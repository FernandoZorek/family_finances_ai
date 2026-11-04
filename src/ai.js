// Classificação opcional por IA: lojas que caíram em "Outros"/"Outras receitas" viram regras automáticas.
// Desligada por padrão. Liga com FF_AI_PROVIDER (anthropic | openai | webhook) — veja .env.example.
// Privacidade: só o nome da loja sem números (sem valores, datas, contas, CPF/CNPJ) e nunca PIX/transferência
// (que trazem nome de pessoas). As regras criadas ficam marcadas como "ia" para revisão.
const { db } = require('./db');
const config = require('./config');
const { similarKey, recategorizeAll } = require('./categorize');

const FALLBACK_CATS = ['Outros', 'Outras receitas'];
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

async function askAnthropic(text) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new (Anthropic.default || Anthropic)({ apiKey: config.ai.apiKey || undefined, baseURL: config.ai.baseUrl || undefined });
  // classificação simples: esforço baixo; fallback do servidor se o modelo recusar o pedido
  const res = await client.beta.messages.create({
    model: config.ai.model,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: text }],
  });
  if (res.stop_reason === 'refusal') throw new Error('O modelo recusou o pedido.');
  if (res.stop_reason === 'max_tokens') throw new Error('Resposta cortada (max_tokens).');
  const block = res.content.find((b) => b.type === 'text');
  return JSON.parse(block?.text || '{}');
}

// Qualquer API compatível com OpenAI (OpenAI, Ollama, LM Studio, OpenRouter, ...)
async function askOpenAI(text) {
  const url = `${(config.ai.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.ai.apiKey ? { Authorization: `Bearer ${config.ai.apiKey}` } : {}) },
    body: JSON.stringify({
      model: config.ai.model,
      messages: [{ role: 'user', content: text }],
      response_format: { type: 'json_schema', json_schema: { name: 'categorias', strict: true, schema: SCHEMA } },
    }),
    signal: AbortSignal.timeout(120e3),
  });
  if (!res.ok) throw new Error(`API respondeu ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}

// Webhook próprio: recebe { categories, items } e responde { items: [{ key, category, confidence }] }
async function askWebhook(items, cats) {
  const res = await fetch(config.ai.baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(config.ai.apiKey ? { Authorization: `Bearer ${config.ai.apiKey}` } : {}) },
    body: JSON.stringify({ categories: cats.map((c) => ({ name: c.name, kind: c.kind })), items: items.map((i) => ({ key: i.key, kind: i.kind })) }),
    signal: AbortSignal.timeout(120e3),
  });
  if (!res.ok) throw new Error(`Webhook respondeu ${res.status}`);
  return res.json();
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
function run(reason = 'manual') {
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
        config.ai.provider === 'anthropic' ? await askAnthropic(text) : config.ai.provider === 'openai' ? await askOpenAI(text) : await askWebhook(items, cats);
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
function afterImport() {
  if (enabled() && isAuto()) run('importação').catch((e) => console.error('[ia]', e.message));
}

module.exports = { status, run, afterImport, candidates, setAuto };
