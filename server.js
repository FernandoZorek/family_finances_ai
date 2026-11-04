// Family Finances: inicia o servidor
const config = require('./src/config');
const { bootstrap } = require('./src/bootstrap');
const { createApp } = require('./src/app');
const auth = require('./src/auth');

bootstrap()
  .then(() => {
    const app = createApp();
    setInterval(auth.cleanup, 3600e3).unref();
    app.listen(config.port, config.host, () => console.log(`${config.appName} rodando em http://${config.host}:${config.port}`));
  })
  .catch((e) => {
    console.error('Falha ao iniciar:', e);
    process.exit(1);
  });
