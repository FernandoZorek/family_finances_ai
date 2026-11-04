// Administração de usuários (só administradores)
const express = require('express');
const { db } = require('../db');
const auth = require('../auth');
const { createUser } = require('../users');

const router = express.Router();
router.use(auth.requireAdmin);

const LIST = `SELECT id, username, name, color, aliases, is_admin, disabled, must_change_password, last_login_at, created_at,
  (SELECT COUNT(*) FROM transactions t WHERE t.owner_id = users.id) AS tx_count FROM users ORDER BY id`;
const activeAdmins = () => db.prepare('SELECT COUNT(*) n FROM users WHERE is_admin = 1 AND disabled = 0').get().n;
const fail = (res, status, error) => res.status(status).json({ error });

router.get('/users', (req, res) => res.json(db.prepare(LIST).all()));

router.post('/users', (req, res) => {
  const { username, name, password, is_admin, aliases } = req.body || {};
  try {
    const r = createUser({ username, name, password, isAdmin: Boolean(is_admin), aliases });
    // senha gerada volta uma única vez, para o admin repassar; o usuário troca no primeiro acesso
    res.json({ id: r.id, temporary_password: r.password });
  } catch (e) {
    fail(res, e.status || 500, e.status ? e.message : 'Erro ao criar usuário.');
  }
});

router.patch('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return fail(res, 404, 'Usuário não encontrado.');
  const b = req.body || {};
  const isAdmin = 'is_admin' in b ? (b.is_admin ? 1 : 0) : u.is_admin;
  const disabled = 'disabled' in b ? (b.disabled ? 1 : 0) : u.disabled;
  // não deixa a casa sem administrador nem o admin se trancar para fora
  if (id === req.user.id && (!isAdmin || disabled)) return fail(res, 400, 'Você não pode tirar o seu próprio acesso de administrador.');
  if (u.is_admin && !u.disabled && (!isAdmin || disabled) && activeAdmins() <= 1) return fail(res, 400, 'É preciso ter ao menos um administrador ativo.');
  const name = 'name' in b ? String(b.name || '').trim().slice(0, 60) : u.name;
  if (!name) return fail(res, 400, 'Informe o nome.');
  const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : u.color;
  db.prepare('UPDATE users SET name = ?, color = ?, is_admin = ?, disabled = ? WHERE id = ?').run(name, color, isAdmin, disabled, id);
  if (disabled) auth.revokeSessions(id);
  res.json({ ok: true });
});

// Senha temporária nova (o usuário troca no próximo acesso); encerra as sessões dele
router.post('/users/:id/reset-password', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!u) return fail(res, 404, 'Usuário não encontrado.');
    const pw = auth.generatePassword();
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(await auth.hashPassword(pw), id);
    auth.revokeSessions(id);
    res.json({ temporary_password: pw });
  } catch (e) {
    next(e);
  }
});

// Excluir só quem não tem lançamentos (quem tem, desative: o histórico da casa continua)
router.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return fail(res, 400, 'Você não pode excluir a si mesmo.');
  const u = db.prepare(LIST.replace('ORDER BY id', 'WHERE id = ?')).get(id);
  if (!u) return fail(res, 404, 'Usuário não encontrado.');
  if (u.tx_count > 0) return fail(res, 400, `Esse usuário tem ${u.tx_count} lançamentos. Desative em vez de excluir.`);
  if (u.is_admin && !u.disabled && activeAdmins() <= 1) return fail(res, 400, 'É preciso ter ao menos um administrador ativo.');
  db.transaction(() => {
    db.prepare('UPDATE imports SET uploaded_by = NULL WHERE uploaded_by = ?').run(id);
    db.prepare('UPDATE commitments SET owner_id = NULL WHERE owner_id = ?').run(id);
    db.prepare('UPDATE income_sources SET owner_id = NULL WHERE owner_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

module.exports = router;
