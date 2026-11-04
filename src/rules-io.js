// Exportar/importar regras (de/para) e as categorias que elas usam, em JSON.
// Serve para levar as regras de uma instalação para outra sem colocá-las no código.
const { db } = require('./db');

const FORMAT = 'family-finances/rules';
const SOURCES = ['usuario', 'padrao', 'ia'];

function exportRules() {
  const cats = db.prepare('SELECT id, name, kind, icon, parent_id, nature, tax_rate, key FROM categories').all();
  const byId = new Map(cats.map((c) => [c.id, c]));
  return {
    format: FORMAT,
    version: 1,
    exported_at: new Date().toISOString(),
    categories: cats
      .filter((c) => c.key !== 'Custos da renda')
      .map((c) => ({ name: c.name, kind: c.kind, icon: c.icon, parent: byId.get(c.parent_id)?.name || null, nature: c.nature, tax_rate: c.tax_rate })),
    rules: db
      .prepare('SELECT r.pattern, r.priority, r.source, r.account, c.name AS category FROM rules r JOIN categories c ON c.id = r.category_id ORDER BY r.source, r.pattern')
      .all()
      .map((r) => ({ pattern: r.pattern, category: r.category, priority: r.priority, source: r.source, ...(r.account ? { account: r.account } : {}) })),
  };
}

const str = (v, max) => String(v ?? '').trim().slice(0, max);

// Mescla: cria categorias que faltam (pelo nome), cria regras novas e atualiza a categoria das que já existem
// (mesmo texto + conta + origem). Nada é apagado.
function importRules(data) {
  if (!data || data.format !== FORMAT || !Array.isArray(data.rules) || !Array.isArray(data.categories || [])) {
    throw Object.assign(new Error('Arquivo inválido: use um JSON exportado pelo Family Finances.'), { status: 400 });
  }
  if (data.rules.length > 5000 || (data.categories || []).length > 500) throw Object.assign(new Error('Arquivo grande demais.'), { status: 400 });
  const out = { categories_created: 0, rules_created: 0, rules_updated: 0, skipped: 0 };
  const findCat = db.prepare('SELECT id, kind FROM categories WHERE lower(name) = lower(?)');
  db.transaction(() => {
    for (const c of data.categories || []) {
      const name = str(c.name, 60);
      if (!name || !['despesa', 'receita', 'neutra'].includes(c.kind) || findCat.get(name)) continue;
      const rate = c.tax_rate === null || c.tax_rate === undefined ? null : Number(c.tax_rate);
      db.prepare('INSERT INTO categories (name, kind, icon, sort, nature, tax_rate) VALUES (?, ?, ?, 90, ?, ?)').run(
        name,
        c.kind,
        str(c.icon, 16) || '•',
        ['essencial', 'conforto'].includes(c.nature) ? c.nature : null,
        rate >= 0 && rate <= 0.9 ? rate : null
      );
      out.categories_created++;
    }
    // grupos (um nível só, mesmo tipo), depois de todas existirem
    for (const c of data.categories || []) {
      if (!c.parent) continue;
      const child = findCat.get(str(c.name, 60));
      const parent = findCat.get(str(c.parent, 60));
      if (child && parent && child.id !== parent.id && child.kind === parent.kind) {
        db.prepare('UPDATE categories SET parent_id = ? WHERE id = ? AND parent_id IS NULL AND NOT EXISTS (SELECT 1 FROM categories WHERE parent_id = ?)').run(parent.id, child.id, child.id);
      }
    }
    const find = db.prepare('SELECT id, category_id FROM rules WHERE pattern = ? AND COALESCE(account, \'\') = ? AND source = ?');
    for (const r of data.rules) {
      // texto exato: espaço no fim é proposital ("POSTO ", "TIM ")
      const pattern = String(r.pattern ?? '').slice(0, 80);
      const cat = findCat.get(str(r.category, 60));
      const source = SOURCES.includes(r.source) ? r.source : 'usuario';
      const account = str(r.account, 80);
      if (pattern.trim().length < 3 || !cat) {
        out.skipped++;
        continue;
      }
      const priority = Number.isInteger(r.priority) && r.priority >= 0 && r.priority <= 100 ? r.priority : source === 'usuario' ? 100 : 30;
      const ex = find.get(pattern, account, source);
      if (ex) {
        if (ex.category_id !== cat.id) db.prepare('UPDATE rules SET category_id = ? WHERE id = ?').run(cat.id, ex.id), out.rules_updated++;
      } else {
        db.prepare('INSERT INTO rules (pattern, category_id, priority, source, account) VALUES (?, ?, ?, ?, ?)').run(pattern, cat.id, priority, source, account || null);
        out.rules_created++;
      }
    }
  })();
  return out;
}

module.exports = { exportRules, importRules };
