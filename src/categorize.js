const { db } = require('./db');

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Categoria sugerida pelo próprio banco (Itaú) quando nenhuma regra casa
const HINTS = {
  supermercado: 'Mercado',
  restaurante: 'Restaurantes e delivery',
  transporte: 'Transporte',
  'saúde': 'Saúde',
  saude: 'Saúde',
  'educação': 'Educação',
  educacao: 'Educação',
  'vestuário': 'Compras',
  vestuario: 'Compras',
  turismo: 'Lazer',
  hobby: 'Lazer',
  entretenimento: 'Lazer',
};

function loadContext() {
  const categories = db.prepare('SELECT * FROM categories').all();
  // pelo nome e pela key (nome original da categoria padrão, que vale mesmo depois de renomear)
  const byName = Object.fromEntries([...categories.map((c) => [c.name, c]), ...categories.filter((c) => c.key).map((c) => [c.key, c])]);
  const rules = db
    .prepare('SELECT r.*, c.kind FROM rules r JOIN categories c ON c.id = r.category_id ORDER BY r.priority DESC, length(r.pattern) DESC, r.id DESC')
    .all()
    .map((r) => ({ ...r, norm: normalize(r.pattern) }));
  const members = db
    .prepare('SELECT id, name, aliases FROM users')
    .all()
    .map((u) => ({
      id: u.id,
      tokens: [u.name, ...u.aliases.split(',')]
        .map((a) => normalize(a).split(' ').filter(Boolean))
        .filter((t) => t.length),
    }));
  return { categories, byName, rules, members };
}

// Nome do outro lado em PIX/TED ("DES: FULANO", "REM: FULANO", "PIX TRANSF FULANO07/10")
function counterpartOf(norm) {
  const m =
    /(?:\bDES:|\bREM:|PIX TRANSF|\bTRANSF(?:ERENCIA)?\b|\bTED\b|\bDOC\b|PAGAMENTO PIX\s*-|PIX (?:ENVIADO|RECEBIDO)(?!\s+(?:DES|REM):))\s*(?:[\d./-]+\s+)*([A-Z][A-Z .]*)/.exec(norm);
  return m ? m[1].trim().split(' ').filter(Boolean) : null;
}

// Pessoa da casa? Primeiro nome igual (ou truncado pelo banco, >= 6 letras) e, se houver, 2º nome compatível
function memberOf(words, members) {
  if (!words || !words.length) return null;
  for (const m of members) {
    for (const tokens of m.tokens) {
      const [first, second] = tokens;
      const w0 = words[0];
      const firstOk = w0 === first || (w0.length >= 6 && first.startsWith(w0) && words.length === 1);
      if (!firstOk) continue;
      if (words[1] && second && !second.startsWith(words[1]) && !words[1].startsWith(second)) continue;
      return m.id;
    }
  }
  return null;
}

function categorize(tx, ctx) {
  const norm = normalize(tx.description);
  const key = similarKey(tx.description);
  // PDF com texto quebrado tira os espaços ("FARMACIASAOJOAOBR"): compara também sem espaços
  const flat = norm.replace(/ /g, '');
  const inAccount = (r) => !r.account || (tx.account || '').startsWith(r.account);
  const matches = (r) => inAccount(r) && (norm.includes(r.norm) || (r.norm.length >= 3 && key.includes(r.norm)) || (r.norm.length >= 6 && flat.includes(r.norm.replace(/ /g, ''))));
  const cat = (name) => ctx.byName[name];

  if (tx.is_payment) return cat('Pagamento de fatura');

  const userRule = ctx.rules.find((r) => r.source === 'usuario' && !r.account && matches(r));
  if (userRule) return ctx.categories.find((c) => c.id === userRule.category_id);

  if (tx.kind === 'conta' && memberOf(counterpartOf(norm), ctx.members)) return cat('Transferência interna');
  // regra de uma conta só vem depois da transferência entre vocês (PIX de alguém da casa para si mesmo não é venda)
  const accountRule = ctx.rules.find((r) => r.source === 'usuario' && r.account && matches(r));
  if (accountRule) return ctx.categories.find((c) => c.id === accountRule.category_id);

  const rule = ctx.rules.find((r) => {
    if (!matches(r)) return false;
    // regra de receita não classifica saída e vice-versa (ex.: "PIX RECEBIDO" x valor negativo)
    if (r.kind === 'receita' && tx.amount < 0) return false;
    if (r.kind === 'despesa' && tx.amount > 0 && tx.kind === 'conta') return false;
    return true;
  });
  if (rule) return ctx.categories.find((c) => c.id === rule.category_id);

  if (tx.category_hint && HINTS[tx.category_hint]) return cat(HINTS[tx.category_hint]);
  if (tx.amount > 0) return cat(tx.kind === 'cartao' ? 'Reembolsos e estornos' : 'Outras receitas');
  return cat('Outros');
}

// Reaplica regras em tudo que não foi editado à mão
function recategorizeAll() {
  const ctx = loadContext();
  const rows = db.prepare('SELECT * FROM transactions WHERE category_locked = 0').all();
  const upd = db.prepare('UPDATE transactions SET category_id = ?, ignored = ? WHERE id = ?');
  let changed = 0;
  db.transaction(() => {
    const missId = ctx.byName['Fatura de cartão sem detalhe']?.id;
    for (const t of rows) {
      const c = categorize(t, ctx);
      // pagamento x "sem detalhe" quem decide é a reconciliação abaixo
      if (c.name === 'Pagamento de fatura' && t.category_id === missId) continue;
      const ignored = c.kind === 'neutra' ? 1 : 0;
      if (c.id !== t.category_id || ignored !== t.ignored) {
        upd.run(c.id, ignored, t.id);
        changed++;
      }
    }
  })();
  return changed + reconcileCardPayments();
}

// De qual cartão é um pagamento de fatura feito pela conta
const CARD_PAY_BANK = [
  [/COBRANCA BANCO BRADESCO|BRADESCO CART/, 'Bradesco'],
  [/UNICLASS|ITAUCARD|FATURA ITAU|ITAU CART/, 'Itaú'],
  [/MERCADO PAGO|MERCADOPAGO/, 'Mercado Pago'],
  [/OUROCARD|CARTAO BB|BB CARTAO/, 'Banco do Brasil'],
  [/NUBANK|NU PAGAMENTOS/, 'Nubank'],
];
function cardBankOf(t) {
  const n = normalize(t.description);
  for (const [re, bank] of CARD_PAY_BANK) if (re.test(n)) return bank;
  // "Pagamento de fatura Cartão de crédito" dentro da conta do próprio banco
  if (/FATURA|CARTAO/.test(n)) {
    const own = ['Mercado Pago', 'Bradesco', 'Itaú', 'Sicredi', 'Banco do Brasil', 'Nubank'].find((b) => (t.account || '').startsWith(b));
    if (own) return own;
  }
  return null;
}

// Pagamento de fatura só fica fora do balanço quando a fatura (com os gastos detalhados) foi importada.
// Sem a fatura, o pagamento conta como despesa "Fatura de cartão sem detalhe" e vira alerta de documento faltando.
function reconcileCardPayments() {
  const ctx = loadContext();
  const payCat = ctx.byName['Pagamento de fatura'];
  const missCat = ctx.byName['Fatura de cartão sem detalhe'];
  if (!payCat || !missCat) return 0;
  const faturas = db
    .prepare("SELECT bank, due_date, amount_due FROM imports WHERE kind = 'cartao' AND due_date IS NOT NULL AND amount_due IS NOT NULL")
    .all();
  // Valor exato; ou, com o banco identificado, até 10% abaixo (pagamento parcial ou crédito abatido no débito automático)
  const covers = (t, bank) =>
    faturas.some((f) => {
      if (bank && f.bank !== bank) return false;
      if (Math.abs(new Date(t.date) - new Date(f.due_date)) > 15 * 864e5) return false;
      const paid = Math.abs(t.amount);
      if (Math.abs(f.amount_due - paid) < 0.005) return true;
      return !!bank && paid < f.amount_due && paid >= f.amount_due * 0.9;
    });
  const upd = db.prepare('UPDATE transactions SET category_id = ?, ignored = ? WHERE id = ?');
  let n = 0;
  db.transaction(() => {
    // 1) débitos já classificados como pagamento de fatura (por regra) ou sem detalhe
    const rows = db
      .prepare("SELECT id, date, amount, description, account, category_id, ignored FROM transactions WHERE kind = 'conta' AND amount < 0 AND category_locked = 0 AND category_id IN (?, ?)")
      .all(payCat.id, missCat.id);
    for (const t of rows) {
      const ok = covers(t, cardBankOf(t));
      const cat = ok ? payCat.id : missCat.id;
      const ign = ok ? 1 : 0;
      if (cat !== t.category_id || ign !== t.ignored) upd.run(cat, ign, t.id), n++;
    }
    // 2) outros débitos com o valor exato de uma fatura importada (pagamento sem descrição reconhecível)
    const others = db
      .prepare("SELECT id, date, amount, description, account FROM transactions WHERE kind = 'conta' AND amount < 0 AND category_locked = 0 AND category_id NOT IN (?, ?)")
      .all(payCat.id, missCat.id);
    for (const t of others) if (covers(t, null)) upd.run(payCat.id, 1, t.id), n++;
  })();
  return n + reconcileHolerites(ctx);
}

// Salário que cai na conta e tem holerite enviado: o holerite já lança bruto e descontos,
// então o depósito do líquido fica neutro. Sem holerite, volta a ser receita de salário.
function reconcileHolerites(ctx = loadContext()) {
  const netCat = ctx.byName['Salário líquido (detalhado no holerite)'];
  const salCat = ctx.byName['Salário e pró-labore'];
  if (!netCat || !salCat) return 0;
  const recibos = db.prepare("SELECT due_date, amount_due FROM imports WHERE kind = 'holerite' AND due_date IS NOT NULL AND amount_due IS NOT NULL").all();
  const covered = (t) => recibos.some((h) => Math.abs(h.amount_due - t.amount) < 0.005 && Math.abs(new Date(t.date) - new Date(h.due_date)) <= 7 * 864e5);
  const upd = db.prepare('UPDATE transactions SET category_id = ?, ignored = ? WHERE id = ?');
  const rows = db
    .prepare("SELECT * FROM transactions WHERE kind = 'conta' AND amount > 0 AND category_locked = 0 AND category_id IN (?, ?)")
    .all(salCat.id, netCat.id);
  let n = 0;
  db.transaction(() => {
    for (const t of rows) {
      if (covered(t)) {
        if (t.category_id !== netCat.id || !t.ignored) upd.run(netCat.id, 1, t.id), n++;
      } else if (t.category_id === netCat.id) {
        const c = categorize(t, ctx);
        upd.run(c.id, c.kind === 'neutra' ? 1 : 0, t.id), n++;
      }
    }
  })();
  return n;
}

// Chave para achar "o mesmo lançamento" em outros meses: sem números (datas, parcelas, documentos)
function similarKey(desc) {
  return normalize(desc)
    .replace(/\d+(?:[./-]\d+)*/g, ' ')
    .replace(/[^A-Z* ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Texto sugerido para regra a partir de um lançamento
// (as regras casam com a descrição normalizada ou com essa chave sem números)
function rulePatternFor(desc) {
  const key = similarKey(desc);
  return key.length >= 3 ? key.slice(0, 60) : normalize(desc).slice(0, 60);
}

// Mesma loja/lançamento sem espaços (PDFs com texto quebrado: "FARMACIASAOJOAOBR" = "FARMACIA SAO JOAO BR")
const sameKey = (desc) => similarKey(desc).replace(/ /g, '');

module.exports = { sameKey, cardBankOf, similarKey, rulePatternFor, normalize, loadContext, categorize, recategorizeAll, reconcileCardPayments, memberOf, counterpartOf };
