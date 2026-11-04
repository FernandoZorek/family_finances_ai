// Configuração por variáveis de ambiente (veja .env.example). Nada pessoal fica no código.
const path = require('path');

// .env na pasta atual (desenvolvimento); variáveis já definidas no ambiente têm prioridade
try {
  if (require('fs').existsSync('.env')) process.loadEnvFile('.env');
} catch {}

const env = process.env;
const list = (v) =>
  String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// FF_USERS="ana:Ana Souza,bruno:Bruno" -> [{ username, name }]
function parseUsers(v) {
  return list(v)
    .map((item) => {
      const [username, ...rest] = item.split(':');
      return { username: String(username || '').trim().toLowerCase(), name: rest.join(':').trim() };
    })
    .filter((u) => u.username);
}

function trustProxy(v) {
  if (v === undefined || v === '') return 'loopback';
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v; // ex.: "loopback", "10.0.0.0/8"
}

const config = {
  appName: env.APP_NAME || 'Family Finances',
  port: Number(env.PORT || 3010),
  host: env.HOST || '127.0.0.1',
  dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
  isProduction: env.NODE_ENV === 'production',
  trustProxy: trustProxy(env.TRUST_PROXY),
  // auto: Secure quando a requisição chega por HTTPS (direto ou pelo proxy confiável)
  cookieSecure: ['true', 'false'].includes(env.COOKIE_SECURE) ? env.COOKIE_SECURE === 'true' : 'auto',
  sessionDays: Number(env.SESSION_DAYS || 30),
  admin: {
    username: String(env.FF_ADMIN_USERNAME || '').trim().toLowerCase(),
    name: String(env.FF_ADMIN_NAME || '').trim(),
    password: env.FF_ADMIN_PASSWORD || '',
  },
  users: parseUsers(env.FF_USERS),
  // senha inicial de cada usuário de FF_USERS: FF_PASSWORD_<USUARIO> (opcional; sem ela, é gerada)
  userPassword: (username) => env[`FF_PASSWORD_${username.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || '',
  // cidades onde a família mora: nome colado na compra de cartão ("PADARIA XCAMPINAS") indica compra presencial
  homeCities: list(env.FF_HOME_CITIES).map((c) => c.toUpperCase()),
};

module.exports = config;
