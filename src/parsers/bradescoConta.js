// Extrato de conta corrente Bradesco (app "Bradesco Celular")
const { MONEY, parseBRL, brDate, round2, cleanSpaces } = require('./util');

function detect(text) {
  return /Bradesco Celular/.test(text) && /Extrato de:/.test(text) && /Hist[óo]rico/.test(text);
}

const HEADER_RE = /Bradesco Celular|^\s*Data:|^\s*Nome:|Extrato de:|Folha:|Docto\.\s+Cr[ée]dito/;
const ANCHOR_RE = new RegExp(String.raw`^(.*?)\b(\d{5,})\s+(${MONEY})(?:\s+(${MONEY}))?\s*$`);

function parse(pages) {
  const text = pages.join('\n');
  const holder = cleanSpaces((/Nome:\s*(.+)/.exec(text) || [])[1]);
  const conta = (/Conta:\s*([\d-]+)/.exec(text) || [])[1] || '';
  const warnings = [];

  // Posição (fim) das colunas Crédito/Débito/Saldo pelo cabeçalho
  const headerLine = text.split('\n').find((l) => /Cr[ée]dito \(R\$\)/.test(l)) || '';
  const colEnd = (label) => {
    const i = headerLine.search(label);
    return i < 0 ? null : i + headerLine.match(label)[0].length;
  };
  const credEnd = colEnd(/Cr[ée]dito \(R\$\)/);
  const debEnd = colEnd(/D[ée]bito \(R\$\)/);

  // Blocos separados por linha em branco; cada bloco tem título, linha-âncora (docto + valores) e detalhe
  const lines = text.split('\n').filter((l) => !HEADER_RE.test(l));
  const blocks = [];
  let cur = [];
  for (const l of lines) {
    if (/^\s*Total\s/.test(l)) break;
    if (!l.trim()) {
      if (cur.length) blocks.push(cur), (cur = []);
    } else cur.push(l);
  }
  if (cur.length) blocks.push(cur);

  const txs = [];
  let lastDate = null;
  let prevSaldo = null;
  for (const block of blocks) {
    let pending = [];
    let current = null;
    for (const raw of block) {
      let line = raw;
      const dm = /^\s*(\d{2}\/\d{2}\/\d{4})/.exec(line);
      if (dm) {
        lastDate = brDate(dm[1]);
        line = line.replace(dm[1], ' '.repeat(dm[1].length));
      }
      const am = ANCHOR_RE.exec(line);
      if (am) {
        const valueStr = am[3];
        const valueEndCol = line.lastIndexOf(valueStr) + valueStr.length;
        const saldo = am[4] ? parseBRL(am[4]) : null;
        let value = Math.abs(parseBRL(valueStr));
        let isCredit;
        if (prevSaldo !== null && saldo !== null) {
          isCredit = Math.abs(round2(prevSaldo + value) - saldo) < 0.005;
          if (!isCredit && Math.abs(round2(prevSaldo - value) - saldo) >= 0.005) isCredit = null;
        }
        if (isCredit == null && credEnd && debEnd) {
          isCredit = Math.abs(valueEndCol - credEnd) < Math.abs(valueEndCol - debEnd);
        }
        if (saldo !== null) prevSaldo = saldo;
        current = {
          date: lastDate,
          title: cleanSpaces([...pending, am[1]].join(' ')),
          details: [],
          amount: isCredit ? value : -value,
          doc: am[2],
        };
        txs.push(current);
        pending = [];
      } else if (current) {
        current.details.push(cleanSpaces(line));
      } else {
        pending.push(cleanSpaces(line));
      }
    }
    if (pending.length && !current) warnings.push(`Trecho não reconhecido: ${pending.join(' ')}`);
  }

  const transactions = txs.map((t) => {
    const detail = t.details.join(' ');
    const counterpart = /^(?:DES|REM):\s*(.+?)(?:\s+\d{2}\/\d{2})?$/.exec(detail);
    return {
      date: t.date,
      description: cleanSpaces(`${t.title}${detail ? ' ' + detail : ''}`).replace(/\*$/, ''),
      amount: round2(t.amount),
      counterpart: counterpart ? counterpart[1] : null,
    };
  });

  const totalLine = text.split('\n').find((l) => /^\s*Total\s/.test(l));
  let stated = null;
  if (totalLine) {
    const vals = totalLine.match(new RegExp(MONEY, 'g')) || [];
    if (vals.length >= 2) stated = round2(parseBRL(vals[0]) - parseBRL(vals[1]));
  }
  const computed = round2(transactions.reduce((s, t) => s + t.amount, 0));
  const dates = transactions.map((t) => t.date).filter(Boolean).sort();

  return {
    bank: 'Bradesco',
    kind: 'conta',
    account: `Bradesco Conta ${conta}`.trim(),
    holder,
    // O PDF não traz o período: começa no 1º lançamento e vai até a emissão
    periodStart: dates[0],
    periodEnd: brDate((/Data:\s*(\d{2}\/\d{2}\/\d{4})/.exec(text) || [])[1] || '') || dates[dates.length - 1],
    statedTotal: stated,
    computedTotal: computed,
    totalLabel: 'créditos - débitos do período',
    transactions,
    warnings,
  };
}

module.exports = { id: 'bradesco-conta', label: 'Bradesco · Conta corrente', detect, parse };
