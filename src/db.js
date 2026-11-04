const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { dataDir: DATA_DIR } = require('./config');

// banco, uploads e backups: só o usuário do app lê (dados financeiros)
process.umask(0o077);

fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true, mode: 0o700 });

const db = new Database(path.join(DATA_DIR, 'financas.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#2a78d6',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('despesa','receita','neutra')),
  icon TEXT NOT NULL DEFAULT '•',
  sort INTEGER NOT NULL DEFAULT 100
);
CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY,
  pattern TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 10,
  source TEXT NOT NULL DEFAULT 'padrao',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  sha256 TEXT UNIQUE NOT NULL,
  stored_path TEXT,
  parser TEXT NOT NULL,
  bank TEXT,
  kind TEXT,
  account TEXT,
  holder TEXT,
  due_date TEXT,
  period_start TEXT,
  period_end TEXT,
  stated_total REAL,
  amount_due REAL,
  computed_total REAL,
  total_label TEXT,
  warnings TEXT,
  tx_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  import_id INTEGER REFERENCES imports(id) ON DELETE CASCADE,
  owner_id INTEGER REFERENCES users(id),
  date TEXT NOT NULL,
  ref_month TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  account TEXT,
  kind TEXT,
  holder TEXT,
  installment TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  category_locked INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  is_payment INTEGER NOT NULL DEFAULT 0,
  category_hint TEXT,
  note TEXT,
  hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS commitments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  pattern TEXT,
  amount REAL NOT NULL,
  first_month TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  owner_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_month ON transactions(ref_month);
CREATE INDEX IF NOT EXISTS idx_tx_owner ON transactions(owner_id);
`);

// Colunas novas em bancos já existentes
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('commitments').includes('direction')) {
  db.exec("ALTER TABLE commitments ADD COLUMN direction TEXT NOT NULL DEFAULT 'saida'"); // saida | entrada
  db.exec('ALTER TABLE commitments ADD COLUMN recurring INTEGER NOT NULL DEFAULT 0'); // 1 = todo mês, sem fim
}
// key = nome original das categorias padrão: o código acha por ela, o nome visível pode mudar
// regra só para uma conta (ex.: "PIX RECEBIDO" na conta de quem tem MEI = venda do MEI)
if (!cols('rules').includes('account')) db.exec('ALTER TABLE rules ADD COLUMN account TEXT');
// Usuários: administrador, desativado e troca de senha obrigatória (primeiro acesso / senha redefinida)
if (!cols('users').includes('is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  // instalação existente: o primeiro usuário vira administrador
  db.exec('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)');
}
if (!cols('categories').includes('key')) db.exec('ALTER TABLE categories ADD COLUMN key TEXT');
// essencial | conforto | NULL (outras): filtro de despesas do painel
// carga de imposto embutida no preço (fração; NULL = padrão do app). Estimativa para o card de impostos
if (!cols('categories').includes('tax_rate')) db.exec('ALTER TABLE categories ADD COLUMN tax_rate REAL');
if (!cols('categories').includes('nature')) db.exec('ALTER TABLE categories ADD COLUMN nature TEXT');
// Online x presencial: tipo de cada cartão (virtual | fisico | misto) e correção manual por compra/loja
db.exec(`CREATE TABLE IF NOT EXISTS cards (account TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'misto')`);
db.exec(`CREATE TABLE IF NOT EXISTS channel_rules (pattern TEXT PRIMARY KEY, channel TEXT NOT NULL)`);
if (!cols('transactions').includes('channel')) db.exec('ALTER TABLE transactions ADD COLUMN channel TEXT'); // online | presencial (manual)
// Fontes de renda: a entrada e as despesas que existem por causa dela (ex.: PJ -> contador e impostos)
db.exec(`CREATE TABLE IF NOT EXISTS income_sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id INTEGER REFERENCES users(id),
  matchers TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0
)`);
if (!cols('categories').includes('parent_id')) {
  db.exec('ALTER TABLE categories ADD COLUMN parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL'); // grupo (categoria-mãe)
}

module.exports = { db, DATA_DIR };
