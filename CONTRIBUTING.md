# Contributing

Thanks for helping! The UI and domain language are Brazilian Portuguese (the app reads Brazilian bank documents);
code comments are in Portuguese too. Issues and PRs can be in English or Portuguese.

## Setup

```bash
npm install
cp .env.example .env   # adjust if needed
npm run dev            # http://127.0.0.1:3010
npm run check          # lint + tests
```

## Never commit real financial data

Bank statements, bills, payslips, databases and screenshots with real data must not go into issues, PRs or tests.
`.gitignore` blocks `*.pdf`, `*.ofx`, `*.db` and `data/`. For parser tests, write synthetic text fixtures
(see `test/rules.test.js` for the OFX example) with fake names, documents and amounts.

## Adding a bank / document format

Most formats don't need code: upload the file and create a reader in the app (CSV column mapping or AI). Readers are JSON
models interpreted by `src/extractors.js` (see the PDF and CSV examples in `test/extractors.test.js`); presets for public CSV
exports live in `PRESETS` there. Write a parser file only when a model can't express the layout (multi-column pages, totals
spread over the page, etc.):

1. Create `src/parsers/<bank><Type>.js` exporting `{ id, label, detect(text), parse(pages) }`.
   `parse` returns `{ bank, kind: 'conta' | 'cartao' | 'holerite', account, holder, periodStart, periodEnd,
   dueDate?, amountDue?, statedTotal, computedTotal, totalLabel, transactions: [{ date, description, amount, installment?, payment? }], warnings }`.
2. Register it in `src/parsers/index.js` (more specific parsers first).
3. Make `statedTotal` match the total printed by the bank: that is how imports are validated.
4. Check it locally with `npm run test:parsers -- /path/to/your/files --v` (files stay on your machine).

## Code layout

- `server.js` starts the app; `src/app.js` builds the Express app (security headers, routes, static files).
- `src/routes/*` HTTP routes; `src/*.js` domain logic (categorization, projections, alerts, filters, taxes).
- `public/` the single-page app (vanilla JS, no build step). Always escape interpolated values with `esc()`.
