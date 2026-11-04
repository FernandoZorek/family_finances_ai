const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { setupEnv, startApp, client } = require('./helpers');

// API falsa no formato OpenAI: devolve um modelo de CSV e guarda o prompt para conferir o mascaramento
let lastPrompt = '';
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastPrompt = JSON.parse(body).messages[0].content;
    const template = {
      kind: 'csv', name: 'Banco Teste · Extrato', bank: 'Banco Teste', account: 'Banco Teste Conta', doc_kind: 'conta',
      date_format: 'DD/MM/YYYY', decimal: ',', sign: 'as_is', payment_patterns: [], skip: [],
      detect: { all: [], header: ['Quando', 'O que', 'Quanto'] }, line: { regex: null }, sections: { start: null, end: null },
      meta: { account: null, holder: null, due_date: null, period_start: null, period_end: null, total: null }, total_compare: 'sum',
      columns: { date: 'Quando', description: ['O que'], amount: 'Quanto', debit: null, credit: null }, delimiter: ';', header_row: 0, due_from_filename: false,
    };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(template) } }], usage: { prompt_tokens: 800, completion_tokens: 200, total_tokens: 1000 } }));
  });
});

let server, c;
before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  setupEnv({ FF_ADMIN_USERNAME: 'chefe', FF_ADMIN_PASSWORD: 'senha muito forte 1', FF_AI_PROVIDER: 'openai', FF_AI_MODEL: 'modelo-x', FF_AI_BASE_URL: `http://127.0.0.1:${mock.address().port}/v1` });
  let base;
  ({ server, base } = await startApp());
  c = client(base);
  await c('POST', '/api/login', { username: 'chefe', password: 'senha muito forte 1' });
  await c('POST', '/api/me/password', { current: 'senha muito forte 1', next: 'outra senha forte 2' });
});
after(() => {
  server.close();
  mock.close();
});

test('CSV do Nubank (modelo pronto) entra direto, com vencimento pelo nome do arquivo', async () => {
  const csv = 'date,title,amount\n2026-10-05,Padaria do Ze,12.50\n2026-10-08,Pagamento recebido,-500.00\n2026-10-09,Loja X - Parcela 2/3,100.00\n';
  const r = await c.upload([['Nubank_2026-11-10.csv', csv]]);
  const res = r.data.results[0];
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.parser, 'Nubank · Cartão (CSV)');
  assert.equal(res.dueDate, '2026-11-10');
  assert.equal(res.inserted, 3);
  const tx = (await c('GET', '/api/transactions?owner=all&month=2026-11&projected=0')).data;
  assert.ok(tx.some((t) => t.description === 'Loja X' && t.installment === '2/3' && t.amount === -100));
});

test('CSV desconhecido: mapear colunas, importar, salvar leitor e reaproveitar', async () => {
  const csv = 'Dt;Histórico;Débito;Crédito\n03/10/2026;ALUGUEL APTO;2.000,00;\n04/10/2026;SALARIO EMPRESA;;5.000,00\n';
  const up = (await c.upload([['extrato-bancox.csv', csv]])).data.results[0];
  assert.equal(up.ok, false);
  assert.equal(up.code, 'NO_PARSER');
  const info = (await c('GET', `/api/imports/pending/${up.pending_id}`)).data;
  assert.equal(info.format, 'csv');
  assert.equal(info.suggestion.columns.debit, 'Débito');
  const template = { ...info.suggestion, name: 'Banco X · Extrato', bank: 'Banco X', account: 'Banco X Conta', columns: { ...info.suggestion.columns, date: 'Dt', description: ['Histórico'] }, detect: { header: ['Dt', 'Histórico', 'Débito', 'Crédito'] } };
  const pv = (await c('POST', `/api/imports/pending/${up.pending_id}/preview`, { template })).data;
  assert.equal(pv.preview.count, 2);
  assert.equal(pv.preview.computedTotal, 3000);
  const imp = await c('POST', `/api/imports/pending/${up.pending_id}/import`, { template: pv.template, save: true });
  assert.equal(imp.status, 200, JSON.stringify(imp.data));
  assert.equal(imp.data.inserted, 2);
  assert.ok(imp.data.extractor_id);
  // próximo arquivo do mesmo formato: reconhecido pelo leitor salvo
  const next = (await c.upload([['extrato-nov.csv', 'Dt;Histórico;Débito;Crédito\n03/11/2026;ALUGUEL APTO;2.000,00;\n']])).data.results[0];
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal(next.parser, 'Banco X · Extrato');
  const list = (await c('GET', '/api/extractors')).data;
  assert.equal(list.saved[0].uses, 2);
  assert.ok(list.presets.length >= 3);
  // modelo inseguro é recusado
  const bad = await c('POST', `/api/imports/pending/x/preview`, { template });
  assert.equal(bad.status, 404);
});

test('IA cria o leitor: amostra mascarada, modelo validado e testado antes de importar', async () => {
  const csv = 'Quando;O que;Quanto\n05/10/2026;PIX ENVIADO CPF 123.456.789-09 conta 0001234567;-50,00\n06/10/2026;Mercado Bom fulano@email.com;-80,25\n';
  const up = (await c.upload([['novo.csv', csv]])).data.results[0];
  assert.equal(up.code, 'NO_PARSER');
  const r = await c('POST', `/api/imports/pending/${up.pending_id}/ai`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.doesNotMatch(lastPrompt, /123\.456\.789-09|0001234567|fulano@email\.com/);
  assert.match(lastPrompt, /000\.000\.000-00/);
  assert.equal(r.data.preview.count, 2);
  assert.equal(r.data.template.bank, 'Banco Teste');
  const imp = await c('POST', `/api/imports/pending/${up.pending_id}/import`, { template: r.data.template, save: true, source: 'ia' });
  assert.equal(imp.data.inserted, 2);
  assert.equal((await c('GET', '/api/extractors')).data.saved.find((x) => x.bank === 'Banco Teste').source, 'ia');
  const usage = (await c('GET', '/api/ai/usage')).data;
  assert.equal(usage.by_action.find((x) => x.action === 'extrator').input_tokens, 800);
});

test('modelo de PDF (texto) e proteção das regex', () => {
  const E = require('../src/extractors');
  const t = E.validateTemplate({
    kind: 'text', name: 'Banco Y · Fatura', bank: 'Banco Y', doc_kind: 'cartao', date_format: 'DD/MM', decimal: ',', sign: 'invert',
    detect: { all: ['BANCO Y', 'FATURA DO CARTAO'] }, payment_patterns: ['PAGAMENTO EFETUADO'], skip: ['TOTAL'],
    line: { regex: '^\\s*(?<date>\\d{2}/\\d{2})\\s+(?<description>.+?)\\s{2,}(?<amount>-?[\\d.]+,\\d{2})\\s*$' },
    sections: { start: 'LANÇAMENTOS', end: 'RESUMO' },
    meta: { due_date: 'Vencimento:?\\s*(\\d{2}/\\d{2}/\\d{4})', total: 'Total da fatura\\s+R?\\$?\\s*([\\d.]+,\\d{2})' },
    total_compare: 'debits',
  });
  const pages = [`BANCO Y - FATURA DO CARTAO
Vencimento: 10/11/2026     Total da fatura  R$ 150,00
LANÇAMENTOS
05/10  PADARIA DO ZE          50,00
07/10  LOJA ABC 02/05         100,00
08/10  PAGAMENTO EFETUADO     -300,00
TOTAL                          150,00
RESUMO
09/10  NAO ENTRA              999,00`];
  assert.equal(E.matchesText(t, pages[0]), true);
  const r = E.runText(t, pages);
  assert.equal(r.dueDate, '2026-11-10');
  assert.equal(r.transactions.length, 3);
  assert.equal(r.statedTotal, 150);
  assert.equal(r.computedTotal, 150);
  assert.deepEqual(r.transactions.map((x) => [x.date, x.amount, x.installment, x.payment]), [['2026-10-05', -50, null, false], ['2026-10-07', -100, '2/5', false], ['2026-10-08', 300, null, true]]);
  assert.throws(() => E.validateTemplate({ ...t, line: { regex: '(?<date>(a+)+)(?<description>.)(?<amount>.)' } }), /aninhada/);
  assert.throws(() => E.validateTemplate({ ...t, line: { regex: '(?<date>x)(?<amount>y)' } }), /description/);
});
