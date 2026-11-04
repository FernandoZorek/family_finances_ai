const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setupEnv, startApp, client } = require('./helpers');

// "IA" falsa: webhook local que classifica por palavra e devolve uma resposta de baixa confiança
let received = null;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received = JSON.parse(body);
    const answer = received.items.map((i) =>
      /PADARIA/.test(i.key) ? { key: i.key, category: 'Mercado', confidence: 0.95 }
      : /CURSO/.test(i.key) ? { key: i.key, category: 'Educação', confidence: 0.5 } // abaixo do mínimo
      : { key: i.key, category: 'Salário e pró-labore', confidence: 0.99 } // tipo errado para despesa
    );
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ items: answer }));
  });
});

let server, base, c;
before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  setupEnv({ FF_ADMIN_USERNAME: 'chefe', FF_ADMIN_PASSWORD: 'senha muito forte 1', FF_AI_PROVIDER: 'webhook', FF_AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/classify` });
  ({ server, base } = await startApp());
  c = client(base);
  await c('POST', '/api/login', { username: 'chefe', password: 'senha muito forte 1' });
  await c('POST', '/api/me/password', { current: 'senha muito forte 1', next: 'outra senha forte 2' });
});
after(() => {
  server.close();
  mock.close();
});

test('IA: só nome da loja vai para fora; cria regra só com confiança e tipo certos', async () => {
  const cats = (await c('GET', '/api/categories')).data;
  const outros = cats.find((x) => x.key === 'Outros').id;
  for (const d of ['PADARIA SAO JORGE 12/10', 'CURSO DE INGLES XPTO', 'LOJA QUALQUER 123', 'PIX ENVIADO DES: JOAO DA SILVA'])
    assert.equal((await c('POST', '/api/transactions', { date: new Date().toISOString().slice(0, 10), description: d, amount: '50,00', type: 'despesa', category_id: outros })).status, 200);
  // lançamento manual vem travado na categoria: destrava para simular importação
  require('../src/db').db.prepare('UPDATE transactions SET category_locked = 0').run();

  const st = await c('GET', '/api/ai/status');
  assert.equal(st.data.enabled, true);
  assert.equal(st.data.pending, 3); // PIX fica de fora

  const run = await c('POST', '/api/ai/run');
  assert.equal(run.status, 200);
  assert.deepEqual(received.items.map((i) => i.key).sort(), ['CURSO DE INGLES XPTO', 'LOJA QUALQUER', 'PADARIA SAO JORGE']);
  assert.ok(!JSON.stringify(received).includes('50')); // sem valores
  assert.equal(run.data.created, 1);
  assert.equal(run.data.rules[0].category, 'Mercado');

  const rules = (await c('GET', '/api/rules')).data.filter((r) => r.source === 'ia');
  assert.deepEqual(rules.map((r) => r.pattern), ['PADARIA SAO JORGE']);
  const tx = (await c('GET', '/api/transactions?owner=all&q=PADARIA&projected=0')).data;
  assert.equal(tx[0].category, 'Mercado');

  assert.equal((await c('PUT', '/api/ai/auto', { auto: true })).data.auto, true);
  assert.equal((await c('GET', '/api/ai/status')).data.auto, true);
});

test('exportar e importar regras (mescla, cria categorias que faltam, valida o arquivo)', async () => {
  const cats = (await c('GET', '/api/categories')).data;
  assert.equal((await c('POST', '/api/rules', { pattern: 'BARBEARIA DO ZE', category_id: cats.find((x) => x.key === 'Cuidados pessoais').id })).status, 200);
  const exp = await c('GET', '/api/rules/export');
  assert.match(exp.headers.get('content-disposition'), /family-finances-regras-/);
  assert.equal(exp.data.format, 'family-finances/rules');
  assert.ok(exp.data.rules.some((r) => r.pattern === 'BARBEARIA DO ZE' && r.source === 'usuario'));

  const data = {
    ...exp.data,
    categories: [...exp.data.categories, { name: 'Pets', kind: 'despesa', icon: '🐶', parent: null, nature: 'conforto' }],
    rules: [...exp.data.rules, { pattern: 'PETZ', category: 'Pets', source: 'usuario', priority: 100 }, { pattern: 'X', category: 'Pets' }],
  };
  const imp = await c('POST', '/api/rules/import', { data });
  assert.equal(imp.status, 200);
  assert.equal(imp.data.categories_created, 1);
  assert.equal(imp.data.rules_created, 1); // só PETZ: o resto já existia
  assert.equal(imp.data.skipped, 1); // "X" curto demais
  assert.equal((await c('POST', '/api/rules/import', { data: { format: 'outro', rules: [] } })).status, 400);
});
