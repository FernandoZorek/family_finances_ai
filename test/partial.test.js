const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv, startApp, client } = require('./helpers');

let server, c;
before(async () => {
  setupEnv({ FF_ADMIN_USERNAME: 'chefe', FF_ADMIN_PASSWORD: 'senha muito forte 1' });
  let base;
  ({ server, base } = await startApp());
  c = client(base);
  await c('POST', '/api/login', { username: 'chefe', password: 'senha muito forte 1' });
  await c('POST', '/api/me/password', { current: 'senha muito forte 1', next: 'outra senha forte 2' });
});
after(() => server.close());

const csv = (lines) => `date,title,amount\n${lines.join('\n')}\n`;
const month = async () => (await c('GET', '/api/transactions?owner=all&month=2027-03&projected=0')).data;

test('fatura parcial e depois fechada: substitui sem duplicar e mantém as edições', async () => {
  const partial = (await c.upload([['Nubank_2027-03-10.csv', csv(['2027-02-05,Padaria do Ze,12.50', '2027-02-08,Loja em dolar,100.00', '2027-02-09,Mercado Bom,50.00'])]])).data.results[0];
  assert.equal(partial.ok, true, JSON.stringify(partial));
  assert.equal(partial.partial, true); // vence daqui a meses: fatura ainda aberta
  assert.deepEqual(partial.replaced, []);

  const cats = (await c('GET', '/api/categories')).data;
  const lazer = cats.find((x) => x.kind === 'despesa' && x.name !== 'Outros');
  const tx = await month();
  const padaria = tx.find((t) => t.description === 'Padaria do Ze');
  const loja = tx.find((t) => t.description === 'Loja em dolar');
  await c('PATCH', `/api/transactions/${padaria.id}`, { category_id: lazer.id, note: 'café da manhã' });
  await c('PATCH', `/api/transactions/${loja.id}`, { note: 'presente' });

  // fechada: a compra em dólar mudou de valor na conversão e entrou uma compra nova
  const full = (
    await c.upload([['Nubank_2027-03-10 (fechada).csv', csv(['2027-02-05,Padaria do Ze,12.50', '2027-02-08,Loja em dolar,103.40', '2027-02-09,Mercado Bom,50.00', '2027-02-20,Farmacia Boa,30.00'])]])
  ).data.results[0];
  assert.equal(full.ok, true, JSON.stringify(full));
  assert.deepEqual(full.replaced, ['Nubank_2027-03-10.csv']);
  assert.equal(full.inserted, 4);

  const after = await month();
  assert.equal(after.length, 4);
  const p2 = after.find((t) => t.description === 'Padaria do Ze');
  assert.equal(p2.category_id, lazer.id);
  assert.equal(p2.note, 'café da manhã');
  const l2 = after.find((t) => t.description === 'Loja em dolar');
  assert.equal(l2.amount, -103.4);
  assert.equal(l2.note, 'presente');
  const files = (await c('GET', '/api/imports')).data;
  assert.equal(files.filter((f) => f.due_date === '2027-03-10').length, 1);
});

test('outra fatura do mesmo cartão e vencimento (outros lançamentos) não é substituída', async () => {
  const r = (await c.upload([['Nubank_2027-03-10 (adicional).csv', csv(['2027-02-11,Posto Centro,200.00', '2027-02-12,Cinema,40.00'])]])).data.results[0];
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.replaced, []);
  assert.equal((await month()).length, 6);
});

test('fatura parcial continua pendente nos documentos do mês até ser marcada como fechada', async () => {
  const docs = async () => (await c('GET', '/api/docs?month=2027-03')).data;
  let d = await docs();
  assert.ok(d.sent.every((s) => s.partial && s.note.startsWith('parcial')));
  assert.ok(d.missing.some((m) => m.kind === 'cartao' && /fatura fechada/.test(m.when)));

  for (const f of (await c('GET', '/api/imports')).data) assert.equal((await c('PATCH', `/api/imports/${f.id}`, { partial: false })).status, 200);
  d = await docs();
  assert.ok(!d.missing.some((m) => m.kind === 'cartao'));
  assert.equal((await c('PATCH', '/api/imports/1', { partial: 'sim' })).status, 400);
});
