// Sobe o app com banco temporário. Precisa ser chamado antes de qualquer require de src/ (config lê o ambiente).
const fs = require('fs');
const os = require('os');
const path = require('path');

function setupEnv(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-'));
  Object.assign(process.env, { DATA_DIR: dir, NODE_ENV: 'test', ...extra });
  return dir;
}

async function startApp() {
  const { bootstrap } = require('../src/bootstrap');
  const { createApp } = require('../src/app');
  await bootstrap();
  const server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

// cliente com cookie de sessão e cabeçalho CSRF do app
function client(base) {
  let cookie = '';
  return async function call(method, url, body, { csrf = true } = {}) {
    const headers = { ...(csrf ? { 'X-Requested-With': 'fetch' } : {}), ...(cookie ? { Cookie: cookie } : {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
}

function initialPassword(dir, username) {
  const txt = fs.readFileSync(path.join(dir, 'initial-passwords.txt'), 'utf8');
  return new RegExp(`^${username}: (\\S+)$`, 'm').exec(txt)[1];
}

module.exports = { setupEnv, startApp, client, initialPassword };
