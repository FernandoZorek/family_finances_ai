// Extrato de conta corrente Sicredi (internet banking / app)
const { MONEY, parseBRL, brDate, round2, cleanSpaces } = require('./util');

function detect(text) {
  return /Sicredi/i.test(text) && /Extrato de conta corrente/i.test(text);
}

const VALUE_RE = new RegExp(String.raw`([+-])\s*R\$\s*(${MONEY.replace('-?', '')})\s*$`);
const SALDO_RE = new RegExp(String.raw`Saldo (?:do dia [\d/]+|Anterior)\s+R\$\s*(-?\s*${MONEY.replace('-?', '')})`);

function parse(pages) {
  const text = pages.join('\n');
  const holder = cleanSpaces((/Titular - CPF\/CNPJ[^\n]*\n\s*(.+?)\s+-\s+[\d.\-/]+/.exec(text) || [])[1]);
  const conta = (/Conta:\s*([\d-]+)/.exec(text) || [])[1] || '';

  const txs = [];
  const saldos = [];
  let inMov = false;
  let pending = [];
  let last = null;
  for (const raw of text.split('\n')) {
    if (/^\s*Movimenta[çc][õo]es\s+de/.test(raw)) {
      inMov = true;
      pending = [];
      continue;
    }
    if (/Lan[çc]amentos futuros|Cheque especial em sua/.test(raw)) {
      inMov = false;
      continue;
    }
    if (!inMov || !raw.trim() || /^\s*Data\s+Descri/.test(raw)) continue;

    const saldo = SALDO_RE.exec(raw);
    if (saldo) {
      saldos.push(parseBRL(saldo[1].replace(/\s/g, '')));
      pending = [];
      last = null;
      continue;
    }
    let line = raw;
    const dm = /^\s*(\d{2}\/\d{2}\/\d{4})/.exec(line);
    if (dm) line = line.replace(dm[1], '');
    const vm = VALUE_RE.exec(line);
    if (vm) {
      const desc = line.slice(0, vm.index).trim();
      last = {
        date: dm ? brDate(dm[1]) : null,
        parts: [...pending, desc],
        amount: round2((vm[1] === '-' ? -1 : 1) * parseBRL(vm[2])),
        // descrição longa fica centrada no valor: linha acima + linha abaixo
        expectsBelow: !desc && pending.length > 0,
      };
      txs.push(last);
      pending = [];
    } else if (last && last.expectsBelow) {
      last.parts.push(line);
      last.expectsBelow = false;
    } else {
      pending.push(line);
    }
  }

  // Data em branco na âncora: herda a anterior
  let prevDate = null;
  const transactions = txs.map((t) => {
    const date = t.date || prevDate;
    prevDate = date;
    return { date, description: cleanSpaces(t.parts.join(' ')), amount: t.amount };
  });

  const computed = round2(transactions.reduce((s, t) => s + t.amount, 0));
  const stated = saldos.length >= 2 ? round2(saldos[saldos.length - 1] - saldos[0]) : null;
  const dates = transactions.map((t) => t.date).filter(Boolean).sort();
  return {
    bank: 'Sicredi',
    kind: 'conta',
    account: `Sicredi Conta ${conta}`.trim(),
    holder,
    periodStart: brDate((/De (\d{2}\/\d{2}\/\d{4}) a \d{2}\/\d{2}\/\d{4}/.exec(text) || [])[1] || '') || dates[0],
    periodEnd: brDate((/De \d{2}\/\d{2}\/\d{4} a (\d{2}\/\d{2}\/\d{4})/.exec(text) || [])[1] || '') || dates[dates.length - 1],
    statedTotal: stated,
    computedTotal: computed,
    totalLabel: 'variação do saldo no período',
    transactions,
    warnings: [],
  };
}

module.exports = { id: 'sicredi-conta', label: 'Sicredi · Conta corrente', detect, parse };
