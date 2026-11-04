// Compra de cartão online ou presencial. As faturas não dizem; deduz pelo cartão (virtual/físico)
// e pelo nome que a loja manda (intermediador online, cidade colada no fim, maquininha)
const { db } = require('./db');
const { normalize, similarKey } = require('./categorize');
const config = require('./config');

// Nome de loja/intermediador que só vende online
const ONLINE =
  /^(DL ?\*|PAYPAL|EBANX|MERCADOLIVRE|MERCADOPAGO ?\*|MP ?\*(MERCADOLIVRE|MELIMAIS)|MLP ?\*|IFD ?\*|IFOOD|99 ?FOOD|99 ?\*|IG ?\*|FACEBK|GOOGLE|APPLE\.COM|AMAZON|SHOPEE|SHEIN|NETFLIX|SPOTIFY|DISNEY|HBO|PRIME VIDEO|UBER|HETZNER|VINDI|INGRESSO|MICROSOFT|ADOBE|CANVA|OPENAI|ANTHROPIC|ALIEXPRESS|TEMU|MAGALU|AMERICANAS|RAPPI|ZE ?DELIVERY|STEAM|PLAYSTATION|NINTENDO|VIVO LITE)|WWW|\.COM\b|\bDIGITAL\b/;
// Maquininha/PDV no início do nome = cartão passado na loja
const POS = /^(PDV ?\*|STB ?\*|SUMUP|TON ?\*|PG ?\*|MP ?\*)/;
// Cidade colada no fim do nome (ex.: "PADARIA XCAMPINASBR"): o banco corta o nome, então vale qualquer começo
// da cidade com 5+ letras. Cidades vêm de FF_HOME_CITIES (onde a família compra no dia a dia).
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CITY_END = config.homeCities.length
  ? new RegExp(`(${config.homeCities.map((c) => normalize(c).replace(/ /g, '')).flatMap((c) => Array.from({ length: Math.max(0, c.length - 4) }, (_, i) => escapeRe(c.slice(0, c.length - i)))).join('|')})(BR|B|PR|SP|RJ|MG|SC|RS)?$`)
  : null;
const isPresencial = (d) => POS.test(d) || Boolean(CITY_END && CITY_END.test(d.replace(/ /g, '')));

function loadChannelCtx() {
  return {
    cards: Object.fromEntries(db.prepare('SELECT account, mode FROM cards').all().map((c) => [c.account, c.mode])),
    rules: db.prepare('SELECT pattern, channel FROM channel_rules').all(),
  };
}

// -> { channel: 'online'|'presencial', how: 'manual'|'loja'|'cartão'|'nome'|'provável' } ou null (não é compra de cartão)
function channelOf(t, ctx) {
  if (t.kind !== 'cartao' || t.amount >= 0 || t.is_payment) return null;
  if (t.channel) return { channel: t.channel, how: 'manual' };
  const key = similarKey(t.description).replace(/ /g, '');
  const rule = ctx.rules.find((r) => key && key === r.pattern);
  if (rule) return { channel: rule.channel, how: 'loja' };
  const d = normalize(t.description).replace(/\s+\d{2}\/\d{2}$/, '');
  const online = ONLINE.test(d);
  const mode = ctx.cards[t.account] || 'misto';
  if (mode === 'virtual') return { channel: 'online', how: 'cartão' };
  if (online) return { channel: 'online', how: 'nome' };
  if (mode === 'fisico') return { channel: 'presencial', how: 'cartão' };
  if (isPresencial(d)) return { channel: 'presencial', how: 'nome' };
  return { channel: 'presencial', how: 'provável' };
}

module.exports = { channelOf, loadChannelCtx };
