const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');
const { parseStatement } = require('./parsers');
const { markUsed } = require('./extractors');
const { loadContext, categorize, memberOf, normalize, reconcileCardPayments, similarKey } = require('./categorize');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// template/generic/dueDate: formato sem leitor próprio (modelo confirmado na tela, leitura genérica, vencimento da fatura CSV)
async function importFile({ buffer, filename, userId, password, ownerId, template, generic, dueDate }) {
  const fileHash = sha(buffer);
  const existing = db.prepare('SELECT id, filename, created_at FROM imports WHERE sha256 = ?').get(fileHash);
  if (existing) {
    const err = new Error(`Este arquivo já foi enviado (${existing.filename}).`);
    err.code = 'DUPLICATE';
    throw err;
  }

  const st = await parseStatement(buffer, filename, { password, template, generic, dueDate });
  if (!st.transactions.length) throw new Error('Nenhum lançamento encontrado no arquivo.');

  const ctx = loadContext();
  const ownerFor = (holder) => {
    if (holder) {
      const id = memberOf(normalize(holder).split(' '), ctx.members);
      if (id) return id;
    }
    return ownerId || userId;
  };

  const ext = path.extname(filename || '').toLowerCase() || '.pdf';
  const storedPath = path.join(DATA_DIR, 'uploads', `${fileHash}${ext}`);
  fs.writeFileSync(storedPath, buffer, { mode: 0o600 });

  // lançamentos do arquivo, já categorizados (hash = conta, data, descrição, valor, parcela e mês da fatura)
  const seen = new Map();
  const rows = [];
  for (const t of st.transactions) {
    if (!t.date) continue;
    const refMonth = st.kind === 'cartao' && st.dueDate ? st.dueDate.slice(0, 7) : t.date.slice(0, 7);
    const base = [st.account, t.date, normalize(t.description), t.amount.toFixed(2), t.installment || '', st.kind === 'cartao' ? refMonth : ''].join('|');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    const tx = {
      owner_id: ownerFor(t.holder || st.holder),
      date: t.date,
      ref_month: refMonth,
      description: t.description,
      amount: t.amount,
      account: st.account + (t.card ? ` final ${t.card}` : ''),
      kind: st.kind,
      holder: t.holder || st.holder || null,
      installment: t.installment || null,
      is_payment: t.payment ? 1 : 0,
      category_hint: t.categoryHint || null,
      hash: sha(`${base}|${n}`),
      category_locked: 0,
      note: null,
      channel: null,
    };
    const cat = categorize(tx, ctx);
    tx.category_id = cat.id;
    tx.ignored = cat.kind === 'neutra' ? 1 : 0;
    rows.push(tx);
  }

  const insImport = db.prepare(`INSERT INTO imports
    (filename, sha256, stored_path, parser, bank, kind, account, holder, due_date, period_start, period_end,
     stated_total, amount_due, computed_total, total_label, warnings, uploaded_by, partial)
    VALUES (@filename, @sha256, @stored_path, @parser, @bank, @kind, @account, @holder, @due_date, @period_start, @period_end,
     @stated_total, @amount_due, @computed_total, @total_label, @warnings, @uploaded_by, @partial)`);
  const insTx = db.prepare(`INSERT OR IGNORE INTO transactions
    (import_id, owner_id, date, ref_month, description, amount, account, kind, holder, installment,
     category_id, category_locked, ignored, is_payment, category_hint, note, channel, hash)
    VALUES (@import_id, @owner_id, @date, @ref_month, @description, @amount, @account, @kind, @holder, @installment,
     @category_id, @category_locked, @ignored, @is_payment, @category_hint, @note, @channel, @hash)`);

  const result = db.transaction(() => {
    // versão anterior (parcial) do mesmo documento: sai e as edições passam para os lançamentos novos
    const replaced = previousVersions(st, rows);
    for (const r of replaced) db.prepare('DELETE FROM imports WHERE id = ?').run(r.id);

    const importId = insImport.run({
      filename,
      sha256: fileHash,
      stored_path: storedPath,
      parser: st.parser,
      bank: st.bank,
      kind: st.kind,
      account: st.account,
      holder: st.holder || null,
      due_date: st.dueDate || null,
      period_start: st.periodStart || null,
      period_end: st.periodEnd || null,
      stated_total: st.statedTotal ?? null,
      amount_due: st.amountDue ?? null,
      computed_total: st.computedTotal ?? null,
      total_label: st.totalLabel || null,
      warnings: JSON.stringify(st.warnings || []),
      uploaded_by: userId,
      partial: isOpenBill(st) ? 1 : 0,
    }).lastInsertRowid;

    let inserted = 0;
    for (const tx of rows) inserted += insTx.run({ ...tx, import_id: importId }).changes;
    const skipped = st.transactions.length - inserted;
    db.prepare('UPDATE imports SET tx_count = ?, skipped_count = ? WHERE id = ?').run(inserted, skipped, importId);
    return { importId, inserted, skipped, replaced };
  })();
  for (const r of result.replaced) if (r.stored_path) fs.rm(r.stored_path, { force: true }, () => {});

  const reconciled = reconcileCardPayments();
  markUsed(st.extractorId);
  return {
    id: result.importId,
    filename,
    parser: st.parserLabel,
    bank: st.bank,
    kind: st.kind,
    holder: st.holder,
    dueDate: st.dueDate || null,
    inserted: result.inserted,
    skipped: result.skipped,
    statedTotal: st.statedTotal ?? null,
    computedTotal: st.computedTotal ?? null,
    totalLabel: st.totalLabel,
    warnings: st.warnings || [],
    reconciled,
    partial: isOpenBill(st),
    replaced: result.replaced.map((r) => r.filename),
  };
}

// Fatura enviada bem antes do vencimento ainda está aberta (fecha ~7 a 10 dias antes de vencer)
function isOpenBill(st, today = new Date()) {
  if (st.kind !== 'cartao' || !st.dueDate) return false;
  return (new Date(`${st.dueDate}T12:00:00`) - today) / 864e5 > OPEN_BILL_DAYS;
}
const OPEN_BILL_DAYS = 12;

// Envios anteriores do mesmo documento (mesma fatura, ou extrato da mesma conta com período dentro do novo)
// que o arquivo novo contém quase inteiro: são versões parciais e serão substituídas.
// Os lançamentos que continuam no arquivo novo herdam o que a pessoa editou (categoria, nota, canal, dono, descrição).
const MIN_CONTAINED = 0.8;
function previousVersions(st, rows) {
  let candidates = [];
  if (st.kind === 'cartao' && st.dueDate) {
    candidates = db.prepare("SELECT * FROM imports WHERE kind = 'cartao' AND account = ? AND substr(due_date, 1, 7) = ?").all(st.account, st.dueDate.slice(0, 7));
  } else if (st.kind === 'conta' && st.periodStart && st.periodEnd) {
    candidates = db
      .prepare("SELECT * FROM imports WHERE kind = 'conta' AND account = ? AND period_start >= ? AND period_end <= ?")
      .all(st.account, st.periodStart, st.periodEnd);
  }
  const sameHolder = (i) => !i.holder || !st.holder || normalize(i.holder) === normalize(st.holder);
  const oldTx = db.prepare('SELECT * FROM transactions WHERE import_id = ?');
  const replaced = [];
  for (const imp of candidates.filter(sameHolder)) {
    const old = oldTx.all(imp.id);
    const pairs = matchVersions(old, rows);
    if (old.length && pairs.length < old.length * MIN_CONTAINED) continue;
    for (const [o, n, exact] of pairs) carryEdits(o, n, exact);
    replaced.push(imp);
  }
  return replaced;
}

// -> [[antigo, novo, mesmoHash]]: primeiro pelo hash; depois o lançamento que mudou entre as versões
// (mesma loja com valor até 5% diferente, ou mesmo valor, em até 5 dias)
function matchVersions(old, rows) {
  const byHash = new Map(rows.map((r) => [r.hash, r]));
  const used = new Set();
  const pairs = [];
  const rest = [];
  for (const o of old) {
    const n = byHash.get(o.hash);
    if (n && !used.has(n)) used.add(n), pairs.push([o, n, true]);
    else rest.push(o);
  }
  const days = (a, b) => Math.abs(new Date(a) - new Date(b)) / 864e5;
  for (const o of rest) {
    const key = similarKey(o.description);
    const n = rows.find(
      (r) =>
        !used.has(r) &&
        Math.sign(r.amount) === Math.sign(o.amount) &&
        (r.installment || '') === (o.installment || '') &&
        days(r.date, o.date) <= 5 &&
        ((key && similarKey(r.description) === key && Math.abs(r.amount - o.amount) <= Math.max(1, Math.abs(o.amount) * 0.05)) ||
          (Math.abs(r.amount - o.amount) < 0.005 && days(r.date, o.date) <= 3)),
    );
    if (n) used.add(n), pairs.push([o, n, false]);
  }
  return pairs;
}

function carryEdits(o, n, exact) {
  if (o.category_locked) Object.assign(n, { category_id: o.category_id, ignored: o.ignored, category_locked: 1 });
  if (o.note) n.note = o.note;
  if (o.channel) n.channel = o.channel;
  if (o.owner_id) n.owner_id = o.owner_id;
  if (exact && o.description !== n.description) n.description = o.description; // renomeado à mão
}

module.exports = { importFile, isOpenBill };
