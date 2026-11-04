// Fatura de cartão Itaú (layout em duas colunas; a categoria do Itaú vem na linha de baixo)
const { MONEY, parseBRL, brDate, inferCardDate, round2, cleanSpaces } = require('./util');

// Alguns PDFs do Itaú saem com espaços no meio das palavras e dos números ("Lan çamentos", "1.071 ,92")
const compact = (s) => s.replace(/[ \t]+/g, '');
const isBroken = (text) => !/Lan[çc]amentos: compras e saques/.test(text);

function detect(text) {
  if (!isBroken(text)) return /Ita[uú]/i.test(text);
  const c = compact(text);
  return /Totaldestafatura/.test(c) && /Previs[ãa]opr[óo]x\.Fechamento/.test(c) && /\d{4}\.XXXX\.XXXX\.\d{4}/.test(c);
}

// Junta espaço simples dentro de números e datas ("1.1 15 ,33" -> "1.115,33", "20/ 07" -> "20/07")
const fixNumbers = (line) => line.replace(/(?<=[\d.,/]) (?=[\d.,/])/g, '');

// Posição na linha original onde começa um trecho achado no texto sem espaços
function brokenIndex(line, re) {
  const m = re.exec(compact(line));
  if (!m) return -1;
  let seen = 0;
  for (let i = 0; i < line.length; i++) {
    if (/[ \t]/.test(line[i])) continue;
    if (seen === m.index) return i;
    seen++;
  }
  return -1;
}

const TX_RE = new RegExp(String.raw`(?<![\d/,.])(\d{2}\/\d{2})(?![\d/])\s+(\S.*?)\s+(${MONEY})(?![\d,])`, 'g');
const ITAU_CATEGORIES = /^(supermercado|restaurante|transporte|servi[çc]os|sa[úu]de|outros|eletronics|eletr[ôo]nicos|vestu[áa]rio|educa[çc][ãa]o|hobby|turismo|entretenimento|diversos|lazer|moradia|ve[íi]culos)\b/i;

function parse(rawPages) {
  const broken = isBroken(rawPages.join('\n'));
  const pages = broken ? rawPages.map((p) => p.split('\n').map(fixNumbers).join('\n')) : rawPages;
  const text = pages.join('\n');
  const flat = broken ? compact(text) : text;
  const warnings = [];
  const due = brDate((/Vencimento:\s*(\d{2}\/\d{2}\/\d{4})/.exec(text) || [])[1] || '');
  const holder = cleanSpaces((/T\s?i\s?t\s?u\s?l\s?a\s?r\s+([A-ZÀ-Ü ]+?)(?:\s{2,}|\n|$)/m.exec(text) || [])[1]);
  const card = (/Cart[ãa]o\s*\d{4}\.X{4}\.X{4}\.(\d{4})/.exec(flat) || [])[1] || null;
  const statedLanc = (() => {
    const m = new RegExp(String.raw`Total\s*dos\s*lan[çc]amentos\s*atuais\s*(${MONEY})`).exec(flat);
    return m ? parseBRL(m[1]) : null;
  })();

  const transactions = [];
  for (const page of pages) {
    const lines = page.split('\n');
    let stop = false;
    let rightCol = null; // texto quebrado: a coluna da esquerda continua ao lado das próximas faturas
    for (let i = 0; i < lines.length && !stop; i++) {
      let line = lines[i];
      if (rightCol != null) line = line.slice(0, rightCol);
      const cut = broken ? brokenIndex(line, /Compraspar?celadas-pr/) : line.search(/Compras parceladas - pr[óo]ximas faturas|Compras parceladas\s*-\s*pr/);
      if (cut >= 0) {
        line = line.slice(0, cut);
        if (broken) rightCol = Math.max(0, cut - 3);
        else stop = true;
      }
      if (/Pagamentoefetuadoem|Previs[ãa]o|Postagem|Emiss[ãa]o|Vencimento/.test(compact(line))) continue;
      TX_RE.lastIndex = 0;
      let m;
      while ((m = TX_RE.exec(line))) {
        // texto quebrado: tira os espaços da descrição para as regras (busca por trecho) funcionarem
        const desc = broken ? compact(m[2]).replace(/(\d{2}\/\d{2})$/, ' $1') : cleanSpaces(m[2]);
        if (/^(Total|Lan[çc]amentos|Repasse)/i.test(desc)) continue;
        const col = m.index;
        // Categoria do Itaú: logo abaixo, na mesma coluna
        let hint = null;
        for (let k = 1; k <= 3 && !hint && lines[i + k] !== undefined; k++) {
          let below = lines[i + k].slice(Math.max(0, col - 2), col + 40).trim();
          if (broken) below = compact(below);
          const hm = ITAU_CATEGORIES.exec(below);
          if (hm) hint = hm[1].toLowerCase();
        }
        let description = desc;
        let installment = null;
        const inst = /\s(\d{2})\/(\d{2})$/.exec(desc);
        if (inst) {
          installment = `${Number(inst[1])}/${Number(inst[2])}`;
          description = desc.slice(0, inst.index);
        }
        const value = parseBRL(m[3]);
        transactions.push({
          date: due ? inferCardDate(m[1], due) : null,
          description,
          amount: round2(-value),
          installment,
          holder,
          card,
          payment: /^PAGAMENTO\b|PAGTO\s*(DEB|EFETUADO)/i.test(description) || (broken && /^PAGAMENTO/i.test(description)),
          categoryHint: hint,
        });
      }
    }
    if (stop || rightCol != null) break;
  }

  // IOF de compras internacionais vem sem data
  const iof = new RegExp(String.raw`Repasse\s*de\s*IOF\s*em\s*R\$\s*(${MONEY})`).exec(flat);
  if (iof && due) {
    transactions.push({
      date: due,
      description: 'IOF compras internacionais',
      amount: round2(-parseBRL(iof[1])),
      holder,
      card,
      payment: false,
    });
  }

  const computed = round2(-transactions.filter((t) => !t.payment).reduce((s, t) => s + t.amount, 0));
  if (!due) warnings.push('Vencimento da fatura não encontrado.');

  return {
    bank: 'Itaú',
    kind: 'cartao',
    account: 'Itaú Cartão',
    holder,
    dueDate: due,
    statedTotal: statedLanc,
    amountDue: (() => {
      const m = new RegExp(String.raw`Total\s*desta\s*fatura\s*(${MONEY})`).exec(flat);
      return m ? parseBRL(m[1]) : null;
    })(),
    computedTotal: computed,
    totalLabel: 'total dos lançamentos atuais',
    transactions,
    warnings,
  };
}

module.exports = { id: 'itau-cartao', label: 'Itaú · Cartão de crédito', detect, parse };
