// Metas de gasto: quanto já saiu (real + previsto) de cada categoria no mês e o histórico dos últimos meses
const { db } = require('./db');
const { addMonths, ym } = require('./lib/dates');
const { projectedRows } = require('./projections');

const r2 = (v) => Math.round(v * 100) / 100;

// gasto por categoria no mês: { [category_id]: { real, projected } }
function spendByCategory(month, owner, proj) {
  const out = {};
  const rows = db
    .prepare(
      `SELECT t.category_id, -SUM(t.amount) AS v FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.ignored = 0 AND c.kind = 'despesa' AND t.ref_month = ? ${owner ? 'AND t.owner_id = ?' : ''} GROUP BY t.category_id`
    )
    .all(...(owner ? [month, owner] : [month]));
  for (const r of rows) out[r.category_id] = { real: r.v, projected: 0 };
  for (const p of proj) {
    if (p.ref_month !== month || p.amount >= 0 || p.category_kind !== 'despesa') continue;
    (out[p.category_id] ??= { real: 0, projected: 0 }).projected += -p.amount;
  }
  return out;
}

// soma da categoria e das subcategorias dela
function sumFor(catId, spend, children) {
  const ids = [catId, ...(children[catId] || [])];
  return ids.reduce((a, id) => ({ real: a.real + (spend[id]?.real || 0), projected: a.projected + (spend[id]?.projected || 0) }), { real: 0, projected: 0 });
}

function childrenMap() {
  const m = {};
  for (const c of db.prepare('SELECT id, parent_id FROM categories WHERE parent_id IS NOT NULL').all()) (m[c.parent_id] ??= []).push(c.id);
  return m;
}

const statusOf = (pct) => (pct >= 1 ? 'estourou' : pct >= 0.8 ? 'perto' : 'ok');

function budgetsFor(month = ym(), owner = null, historyMonths = 6) {
  const budgets = db
    .prepare('SELECT b.id, b.category_id, b.monthly_limit, c.name, c.icon FROM budgets b JOIN categories c ON c.id = b.category_id ORDER BY c.sort, c.name')
    .all();
  if (!budgets.length) return [];
  const proj = projectedRows(owner);
  const children = childrenMap();
  const months = Array.from({ length: historyMonths }, (_, i) => addMonths(month, i - historyMonths + 1));
  const spendByMonth = Object.fromEntries(months.map((m) => [m, spendByCategory(m, owner, proj)]));
  return budgets.map((b) => {
    const cur = sumFor(b.category_id, spendByMonth[month], children);
    const total = cur.real + cur.projected;
    const pct = total / b.monthly_limit;
    return {
      ...b,
      spent: r2(cur.real),
      projected: r2(cur.projected),
      total: r2(total),
      remaining: r2(b.monthly_limit - total),
      pct: Math.round(pct * 1000) / 10,
      status: statusOf(pct),
      history: months.map((m) => {
        const s = sumFor(b.category_id, spendByMonth[m], children);
        const v = s.real + s.projected;
        return { m, total: r2(v), status: statusOf(v / b.monthly_limit) };
      }),
    };
  });
}

// referência para criar metas: média dos últimos meses fechados de cada categoria principal
function suggestions(month = ym(), owner = null, n = 3) {
  const months = Array.from({ length: n }, (_, i) => addMonths(month, -n + i));
  const children = childrenMap();
  const spend = months.map((m) => spendByCategory(m, owner, []));
  // média só dos meses que têm lançamentos (mês sem extrato não puxa a média para baixo)
  const withData = spend.filter((sp) => Object.keys(sp).length).length || 1;
  const existing = new Map(db.prepare('SELECT category_id, monthly_limit FROM budgets').all().map((b) => [b.category_id, b.monthly_limit]));
  return db
    .prepare("SELECT id, name, icon FROM categories WHERE kind = 'despesa' AND parent_id IS NULL AND COALESCE(key, name) NOT IN ('Fatura de cartão sem detalhe', 'Custos da renda') ORDER BY sort, name")
    .all()
    .map((c) => {
      const vals = spend.map((s) => {
        const v = sumFor(c.id, s, children);
        return v.real;
      });
      return { category_id: c.id, name: c.name, icon: c.icon, average: r2(vals.reduce((a, v) => a + v, 0) / withData), months: vals.map(r2), limit: existing.get(c.id) || null };
    });
}

function setBudget(categoryId, limit) {
  const cat = db.prepare("SELECT id FROM categories WHERE id = ? AND kind = 'despesa'").get(Number(categoryId));
  if (!cat) throw Object.assign(new Error('Escolha uma categoria de despesa.'), { status: 400 });
  const v = Number(limit);
  if (!v || v <= 0) {
    db.prepare('DELETE FROM budgets WHERE category_id = ?').run(cat.id);
    return null;
  }
  if (v > 1e8) throw Object.assign(new Error('Valor alto demais.'), { status: 400 });
  db.prepare('INSERT INTO budgets (category_id, monthly_limit) VALUES (?, ?) ON CONFLICT(category_id) DO UPDATE SET monthly_limit = excluded.monthly_limit').run(cat.id, r2(v));
  return cat.id;
}

module.exports = { budgetsFor, suggestions, setBudget, spendByCategory, childrenMap, sumFor };
