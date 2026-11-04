// Holerite / recibo de pagamento de salário (folha SCI e similares)
// Vira: salário bruto (receita) + cada desconto em folha (despesa). O líquido que cai na conta
// fica neutro na reconciliação (categorize.reconcileHolerites), para não contar duas vezes.
const { MONEY, parseBRL, brDate, round2, cleanSpaces } = require('./util');

const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function detect(text) {
  return /RECIBO DE PAGAMENTO DE SAL[ÁA]RIO|DEMONSTRATIVO DE PAGAMENTO|CONTRACHEQUE/i.test(text) && /L[ÍI]QUIDO/i.test(text) && /PROVENTOS|VENCIMENTOS/i.test(text);
}

function parse(pages) {
  // O PDF costuma trazer duas vias iguais (empregado e empresa): lê só a primeira
  const full = pages.join('\n');
  const starts = [...full.matchAll(/RECIBO DE PAGAMENTO|DEMONSTRATIVO DE PAGAMENTO/gi)].map((m) => m.index);
  const text = starts.length > 1 ? full.slice(0, full.lastIndexOf('\n', starts[1])) : full;
  const lines = text.split('\n');

  const employer = cleanSpaces((/^\s*(?:\d+\s*-\s*)?(.+?)\s{2,}(?:RECIBO|DEMONSTRATIVO)/m.exec(text) || [])[1] || 'Empregador');
  const nameIdx = lines.findIndex((l) => /Nome do funcion[áa]rio/i.test(l));
  const holder = cleanSpaces((/^\s*\d*\s*([A-ZÀ-Ü][A-ZÀ-Ü ]+?)(?:\s{2,}|$)/.exec(lines[nameIdx + 1] || '') || [])[1] || '');
  const refM = /Referente ao m[êe]s de\s+([A-Za-zçÇ]+)\s*\/\s*(\d{4})/i.exec(text);
  const refLabel = refM ? `${plain(refM[1]).slice(0, 3)}/${refM[2].slice(2)}` : '';
  const payDate = brDate((/(\d{2}\/\d{2}\/\d{4})\s+Assinatura/i.exec(text) || [])[1] || '');
  const net = parseBRL((new RegExp(String.raw`L[ÍI]QUIDO[^\d\n]*?(${MONEY})`, 'i').exec(text) || [])[1] || '');

  // Colunas pelo cabeçalho: valor que termina perto de PROVENTOS é provento, perto de DESCONTOS é desconto
  const hIdx = lines.findIndex((l) => /PROVENTOS|VENCIMENTOS/i.test(l) && /DESCONTOS/i.test(l));
  const header = lines[hIdx] || '';
  const endOf = (re) => {
    const m = re.exec(header);
    return m ? m.index + m[0].length : null;
  };
  const provEnd = endOf(/PROVENTOS|VENCIMENTOS/i);
  const descEnd = endOf(/DESCONTOS/i);

  const items = [];
  let totProv = null;
  let totDesc = null;
  for (const raw of lines.slice(hIdx + 1)) {
    if (/Totais/i.test(raw)) {
      const v = raw.match(new RegExp(MONEY, 'g')) || [];
      if (v.length >= 2) (totProv = parseBRL(v[v.length - 2])), (totDesc = parseBRL(v[v.length - 1]));
      break;
    }
    const m = /^\s*(\d{1,5})\s+(.+?)\s{2,}/.exec(raw);
    if (!m) continue;
    const re = new RegExp(MONEY, 'g');
    let last = null;
    for (let x; (x = re.exec(raw)); ) last = { s: x[0], end: x.index + x[0].length };
    if (!last) continue;
    const isDesc = descEnd && provEnd ? Math.abs(last.end - descEnd) < Math.abs(last.end - provEnd) : false;
    items.push({ desc: cleanSpaces(m[2]), value: parseBRL(last.s), isDesc });
  }

  const prov = round2(items.filter((i) => !i.isDesc).reduce((s, i) => s + i.value, 0));
  const gross = totProv ?? prov;
  const date = payDate || null;
  const who = employer.replace(/\s+(LTDA|S\.?A\.?|ME|EIRELI|EPP)\.?$/i, '');
  const transactions = [
    { date, description: `Salário bruto · ${who}${refLabel ? ` (ref. ${refLabel})` : ''}`, amount: round2(gross) },
    ...items.filter((i) => i.isDesc).map((i) => ({ date, description: `Desconto em folha · ${i.desc}`, amount: -round2(i.value) })),
  ];
  const warnings = [];
  if (totProv != null && Math.abs(totProv - prov) >= 0.01) warnings.push(`Proventos: holerite ${totProv} x lido ${prov}`);
  const descSum = round2(items.filter((i) => i.isDesc).reduce((s, i) => s + i.value, 0));
  if (totDesc != null && Math.abs(totDesc - descSum) >= 0.01) warnings.push(`Descontos: holerite ${totDesc} x lido ${descSum}`);
  if (!date) warnings.push('Data de pagamento não encontrada.');

  return {
    bank: 'Holerite',
    kind: 'holerite',
    account: `Holerite ${who}`.slice(0, 60),
    holder,
    // due_date/amount_due guardam data e valor do líquido, usados para achar o depósito na conta
    dueDate: date,
    amountDue: net || null,
    periodStart: date,
    periodEnd: date,
    statedTotal: net || null,
    computedTotal: round2(transactions.reduce((s, t) => s + t.amount, 0)),
    totalLabel: 'salário líquido (bruto - descontos)',
    transactions,
    warnings,
  };
}

module.exports = { id: 'holerite', label: 'Holerite · Recibo de salário', detect, parse };
