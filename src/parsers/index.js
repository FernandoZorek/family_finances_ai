const { extractLayoutText } = require('./pdfText');
const ofx = require('./ofx');
const generico = require('./generico');

// Ordem importa: os mais específicos primeiro
const PDF_PARSERS = [
  require('./bradescoCartao'),
  require('./bradescoConta'),
  require('./itauCartao'),
  require('./itauConta'),
  require('./mercadoPago'),
  require('./mercadoPagoConta'),
  require('./sicrediConta'),
  require('./bbCartao'),
  require('./holerite'),
  require('./contaPJ'),
];

async function parseStatement(buffer, filename, { password } = {}) {
  const name = (filename || '').toLowerCase();
  const head = buffer.slice(0, 1024).toString('latin1');
  if (name.endsWith('.ofx') || /OFXHEADER|<OFX>/i.test(head)) {
    const r = ofx.parse(buffer.toString('latin1'));
    return { ...r, parser: ofx.id, parserLabel: ofx.label };
  }
  if (!head.startsWith('%PDF')) throw new Error('Formato não suportado. Envie PDF ou OFX.');

  let pages;
  try {
    pages = await extractLayoutText(buffer, password);
  } catch (e) {
    if (e && e.name === 'PasswordException') {
      const err = new Error(password ? 'Senha do PDF incorreta.' : 'Este PDF é protegido por senha. Informe a senha no envio.');
      err.code = 'PDF_PASSWORD';
      throw err;
    }
    throw e;
  }
  const text = pages.join('\n');
  if (text.replace(/\s/g, '').length < 50) {
    throw new Error('O PDF não tem texto extraível (provavelmente é imagem escaneada).');
  }
  const parser = PDF_PARSERS.find((p) => p.detect(text));
  if (parser) return { ...parser.parse(pages), parser: parser.id, parserLabel: parser.label };
  return { ...generico.parse(pages), parser: generico.id, parserLabel: generico.label };
}

module.exports = { parseStatement, PDF_PARSERS };
