// Usuários: criação/validação e sincronização com as variáveis de ambiente (FF_ADMIN_*, FF_USERS)
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');
const config = require('./config');
const auth = require('./auth');

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const COLORS = ['#2a78d6', '#e87ba4', '#1f9e74', '#c98500', '#8a6fe0', '#d95926', '#3d8fb5', '#b5553d'];
const nextColor = () => COLORS[db.prepare('SELECT COUNT(*) n FROM users').get().n % COLORS.length];

function userProblem({ username, name }) {
  if (!USERNAME_RE.test(String(username || ''))) return 'Usuário: 3 a 32 caracteres, letras minúsculas, números, ponto, hífen ou sublinhado.';
  if (!String(name || '').trim()) return 'Informe o nome.';
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return 'Esse usuário já existe.';
  return null;
}

// Cria o usuário. Sem senha informada, gera uma temporária. Sempre exige troca no primeiro acesso,
// porque quem definiu a senha (admin ou variável de ambiente) não deve continuar sabendo dela.
function createUser({ username, name, password, isAdmin = false, aliases = '' }) {
  username = String(username || '').trim().toLowerCase();
  const problem = userProblem({ username, name });
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const generated = !password;
  const pw = password || auth.generatePassword();
  if (!generated) {
    const bad = auth.passwordProblem(pw, username);
    if (bad) throw Object.assign(new Error(bad), { status: 400 });
  }
  const id = db
    .prepare(
      `INSERT INTO users (username, name, aliases, password_hash, color, is_admin, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    )
    .run(username, String(name).trim().slice(0, 60), String(aliases || name).trim().toUpperCase().slice(0, 300), auth.hashPasswordSync(pw), nextColor(), isAdmin ? 1 : 0).lastInsertRowid;
  return { id, username, password: generated ? pw : null };
}

// No início: garante os usuários das variáveis de ambiente (cria os que faltam; nunca muda senha existente).
// Sem nenhum usuário e sem variáveis, cria "admin" com senha gerada.
function syncEnvUsers() {
  const wanted = [];
  if (config.admin.username) wanted.push({ username: config.admin.username, name: config.admin.name || config.admin.username, password: config.admin.password, isAdmin: true });
  for (const u of config.users) {
    if (u.username === config.admin.username) continue;
    wanted.push({ username: u.username, name: u.name || u.username, password: config.userPassword(u.username), isAdmin: false });
  }
  if (!wanted.length && !db.prepare('SELECT 1 FROM users').get()) wanted.push({ username: 'admin', name: 'Admin', password: '', isAdmin: true });

  const generated = [];
  for (const w of wanted) {
    const existing = db.prepare('SELECT id, is_admin FROM users WHERE username = ?').get(w.username);
    if (existing) {
      if (w.isAdmin && !existing.is_admin) db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
      continue;
    }
    try {
      const r = createUser(w);
      if (r.password) generated.push(`${r.username}: ${r.password}`);
      console.log(`Usuário criado: ${r.username}${w.isAdmin ? ' (admin)' : ''}`);
    } catch (e) {
      console.error(`Não foi possível criar o usuário "${w.username}" das variáveis de ambiente: ${e.message}`);
    }
  }
  if (generated.length) {
    // senhas geradas: só no arquivo (permissão 600), nunca no log
    const file = path.join(DATA_DIR, 'initial-passwords.txt');
    fs.appendFileSync(file, `# ${new Date().toISOString()} (troca obrigatória no primeiro acesso)\n${generated.join('\n')}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    console.log(`Senhas iniciais geradas em ${file} (apague o arquivo depois do primeiro acesso).`);
  }
  if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1 AND disabled = 0').get()) {
    console.warn('Atenção: nenhum administrador ativo. Defina FF_ADMIN_USERNAME ou use scripts/reset-password.js --admin.');
  }
}

module.exports = { createUser, syncEnvUsers, USERNAME_RE };
