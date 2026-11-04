// Entradas e saídas recorrentes, financiamentos e sugestões
const express = require('express');
const { db } = require('../db');
const { normalize, rulePatternFor, sameKey } = require('../categorize');
const { cleanSpaces } = require('../parsers/util');
const { commitmentStatus, commitmentInput, COMMITMENT_ERR, COMMITMENT_COLS } = require('../projections');

const router = express.Router();

router.get('/commitments', (req, res) => {
  const rows = db
    .prepare(`SELECT k.*, c.name AS category, c.icon, u.name AS owner FROM commitments k
              LEFT JOIN categories c ON c.id = k.category_id LEFT JOIN users u ON u.id = k.owner_id ORDER BY k.direction, k.id`)
    .all();
  res.json(rows.map(commitmentStatus));
});

router.post('/commitments', (req, res) => {
  const c = commitmentInput(req.body || {});
  if (!c) return res.status(400).json({ error: COMMITMENT_ERR });
  // mesmo texto de busca, mesma pessoa e sentido: atualiza o que já existe em vez de duplicar
  const flat = (s) => normalize(s || '').replace(/ /g, '');
  const dup = c.pattern && db.prepare('SELECT id, pattern, owner_id, direction FROM commitments').all()
    .find((x) => x.direction === c.direction && (x.owner_id || null) === (c.owner_id || null) && flat(x.pattern) === flat(c.pattern));
  if (dup) {
    db.prepare(`UPDATE commitments SET ${COMMITMENT_COLS.split(', ').map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id`).run({ ...c, id: dup.id });
    return res.json({ id: dup.id, updated: true });
  }
  const id = db
    .prepare(`INSERT INTO commitments (${COMMITMENT_COLS}) VALUES (${COMMITMENT_COLS.split(', ').map((k) => '@' + k).join(', ')})`)
    .run(c).lastInsertRowid;
  res.json({ id });
});

router.put('/commitments/:id', (req, res) => {
  const c = commitmentInput(req.body || {});
  if (!c) return res.status(400).json({ error: COMMITMENT_ERR });
  db.prepare(`UPDATE commitments SET ${COMMITMENT_COLS.split(', ').map((k) => `${k}=@${k}`).join(', ')} WHERE id=@id`).run({ ...c, id: Number(req.params.id) });
  res.json({ ok: true });
});

router.delete('/commitments/:id', (req, res) => {
  db.prepare('DELETE FROM commitments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Sugestões: o mesmo lançamento (descrição sem números, mesmo sinal, mesma pessoa) em 2+ dos últimos 3 meses com dados
router.get('/commitments/suggestions', (req, res) => {
  const months = db.prepare('SELECT DISTINCT ref_month AS m FROM transactions ORDER BY m DESC LIMIT 3').all().map((r) => r.m);
  if (months.length < 2) return res.json([]);
  const rows = db
    .prepare(`SELECT t.description, t.amount, t.ref_month, t.owner_id, t.category_id, t.kind, c.name AS category, c.icon, c.kind AS ckind
              FROM transactions t JOIN categories c ON c.id = t.category_id
              WHERE t.ref_month IN (${months.map(() => '?').join(',')}) AND t.ignored = 0 AND t.installment IS NULL
                AND c.kind != 'neutra' AND COALESCE(c.key, c.name) != 'Fatura de cartão sem detalhe'`)
    .all(...months);
  const existing = db.prepare('SELECT pattern, name FROM commitments').all().map((c) => normalize(c.pattern || c.name).replace(/ /g, ''));
  const groups = new Map();
  for (const t of rows) {
    const key = sameKey(t.description);
    if (key.length < 4) continue;
    const dir = t.amount > 0 ? 'entrada' : 'saida';
    if ((dir === 'entrada') !== (t.ckind === 'receita')) continue;
    const id = `${key}|${dir}|${t.owner_id}`;
    const g = groups.get(id) || { key, dir, owner_id: t.owner_id, category_id: t.category_id, category: t.category, icon: t.icon, desc: t.description, months: {}, };
    g.months[t.ref_month] = (g.months[t.ref_month] || 0) + Math.abs(t.amount);
    g.desc = t.description;
    groups.set(id, g);
  }
  const out = [];
  for (const g of groups.values()) {
    const vals = Object.values(g.months);
    if (vals.length < 2) continue;
    if (existing.some((p) => p && (g.key.includes(p) || p.includes(g.key)))) continue;
    const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
    // valor estável (variação até 35%) para não sugerir mercado, posto etc.
    if (Math.max(...vals) > avg * 1.35 || Math.min(...vals) < avg * 0.65 || avg < 10) continue;
    const name = cleanSpaces(g.desc.replace(/^(PAGAMENTO PIX\s*-|PIX ENVIADO\s*(DES:)?|PIX RECEBIDO\s*(REM:)?|DA\s)\s*/i, '').replace(/\b\d{6,}\b/g, '').replace(/\s+\d[\d/.-]*\s*$/, ''));
    out.push({ name: name.slice(0, 60), pattern: rulePatternFor(g.desc), amount: Math.round(avg * 100) / 100, direction: g.dir, owner_id: g.owner_id, category_id: g.category_id, category: g.category, icon: g.icon, seen: vals.length });
  }
  res.json(out.sort((a, b) => b.amount - a.amount).slice(0, 15));
});

module.exports = router;
