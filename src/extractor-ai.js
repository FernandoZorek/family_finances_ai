// IA sugere o MODELO de leitura (JSON) de um formato desconhecido. Nunca gera código.
// Vai para a IA só uma amostra do texto com CPF/CNPJ, cartão, conta, e-mail e telefone mascarados.
const ai = require('./ai');
const extractors = require('./extractors');
const { cleanSpaces } = require('./parsers/util');

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// Mascara dados pessoais mantendo o formato (a regex do modelo continua casando)
function mask(text) {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, 'email@exemplo.com')
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '000.000.000-00')
    .replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, '00.000.000/0000-00')
    .replace(/\b(?:\d{4}[ .*X]{1,3}){3}\d{4}\b/gi, '0000 0000 0000 0000')
    .replace(/\(?\b\d{2}\)?\s?9?\d{4}-\d{4}\b/g, '(00) 00000-0000')
    // sequências longas de dígitos (conta, agência+conta, documento, código de barras) -> zeros do mesmo tamanho
    .replace(/\b\d[\d-]{5,}\d\b/g, (m) => m.replace(/\d/g, '0'));
}

function sampleOf(pending, parsed) {
  if (parsed.format === 'csv') {
    const rows = parsed.rows.slice(0, 14).map((r) => r.join(parsed.delimiter));
    return mask(rows.join('\n')).slice(0, 6000);
  }
  const lines = parsed.pages
    .join('\n')
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim());
  // começo (cabeçalho, totais) + um trecho do meio (lançamentos)
  const pick = [...lines.slice(0, 110), ...(lines.length > 160 ? ['[...]', ...lines.slice(Math.floor(lines.length / 2), Math.floor(lines.length / 2) + 40)] : lines.slice(110, 150))];
  return mask(pick.map((l) => l.slice(0, 220)).join('\n')).slice(0, 14000);
}

const S = { type: ['string', 'null'] };
const SA = { type: 'array', items: { type: 'string' } };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMA = obj({
  kind: { type: 'string', enum: ['text', 'csv'] },
  name: { type: 'string' },
  bank: { type: 'string' },
  account: S,
  doc_kind: { type: 'string', enum: ['conta', 'cartao'] },
  date_format: { type: 'string', enum: extractors.DATE_FORMATS },
  decimal: { type: 'string', enum: [',', '.'] },
  sign: { type: 'string', enum: ['as_is', 'invert'] },
  payment_patterns: SA,
  skip: SA,
  detect: obj({ all: SA, header: SA }),
  line: obj({ regex: S }),
  sections: obj({ start: S, end: S }),
  meta: obj({ account: S, holder: S, due_date: S, period_start: S, period_end: S, total: S }),
  total_compare: { type: 'string', enum: ['sum', 'debits'] },
  columns: obj({ date: S, description: SA, amount: S, debit: S, credit: S }),
  delimiter: S,
  header_row: { type: ['integer', 'null'] },
  due_from_filename: { type: 'boolean' },
});

function prompt(format, sample, filename, feedback) {
  return `Você cria MODELOS DE LEITURA (JSON) para extratos bancários e faturas de cartão brasileiros. O app aplica o modelo; você não escreve código.
Arquivo: "${filename.replace(/[^\w .-]/g, '')}" (formato ${format === 'csv' ? 'CSV' : 'texto extraído de PDF, colunas alinhadas com espaços'}).

Regras do modelo:
- kind: "${format === 'csv' ? 'csv' : 'text'}". doc_kind: "cartao" para fatura de cartão, "conta" para extrato de conta.
- bank: nome do banco/instituição; name: nome curto do leitor (ex.: "Santander · Fatura do cartão"). account: nome da conta/cartão sem números (ex.: "Santander Cartão").
- date_format: como a data aparece nas linhas. decimal: separador decimal dos valores.
- sign: valores no app são negativos para saída/compra e positivos para entrada. Se no documento a compra/débito aparece positiva (comum em fatura), use "invert".
- payment_patterns: textos das linhas de pagamento da fatura (ex.: "PAGAMENTO EFETUADO"); skip: textos de linhas a ignorar (saldo, totais, cabeçalhos).
- PDF (kind "text"):
  - detect.all: 2 a 5 textos FIXOS do layout que identificam este banco e tipo de documento (nome do banco, títulos de seção). NUNCA nomes de pessoas, CPF, números de conta ou valores.
  - line.regex: regex JavaScript (flag i) aplicada a CADA linha, com grupos nomeados (?<date>...), (?<description>...) e (?<amount>...) ou (?<debit>...)/(?<credit>...). Sem repetição aninhada como (a+)+ e sem \\1. Prefira [\\s\\S] só quando necessário; use .+? para descrição.
  - sections.start/end: textos da linha onde começa/termina a lista de lançamentos (ou null).
  - meta.*: regex com UM grupo de captura para conta, titular, vencimento (data), período e total da fatura/variação; null se não houver. total_compare: "sum" (total = soma dos lançamentos) ou "debits" (total = só compras/saídas).
  - columns: use valores nulos e lista vazia. delimiter/header_row: null. due_from_filename: false.
- CSV (kind "csv"):
  - detect.header: nomes EXATOS das colunas do cabeçalho que identificam o formato. columns: nomes das colunas de data, descrição (lista, pode juntar duas), valor (ou débito/crédito).
  - delimiter: o separador; header_row: índice (0 = primeira linha) do cabeçalho. due_from_filename: true se o nome do arquivo tem a data de vencimento (AAAA-MM-DD).
  - line.regex, sections e meta: null. detect.all: lista vazia.
A amostra abaixo teve CPF/CNPJ, contas, cartões, e-mails e telefones trocados por zeros.${feedback ? `\n\nA tentativa anterior falhou: ${feedback}. Corrija o modelo.` : ''}

Amostra:
${sample}`;
}

// Sem números longos nem e-mail nos textos de reconhecimento (o modelo vale para o banco, não para a pessoa)
function personalFree(t) {
  const texts = [...(t.detect?.all || []), ...(t.detect?.header || [])];
  if (texts.some((x) => /\d{4,}|@/.test(x))) throw fail('O modelo sugerido usa dados pessoais para reconhecer o documento. Tente de novo.', 422);
}

// -> { template, result } (result = leitura do arquivo inteiro com o modelo)
async function generate(parsed, filename, { user, run }) {
  if (!ai.enabled()) throw fail('IA desligada (defina FF_AI_PROVIDER).');
  if (require('./config').ai.provider === 'webhook') throw fail('Criar leitor com IA precisa de um provedor (anthropic ou openai); o webhook não suporta.');
  const sample = sampleOf(null, parsed);
  let feedback = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      raw = await ai.askJSON(prompt(parsed.format, sample, filename, feedback), SCHEMA, 'medium', { action: 'extrator', user });
    } catch (e) {
      throw fail(`Falha na IA: ${String(e.message || e).slice(0, 200)}`, 502);
    }
    const t = { ...raw, columns: raw.columns && { ...raw.columns, description: raw.columns.description || [] } };
    try {
      const template = extractors.validateTemplate(t);
      personalFree(template);
      const result = await run(template);
      if (!result.transactions.length) throw fail('o modelo não encontrou nenhum lançamento');
      return { template, result };
    } catch (e) {
      feedback = cleanSpaces(e.message).slice(0, 300);
      if (attempt === 1) throw fail(`A IA não conseguiu criar um leitor que funcione: ${feedback}`, 422);
    }
  }
}

module.exports = { generate, mask };
