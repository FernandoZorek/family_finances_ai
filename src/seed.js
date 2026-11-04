const { db } = require('./db');

// [nome, tipo, ícone]
const CATEGORIES = [
  ['Mercado', 'despesa', '🛒'],
  ['Restaurantes e delivery', 'despesa', '🍽️'],
  ['Transporte', 'despesa', '🚗'],
  ['Veículo', 'despesa', '🔧'],
  ['Moradia', 'despesa', '🏠'],
  ['Contas da casa', 'despesa', '💡'],
  ['Assinaturas', 'despesa', '📺'],
  ['Compras', 'despesa', '🛍️'],
  ['Saúde', 'despesa', '💊'],
  ['Cuidados pessoais', 'despesa', '💈'],
  ['Igreja e doações', 'despesa', '⛪'],
  ['Lazer', 'despesa', '🎉'],
  ['Educação', 'despesa', '📚'],
  ['Seguros', 'despesa', '🛡️'],
  ['Trabalho / empresa', 'despesa', '💼'],
  ['Tarifas e juros', 'despesa', '🏦'],
  ['Fatura de cartão sem detalhe', 'despesa', '💳'],
  ['Impostos e taxas', 'despesa', '🧾'],
  ['PIX e transferências a terceiros', 'despesa', '↗️'],
  ['Outros', 'despesa', '•'],
  ['Salário e pró-labore', 'receita', '💰'],
  ['Rendimentos', 'receita', '📈'],
  ['Reembolsos e estornos', 'receita', '↩️'],
  ['Vendas e serviços (MEI)', 'receita', '🧁'],
  ['Outras receitas', 'receita', '➕'],
  ['Pagamento de fatura', 'neutra', '💳'],
  ['Transferência interna', 'neutra', '🔁'],
  ['Salário líquido (detalhado no holerite)', 'neutra', '💰'],
];

// Padrões "contém" (sem acento, maiúsculas). Ordem de prioridade: maior primeiro.
const RULES = [
  // neutras (não entram em receita/despesa)
  ['FATURA UNICLASS', 'Pagamento de fatura', 50],
  ['PAGTO ELETRON COBRANCA BANCO BRADESCO', 'Pagamento de fatura', 50],
  ['PIX QR CODE ESTATICO DES: MERCADO PAGO', 'Pagamento de fatura', 50],
  ['PAGAMENTO DE FATURA', 'Pagamento de fatura', 50],
  ['PAGTO FATURA', 'Pagamento de fatura', 50],
  ['BAIXA AUTOMAT POUPANCA', 'Transferência interna', 50],
  ['APLICACAO POUPANCA', 'Transferência interna', 50],
  ['RESGATE', 'Transferência interna', 20],
  // receitas
  ['SALARIO', 'Salário e pró-labore', 40],
  ['PROVENTOS', 'Salário e pró-labore', 30],
  ['RENTAB.INVEST', 'Rendimentos', 40],
  ['REND PAGO', 'Rendimentos', 40],
  ['RENDIMENTO', 'Rendimentos', 30],
  ['CREDITO CONCEDIDO', 'Reembolsos e estornos', 40],
  ['CONTESTAC', 'Reembolsos e estornos', 40],
  ['ESTORNO', 'Reembolsos e estornos', 40],
  // moradia e contas
  ['PRESTACAO DE CRED IMOB', 'Moradia', 40],
  ['CONDOMINIO', 'Moradia', 30],
  ['ALUGUEL', 'Moradia', 20],
  // concessionárias e telefonia (nacionais)
  ['ENERGIA', 'Contas da casa', 25],
  ['SANEAMENTO', 'Contas da casa', 25],
  ['ENEL', 'Contas da casa', 30],
  ['CEMIG', 'Contas da casa', 30],
  ['CPFL', 'Contas da casa', 30],
  ['LIGHT S', 'Contas da casa', 30],
  ['NEOENERGIA', 'Contas da casa', 30],
  ['EQUATORIAL', 'Contas da casa', 30],
  ['COPEL', 'Contas da casa', 30],
  ['CELESC', 'Contas da casa', 30],
  ['SABESP', 'Contas da casa', 30],
  ['SANEPAR', 'Contas da casa', 30],
  ['CEDAE', 'Contas da casa', 30],
  ['COMGAS', 'Contas da casa', 30],
  ['TIM ', 'Contas da casa', 20],
  ['OI FIBRA', 'Contas da casa', 25],
  ['NET SERVICOS', 'Contas da casa', 25],
  ['VIVO', 'Contas da casa', 20],
  ['CLARO', 'Contas da casa', 20],
  // veículo e transporte
  ['FINANC VEIC', 'Veículo', 40],
  ['BORRACHARIA', 'Veículo', 30],
  ['UBER', 'Transporte', 30],
  ['99*', 'Transporte', 25],
  ['99 POP', 'Transporte', 25],
  ['POSTO ', 'Transporte', 25],
  ['SHELL', 'Transporte', 20],
  ['IPIRANGA', 'Transporte', 20],
  ['ESTAPAR', 'Transporte', 20],
  // alimentação
  ['99FOOD', 'Restaurantes e delivery', 35],
  ['IFOOD', 'Restaurantes e delivery', 35],
  ['RESTAURANTE', 'Restaurantes e delivery', 30],
  ['PIZZ', 'Restaurantes e delivery', 30],
  ['LANCHONETE', 'Restaurantes e delivery', 30],
  ['BURGER', 'Restaurantes e delivery', 25],
  ['CONFEITARIA', 'Mercado', 30],
  ['SUPERMERC', 'Mercado', 25],
  ['MERCEARIA', 'Mercado', 25],
  ['ATACADAO', 'Mercado', 25],
  ['HORTIFRUTI', 'Mercado', 25],
  ['PADARIA', 'Mercado', 25],
  // saúde e cuidados
  ['PANVEL', 'Saúde', 30],
  ['DENTAL', 'Saúde', 30],
  ['DROGA', 'Saúde', 25],
  ['FARMA', 'Saúde', 25],
  ['UNIMED', 'Saúde', 30],
  ['BARBEARIA', 'Cuidados pessoais', 30],
  ['BARBER', 'Cuidados pessoais', 30],
  ['SALAO', 'Cuidados pessoais', 20],
  // igreja
  // lazer, assinaturas, trabalho
  ['AMAZON PRIME', 'Assinaturas', 35],
  ['GOOGLE PREMIE', 'Assinaturas', 35],
  ['MELIMAIS', 'Assinaturas', 35],
  ['NETFLIX', 'Assinaturas', 35],
  ['SPOTIFY', 'Assinaturas', 35],
  ['DISNEY', 'Assinaturas', 30],
  ['HBO', 'Assinaturas', 30],
  ['FACEBK', 'Trabalho / empresa', 35],
  ['HETZNER', 'Trabalho / empresa', 35],
  ['GOOGLE CLOUD', 'Trabalho / empresa', 36],
  ['SEGURO', 'Seguros', 25],
  ['TARIFA', 'Tarifas e juros', 35],
  ['IOF', 'Tarifas e juros', 35],
  ['JUROS', 'Tarifas e juros', 30],
  ['ANUIDADE', 'Tarifas e juros', 30],
  // compras
  ['MERCADOLIVRE', 'Compras', 30],
  ['MERCADOPAGO*', 'Compras', 25],
  ['MP*', 'Compras', 20],
  ['MP *', 'Compras', 20],
  ['AMAZON MARKETP', 'Compras', 30],
  ['AMAZONMKTPLC', 'Compras', 30],
  ['SHOPEE', 'Compras', 30],
  ['DISTRIBUIDORA', 'Compras', 15],
  // genéricos de conta
  ['PIX ENVIADO', 'PIX e transferências a terceiros', 5],
  ['PIX RECEBIDO', 'Outras receitas', 5],
];

// Regras acrescentadas depois da primeira versão: entram uma única vez em bancos já existentes
const RULES_V2 = [
  ['CONTA SALARIO', 'Salário e pró-labore', 45],
  ['LIBERACAO DE DINHEIRO', 'Vendas e serviços (MEI)', 40],
  ['PAGAMENTO COM CODIGO QR', 'Vendas e serviços (MEI)', 30],
  ['DINHEIRO RESERVADO', 'Transferência interna', 50],
  ['DINHEIRO RETIRADO', 'Transferência interna', 50],
  ['MINISTERIO DA FAZENDA', 'Impostos e taxas', 40],
  ['MUNICIPIO DE', 'Impostos e taxas', 35],
  ['RECEITA FEDERAL', 'Impostos e taxas', 35],
  ['DETRAN', 'Veículo', 35],
  ['NIC .BR', 'Trabalho / empresa', 35],
  ['NIC.BR', 'Trabalho / empresa', 35],
  ['CONDOMINIAL', 'Moradia', 35],
  ['HAVAN', 'Compras', 30],
  ['BOTICARIO', 'Cuidados pessoais', 30],
  ['AMAZON SERVICOS', 'Compras', 30],
  ['PARKING', 'Transporte', 30],
  ['ESTACIONAMENTO', 'Transporte', 30],
  ['COLEGIO', 'Educação', 30],
  ['ESCOLA', 'Educação', 25],
  ['CACAU SHOW', 'Mercado', 30],
];

// Holerite: bruto como receita e cada desconto em folha na categoria do que ele paga
// Conta PJ: impostos e contabilidade
const RULES_V4 = [
  ['SIMPLES NACIONAL', 'Impostos e taxas', 40],
  ['DARF', 'Impostos e taxas', 40],
  ['CONTABILIZEI', 'Trabalho / empresa', 40],
];

const RULES_V3 = [
  ['SALARIO BRUTO', 'Salário e pró-labore', 50],
  ['MENSALIDADE ESCOLAR', 'Educação', 40],
  ['DESCONTO DE CANTINA', 'Educação', 40],
  ['DESPESAS MEDICAS', 'Saúde', 40],
  ['COPARTICIPACAO', 'Saúde', 40],
  ['PLANO DE SAUDE', 'Saúde', 35],
  ['ODONTO', 'Saúde', 30],
  ['I.N.S.S', 'Impostos e taxas', 40],
  ['INSS', 'Impostos e taxas', 35],
  ['IRRF', 'Impostos e taxas', 35],
  ['VALE TRANSPORTE', 'Transporte', 35],
  ['DESCONTO EM FOLHA', 'Outros', 10],
];

const NATURE = {
  essencial: ['Mercado', 'Moradia', 'Contas da casa', 'Transporte', 'Veículo', 'Saúde', 'Planos', 'Educação', 'Seguros', 'Impostos e taxas', 'Igreja e doações'],
  conforto: ['Restaurantes e delivery', 'Assinaturas', 'Compras', 'Lazer', 'Cuidados pessoais', 'Esporte', 'Cabelo/Barba'],
};

function seed() {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  // categoria renomeada pelo usuário continua sendo achada pela key (não é recriada)
  const hasKey = db.prepare('SELECT id FROM categories WHERE key = ?');
  const adopt = db.prepare('UPDATE categories SET key = ? WHERE name = ? AND key IS NULL');
  const insCat = db.prepare('INSERT OR IGNORE INTO categories (name, kind, icon, sort, key) VALUES (?, ?, ?, ?, ?)');
  CATEGORIES.forEach(([name, kind, icon], i) => {
    if (hasKey.get(name)) return;
    adopt.run(name, name);
    if (!hasKey.get(name)) insCat.run(name, kind, icon, i, name);
  });
  const fixSort = db.prepare('UPDATE categories SET sort = ? WHERE key = ?');
  CATEGORIES.forEach(([name], i) => fixSort.run(i, name));

  const catId = db.prepare('SELECT id FROM categories WHERE key = ? OR name = ? ORDER BY key = ? DESC LIMIT 1');
  const insRule = db.prepare("INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, ?, ?, 'padrao')");
  const addRules = (list) => {
    for (const [pattern, cat, prio] of list) insRule.run(pattern, catId.get(cat, cat, cat).id, prio);
  };
  const getVersion = () => Number(db.prepare("SELECT value FROM meta WHERE key = 'rules_version'").get()?.value || 0);
  const setVersion = (v) => db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('rules_version', ?)").run(String(v));

  const before = getVersion();
  db.transaction(() => {
    let v = getVersion();
    if (v === 0) {
      const count = db.prepare("SELECT COUNT(*) c FROM rules WHERE source = 'padrao'").get().c;
      if (count === 0) addRules(RULES);
      v = 1;
    }
    if (v < 2) {
      addRules(RULES_V2);
      v = 2;
    }
    if (v < 3) {
      addRules(RULES_V3);
      v = 3;
    }
    if (v < 4) {
      addRules(RULES_V4);
      v = 4;
    }
    setVersion(v);
  })();
  // Categoria interna da renda líquida (não aparece nas listas de escolha)
  db.prepare("INSERT OR IGNORE INTO categories (name, kind, icon, sort, key) SELECT 'Custos da renda', 'receita', '➖', 999, 'Custos da renda' WHERE NOT EXISTS (SELECT 1 FROM categories WHERE key = 'Custos da renda')").run();
  // Essencial / conforto, uma vez só (depois quem manda é o usuário em Ajustes)
  if (!db.prepare("SELECT 1 FROM meta WHERE key = 'nature_version'").get()) {
    const setNature = db.prepare('UPDATE categories SET nature = ? WHERE COALESCE(key, name) = ? AND nature IS NULL');
    for (const n of NATURE.essencial) setNature.run('essencial', n);
    for (const n of NATURE.conforto) setNature.run('conforto', n);
    db.prepare("INSERT INTO meta (key, value) VALUES ('nature_version', '1')").run();
  }
  return before > 0 && getVersion() > before;
}

module.exports = { seed };
