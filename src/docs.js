// Documentos de um mês: o que já foi enviado e o que provavelmente ainda falta enviar
const { db } = require('./db');
const { computeAlerts } = require('./alerts');

const ym = (iso) => iso.slice(0, 7);
function addMonths(m, n) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const lastDay = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function monthDocs(month, today = new Date()) {
  const imports = db.prepare('SELECT * FROM imports').all();
  const users = db.prepare('SELECT id, name, aliases FROM users').all();
  const ownerName = (holder) => {
    if (!holder) return null;
    const first = holder.trim().split(/\s+/)[0].toUpperCase();
    return users.find((u) => u.name.toUpperCase() === first || u.aliases.toUpperCase().split(',').some((a) => a.trim().startsWith(first)))?.name || null;
  };
  // dono pelos lançamentos quando o titular não diz (ex.: conta PJ)
  const ownerOfImport = db.prepare('SELECT u.name FROM transactions t JOIN users u ON u.id = t.owner_id WHERE t.import_id = ? GROUP BY u.id ORDER BY COUNT(*) DESC LIMIT 1');
  const owner = (i) => ownerName(i.holder) || ownerOfImport.get(i.id)?.name || null;

  const first = `${month}-01`;
  const last = `${month}-${String(lastDay(month)).padStart(2, '0')}`;
  const todayIso = iso(today);
  const inMonth = (i) =>
    i.kind === 'conta' ? i.period_start && i.period_end && i.period_start <= last && i.period_end >= first : i.due_date && ym(i.due_date) === month;
  const refMonth = (i) => (i.kind === 'conta' ? i.period_start && ym(i.period_start) : i.due_date && ym(i.due_date));

  // fonte = mesmo tipo + conta/cartão + pessoa
  const sources = new Map();
  for (const i of imports) {
    if (!i.kind || !i.account) continue;
    const who = owner(i);
    const key = `${i.kind}|${i.account}|${who || ''}`;
    if (!sources.has(key)) sources.set(key, { kind: i.kind, account: i.account, bank: i.bank, owner: who, items: [] });
    sources.get(key).items.push(i);
  }

  const sent = [];
  const missing = [];
  for (const s of sources.values()) {
    const here = s.items.filter(inMonth);
    if (here.length && s.kind === 'conta') {
      // uma linha por conta, com a cobertura somada dos extratos (o PDF às vezes repete o 1º dia do mês seguinte)
      const days = new Set();
      for (const i of here)
        for (let d = 1; d <= lastDay(month); d++) {
          const day = `${month}-${String(d).padStart(2, '0')}`;
          if (i.period_start <= day && day <= i.period_end) days.add(d);
        }
      const total = lastDay(month);
      const gaps = [];
      for (let d = 1; d <= total; d++) if (!days.has(d)) gaps.length && gaps[gaps.length - 1][1] === d - 1 ? (gaps[gaps.length - 1][1] = d) : gaps.push([d, d]);
      const dd = (d) => `${String(d).padStart(2, '0')}/${month.slice(5, 7)}`;
      const covered = [];
      for (let d = 1; d <= total; d++) if (days.has(d)) covered.length && covered[covered.length - 1][1] === d - 1 ? (covered[covered.length - 1][1] = d) : covered.push([d, d]);
      const rng = (list) => list.map(([a, b]) => (a === b ? dd(a) : `${dd(a)} a ${dd(b)}`)).join(', ');
      // só os dias seguidos do 1º dia do mês, vindos do extrato do mês anterior, não contam como envio deste mês
      if (days.size <= 1 && days.has(1) && here.every((i) => i.period_start < first)) {
        here.length = 0;
      } else {
        // arquivo que só repete o 1º dia (vindo do extrato do mês anterior) não precisa aparecer
        const files = here.filter((i) => !(i.period_start < first && i.period_end <= `${month}-01`) || here.length === 1).map((i) => i.filename);
        sent.push({ kind: 'conta', account: s.account, owner: s.owner, filename: files.join(', '), note: gaps.length ? `cobre ${rng(covered)}` : 'mês inteiro' });
        if (gaps.length) {
          const over = last < todayIso;
          missing.push({ kind: 'conta', account: s.account, owner: s.owner, status: over ? 'falta' : 'aguardando',
            when: over ? `faltam os dias ${rng(gaps)}` : `resto do mês (${rng(gaps)}), disponível a partir de 01/${addMonths(month, 1).slice(5, 7)}` });
        }
        continue;
      }
    }
    if (here.length) {
      for (const i of here) {
        const note = i.kind === 'cartao' ? `vencimento ${i.due_date.split('-').reverse().join('/')}` : `pago em ${i.due_date.split('-').reverse().join('/')}`;
        sent.push({ id: i.id, kind: s.kind, account: s.account, owner: s.owner, filename: i.filename, note: i.partial ? `parcial · ${note}` : note, total: i.amount_due, partial: !!i.partial });
      }
      // só a versão parcial da fatura: a fechada ainda precisa ser enviada (substitui a parcial)
      const open = here.filter((i) => i.partial);
      if (open.length && open.length === here.length) {
        const due = open[0].due_date;
        const ready = iso(new Date(new Date(`${due}T12:00:00`).getTime() - 7 * 864e5));
        missing.push({ kind: s.kind, account: s.account, owner: s.owner, status: todayIso >= ready ? 'falta' : 'aguardando',
          when: `fatura fechada (a parcial foi enviada), vence ${due.split('-').reverse().join('/')}` });
      }
      continue;
    }
    // ainda manda esse documento? algum envio nos 3 meses antes ou depois
    const months = s.items.map(refMonth).filter(Boolean);
    if (!months.some((m) => m >= addMonths(month, -3) && m <= addMonths(month, 3))) continue;
    if (months.every((m) => m > month)) continue; // começou a mandar depois desse mês
    const lastItem = s.items.filter((i) => i.due_date || i.period_end).sort((a, b) => String(b.due_date || b.period_end).localeCompare(String(a.due_date || a.period_end)))[0];
    let expected;
    let when;
    if (s.kind === 'conta') {
      expected = iso(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)); // extrato fecha no fim do mês
      when = `disponível a partir de ${expected.slice(8, 10)}/${expected.slice(5, 7)}`;
    } else {
      const day = Math.min(Number((lastItem?.due_date || '').slice(8, 10)) || 10, lastDay(month));
      expected = `${month}-${String(day).padStart(2, '0')}`;
      when = s.kind === 'cartao' ? `vence por volta de ${expected.slice(8, 10)}/${expected.slice(5, 7)}` : `pagamento por volta de ${expected.slice(8, 10)}/${expected.slice(5, 7)}`;
    }
    // fatura costuma sair ~7 dias antes do vencimento
    const ready = s.kind === 'cartao' ? iso(new Date(new Date(expected).getTime() - 7 * 864e5)) : expected;
    missing.push({ kind: s.kind, account: s.account, owner: s.owner, when, status: todayIso >= ready ? 'falta' : 'aguardando' });
  }

  // faturas pagas na conta sem a fatura enviada (detectado pelo pagamento)
  for (const a of computeAlerts(today).filter((x) => x.month === month && x.key.startsWith('pgto:'))) {
    const acc = a.title.replace(/^Falta a fatura do /, '').replace(/:.*$/, '');
    missing.push({ kind: 'cartao', account: acc.charAt(0).toUpperCase() + acc.slice(1), owner: null, when: a.title.replace(/^[^:]*:\s*/, ''), status: 'falta', detail: a.detail });
  }

  const order = { conta: 0, cartao: 1, holerite: 2 };
  const by = (a, b) => order[a.kind] - order[b.kind] || String(a.owner).localeCompare(String(b.owner)) || a.account.localeCompare(b.account);
  return { month, sent: sent.sort(by), missing: missing.sort((a, b) => (a.status === 'falta' ? 0 : 1) - (b.status === 'falta' ? 0 : 1) || by(a, b)) };
}

module.exports = { monthDocs };
