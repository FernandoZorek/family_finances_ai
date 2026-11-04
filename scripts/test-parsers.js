// Uso: node scripts/test-parsers.js <pasta-ou-arquivo> [--v]
const fs = require('fs');
const path = require('path');
const { parseStatement } = require('../src/parsers');

(async () => {
  const target = process.argv[2];
  const verbose = process.argv.includes('--v');
  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter((f) => /\.(pdf|ofx)$/i.test(f)).map((f) => path.join(target, f))
    : [target];
  let fail = 0;
  for (const f of files) {
    const r = await parseStatement(fs.readFileSync(f), f, { generic: true });
    const ok = r.statedTotal == null ? '?' : Math.abs(Math.round((r.statedTotal - r.computedTotal) * 100)) === 0 ? 'OK' : 'DIVERGE';
    if (ok === 'DIVERGE') fail++;
    console.log(`\n# ${path.basename(f)}\n  ${r.parserLabel} | titular: ${r.holder} | venc: ${r.dueDate || '-'} | ${r.transactions.length} lançamentos`);
    console.log(`  a pagar: ${r.amountDue}\n  conferência (${r.totalLabel}): impresso ${r.statedTotal} x calculado ${r.computedTotal} => ${ok}`);
    for (const w of r.warnings) console.log('  aviso:', w);
    if (verbose) for (const t of r.transactions) console.log(`   ${t.date} ${String(t.amount).padStart(10)} ${t.payment ? '[PGTO] ' : ''}${t.description}${t.installment ? ' (' + t.installment + ')' : ''}${t.holder ? ' · ' + t.holder : ''}${t.categoryHint ? ' #' + t.categoryHint : ''}`);
  }
  process.exit(fail ? 1 : 0);
})();
