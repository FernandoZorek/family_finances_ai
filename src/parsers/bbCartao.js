// Fatura de cartão Banco do Brasil (Ourocard)
const { MONEY, parseBRL, brDate, inferCardDate, round2, cleanSpaces } = require('./util');

function detect(text) {
  return /OUROCARD|bb\.com\.br/i.test(text) && /Lan[çc]amentos nesta fatura/i.test(text);
}

const TX_RE = new RegExp(String.raw`^\s*(\d{2}\/\d{2})\s+(.+?)\s+(?:[A-Z]{2}\s+)?R\$\s*(${MONEY})\s*$`);
// Seções do BB usadas como dica de categoria
const SECTION_HINT = {
  servicos: null,
  vestuario: 'vestuário',
  restaurantes: 'restaurante',
  supermercados: 'supermercado',
  transporte: 'transporte',
  saude: 'saúde',
  educacao: 'educação',
  lazer: 'entretenimento',
  turismo: 'turismo',
};

function norm(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function parse(pages) {
  const text = pages.join('\n');
  const due = brDate((/Vencimento[\s\S]{0,400}?(\d{2}\/\d{2}\/\d{4})/.exec(text) || [])[1] || '');
  const statedTotal = (() => {
    const m = new RegExp(String.raw`Total da Fatura\s+R\$\s*(${MONEY})`).exec(text);
    return m ? parseBRL(m[1]) : null;
  })();
  const amountDue = (() => {
    const m = new RegExp(String.raw`^\s*Total\s+R\$\s*(${MONEY})\s*$`, 'm').exec(text);
    return m ? parseBRL(m[1]) : statedTotal;
  })();

  const lines = text.split('\n');
  const transactions = [];
  let started = false;
  let holder = null;
  let card = null;
  let section = null;
  for (const line of lines) {
    if (/Lan[çc]amentos nesta fatura/i.test(line)) started = true;
    if (!started) continue;
    if (/Total da Fatura/i.test(line)) break;
    const h = /^\s*(.+?)\s+\(Cart[ãa]o\s+(\d{4})\)/.exec(line);
    if (h) {
      holder = cleanSpaces(h[1]);
      card = h[2];
      continue;
    }
    const m = TX_RE.exec(line);
    if (!m) {
      const t = line.trim();
      if (t && t.length < 40 && !/\d/.test(t) && !/^(Data|SALDO)/i.test(t)) section = t;
      continue;
    }
    let desc = cleanSpaces(m[2]);
    let installment = null;
    const inst = /\bPARC\s+(\d{2})\/(\d{2})\b/i.exec(desc);
    if (inst) {
      installment = `${Number(inst[1])}/${Number(inst[2])}`;
      desc = cleanSpaces(desc.replace(inst[0], ''));
    }
    const value = parseBRL(m[3]);
    const isPayment = /PGTO|PAGAMENTO/i.test(desc) && value < 0;
    const sec = section ? norm(section) : '';
    transactions.push({
      date: due ? inferCardDate(m[1], due) : null,
      description: desc,
      amount: round2(-value),
      installment,
      holder,
      card,
      payment: isPayment,
      categoryHint: SECTION_HINT[sec] || null,
    });
  }

  const computed = round2(-transactions.filter((t) => !t.payment).reduce((s, t) => s + t.amount, 0));
  const titular = cleanSpaces(lines.find((l) => l.trim()) || '').split(/\s{2,}|RUA |AV\.? /)[0];
  return {
    bank: 'Banco do Brasil',
    kind: 'cartao',
    account: 'BB Ourocard',
    holder: holder || titular,
    dueDate: due,
    statedTotal,
    amountDue,
    computedTotal: computed,
    totalLabel: 'total da fatura',
    transactions,
    warnings: due ? [] : ['Vencimento da fatura não encontrado.'],
  };
}

module.exports = { id: 'bb-cartao', label: 'Banco do Brasil · Cartão Ourocard', detect, parse };
