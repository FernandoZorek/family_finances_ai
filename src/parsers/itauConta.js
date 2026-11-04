// Extrato de conta corrente Itaú (internet banking / app, PDF "extrato conta / lançamentos")
const { MONEY, parseBRL, brDate, round2, cleanSpaces } = require('./util');

function detect(text) {
  return /extrato conta\s*\/\s*lan[çc]amentos/i.test(text) || (/itau\.com\.br/i.test(text) && /SALDO DO DIA/.test(text));
}

const LINE_RE = new RegExp(String.raw`^\s*(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+(${MONEY})(?:\s+(${MONEY}))?\s*$`);

function parse(pages) {
  const text = pages.join('\n');
  const head = text.split('\n').find((l) => /\d{3}\.\d{3}\.\d{3}-\d{2}/.test(l)) || '';
  const holder = cleanSpaces(head.trim().split(/\s{2,}|\d{3}\.\d{3}/)[0]);
  const conta = (/conta:\s*([\d-]+)/i.exec(text) || [])[1] || '';
  const transactions = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const desc = cleanSpaces(m[2]);
    if (/^SALDO\b|SALDO DO DIA|SALDO ANTERIOR/i.test(desc)) continue;
    transactions.push({ date: brDate(m[1]), description: desc, amount: round2(parseBRL(m[3])) });
  }
  transactions.sort((a, b) => a.date.localeCompare(b.date));

  // Conferência: variação do saldo entre o primeiro e o último "SALDO DO DIA" do período
  const saldos = [];
  for (const line of text.split('\n')) {
    const m = new RegExp(String.raw`^\s*(\d{2}\/\d{2}\/\d{4})\s+SALDO DO DIA\s+(${MONEY})`).exec(line);
    if (m) saldos.push({ date: brDate(m[1]), v: parseBRL(m[2]) });
  }
  saldos.sort((a, b) => a.date.localeCompare(b.date));
  let stated = null;
  let computed = round2(transactions.reduce((s, t) => s + t.amount, 0));
  if (saldos.length >= 2) {
    const first = saldos[0];
    const last = saldos[saldos.length - 1];
    stated = round2(last.v - first.v);
    computed = round2(transactions.filter((t) => t.date > first.date && t.date <= last.date).reduce((s, t) => s + t.amount, 0));
  }
  const dates = transactions.map((t) => t.date).sort();

  return {
    bank: 'Itaú',
    kind: 'conta',
    account: `Itaú Conta ${conta}`.trim(),
    holder,
    periodStart: brDate((/per[íi]odo de visualiza[çc][ãa]o:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text) || [])[1] || '') || dates[0],
    periodEnd: brDate((/per[íi]odo de visualiza[çc][ãa]o:[^\n]*?at[ée]\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text) || [])[1] || '') || dates[dates.length - 1],
    statedTotal: stated,
    computedTotal: computed,
    totalLabel: 'variação do saldo no período',
    transactions,
    warnings: [],
  };
}

module.exports = { id: 'itau-conta', label: 'Itaú · Conta corrente', detect, parse };
