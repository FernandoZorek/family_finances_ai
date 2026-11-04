const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setupEnv } = require('./helpers');

setupEnv({ FF_HOME_CITIES: 'Campinas' });
const { taxSummary } = require('../src/taxes');
const { channelOf } = require('../src/channel');
const { sameKey, normalize } = require('../src/categorize');
const { searchValue } = require('../src/routes/transactions');
const { addMonths, monthsBetween } = require('../src/lib/dates');
const ofx = require('../src/parsers/ofx');

test('datas em meses', () => {
  assert.equal(addMonths('2026-11', 2), '2027-01');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(monthsBetween('2026-10', '2027-01'), 3);
});

test('busca por valor', () => {
  assert.deepEqual(searchValue('1.311,95'), { value: 1311.95, cents: true });
  assert.deepEqual(searchValue('R$ 50'), { value: 50, cents: false });
  assert.equal(searchValue('netflix'), null);
});

test('mesma loja com e sem espaços (PDF com texto quebrado)', () => {
  assert.equal(sameKey('FARMACIA SAO JOAO BR 12/10'), sameKey('FARMACIASAOJOAOBR'));
  assert.equal(normalize('  Pão  de Açúcar '), 'PAO DE ACUCAR');
});

test('online x presencial', () => {
  const ctx = { cards: { 'Cartão virtual': 'virtual', 'Cartão físico': 'fisico' }, rules: [] };
  const buy = (description, account = 'Cartão misto') => channelOf({ kind: 'cartao', amount: -10, description, account }, ctx);
  assert.equal(buy('SHOPEE *LOJA').channel, 'online');
  assert.equal(buy('PADARIA DO ZECAMPINASBR').how, 'nome'); // cidade de FF_HOME_CITIES colada no fim
  assert.equal(buy('PADARIA DO ZE').how, 'provável');
  assert.equal(buy('PADARIA DO ZE', 'Cartão virtual').channel, 'online');
  assert.equal(buy('UBER TRIP', 'Cartão físico').channel, 'online');
  assert.equal(channelOf({ kind: 'conta', amount: -10, description: 'PIX' }, ctx), null);
});

test('impostos: diretos, contador e embutidos (estimativa)', () => {
  const cat = (name, tax_rate = null) => ({ name, key: name, tax_rate });
  const t = taxSummary([
    { description: 'PAGAMENTO SIMPLES NACIONAL', amount: -100, cat: cat('Impostos e taxas') },
    { description: 'CONTABILIZEI', amount: -50, cat: cat('Trabalho / empresa') },
    { description: 'SUPERMERCADO X', amount: -1000, cat: cat('Mercado') },
    { description: 'POSTO SHELL', amount: -100, cat: cat('Transporte') },
    { description: 'LOJA Y', amount: -100, cat: cat('Compras', 0.5) },
  ]);
  assert.equal(t.direct, 100);
  assert.equal(t.accountant, 50);
  assert.equal(t.indirect, 220 + 38 + 50); // mercado 22%, combustível 38%, taxa própria 50%
  assert.equal(t.total, 458);
});

test('leitor OFX', () => {
  const text = `OFXHEADER:100
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKACCTFROM><BANKID>001<ACCTID>12345</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001<DTEND>20261031
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261005<TRNAMT>-150.25<FITID>1<MEMO>CONTA DE LUZ</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261010<TRNAMT>3000.00<FITID>2<MEMO>SALARIO</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  const r = ofx.parse(text);
  assert.equal(r.transactions.length, 2);
  assert.deepEqual(r.transactions.map((t) => [t.date, t.amount]), [['2026-10-05', -150.25], ['2026-10-10', 3000]]);
});
