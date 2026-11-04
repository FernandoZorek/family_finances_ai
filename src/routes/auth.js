// Login, logout e a conta do próprio usuário
const express = require('express');
const { db } = require('../db');
const auth = require('../auth');
const { normalize } = require('../categorize');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    const name = String(username || '').toLowerCase().trim().slice(0, 64);
    if (!auth.loginAllowed(req.ip, name)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
    // conta a tentativa antes do bcrypt: rajadas em paralelo não furam o limite
    auth.loginFailed(req.ip, name);
    const user = await auth.verifyLogin(name, password);
    if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    auth.loginSucceeded(req.ip, name);
    auth.createSession(req, res, user.id);
    res.json({ ok: true, user: auth.publicUser(user) });
  } catch (e) {
    next(e);
  }
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res);
  res.json({ ok: true });
});

// a partir daqui, só logado
const me = express.Router();
me.use(auth.requireAuth);

me.get('/me', (req, res) => {
  const users = db.prepare('SELECT id, username, name, color, aliases FROM users WHERE disabled = 0 ORDER BY id').all();
  res.json({ user: req.user, users });
});

me.post('/me/password', async (req, res, next) => {
  try {
    const { current, next: pw } = req.body || {};
    const key = `pw-${req.user.id}`;
    if (!auth.loginAllowed(req.ip, key)) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
    auth.loginFailed(req.ip, key);
    if (!(await auth.verifyLogin(req.user.username, current))) return res.status(400).json({ error: 'Senha atual incorreta.' });
    auth.loginSucceeded(req.ip, key);
    const bad = auth.passwordProblem(pw, req.user.username);
    if (bad) return res.status(400).json({ error: bad });
    if (String(pw) === String(current)) return res.status(400).json({ error: 'A nova senha precisa ser diferente da atual.' });
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(await auth.hashPassword(pw), req.user.id);
    auth.revokeSessions(req.user.id, req); // outras sessões abertas caem
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Nome e apelidos nos extratos: cada um edita o seu; administrador edita qualquer um
me.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id !== req.user.id && !req.user.is_admin) return res.status(403).json({ error: 'Você só pode editar o seu próprio cadastro.' });
  const { name, aliases } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
  // os apelidos decidem de quem é cada lançamento importado: não podem coincidir com o nome/apelido de outra pessoa
  if (aliases !== undefined) {
    const mine = aliasTokens(aliases);
    const clash = db
      .prepare('SELECT name, aliases FROM users WHERE id != ?')
      .all(id)
      .find((o) => aliasTokens(`${o.name},${o.aliases}`).some((x) => mine.includes(x)));
    if (clash) return res.status(400).json({ error: `Um dos nomes já identifica ${clash.name}.` });
  }
  db.prepare('UPDATE users SET name = ?, aliases = ? WHERE id = ?').run(
    String(name || u.name).trim().slice(0, 60),
    String(aliases ?? u.aliases).trim().slice(0, 300),
    u.id
  );
  res.json({ ok: true });
});

// nomes completos (2+ palavras) normalizados, para comparar apelidos
function aliasTokens(s) {
  return String(s || '')
    .split(',')
    .map((x) => normalize(x))
    .filter((x) => x.split(' ').length >= 2);
}

module.exports = { router, me };
