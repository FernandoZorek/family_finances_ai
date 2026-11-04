// Insights por IA: como foi o gasto nos últimos meses, onde economizar e quanto isso rende.
// A IA recebe só totais por mês e por categoria (e as maiores lojas de cada categoria, sem PIX/transferências);
// as contas de economia (por mês e em 3/6/12 meses) são feitas aqui, não pela IA.
const { db } = require('./db');
const config = require('./config');
const ai = require('./ai');
const { addMonths, ym } = require('./lib/dates');
const { sameKey, similarKey } = require('./categorize');
const { spendByCategory, childrenMap, sumFor } = require('./budgets');

const r2 = (v) => Math.round(v * 100) / 100;
const SKIP_MERCHANT = /\b(PIX|TED|DOC|TRANSF|TRANSFERENCIA|DEPOSITO|SAQUE|PAGAMENTO DE FATURA|DESCONTO EM FOLHA)\b/;
const MIN_INTERVAL = 60e3; // um pedido por minuto (custo)
let lastAt = 0;

// Dados dos últimos N meses fechados (o mês atual ainda está incompleto)
function buildData(months, owner) {
  const end = addMonths(ym(), -1);
  const period = Array.from({ length: months }, (_, i) => addMonths(end, i - months + 1));
  const ownerSql = owner ? 'AND t.owner_id = ?' : '';
  const args = (m) => (owner ? [m, owner] : [m]);
  const totals = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN c.kind = 'receita' THEN t.amount END), 0) AS income,
            COALESCE(-SUM(CASE WHEN c.kind = 'despesa' THEN t.amount END), 0) AS expense
     FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.ignored = 0 AND t.ref_month = ? ${ownerSql}`
  );
  const byMonth = period.map((m) => ({ month: m, ...totals.get(...args(m)) }));
  const withData = byMonth.filter((x) => x.income || x.expense);
  if (!withData.length) throw Object.assign(new Error('Ainda não há meses com lançamentos nesse período.'), { status: 400 });

  const children = childrenMap();
  const spend = period.map((m) => spendByCategory(m, owner, []));
  const cats = db
    .prepare("SELECT id, name, nature, key FROM categories WHERE kind = 'despesa' AND parent_id IS NULL AND COALESCE(key, name) NOT IN ('Custos da renda') ORDER BY sort")
    .all()
    .map((c) => {
      const vals = spend.map((s) => r2(sumFor(c.id, s, children).real));
      return { id: c.id, key: c.key, name: c.name, nature: c.nature || 'outras', months: vals, average: r2(vals.reduce((a, v) => a + v, 0) / withData.length) };
    })
    .filter((c) => c.average > 0)
    .sort((a, b) => b.average - a.average);
  // fatura paga sem a fatura enviada: gasto real, mas sem saber onde (vai à parte, não como categoria)
  const unknown = cats.find((c) => c.key === 'Fatura de cartão sem detalhe');
  if (unknown) cats.splice(cats.indexOf(unknown), 1);

  // maiores lojas das 6 maiores categorias (só nome sem números; sem PIX nem transferências)
  const merchantsQ = db.prepare(
    `SELECT t.description, -t.amount AS v FROM transactions t JOIN categories c ON c.id = t.category_id
     WHERE t.ignored = 0 AND t.amount < 0 AND t.ref_month BETWEEN ? AND ? AND (c.id = ? OR c.parent_id = ?) ${ownerSql}`
  );
  for (const c of cats.slice(0, 6)) {
    const agg = new Map();
    for (const r of merchantsQ.all(period[0], end, c.id, c.id, ...(owner ? [owner] : []))) {
      const name = similarKey(r.description);
      if (name.length < 3 || SKIP_MERCHANT.test(name)) continue;
      const k = sameKey(r.description);
      const a = agg.get(k) || { name, total: 0, n: 0 };
      a.total += r.v;
      a.n++;
      agg.set(k, a);
    }
    c.top_merchants = [...agg.values()].sort((a, b) => b.total - a.total).slice(0, 4).map((x) => ({ name: x.name, total: r2(x.total), purchases: x.n }));
  }
  const budgets = db.prepare('SELECT c.name AS category, b.monthly_limit FROM budgets b JOIN categories c ON c.id = b.category_id').all();
  const avg = (k) => r2(withData.reduce((a, x) => a + x[k], 0) / withData.length);
  return {
    period,
    months_with_data: withData.length,
    income_avg: avg('income'),
    expense_avg: avg('expense'),
    by_month: byMonth.map((x) => ({ month: x.month, income: r2(x.income), expense: r2(x.expense) })),
    categories: cats.map(({ id: _id, key: _key, ...c }) => c),
    card_bills_without_detail_avg: unknown ? unknown.average : 0,
    budgets,
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
    warnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'highlights', 'savings', 'warnings'],
  additionalProperties: false,
};

function prompt(data) {
  return `Você é um consultor de finanças pessoais para uma família brasileira. Analise os dados (valores em R$, por mês) e responda em português do Brasil, direto e concreto.

- "summary": 3 a 5 frases sobre como foi o período (renda x gasto, tendência, o que pesou mais).
- "highlights": 3 a 6 observações com números (ex.: categoria que mais cresceu, mês fora da curva, loja que concentra o gasto).
- "savings": até 6 categorias onde dá para economizar, priorizando as de conforto e as que cresceram. Para cada uma: "category" exatamente como na lista,
  "monthly_target" = gasto mensal realista para os próximos meses (menor que a média, sem cortes impossíveis em itens essenciais),
  "reason" curta e "actions" com 2 ou 3 ações práticas.
- "warnings": riscos (gasto acima da renda, meta estourada, dados de poucos meses). Lista vazia se não houver.
Não invente dados que não estão abaixo. Não faça contas de economia acumulada: o app calcula.

Dados:
${JSON.stringify(data)}`;
}

// Junta a resposta da IA com as contas feitas aqui
function enrich(answer, data, months) {
  const byName = new Map(data.categories.map((c) => [c.name.toLowerCase(), c]));
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
      reason: String(s.reason || '').slice(0, 300),
      actions: (Array.isArray(s.actions) ? s.actions : []).slice(0, 4).map((a) => String(a).slice(0, 200)),
    });
  }
  const total = r2(savings.reduce((a, s) => a + s.monthly, 0));
  const strs = (v, n) => (Array.isArray(v) ? v : []).slice(0, n).map((x) => String(x).slice(0, 400));
  return {
    months,
    period: data.period,
    income_avg: data.income_avg,
    expense_avg: data.expense_avg,
    summary: String(answer?.summary || '').slice(0, 1500),
    highlights: strs(answer?.highlights, 8),
    warnings: strs(answer?.warnings, 6),
    savings,
    total: { monthly: total, in3: r2(total * 3), in6: r2(total * 6), in12: r2(total * 12) },
  };
}

async function generate({ months = 3, owner = null } = {}) {
  if (!ai.enabled()) throw Object.assign(new Error('IA desligada (defina FF_AI_PROVIDER).'), { status: 400 });
  if (Date.now() - lastAt < MIN_INTERVAL) throw Object.assign(new Error('Aguarde um minuto antes de gerar de novo.'), { status: 429 });
  lastAt = Date.now();
  months = [3, 6, 12].includes(Number(months)) ? Number(months) : 3;
  const data = buildData(months, owner);
  let answer;
  try {
    answer =
      config.ai.provider === 'webhook'
        ? await ai.askWebhook({ type: 'insights', prompt: prompt(data), data })
        : await ai.askJSON(prompt(data), SCHEMA, 'medium');
  } catch (e) {
    throw Object.assign(new Error(`Falha na análise por IA: ${String(e.message || e).slice(0, 200)}`), { status: 502 });
  }
  const result = { at: new Date().toISOString(), owner, ...enrich(answer, data, months) };
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`ai_insights_${owner || 'all'}`, JSON.stringify(result));
  return result;
}

function last(owner = null) {
  try {
    return JSON.parse(db.prepare('SELECT value FROM meta WHERE key = ?').get(`ai_insights_${owner || 'all'}`)?.value || 'null');
  } catch {
    return null;
  }
}

module.exports = { generate, last, buildData };
