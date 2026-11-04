const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, DATA_DIR } = require('./db');
const { parseStatement } = require('./parsers');
const { markUsed } = require('./extractors');
const { loadContext, categorize, memberOf, normalize, reconcileCardPayments } = require('./categorize');

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

  const insImport = db.prepare(`INSERT INTO imports
    (filename, sha256, stored_path, parser, bank, kind, account, holder, due_date, period_start, period_end,
     stated_total, amount_due, computed_total, total_label, warnings, uploaded_by)
    VALUES (@filename, @sha256, @stored_path, @parser, @bank, @kind, @account, @holder, @due_date, @period_start, @period_end,
     @stated_total, @amount_due, @computed_total, @total_label, @warnings, @uploaded_by)`);
  const insTx = db.prepare(`INSERT OR IGNORE INTO transactions
    (import_id, owner_id, date, ref_month, description, amount, account, kind, holder, installment,
     category_id, ignored, is_payment, category_hint, hash)
    VALUES (@import_id, @owner_id, @date, @ref_month, @description, @amount, @account, @kind, @holder, @installment,
     @category_id, @ignored, @is_payment, @category_hint, @hash)`);

  const result = db.transaction(() => {
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
    }).lastInsertRowid;

    const seen = new Map();
    let inserted = 0;
    for (const t of st.transactions) {
      if (!t.date) continue;
      const refMonth = st.kind === 'cartao' && st.dueDate ? st.dueDate.slice(0, 7) : t.date.slice(0, 7);
      const base = [st.account, t.date, normalize(t.description), t.amount.toFixed(2), t.installment || '', st.kind === 'cartao' ? refMonth : ''].join('|');
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      const tx = {
        import_id: importId,
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
      };
      const cat = categorize(tx, ctx);
      tx.category_id = cat.id;
      tx.ignored = cat.kind === 'neutra' ? 1 : 0;
      inserted += insTx.run(tx).changes;
    }
    const skipped = st.transactions.length - inserted;
    db.prepare('UPDATE imports SET tx_count = ?, skipped_count = ? WHERE id = ?').run(inserted, skipped, importId);
    return { importId, inserted, skipped };
  })();

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
  };
}

module.exports = { importFile };
