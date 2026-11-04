// Fatura do cartão de crédito Mercado Pago
const { MONEY, parseBRL, brDate, inferCardDate, round2, cleanSpaces } = require('./util');

function detect(text) {
  return /Mercado Pago/i.test(text) && /Movimenta[çc][õo]es na fatura|Detalhes de consumo/.test(text);
}

const TX_RE = new RegExp(String.raw`^\s*(\d{2}\/\d{2})\s+(.+?)\s+(?:Parcela\s+(\d+)\s+de\s+(\d+)\s+)?R\$\s*(${MONEY})\s*$`);

function parse(pages) {
  const text = pages.join('\n');
  const due = brDate((/Venc(?:e em|imento:)[\s\S]{0,120}?(\d{2}\/\d{2}\/\d{4})/.exec(text) || [])[1] || '');
  const holder = cleanSpaces(text.split('\n').find((l) => l.trim()) || '');
  const card = (/Cart[ãa]o\s+\w+\s+\[\**(\d{4})\]/.exec(text) || [])[1] || null;
  const statedConsumo = (() => {
    const m = new RegExp(String.raw`Consumos de [\d/]+ a [\d/]+\s+R\$\s*(${MONEY})`).exec(text);
    return m ? parseBRL(m[1]) : null;
  })();

  const transactions = [];
  let section = null;
  for (const line of text.split('\n')) {
    if (/Movimenta[çc][õo]es na fatura/.test(line)) section = 'mov';
    else if (/Cart[ãa]o\s+\w+\s+\[/.test(line)) section = 'card';
    else if (/^\s*Total\s+R\$/.test(line)) section = null;
    if (!section) continue;
    const m = TX_RE.exec(line);
    if (!m) continue;
    const desc = cleanSpaces(m[2]);
    const value = parseBRL(m[5]);
    const isPayment = /Pagamento da fatura/i.test(desc);
    const isCredit = section === 'mov' && !isPayment; // "Crédito concedido", estornos
    transactions.push({
      date: due ? inferCardDate(m[1], due) : null,
      description: desc,
      amount: round2(isCredit || isPayment ? value : -value),
      installment: m[3] ? `${m[3]}/${m[4]}` : null,
      holder,
      card,
      payment: isPayment,
    });
  }

  const consumo = round2(-transactions.filter((t) => !t.payment && t.amount < 0).reduce((s, t) => s + t.amount, 0));
  return {
    bank: 'Mercado Pago',
    kind: 'cartao',
    account: 'Mercado Pago Cartão',
    holder,
    dueDate: due,
    statedTotal: statedConsumo,
    amountDue: (() => {
      const m = new RegExp(String.raw`^\s*Total\s+R\$\s*(${MONEY})\s*$`, 'm').exec(text);
      const total = m ? parseBRL(m[1]) : null;
      if (total || !due) return total;
      // Paga antes do vencimento: "Total a pagar R$ 0,00"; o valor da fatura está no próprio pagamento
      const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
      const ref = `${MESES[Number(due.slice(5, 7)) - 1]}/${due.slice(0, 4)}`;
      const paid = transactions.filter((t) => t.payment && t.description.toLowerCase().includes(ref)).reduce((s, t) => s + t.amount, 0);
      return paid ? round2(paid) : total;
    })(),
    computedTotal: consumo,
    totalLabel: 'consumos do período',
    transactions,
    warnings: due ? [] : ['Vencimento da fatura não encontrado.'],
  };
}

module.exports = { id: 'mercadopago-cartao', label: 'Mercado Pago · Cartão de crédito', detect, parse };
