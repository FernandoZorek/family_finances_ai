// Arquivos enviados sem leitor, guardados na memória (não em disco) por 1 hora enquanto a pessoa escolhe
// como ler: criar leitor com IA, mapear colunas (CSV) ou leitura genérica. Senha do PDF fica só aqui.
const crypto = require('crypto');

const TTL = 3600e3;
const MAX = 20;
const items = new Map();

function prune() {
  const now = Date.now();
  for (const [id, it] of items) if (now - it.at > TTL) items.delete(id);
  while (items.size > MAX) items.delete(items.keys().next().value);
}

function put(entry) {
  prune();
  const id = crypto.randomBytes(12).toString('base64url');
  items.set(id, { ...entry, at: Date.now() });
  return id;
}

// só quem enviou consegue usar
function get(id, userId) {
  prune();
  const it = items.get(String(id));
  return it && it.userId === userId ? it : null;
}

const drop = (id) => items.delete(String(id));

module.exports = { put, get, drop };
