const { extractLayoutText } = require('./pdfText');
const ofx = require('./ofx');
const generico = require('./generico');
const { parseCsv, looksLikeCsv } = require('./csv');
const extractors = require('../extractors');

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

// Sem leitor para o formato: a tela oferece criar um (IA ou mapeamento) ou a leitura genérica
const noParser = (format) => Object.assign(new Error('Nenhum leitor reconhece este arquivo.'), { code: 'NO_PARSER', format });

// opts: password; template (modelo a usar já validado); generic (aceita a leitura genérica de PDF); dueDate (fatura CSV)
async function parseStatement(buffer, filename, { password, template, generic, dueDate } = {}) {
  const name = (filename || '').toLowerCase();
  const head = buffer.slice(0, 1024).toString('latin1');
  if (name.endsWith('.ofx') || /OFXHEADER|<OFX>/i.test(head)) {
    const r = ofx.parse(buffer.toString('latin1'));
    return { ...r, parser: ofx.id, parserLabel: ofx.label };
  }
  if (!head.startsWith('%PDF')) {
    if (!(name.endsWith('.csv') || name.endsWith('.txt') || looksLikeCsv(buffer))) throw new Error('Formato não suportado. Envie PDF, OFX ou CSV.');
    const { rows } = parseCsv(buffer, template?.delimiter);
    const found = template ? { id: null, name: template.name, template } : extractors.findForCsv(rows);
    if (!found) throw noParser('csv');
    const r = extractors.runCsv(found.template, rows, { filename, dueDate });
    return { ...r, parser: found.id ? `extrator:${found.id}` : 'extrator', parserLabel: found.name, extractorId: found.id };
  }

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
  if (template) return { ...extractors.runText(template, pages), parser: 'extrator', parserLabel: template.name };
  const parser = PDF_PARSERS.find((p) => p.detect(text));
  if (parser) return { ...parser.parse(pages), parser: parser.id, parserLabel: parser.label };
  const found = extractors.findForText(text);
  if (found) return { ...extractors.runText(found.template, pages), parser: `extrator:${found.id}`, parserLabel: found.name, extractorId: found.id };
  if (!generic) throw noParser('pdf');
  return { ...generico.parse(pages), parser: generico.id, parserLabel: generico.label };
}

module.exports = { parseStatement, PDF_PARSERS };
