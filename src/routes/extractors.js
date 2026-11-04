// Leitores de documentos: arquivos sem leitor (prévia, mapeamento de CSV, IA, importar) e leitores salvos
const express = require('express');
const { db } = require('../db');
const pending = require('../pending');
const extractors = require('../extractors');
const extractorAi = require('../extractor-ai');
const { importFile } = require('../importer');
const { extractLayoutText } = require('../parsers/pdfText');
const { parseCsv } = require('../parsers/csv');
const ai = require('../ai');

const router = express.Router();
const fail = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro interno.' });
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

// conteúdo do arquivo pendente: linhas do CSV ou páginas do PDF
async function parsedOf(it) {
  if (it.format === 'csv') return { format: 'csv', ...parseCsv(it.buffer) };
  return { format: 'pdf', pages: await extractLayoutText(it.buffer, it.password) };
}

function preview(r) {
  return {
    count: r.transactions.length,
    sample: r.transactions.slice(0, 12),
    bank: r.bank,
    kind: r.kind,
    account: r.account,
    dueDate: r.dueDate,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    statedTotal: r.statedTotal,
    computedTotal: r.computedTotal,
    totalLabel: r.totalLabel,
    warnings: r.warnings,
  };
}

function runWith(template, parsed, it, dueDate) {
  return parsed.format === 'csv' ? extractors.runCsv(template, parsed.rows, { filename: it.filename, dueDate }) : extractors.runText(template, parsed.pages);
}

const pendingOr404 = (req, res) => {
  const it = pending.get(req.params.id, req.user.id);
  if (!it) res.status(404).json({ error: 'Arquivo expirou. Envie de novo.' });
  return it;
};

router.get('/imports/pending/:id', async (req, res) => {
  const it = pendingOr404(req, res);
  if (!it) return;
  try {
    const p = await parsedOf(it);
    res.json({
      filename: it.filename,
      format: it.format,
      ai: ai.enabled() && ai.status().provider !== 'webhook',
      // o próprio usuário vê as primeiras linhas do arquivo dele, para mapear as colunas
      ...(p.format === 'csv' ? { delimiter: p.delimiter, rows: p.rows.slice(0, 12), suggestion: extractors.suggestCsv(p.rows, it.filename) } : {}),
    });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/imports/pending/:id/preview', async (req, res) => {
  const it = pendingOr404(req, res);
  if (!it) return;
  try {
    const template = extractors.validateTemplate(req.body?.template);
    const due = DUE_RE.test(req.body?.due_date || '') ? req.body.due_date : undefined;
    res.json({ template, preview: preview(runWith(template, await parsedOf(it), it, due)) });
  } catch (e) {
    fail(res, e);
  }
});

router.post('/imports/pending/:id/ai', async (req, res) => {
  const it = pendingOr404(req, res);
  if (!it) return;
  try {
    const parsed = await parsedOf(it);
    const { template, result } = await extractorAi.generate(parsed, it.filename, { user: req.user, run: async (t) => runWith(t, parsed, it) });
    res.json({ template, preview: preview(result) });
  } catch (e) {
    fail(res, e);
  }
});

// importar com o modelo confirmado (e salvar o leitor) ou com a leitura genérica
router.post('/imports/pending/:id/import', async (req, res) => {
  const it = pendingOr404(req, res);
  if (!it) return;
  const b = req.body || {};
  try {
    const template = b.generic ? null : extractors.validateTemplate(b.template);
    const due = DUE_RE.test(b.due_date || '') ? b.due_date : undefined;
    let extractorId = null;
    if (template && b.save) extractorId = extractors.saveTemplate(template, { name: b.name, source: b.source === 'ia' ? 'ia' : 'manual', userId: req.user.id });
    const r = await importFile({ buffer: it.buffer, filename: it.filename, userId: req.user.id, password: it.password, ownerId: it.ownerId, template, generic: Boolean(b.generic), dueDate: due });
    if (extractorId) extractors.markUsed(Number(extractorId));
    pending.drop(req.params.id);
    res.json({ ok: true, ...r, extractor_id: extractorId });
  } catch (e) {
    fail(res, e.status ? e : Object.assign(e, { status: e.code === 'DUPLICATE' ? 409 : 400 }));
  }
});

// leitores salvos
router.get('/extractors', (req, res) => res.json(extractors.list()));
router.patch('/extractors/:id(\\d+)', (req, res) => {
  const b = req.body || {};
  const r = db.prepare('SELECT id FROM extractors WHERE id = ?').get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'Leitor não encontrado.' });
  if ('enabled' in b) db.prepare('UPDATE extractors SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, r.id);
  if (b.name) db.prepare('UPDATE extractors SET name = ? WHERE id = ?').run(String(b.name).trim().slice(0, 60), r.id);
  res.json({ ok: true });
});
router.delete('/extractors/:id(\\d+)', (req, res) => {
  db.prepare('DELETE FROM extractors WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = router;
