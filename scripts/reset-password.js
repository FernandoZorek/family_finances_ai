// Redefine a senha de um usuário pela linha de comando (acesso ao servidor = acesso de administrador).
// Uso: DATA_DIR=... node scripts/reset-password.js <usuario> [--admin]
//   A senha nova é lida do terminal (não fica no histórico do shell). --admin também torna o usuário administrador.
const readline = require('readline');
const { db } = require('../src/db');
const auth = require('../src/auth');

const args = process.argv.slice(2);
const username = String(args.find((a) => !a.startsWith('--')) || '').toLowerCase();
const makeAdmin = args.includes('--admin');
if (!username) {
  console.error('Uso: node scripts/reset-password.js <usuario> [--admin]');
  process.exit(1);
}
const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!user) {
  console.error('Usuário não encontrado.');
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl.stdoutMuted = true;
rl._writeToOutput = (s) => rl.output.write(rl.stdoutMuted && !s.includes('\n') ? '' : s);
process.stdout.write('Nova senha: ');
rl.question('', async (pw) => {
  rl.close();
  process.stdout.write('\n');
  const bad = auth.passwordProblem(pw, username);
  if (bad) {
    console.error(bad);
    process.exit(1);
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, disabled = 0' + (makeAdmin ? ', is_admin = 1' : '') + ' WHERE id = ?').run(await auth.hashPassword(pw), user.id);
  auth.revokeSessions(user.id);
  console.log(`Senha alterada${makeAdmin ? ' e usuário promovido a administrador' : ''}. Sessões abertas foram encerradas.`);
});
