// Backup diário do banco (mantém os últimos 14). Uso: DATA_DIR=... node scripts/backup.js
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('../src/db');

const dir = path.join(DATA_DIR, 'backups');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, `family-finances-${new Date().toISOString().slice(0, 10)}.db`);
db.backup(file).then(() => {
  const old = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort().reverse().slice(14);
  old.forEach((f) => fs.rmSync(path.join(dir, f)));
  console.log('backup ok:', file);
});
