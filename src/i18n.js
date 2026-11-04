// Idioma da requisição: cookie fin_locale (escolha do usuário) ou Accept-Language do navegador
const LOCALES = ['pt-BR', 'en', 'es'];
const LANGUAGE_NAME = { 'pt-BR': 'português do Brasil', en: 'English', es: 'español' };

function localeOf(req) {
  const m = /(?:^|;\s*)fin_locale=([\w-]+)/.exec(req.headers.cookie || '');
  if (m && LOCALES.includes(m[1])) return m[1];
  for (const part of String(req.headers['accept-language'] || '').split(',')) {
    const l = part.trim().toLowerCase();
    if (l.startsWith('pt')) return 'pt-BR';
    if (l.startsWith('es')) return 'es';
    if (l.startsWith('en')) return 'en';
  }
  return 'pt-BR';
}

module.exports = { LOCALES, LANGUAGE_NAME, localeOf };
