// Lançamentos: lista/busca, CSV, lançamento manual, edição e "iguais em outros meses"
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');
const { recategorizeAll, normalize, similarKey, rulePatternFor, sameKey } = require('../categorize');
const { channelOf, loadChannelCtx } = require('../channel');
const { projectedRows } = require('../projections');

const router = express.Router();

// ---------- lançamentos ----------
// "1.311,95", "1311,95", "R$ 50", "50" -> { value, cents }
function searchValue(text) {
  const t = String(text).replace(/R\$/i, '').replace(/\s/g, '').replace(/^-/, '');
  if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d{1,2})?$/.test(t) && !/^\d+\.\d{1,2}$/.test(t)) return null;
  const cents = /[,]\d{1,2}$/.test(t) || /^\d+\.\d{1,2}$/.test(t);
  const value = /^\d+\.\d{1,2}$/.test(t) ? Number(t) : Number(t.replace(/\./g, '').replace(',', '.'));
  return value > 0 ? { value: cents ? value : Math.trunc(value), cents } : null;
}

function filters(q) {
  const where = [];
  const params = {};
  if (q.month && /^\d{4}-\d{2}$/.test(q.month)) where.push('t.ref_month = @month'), (params.month = q.month);
  if (q.owner && q.owner !== 'all') where.push('t.owner_id = @owner'), (params.owner = Number(q.owner));
  if (q.category) where.push('(t.category_id = @category OR c.parent_id = @category)'), (params.category = Number(q.category));
  if (q.account) where.push('t.account = @account'), (params.account = q.account);
  if (q.type === 'despesa') where.push("c.kind = 'despesa'");
  if (q.type === 'receita') where.push("c.kind = 'receita'");
  if (q.type === 'ignorados') where.push('t.ignored = 1');
  else if (q.ignored !== '1') where.push('t.ignored = 0');
  if (q.q) {
    const v = searchValue(q.q);
    // número na busca: acha também pelo valor (com centavos = exato; sem centavos = aquele real inteiro)
    if (v) where.push(`(t.description LIKE @q OR ${v.cents ? 'ABS(ABS(t.amount) - @v) < 0.005' : 'CAST(ABS(t.amount) AS INTEGER) = @v'})`), (params.v = v.value);
    else where.push('t.description LIKE @q');
    params.q = `%${q.q}%`;
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const TX_SELECT = `SELECT t.id, t.date, t.ref_month, t.description, t.amount, t.account, t.kind, t.holder, t.installment,
  t.category_id, t.category_locked, t.ignored, t.is_payment, t.note, t.owner_id, t.import_id, t.channel,
  c.name AS category, c.icon, c.kind AS category_kind, u.name AS owner
  FROM transactions t LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN users u ON u.id = t.owner_id`;

router.get('/transactions', (req, res) => {
  const f = filters(req.query);
  const cctx = loadChannelCtx();
  let rows = db.prepare(`${TX_SELECT} ${f.sql} ORDER BY t.date DESC, t.id DESC LIMIT 2000`).all(f.params);
  // online / presencial (só compras de cartão; a parcela prevista herda a compra original)
  const withChannel = (list) => {
    for (const r of list) {
      const c = channelOf(r, cctx);
      if (c) (r.channel = c.channel), (r.channel_how = c.how);
    }
    return ['online', 'presencial'].includes(req.query.channel) ? list.filter((r) => r.channel === req.query.channel) : list;
  };
  rows = withChannel(rows);
  // Lançamentos futuros previstos (parcelas de cartão a vencer e recorrentes), fora quando pedem só ignorados
  if (req.query.projected === '0' || req.query.type === 'ignorados') return res.json(rows);
  const q = req.query;
  const cat = q.category ? Number(q.category) : null;
  const parentOf = Object.fromEntries(db.prepare('SELECT id, parent_id FROM categories').all().map((c) => [c.id, c.parent_id]));
  const needle = q.q ? normalize(q.q) : null;
  const sv = q.q ? searchValue(q.q) : null;
  const valueHit = (a) => sv && (sv.cents ? Math.abs(Math.abs(a) - sv.value) < 0.005 : Math.trunc(Math.abs(a)) === sv.value);
  const proj = projectedRows(q.owner && q.owner !== 'all' ? Number(q.owner) : null).filter(
    (r) =>
      (!q.month || r.ref_month === q.month) &&
      (!cat || r.category_id === cat || parentOf[r.category_id] === cat) &&
      (q.type !== 'despesa' || r.category_kind === 'despesa') &&
      (q.type !== 'receita' || r.category_kind === 'receita') &&
      (!needle || normalize(r.description).includes(needle) || valueHit(r.amount))
  );
  res.json([...withChannel(proj), ...rows].sort((a, b) => b.date.localeCompare(a.date)));
});

router.get('/transactions.csv', (req, res) => {
  const f = filters(req.query);
  const rows = db.prepare(`${TX_SELECT} ${f.sql} ORDER BY t.date, t.id`).all(f.params);
  // aspas duplicadas; texto que começa com = + - @ vira fórmula na planilha: prefixa ' (CSV injection)
  const esc = (v) => {
    const s = String(v ?? '');
    return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  };
  const lines = ['data;mes_referencia;descricao;valor;categoria;pessoa;conta;parcela;ignorado'];
  for (const r of rows) {
    lines.push(
      [r.date.split('-').reverse().join('/'), r.ref_month, esc(r.description), r.amount.toFixed(2).replace('.', ','), esc(r.category), esc(r.owner), esc(r.account), r.installment || '', r.ignored ? 'sim' : 'não'].join(';')
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : 'todos';
  res.setHeader('Content-Disposition', `attachment; filename="lancamentos-${month}.csv"`);
  res.send('﻿' + lines.join('\n'));
});

router.post('/transactions', (req, res) => {
  const { date, description, amount, type, category_id, owner_id } = req.body || {};
  const v = Math.abs(Number(String(amount).replace(/\./g, '').replace(',', '.')));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !description || !v) return res.status(400).json({ error: 'Preencha data, descrição e valor.' });
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(category_id);
  if (!cat) return res.status(400).json({ error: 'Escolha a categoria.' });
  const owner = owner_id ? Number(owner_id) : req.user.id;
  if (!userExists(owner)) return res.status(400).json({ error: 'Pessoa inválida.' });
  const signed = type === 'receita' ? v : -v;
  const id = db
    .prepare(`INSERT INTO transactions (owner_id, date, ref_month, description, amount, account, kind, category_id, category_locked, ignored, hash)
              VALUES (?, ?, ?, ?, ?, 'Manual', 'manual', ?, 1, ?, ?)`)
    .run(owner, date, date.slice(0, 7), String(description).trim().slice(0, 200), signed, cat.id, cat.kind === 'neutra' ? 1 : 0, crypto.randomUUID())
    .lastInsertRowid;
  res.json({ id });
});

const userExists = (id) => Boolean(db.prepare('SELECT 1 FROM users WHERE id = ?').get(Number(id)));

// Mesmo lançamento em outros meses (descrição igual sem números, mesmo sentido do valor)
function similarTo(t) {
  const key = sameKey(t.description);
  if (key.length < 3) return [];
  return db
    .prepare('SELECT id, date, description, amount, category_id FROM transactions WHERE id != ? AND (amount < 0) = (? < 0)')
    .all(t.id, t.amount)
    .filter((r) => sameKey(r.description) === key);
}

router.get('/transactions/:id/similar', (req, res) => {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Lançamento não encontrado.' });
  const list = similarTo(t);
  res.json({
    before: list.filter((r) => r.date < t.date || (r.date === t.date && r.id < t.id)).length,
    after: list.filter((r) => r.date > t.date || (r.date === t.date && r.id > t.id)).length,
    pattern: rulePatternFor(t.description),
  });
});

router.patch('/transactions/:id', (req, res) => {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Lançamento não encontrado.' });
  const b = req.body || {};
  const out = { ok: true, changed: 0 };
  if (b.category_id !== undefined) {
    const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(b.category_id);
    if (!cat) return res.status(400).json({ error: 'Categoria inválida.' });
    const setCat = db.prepare('UPDATE transactions SET category_id = ?, category_locked = 1, ignored = ? WHERE id = ?');
    const ign = cat.kind === 'neutra' ? 1 : 0;
    // apply_to: 'only' | 'before' | 'after' | 'all' (anteriores/posteriores do mesmo lançamento)
    const scope = ['before', 'after', 'all'].includes(b.apply_to) ? b.apply_to : 'only';
    db.transaction(() => {
      setCat.run(cat.id, ign, t.id);
      if (scope !== 'only') {
        for (const r of similarTo(t)) {
          const isBefore = r.date < t.date || (r.date === t.date && r.id < t.id);
          if (scope === 'all' || (scope === 'before') === isBefore) {
            setCat.run(cat.id, ign, r.id);
            out.changed++;
          }
        }
      }
    })();
    // Posteriores/todos: vale também para os próximos arquivos importados
    if (scope === 'after' || scope === 'all') {
      const p = String(b.rule_pattern || rulePatternFor(t.description)).trim();
      if (p.length >= 3) {
        db.prepare("DELETE FROM rules WHERE source = 'usuario' AND pattern = ?").run(p);
        db.prepare("INSERT INTO rules (pattern, category_id, priority, source) VALUES (?, ?, 100, 'usuario')").run(p, cat.id);
        out.changed += recategorizeAll();
        out.rule = p;
      }
    }
  }
  if (b.channel !== undefined) {
    const ch = ['online', 'presencial'].includes(b.channel) ? b.channel : null;
    const key = similarKey(t.description).replace(/ /g, '');
    if (b.channel_all && key.length >= 3) {
      // vale para todas as compras desta loja (e as próximas importadas): regra + limpa correções avulsas
      if (ch) db.prepare('INSERT OR REPLACE INTO channel_rules (pattern, channel) VALUES (?, ?)').run(key, ch);
      else db.prepare('DELETE FROM channel_rules WHERE pattern = ?').run(key);
      const same = db.prepare("SELECT id, description FROM transactions WHERE kind = 'cartao'").all().filter((r) => similarKey(r.description).replace(/ /g, '') === key);
      const clr = db.prepare('UPDATE transactions SET channel = NULL WHERE id = ?');
      for (const r of same) clr.run(r.id);
      out.changed += same.length - 1;
    } else db.prepare('UPDATE transactions SET channel = ? WHERE id = ?').run(ch, t.id);
  }
  if (b.owner_id !== undefined) {
    if (!userExists(b.owner_id)) return res.status(400).json({ error: 'Pessoa inválida.' });
    db.prepare('UPDATE transactions SET owner_id = ? WHERE id = ?').run(Number(b.owner_id), t.id);
  }
  if (b.ignored !== undefined) db.prepare('UPDATE transactions SET ignored = ?, category_locked = 1 WHERE id = ?').run(b.ignored ? 1 : 0, t.id);
  if (b.note !== undefined) db.prepare('UPDATE transactions SET note = ? WHERE id = ?').run(String(b.note).slice(0, 500), t.id);
  if (b.description !== undefined && String(b.description).trim()) db.prepare('UPDATE transactions SET description = ? WHERE id = ?').run(String(b.description).trim().slice(0, 200), t.id);
  res.json(out);
});

router.delete('/transactions/:id', (req, res) => {
  const t = db.prepare('SELECT kind FROM transactions WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'Lançamento não encontrado.' });
  if (t.kind !== 'manual') return res.status(400).json({ error: 'Só lançamentos manuais podem ser excluídos. Para importados, marque como ignorado.' });
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = { router, searchValue, similarTo };
