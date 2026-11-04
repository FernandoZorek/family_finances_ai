// Extrato da conta Mercado Pago ("EXTRATO DE CONTA", PF ou PJ/MEI)
const { MONEY, parseBRL, round2, cleanSpaces } = require('./util');

const isoDash = (s) => (s ? `${s.slice(6, 10)}-${s.slice(3, 5)}-${s.slice(0, 2)}` : null);

function detect(text) {
  return /EXTRATO DE CONTA/.test(text) && /DETALHE DOS MOVIMENTOS/.test(text) && /Mercado Pago/i.test(text);
}

const ANCHOR_RE = new RegExp(String.raw`^\s*(?:(\d{2})-(\d{2})-(\d{4}))?\s*(.*?)\s*\b(\d{9,})\s+R\$\s*(${MONEY})\s+R\$\s*(${MONEY})\s*$`);
// Frases que abrem a descrição de um novo movimento
const TITLE_RE = /^(Pagamento|Pix recebido|Pix enviado|Libera[çc][ãa]o de dinheiro|Dinheiro (reservado|retirado)|Transfer[êe]ncia|Rendimento|Compra|Estorno|Devolu[çc][ãa]o|Reembolso|Cancelamento|Tarifa|Recarga|Saque|Dep[óo]sito|Envio de dinheiro|Recebimento|Cobran[çc]a)\b/i;
const SKIP_RE = /^\s*(Data\s+Descri|\d+\/\d+\s*$)/;

function parse(pages) {
  const text = pages.join('\n');
  const lines = text.split('\n');
  const headIdx = lines.findIndex((l) => /EXTRATO DE CONTA/.test(l));
  const holder = cleanSpaces((lines[headIdx + 1] || '').replace(/^[\s\d.]+(?=[A-ZÀ-Ü])/, ''));
  const conta = (/Conta:\s*(\d+)/.exec(text) || [])[1] || '';
  const money = (re) => {
    const m = new RegExp(re.source + String.raw`\s*R\$\s*(${MONEY})`).exec(text);
    return m ? parseBRL(m[1]) : null;
  };
  const entradas = money(/Entradas:/);
  const saidas = money(/Saidas:/);

  const txs = [];
  let started = false;
  let pending = [];
  let last = null;
  for (const raw of lines) {
    if (/DETALHE DOS MOVIMENTOS/.test(raw)) {
      started = true;
      continue;
    }
    if (!started) continue;
    if (/Data de gera[çc][ãa]o|Voc[êe] tem alguma d[úu]vida/.test(raw)) break;
    if (!raw.trim() || SKIP_RE.test(raw)) continue;

    const m = ANCHOR_RE.exec(raw);
    if (m) {
      const inline = m[4].trim();
      let parts = pending;
      if (inline && TITLE_RE.test(inline)) parts = [inline];
      else if (inline) parts = [...pending, inline];
      last = {
        date: m[1] ? `${m[3]}-${m[2]}-${m[1]}` : last?.date,
        parts,
        amount: round2(parseBRL(m[6])),
      };
      txs.push(last);
      pending = [];
      continue;
    }
    const t = raw.trim();
    if (TITLE_RE.test(t)) pending = [t];
    else if (pending.length) pending.push(t);
    else if (last) last.parts.push(t);
  }

  const transactions = txs.map((t) => ({ date: t.date, description: cleanSpaces(t.parts.join(' ')) || 'Movimento', amount: t.amount }));
  const inSum = round2(transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0));
  const outSum = round2(transactions.filter((t) => t.amount < 0).reduce((s, t) => s + t.amount, 0));
  const warnings = [];
  if (entradas != null && Math.abs(entradas - inSum) >= 0.01) warnings.push(`Entradas: banco ${entradas} x lido ${inSum}`);
  if (saidas != null && Math.abs(saidas - outSum) >= 0.01) warnings.push(`Saídas: banco ${saidas} x lido ${outSum}`);
  const dates = transactions.map((t) => t.date).filter(Boolean).sort();

  return {
    bank: 'Mercado Pago',
    kind: 'conta',
    account: `Mercado Pago Conta ${conta.slice(-6)}`.trim(),
    holder,
    periodStart: isoDash((/Periodo:\s*De\s*(\d{2}-\d{2}-\d{4})/.exec(text) || [])[1]) || dates[0],
    periodEnd: isoDash((/Periodo:\s*De\s*\d{2}-\d{2}-\d{4}\s*al\s*(\d{2}-\d{2}-\d{4})/.exec(text) || [])[1]) || dates[dates.length - 1],
    statedTotal: entradas != null && saidas != null ? round2(entradas + saidas) : null,
    computedTotal: round2(inSum + outSum),
    totalLabel: 'entradas + saídas do período',
    transactions,
    warnings,
  };
}

module.exports = { id: 'mercadopago-conta', label: 'Mercado Pago · Conta', detect, parse };
