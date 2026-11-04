// Fatura de cartão de crédito Bradesco (titular + adicionais em seções "NOME   Cartão XXXX")
const { MONEY, parseBRL, brDate, inferCardDate, round2, cleanSpaces } = require('./util');

function detect(text) {
  return /Bradesco/i.test(text) && /Fatura Mensal/.test(text) && /Hist[óo]rico de Lan[çc]amentos/.test(text);
}

const TX_RE = new RegExp(String.raw`^\s{0,40}(\d{2}\/\d{2})\s+(.+?)\s+(${MONEY.replace('-?', '')})(\s*-)?(?=\s|$)`);

function parse(pages) {
  const text = pages.join('\n');
  const lines = text.split('\n');
  const warnings = [];

  let due = null;
  const vIdx = lines.findIndex((l) => /Total de fatura\s+Vencimento/.test(l));
  if (vIdx >= 0) {
    for (let i = vIdx + 1; i < vIdx + 5 && !due; i++) {
      const m = /(\d{2}\/\d{2}\/\d{4})/.exec(lines[i] || '');
      if (m) due = brDate(m[1]);
    }
  }
  if (!due) {
    const m = /Vencimento[^\d]{0,80}(\d{2}\/\d{2}\/\d{4})/s.exec(text);
    if (m) due = brDate(m[1]);
  }
  const titular = cleanSpaces((/Nome do Pagador\/CPF\/CNPJ\/Endere[çc]o\/Cidade\/UF\/CEP\s+(.+?)\s+CPF/.exec(text) || [])[1]);

  const transactions = [];
  let holder = titular || null;
  let card = null;
  let started = false;
  let statedTotal = null;
  for (const line of lines) {
    if (/Hist[óo]rico de Lan[çc]amentos/.test(line)) started = true;
    if (!started) continue;
    const sec = /^\s*([A-ZÀ-Ü][A-ZÀ-Ü .]+?)\s{2,}Cart[ãa]o\s+(\d{4}\s+X{4}\s+X{4}\s+(\d{4}))/.exec(line);
    if (sec) {
      holder = cleanSpaces(sec[1]);
      card = sec[3];
      continue;
    }
    const tot = new RegExp(String.raw`Total da fatura em real\s+(${MONEY})`).exec(line);
    if (tot) {
      statedTotal = parseBRL(tot[1]);
      break;
    }
    const m = TX_RE.exec(line);
    if (!m) continue;
    const parts = m[2].split(/\s{2,}/);
    let merchant = parts[0];
    let installment = null;
    const inst = /\s*(\d{2})\/(\d{2})$/.exec(merchant) || (parts[1] && /^(\d{2})\/(\d{2})$/.exec(parts[1]));
    if (inst) {
      installment = `${Number(inst[1])}/${Number(inst[2])}`;
      merchant = merchant.replace(/\s*\d{2}\/\d{2}$/, '');
    }
    const value = parseBRL(m[3]);
    const isCredit = Boolean(m[4]);
    const isPayment = /PAG(TO|AMENTO)?\s+BOLETO|PAGAMENTO\s+(RECEBIDO|EFETUADO)|PAG\s+FATURA/i.test(merchant);
    transactions.push({
      date: due ? inferCardDate(m[1], due) : null,
      description: cleanSpaces(merchant),
      amount: round2(isCredit ? value : -value),
      installment,
      holder,
      card,
      payment: isPayment,
    });
  }

  const charges = transactions.filter((t) => !t.payment);
  const computed = round2(-charges.reduce((s, t) => s + t.amount, 0));
  if (!due) warnings.push('Vencimento da fatura não encontrado: datas podem estar com ano errado.');

  return {
    bank: 'Bradesco',
    kind: 'cartao',
    account: 'Bradesco Cartão',
    holder: titular,
    dueDate: due,
    statedTotal,
    amountDue: statedTotal,
    computedTotal: computed,
    totalLabel: 'total de lançamentos da fatura',
    transactions,
    warnings,
  };
}

module.exports = { id: 'bradesco-cartao', label: 'Bradesco · Cartão de crédito', detect, parse };
