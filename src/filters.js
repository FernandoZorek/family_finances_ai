// Filtros do painel: fontes de renda (desmarcar uma tira a entrada e as despesas ligadas a ela),
// renda bruta/líquida (líquida: despesas ligadas à renda viram desconto da receita, na categoria "Custos da renda")
// e tipo de despesa (essencial / conforto / outras)
const { db } = require('./db');
const { normalize } = require('./categorize');

const flat = (s) => normalize(s || '').replace(/ /g, '');

// matchers: [{ t: 'account' | 'pattern' | 'category', v }]
function loadSources() {
  return db
    .prepare('SELECT * FROM income_sources ORDER BY sort, id')
    .all()
    .map((s) => ({ ...s, matchers: JSON.parse(s.matchers || '[]') }));
}

// A qual fonte o lançamento pertence (a primeira que casar; dono da fonte precisa bater)
function sourceOf(tx, sources) {
  const desc = flat(tx.description);
  const pat = flat(tx.pattern);
  const account = normalize(tx.account || '');
  for (const s of sources) {
    if (s.owner_id && tx.owner_id !== s.owner_id) continue;
    for (const m of s.matchers) {
      if (m.t === 'category' && Number(m.v) === tx.category_id) return s.id;
      if (m.t === 'account' && account.startsWith(normalize(m.v))) return s.id;
      if (m.t === 'pattern') {
        const v = flat(m.v);
        if (v.length >= 3 && (desc.includes(v) || (pat && pat.includes(v)))) return s.id;
      }
    }
  }
  return null;
}

// Estado do filtro da requisição em curso (better-sqlite3 é síncrono: uma por vez)
let active = null;

function makeFilter(q) {
  const exclude = new Set(String(q.exclude || '').split(',').map(Number).filter(Boolean));
  const nature = ['essencial', 'conforto', 'outras'].includes(q.nature) ? q.nature : null;
  const liquid = q.liquid === '1';
  if (!exclude.size && !nature && !liquid) return null;
  const cats = Object.fromEntries(db.prepare('SELECT id, kind, nature, key FROM categories').all().map((c) => [c.id, c]));
  const costCat = Object.values(cats).find((c) => c.key === COST_KEY)?.id || null;
  return { exclude, nature, liquid: liquid && costCat, costCat, cats, sources: exclude.size || liquid ? loadSources() : [] };
}

const COST_KEY = 'Custos da renda';

// Despesa que existe por causa de uma renda (impostos, contador, descontos em folha, custos de trabalho)
function isIncomeCost(tx, f = active) {
  return Boolean(f && f.liquid && f.cats[tx.category_id]?.kind === 'despesa' && sourceOf(tx, f.sources));
}
// Categoria usada no painel: na renda líquida, custo da renda vira "Custos da renda" (receita negativa)
const mapCat = (tx, f = active) => (isIncomeCost(tx, f) ? f.costCat : tx.category_id);

function keep(tx, f = active) {
  if (!f) return true;
  const c = f.cats[tx.category_id];
  // custo da renda na renda líquida já é desconto da receita: o filtro de tipo de despesa não se aplica
  if (f.nature && c && c.kind === 'despesa' && (c.nature || 'outras') !== f.nature && !isIncomeCost(tx, f)) return false;
  if (f.exclude.size) {
    const s = sourceOf(tx, f.sources);
    if (s && f.exclude.has(s)) return false;
  }
  return true;
}

db.function('keep_tx', { deterministic: false }, (owner_id, category_id, description, account, pattern) =>
  keep({ owner_id, category_id, description, account, pattern }) ? 1 : 0
);
db.function('map_cat', { deterministic: false }, (owner_id, category_id, description, account, pattern) =>
  mapCat({ owner_id, category_id, description, account, pattern })
);

// Roda fn com o filtro da query ativo; SQL usa FILTER_SQL, JS usa keep()
function withFilter(q, fn) {
  active = makeFilter(q);
  try {
    return fn(active);
  } finally {
    active = null;
  }
}
// t.orig_cat: categoria original (antes de virar "Custos da renda"), para a fonte de renda casar pela categoria
const FILTER_SQL = 'AND keep_tx(t.owner_id, t.orig_cat, t.description, t.account, t.pattern) = 1';
// coluna de categoria do src: na renda líquida, custos da renda vão para "Custos da renda"
const CAT_SQL = (cat = 'category_id', desc = 'description', account = 'account', pattern = 'NULL', owner = 'owner_id') =>
  `map_cat(${owner}, ${cat}, ${desc}, ${account}, ${pattern})`;

module.exports = { loadSources, sourceOf, withFilter, keep, isIncomeCost, FILTER_SQL, CAT_SQL, COST_KEY };
