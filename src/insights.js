// Insights por IA: como foi o gasto num período, onde economizar e quanto isso rende.
// Filtros: período (últimos N meses ou de/até), categoria, documento (conta/cartão), objetivo e direcionamento livre.
// A IA recebe só totais por mês e por categoria (e as maiores lojas, sem PIX/transferências);
// as contas de economia (por mês, 3/6/12 meses e até o prazo do objetivo) são feitas aqui, não pela IA.
const { db } = require('./db');
const config = require('./config');
const ai = require('./ai');
const { addMonths, monthsBetween, ym } = require('./lib/dates');
const { sameKey, similarKey } = require('./categorize');
const { childrenMap } = require('./budgets');

const r2 = (v) => Math.round(v * 100) / 100;
const SKIP_MERCHANT = /\b(PIX|TED|DOC|TRANSF|TRANSFERENCIA|DEPOSITO|SAQUE|PAGAMENTO DE FATURA|DESCONTO EM FOLHA)\b/;
const MIN_INTERVAL = 60e3; // um pedido por minuto (custo)
const MONTH_RE = /^\d{4}-\d{2}$/;
const MAX_MONTHS = 24;
let lastAt = 0;
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// meses para juntar o objetivo: do mês atual até o prazo, inclusive
const monthsLeft = (until) => Math.max(1, monthsBetween(ym(), until) + 1);

// Valida e normaliza os filtros pedidos pela tela
function normalizeParams(b = {}, owner = null) {
  let from;
  let to;
  if (MONTH_RE.test(b.from || '') && MONTH_RE.test(b.to || '')) {
    [from, to] = b.from <= b.to ? [b.from, b.to] : [b.to, b.from];
    if (monthsBetween(from, to) + 1 > MAX_MONTHS) throw fail(`Escolha no máximo ${MAX_MONTHS} meses.`);
  } else {
    const n = [3, 6, 12].includes(Number(b.months)) ? Number(b.months) : 3;
    to = addMonths(ym(), -1); // o mês atual ainda está incompleto
    from = addMonths(to, -(n - 1));
  }
  const category = b.category_id ? db.prepare("SELECT id, name FROM categories WHERE id = ? AND kind = 'despesa'").get(Number(b.category_id)) : null;
  if (b.category_id && !category) throw fail('Categoria inválida.');
  const account = b.account ? String(b.account).slice(0, 80) : null;
  if (account && !db.prepare('SELECT 1 FROM transactions WHERE account = ? LIMIT 1').get(account)) throw fail('Documento não encontrado.');
  const goalAmount = Number(String(b.goal_amount ?? '').replace(/\./g, '').replace(',', '.')) || null;
  const goalMonth = MONTH_RE.test(b.goal_month || '') ? b.goal_month : null;
  if (goalAmount && (goalAmount < 0 || goalAmount > 1e9)) throw fail('Valor do objetivo inválido.');
  if (goalAmount && goalMonth && goalMonth < ym()) throw fail('O prazo do objetivo já passou.');
  return {
    from,
    to,
    months: monthsBetween(from, to) + 1,
    owner,
    category_id: category?.id || null,
    category: category?.name || null,
    account,
    goal_amount: goalAmount,
    goal_month: goalAmount ? goalMonth || `${ym().slice(0, 4)}-12` : null,
    guidance: String(b.guidance || '').trim().slice(0, 600) || null,
  };
}

// Totais do período com os filtros (o que vai para a IA)
function buildData(p) {
  const period = Array.from({ length: p.months }, (_, i) => addMonths(p.from, i));
  const children = childrenMap();
  const catIds = p.category_id ? [p.category_id, ...(children[p.category_id] || [])] : null;
  const where = ['t.ignored = 0', 't.ref_month BETWEEN @from AND @to'];
  const params = { from: p.from, to: p.to };
  if (p.owner) where.push('t.owner_id = @owner'), (params.owner = p.owner);
  if (p.account) where.push('t.account = @account'), (params.account = p.account);
  const scope = `FROM transactions t JOIN categories c ON c.id = t.category_id WHERE ${where.join(' AND ')}`;
  const inCat = catIds ? `AND c.id IN (${catIds.map(Number).join(',')})` : '';

  const totals = db
    .prepare(
      `SELECT t.ref_month AS m, COALESCE(SUM(CASE WHEN c.kind = 'receita' THEN t.amount END), 0) AS income,
              COALESCE(-SUM(CASE WHEN c.kind = 'despesa' ${inCat} THEN t.amount END), 0) AS expense ${scope} GROUP BY t.ref_month`
    )
    .all(params);
  const byM = Object.fromEntries(totals.map((r) => [r.m, r]));
  const byMonth = period.map((m) => ({ month: m, income: r2(byM[m]?.income || 0), expense: r2(byM[m]?.expense || 0) }));
  const withData = byMonth.filter((x) => x.income || x.expense).length;
  if (!withData) throw fail('Não há lançamentos com esses filtros no período.');

  // por categoria principal (grupo soma subcategorias); com categoria escolhida, as subcategorias dela
  const rows = db.prepare(`SELECT t.ref_month AS m, c.id, c.parent_id, -SUM(t.amount) AS v ${scope} AND c.kind = 'despesa' ${inCat} GROUP BY t.ref_month, c.id`).all(params);
  const cats = Object.fromEntries(db.prepare('SELECT id, name, nature, key FROM categories').all().map((c) => [c.id, c]));
  const group = (r) => (p.category_id ? r.id : r.parent_id || r.id);
  const agg = new Map();
  for (const r of rows) {
    const g = group(r);
    const a = agg.get(g) || { id: g, months: {} };
    a.months[r.m] = (a.months[r.m] || 0) + r.v;
    agg.set(g, a);
  }
  let unknown = 0;
  const categories = [];
  for (const a of agg.values()) {
    const c = cats[a.id];
    const vals = period.map((m) => r2(a.months[m] || 0));
    const average = r2(vals.reduce((s, v) => s + v, 0) / withData);
    if ((c?.key || c?.name) === 'Fatura de cartão sem detalhe') {
      unknown = average; // gasto real, mas sem saber onde: vai à parte, não como categoria
      continue;
    }
    if (average > 0) categories.push({ id: a.id, name: c?.name || '?', nature: c?.nature || 'outras', months: vals, average });
  }
  categories.sort((a, b) => b.average - a.average);

  // maiores lojas (só nome sem números; sem PIX nem transferências)
  const merchantsQ = db.prepare(`SELECT t.description, -t.amount AS v ${scope} AND t.amount < 0 AND (c.id = @cat OR c.parent_id = @cat)`);
  const topN = p.category_id ? 12 : 4;
  for (const c of categories.slice(0, p.category_id ? 10 : 6)) {
    const m = new Map();
    for (const r of merchantsQ.all({ ...params, cat: c.id })) {
      const name = similarKey(r.description);
      if (name.length < 3 || SKIP_MERCHANT.test(name)) continue;
      const k = sameKey(r.description);
      const x = m.get(k) || { name, total: 0, purchases: 0 };
      x.total += r.v;
      x.purchases++;
      m.set(k, x);
    }
    c.top_merchants = [...m.values()].sort((a, b) => b.total - a.total).slice(0, topN).map((x) => ({ ...x, total: r2(x.total) }));
  }

  // renda média geral da casa/pessoa no período (contexto, mesmo com filtro de categoria/documento)
  const incomeAll = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount), 0) AS v FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.ignored = 0 AND c.kind = 'receita' AND t.ref_month BETWEEN @from AND @to ${p.owner ? 'AND t.owner_id = @owner' : ''}`
    )
    .get(params).v;
  const budgets = db.prepare('SELECT c.name AS category, b.monthly_limit FROM budgets b JOIN categories c ON c.id = b.category_id').all();
  return {
    scope: { category: p.category, document: p.account, months: p.months },
    period,
    months_with_data: withData,
    household_income_avg: r2(incomeAll / withData),
    income_avg: r2(byMonth.reduce((s, x) => s + x.income, 0) / withData),
    expense_avg: r2(byMonth.reduce((s, x) => s + x.expense, 0) / withData),
    by_month: byMonth,
    categories: categories.map(({ id: _id, ...c }) => c),
    card_bills_without_detail_avg: unknown,
    budgets,
    goal: p.goal_amount ? { amount: p.goal_amount, until: p.goal_month, months_left: monthsLeft(p.goal_month) } : null,
  };
}

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    savings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          monthly_target: { type: 'number' },
          reason: { type: 'string' },
          actions: { type: 'array', items: { type: 'string' } },
        },
        required: ['category', 'monthly_target', 'reason', 'actions'],
        additionalProperties: false,
      },
    },
    goal_feedback: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'highlights', 'savings', 'goal_feedback', 'warnings'],
  additionalProperties: false,
};

function prompt(data, p) {
  const focus = [
    p.category && `Foque na categoria "${p.category}" (os itens em "categories" são as subcategorias dela).`,
    p.account && `Os dados são só do documento "${p.account}" (um extrato ou fatura específico).`,
  ]
    .filter(Boolean)
    .join('\n');
  const goal = data.goal
    ? `- Há um objetivo: juntar R$ ${data.goal.amount} até ${data.goal.until} (${data.goal.months_left} meses). Monte os cortes para chegar o mais perto possível
  do objetivo sem ser irreal, e explique em "goal_feedback" se é viável e o que mais seria preciso.`
    : '- "goal_feedback": texto vazio (não há objetivo).';
  return `Você é um consultor de finanças pessoais para uma família brasileira. Analise os dados (valores em R$, por mês) e responda em português do Brasil, direto e concreto.
${focus}
- "summary": 3 a 5 frases sobre o período (renda x gasto, tendência, o que pesou mais).
- "highlights": 3 a 6 observações com números (categoria que mais cresceu, mês fora da curva, loja que concentra o gasto).
- "savings": até 6 itens onde dá para economizar, priorizando conforto e o que cresceu. "category" exatamente como na lista "categories",
  "monthly_target" = gasto mensal realista para os próximos meses (menor que a média, sem cortes impossíveis em itens essenciais),
  "reason" curta e "actions" com 2 ou 3 ações práticas.
${goal}
- "warnings": riscos (gasto acima da renda, meta estourada, poucos meses de dados). Lista vazia se não houver.
Não invente dados que não estão abaixo. Não calcule economia acumulada: o app calcula.${
    p.guidance
      ? `

Pedido do usuário (leve em conta, mas mantenha o formato acima):
"""${p.guidance}"""`
      : ''
  }

Dados:
${JSON.stringify(data)}`;
}

// Junta a resposta da IA com as contas feitas aqui
function enrich(answer, data, p) {
  const byName = new Map(data.categories.map((c) => [c.name.toLowerCase(), c]));
  const left = data.goal?.months_left || null;
  const savings = [];
  for (const s of Array.isArray(answer?.savings) ? answer.savings : []) {
    const c = byName.get(String(s.category || '').toLowerCase());
    if (!c || savings.some((x) => x.category === c.name)) continue;
    const target = Math.max(0, Math.min(c.average, Number(s.monthly_target) || 0));
    const monthly = r2(c.average - target);
    if (monthly <= 0) continue;
    savings.push({
      category: c.name,
      average: c.average,
      target: r2(target),
      monthly,
      in3: r2(monthly * 3),
      in6: r2(monthly * 6),
      in12: r2(monthly * 12),
      ...(left ? { until_goal: r2(monthly * left) } : {}),
      reason: String(s.reason || '').slice(0, 300),
      actions: (Array.isArray(s.actions) ? s.actions : []).slice(0, 4).map((a) => String(a).slice(0, 200)),
    });
  }
  const total = r2(savings.reduce((a, s) => a + s.monthly, 0));
  const strs = (v, n) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => String(x).slice(0, 400));
  let goal = null;
  if (data.goal) {
    const reached = r2(total * left);
    goal = {
      ...data.goal,
      needed_monthly: r2(data.goal.amount / left),
      reached,
      coverage: Math.round((reached / data.goal.amount) * 1000) / 10,
      feedback: String(answer?.goal_feedback || '').slice(0, 800),
    };
  }
  return {
    params: p,
    period: data.period,
    income_avg: data.income_avg,
    expense_avg: data.expense_avg,
    household_income_avg: data.household_income_avg,
    summary: String(answer?.summary || '').slice(0, 1500),
    highlights: strs(answer?.highlights, 8),
    warnings: strs(answer?.warnings, 6),
    savings,
    total: { monthly: total, in3: r2(total * 3), in6: r2(total * 6), in12: r2(total * 12), ...(left ? { until_goal: r2(total * left) } : {}) },
    goal,
  };
}

const row = (r) =>
  r && {
    id: r.id,
    at: r.created_at.replace(' ', 'T') + 'Z',
    created_by: r.created_by,
    owner: r.owner_id,
    title: r.title,
    saved: Boolean(r.saved),
    ...JSON.parse(r.result),
  };

async function generate(body, user) {
  if (!ai.enabled()) throw fail('IA desligada (defina FF_AI_PROVIDER).');
  const owner = body.owner && body.owner !== 'all' ? Number(body.owner) : null;
  const p = normalizeParams(body, owner);
  if (Date.now() - lastAt < MIN_INTERVAL) throw fail('Aguarde um minuto antes de gerar de novo.', 429);
  lastAt = Date.now();
  const data = buildData(p);
  let answer;
  try {
    answer =
      config.ai.provider === 'webhook'
        ? await ai.askWebhook({ type: 'insights', prompt: prompt(data, p), data }, { action: 'insights', user })
        : await ai.askJSON(prompt(data, p), SCHEMA, 'medium', { action: 'insights', user });
  } catch (e) {
    throw fail(`Falha na análise por IA: ${String(e.message || e).slice(0, 200)}`, 502);
  }
  const result = enrich(answer, data, p);
  // guarda a gerada (não salva); mantém só as 10 últimas não salvas
  const id = db
    .prepare('INSERT INTO insights (created_by, owner_id, params, result) VALUES (?, ?, ?, ?)')
    .run(user?.id || null, owner, JSON.stringify(p), JSON.stringify(result)).lastInsertRowid;
  db.prepare('DELETE FROM insights WHERE saved = 0 AND id NOT IN (SELECT id FROM insights WHERE saved = 0 ORDER BY id DESC LIMIT 10)').run();
  return row(db.prepare('SELECT * FROM insights WHERE id = ?').get(id));
}

// última análise da pessoa/família (salva ou não)
function last(owner = null) {
  return row(db.prepare(`SELECT * FROM insights WHERE ${owner ? 'owner_id = ?' : 'owner_id IS NULL'} ORDER BY id DESC LIMIT 1`).get(...(owner ? [owner] : []))) || null;
}

function get(id) {
  return row(db.prepare('SELECT * FROM insights WHERE id = ?').get(Number(id))) || null;
}

// salvas: lista resumida (para rever depois)
function listSaved() {
  return db
    .prepare('SELECT i.id, i.created_at, i.title, i.owner_id, i.params, u.name AS created_by_name FROM insights i LEFT JOIN users u ON u.id = i.created_by WHERE i.saved = 1 ORDER BY i.id DESC')
    .all()
    .map((r) => ({ id: r.id, at: r.created_at.replace(' ', 'T') + 'Z', title: r.title, owner: r.owner_id, created_by: r.created_by_name, params: JSON.parse(r.params) }));
}

function save(id, title) {
  const t = String(title || '').trim().slice(0, 100);
  const r = db.prepare('UPDATE insights SET saved = 1, title = ? WHERE id = ?').run(t || null, Number(id));
  if (!r.changes) throw fail('Análise não encontrada.', 404);
}

// excluir: quem gerou ou um administrador
function remove(id, user) {
  const r = db.prepare('SELECT created_by FROM insights WHERE id = ?').get(Number(id));
  if (!r) throw fail('Análise não encontrada.', 404);
  if (r.created_by && r.created_by !== user.id && !user.is_admin) throw fail('Só quem gerou (ou um administrador) pode excluir.', 403);
  db.prepare('DELETE FROM insights WHERE id = ?').run(Number(id));
}

// opções dos filtros: documentos (contas e cartões) e categorias principais de despesa
function options(owner = null) {
  const accounts = db
    .prepare(
      `SELECT t.account, t.kind, u.name AS owner, MIN(t.ref_month) AS first, MAX(t.ref_month) AS last, COUNT(*) AS n FROM transactions t
       LEFT JOIN users u ON u.id = t.owner_id WHERE t.kind IN ('conta', 'cartao', 'holerite', 'manual') ${owner ? 'AND t.owner_id = ?' : ''}
       GROUP BY t.account ORDER BY t.kind, t.account`
    )
    .all(...(owner ? [owner] : []));
  const categories = db
    .prepare("SELECT id, name, icon FROM categories WHERE kind = 'despesa' AND parent_id IS NULL AND COALESCE(key, name) NOT IN ('Fatura de cartão sem detalhe', 'Custos da renda') ORDER BY sort, name")
    .all();
  const range = db.prepare('SELECT MIN(ref_month) AS min, MAX(ref_month) AS max FROM transactions').get();
  return { accounts, categories, min_month: range.min, max_month: range.max };
}

// só para testes: libera o limite de uma análise por minuto
const resetRateLimit = () => (lastAt = 0);

module.exports = { generate, last, get, listSaved, save, remove, options, buildData, normalizeParams, resetRateLimit };
