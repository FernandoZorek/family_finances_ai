// Leitura de CSV exportado por bancos: codificação (UTF-8 ou Latin-1), separador (; , tab |) e aspas.
const MAX_ROWS = 20000;

// UTF-8 válido? senão Latin-1 (internet banking antigo exporta assim)
function decode(buffer) {
  const utf8 = buffer.toString('utf8');
  const text = utf8.includes('\uFFFD') ? buffer.toString('latin1') : utf8;
  return text.replace(/^\uFEFF/, '');
}

function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 15);
  let best = ',';
  let bestScore = 0;
  for (const d of [';', ',', '\t', '|']) {
    // quantidade de colunas mais comum entre as linhas; vale mais quando se repete e tem várias colunas
    const freq = new Map();
    for (const l of lines) {
      const n = splitLine(l, d).length;
      freq.set(n, (freq.get(n) || 0) + 1);
    }
    const [cols, times] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] || [0, 0];
    const score = cols > 1 ? times * cols : 0;
    if (score > bestScore) (bestScore = score), (best = d);
  }
  return best;
}

function splitLine(line, d) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

// -> { delimiter, rows: string[][] } (sem linhas vazias)
function parseCsv(buffer, delimiter) {
  const text = decode(buffer);
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    rows.push(splitLine(line, d));
    if (rows.length >= MAX_ROWS) break;
  }
  return { delimiter: d, rows };
}

// Parece CSV? (texto com o mesmo separador em várias linhas)
function looksLikeCsv(buffer) {
  const head = buffer.slice(0, 4096).toString('latin1');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0E-\x1F]/.test(head)) return false; // binário
  const lines = head.split(/\r?\n/).filter((l) => l.trim()).slice(0, 5);
  return lines.length >= 2 && [';', ',', '\t', '|'].some((d) => lines.every((l) => l.split(d).length >= 3));
}

module.exports = { parseCsv, decode, looksLikeCsv, splitLine };
