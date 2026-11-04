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
- **Online vs in-person:** card purchases are labeled from the card type (virtual / physical / mixed, in **Ajustes › Cartões**)
  and the merchant name; you can correct one purchase or a whole merchant.
- **Goals (Metas):** monthly spending limit per category (groups include sub-categories), with the month's forecast,
  status (within / close / over) and history.
- **AI Insights (optional):** last 3/6/12 months or a custom range, optionally focused on one category or one statement/bill,
  with a savings goal ("R$ 20,000 by December") and free-text guidance. The app computes savings over 3/6/12 months and up to the
  goal's deadline, turns a suggestion into a spending goal in one click, and keeps saved analyses to review later.
- **AI rules (optional):** merchants left in "Outros" get a category rule from the model, by button or after every upload.
- **AI usage:** every AI call is logged with tokens and estimated cost — by action, by month and total.
- **Rules export/import:** move your rules and categories to another install as a JSON file.
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
| `FF_AI_PROVIDER` | – | Turns on AI rules and Insights: `anthropic`, `openai` (any OpenAI-compatible API) or `webhook`. Empty = off. |
| `FF_AI_MODEL` | `claude-opus-5-5` (anthropic) | Model name. Required for `openai`. |
| `FF_AI_API_KEY` | – | API key (`anthropic` also reads `ANTHROPIC_API_KEY`; `webhook` sends it as `Authorization: Bearer`). |
| `FF_AI_BASE_URL` | – | `openai`: API base URL. `webhook`: your endpoint URL. |
| `FF_AI_AUTO` | `false` | Initial value of "analyze automatically after each upload" (admins toggle it in the UI). |
| `FF_AI_MIN_CONFIDENCE` | `0.8` | Minimum confidence (0–1) to create an AI rule. |
| `FF_AI_PRICE_INPUT`, `FF_AI_PRICE_OUTPUT` | built-in table | USD per 1M input/output tokens for the usage report (built-in: Anthropic models; Gemini 2.5 as an estimate). |
| `FF_USD_BRL` | – | Optional exchange rate to also show AI cost in R$. |

### Users

Users from the environment are only **created** (never overwritten). Without any variable and with an empty database,
an `admin` user is created. Generated passwords go to `DATA_DIR/initial-passwords.txt` (mode 600), never to logs.
Everyone must set a new password on first login. Admins manage users in **Ajustes › Usuários** (create, reset password,
admin role, disable, delete users without transactions). There is always at least one active admin.

Lost the admin password? `node scripts/reset-password.js <user> --admin` (prompts for the new password).

### Rules export / import

**Ajustes › Regras de categoria › Exportar regras** downloads a JSON with every rule and the categories it uses.
Admins can **import** it on another install: missing categories are created, existing rules updated, nothing deleted.
Keep that file private — it reflects where you shop.

### AI (optional, off by default)

Set `FF_AI_PROVIDER` to enable two features:

- **AI rules** (Ajustes › Regras): merchants that ended up in "Outros"/"Outras receitas" get a category from the model;
  a rule is created when confidence ≥ `FF_AI_MIN_CONFIDENCE` and tagged **IA** for review. Run it with a button or turn on
  *analyze automatically after each upload*.
- **Insights** (menu **Insights**): analysis of a period with optional category/document filter, savings goal and guidance;
  analyses can be saved. The **AI usage** panel on the same page shows calls, tokens and estimated cost by action, month and total.

Providers:

| Provider | Example |
|---|---|
| Anthropic | `FF_AI_PROVIDER=anthropic`, `FF_AI_API_KEY=...` (default model `claude-opus-5-5`) |
| OpenAI-compatible | `FF_AI_PROVIDER=openai`, `FF_AI_BASE_URL=https://api.openai.com/v1`, `FF_AI_MODEL=...` |
| Google Gemini | `FF_AI_PROVIDER=openai`, `FF_AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai`, `FF_AI_MODEL=gemini-2.5-flash` |
| Local (Ollama) | `FF_AI_PROVIDER=openai`, `FF_AI_BASE_URL=http://127.0.0.1:11434/v1`, `FF_AI_MODEL=llama3.1` — nothing leaves your machine |
| Webhook | `FF_AI_PROVIDER=webhook`, `FF_AI_BASE_URL=https://your-service/classify` |

The webhook receives `POST` JSON with `type: "rules"` (`categories`, `items: [{key, kind}]`) and must answer
`{ items: [{ key, category, confidence }] }`; or `type: "insights"` (`prompt`, `data`) and must answer
`{ summary, highlights, savings: [{ category, monthly_target, reason, actions }], goal_feedback, warnings }`.
It may add `usage: { input_tokens, output_tokens, cost_usd }` to feed the usage report.

**Privacy.** AI rules send only merchant names without digits — no amounts, dates, accounts or documents, and never PIX/transfers
(they contain people's names). Insights send monthly totals per category, the top merchants of each category (no PIX/transfers),
your goal and your guidance text. Costs shown are estimates from token counts; check your provider's billing.

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

**Telas:** Painel (receitas, despesas, saldo, impostos, previsão, comparação de meses, online x presencial), **Metas** (limite
mensal por categoria, com previsto e histórico), **Insights** (análise por IA com período, categoria, documento, objetivo e
direcionamento; análises salvas; uso e custo de IA), Lançamentos, Enviar, Arquivos e Ajustes (regras, exportar/importar,
categorias, rendas, cartões, recorrentes, usuários).

**IA (opcional):** defina `FF_AI_PROVIDER` (Anthropic, qualquer API compatível com OpenAI, como Gemini ou um Ollama local, ou
um webhook seu). Regras por IA mandam só o nome da loja; os Insights mandam totais por categoria, as maiores lojas, o objetivo
e o direcionamento. Nunca vão PIX nem nomes de pessoas.

Use sempre atrás de HTTPS e faça backup da pasta `DATA_DIR`. Os impostos embutidos nos preços e o custo da IA são **estimativas**.
