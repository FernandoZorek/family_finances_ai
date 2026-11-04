# Security

Family Finances stores sensitive financial data. Please report vulnerabilities **privately** through
[GitHub Security Advisories](https://github.com/FernandoZorek/family_finances_ai/security/advisories/new) instead of opening a public issue.
You should get an answer within a few days.

## How the app protects your data

- **Self-hosted, no third parties:** statements are parsed on your server; nothing is sent to external services (no CDN, no analytics).
  The only exception is the **optional** AI rules feature (`FF_AI_PROVIDER`, off by default), which sends merchant names
  without digits — never amounts, dates, accounts or PIX/transfer descriptions — and, for on-demand insights, monthly totals per
  category plus top merchants per category, the savings goal and the user's guidance text. It can run fully local (Ollama).
  Every AI call is logged (action, model, tokens, estimated cost) so you can audit what was used.
- **Authentication:** bcrypt (cost 12) password hashes, random 256-bit session tokens stored only as SHA-256 hashes,
  `HttpOnly` + `SameSite=Strict` cookies (`Secure` over HTTPS), session revocation on password change/reset/disable.
- **CSRF:** every state-changing request must carry the `X-Requested-With: fetch` header (not sendable cross-site without CORS) on top of `SameSite=Strict`.
- **Brute force:** login and password-change attempts are rate limited per IP+user and per IP; unknown users take the same time as known ones.
- **First access:** users created by the admin or by environment variables get a temporary password and must change it on first login.
- **Roles:** only admins manage users; there is always at least one active admin.
- **Headers:** strict Content-Security-Policy (`script-src 'self'`, no inline scripts), `frame-ancestors 'none'`, `no-store` cache on all API responses.
- **Uploads:** only PDF/OFX (checked by content), size and count limits, stored with hashed names and `0600` permissions; PDF.js runs with `isEvalSupported: false`.
- **Output:** all data rendered in the UI is HTML-escaped; CSV export neutralizes spreadsheet formulas.

## Your responsibilities when self-hosting

- Serve it **only over HTTPS** (reverse proxy or tunnel). Keep `HOST=127.0.0.1` behind a proxy and set `TRUST_PROXY` correctly.
- Protect and back up `DATA_DIR` (database, uploaded statements). It is not encrypted at rest; use disk encryption if needed.
- Delete `DATA_DIR/initial-passwords.txt` after the first logins.
- Keep Node.js and dependencies updated (`npm audit`).
