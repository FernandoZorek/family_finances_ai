# Family Finances

Self-hosted, mobile-first dashboard for a household's money. Upload the PDF/OFX statements and credit card bills you
already get from your banks, and Family Finances reads, validates and categorizes every transaction, then shows where the
money went, what is coming next month and how each person and income source contributes.

> 🇧🇷 The interface is in Brazilian Portuguese and the parsers target Brazilian banks. [Leia em português](#português).

## Features

- **Import** PDF/OFX statements and bills; each import is checked against the total printed by the bank. Duplicates are skipped.
- **Automatic categories** with editable rules (per text, per account), categories and sub-categories, "apply to similar ones".
- **Card bills reconciliation:** bill payments are neutral when the bill was imported; missing documents become alerts.
- **Payslips (holerite):** gross salary plus each payroll deduction, with the net deposit reconciled.
- **Forecast:** future card installments, recurring income/expenses and loans, month by month.
- **Dashboard:** income/expense/balance, taxes card (direct + accountant + *estimated* embedded taxes), pie chart,
  month comparison, "bills that end soon", online vs in-person card purchases, documents sent/missing per month.
- **Filters:** by person, by income source (removing an income also removes its related costs), gross/net income,
  essential/comfort/other expenses.
- **Spending goals:** monthly limit per category (groups include sub-categories), tracked on the dashboard with the month's forecast and history.
- **AI insights (optional):** summary of the last 3/6/12 months, where you spent most and where to save; the app computes the savings over 3, 6 and 12 months and turns a suggestion into a goal in one click.
- **Multi-user:** users from environment variables plus an admin panel; temporary passwords must be changed on first login.

Supported documents: Bradesco (account and card), Itaú (account and card), Mercado Pago (account and card), Sicredi (account),
Banco do Brasil (Ourocard), business account statements from bank 301, SCI-style payslips, OFX from any bank, and a generic PDF fallback.
Adding a bank is a single file: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

### Docker

```bash
cp .env.example .env        # set FF_ADMIN_USERNAME, FF_USERS, FF_HOME_CITIES...
docker compose up -d --build
cat data/initial-passwords.txt   # temporary passwords, if you did not set them
```

Open http://127.0.0.1:3010 through your HTTPS reverse proxy (see `deploy/nginx.example.conf`).

### Node.js (20.6+)

```bash
npm ci
cp .env.example .env
npm start                   # http://127.0.0.1:3010
```

## Configuration

All configuration is done with environment variables (see [.env.example](.env.example)).

| Variable | Default | Description |
|---|---|---|
| `PORT` / `HOST` | `3010` / `127.0.0.1` | Listen address. Keep `127.0.0.1` behind a reverse proxy; `0.0.0.0` in containers. |
| `DATA_DIR` | `./data` | SQLite database, uploaded files and backups. Back it up. |
| `APP_NAME` | `Family Finances` | Name shown in the UI. |
| `TRUST_PROXY` | `loopback` | Express `trust proxy` setting for your reverse proxy. |
| `COOKIE_SECURE` | `auto` | `Secure` cookie when the request came over HTTPS. |
| `SESSION_DAYS` | `30` | Session lifetime. |
| `FF_ADMIN_USERNAME`, `FF_ADMIN_NAME`, `FF_ADMIN_PASSWORD` | – | Admin created on start if missing. Empty password = generated. |
| `FF_USERS` | – | Other members, `user:Name,user2:Name 2`. Optional `FF_PASSWORD_<USER>`. |
| `FF_HOME_CITIES` | – | Cities where you shop; a city glued to a card purchase marks it as in-person. |
| `FF_AI_PROVIDER` | – | Optional AI rules: `anthropic`, `openai` (any OpenAI-compatible API, e.g. local Ollama) or `webhook`. See below. |
| `FF_AI_MODEL`, `FF_AI_API_KEY`, `FF_AI_BASE_URL` | – | Model (Anthropic default `claude-opus-5-5`), key, base URL / webhook URL. |
| `FF_AI_AUTO`, `FF_AI_MIN_CONFIDENCE` | `false`, `0.8` | Analyze after every upload (initial value; admins toggle it in the UI) and minimum confidence. |

### Rules: export, import and optional AI

- **Ajustes › Regras de categoria › Exportar regras** downloads a JSON with every rule and the categories it uses.
  Admins can **import** it on another install: missing categories are created, existing rules updated, nothing deleted.
  Keep that file private — it reflects where you shop.
- **AI (optional, off by default):** set `FF_AI_PROVIDER`. Merchants that ended up in "Outros"/"Outras receitas" are sent
  to the model, which picks a category; a rule is created when confidence ≥ `FF_AI_MIN_CONFIDENCE`. Rules are tagged **IA**
  for review. Run it with a button or turn on *analyze automatically after each upload*.
  **Privacy:** only the merchant name without digits is sent — no amounts, dates, accounts, documents, and never PIX/transfers
  (they contain people's names). **Insights** send monthly totals per category and the top merchants of each category
  (no PIX/transfers, no people's names). Use `openai` with a local Ollama (`FF_AI_BASE_URL=http://127.0.0.1:11434/v1`) to keep everything on your machine.

Users from the environment are only **created** (never overwritten). Without any variable and with an empty database,
an `admin` user is created. Generated passwords go to `DATA_DIR/initial-passwords.txt` (mode 600), never to logs.
Everyone must set a new password on first login. Admins manage users in **Ajustes › Usuários**.

Lost the admin password? `node scripts/reset-password.js <user> --admin` (prompts for the new password).

## Deploy

- **Docker:** `docker-compose.yml` (data in `./data`, port bound to localhost).
- **systemd:** `deploy/family-finances.service`.
- **No root access:** `deploy/watchdog.sh` from cron keeps the app (and an optional Cloudflare Tunnel) running;
  `deploy/deploy.sh` syncs the code over SSH (settings in `deploy/.env.deploy`, not versioned).
- **Backups:** `npm run backup` (keeps the last 14 daily copies in `DATA_DIR/backups`).

## Development

```bash
npm run dev      # restarts on change
npm run check    # eslint + node:test (integration tests use a temporary database)
npm run test:parsers -- ~/my-statements --v   # check parsers against your own files (they never leave your machine)
```

## Security

See [SECURITY.md](SECURITY.md) for the security model and how to report vulnerabilities.

## Disclaimer

Embedded-tax figures are **estimates** based on average tax burden per category, not data from invoices. Categorization and
online/in-person detection are heuristics. This is not financial or tax advice.

## License

[MIT](LICENSE)

---

## Português

Painel financeiro da família, para hospedar no seu próprio servidor. Envie os extratos e faturas em PDF/OFX que você já
recebe dos bancos: o Family Finances lê, confere com o total do banco, categoriza e mostra para onde foi o dinheiro, o que
vem nos próximos meses e quanto cada pessoa e cada renda contribui.

**Começando:** copie `.env.example` para `.env`, defina o administrador (`FF_ADMIN_USERNAME`), as pessoas da casa (`FF_USERS`)
e as cidades onde vocês compram (`FF_HOME_CITIES`), e rode `docker compose up -d --build` ou `npm start`. As senhas temporárias
ficam em `DATA_DIR/initial-passwords.txt` e precisam ser trocadas no primeiro acesso. Novos usuários: **Ajustes › Usuários**.

Use sempre atrás de HTTPS e faça backup da pasta `DATA_DIR`. Os impostos embutidos nos preços são **estimativas** por categoria.
