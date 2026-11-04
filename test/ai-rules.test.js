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
    if (received.type === 'insights') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        summary: 'Gasto estável.',
        highlights: ['Mercado é o maior gasto.'],
        warnings: [],
        // meta acima da média é limitada à média (economia 0, sai da lista); categoria inexistente é ignorada
        savings: [{ category: 'Mercado', monthly_target: 30, reason: 'Comprar no atacado', actions: ['Lista de compras'] },
          { category: 'Inexistente', monthly_target: 1, reason: 'x', actions: [] }],
      }));
    }
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

test('metas de gasto e insights (economia calculada pelo app)', async () => {
  const cats = (await c('GET', '/api/categories')).data;
  const mercado = cats.find((x) => x.key === 'Mercado').id;
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  assert.equal((await c('POST', '/api/transactions', { date: prev, description: 'SUPERMERCADO BOM', amount: '100,00', type: 'despesa', category_id: mercado })).status, 200);
  assert.equal((await c('PUT', '/api/budgets', { items: [{ category_id: mercado, monthly_limit: 60 }] })).status, 200);
  assert.equal((await c('PUT', '/api/budgets', { items: [{ category_id: cats.find((x) => x.key === 'Salário e pró-labore').id, monthly_limit: 10 }] })).status, 400);

  const b = (await c('GET', `/api/budgets?month=${month}`)).data;
  assert.equal(b.length, 1);
  assert.equal(b[0].monthly_limit, 60);
  // mês atual: a padaria (50) que a IA pôs em Mercado = 83% da meta
  assert.equal(b[0].status, 'perto');
  assert.equal(b[0].history.at(-2).status, 'estourou'); // mês anterior: 100 de 60

  const ins = await c('POST', '/api/insights', { months: 3 });
  assert.equal(ins.status, 200, JSON.stringify(ins.data));
  assert.equal(received.type, 'insights');
  assert.ok(received.data.categories.every((x) => !('id' in x)));
  assert.equal(ins.data.savings.length, 1);
  const sav = ins.data.savings[0];
  assert.equal(sav.category, 'Mercado');
  assert.equal(sav.monthly, Math.round((sav.average - 30) * 100) / 100);
  assert.equal(sav.in12, Math.round(sav.monthly * 12 * 100) / 100);
  assert.equal((await c('GET', '/api/insights')).data.summary, 'Gasto estável.');
  assert.equal((await c('POST', '/api/insights', { months: 3 })).status, 429); // um por minuto

  assert.equal((await c('PUT', '/api/budgets', { items: [{ category_id: mercado, monthly_limit: 0 }] })).status, 200);
  assert.equal((await c('GET', '/api/budgets')).data.length, 0);
});
