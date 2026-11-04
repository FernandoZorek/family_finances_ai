// O que roda uma vez ao iniciar: categorias/regras padrão, usuários das variáveis de ambiente
// e manutenção dos arquivos já importados.
const fs = require('fs');
const { db } = require('./db');
const { seed } = require('./seed');
const { recategorizeAll, reconcileCardPayments } = require('./categorize');
const { syncEnvUsers } = require('./users');

function runOnce(key, fn) {
  if (db.prepare('SELECT 1 FROM meta WHERE key = ?').get(key)) return;
  fn();
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, '1')").run(key);
}

// Uma vez por versão: relê os arquivos guardados para gravar o período declarado no extrato
async function refreshImportPeriods() {
  const VERSION = '2';
  if (db.prepare("SELECT value FROM meta WHERE key = 'periods_version'").get()?.value === VERSION) return;
  const { parseStatement } = require('./parsers');
  for (const r of db.prepare('SELECT id, filename, stored_path FROM imports').all()) {
    try {
      if (!r.stored_path || !fs.existsSync(r.stored_path)) continue;
      const st = await parseStatement(fs.readFileSync(r.stored_path), r.filename, { generic: true });
      db.prepare('UPDATE imports SET period_start = ?, period_end = ?, due_date = COALESCE(?, due_date), amount_due = COALESCE(?, amount_due) WHERE id = ?').run(
        st.periodStart || null,
        st.periodEnd || null,
        st.dueDate || null,
        st.amountDue ?? null,
        r.id
      );
    } catch (e) {
      console.error('[períodos]', r.id, e.message);
    }
  }
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('periods_version', ?)").run(VERSION);
}

async function bootstrap() {
  // regras novas numa atualização: reaplica nos lançamentos que não foram editados à mão
  if (seed()) console.log(`Regras atualizadas: ${recategorizeAll()} lançamentos recategorizados`);
  // grupos padrão (depois quem manda é o usuário em Ajustes)
  runOnce('groups_version', () => {
    const setParent = db.prepare('UPDATE categories SET parent_id = (SELECT id FROM categories WHERE key = ?) WHERE key = ? AND parent_id IS NULL');
    setParent.run('Transporte', 'Veículo');
    setParent.run('Moradia', 'Contas da casa');
  });
  syncEnvUsers();
  await refreshImportPeriods();
  const n = reconcileCardPayments();
  if (n) console.log(`Pagamentos de fatura reconciliados: ${n}`);
}

module.exports = { bootstrap };
