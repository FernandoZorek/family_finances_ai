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

router.get('/insights', (req, res) => res.json(insights.last(ownerOf(req.query))));
router.post('/insights', async (req, res) => {
  try {
    res.json(await insights.generate({ months: req.body?.months, owner: ownerOf(req.body || {}) }));
  } catch (e) {
    fail(res, e);
  }
});

module.exports = router;
