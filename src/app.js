// Monta o app Express: segurança (cabeçalhos, CSRF, sessão), API e arquivos estáticos
const path = require('path');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const config = require('./config');
const auth = require('./auth');

const ROOT = path.join(__dirname, '..');

function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          // estilos inline: o front usa atributos style (sem script inline)
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'same-origin' },
    })
  );

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store'); // dados financeiros: nada em cache de navegador/proxy
    next();
  });
  // JSON pequeno em tudo; só a importação de regras aceita arquivo maior
  const jsonSmall = express.json({ limit: '200kb' });
  const jsonRules = express.json({ limit: '2mb' });
  api.use((req, res, next) => (req.path === '/rules/import' ? jsonRules : jsonSmall)(req, res, next));
  api.use(auth.requireFetchHeader);
  const { router: authRoutes, me } = require('./routes/auth');
  api.use(authRoutes);
  api.use(me);
  // tudo abaixo exige login (e troca de senha feita, quando obrigatória)
  api.use(auth.requireAuth);
  api.use('/admin', require('./routes/admin'));
  api.use(require('./routes/settings'));
  api.use(require('./routes/imports'));
  api.use(require('./routes/extractors'));
  api.use(require('./routes/transactions').router);
  api.use(require('./routes/dashboard'));
  api.use(require('./routes/commitments'));
  api.use(require('./routes/goals'));
  api.use((req, res) => res.status(404).json({ error: 'Não encontrado.' }));
  app.use('/api', api);

  // index.html com versão nos assets: cada deploy muda a URL (cache de CDN/navegador)
  const BUILD = Date.now().toString(36);
  const indexHtml = fs
    .readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8')
    .replace('/app.js"', `/app.js?v=${BUILD}"`)
    .replace('/styles.css"', `/styles.css?v=${BUILD}"`)
    .replaceAll('{{APP_NAME}}', config.appName.replace(/[<>&"]/g, ''));
  const sendIndex = (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(indexHtml);
  app.get(['/', '/index.html'], sendIndex);
  app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: '1h' }));
  // seletor de emoji (todos os emojis, nomes em português), servido daqui mesmo, sem CDN
  // só os arquivos usados (não a pasta inteira do pacote)
  const EMOJI = path.join(ROOT, 'node_modules/emoji-picker-element');
  for (const f of ['index.js', 'picker.js', 'database.js', 'i18n/pt_BR.js'])
    app.get(`/vendor/emoji-picker/${f}`, (req, res) => res.sendFile(path.join(EMOJI, f), { maxAge: '7d' }));
  app.get('/vendor/emoji-data/pt.json', (req, res) =>
    res.sendFile(path.join(ROOT, 'node_modules/emoji-picker-element-data/pt/cldr/data.json'), { maxAge: '7d' })
  );
  app.get('*', sendIndex);

  app.use((err, req, res, _next) => {
    if (err instanceof multer.MulterError) return res.status(400).json({ error: `Upload recusado: ${err.message}` });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requisição grande demais.' });
    console.error(err);
    res.status(500).json({ error: 'Erro interno.' });
  });
  return app;
}

module.exports = { createApp };
