// Impostos do mês: diretos (aparecem no extrato), contador e embutidos nos preços.
// Embutidos são ESTIMATIVA: carga média aproximada por categoria (editável em Ajustes) e exceções pelo nome
// da compra (combustível, farmácia, eletrônicos, financiamento). Não é dado de nota fiscal.
const { normalize } = require('./categorize');

// Carga média aproximada por categoria (fração do preço). Estimativa inicial; o usuário ajusta.
const DEFAULT_RATES = {
  Mercado: 0.22,
  'Restaurantes e delivery': 0.32,
  Transporte: 0.2,
  'Veículo': 0.38,
  Moradia: 0,
  'Contas da casa': 0.4,
  Assinaturas: 0.25,
  Compras: 0.35,
  'Saúde': 0.15,
  'Cuidados pessoais': 0.35,
  'Igreja e doações': 0,
  Lazer: 0.3,
  'Educação': 0.15,
  Seguros: 0.1,
  'Trabalho / empresa': 0.15,
  'Tarifas e juros': 0.1,
  'Fatura de cartão sem detalhe': 0.3,
  'PIX e transferências a terceiros': 0,
  Outros: 0.2,
  Reforma: 0.4,
  Esporte: 0.15,
  'Cabelo/Barba': 0.15,
  Planos: 0.1,
};

// Pelo nome da compra, antes da categoria
const OVERRIDES = [
  { re: /POSTO|COMBUST|GASOLINA|SHELL|IPIRANGA|PETROBRAS|BR MANIA|AUTO ?POSTO/, rate: 0.38, label: 'Combustível' },
  { re: /FARMAC|DROGA|PANVEL|RAIA|NISSEI|PAGUE MENOS|DROGASIL|UNIPRECO/, rate: 0.31, label: 'Farmácia' },
  { re: /KABUM|FAST ?SHOP|SAMSUNG|MOTOROLA|DELL|LENOVO|ELECTROLU|PONTO ?FRIO|CASAS ?BAHIA|MAGAZINE|MAGALU/, rate: 0.4, label: 'Eletrônicos e eletrodomésticos' },
  // financiamento habitacional (SFH) não tem IOF; o de veículo tem IOF (~3%) diluído nas parcelas
  { re: /CRED\s*IMOB|HABITA|PRESTACAO DE CRED/, rate: 0, label: 'Financiamento imobiliário' },
  { re: /FINANC\s*VEIC|FINANCIAMENTO.*(CARRO|VEIC)/, rate: 0.03, label: 'Financiamento de veículo (IOF)' },
];
const CONTADOR = /CONTABILIZEI|CONTABIL|CONTADOR/;
const DIRECT_DESC = /\bIOF\b|DARF|SIMPLES NACIONAL|I\.?N\.?S\.?S|IRRF|IPVA|IPTU|LICENCIAMENTO|DETRAN|MINISTERIO DA FAZENDA|MUNICIPIO DE|RECEITA FEDERAL/;

// rows: { description, amount (<0), cat: { name, key, tax_rate } } -> resumo
function taxSummary(rows) {
  const out = { direct: 0, accountant: 0, indirect: 0, items: { direct: {}, accountant: {}, indirect: {} } };
  const add = (bucket, label, v, base, rate) => {
    const it = (out.items[bucket][label] ??= { label, value: 0, base: 0, rate: rate ?? null });
    it.value += v;
    it.base += base;
    out[bucket] += v;
  };
  for (const r of rows) {
    const v = -r.amount;
    if (!(v > 0) || !r.cat) continue;
    const d = normalize(r.description);
    const key = r.cat.key || r.cat.name;
    if (CONTADOR.test(d)) add('accountant', 'Contador', v, v);
    else if (key === 'Impostos e taxas' || DIRECT_DESC.test(d)) add('direct', r.description.replace(/\s+\d{2}\/\d{2}$/, '').slice(0, 40), v, v);
    else {
      const o = OVERRIDES.find((x) => x.re.test(d));
      const rate = o ? o.rate : r.cat.tax_rate ?? DEFAULT_RATES[key] ?? 0.2;
      if (rate > 0) add('indirect', o ? o.label : r.cat.name, v * rate, v, rate);
    }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  const list = (o) => Object.values(o).map((x) => ({ ...x, value: r2(x.value), base: r2(x.base) })).sort((a, b) => b.value - a.value);
  return {
    total: r2(out.direct + out.accountant + out.indirect),
    direct: r2(out.direct),
    accountant: r2(out.accountant),
    indirect: r2(out.indirect),
    items: { direct: list(out.items.direct), accountant: list(out.items.accountant), indirect: list(out.items.indirect) },
  };
}

module.exports = { taxSummary, DEFAULT_RATES, OVERRIDES };
