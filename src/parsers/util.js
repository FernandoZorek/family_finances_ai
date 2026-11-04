const MONEY = String.raw`-?\d{1,3}(?:\.\d{3})*,\d{2}`;

function parseBRL(s) {
  if (s == null) return NaN;
  const clean = String(s).replace(/R\$\s*/, '').replace(/\s/g, '');
  const neg = clean.startsWith('-') || clean.endsWith('-');
  const n = Number(clean.replace(/-/g, '').replace(/\./g, '').replace(',', '.'));
  return neg ? -n : n;
}

// 'DD/MM/AAAA' -> 'AAAA-MM-DD'
function brDate(s) {
  const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

// Data de fatura sem ano ('DD/MM'): o ano sai do vencimento
function inferCardDate(ddmm, dueIso) {
  const [d, m] = ddmm.split('/').map(Number);
  const dueY = Number(dueIso.slice(0, 4));
  const iso = (y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // compra não pode ser posterior ao vencimento: se for, é do ano anterior (ex.: parcela 12/12)
  return iso(dueY) > dueIso ? iso(dueY - 1) : iso(dueY);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function cleanSpaces(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

module.exports = { MONEY, parseBRL, brDate, inferCardDate, round2, cleanSpaces };
