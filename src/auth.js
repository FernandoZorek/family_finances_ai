// Sessões por cookie (token aleatório; no banco só o hash), senhas com bcrypt, CSRF por cabeçalho,
// limite de tentativas de login e papéis (administrador / membro).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const config = require('./config');

const COOKIE = 'fin_sid';
const BCRYPT_ROUNDS = 12;
const MIN_PASSWORD = 10;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
// hash de referência: login de usuário inexistente gasta o mesmo tempo (não revela quem existe)
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {}
    }
  }
  return out;
}

function setCookie(req, res, value, maxAgeSec) {
  const secure = config.cookieSecure === 'auto' ? req.secure : config.cookieSecure;
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha(token), userId, expires);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  setCookie(req, res, token, config.sessionDays * 86400);
}

const tokenOf = (req) => parseCookies(req.headers.cookie)[COOKIE];

function destroySession(req, res) {
  const token = tokenOf(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(token));
  setCookie(req, res, '', 0);
}

// Encerra as sessões do usuário (todas, ou todas menos a atual)
function revokeSessions(userId, exceptReq) {
  const keep = exceptReq && tokenOf(exceptReq);
  if (keep) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha(keep));
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  color: u.color,
  is_admin: Boolean(u.is_admin),
  must_change_password: Boolean(u.must_change_password),
});

function currentUser(req) {
  const token = tokenOf(req);
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND u.disabled = 0`
    )
    .get(sha(token));
  if (!row || row.expires_at < new Date().toISOString()) return null;
  return publicUser(row);
}

// Proteção CSRF: o cookie é SameSite=Strict e toda chamada que altera dado precisa do cabeçalho
// enviado pelo app (um formulário de outro site não consegue enviar cabeçalho customizado)
function requireFetchHeader(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'fetch') {
    return res.status(403).json({ error: 'Requisição recusada.' });
  }
  next();
}

// Rotas liberadas enquanto a troca de senha obrigatória não foi feita
const ALLOWED_BEFORE_CHANGE = new Set(['/me', '/me/password', '/logout']);

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Faça login.' });
  if (user.must_change_password && !ALLOWED_BEFORE_CHANGE.has(req.path)) {
    return res.status(403).json({ error: 'Troque a senha para continuar.', code: 'PASSWORD_CHANGE_REQUIRED' });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'Apenas administradores.' });
  next();
}

// Limite de tentativas de login: por IP+usuário e por IP (janela de 15 min)
const WINDOW = 15 * 60e3;
const attempts = new Map();
function tooMany(key, max) {
  const a = attempts.get(key);
  return Boolean(a && Date.now() - a.first < WINDOW && a.count >= max);
}
function loginAllowed(ip, username) {
  return !tooMany(`u|${ip}|${username}`, 8) && !tooMany(`ip|${ip}`, 30);
}
function loginFailed(ip, username) {
  const now = Date.now();
  for (const key of [`u|${ip}|${username}`, `ip|${ip}`]) {
    const a = attempts.get(key);
    if (!a || now - a.first > WINDOW) attempts.set(key, { first: now, count: 1 });
    else a.count++;
  }
}
// login certo zera a contagem daquele usuário (a do IP continua, contra varredura de usuários)
function loginSucceeded(ip, username) {
  attempts.delete(`u|${ip}|${username}`);
  const a = attempts.get(`ip|${ip}`);
  if (a && a.count > 0) a.count--;
}
function pruneAttempts() {
  const now = Date.now();
  for (const [k, a] of attempts) if (now - a.first > WINDOW) attempts.delete(k);
}

async function verifyLogin(username, password) {
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').toLowerCase().trim());
  const ok = await bcrypt.compare(String(password || ''), u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok || u.disabled) return null;
  return u;
}

const hashPassword = (pw) => bcrypt.hash(String(pw), BCRYPT_ROUNDS);
const hashPasswordSync = (pw) => bcrypt.hashSync(String(pw), BCRYPT_ROUNDS);
const generatePassword = () => crypto.randomBytes(12).toString('base64url');

// null = senha aceita; texto = motivo da recusa
function passwordProblem(pw, username) {
  const p = String(pw || '');
  if (p.length < MIN_PASSWORD) return `A senha precisa ter ao menos ${MIN_PASSWORD} caracteres.`;
  if (p.length > 200) return 'Senha longa demais.';
  if (username && p.toLowerCase().includes(String(username).toLowerCase())) return 'A senha não pode conter o nome de usuário.';
  return null;
}

function cleanup() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
  pruneAttempts();
}

module.exports = {
  COOKIE,
  MIN_PASSWORD,
  createSession,
  destroySession,
  revokeSessions,
  currentUser,
  publicUser,
  requireFetchHeader,
  requireAuth,
  requireAdmin,
  loginAllowed,
  loginFailed,
  loginSucceeded,
  verifyLogin,
  hashPassword,
  hashPasswordSync,
  generatePassword,
  passwordProblem,
  cleanup,
  sha,
};
