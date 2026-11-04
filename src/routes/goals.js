// Metas de gasto por categoria e insights por IA
const express = require('express');
const { budgetsFor, suggestions, setBudget } = require('../budgets');
const insights = require('../insights');

const router = express.Router();
const ownerOf = (q) => (q.owner && q.owner !== 'all' ? Number(q.owner) : null);
const monthOf = (q) => (/^\d{4}-\d{2}$/.test(q.month || '') ? q.month : undefined);
const fail = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : 'Erro interno.' });

router.get('/budgets', (req, res) => res.json(budgetsFor(monthOf(req.query), ownerOf(req.query))));
router.get('/budgets/suggestions', (req, res) => res.json(suggestions(monthOf(req.query), ownerOf(req.query))));

// { items: [{ category_id, monthly_limit }] } — limite vazio/0 remove a meta
router.put('/budgets', (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : [req.body || {}];
  try {
    for (const it of items) setBudget(it.category_id, it.monthly_limit);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

// Insights: última análise, opções dos filtros, gerar (com filtros), salvas (listar, abrir, salvar, excluir)
router.get('/insights', (req, res) => res.json(insights.last(ownerOf(req.query))));
router.get('/insights/options', (req, res) => res.json(insights.options(ownerOf(req.query))));
router.get('/insights/saved', (req, res) => res.json(insights.listSaved()));
router.get('/insights/:id(\\d+)', (req, res) => {
  const r = insights.get(req.params.id);
  return r ? res.json(r) : res.status(404).json({ error: 'Análise não encontrada.' });
});
router.post('/insights', async (req, res) => {
  try {
    res.json(await insights.generate(req.body || {}, req.user));
  } catch (e) {
    fail(res, e);
  }
});
router.patch('/insights/:id(\\d+)', (req, res) => {
  try {
    insights.save(req.params.id, req.body?.title);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});
router.delete('/insights/:id(\\d+)', (req, res) => {
  try {
    insights.remove(req.params.id, req.user);
    res.json({ ok: true });
  } catch (e) {
    fail(res, e);
  }
});

module.exports = router;
