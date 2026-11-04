// Ajustes: categorias, regras, documentos/alertas, impostos embutidos, cartões e fontes de renda
const express = require('express');
const { requireAdmin } = require('../auth');
const ai = require('../ai');
const { exportRules, importRules } = require('../rules-io');
const { db } = require('../db');
const { computeAlerts, dismiss } = require('../alerts');
const { recategorizeAll, reconcileCardPayments } = require('../categorize');
const { loadSources } = require('../filters');
const { monthDocs } = require('../docs');
const { channelOf, loadChannelCtx } = require('../channel');
const { DEFAULT_RATES, OVERRIDES } = require('../taxes');
const { ym } = require('../lib/dates');

const router = express.Router();

// ---------- categorias e regras ----------
router.get('/categories', (req, res) => {
  res.json(db.prepare('SELECT * FROM categories ORDER BY sort, name').all());
});

router.post('/categories', (req, res) => {
  const { name, kind, icon } = req.body || {};
  if (!name || !['despesa', 'receita', 'neutra'].includes(kind)) return res.status(400).json({ error: 'Informe nome e tipo.' });
  try {
    const id = db
      .prepare('INSERT INTO categories (name, kind, icon, sort) VALUES (?, ?, ?, 90)')
      .run(String(name).trim().slice(0, 60), kind, String(icon || '').trim().slice(0, 16) || '•').lastInsertRowid;
    res.json({ id });
  } catch {
    res.status(400).json({ error: 'Já existe uma categoria com esse nome.' });
  }
});

// Editar nome/emoji e agrupar: a categoria vira subcategoria de outra do mesmo tipo (um nível só)
router.patch('/categories/:id', (req, res) => {
  const id = Number(req.params.id);
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!cat) return res.status(404).json({ error: 'Categoria não encontrada.' });
  const b = req.body || {};
  if ('nature' in b) {
    const nature = ['essencial', 'conforto'].includes(b.nature) ? b.nature : null;
    db.prepare('UPDATE categories SET nature = ? WHERE id = ?').run(nature, id);
    if (!('name' in b || 'icon' in b || 'parent_id' in b)) return res.json({ ok: true });
  }
  if ('name' in b || 'icon' in b) {
    const name = 'name' in b ? String(b.name || '').trim().slice(0, 60) : cat.name;
    const icon = 'icon' in b ? String(b.icon || '').trim().slice(0, 16) || '•' : cat.icon;
    if (!name) return res.status(400).json({ error: 'Informe o nome.' });
    try {
      db.prepare('UPDATE categories SET name = ?, icon = ? WHERE id = ?').run(name, icon, id);
    } catch {
      return res.status(400).json({ error: 'Já existe uma categoria com esse nome.' });
    }
    if (!('parent_id' in b)) return res.json({ ok: true });
  }
  const parentId = req.body?.parent_id ? Number(req.body.parent_id) : null;
  if (parentId) {
    const parent = db.prepare('SELECT * FROM categories WHERE id = ?').get(parentId);
    if (!parent || parent.id === id) return res.status(400).json({ error: 'Grupo inválido.' });
    if (parent.kind !== cat.kind) return res.status(400).json({ error: 'O grupo precisa ser do mesmo tipo (despesa com despesa, receita com receita).' });
    if (parent.parent_id) return res.status(400).json({ error: `"${parent.name}" já é subcategoria; escolha uma categoria principal.` });
    if (db.prepare('SELECT 1 FROM categories WHERE parent_id = ?').get(id)) return res.status(400).json({ error: `"${cat.name}" já é grupo de outras categorias.` });
  }
  db.prepare('UPDATE categories SET parent_id = ? WHERE id = ?').run(parentId, id);
  res.json({ ok: true });
});

// Documentos do mês: enviados e os que provavelmente faltam
router.get('/docs', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : ym();
  res.json(monthDocs(month));
});

// ---------- impostos embutidos (estimativa por categoria) ----------
router.get('/tax-rates', (req, res) => {
  const cats = db.prepare("SELECT id, name, key, icon, tax_rate FROM categories WHERE kind = 'despesa' ORDER BY sort, name").all();
  res.json({
    categories: cats
      .filter((c) => (c.key || c.name) !== 'Impostos e taxas' && (c.key || c.name) !== 'Custos da renda')
      .map((c) => ({ ...c, default: DEFAULT_RATES[c.key || c.name] ?? 0.2 })),
    overrides: OVERRIDES.map((o) => ({ label: o.label, rate: o.rate })),
  });
});
router.patch('/tax-rates/:id', (req, res) => {
  const v = req.body?.rate;
  const rate = v === null || v === '' ? null : Number(v);
  if (rate !== null && !(rate >= 0 && rate <= 0.9)) return res.status(400).json({ error: 'Use um percentual entre 0 e 90.' });
  db.prepare('UPDATE categories SET tax_rate = ? WHERE id = ?').run(rate, Number(req.params.id));
  res.json({ ok: true });
});

// ---------- cartões: virtual (online) / físico (presencial) / misto ----------
router.get('/cards', (req, res) => {
  const modes = Object.fromEntries(db.prepare('SELECT account, mode FROM cards').all().map((c) => [c.account, c.mode]));
  const cctx = loadChannelCtx();
  const rows = db.prepare("SELECT t.*, u.name AS owner FROM transactions t LEFT JOIN users u ON u.id = t.owner_id WHERE t.kind = 'cartao' AND t.amount < 0 AND t.is_payment = 0").all();
  const out = new Map();
  for (const t of rows) {
    const c = out.get(t.account) || { account: t.account, mode: modes[t.account] || 'misto', owner: t.owner, online: 0, presencial: 0, n: 0 };
    const ch = channelOf(t, cctx);
    if (ch) c[ch.channel]++;
    c.n++;
    out.set(t.account, c);
  }
  res.json([...out.values()].sort((a, b) => a.account.localeCompare(b.account)));
});
router.put('/cards', (req, res) => {
  const { account, mode } = req.body || {};
  if (!account || !['virtual', 'fisico', 'misto'].includes(mode)) return res.status(400).json({ error: 'Cartão ou tipo inválido.' });
  db.prepare('INSERT OR REPLACE INTO cards (account, mode) VALUES (?, ?)').run(String(account), mode);
  res.json({ ok: true });
});

// ---------- fontes de renda (filtro do painel) ----------
router.get('/sources', (req, res) => res.json(loadSources()));

function sourceInput(b) {
  const name = String(b.name || '').trim().slice(0, 60);
  const matchers = (Array.isArray(b.matchers) ? b.matchers : [])
    .filter((x) => ['account', 'pattern', 'category'].includes(x?.t) && String(x.v ?? '').trim())
    .map((x) => ({ t: x.t, v: x.t === 'category' ? Number(x.v) : String(x.v).trim().slice(0, 80) }))
    .slice(0, 40);
  if (!name || !matchers.length) return null;
  return { name, owner_id: b.owner_id ? Number(b.owner_id) : null, matchers: JSON.stringify(matchers) };
}
const SOURCE_ERR = 'Informe o nome e pelo menos uma regra (categoria, texto ou conta).';
router.post('/sources', (req, res) => {
  const s = sourceInput(req.body || {});
  if (!s) return res.status(400).json({ error: SOURCE_ERR });
  const sort = (db.prepare('SELECT MAX(sort) m FROM income_sources').get().m || 0) + 1;
  res.json({ id: db.prepare('INSERT INTO income_sources (name, owner_id, matchers, sort) VALUES (@name, @owner_id, @matchers, @sort)').run({ ...s, sort }).lastInsertRowid });
});
router.put('/sources/:id', (req, res) => {
  const s = sourceInput(req.body || {});
  if (!s) return res.status(400).json({ error: SOURCE_ERR });
  db.prepare('UPDATE income_sources SET name = @name, owner_id = @owner_id, matchers = @matchers WHERE id = @id').run({ ...s, id: Number(req.params.id) });
  res.json({ ok: true });
});
router.delete('/sources/:id', (req, res) => {
  db.prepare('DELETE FROM income_sources WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/rules', (req, res) => {
  res.json(
    db
      .prepare(`SELECT r.*, c.name AS category, c.icon FROM rules r JOIN categories c ON c.id = r.category_id
                ORDER BY r.source = 'usuario' DESC, r.priority DESC, r.pattern`)
      .all()
  );
});

// Exportar / importar regras (JSON). Importar mexe na categorização de todos: só administrador.
router.get('/rules/export', (req, res) => {
  res.setHeader('Content-Disposition', `attachment; filename="family-finances-regras-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(exportRules());
});
router.post('/rules/import', requireAdmin, (req, res) => {
  try {
    const r = importRules(req.body?.data);
    res.json({ ...r, changed: recategorizeAll() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro ao importar.' });
  }
});

// IA opcional: estado, ligar/desligar o automático e rodar agora
router.get('/ai/status', (req, res) => res.json(ai.status()));
router.put('/ai/auto', requireAdmin, (req, res) => {
  ai.setAuto(Boolean(req.body?.auto));
  res.json(ai.status());
});
router.post('/ai/run', requireAdmin, async (req, res) => {
  try {
    res.json(await ai.run('manual'));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/rules', (req, res) => {
  const { pattern, category_id, apply } = req.body || {};
  const p = String(pattern || '').trim();
  if (p.length < 3 || p.length > 80 || !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(Number(category_id)))
    return res.status(400).json({ error: 'Informe um texto (3 a 80 letras) e a categoria.' });
  db.prepare("DELETE FROM rules WHERE source = 'usuario' AND pattern = ?").run(p);
  const id = db.prepare("INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, ?, 100, 'usuario')").run(p, category_id).lastInsertRowid;
  const changed = apply === false ? 0 : recategorizeAll();
  res.json({ id, changed });
});

router.delete('/rules/:id', (req, res) => {
  db.prepare('DELETE FROM rules WHERE id = ?').run(req.params.id);
  res.json({ ok: true, changed: recategorizeAll() });
});

router.post('/rules/apply', (req, res) => {
  const changed = recategorizeAll();
  const reconciled = reconcileCardPayments();
  res.json({ changed, reconciled });
});


// ---------- documentos faltando ----------
router.get('/alerts', (req, res) => {
  const all = computeAlerts();
  res.json(req.query.month ? all.filter((a) => !a.month || a.month === req.query.month) : all);
});

router.post('/alerts/dismiss', (req, res) => {
  if (!req.body?.key) return res.status(400).json({ error: 'Alerta inválido.' });
  dismiss(req.body.key);
  res.json({ ok: true });
});

module.exports = router;
