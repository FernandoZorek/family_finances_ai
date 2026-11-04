// Extrato de conta PJ "Movimentações" (banco 301)
// Colunas: Data | Categoria | Lançamento | Descrição | Entrada | Saída ("-" na coluna vazia)
const { MONEY, parseBRL, brDate, round2, cleanSpaces } = require('./util');

function detect(text) {
  return /Banco\s+\d{3}\s+Ag[êe]ncia\s+\d+\s+Conta\s+[\d-]+/.test(text) && /Total de entradas/.test(text) && /Saldo do dia/.test(text);
}

const COL = String.raw`(-|-?R\$\s*${MONEY.replace('-?', '')})`;
const TX_RE = new RegExp(String.raw`^\s*(\d{2}\/\d{2}\/\d{4})\s+(?:Pessoa\s+(?:Jur[íi]dica|F[íi]sica)\s+)?(.+?)\s+${COL}\s+${COL}\s*$`);
const money = (s) => (s === '-' ? 0 : parseBRL(s.replace(/R\$\s*/, '')));

function parse(pages) {
  const text = pages.join('\n');
  const lines = text.split('\n');
  const holder = cleanSpaces(lines.find((l) => l.trim()) || '');
  const bank = (/Banco\s+(\d{3})/.exec(text) || [])[1] || '';
  const conta = (/Conta\s+([\d-]+)/.exec(text) || [])[1] || '';
  const total = (re) => {
    const m = new RegExp(re.source + String.raw`\s*R\$\s*(${MONEY})`).exec(text);
    return m ? parseBRL(m[1]) : null;
  };
  const entradas = total(/Total de entradas/);
  const saidas = total(/Total de sa[íi]das/);

  const transactions = [];
  for (const raw of lines) {
    const m = TX_RE.exec(raw);
    if (!m) continue;
    const inValue = money(m[3]);
    const outValue = money(m[4]);
    const amount = round2(inValue - outValue);
    if (!amount) continue;
    // "PIX EMPRESA X" -> "PIX RECEBIDO REM: EMPRESA X", como nos outros bancos (regras e transferência interna)
    const [kind, ...rest] = cleanSpaces(m[2]).split(' ');
    const who = rest.join(' ');
    const description = /^PIX$/i.test(kind) ? `PIX ${amount > 0 ? 'RECEBIDO REM' : 'ENVIADO DES'}: ${who}` : `${kind.toUpperCase()} ${who}`;
    transactions.push({ date: brDate(m[1]), description, amount });
  }

  const computed = round2(transactions.reduce((s, t) => s + t.amount, 0));
  const warnings = [];
  const inSum = round2(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0));
  if (entradas != null && Math.abs(entradas - inSum) >= 0.01) warnings.push(`Entradas: banco ${entradas} x lido ${inSum}`);
  const dates = transactions.map((t) => t.date).sort();
  const period = /De\s+(\d{2}\/\d{2}\/\d{4})\s+a\s+(\d{2}\/\d{2}\/\d{4})/.exec(text);

  return {
    bank: bank ? `Banco ${bank}` : 'Conta PJ',
    kind: 'conta',
    account: `Conta PJ ${holder.replace(/\s+(LTDA|S\.?A\.?|ME|EIRELI|EPP)\.?$/i, '')} ${conta}`.trim().slice(0, 60),
    holder,
    periodStart: period ? brDate(period[1]) : dates[0],
    // o PDF repete os lançamentos do 1º dia do mês seguinte; o período vai até a última data lida
    periodEnd: [period ? brDate(period[2]) : null, dates[dates.length - 1]].filter(Boolean).sort().pop() || null,
    statedTotal: entradas != null && saidas != null ? round2(entradas - saidas) : null,
    computedTotal: computed,
    totalLabel: 'entradas - saídas',
    transactions,
    warnings,
  };
}

module.exports = { id: 'conta-pj', label: 'Conta PJ · Movimentações (banco 301)', detect, parse };
