// Leitor genérico para PDFs de bancos ainda sem parser dedicado: pega linhas "data  descrição  valor".
// Resultado é marcado como "conferir", porque sinal e escopo dos valores não são garantidos.
const { MONEY, parseBRL, brDate, round2, cleanSpaces } = require('./util');

const LINE_RE = new RegExp(String.raw`^\s*(\d{2}\/\d{2}(?:\/\d{2,4})?)\s+(.+?)\s+(R\$\s*)?(${MONEY})(\s*-)?(?:\s+(${MONEY}))?\s*$`);

function parse(pages, { year } = {}) {
  const text = pages.join('\n');
  const y = year || new Date().getFullYear();
  const transactions = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const desc = cleanSpaces(m[2]);
    if (/SALDO|^Total/i.test(desc)) continue;
    let date = m[1];
    if (date.length === 5) date = `${date}/${y}`;
    else if (date.length === 8) date = `${date.slice(0, 6)}20${date.slice(6)}`;
    let amount = parseBRL(m[4]);
    if (m[5]) amount = -Math.abs(amount);
    transactions.push({ date: brDate(date), description: desc, amount: round2(amount) });
  }
  return {
    bank: 'Outro banco',
    kind: 'conta',
    account: 'Outro banco',
    holder: null,
    statedTotal: null,
    computedTotal: round2(transactions.reduce((s, t) => s + t.amount, 0)),
    totalLabel: 'soma dos lançamentos',
    transactions,
    warnings: ['Formato não reconhecido: leitura genérica. Confira sinais (entrada/saída) e valores.'],
  };
}

module.exports = { id: 'generico', label: 'Leitura genérica', parse };
