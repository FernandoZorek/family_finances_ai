// Documentos faltando: faturas e extratos recorrentes que não foram enviados (ou cobrem só parte do mês)
const { db } = require('./db');
const { cardBankOf } = require('./categorize');

const ym = (iso) => iso.slice(0, 7);
function addMonths(m, n) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const lastDay = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const label = (m) => `${MES[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;
const br = (iso) => iso.split('-').reverse().join('/');
const brl = (v) => Math.abs(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function dismissed() {
  try {
    return new Set(JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'alerts_dismissed'").get()?.value || '[]'));
  } catch {
    return new Set();
  }
}

function dismiss(key) {
  const set = dismissed();
  set.add(String(key));
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('alerts_dismissed', ?)").run(JSON.stringify([...set]));
}

function computeAlerts(today = new Date()) {
  const cur = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const imports = db.prepare('SELECT * FROM imports').all();
  const users = db.prepare('SELECT id, name, aliases FROM users').all();
  const ownerName = (holder) => {
    if (!holder) return null;
    const first = holder.trim().split(/\s+/)[0].toUpperCase();
    return users.find((u) => u.name.toUpperCase() === first || u.aliases.toUpperCase().split(',').some((a) => a.trim().startsWith(first)))?.name || null;
  };
  const alerts = [];
  const push = (a) => alerts.push(a);

  // 1) Pagamento de fatura sem a fatura correspondente
  const missing = db
    .prepare(`SELECT t.id, t.date, t.amount, t.description, t.account, t.ref_month, u.name AS owner FROM transactions t
              JOIN categories c ON c.id = t.category_id LEFT JOIN users u ON u.id = t.owner_id
              WHERE COALESCE(c.key, c.name) = 'Fatura de cartão sem detalhe' AND t.ignored = 0`)
    .all();
  const coveredByPayment = new Set();
  for (const t of missing) {
    const bank = cardBankOf(t) || 'cartão';
    coveredByPayment.add(`${bank}|${t.ref_month}`);
    // Fatura do mesmo banco já enviada perto dessa data, com valor bem diferente: provavelmente outro cartão
    const near = imports.filter(
      (i) => i.kind === 'cartao' && i.bank === bank && i.due_date && i.amount_due != null && Math.abs(new Date(i.due_date) - new Date(t.date)) <= 25 * 864e5
    );
    const nearTxt = near.length
      ? ` A fatura ${bank} já enviada (${near.map((i) => `${[ownerName(i.holder) || i.holder, `vencimento ${br(i.due_date)}`, brl(i.amount_due)].filter(Boolean).join(', ')}`).join('; ')}) tem outro valor, então deve ser de outro cartão.`
      : '';
    push({
      key: `pgto:${t.id}`,
      level: 'alta',
      month: t.ref_month,
      title: `Falta a fatura do cartão ${bank}${t.owner ? ` de ${t.owner}` : ''}: ${brl(t.amount)} pagos em ${br(t.date)}`,
      detail: `${t.owner ? t.owner + ' pagou' : 'Pagamento de'} ${brl(t.amount)} em ${br(t.date)} pela ${t.account}, mas a fatura com esse valor não foi enviada. Sem ela, o valor entra como "Fatura de cartão sem detalhe" e não dá para ver onde foi gasto.${nearTxt}`,
    });
  }

  // Fontes recorrentes (cada conta e cada cartão já enviado alguma vez)
  const sources = new Map();
  for (const i of imports) {
    if (!i.account || !i.kind || i.kind === 'holerite') continue; // holerite não é extrato recorrente cobrado
    const key = `${i.kind}|${i.account}`;
    if (!sources.has(key)) sources.set(key, { kind: i.kind, account: i.account, bank: i.bank, holder: i.holder, items: [] });
    sources.get(key).items.push(i);
  }
  // Início esperado: mediana do primeiro mês de cada fonte (evita cobrar meses antigos de quem começou a enviar depois)
  const firsts = [...sources.values()]
    .map((s) => s.items.map((i) => (s.kind === 'cartao' ? i.due_date && ym(i.due_date) : i.period_start && ym(i.period_start))).filter(Boolean).sort()[0])
    .filter(Boolean)
    .sort();
  if (!firsts.length) return alerts;
  const start = firsts[Math.floor((firsts.length - 1) / 2)];

  for (const s of sources.values()) {
    const who = ownerName(s.holder);
    const name = `${s.account}${who ? ` (${who})` : ''}`;
    if (s.kind === 'cartao') {
      const dues = s.items.map((i) => i.due_date).filter(Boolean).sort();
      if (!dues.length) continue;
      const months = new Set(dues.map(ym));
      const dueDay = Number(dues[dues.length - 1].slice(8, 10));
      // mês atual só é cobrado depois do vencimento
      const end = today.getDate() > dueDay + 2 ? cur : addMonths(cur, -1);
      for (let m = start; m <= end; m = addMonths(m, 1)) {
        if (months.has(m) || coveredByPayment.has(`${s.bank}|${m}`)) continue;
        push({
          key: `fatura:${s.account}:${m}`,
          level: 'media',
          month: m,
          title: `Falta a fatura ${name} com vencimento em ${label(m)}`,
          detail: `As faturas desse cartão vencem por volta do dia ${dueDay}. Sem ela, os gastos de cartão desse mês ficam de fora.`,
        });
      }
    } else {
      // Contas: cada mês fechado precisa estar coberto pelo período dos extratos
      const ranges = s.items.filter((i) => i.period_start && i.period_end).map((i) => [i.period_start, i.period_end]);
      for (let m = start; m < cur; m = addMonths(m, 1)) {
        let covered = 0;
        const gaps = [];
        for (let d = 1; d <= lastDay(m); d++) {
          const day = `${m}-${String(d).padStart(2, '0')}`;
          if (ranges.some(([a, b]) => a <= day && day <= b)) covered++;
          else if (gaps.length && gaps[gaps.length - 1][1] === `${m}-${String(d - 1).padStart(2, '0')}`) gaps[gaps.length - 1][1] = day;
          else gaps.push([day, day]);
        }
        const gap = lastDay(m) - covered;
        if (gap <= 3) continue;
        const gapText = gaps.map(([a, b]) => (a === b ? br(a).slice(0, 5) : `${br(a).slice(0, 5)} a ${br(b).slice(0, 5)}`)).join(', ');
        push({
          key: `extrato:${s.account}:${m}`,
          level: 'media',
          month: m,
          title: covered ? `Extrato ${name} cobre só parte de ${label(m)}` : `Falta o extrato ${name} de ${label(m)}`,
          detail: covered
            ? `Faltam ${gap} dias (${gapText}). Entradas e saídas desses dias, como salário ou contas, não aparecem.`
            : `Nenhum extrato dessa conta cobre ${label(m)}.`,
        });
      }
    }
  }

  // 3) Fatura paga por débito numa conta que nunca foi enviada (ex.: "PGTO DEBITO CONTA 1234")
  const debitos = db
    .prepare(
      `SELECT t.description, t.account, i.bank, group_concat(DISTINCT substr(t.date, 1, 7)) AS months
       FROM transactions t JOIN imports i ON i.id = t.import_id
       WHERE t.is_payment = 1 AND t.description LIKE '%DEBITO CONTA%' GROUP BY t.description, t.account, i.bank`
    )
    .all();
  for (const d of debitos) {
    // meses em que a fatura foi debitada nessa conta: são os extratos que faltam
    const months = String(d.months || '').split(',').filter(Boolean).sort();
    const monthsTxt = months.map(label).join(', ').replace(/, ([^,]*)$/, ' e $1');
    const hasConta = imports.some((i) => i.kind === 'conta' && i.bank === d.bank);
    if (hasConta) continue;
    const num = (/CONTA\s+(\d+)/i.exec(d.description) || [])[1] || '';
    push({
      key: `conta:${d.bank}:${num}`,
      level: 'baixa',
      month: null, // sem certeza de que falta algo: não marca o mês como incompleto
      title: `Falta o extrato da conta ${d.bank}${num ? ` ${num}` : ''}${monthsTxt ? ` de ${monthsTxt}` : ''}`,
      detail: `A ${d.account} foi paga por débito nessa conta${monthsTxt ? ` em ${monthsTxt}` : ''}. Se ela tiver outras entradas ou saídas (salário, PIX, boletos), envie o extrato desse${months.length > 1 ? 's meses' : ' mês'}.`,
    });
  }

  const hidden = dismissed();
  const order = { alta: 0, media: 1, baixa: 2 };
  return alerts
    .filter((a) => !hidden.has(a.key))
    .sort((a, b) => order[a.level] - order[b.level] || String(b.month).localeCompare(String(a.month)));
}

module.exports = { computeAlerts, dismiss };
