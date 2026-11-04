const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setupEnv, startApp, client, initialPassword } = require('./helpers');

const dir = setupEnv({ FF_ADMIN_USERNAME: 'chefe', FF_ADMIN_NAME: 'Chefe', FF_USERS: 'ana:Ana Souza', FF_PASSWORD_ANA: 'primeira-senha-forte' });
let server, base;
before(async () => ({ server, base } = await startApp()));
after(() => server.close());

const NEW_PW = 'uma senha bem forte 123';

test('usuários das variáveis de ambiente são criados; senha gerada vai para arquivo 600', () => {
  const file = path.join(dir, 'initial-passwords.txt');
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, 'utf8'), /^chefe: /m);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /^ana: /m); // senha veio do ambiente
  const { db } = require('../src/db');
  assert.equal(db.prepare("SELECT must_change_password m FROM users WHERE username = 'ana'").get().m, 1);
});

test('saúde e cabeçalhos de segurança', async () => {
  const res = await fetch(base + '/healthz');
  assert.equal(res.status, 200);
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(page.headers.get('x-powered-by'), null);
  assert.match(await page.text(), /<title>Family Finances<\/title>/);
});

test('login: CSRF, senha errada, troca obrigatória e fluxo completo', async () => {
  const c = client(base);
  assert.equal((await c('POST', '/api/login', { username: 'chefe', password: 'x' }, { csrf: false })).status, 403);
  assert.equal((await c('POST', '/api/login', { username: 'chefe', password: 'errada' })).status, 401);
  assert.equal((await c('POST', '/api/login', { username: 'ninguem', password: 'errada' })).status, 401);

  const pw = initialPassword(dir, 'chefe');
  const login = await c('POST', '/api/login', { username: 'chefe', password: pw });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal(login.data.user.must_change_password, true);

  // antes de trocar a senha, só /me e /me/password
  const blocked = await c('GET', '/api/categories');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await c('GET', '/api/me')).status, 200);
  assert.equal((await c('POST', '/api/me/password', { current: pw, next: 'curta' })).status, 400);
  assert.equal((await c('POST', '/api/me/password', { current: pw, next: 'chefe-senha-123' })).status, 400); // contém o usuário
  assert.equal((await c('POST', '/api/me/password', { current: pw, next: NEW_PW })).status, 200);

  const cats = await c('GET', '/api/categories');
  assert.equal(cats.status, 200);
  assert.ok(cats.data.length > 10);
  assert.equal(cats.headers.get('cache-control'), 'no-store');
  // alteração sem o cabeçalho do app é recusada mesmo logado
  assert.equal((await c('POST', '/api/categories', { name: 'X', kind: 'despesa' }, { csrf: false })).status, 403);
});

test('administração de usuários e permissões', async () => {
  const admin = client(base);
  assert.equal((await admin('POST', '/api/login', { username: 'chefe', password: NEW_PW })).status, 200);
  const created = await admin('POST', '/api/admin/users', { username: 'bruno', name: 'Bruno' });
  assert.equal(created.status, 200);
  assert.ok(created.data.temporary_password.length >= 12);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'bruno', name: 'Outro' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/users', { username: 'X Y', name: 'Inválido' })).status, 400);

  const bruno = client(base);
  assert.equal((await bruno('POST', '/api/login', { username: 'bruno', password: created.data.temporary_password })).status, 200);
  assert.equal((await bruno('POST', '/api/me/password', { current: created.data.temporary_password, next: NEW_PW })).status, 200);
  assert.equal((await bruno('GET', '/api/admin/users')).status, 403);
  const me = await bruno('GET', '/api/me');
  const chefeId = me.data.users.find((u) => u.username === 'chefe').id;
  assert.equal((await bruno('PATCH', `/api/users/${chefeId}`, { name: 'Hack' })).status, 403);
  assert.equal((await bruno('PATCH', `/api/users/${me.data.user.id}`, { name: 'Bruno S' })).status, 200);

  // desativar derruba a sessão; último admin não pode perder o papel
  const list = await admin('GET', '/api/admin/users');
  const brunoId = list.data.find((u) => u.username === 'bruno').id;
  assert.equal((await admin('PATCH', `/api/admin/users/${brunoId}`, { disabled: true })).status, 200);
  assert.equal((await bruno('GET', '/api/me')).status, 401);
  assert.equal((await admin('PATCH', `/api/admin/users/${chefeId}`, { is_admin: false })).status, 400);

  // nova senha temporária obriga a trocar de novo
  const reset = await admin('POST', `/api/admin/users/${brunoId}/reset-password`);
  assert.equal(reset.status, 200);
  assert.equal((await admin('PATCH', `/api/admin/users/${brunoId}`, { disabled: false })).status, 200);
  const again = client(base);
  const l2 = await again('POST', '/api/login', { username: 'bruno', password: reset.data.temporary_password });
  assert.equal(l2.data.user.must_change_password, true);
  assert.equal((await admin('DELETE', `/api/admin/users/${brunoId}`)).status, 200);
});

test('CSV não executa fórmula e apelido não pode ser de outra pessoa', async () => {
  const c = client(base);
  assert.equal((await c('POST', '/api/login', { username: 'chefe', password: NEW_PW })).status, 200);
  const cats = await c('GET', '/api/categories');
  const outros = cats.data.find((x) => x.key === 'Outros');
  const me = await c('GET', '/api/me');
  assert.equal((await c('POST', '/api/transactions', { date: '2026-10-05', description: '=HYPERLINK("http://x")', amount: '10,00', type: 'despesa', category_id: outros.id })).status, 200);
  assert.equal((await c('POST', '/api/transactions', { date: '2026-10-05', description: 'X', amount: '1', type: 'despesa', category_id: outros.id, owner_id: 999 })).status, 400);
  const csv = await c('GET', '/api/transactions.csv?month=2026-10');
  assert.match(csv.data, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  const ana = me.data.users.find((u) => u.username === 'ana');
  const clash = await c('PATCH', `/api/users/${me.data.user.id}`, { aliases: 'ANA SOUZA' });
  assert.equal(clash.status, 400, JSON.stringify([clash.data, me.data.user, ana]));
  assert.equal((await c('PATCH', `/api/users/${ana.id}`, { aliases: 'ANA SOUZA, ANA S SILVA' })).status, 200);
});

test('limite de tentativas de login', async () => {
  const c = client(base);
  let last;
  for (let i = 0; i < 9; i++) last = await c('POST', '/api/login', { username: 'ana', password: 'errada' });
  assert.equal(last.status, 429);
});
