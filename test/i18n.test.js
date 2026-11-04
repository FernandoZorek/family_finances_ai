const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setupEnv, startApp, client } = require('./helpers');

const ROOT = path.join(__dirname, '..');
// chaves usadas no front: __('texto') (aspas simples, com \' escapado)
function appKeys() {
  const src = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const keys = new Set();
  const re = /\b__\('((?:[^'\\]|\\.)*)'/g;
  let m;
  while ((m = re.exec(src))) keys.add(m[1].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1'));
  return keys;
}
const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
const SKIP = new Set(['English', 'Español', 'Português (Brasil)', 'Bradesco', 'Itaú', 'Sicredi', 'Online']);

for (const loc of ['en', 'es']) {
  test(`dicionário ${loc}: todo texto da interface traduzido, com as mesmas variáveis`, () => {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, `public/i18n/${loc}.json`), 'utf8'));
    const missing = [...appKeys()].filter((k) => !SKIP.has(k) && !(k in dict));
    assert.deepEqual(missing, [], `faltam ${missing.length} traduções em ${loc}.json`);
    for (const [k, v] of Object.entries(dict)) {
      assert.ok(typeof v === 'string' && v.trim(), `${loc}: tradução vazia para ${JSON.stringify(k)}`);
      assert.equal(placeholders(v), placeholders(k), `${loc}: variáveis diferentes em ${JSON.stringify(k)}`);
    }
  });
}

let server, base;
before(async () => {
  setupEnv({ FF_ADMIN_USERNAME: 'chefe', FF_ADMIN_PASSWORD: 'senha muito forte 1' });
  ({ server, base } = await startApp());
});
after(() => server.close());

test('dicionário vem pelo cookie ou pelo idioma do navegador; idioma fica salvo no usuário', async () => {
  const js = async (headers) => (await (await fetch(base + '/i18n.js', { headers })).text());
  assert.match(await js({}), /"locale":"pt-BR"/);
  assert.match(await js({ 'Accept-Language': 'es-AR,es;q=0.9' }), /"locale":"es"/);
  assert.match(await js({ Cookie: 'fin_locale=en', 'Accept-Language': 'es' }), /"locale":"en"/);
  assert.match(await js({ Cookie: 'fin_locale=xx' }), /"locale":"pt-BR"/);
  const c = client(base);
  await c('POST', '/api/login', { username: 'chefe', password: 'senha muito forte 1' });
  await c('POST', '/api/me/password', { current: 'senha muito forte 1', next: 'outra senha forte 2' });
  assert.equal((await c('PUT', '/api/me/locale', { locale: 'fr' })).status, 400);
  assert.equal((await c('PUT', '/api/me/locale', { locale: 'es' })).status, 200);
  assert.equal((await c('GET', '/api/me')).data.user.locale, 'es');
});
