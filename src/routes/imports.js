// Envio e gestão dos arquivos importados (PDF/OFX)
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { db } = require('../db');
const { importFile } = require('../importer');
const { afterImport } = require('../ai');
const pending = require('../pending');

const router = express.Router();

// arquivos ficam em memória só durante a leitura; limite de tamanho e quantidade
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 10, fields: 10 },
});

// ---------- importação ----------
router.post('/imports', upload.array('files'), async (req, res) => {
  const results = [];
  for (const f of req.files || []) {
    const filename = Buffer.from(f.originalname, 'latin1').toString('utf8');
    try {
      results.push({
        ok: true,
        ...(await importFile({
          buffer: f.buffer,
          filename,
          userId: req.user.id,
          password: req.body.password || undefined,
          ownerId: req.body.owner_id ? Number(req.body.owner_id) : null,
        })),
      });
    } catch (e) {
      const out = { ok: false, filename, error: e.message || 'Falha ao ler o arquivo.', code: e.code };
      // formato sem leitor: guarda (na memória, 1 h) para a pessoa escolher como ler
      if (e.code === 'NO_PARSER') {
        out.format = e.format;
        out.pending_id = pending.put({ buffer: f.buffer, filename, format: e.format, password: req.body.password || undefined, ownerId: req.body.owner_id ? Number(req.body.owner_id) : null, userId: req.user.id });
      }
      results.push(out);
      if (!['DUPLICATE', 'PDF_PASSWORD', 'NO_PARSER'].includes(e.code)) console.error('[import]', filename, e);
    }
  }
  // IA (se ligada e no automático): analisa as lojas novas sem categoria, em segundo plano
  if (results.some((r) => r.ok)) afterImport(req.user);
  res.json({ results });
});

router.get('/imports', (req, res) => {
  res.json(
    db
      .prepare(`SELECT i.id, i.filename, i.parser, i.bank, i.kind, i.account, i.holder, i.due_date, i.period_start, i.period_end,
                       i.stated_total, i.amount_due, i.computed_total, i.total_label, i.warnings, i.tx_count, i.skipped_count,
                       i.partial, i.created_at, u.name AS uploaded_by
                FROM imports i LEFT JOIN users u ON u.id = i.uploaded_by ORDER BY i.created_at DESC, i.id DESC`)
      .all()
      .map((r) => ({ ...r, warnings: JSON.parse(r.warnings || '[]') }))
  );
});

router.get('/imports/:id/file', (req, res) => {
  const imp = db.prepare('SELECT filename, stored_path FROM imports WHERE id = ?').get(req.params.id);
  if (!imp || !imp.stored_path || !fs.existsSync(imp.stored_path)) return res.status(404).end();
  res.download(imp.stored_path, imp.filename);
});

// marcar/desmarcar fatura como parcial (o documento do mês continua pendente até a versão fechada)
router.patch('/imports/:id', (req, res) => {
  if (typeof req.body?.partial !== 'boolean') return res.status(400).json({ error: 'Informe partial (true ou false).' });
  const r = db.prepare('UPDATE imports SET partial = ? WHERE id = ?').run(req.body.partial ? 1 : 0, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Importação não encontrada.' });
  res.json({ ok: true });
});

router.delete('/imports/:id', (req, res) => {
  const imp = db.prepare('SELECT stored_path FROM imports WHERE id = ?').get(req.params.id);
  if (!imp) return res.status(404).json({ error: 'Importação não encontrada.' });
  db.prepare('DELETE FROM imports WHERE id = ?').run(req.params.id);
  if (imp.stored_path) fs.rm(imp.stored_path, { force: true }, () => {});
  res.json({ ok: true });
});

module.exports = router;
