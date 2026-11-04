// Painel: meses, resumo do mês, comparação de meses e previsão
const express = require('express');
const { db } = require('../db');
const { normalize, sameKey } = require('../categorize');
const { withFilter, keep, isIncomeCost, FILTER_SQL, CAT_SQL } = require('../filters');
const { channelOf, loadChannelCtx } = require('../channel');
const { taxSummary } = require('../taxes');
const { ym, addMonths } = require('../lib/dates');
const { projectedRows, commitmentStatus } = require('../projections');

const router = express.Router();

// ---------- painel ----------
router.get('/months', (req, res) => {
  const real = db.prepare('SELECT DISTINCT ref_month AS m FROM transactions').all().map((r) => r.m);
  const future = projectedRows(null).map((r) => r.ref_month);
  res.json([...new Set([...real, ...future])].sort().reverse());
});


router.get('/summary', (req, res) => withFilter(req.query, (flt) => summary(req, res, flt ? FILTER_SQL : '', flt)));
function summary(req, res, fsql, flt) {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : new Date().toISOString().slice(0, 7);
  const owner = req.query.owner && req.query.owner !== 'all' ? Number(req.query.owner) : null;
  const ownerSql = owner ? 'AND t.owner_id = @owner' : '';
  // Lançamentos previstos (parcelas a vencer, recorrentes) entram nos totais junto com os realizados
  const projAll = projectedRows(null);
  const p = { month, owner, proj: JSON.stringify(projAll.map((r) => ({ amount: r.amount, category_id: r.category_id, owner_id: r.owner_id, ref_month: r.ref_month, account: r.account, description: r.description, installment: r.installment, pattern: r.pattern || null }))) };
  // renda líquida: custo da renda troca de categoria ("Custos da renda", receita negativa); orig_cat guarda a original
  const J = (k) => `json_extract(value, '$.${k}')`;
  const catReal = flt?.liquid ? CAT_SQL() : 'category_id';
  const catProj = flt?.liquid ? CAT_SQL(J('category_id'), J('description'), J('account'), J('pattern'), J('owner_id')) : J('category_id');
  const src = `(SELECT amount, ${catReal} AS category_id, category_id AS orig_cat, ignored, owner_id, ref_month, account, description, installment, NULL AS pattern, 0 AS projected FROM transactions
    UNION ALL SELECT ${J('amount')}, ${catProj}, ${J('category_id')}, 0, ${J('owner_id')}, ${J('ref_month')},
      ${J('account')}, ${J('description')}, ${J('installment')}, ${J('pattern')}, 1 FROM json_each(@proj))`;
  const base = `FROM ${src} t JOIN categories c ON c.id = t.category_id WHERE t.ignored = 0 ${ownerSql} ${fsql}`;

  const totals = (m) =>
    db
      .prepare(`SELECT COALESCE(SUM(CASE WHEN c.kind='receita' THEN t.amount END),0) AS income,
                       COALESCE(-SUM(CASE WHEN c.kind='despesa' THEN t.amount END),0) AS expense ${base} AND t.ref_month = @month`)
      .get({ ...p, month: m });

  const cur = totals(month);
  const prev = totals(addMonths(month, -1));

  const byCategory = db
    .prepare(`SELECT c.id, c.name, c.icon, c.parent_id, -SUM(t.amount) AS total, COUNT(*) AS n ${base} AND t.ref_month = @month AND c.kind = 'despesa'
              GROUP BY c.id HAVING total > 0.004 ORDER BY total DESC`)
    .all(p);
  const prevByCat = Object.fromEntries(
    db
      .prepare(`SELECT c.id, -SUM(t.amount) AS total ${base} AND t.ref_month = @month AND c.kind = 'despesa' GROUP BY c.id`)
      .all({ ...p, month: addMonths(month, -1) })
      .map((r) => [r.id, r.total])
  );
  byCategory.forEach((c) => (c.prev = prevByCat[c.id] || 0));

  const incomeByCategory = db
    .prepare(`SELECT c.id, c.name, c.icon, SUM(t.amount) AS total ${base} AND t.ref_month = @month AND c.kind = 'receita'
              GROUP BY c.id HAVING total > 0.004 ORDER BY total DESC`)
    .all(p);

  const byMember = db
    .prepare(`SELECT u.id, u.name, u.color,
                COALESCE(-SUM(CASE WHEN c.kind='despesa' THEN t.amount END),0) AS expense,
                COALESCE(SUM(CASE WHEN c.kind='receita' THEN t.amount END),0) AS income
              FROM ${src} t JOIN categories c ON c.id = t.category_id JOIN users u ON u.id = t.owner_id
              WHERE t.ignored = 0 AND t.ref_month = @month ${fsql} GROUP BY u.id ORDER BY u.id`)
    .all({ month, proj: p.proj });

  const byAccount = db
    .prepare(`SELECT t.account, -SUM(t.amount) AS total ${base} AND t.ref_month = @month AND c.kind = 'despesa'
              GROUP BY t.account HAVING total > 0.004 ORDER BY total DESC`)
    .all(p);

  const merchantsRaw = db
    .prepare(`SELECT t.description, t.amount ${base} AND t.ref_month = @month AND c.kind = 'despesa' AND t.amount < 0`)
    .all(p);
  const merchants = new Map();
  for (const r of merchantsRaw) {
    const key = normalize(r.description).replace(/^PIX (ENVIADO|RECEBIDO|QR CODE ESTATICO)\s*(DES|REM):\s*/, '').replace(/^PG \*/, '').replace(/\s*\d{2}\/\d{2}$/, '').replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ');
    const m = merchants.get(key) || { name: key, total: 0, n: 0 };
    m.total -= r.amount;
    m.n++;
    merchants.set(key, m);
  }
  const topMerchants = [...merchants.values()].sort((a, b) => b.total - a.total).slice(0, 8);

  const start = addMonths(month, -11);
  const evoRows = db
    .prepare(`SELECT t.ref_month AS m,
                COALESCE(SUM(CASE WHEN c.kind='receita' THEN t.amount END),0) AS income,
                COALESCE(-SUM(CASE WHEN c.kind='despesa' THEN t.amount END),0) AS expense
              ${base} AND t.ref_month BETWEEN @start AND @month GROUP BY t.ref_month`)
    .all({ ...p, start });
  const evoMap = Object.fromEntries(evoRows.map((r) => [r.m, r]));
  const first = evoRows.length ? evoRows.map((r) => r.m).sort()[0] : month;
  const evolution = [];
  for (let m = first < start ? start : first; m <= month; m = addMonths(m, 1)) {
    evolution.push({ m, income: evoMap[m]?.income || 0, expense: evoMap[m]?.expense || 0 });
  }

  const installmentsNext = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(-SUM(t.amount),0) AS total ${base} AND t.ref_month = @month AND t.installment IS NOT NULL
              AND CAST(substr(t.installment, 1, instr(t.installment,'/')-1) AS INTEGER) < CAST(substr(t.installment, instr(t.installment,'/')+1) AS INTEGER)`)
    .get(p);

  // impostos do mês: diretos + contador + embutidos (estimativa). Usa a categoria original (renda líquida troca a categoria)
  const catsById = Object.fromEntries(db.prepare('SELECT id, name, key, tax_rate FROM categories').all().map((c) => [c.id, c]));
  const taxes = taxSummary(
    db
      .prepare(`SELECT t.orig_cat, t.description, t.amount FROM ${src} t JOIN categories oc ON oc.id = t.orig_cat
                WHERE t.ignored = 0 AND oc.kind = 'despesa' AND t.amount < 0 AND t.ref_month = @month ${ownerSql} ${fsql}`)
      .all(p)
      .map((r) => ({ ...r, cat: catsById[r.orig_cat] }))
  );

  // compras de cartão do mês: online x presencial
  const cctx = loadChannelCtx();
  const byChannel = { online: 0, presencial: 0, n: { online: 0, presencial: 0 } };
  for (const t of db
    .prepare(`SELECT t.description, t.amount, t.account, t.kind, t.is_payment, t.channel, t.owner_id, t.category_id FROM (SELECT *, NULL AS pattern, category_id AS orig_cat FROM transactions) t
              JOIN categories c ON c.id = t.category_id WHERE t.ignored = 0 AND c.kind = 'despesa' AND t.kind = 'cartao' AND t.ref_month = @month ${ownerSql} ${fsql}`)
    .all(p)) {
    const ch = channelOf(t, cctx);
    if (!ch || isIncomeCost(t)) continue; // renda líquida: custo da renda já saiu das despesas
    byChannel[ch.channel] -= t.amount;
    byChannel.n[ch.channel]++;
  }

  const cards = db
    .prepare(`SELECT account, due_date, amount_due, holder FROM imports WHERE kind = 'cartao' AND due_date IS NOT NULL AND substr(due_date,1,7) = @month ORDER BY due_date`)
    .all({ month });

  const proj = projAll.filter((r) => r.ref_month === month && (!owner || r.owner_id === owner) && keep(r));
  const projected = {
    income: proj.filter((r) => r.amount > 0 || isIncomeCost(r)).reduce((a, r) => a + r.amount, 0),
    expense: proj.filter((r) => r.amount < 0 && !isIncomeCost(r)).reduce((a, r) => a - r.amount, 0),
    n: proj.length,
  };

  // Parcelas e financiamentos cuja última parcela cai no mês anterior, neste e no próximo (dinheiro que fica livre)
  const lastQ = db.prepare(
    `SELECT t.description, t.amount, t.account, t.installment, t.owner_id, t.category_id FROM transactions t
     WHERE t.ignored = 0 AND t.amount < 0 AND t.ref_month = ? AND t.installment LIKE '%/%' ${owner ? 'AND t.owner_id = ?' : ''}`
  );
  const isLast = (inst) => {
    const m = /^(\d+)\/(\d+)$/.exec(inst || '');
    return m && Number(m[1]) === Number(m[2]) && Number(m[2]) > 1;
  };
  const userName = Object.fromEntries(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, u.name]));
  const endings = [-1, 0, 1].map((k) => {
    const m = addMonths(month, k);
    const real = (owner ? lastQ.all(m, owner) : lastQ.all(m)).filter((t) => isLast(t.installment) && keep(t)).map((t) => ({ ...t, projected: 0 }));
    const fut = projAll.filter(
      (r) => r.ref_month === m && (!owner || r.owner_id === owner) && r.amount < 0 && keep(r) && (r.type === 'parcela' ? isLast(r.installment) : r.type === 'financiamento' && r.left === 1)
    );
    const items = [...real, ...fut]
      .map((t) => ({ description: t.description, amount: -t.amount, account: t.account, installment: t.type === 'financiamento' ? 'última' : t.installment, owner: userName[t.owner_id] || null, projected: t.projected ? 1 : 0 }))
      .sort((a, b) => b.amount - a.amount);
    return { m, total: Math.round(items.reduce((a, i) => a + i.amount, 0) * 100) / 100, items };
  });

  res.json({
    month,
    endings,
    projected,
    income: cur.income,
    expense: cur.expense,
    balance: cur.income - cur.expense,
    prev: { income: prev.income, expense: prev.expense },
    byCategory,
    incomeByCategory,
    byMember,
    byAccount,
    topMerchants,
    evolution,
    installmentsNext,
    cards,
    byChannel,
    taxes,
    liquid: Boolean(flt?.liquid),
  });
}


// Comparar mês anterior / atual / próximo (com o previsto), por categoria e por lançamento
router.get('/compare', (req, res) => withFilter(req.query, (flt) => compare(req, res, flt ? FILTER_SQL : '', flt)));
function compare(req, res, fsql, flt) {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : ym();
  const owner = req.query.owner && req.query.owner !== 'all' ? Number(req.query.owner) : null;
  const months = [addMonths(month, -1), month, addMonths(month, 1)];
  const proj = JSON.stringify(projectedRows(null).map((r) => ({ amount: r.amount, category_id: r.category_id, owner_id: r.owner_id, ref_month: r.ref_month, description: r.description, account: r.account, pattern: r.pattern || null })));
  const J = (k) => `json_extract(value, '$.${k}')`;
  const catReal = flt?.liquid ? CAT_SQL() : 'category_id';
  const catProj = flt?.liquid ? CAT_SQL(J('category_id'), J('description'), J('account'), J('pattern'), J('owner_id')) : J('category_id');
  const rows = db
    .prepare(
      `SELECT t.ref_month AS m, c.id AS category_id, c.kind, t.description, MAX(t.pattern) AS pattern, SUM(t.amount) AS total, MAX(t.projected) AS projected
       FROM (SELECT amount, ${catReal} AS category_id, category_id AS orig_cat, ignored, owner_id, ref_month, description, account, NULL AS pattern, 0 AS projected FROM transactions
             UNION ALL SELECT ${J('amount')}, ${catProj}, ${J('category_id')}, 0, ${J('owner_id')},
               ${J('ref_month')}, ${J('description')}, ${J('account')}, ${J('pattern')}, 1 FROM json_each(@proj)) t
       JOIN categories c ON c.id = t.category_id
       WHERE t.ignored = 0 AND c.kind IN ('despesa', 'receita') AND t.ref_month IN (@m0, @m1, @m2) ${owner ? 'AND t.owner_id = @owner' : ''} ${fsql}
       GROUP BY t.ref_month, c.id, t.description`
    )
    .all({ proj, owner, m0: months[0], m1: months[1], m2: months[2] });
  // mesmo estabelecimento em meses diferentes (datas, parcelas e números mudam): junta pela chave sem números
  const items = new Map();
  // reais primeiro: o previsto de um recorrente (nome do cadastro, ex.: "DARF (empresa)") cai na linha
  // do lançamento real que tem o texto de busca do cadastro ("PAGAMENTO DARF UNIFICADO")
  rows.sort((a, b) => a.projected - b.projected);
  for (const r of rows) {
    let same = sameKey(r.description) || r.description.replace(/ /g, '');
    if (r.pattern) {
      const pk = sameKey(r.pattern) || r.pattern.replace(/ /g, '');
      const hit = pk.length >= 4 && [...items.values()].find((x) => x.category_id === r.category_id && x.key.includes(pk));
      same = hit ? hit.key : pk;
    }
    const key = `${r.category_id}|${same}`;
    const it = items.get(key) || { category_id: r.category_id, kind: r.kind, description: r.description, key: same, values: [0, 0, 0], projected: [0, 0, 0] };
    const i = months.indexOf(r.m);
    const v = r.kind === 'despesa' ? -r.total : r.total;
    it.values[i] = Math.round((it.values[i] + v) * 100) / 100;
    if (r.projected) it.projected[i] = 1;
    items.set(key, it);
  }
  res.json({ months, items: [...items.values()].filter((it) => it.values.some((v) => Math.abs(v) > 0.004)) });
}

// Previsão por mês (painel): soma dos lançamentos previstos
router.get('/future', (req, res) => withFilter(req.query, () => future(req, res)));
function future(req, res) {
  const owner = req.query.owner && req.query.owner !== 'all' ? Number(req.query.owner) : null;
  const horizon = Math.min(Number(req.query.months) || 12, 36);
  const cur = ym();
  const months = Array.from({ length: horizon }, (_, i) => ({ m: addMonths(cur, i), total: 0, income: 0, financing: 0, recurring: 0, installments: 0, balance: 0, items: [] }));
  const byMonth = Object.fromEntries(months.map((x) => [x.m, x]));
  for (const r of projectedRows(owner)) {
    const slot = byMonth[r.ref_month];
    if (!slot || !keep(r)) continue;
    const v = Math.abs(r.amount);
    if (isIncomeCost(r)) {
      // renda líquida: imposto/contador/desconto em folha diminui a entrada em vez de ser saída
      slot.income -= v;
      slot.items.push({ type: 'entrada', name: `− ${r.description}`, account: r.account, amount: -v, category_id: r.category_id, owner_id: r.owner_id, cost: 1 });
      continue;
    }
    if (r.type === 'entrada') slot.income += v;
    else if (r.type === 'recorrente') slot.recurring += v;
    else if (r.type === 'financiamento') slot.financing += v;
    else slot.installments += v;
    slot.items.push({ type: r.type, name: r.description, account: r.account, amount: v, n: r.type === 'parcela' ? r.installment : null, left: r.left, category_id: r.category_id, owner_id: r.owner_id });
  }
  // parcelas que já estão em faturas enviadas (reais) também contam: senão o mês com fatura parece ter menos parcelas
  const real = db
    .prepare(
      `SELECT description, account, installment, amount, ref_month, category_id, owner_id FROM transactions
       WHERE kind = 'cartao' AND installment IS NOT NULL AND ignored = 0 AND amount < 0 AND ref_month >= ? ${owner ? 'AND owner_id = ?' : ''}`
    )
    .all(...(owner ? [cur, owner] : [cur]));
  for (const t of real) {
    const slot = byMonth[t.ref_month];
    if (!slot || !keep(t)) continue;
    if (isIncomeCost(t)) {
      slot.income += t.amount;
      slot.items.push({ type: 'entrada', name: `− ${t.description}`, account: t.account, amount: t.amount, category_id: t.category_id, owner_id: t.owner_id, cost: 1 });
      continue;
    }
    slot.installments += -t.amount;
    slot.items.push({ type: 'parcela', real: 1, name: t.description, account: t.account, amount: -t.amount, n: t.installment, category_id: t.category_id, owner_id: t.owner_id });
  }
  const r2 = (v) => Math.round(v * 100) / 100;
  for (const x of months) {
    x.installments = r2(x.installments);
    x.total = r2(x.financing + x.recurring + x.installments);
    x.income = r2(x.income);
    x.balance = r2(x.income - x.total);
    x.items.sort((a, b) => (a.type === 'entrada') - (b.type === 'entrada') || b.amount - a.amount);
  }
  const commitments = db.prepare('SELECT * FROM commitments').all().filter((c) => !owner || c.owner_id === owner);
  res.json({ months, commitments: commitments.map(commitmentStatus) });
}

module.exports = router;
