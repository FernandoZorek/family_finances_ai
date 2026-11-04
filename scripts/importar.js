// Importa arquivos pela linha de comando (mesmo fluxo do envio pelo app).
// Uso: DATA_DIR=... node scripts/importar.js <usuario-que-enviou> <arquivo...>
const fs = require('fs');
const path = require('path');
const { db } = require('../src/db');
const { seed } = require('../src/seed');
const { importFile } = require('../src/importer');

(async () => {
  const [username, ...files] = process.argv.slice(2);
  seed();
  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(String(username || '').toLowerCase());
  if (!user || !files.length) {
    console.error('Uso: node scripts/importar.js <usuario> <arquivo...>');
    process.exit(1);
  }
  for (const f of files) {
    try {
      const r = await importFile({ buffer: fs.readFileSync(f), filename: path.basename(f), userId: user.id });
      const conf = r.statedTotal == null ? 'sem total' : Math.round((r.statedTotal - r.computedTotal) * 100) === 0 ? 'confere' : `DIFERENÇA banco ${r.statedTotal} x lido ${r.computedTotal}`;
      console.log(`OK  ${r.filename} · ${r.parser} · ${r.inserted} lançamentos${r.skipped ? ` (${r.skipped} já existiam)` : ''} · ${conf}`);
    } catch (e) {
      console.log(`ERRO ${path.basename(f)} · ${e.message}`);
    }
  }
})();
