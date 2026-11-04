// Extrai o texto de um PDF reconstruindo o layout por coordenadas (equivalente ao pdftotext -layout),
// para que os parsers trabalhem com colunas alinhadas. Usa só JavaScript (pdfjs), sem dependência do sistema.
let pdfjsPromise;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function extractLayoutText(buffer, password) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    password: password || undefined,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    pages.push(renderPage(content.items));
    page.cleanup();
  }
  await doc.destroy();
  return pages;
}

function renderPage(items) {
  const parts = [];
  const widths = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.transform[3]) || Math.abs(it.height) || 8;
    parts.push({ x, y, h, w: it.width, str: it.str });
    if (it.str.length >= 2 && it.width > 0) widths.push(it.width / it.str.length);
  }
  if (!parts.length) return '';
  widths.sort((a, b) => a - b);
  const charW = Math.max(widths[Math.floor(widths.length * 0.3)] || 4.5, 2.5);

  // Agrupa por linha (y), com tolerância proporcional à altura da fonte
  parts.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const part of parts) {
    const line = lines.find((l) => Math.abs(l.y - part.y) <= Math.max(2, Math.min(l.h, part.h) * 0.45));
    if (line) line.items.push(part);
    else lines.push({ y: part.y, h: part.h, items: [part] });
  }
  lines.sort((a, b) => b.y - a.y);

  const out = [];
  let prevY = null;
  for (const line of lines) {
    if (prevY !== null) {
      const gap = (prevY - line.y) / (line.h * 1.6);
      for (let i = 1; i < Math.min(Math.round(gap), 3); i++) out.push('');
    }
    prevY = line.y;
    line.items.sort((a, b) => a.x - b.x);
    let s = '';
    let prevEnd = null;
    for (const it of line.items) {
      // Pedaços colados no anterior (mesma palavra quebrada em vários itens) seguem sem espaço
      if (prevEnd !== null && it.x - prevEnd < charW * 0.35) {
        s += it.str;
      } else {
        let col = Math.round(it.x / charW);
        if (col < s.length + 1 && s.length) col = s.length + (s.endsWith(' ') ? 0 : 1);
        if (col > s.length) s += ' '.repeat(col - s.length);
        s += it.str;
      }
      prevEnd = it.x + it.w;
    }
    out.push(s.replace(/\s+$/, ''));
  }
  return out.join('\n');
}

module.exports = { extractLayoutText };
