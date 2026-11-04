// Leitores declarativos ("extratores"): para formatos sem leitor próprio, um MODELO em JSON diz como ler o documento.
// O modelo nunca é código: só palavras para reconhecer o documento, uma expressão regular por linha (PDF) ou o
// mapeamento de colunas (CSV), formatos de data/valor e se o sinal é invertido. Pode ser escrito à mão, vir pronto
// (presets de CSV) ou ser sugerido pela IA; é validado antes de usar (tamanho e forma das regex, contra travamento).
const { db } = require('./db');
const { normalize } = require('./categorize');
const { round2, cleanSpaces, inferCardDate } = require('./parsers/util');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const MAX_LINE = 400;
const MONTHS_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const DATE_FORMATS = ['DD/MM/YYYY', 'DD/MM/YY', 'DD/MM', 'YYYY-MM-DD', 'DD-MM-YYYY', 'DD.MM.YYYY', 'DD MMM', 'DD MMM YYYY'];
const norm = (s) => normalize(s).toLowerCase();

// ---------- valores e datas ----------
// "R$ 1.234,56" | "-1.234,56" | "1,234.56" | "(123,45)" | "123,45 D" -> número
function parseAmount(raw, decimal = ',') {
  let s = String(raw ?? '').trim();
  if (!s) return NaN;
  let neg = /^\(.*\)$/.test(s) || /^-|-$/.test(s.replace(/\s/g, '')) || /\s?D$/i.test(s);
  s = s.replace(/R\$|US\$|BRL|[()\s]|[CD]$/gi, '').replace(/^-|-$/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  s = decimal === ',' ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  const n = Number(s);
  if (Number.isNaN(n)) return NaN;
  if (n < 0) neg = true;
  return neg ? -Math.abs(n) : n;
}

// -> 'AAAA-MM-DD' ou null. Sem ano: cartão usa o vencimento; conta usa o ano de referência
function parseDate(raw, fmt, ctx = {}) {
  const s = String(raw ?? '').trim().toLowerCase();
  const pad = (n) => String(n).padStart(2, '0');
  let d;
  let m;
  let y;
  let r;
  switch (fmt) {
    case 'YYYY-MM-DD':
      if ((r = /(\d{4})-(\d{2})-(\d{2})/.exec(s))) [, y, m, d] = r;
      break;
    case 'DD-MM-YYYY':
    case 'DD.MM.YYYY':
    case 'DD/MM/YYYY':
      if ((r = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s))) [, d, m, y] = r;
      break;
    case 'DD/MM/YY':
      if ((r = /(\d{1,2})\/(\d{1,2})\/(\d{2})\b/.exec(s))) [, d, m, y] = r, (y = 2000 + Number(y));
      break;
    case 'DD/MM':
      if ((r = /(\d{1,2})\/(\d{1,2})/.exec(s))) [, d, m] = r;
      break;
    case 'DD MMM':
    case 'DD MMM YYYY':
      if ((r = /(\d{1,2})\s*(?:de\s*)?([a-zç]{3})[a-zç]*\.?\s*(?:de\s*)?(\d{4})?/.exec(s))) {
        d = r[1];
        m = MONTHS_PT.indexOf(r[2]) + 1 || null;
        y = r[3];
      }
      break;
    default:
      return null;
  }
  if (!d || !m || Number(m) > 12 || Number(d) > 31) return null;
  if (!y) {
    if (ctx.dueDate) return inferCardDate(`${pad(d)}/${pad(m)}`, ctx.dueDate);
    y = ctx.year || new Date().getFullYear();
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

// ---------- segurança das regex ----------
// Sem quantificador aninhado ((a+)+, (.*)*) e com tamanho limitado: evita travar o servidor (ReDoS)
function safeRegex(src, { groups = [] } = {}) {
  if (typeof src !== 'string' || !src || src.length > 400) throw fail('Regex vazia ou longa demais.');
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(src)) throw fail('Regex com repetição aninhada não é aceita.');
  if (/\\[1-9]/.test(src)) throw fail('Regex com referência a grupo não é aceita.');
  let re;
  try {
    re = new RegExp(src, 'i');
  } catch (e) {
    throw fail(`Regex inválida: ${e.message}`);
  }
  for (const g of groups) if (!new RegExp(`\\(\\?<${g}>`).test(src)) throw fail(`A regex precisa do grupo (?<${g}>...).`);
  return re;
}

// ---------- validação do modelo ----------
const str = (v, max = 80) => (v == null ? null : String(v).slice(0, max));
const strList = (v, n = 10, max = 80) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).slice(0, n).map((x) => x.slice(0, max)) : []);

function validateTemplate(t) {
  if (!t || typeof t !== 'object') throw fail('Modelo inválido.');
  const kind = t.kind === 'csv' ? 'csv' : t.kind === 'text' ? 'text' : null;
  if (!kind) throw fail('Modelo precisa de kind "csv" ou "text".');
  const docKind = t.doc_kind === 'cartao' ? 'cartao' : 'conta';
  if (!DATE_FORMATS.includes(t.date_format)) throw fail(`Formato de data inválido (use ${DATE_FORMATS.join(', ')}).`);
  const out = {
    kind,
    name: str(t.name, 60) || 'Leitor',
    bank: str(t.bank, 40) || 'Banco',
    account: str(t.account, 60) || null,
    doc_kind: docKind,
    date_format: t.date_format,
    decimal: t.decimal === '.' ? '.' : ',',
    sign: t.sign === 'invert' ? 'invert' : 'as_is',
    payment_patterns: strList(t.payment_patterns, 6),
    skip: strList(t.skip, 20),
  };
  if (kind === 'csv') {
    const cols = t.columns || {};
    const col = (v) => (v == null || v === '' ? null : typeof v === 'number' ? Math.max(0, Math.floor(v)) : String(v).slice(0, 60));
    out.detect = { header: strList(t.detect?.header, 12, 60) };
    if (!out.detect.header.length) throw fail('Modelo CSV precisa dos nomes das colunas para reconhecer o arquivo.');
    out.delimiter = [';', ',', '\t', '|'].includes(t.delimiter) ? t.delimiter : null;
    out.header_row = Number.isInteger(t.header_row) && t.header_row >= 0 && t.header_row < 50 ? t.header_row : null;
    out.columns = {
      date: col(cols.date),
      description: Array.isArray(cols.description) ? cols.description.map(col).filter((x) => x != null).slice(0, 4) : [col(cols.description)].filter((x) => x != null),
      amount: col(cols.amount),
      debit: col(cols.debit),
      credit: col(cols.credit),
    };
    if (out.columns.date == null || !out.columns.description.length || (out.columns.amount == null && out.columns.debit == null && out.columns.credit == null)) {
      throw fail('Escolha as colunas de data, descrição e valor (ou débito/crédito).');
    }
    out.due_from_filename = Boolean(t.due_from_filename);
  } else {
    out.detect = { all: strList(t.detect?.all, 8, 80) };
    if (!out.detect.all.length) throw fail('Modelo precisa de textos que reconheçam o documento.');
    const line = t.line || {};
    safeRegex(line.regex, { groups: ['date', 'description'] });
    if (!/\(\?<(amount|debit|credit)>/.test(line.regex)) throw fail('A regex precisa do grupo (?<amount>) ou (?<debit>)/(?<credit>).');
    out.line = { regex: line.regex };
    out.sections = { start: str(t.sections?.start), end: str(t.sections?.end) };
    out.meta = {};
    for (const k of ['account', 'holder', 'due_date', 'period_start', 'period_end', 'total']) {
      const src = t.meta?.[k];
      if (src) {
        safeRegex(src);
        out.meta[k] = src;
      }
    }
    out.total_compare = t.total_compare === 'debits' ? 'debits' : 'sum';
  }
  return out;
}

// ---------- reconhecer ----------
function matchesText(t, text) {
  const n = norm(text.slice(0, 20000));
  return t.detect.all.every((w) => n.includes(norm(w)));
}

function headerIndex(t, rows) {
  const want = t.detect.header.map(norm);
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map(norm);
    if (want.every((w) => cells.includes(w))) return i;
  }
  return -1;
}

// ---------- executar ----------
const isPayment = (t, desc) => t.payment_patterns.some((p) => norm(desc).includes(norm(p)));
const installmentOf = (desc) => {
  // "LOJA 02/03", "Loja - Parcela 2/3", "LOJA (2 de 3)"
  const m = /[\s-]*(?:parc(?:ela)?\.?\s*)?\(?\b(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\)?\s*$/i.exec(desc);
  return m && Number(m[1]) <= Number(m[2]) && Number(m[2]) > 1 ? { inst: `${Number(m[1])}/${Number(m[2])}`, desc: desc.slice(0, m.index).replace(/[\s-]+$/, '').trim() } : null;
};

function finish(t, transactions, { stated = null, dueDate = null, holder = null, account = null, periodStart, periodEnd, warnings = [] }) {
  const dates = transactions.map((x) => x.date).filter(Boolean).sort();
  // fatura: pagamento da fatura anterior não entra no total
  const sum = round2(transactions.filter((x) => !(t.doc_kind === 'cartao' && x.payment)).reduce((a, x) => a + x.amount, 0));
  const debits = round2(-transactions.filter((x) => x.amount < 0 && !x.payment).reduce((a, x) => a + x.amount, 0));
  const computed = t.doc_kind === 'cartao' ? (t.total_compare === 'debits' ? debits : round2(-sum)) : t.total_compare === 'debits' ? debits : sum;
  if (t.doc_kind === 'cartao' && !dueDate) warnings.push('Vencimento da fatura não encontrado: a fatura entra no mês das compras.');
  return {
    bank: t.bank,
    kind: t.doc_kind,
    account: account || t.account || `${t.bank} ${t.doc_kind === 'cartao' ? 'Cartão' : 'Conta'}`,
    holder,
    dueDate,
    periodStart: periodStart || dates[0] || null,
    periodEnd: periodEnd || dates[dates.length - 1] || null,
    statedTotal: stated,
    amountDue: t.doc_kind === 'cartao' ? stated : null,
    computedTotal: computed,
    totalLabel: t.doc_kind === 'cartao' ? 'total da fatura' : 'entradas - saídas',
    transactions,
    warnings,
  };
}

function runText(t, pages) {
  const text = pages.join('\n');
  const meta = {};
  for (const [k, src] of Object.entries(t.meta || {})) {
    const m = safeRegex(src).exec(text);
    meta[k] = m ? cleanSpaces(m[1] ?? m[0]) : null;
  }
  const isoOf = (v) => (v ? parseDate(v, 'DD/MM/YYYY') || parseDate(v, 'YYYY-MM-DD') || parseDate(v, 'DD MMM YYYY') : null);
  const dueDate = isoOf(meta.due_date);
  const year = Number((isoOf(meta.period_end) || dueDate || '').slice(0, 4)) || undefined;
  const re = safeRegex(t.line.regex);
  const skip = t.skip.map(norm);
  const transactions = [];
  let inSection = !t.sections?.start;
  for (const raw of text.split('\n')) {
    const line = raw.slice(0, MAX_LINE);
    const n = norm(line);
    if (t.sections?.start && n.includes(norm(t.sections.start))) inSection = true;
    if (t.sections?.end && n.includes(norm(t.sections.end))) inSection = false;
    if (!inSection || skip.some((s) => n.includes(s))) continue;
    const m = re.exec(line);
    if (!m?.groups) continue;
    const g = m.groups;
    const date = parseDate(g.date, t.date_format, { dueDate, year });
    let amount;
    if (g.amount != null) amount = parseAmount(g.amount, t.decimal);
    else amount = (parseAmount(g.credit, t.decimal) || 0) - Math.abs(parseAmount(g.debit, t.decimal) || 0);
    if (!date || Number.isNaN(amount) || !amount) continue;
    if (g.amount != null && t.sign === 'invert') amount = -amount;
    let description = cleanSpaces(g.description);
    const inst = installmentOf(description);
    if (inst) description = inst.desc;
    transactions.push({ date, description: description || 'Lançamento', amount: round2(amount), installment: inst?.inst || null, payment: isPayment(t, description) });
  }
  const stated = meta.total ? Math.abs(parseAmount(meta.total, t.decimal)) : null;
  return finish(t, transactions, {
    stated: Number.isNaN(stated) ? null : stated,
    dueDate,
    holder: meta.holder,
    account: meta.account ? `${t.bank} ${meta.account}`.slice(0, 60) : null,
    periodStart: isoOf(meta.period_start),
    periodEnd: isoOf(meta.period_end),
  });
}

function runCsv(t, rows, { filename = '', dueDate: dueOverride } = {}) {
  const h = t.header_row ?? headerIndex(t, rows);
  if (h < 0 || !rows[h]) throw fail('Cabeçalho do CSV não encontrado.');
  const header = rows[h].map(norm);
  const idx = (c) => (c == null ? -1 : typeof c === 'number' ? c : header.indexOf(norm(c)));
  const ci = { date: idx(t.columns.date), desc: t.columns.description.map(idx).filter((i) => i >= 0), amount: idx(t.columns.amount), debit: idx(t.columns.debit), credit: idx(t.columns.credit) };
  if (ci.date < 0 || !ci.desc.length || (ci.amount < 0 && ci.debit < 0 && ci.credit < 0)) throw fail('Colunas do modelo não existem neste CSV.');
  let dueDate = dueOverride || null;
  if (!dueDate && t.due_from_filename) {
    const m = /(\d{4})-(\d{2})-(\d{2})/.exec(filename);
    if (m) dueDate = `${m[1]}-${m[2]}-${m[3]}`;
  }
  const skip = t.skip.map(norm);
  const transactions = [];
  for (const r of rows.slice(h + 1)) {
    const description = cleanSpaces(ci.desc.map((i) => r[i] || '').filter(Boolean).join(' '));
    if (!description || skip.some((s) => norm(description).includes(s))) continue;
    const date = parseDate(r[ci.date], t.date_format, { dueDate });
    let amount;
    if (ci.amount >= 0) {
      amount = parseAmount(r[ci.amount], t.decimal);
      if (t.sign === 'invert') amount = -amount;
    } else amount = (Math.abs(parseAmount(r[ci.credit], t.decimal)) || 0) - (Math.abs(parseAmount(r[ci.debit], t.decimal)) || 0);
    if (!date || Number.isNaN(amount) || !amount) continue;
    const inst = installmentOf(description);
    transactions.push({ date, description: inst ? inst.desc : description, amount: round2(amount), installment: inst?.inst || null, payment: isPayment(t, description) });
  }
  return finish(t, transactions, { dueDate });
}

// ---------- modelos prontos de CSV (formatos públicos de exportação) ----------
const PRESETS = [
  {
    id: 'preset:nubank-cartao',
    name: 'Nubank · Cartão (CSV)',
    kind: 'csv',
    bank: 'Nubank',
    account: 'Nubank Cartão',
    doc_kind: 'cartao',
    detect: { header: ['date', 'title', 'amount'] },
    columns: { date: 'date', description: 'title', amount: 'amount' },
    date_format: 'YYYY-MM-DD',
    decimal: '.',
    sign: 'invert', // compra vem positiva
    payment_patterns: ['Pagamento recebido'],
    due_from_filename: true, // "Nubank_2026-11-10.csv"
  },
  {
    id: 'preset:nubank-conta',
    name: 'Nubank · Conta (CSV)',
    kind: 'csv',
    bank: 'Nubank',
    account: 'Nubank Conta',
    doc_kind: 'conta',
    detect: { header: ['Data', 'Valor', 'Identificador', 'Descrição'] },
    columns: { date: 'Data', description: 'Descrição', amount: 'Valor' },
    date_format: 'DD/MM/YYYY',
    decimal: '.',
    sign: 'as_is',
  },
  {
    id: 'preset:inter-conta',
    name: 'Inter · Conta (CSV)',
    kind: 'csv',
    bank: 'Inter',
    account: 'Inter Conta',
    doc_kind: 'conta',
    detect: { header: ['Data Lançamento', 'Descrição', 'Valor'] },
    columns: { date: 'Data Lançamento', description: ['Histórico', 'Descrição'], amount: 'Valor' },
    date_format: 'DD/MM/YYYY',
    decimal: ',',
    sign: 'as_is',
  },
].map((p) => ({ ...validateTemplate(p), id: p.id, source: 'preset' }));

// Sugestão de mapeamento para um CSV desconhecido (a pessoa confere antes de importar)
function suggestCsv(rows, filename = '') {
  const hi = rows.findIndex((r) => r.filter((c) => /[a-z]/i.test(c)).length >= 2 && r.length >= 2);
  const header = rows[Math.max(0, hi)] || [];
  const find = (re) => header.find((h) => re.test(norm(h))) || null;
  const date = find(/^(data|date|dt)\b/);
  const description = find(/(descri|histor|title|titulo|lancamento|estabelecimento|memo|detalhe)/);
  const amount = find(/^(valor|amount|value|quantia|montante)/);
  const debit = find(/(debito|saida)/);
  const credit = find(/(credito|entrada)/);
  const sample = rows.slice(hi + 1, hi + 8);
  const col = (name) => header.indexOf(name);
  const dateSample = date ? sample.map((r) => r[col(date)]).find(Boolean) || '' : '';
  const date_format = /^\d{4}-\d{2}-\d{2}/.test(dateSample) ? 'YYYY-MM-DD' : /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(dateSample) ? 'DD/MM/YY' : /^\d{1,2}-\d{1,2}-\d{4}/.test(dateSample) ? 'DD-MM-YYYY' : 'DD/MM/YYYY';
  const valSample = sample.map((r) => r[col(amount || debit || credit)] || '').join(' ');
  const decimal = /\d,\d{2}\b/.test(valSample) ? ',' : '.';
  const card = /cart|fatura|credit|card/i.test(filename) || /title/i.test(header.join(' '));
  return {
    kind: 'csv',
    name: '',
    bank: '',
    account: '',
    doc_kind: card ? 'cartao' : 'conta',
    detect: { header: [date, description, amount || debit, credit].filter(Boolean) },
    header_row: Math.max(0, hi),
    columns: { date, description: description ? [description] : [], amount: debit && credit ? null : amount, debit: amount ? null : debit, credit: amount ? null : credit },
    date_format,
    decimal,
    sign: card ? 'invert' : 'as_is',
    payment_patterns: card ? ['Pagamento'] : [],
  };
}

// ---------- leitores salvos ----------
function saved({ enabledOnly = true } = {}) {
  return db
    .prepare(`SELECT * FROM extractors ${enabledOnly ? 'WHERE enabled = 1' : ''} ORDER BY id DESC`)
    .all()
    .map((r) => ({ ...r, template: JSON.parse(r.template), enabled: Boolean(r.enabled) }));
}

function list() {
  return {
    saved: saved({ enabledOnly: false }).map(({ template, ...r }) => ({ ...r, kind: template.kind, doc_kind: template.doc_kind, bank: template.bank, template })),
    presets: PRESETS.map((p) => ({ id: p.id, name: p.name, kind: p.kind, doc_kind: p.doc_kind, bank: p.bank })),
  };
}

function saveTemplate(template, { name, source = 'manual', userId = null } = {}) {
  const t = validateTemplate({ ...template, name: name || template.name });
  return db.prepare('INSERT INTO extractors (name, template, source, created_by) VALUES (?, ?, ?, ?)').run(t.name, JSON.stringify(t), source, userId).lastInsertRowid;
}

function markUsed(id) {
  if (Number.isInteger(id)) db.prepare("UPDATE extractors SET uses = uses + 1, last_used_at = datetime('now') WHERE id = ?").run(id);
}

// Qual leitor salvo/preset reconhece este documento
function findForText(text) {
  return saved().find((r) => r.template.kind === 'text' && matchesText(r.template, text)) || null;
}
function findForCsv(rows) {
  const s = saved().find((r) => r.template.kind === 'csv' && headerIndex(r.template, rows) >= 0);
  if (s) return s;
  const p = PRESETS.find((x) => headerIndex(x, rows) >= 0);
  return p ? { id: p.id, name: p.name, template: p, source: 'preset' } : null;
}

module.exports = { validateTemplate, runText, runCsv, suggestCsv, safeRegex, parseAmount, parseDate, PRESETS, list, saveTemplate, markUsed, findForText, findForCsv, matchesText, headerIndex, DATE_FORMATS };
