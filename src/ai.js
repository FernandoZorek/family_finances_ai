// Classificação opcional por IA: lojas que caíram em "Outros"/"Outras receitas" viram regras automáticas.
// Desligada por padrão. Liga com FF_AI_PROVIDER (anthropic | openai | webhook) — veja .env.example.
// Privacidade: só o nome da loja sem números (sem valores, datas, contas, CPF/CNPJ) e nunca PIX/transferência
// (que trazem nome de pessoas). As regras criadas ficam marcadas como "ia" para revisão.
const { db } = require('./db');
const config = require('./config');
const { similarKey, recategorizeAll } = require('./categorize');

const FALLBACK_CATS = ['Outros', 'Outras receitas'];

// Preço por 1M de tokens (USD). Anthropic: tabela de preços oficial; Gemini: página de preços do Google
// (estimativa, confira). FF_AI_PRICE_INPUT/OUTPUT sobrepõem. Modelo fora da tabela e sem preço: custo fica em branco.
const PRICES = {
  'claude-fable-5-1': [10, 50],
  'claude-opus-5-5': [4, 20],
  'claude-opus-5': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
  'gemini-2.5-pro': [1.25, 10],
};
function priceOf(model) {
  if (config.ai.priceInput != null && config.ai.priceOutput != null) return { input: config.ai.priceInput, output: config.ai.priceOutput, source: 'configurado' };
  const p = PRICES[model];
  return p ? { input: p[0], output: p[1], source: String(model).startsWith('gemini') ? 'tabela do app (estimativa)' : 'tabela do app' } : null;
}

// registra cada chamada (também as que falharam), com custo estimado
function recordUsage(meta, model, usage, ok) {
  const inT = Math.max(0, Math.round(usage?.input || 0));
  const outT = Math.max(0, Math.round(usage?.output || 0));
  const price = priceOf(model);
  const cost = usage?.cost_usd != null ? Number(usage.cost_usd) : price ? (inT * price.input + outT * price.output) / 1e6 : null;
  db.prepare('INSERT INTO ai_usage (action, provider, model, input_tokens, output_tokens, cost_usd, user_id, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    meta?.action || 'outro',
    config.ai.provider,
    model || null,
    inT,
    outT,
    cost,
    meta?.user?.id || null,
    ok ? 1 : 0
  );
}
const SKIP = /\b(PIX|TED|DOC|TRANSF|TRANSFERENCIA|DEPOSITO|SAQUE|PAGAMENTO DE FATURA|PAGTO FATURA|BOLETO)\b/;
const MAX_ITEMS = 80;

const enabled = () => Boolean(config.ai.provider);
// automático a cada arquivo enviado: escolha salva em Ajustes; sem escolha, FF_AI_AUTO
function isAuto() {
  const v = db.prepare("SELECT value FROM meta WHERE key = 'ai_auto'").get()?.value;
  return v === undefined ? config.ai.auto : v === '1';
}
function setAuto(on) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ai_auto', ?)").run(on ? '1' : '0');
}
let running = null;

// Lojas sem regra própria nos últimos 6 meses (uma entrada por loja)
function candidates() {
  const since = new Date(Date.now() - 183 * 864e5).toISOString().slice(0, 10);
  const rows = db
    .prepare(
      `SELECT t.description, t.amount FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE t.ignored = 0 AND t.category_locked = 0 AND t.date >= ? AND COALESCE(c.key, c.name) IN (${FALLBACK_CATS.map(() => '?').join(',')})`
    )
    .all(since, ...FALLBACK_CATS);
  const seen = new Map();
  for (const r of rows) {
    const key = similarKey(r.description);
    if (key.length < 4 || SKIP.test(key)) continue;
    const kind = r.amount < 0 ? 'despesa' : 'receita';
    const id = `${kind}|${key}`;
    const it = seen.get(id) || { key, kind, n: 0 };
    it.n++;
    seen.set(id, it);
  }
  return [...seen.values()].sort((a, b) => b.n - a.n).slice(0, MAX_ITEMS);
}

function categoryList() {
  return db
    .prepare("SELECT name, kind, key FROM categories WHERE kind IN ('despesa', 'receita') ORDER BY sort, name")
    .all()
    .filter((c) => !FALLBACK_CATS.includes(c.key || c.name) && (c.key || c.name) !== 'Custos da renda');
}

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          category: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['key', 'category', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

function prompt(items, cats) {
  const list = (kind) => cats.filter((c) => c.kind === kind).map((c) => `- ${c.name}`).join('\n');
  return `Você classifica nomes de estabelecimentos que aparecem em extratos e faturas de cartão de bancos brasileiros.
Para cada item, escolha UMA categoria da lista do tipo indicado (despesa ou receita), escrita exatamente como na lista.
"confidence" vai de 0 a 1: use 0.9+ só quando o nome deixa claro o tipo de negócio; se não reconhecer, use valor baixo.
Responda com todos os itens, repetindo o "key" exatamente.

Categorias de despesa:
${list('despesa')}

Categorias de receita:
${list('receita')}

Itens (JSON):
${JSON.stringify(items.map((i) => ({ key: i.key, tipo: i.kind })))}`;
}

async function askAnthropic(text, schema = SCHEMA, effort = 'low') {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new (Anthropic.default || Anthropic)({ apiKey: config.ai.apiKey || undefined, baseURL: config.ai.baseUrl || undefined });
  // classificação simples: esforço baixo; fallback do servidor se o modelo recusar o pedido
  const res = await client.beta.messages.create({
    model: config.ai.model,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: text }],
  });
  // tokens de entrada incluem os de cache (lidos/escritos); saída inclui o raciocínio
  const u = res.usage || {};
  const usage = { input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0 };
  if (res.stop_reason === 'refusal') throw Object.assign(new Error('O modelo recusou o pedido.'), { usage });
  if (res.stop_reason === 'max_tokens') throw Object.assign(new Error('Resposta cortada (max_tokens).'), { usage });
  const block = res.content.find((b) => b.type === 'text');
  return { json: JSON.parse(block?.text || '{}'), usage, model: res.model || config.ai.model };
}

// Qualquer API compatível com OpenAI (OpenAI, Ollama, LM Studio, OpenRouter, ...)
async function askOpenAI(text, schema = SCHEMA) {
  const url = `${(config.ai.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.ai.apiKey ? { Authorization: `Bearer ${config.ai.apiKey}` } : {}) },
    body: JSON.stringify({
      model: config.ai.model,
      messages: [{ role: 'user', content: text }],
      response_format: { type: 'json_schema', json_schema: { name: 'resposta', strict: true, schema } },
    }),
    signal: AbortSignal.timeout(120e3),
  });
  if (!res.ok) throw new Error(`API respondeu ${res.status}`);
  const data = await res.json();
  // saída = total - entrada (inclui tokens de raciocínio, cobrados como saída)
  const u = data.usage || {};
  const usage = { input: u.prompt_tokens || 0, output: u.total_tokens ? u.total_tokens - (u.prompt_tokens || 0) : u.completion_tokens || 0 };
  return { json: JSON.parse(data.choices?.[0]?.message?.content || '{}'), usage, model: config.ai.model };
}

// Webhook próprio: recebe { type, ... } e responde no mesmo formato do schema
//   type "rules":    { categories, items } -> { items: [{ key, category, confidence }] }
//   type "insights": { prompt, data }      -> { summary, highlights, savings, warnings }
async function askWebhook(payload, meta) {
  const res = await fetch(config.ai.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.ai.apiKey ? { Authorization: `Bearer ${config.ai.apiKey}` } : {}) },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120e3),
  });
  if (!res.ok) {
    recordUsage(meta, null, null, false);
    throw new Error(`Webhook respondeu ${res.status}`);
  }
  const json = await res.json();
  // o webhook pode informar o uso: { usage: { input_tokens, output_tokens, cost_usd } }
  const u = json?.usage || {};
  recordUsage(meta, u.model || null, { input: u.input_tokens, output: u.output_tokens, cost_usd: u.cost_usd }, true);
  return json;
}

// Pergunta ao provedor configurado e devolve o JSON no formato do schema; registra o uso (ação, tokens, custo)
async function askJSON(text, schema = SCHEMA, effort = 'low', meta = {}) {
  const ask = config.ai.provider === 'anthropic' ? () => askAnthropic(text, schema, effort) : config.ai.provider === 'openai' ? () => askOpenAI(text, schema) : null;
  if (!ask) throw new Error('Provedor sem suporte a pergunta livre.');
  try {
    const r = await ask();
    recordUsage(meta, r.model, r.usage, true);
    return r.json;
  } catch (e) {
    recordUsage(meta, config.ai.model, e.usage, false);
    throw e;
  }
}

// Quanto a IA gastou: por ação, por mês e total (datas AAAA-MM-DD, opcionais)
function usageReport({ from, to } = {}) {
  const d = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  const where = ['1 = 1'];
  const args = [];
  if (d(from)) where.push('date(at) >= ?'), args.push(from);
  if (d(to)) where.push('date(at) <= ?'), args.push(to);
  const w = where.join(' AND ');
  const agg = `COUNT(*) AS calls, SUM(1 - ok) AS failed, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
    ROUND(SUM(cost_usd), 6) AS cost_usd, SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END) AS without_price`;
  return {
    from: d(from),
    to: d(to),
    currency: 'USD',
    usd_brl: config.ai.usdBrl,
    price: config.ai.provider && config.ai.provider !== 'webhook' ? { model: config.ai.model, ...(priceOf(config.ai.model) || { input: null, output: null, source: 'sem preço (defina FF_AI_PRICE_INPUT/OUTPUT)' }) } : null,
    total: db.prepare(`SELECT ${agg} FROM ai_usage WHERE ${w}`).get(...args),
    by_action: db.prepare(`SELECT action, ${agg} FROM ai_usage WHERE ${w} GROUP BY action ORDER BY cost_usd DESC, calls DESC`).all(...args),
    by_month: db.prepare(`SELECT substr(at, 1, 7) AS month, ${agg} FROM ai_usage WHERE ${w} GROUP BY month ORDER BY month DESC`).all(...args),
    by_model: db.prepare(`SELECT COALESCE(model, provider) AS model, ${agg} FROM ai_usage WHERE ${w} GROUP BY 1 ORDER BY cost_usd DESC`).all(...args),
  };
}

function saveRun(info) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ai_last_run', ?)").run(JSON.stringify({ at: new Date().toISOString(), ...info }));
}

function status() {
  let last = null;
  try {
    last = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'ai_last_run'").get()?.value || 'null');
  } catch {}
  return {
    enabled: enabled(),
    provider: config.ai.provider || null,
    model: config.ai.provider === 'webhook' ? null : config.ai.model,
    auto: isAuto(),
    min_confidence: config.ai.minConfidence,
    pending: enabled() ? candidates().length : null,
    running: Boolean(running),
    last_run: last,
  };
}

// Roda uma análise (uma por vez). Cria regras "ia" para as respostas com confiança suficiente.
function run(reason = 'manual', user = null) {
  if (!enabled()) return Promise.reject(Object.assign(new Error('IA desligada (defina FF_AI_PROVIDER).'), { status: 400 }));
  if (running) return running;
  running = (async () => {
    const items = candidates();
    if (!items.length) {
      saveRun({ reason, sent: 0, created: 0, changed: 0 });
      return { sent: 0, created: 0, changed: 0, rules: [] };
    }
    const cats = categoryList();
    try {
      const text = prompt(items, cats);
      const answer =
        config.ai.provider === 'webhook'
          ? await askWebhook({ type: 'rules', categories: cats.map((c) => ({ name: c.name, kind: c.kind })), items: items.map((i) => ({ key: i.key, kind: i.kind })) }, { action: 'regras', user })
          : await askJSON(text, SCHEMA, 'low', { action: 'regras', user });
      const byKey = new Map(items.map((i) => [i.key, i]));
      const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c]));
      const ins = db.prepare("INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, (SELECT id FROM categories WHERE name = ?), 70, 'ia')");
      const exists = db.prepare('SELECT 1 FROM rules WHERE pattern = ? AND account IS NULL');
      const created = [];
      db.transaction(() => {
        for (const a of Array.isArray(answer?.items) ? answer.items : []) {
          const item = byKey.get(String(a.key || ''));
          const cat = catByName.get(String(a.category || '').toLowerCase());
          // só o que foi pedido, categoria existente do mesmo tipo, confiança acima do mínimo
          if (!item || !cat || cat.kind !== item.kind || !(Number(a.confidence) >= config.ai.minConfidence)) continue;
          if (exists.get(item.key)) continue;
          ins.run(item.key, cat.name);
          created.push({ pattern: item.key, category: cat.name, confidence: Number(a.confidence) });
        }
      })();
      const changed = created.length ? recategorizeAll() : 0;
      saveRun({ reason, sent: items.length, created: created.length, changed });
      if (created.length) console.log(`[ia] ${created.length} regras criadas, ${changed} lançamentos recategorizados`);
      return { sent: items.length, created: created.length, changed, rules: created };
    } catch (e) {
      // não registra a resposta/erro completo (pode conter dados); só a mensagem
      saveRun({ reason, sent: items.length, created: 0, error: String(e.message || e).slice(0, 200) });
      throw Object.assign(new Error(`Falha na análise por IA: ${String(e.message || e).slice(0, 200)}`), { status: 502 });
    }
  })().finally(() => (running = null));
  return running;
}

// Depois de cada importação, se FF_AI_AUTO=true (em segundo plano, sem atrasar o envio)
function afterImport(user = null) {
  if (enabled() && isAuto()) run('importação', user).catch((e) => console.error('[ia]', e.message));
}

module.exports = { status, run, afterImport, candidates, setAuto, askJSON, askWebhook, enabled, usageReport, priceOf };
