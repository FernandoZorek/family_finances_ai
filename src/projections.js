// Lançamentos previstos: parcelas de cartão a vencer e itens recorrentes/financiamentos
const { db } = require('./db');
const { normalize, similarKey } = require('./categorize');
const { ym, addMonths, monthsBetween } = require('./lib/dates');
function commitmentInput(b) {
  const amount = Math.abs(Number(String(b.amount ?? '').replace(/\./g, '').replace(',', '.')));
  const recurring = b.recurring ? 1 : 0;
  const remaining = recurring ? 0 : parseInt(b.remaining, 10);
  if (!String(b.name || '').trim() || !amount || !(recurring || remaining > 0) || !/^\d{4}-\d{2}$/.test(b.first_month || '')) return null;
  return {
    name: String(b.name).trim().slice(0, 80),
    pattern: String(b.pattern || '').trim().slice(0, 80) || null,
    amount,
    remaining: Math.min(remaining, 600),
    recurring,
    direction: b.direction === 'entrada' ? 'entrada' : 'saida',
    first_month: b.first_month,
    category_id: b.category_id ? Number(b.category_id) : null,
    owner_id: b.owner_id ? Number(b.owner_id) : null,
  };
}

function commitmentStatus(c) {
  if (c.recurring) return { ...c, left: null, last_month: null, left_total: null, active: true };
  const cur = ym();
  const done = Math.max(0, Math.min(c.remaining, monthsBetween(c.first_month, cur)));
  const left = c.remaining - done;
  const last = addMonths(c.first_month, c.remaining - 1);
  return { ...c, left, last_month: last, left_total: left * c.amount, active: left > 0 };
}

const COMMITMENT_ERR = 'Preencha nome, valor, mês de início e quantas parcelas faltam (ou marque "todo mês, sem fim").';
const COMMITMENT_COLS = 'name, pattern, amount, remaining, recurring, direction, first_month, category_id, owner_id';


// Lançamentos previstos: parcelas de cartão depois da última fatura enviada de cada cartão
// e itens recorrentes/financiamentos nos meses em que ainda não apareceram no extrato
const PROJ_HORIZON = 12;
function projectedRows(owner) {
  const cur = ym();
  const users = Object.fromEntries(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
  const cats = Object.fromEntries(db.prepare('SELECT id, name, icon, kind, key FROM categories').all().map((c) => [c.id, c]));
  const out = [];
  const byName = Object.fromEntries(Object.values(cats).map((c) => [c.key || c.name, c.id]));
  const add = (r) => {
    if (!cats[r.category_id]) r.category_id = byName[r.amount > 0 ? 'Outras receitas' : 'Outros'] ?? null; // sem categoria ficaria fora dos totais
    const c = cats[r.category_id] || {};
    out.push({ ...r, projected: 1, ignored: 0, category: c.name || null, icon: c.icon || '🗓️', category_kind: c.kind || (r.amount > 0 ? 'receita' : 'despesa'), owner: users[r.owner_id] || null });
  };

  const latest = db.prepare("SELECT account, MAX(ref_month) AS m FROM transactions WHERE kind = 'cartao' GROUP BY account").all();
  const instQ = db.prepare(
    "SELECT id, date, description, amount, installment, owner_id, category_id, holder, channel FROM transactions WHERE kind = 'cartao' AND account = ? AND ref_month = ? AND installment IS NOT NULL AND ignored = 0 AND amount < 0"
  );
  for (const { account, m: L } of latest) {
    for (const t of instQ.all(account, L)) {
      if (owner && t.owner_id !== owner) continue;
      const [i, n] = t.installment.split('/').map(Number);
      for (let k = 1; k <= n - i; k++) {
        add({ id: `p${t.id}-${k}`, type: 'parcela', date: t.date, ref_month: addMonths(L, k), description: t.description, amount: t.amount, account, kind: 'cartao', installment: `${i + k}/${n}`, owner_id: t.owner_id, holder: t.holder, category_id: t.category_id, channel: t.channel });
      }
    }
  }

  const monthTx = db.prepare('SELECT description, amount, date FROM transactions WHERE ref_month = ?' + (owner ? ' AND owner_id = ?' : ''));
  const txCache = {};
  const txOf = (m) =>
    (txCache[m] ??= (owner ? monthTx.all(m, owner) : monthTx.all(m)).map((r) => ({ d: normalize(r.description) + '|' + similarKey(r.description), in: r.amount > 0, date: r.date })));
  const last = addMonths(cur, PROJ_HORIZON - 1);
  for (const c of db.prepare('SELECT * FROM commitments').all()) {
    if (owner && c.owner_id !== owner) continue;
    const pat = c.pattern ? normalize(c.pattern) : null;
    const isIn = c.direction === 'entrada';
    const n = c.recurring ? monthsBetween(c.first_month, last) + 1 : c.remaining;
    let day = '05';
    for (let k = 0; k < n; k++) {
      const m = addMonths(c.first_month, k);
      if (m < cur || m > last) continue;
      const seen = pat && txOf(m).find((t) => t.in === isIn && (t.d.includes(pat) || t.d.replace(/ /g, '').includes(pat.replace(/ /g, ''))));
      if (seen) {
        day = seen.date.slice(8, 10);
        continue; // já aconteceu neste mês
      }
      const dd = String(Math.min(Number(day), new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate())).padStart(2, '0');
      add({
        id: `c${c.id}-${m}`,
        type: isIn ? 'entrada' : c.recurring ? 'recorrente' : 'financiamento',
        date: `${m}-${dd}`,
        ref_month: m,
        description: c.name,
        amount: isIn ? c.amount : -c.amount,
        account: c.recurring ? 'Recorrente' : `Financiamento · faltam ${c.remaining - k}`,
        pattern: c.pattern || null,
        kind: 'previsto',
        installment: c.recurring ? null : `${c.remaining - k} restantes`,
        left: c.recurring ? null : c.remaining - k,
        owner_id: c.owner_id,
        category_id: c.category_id,
      });
    }
  }
  return out;
}

module.exports = { projectedRows, commitmentInput, commitmentStatus, COMMITMENT_ERR, COMMITMENT_COLS, PROJ_HORIZON };
