// OFX (exportação padrão da maioria dos bancos: conta corrente e cartão)
const { round2, cleanSpaces } = require('./util');

function tag(block, name) {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block);
  return m ? m[1].trim() : null;
}

function ofxDate(s) {
  return s && /^\d{8}/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

function parse(text) {
  const isCard = /<CREDITCARDMSGSRSV1>/i.test(text);
  const org = tag(text, 'ORG') || tag(text, 'BANKID') || 'Banco';
  const acct = tag(text, 'ACCTID') || '';
  const transactions = [];
  const re = /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi;
  let m;
  while ((m = re.exec(text))) {
    const b = m[1];
    const amount = Number(String(tag(b, 'TRNAMT') || '0').replace(',', '.'));
    const memo = cleanSpaces([tag(b, 'NAME'), tag(b, 'MEMO')].filter(Boolean).join(' '));
    transactions.push({
      date: ofxDate(tag(b, 'DTPOSTED')),
      description: memo || 'Sem descrição',
      amount: round2(amount),
      fitid: tag(b, 'FITID'),
    });
  }
  const dates = transactions.map((t) => t.date).filter(Boolean).sort();
  return {
    bank: org,
    kind: isCard ? 'cartao' : 'conta',
    account: `${org} ${isCard ? 'Cartão' : 'Conta'} ${acct.slice(-6)}`.trim(),
    holder: null,
    periodStart: dates[0],
    periodEnd: dates[dates.length - 1],
    statedTotal: null,
    computedTotal: round2(transactions.reduce((s, t) => s + t.amount, 0)),
    totalLabel: 'soma dos lançamentos',
    transactions,
    warnings: [],
  };
}

module.exports = { id: 'ofx', label: 'OFX', parse };
