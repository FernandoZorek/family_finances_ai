'use strict';

// ---------- utilitários ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// nome do app vem do servidor (APP_NAME) no <title>
const APP_NAME = document.title || __('Family Finances');
// ---------- idioma (i18n) ----------
// Chave = texto em português (estilo gettext): sem tradução, aparece o original. O dicionário do idioma escolhido
// vem em /i18n.js (carregado antes deste arquivo, pelo cookie fin_locale ou pelo idioma do navegador).
const LOCALES = { 'pt-BR': 'Português (Brasil)', en: 'English', es: 'Español' };
const INTL = { 'pt-BR': 'pt-BR', en: 'en-US', es: 'es-ES' };
const I18N = window.FF_I18N && LOCALES[window.FF_I18N.locale] ? window.FF_I18N : { locale: 'pt-BR', dict: {} };
document.documentElement.lang = INTL[I18N.locale];
function __(s, vars) {
  let out = I18N.dict[s] ?? s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return out;
}
// troca o idioma: cookie (lido pelo servidor ao montar a página), preferência do usuário e recarrega
async function changeLocale(locale) {
  if (!LOCALES[locale]) return;
  document.cookie = `fin_locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
  if (state.user) await api('/me/locale', { method: 'PUT', body: { locale } }).catch(() => {});
  location.reload();
}
const LOC = () => INTL[I18N.locale];

const brl = (v) => (v ?? 0).toLocaleString(LOC(), { style: 'currency', currency: 'BRL', currencyDisplay: 'narrowSymbol' });
const brlShort = (v) => (Math.abs(v) >= 1000 ? `R$ ${(v / 1000).toLocaleString(LOC(), { maximumFractionDigits: 1 })} ${__('mil')}` : brl(v));
// nome curto do mês (jan, feb, ene...) pelo idioma
const monthShort = (m) => new Date(2000, m - 1, 15).toLocaleDateString(LOC(), { month: 'short' }).replace(/\./g, '');
const monthLabel = (ym, full) => {
  const [y, m] = ym.split('-').map(Number);
  return full ? new Date(y, m - 1, 15).toLocaleDateString(LOC(), { month: 'long', year: 'numeric' }) : `${monthShort(m)}/${String(y).slice(2)}`;
};
const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const fmtDate = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(LOC(), { day: '2-digit', month: '2-digit', year: 'numeric' });
const normalizeTxt = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const dayLabel = (iso) => {
  const d = new Date(iso + 'T12:00:00');
  const s = d.toLocaleDateString(LOC(), { weekday: 'short', day: '2-digit', month: 'short' }).replace(/\./g, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

async function api(path, opts = {}) {
  const headers = { 'X-Requested-With': 'fetch', ...(opts.headers || {}) };
  let body = opts.body;
  if (body && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch('/api' + path, { method: opts.method || 'GET', headers, body, credentials: 'same-origin' });
  if (res.status === 401 && path !== '/login') {
    state.user = null;
    render();
    throw new Error(__('Sessão expirada.'));
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 403 && data?.code === 'PASSWORD_CHANGE_REQUIRED' && state.user) {
    state.user.must_change_password = true;
    render();
  }
  if (!res.ok) throw new Error(data?.error ? __(data.error) : __('Erro {0}', { 0: res.status }));
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2600);
}

// Grupo (categoria-mãe) e nome completo "Moradia › Contas da casa"
const catById = (id) => state.categories.find((c) => c.id === id);
const catGroup = (id) => {
  const c = catById(id);
  return c?.parent_id ? catById(c.parent_id) || c : c;
};
const catPath = (id, fallback) => {
  const c = catById(id);
  if (!c) return fallback || __('Sem categoria');
  const p = c.parent_id && catById(c.parent_id);
  return p ? `${p.name} › ${c.name}` : c.name;
};
// Categorias de um tipo, cada grupo seguido das suas subcategorias
// categoria interna da renda líquida: não aparece para escolher
const COST_KEY = __('Custos da renda');
function catsOrdered(kind) {
  const list = state.categories.filter((c) => c.kind === kind && c.key !== COST_KEY);
  const tops = list.filter((c) => !c.parent_id || !list.some((p) => p.id === c.parent_id));
  return tops.flatMap((t) => [t, ...list.filter((c) => c.parent_id === t.id)]);
}

// Botão #emojiBtn abre o seletor em #emojiGrid; o emoji escolhido aparece em #emojiCur
function bindEmojiPick(root, onPick) {
  const grid = $('#emojiGrid', root);
  const btn = $('#emojiBtn', root);
  btn.addEventListener('click', async () => {
    grid.hidden = !grid.hidden;
    btn.setAttribute('aria-expanded', String(!grid.hidden));
    if (grid.hidden || grid.firstChild) return;
    grid.textContent = __('Carregando emojis…');
    try {
      const picker = await emojiPicker();
      grid.textContent = '';
      grid.appendChild(picker);
      picker.addEventListener('emoji-click', (ev) => {
        $('#emojiCur', root).textContent = ev.detail.unicode;
        onPick(ev.detail.unicode);
        grid.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      });
    } catch {
      grid.textContent = __('Não deu para carregar os emojis. Tente de novo.');
    }
  });
}

function openCategory(c, done) {
  if (!c) return;
  let icon = c.icon;
  const { el, close } = sheet(`
    <h3>${__('Editar categoria')}</h3>
    <form id="catEdit">
      <label class="field"><span>${__('Nome')}</span><input type="text" name="name" value="${esc(c.name)}" maxlength="60" required></label>
      <div class="field"><span>${__('Emoji')}</span><span class="emojipick"><button type="button" class="btn ghost" id="emojiBtn" aria-haspopup="true" aria-expanded="false"><span id="emojiCur">${esc(c.icon)}</span> ${__('Trocar emoji')}</button></span></div>
      <div class="emojigrid" id="emojiGrid" hidden></div>
      <p class="muted small" style="margin-top:0">${__('Os lançamentos e as regras continuam ligados a esta categoria.')}</p>
      <div class="actions"><button class="btn" type="submit">${__('Salvar')}</button><button class="btn ghost" type="button" id="catCancel">${__('Cancelar')}</button></div>
    </form>`);
  bindEmojiPick(el, (e) => (icon = e));
  $('#catCancel', el).addEventListener('click', close);
  $('#catEdit', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/categories/${c.id}`, { method: 'PATCH', body: { name: new FormData(e.target).get('name'), icon } });
      state.categories = await api('/categories');
      toast(__('Categoria atualizada'));
      close();
      done();
    } catch (err) {
      toast(err.message);
    }
  });
}

// Exportar/importar regras e IA opcional para criar regras de lojas sem categoria
function bindRulesIO(view, again) {
  $('#rulesFile', view)?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm(__('Importar {0} regras e {1} categorias de "{2}"? Nada é apagado.', { 0: data.rules?.length ?? 0, 1: data.categories?.length ?? 0, 2: file.name }))) return;
      const r = await api('/rules/import', { method: 'POST', body: { data } });
      state.categories = await api('/categories');
      toast(__('{0} regras novas, {1} atualizadas, {2} categorias · {3} lançamentos recategorizados', { 0: r.rules_created, 1: r.rules_updated, 2: r.categories_created, 3: r.changed }));
      again();
    } catch (err) {
      toast(err instanceof SyntaxError ? __('Arquivo não é um JSON válido.') : err.message);
    } finally {
      e.target.value = '';
    }
  });
  const box = $('#aiBox', view);
  api('/ai/status')
    .then((st) => {
      const when = st.last_run ? `${fmtDate(st.last_run.at.slice(0, 10))} ${st.last_run.at.slice(11, 16)}` : '';
      const last = st.last_run
        ? st.last_run.error
          ? __('Última análise ({0}): erro, {1}', { 0: when, 1: esc(st.last_run.error) })
          : __('Última análise ({0}, {1}): {2} lojas enviadas, {3} regras criadas, {4} lançamentos recategorizados.', { 0: when, 1: esc(st.last_run.reason || ''), 2: st.last_run.sent, 3: st.last_run.created, 4: st.last_run.changed || 0 })
        : __('Ainda não rodou.');
      box.innerHTML = st.enabled
        ? `<div class="aibox"><h4 class="docsh" style="margin-top:0">🤖 ${__('Regras automáticas por IA')} <span class="muted small">${esc(st.provider)}${st.model ? ` · ${esc(st.model)}` : ''}</span></h4>
            <p class="muted small" style="margin:0 0 8px">${__('Lojas que caíram em "Outros" ou "Outras receitas" ganham uma regra quando a IA tem confiança de')} ${Math.round(st.min_confidence * 100)}% ${__('ou mais. Só o nome da loja é enviado (sem valores, datas, contas ou PIX). As regras criadas aparecem em "Criadas pela IA" para você revisar.')}</p>
            ${
              state.user.is_admin
                ? `<label class="check"><input type="checkbox" id="aiAuto" ${st.auto ? 'checked' : ''}><span>${__('Analisar automaticamente a cada arquivo enviado')}</span></label>
                   <button class="btn sm" id="aiRun" ${st.pending ? '' : 'disabled'}>${st.pending ? __('Analisar agora ({0} {1} sem categoria)', { 0: st.pending, 1: st.pending === 1 ? __('loja') : __('lojas') }) : __('Nada para analisar')}</button>`
                : ''
            }
            <p class="muted small" id="aiLast" style="margin:8px 0 0">${last}</p></div>`
        : `<p class="muted small" style="margin:10px 0 0">🤖 ${__('Regras automáticas por IA: desligado. Para ligar, defina')} <code>${__('FF_AI_PROVIDER')}</code> ${__('no servidor (veja o README).')}</p>`;
      $('#aiAuto', box)?.addEventListener('change', async (e) => {
        try {
          await api('/ai/auto', { method: 'PUT', body: { auto: e.target.checked } });
          toast(e.target.checked ? __('Análise automática ligada') : __('Análise automática desligada'));
        } catch (err) {
          toast(err.message);
          e.target.checked = !e.target.checked;
        }
      });
      $('#aiRun', box)?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Analisando…';
        try {
          const r = await api('/ai/run', { method: 'POST' });
          toast(r.created ? __('{0} regras criadas · {1} lançamentos recategorizados', { 0: r.created, 1: r.changed }) : __('Nenhuma regra nova com confiança suficiente'));
          state.categories = await api('/categories');
          again();
        } catch (err) {
          toast(err.message);
          btn.disabled = false;
          btn.textContent = __('Analisar agora');
        }
      });
    })
    .catch(() => (box.innerHTML = ''));
}

// Administração de usuários (só admin)
function showTempPassword(username, pw) {
  const { el, close } = sheet(`
    <h3>${__('Senha temporária de')} ${esc(username)}</h3>
    <p class="muted small" style="margin-top:4px">${__('Repasse por um canal seguro. Ela vale para um acesso: no primeiro login')}, ${esc(username)} ${__('cria a própria senha. Esta tela não mostra a senha de novo.')}</p>
    <div class="temppw num" id="tpw">${esc(pw)}</div>
    <div class="actions" style="margin-top:12px"><button class="btn sm" id="tpwCopy">${__('Copiar')}</button><button class="btn ghost sm" id="tpwClose">${__('Fechar')}</button></div>`);
  $('#tpwCopy', el).addEventListener('click', () => navigator.clipboard?.writeText(pw).then(() => toast(__('Copiada'))));
  $('#tpwClose', el).addEventListener('click', close);
}
function bindAdminUsers(view, again) {
  const box = $('#adminUsers', view);
  api('/admin/users').then((users) => {
    box.innerHTML = users
      .map(
        (u) => `<div class="row catrow" style="cursor:default"><div class="ic"><span class="dot" style="background:${esc(u.color)};width:12px;height:12px"></span></div>
          <div class="main"><div class="title">${esc(u.name)} <span class="muted small">@${esc(u.username)}</span>${u.is_admin ? ` <span class="pill">${__('admin')}</span>` : ''}${u.disabled ? ` <span class="pill">${__('desativado')}</span>` : ''}</div>
          <div class="sub muted small">${u.tx_count} ${__('lançamentos')} · ${u.last_login_at ? __('último acesso {0}', { 0: fmtDate(u.last_login_at.slice(0, 10)) }) : __('nunca entrou')}${u.must_change_password ? __(' · senha temporária') : ''}</div></div>
          <div class="catsels">${
            u.id === state.user.id
              ? `<span class="muted small">${__('você')}</span>`
              : `<button class="btn ghost sm" data-ua="reset" data-uid="${u.id}">${__('Nova senha')}</button>
                 <button class="btn ghost sm" data-ua="${u.is_admin ? 'unadmin' : 'admin'}" data-uid="${u.id}">${u.is_admin ? __('Tirar admin') : __('Tornar admin')}</button>
                 <button class="btn ghost sm" data-ua="${u.disabled ? 'enable' : 'disable'}" data-uid="${u.id}">${u.disabled ? __('Reativar') : __('Desativar')}</button>
                 ${u.tx_count ? '' : `<button class="btn danger sm" data-ua="delete" data-uid="${u.id}">${__('Excluir')}</button>`}`
          }</div></div>`
      )
      .join('');
    $$('[data-ua]', box).forEach((b) =>
      b.addEventListener('click', async () => {
        const u = users.find((x) => x.id === Number(b.dataset.uid));
        const act = b.dataset.ua;
        try {
          if (act === 'reset') {
            if (!confirm(__('Gerar uma senha temporária nova para {0}? A senha atual deixa de valer e as sessões abertas caem.', { 0: u.name }))) return;
            const r = await api(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
            showTempPassword(u.username, r.temporary_password);
          } else if (act === 'delete') {
            if (!confirm(__('Excluir {0}?', { 0: u.name }))) return;
            await api(`/admin/users/${u.id}`, { method: 'DELETE' });
          } else {
            const body = { admin: { is_admin: true }, unadmin: { is_admin: false }, disable: { disabled: true }, enable: { disabled: false } }[act];
            if (act === 'disable' && !confirm(__('Desativar {0}? A pessoa não consegue mais entrar; os lançamentos continuam.', { 0: u.name }))) return;
            await api(`/admin/users/${u.id}`, { method: 'PATCH', body });
          }
          if (act !== 'reset') toast(__('Usuário atualizado'));
          const me = await api('/me');
          state.users = me.users;
          again();
        } catch (e) {
          toast(e.message);
        }
      })
    );
  }).catch((e) => (box.innerHTML = `<p class="muted small">${esc(e.message)}</p>`));
  $('#newUser', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api('/admin/users', { method: 'POST', body: { username: String(fd.get('username')).trim().toLowerCase(), name: fd.get('name'), is_admin: fd.get('is_admin') === 'on' } });
      const me = await api('/me');
      state.users = me.users;
      again();
      showTempPassword(String(fd.get('username')).trim().toLowerCase(), r.temporary_password);
    } catch (err) {
      toast(err.message);
    }
  });
}

// Renda: nome, pessoa e regras (uma por linha: "categoria: X", "texto: Y", "conta: Z")
function openSource(src, done) {
  const isEdit = Boolean(src.id);
  // palavras-chave das regras no idioma da tela (o leitor aceita também as dos outros idiomas)
  const LABEL = { category: __('categoria').toLowerCase(), pattern: __('texto').toLowerCase(), account: __('conta').toLowerCase() };
  const lines = (src.matchers || []).map((m) => `${LABEL[m.t]}: ${m.t === 'category' ? catById(m.v)?.name || m.v : m.v}`).join('\n');
  const { el, close } = sheet(`
    <h3>${isEdit ? __('Editar renda') : __('Nova renda')}</h3>
    <form id="srcForm">
      <label class="field"><span>${__('Nome')}</span><input type="text" name="name" value="${esc(src.name || '')}" maxlength="60" required placeholder="${__('Ex.: PJ da Ana')}"></label>
      <label class="field"><span>${__('Pessoa')}</span><select name="owner"><option value="">${__('Todos')}</option>${state.users.map((u) => `<option value="${u.id}" ${u.id === src.owner_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <label class="field"><span>${__('Regras (uma por linha)')}</span><textarea name="rules" rows="7" placeholder="${__('categoria: Vendas e serviços (MEI)&#10;texto: SIMPLES NACIONAL&#10;conta: Conta PJ')}">${esc(lines)}</textarea></label>
      <p class="muted small" style="margin-top:0"><b>${__('categoria')}:</b> ${__('tudo daquela categoria')} · <b>${__('texto')}:</b> ${__('descrição contém o texto')} · <b>${__('conta')}:</b> ${__('conta ou cartão começa com o texto. Só vale para lançamentos da pessoa escolhida. Entram tanto a entrada quanto as despesas ligadas.')}</p>
      <div class="actions"><button class="btn" type="submit">${__('Salvar')}</button><button class="btn ghost" type="button" id="srcCancel">${__('Cancelar')}</button>
      ${isEdit ? `<button class="btn danger" type="button" id="srcDel">${__('Excluir')}</button>` : ''}</div>
    </form>`);
  $('#srcCancel', el).addEventListener('click', close);
  $('#srcDel', el)?.addEventListener('click', async () => {
    if (!confirm(__('Excluir a renda "{0}"? Os lançamentos não mudam.', { 0: src.name }))) return;
    await api(`/sources/${src.id}`, { method: 'DELETE' });
    state.sources = await api('/sources');
    close();
    done();
  });
  $('#srcForm', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const bad = [];
    const matchers = String(fd.get('rules') || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const m = /^(categoria|categoría|texto|conta|category|text|account|cuenta)\s*:\s*(.+)$/i.exec(l);
        if (!m) return bad.push(l), null;
        const t = { categoria: 'category', 'categoría': 'category', category: 'category', texto: 'pattern', text: 'pattern', conta: 'account', account: 'account', cuenta: 'account' }[m[1].toLowerCase()];
        if (t !== 'category') return { t, v: m[2].trim() };
        const c = state.categories.find((x) => normalizeTxt(x.name) === normalizeTxt(m[2]));
        return c ? { t, v: c.id } : (bad.push(l), null);
      })
      .filter(Boolean);
    if (bad.length) return toast(__('Não entendi: {0}', { 0: bad[0] }));
    try {
      const body = { name: fd.get('name'), owner_id: fd.get('owner') || null, matchers };
      await api(isEdit ? `/sources/${src.id}` : '/sources', { method: isEdit ? 'PUT' : 'POST', body });
      state.sources = await api('/sources');
      toast(__('Renda salva'));
      close();
      done();
    } catch (err) {
      toast(err.message);
    }
  });
}

// Seletor com todos os emojis (emoji-picker-element), carregado só quando abre
async function emojiPicker() {
  const [{ Picker }, { default: i18n }] = await Promise.all([import('/vendor/emoji-picker/index.js'), import('/vendor/emoji-picker/i18n/pt_BR.js')]);
  return new Picker({ locale: 'pt', dataSource: '/vendor/emoji-data/pt.json', i18n });
}

function store(key, val) {
  try {
    if (val === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, val);
  } catch {
    return null;
  }
}

// ---------- estado ----------
const state = {
  user: undefined,
  users: [],
  categories: [],
  months: [],
  month: null,
  owner: store('fin.owner') || 'all',
  route: 'painel',
  txFilters: { q: '', category: '', type: '', all: false, channel: '' },
  sources: [],
  // filtro do painel: rendas desmarcadas (somem com as despesas ligadas) e tipo de despesa
  pf: (() => {
    try {
      return { exclude: [], nature: '', liquid: false, ...JSON.parse(store('fin.pf') || '{}') };
    } catch {
      return { exclude: [], nature: '', liquid: false };
    }
  })(),
};
const pfQuery = () => {
  const ex = state.pf.exclude.filter((id) => state.sources.some((s) => s.id === id));
  return `${ex.length ? `&exclude=${ex.join(',')}` : ''}${state.pf.nature ? `&nature=${state.pf.nature}` : ''}${state.pf.liquid ? '&liquid=1' : ''}`;
};
const pfSave = () => store('fin.pf', JSON.stringify(state.pf));

const ROUTES = [
  { id: 'painel', label: __('Painel'), ico: '📊' },
  { id: 'metas', label: __('Metas'), ico: '🎯' },
  { id: 'insights', label: __('Insights'), ico: '💡' },
  { id: 'lancamentos', label: __('Lançamentos'), short: __('Lançam.'), ico: '📋' },
  { id: 'enviar', label: __('Enviar'), ico: '📤' },
  { id: 'arquivos', label: __('Arquivos'), ico: '🗂️' },
  { id: 'ajustes', label: __('Ajustes'), ico: '⚙️' },
];

function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.some((r) => r.id === h) ? h : 'painel';
}

window.addEventListener('hashchange', () => {
  state.route = currentRoute();
  render();
});

async function boot() {
  state.route = currentRoute();
  try {
    const me = await api('/me');
    state.user = me.user;
    state.users = me.users;
    // idioma salvo no usuário vale em qualquer aparelho
    if (state.user.locale && state.user.locale !== I18N.locale) {
      document.cookie = `fin_locale=${state.user.locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
      return location.reload();
    }
    if (!state.user.locale) api('/me/locale', { method: 'PUT', body: { locale: I18N.locale } }).catch(() => {});
    if (!state.user.must_change_password) await loadMeta();
  } catch {
    state.user = null;
  }
  render();
}

async function loadMeta() {
  const [cats, months, alerts, sources] = await Promise.all([api('/categories'), api('/months'), api('/alerts'), api('/sources').catch(() => [])]);
  state.categories = cats;
  state.sources = sources;
  state.months = months;
  state.alerts = alerts;
  const thisMonth = new Date().toISOString().slice(0, 7);
  if (!state.month) state.month = months.includes(thisMonth) ? thisMonth : months[0] || thisMonth;
  if (state.owner !== 'all' && !state.users.some((u) => String(u.id) === String(state.owner))) state.owner = 'all';
}

// ---------- render ----------
function render() {
  const app = $('#app');
  if (state.user === undefined) return;
  if (!state.user) return renderLogin(app);
  if (state.user.must_change_password) return renderForcePassword(app);

  app.innerHTML = `
    <div class="shell">
      <nav class="bottomnav">
        <a class="navbrand" href="#/painel"><img src="/icon.svg" alt="" width="26" height="26"> ${esc(APP_NAME)}</a>
        ${ROUTES.map((r) => `<a href="#/${r.id}" class="${state.route === r.id ? 'on' : ''}"><span class="ico">${r.ico}</span><span class="lbl">${r.label}</span>${r.short ? `<span class="lbl-s">${r.short}</span>` : ''}${r.id === 'arquivos' && state.alerts?.length ? `<span class="badge" aria-label="${state.alerts.length} documentos faltando">${state.alerts.length}</span>` : ''}</a>`).join('')}
      </nav>
      <div class="content">
        <header class="topbar">${topbar()}</header>
        <main id="view"></main>
      </div>
    </div>`;
  bindTopbar();
  const view = $('#view');
  ({ painel: viewPainel, metas: viewMetas, insights: viewInsights, lancamentos: viewLancamentos, enviar: viewEnviar, arquivos: viewArquivos, ajustes: viewAjustes })[state.route](view);
}

function topbar() {
  const showFilters = ['painel', 'metas', 'lancamentos'].includes(state.route);
  const showOwner = showFilters || state.route === 'insights';
  const months = [...new Set([...state.months, state.month])].sort().reverse();
  return `
    <div class="topbar-desk">
      <div class="topbar-row" style="flex:1">
        <div class="brand mobile"><img src="/icon.svg" alt="" width="26" height="26">${esc(ROUTES.find((r) => r.id === state.route).label)}</div>
        <button class="iconbtn" id="gsearch" aria-label="${__('Buscar lançamento')}" title="${__('Buscar lançamento em todos os meses')}">🔍</button>
        ${
          showFilters
            ? `<div class="month-picker">
                <button data-m="-1" aria-label="${__('Mês anterior')}">‹</button>
                <select id="monthSel" aria-label="${__('Mês')}">${months.map((m) => `<option value="${m}" ${m === state.month ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}</select>
                <button data-m="1" aria-label="${__('Próximo mês')}">›</button>
              </div>`
            : ''
        }
      </div>
      ${
        showOwner
          ? `<div class="seg" role="tablist" aria-label="${__('Pessoa')}">
              <button class="${state.owner === 'all' ? 'on' : ''}" data-owner="all">👪 ${__('Família')}</button>
              ${state.users.map((u) => `<button class="${String(state.owner) === String(u.id) ? 'on' : ''}" data-owner="${u.id}"><span class="dot" style="background:${esc(u.color)}"></span>${esc(u.name)}</button>`).join('')}
            </div>`
          : ''
      }
    </div>`;
}

function bindTopbar() {
  $('#gsearch')?.addEventListener('click', () => {
    state.txFilters = { q: '', category: '', type: '', all: true };
    state.focusSearch = true;
    if (state.route === 'lancamentos') render();
    else location.hash = '#/lancamentos';
  });
  $$('[data-m]').forEach((b) =>
    b.addEventListener('click', () => {
      state.month = addMonths(state.month, Number(b.dataset.m));
      render();
    })
  );
  $('#monthSel')?.addEventListener('change', (e) => {
    state.month = e.target.value;
    render();
  });
  $$('[data-owner]').forEach((b) =>
    b.addEventListener('click', () => {
      state.owner = b.dataset.owner;
      store('fin.owner', state.owner);
      render();
    })
  );
}

// ---------- login ----------
function renderLogin(app) {
  app.innerHTML = `
    <div class="login">
      <form class="card" id="loginForm" autocomplete="on">
        <select id="loginLang" class="langsel" aria-label="Idioma / Language">${Object.entries(LOCALES).map(([v, l]) => `<option value="${v}" ${v === I18N.locale ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <img src="/icon.svg" alt="" width="44" height="44">
        <h1>${esc(APP_NAME)}</h1>
        <p class="muted small" style="margin-top:0">${__('Entre para ver o balanço da casa.')}</p>
        <label class="field"><span>${__('Usuário')}</span><input type="text" name="username" autocomplete="username" autocapitalize="none" required></label>
        <label class="field"><span>${__('Senha')}</span><input type="password" name="password" autocomplete="current-password" required></label>
        <div class="err-msg" id="loginErr"></div>
        <button class="btn block" type="submit">${__('Entrar')}</button>
      </form>
    </div>`;
  $('#loginLang').addEventListener('change', (e) => changeLocale(e.target.value));
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const btn = $('button', e.target);
    btn.disabled = true;
    try {
      await api('/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
      await boot();
    } catch (err) {
      $('#loginErr').textContent = err.message;
      btn.disabled = false;
    }
  });
}

// Primeiro acesso ou senha redefinida pelo admin: troca obrigatória antes de usar o app
function renderForcePassword(app) {
  app.innerHTML = `
    <div class="login">
      <form class="card" id="forcePw">
        <img src="/icon.svg" alt="" width="44" height="44">
        <h1>${__('Crie sua senha')}</h1>
        <p class="muted small" style="margin-top:0">${__('Olá')}, ${esc(state.user.name)}. ${__('A senha atual é temporária: escolha uma nova para continuar.')}</p>
        <label class="field"><span>${__('Senha temporária')}</span><input type="password" name="current" autocomplete="current-password" required></label>
        <label class="field"><span>${__('Nova senha (mín. 10 caracteres)')}</span><input type="password" name="next" autocomplete="new-password" minlength="10" required></label>
        <label class="field"><span>${__('Repita a nova senha')}</span><input type="password" name="again" autocomplete="new-password" minlength="10" required></label>
        <div class="err-msg" id="pwErr"></div>
        <button class="btn block" type="submit">${__('Salvar e entrar')}</button>
        <button class="btn ghost block" type="button" id="pwOut" style="margin-top:8px">${__('Sair')}</button>
      </form>
    </div>`;
  $('#pwOut').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    render();
  });
  $('#forcePw').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    if (fd.get('next') !== fd.get('again')) return ($('#pwErr').textContent = __('As senhas novas não são iguais.'));
    try {
      await api('/me/password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } });
      toast(__('Senha criada'));
      await boot();
    } catch (err) {
      $('#pwErr').textContent = err.message;
    }
  });
}

// ---------- painel ----------
async function viewPainel(view) {
  view.innerHTML = `<div class="empty">${__('Carregando')}…</div>`;
  if (!state.months.length) {
    view.innerHTML = `<div class="card empty"><div class="big">📤</div><p>${__('Nenhum extrato enviado ainda.')}</p><a class="btn" href="#/enviar">${__('Enviar extratos e faturas')}</a></div>`;
    return;
  }
  const [s, fut, cmp] = await Promise.all([
    api(`/summary?month=${state.month}&owner=${state.owner}${pfQuery()}`),
    api(`/future?owner=${state.owner}&months=12${pfQuery()}`),
    api(`/compare?month=${state.month}&owner=${state.owner}${pfQuery()}`),
  ]);
  const ownerName = state.owner === 'all' ? __('Família') : state.users.find((u) => String(u.id) === String(state.owner))?.name;
  const delta = s.prev.expense ? ((s.expense - s.prev.expense) / s.prev.expense) * 100 : null;
  const grouped = store('groupCats') !== '0';
  const cats = grouped ? groupCategories(s.byCategory) : s.byCategory.map((c) => ({ ...c, kids: [] }));
  const maxCat = Math.max(...cats.map((c) => c.total), 1);
  const maxEvo = Math.max(...s.evolution.map((e) => Math.max(e.income, e.expense)), 1);
  const totalMembers = s.byMember.reduce((a, m) => a + m.expense, 0) || 1;

  const monthAlerts = (state.alerts || []).filter((a) => a.month === s.month);
  view.innerHTML = `
    ${
      monthAlerts.length
        ? `<a class="banner" href="#/arquivos"><b>⚠ ${__('Os números de')} ${monthLabel(s.month, true)} ${__('estão incompletos')}</b>
            <ul>${monthAlerts.slice(0, 4).map((a) => `<li>${esc(a.title)}</li>`).join('')}${monthAlerts.length > 4 ? `<li>${__('e mais')} ${monthAlerts.length - 4}…</li>` : ''}</ul>
            <span class="small">${__('Ver documentos faltando')} ›</span></a>`
        : ''
    }
    ${
      s.projected?.n
        ? `<a class="banner info" href="#/lancamentos"><b>🗓️ ${monthLabel(s.month, true)} ${__('inclui lançamentos previstos')}</b>
            <span class="small">${s.projected.n} ${__('lançamentos futuros · saídas')} <b class="num">${brl(s.projected.expense)}</b>${s.projected.income ? ` · ${__('entradas')} <b class="num">${brl(s.projected.income)}</b>` : ''}. ${__('Parcelas de cartão já compradas e itens recorrentes, já somados nos totais e gráficos abaixo.')}</span>
            <span class="small">${__('Ver lançamentos')} ›</span></a>`
        : ''
    }
    ${painelFilters()}
    <div class="kpis">
      <button class="kpi click" data-entries="receita" aria-label="${__('Ver receitas em tabela')}"><div class="label"><span class="dot" style="background:var(--income)"></span>${__('Receitas')}${s.liquid ? __(' líquidas') : ''} <span class="go"><span class="go-t">${__('ver tabela')} </span>›</span></div><div class="value num">${brl(s.income)}</div><div class="delta">${s.projected?.income ? __('inclui {0} previsto', { 0: brl(s.projected.income) }) : monthLabel(s.month, true)}</div></button>
      <button class="kpi click" data-entries="despesa" aria-label="${__('Ver despesas em tabela')}"><div class="label"><span class="dot" style="background:var(--expense)"></span>${__('Despesas')} <span class="go"><span class="go-t">${__('ver tabela')} </span>›</span></div><div class="value num">${brl(s.expense)}</div>
        <div class="delta">${s.projected?.expense ? __('inclui {0} previsto · ', { 0: brl(s.projected.expense) }) : ''}${delta === null ? __('sem mês anterior') : __('{0} {1}% vs {2}', { 0: delta > 0 ? '▲' : '▼', 1: Math.abs(delta).toFixed(0), 2: monthLabel(addMonths(s.month, -1)) })}</div></button>
      <div class="kpi wide"><div class="label">${__('Saldo do mês')} · ${esc(ownerName)}</div><div class="value num" style="color:${s.balance >= 0 ? 'var(--pos-text)' : 'var(--danger)'}">${brl(s.balance)}</div>
        <div class="delta">${s.projected?.n ? (s.balance >= 0 ? __('deve sobrar no mês, com o previsto') : __('deve faltar no mês, com o previsto')) : s.balance >= 0 ? __('sobrou no mês') : __('faltou no mês')}</div></div>
      ${taxKpi(s)}
    </div>

    ${endingsCard(s)}
    ${channelCard(s)}
    <section class="card" style="margin-top:14px" id="cmpCard"></section>
    <div class="grid dash" style="margin-top:14px">
      <div class="grid">
        ${s.byCategory.length ? pieCard(cats, s.expense, grouped) : ''}
        <section class="card">
          <div class="cardhead"><h2>${__('Para onde foi o dinheiro')} <small>${cats.length} ${grouped ? __('grupos') : __('categorias')}</small></h2>
            <button class="linkbtn" id="toggleGroup">${grouped ? __('Ver todas as categorias') : __('Agrupar categorias')}</button></div>
          ${
            cats.length
              ? `<div class="hbars">${cats
                  .map(
                    (c) => `<button class="hbar" data-cat="${c.id}" title="${__('Ver lançamentos de {0}', { 0: esc(c.name) })}">
                      <span class="name">${esc(c.icon)} ${esc(c.name)}</span><span class="val num">${brl(c.total)}</span>
                      <span class="track"><span class="fill" style="display:block;width:${(c.total / maxCat) * 100}%"></span></span>
                      <span class="sub">${((c.total / (s.expense || 1)) * 100).toFixed(1).replace('.', ',')}% · ${c.n} ${__('lanç.')}${c.prev ? __(' · mês anterior {0}', { 0: brl(c.prev) }) : ''}</span>
                      ${c.kids.length > 1 ? `<span class="kids">${c.kids.map((k) => `<span>${esc(k.icon)} ${esc(k.name)} <b class="num">${brl(k.total)}</b></span>`).join('')}</span>` : ''}
                    </button>`
                  )
                  .join('')}</div>`
              : `<p class="muted">${__('Sem despesas neste mês.')}</p>`
          }
        </section>
      </div>
      <div class="grid">
        ${
          state.owner === 'all' && s.byMember.length
            ? `<section class="card"><h2>${__('Quem gastou')} <small>${__('despesas')}</small></h2><div class="members">
              ${s.byMember
                .map(
                  (m) => `<div class="member"><div class="top"><span><span class="dot" style="background:${esc(m.color)}"></span> ${esc(m.name)}</span>
                    <span class="num"><b>${brl(m.expense)}</b> <span class="muted small">${((m.expense / totalMembers) * 100).toFixed(0)}%</span></span></div>
                    <div class="track"><div class="fill" style="width:${(m.expense / totalMembers) * 100}%;background:${esc(m.color)}"></div></div>
                    <div class="muted small" style="margin-top:3px">${__('Receitas')} ${brl(m.income)}</div></div>`
                )
                .join('')}
              <p class="muted small" style="margin:0">${__('Pelo titular do cartão ou da conta. Ajuste a pessoa de um lançamento tocando nele.')}</p>
            </div></section>`
            : ''
        }
        <section class="card">
          <h2>${__('Evolução mensal')} <small>${__('últimos')} ${s.evolution.length} ${__('meses')}</small></h2>
          <div class="legend"><span><i style="background:var(--income)"></i>${__('Receitas')}</span><span><i style="background:var(--expense)"></i>${__('Despesas')}</span></div>
          <div class="evo" id="evo">
            ${s.evolution
              .map(
                (e, i) => `<div class="col ${e.m === s.month ? 'sel' : ''}" data-i="${i}" tabindex="0" aria-label="${monthLabel(e.m)}: receitas ${brl(e.income)}, despesas ${brl(e.expense)}">
                  <div class="bars"><div class="b" style="height:${(e.income / maxEvo) * 100}%;background:var(--income)"></div><div class="b" style="height:${(e.expense / maxEvo) * 100}%;background:var(--expense)"></div></div></div>`
              )
              .join('')}
          </div>
          <div class="evo-labels">${s.evolution.map((e) => `<span class="${e.m === s.month ? 'cur' : ''}">${monthShort(Number(e.m.slice(5)))}</span>`).join('')}</div>
          <div class="tip num" id="evoTip">${evoTip(s.evolution.find((e) => e.m === s.month))}</div>
          <details><summary>${__('Ver tabela')}</summary>
            <table class="simple num"><thead><tr><th>${__('Mês')}</th><th class="r">${__('Receitas')}</th><th class="r">${__('Despesas')}</th><th class="r">${__('Saldo')}</th></tr></thead>
            <tbody>${s.evolution.map((e) => `<tr><td>${monthLabel(e.m)}</td><td class="r">${brl(e.income)}</td><td class="r">${brl(e.expense)}</td><td class="r">${brl(e.income - e.expense)}</td></tr>`).join('')}</tbody></table>
          </details>
        </section>
        ${futureCard(fut)}
        ${
          s.cards.length
            ? `<section class="card"><h2>${__('Faturas com vencimento no mês')}</h2><div class="list">${s.cards
                .map((c) => `<div class="row" style="cursor:default"><div class="ic">💳</div><div class="main"><div class="title">${esc(c.account)}</div><div class="meta">${__('vence')} ${fmtDate(c.due_date)}</div></div><div class="amt num">${brl(c.amount_due)}</div></div>`)
                .join('')}</div></section>`
            : ''
        }
        <section class="card">
          <h2>${__('Onde mais gastou')}</h2>
          <div class="list">${
            s.topMerchants.map((m) => `<div class="row" data-q="${esc(m.name)}"><div class="main"><div class="title">${esc(m.name)}</div><div class="meta">${m.n} ${m.n > 1 ? __('compras') : __('compra')}</div></div><div class="amt num">${brl(m.total)}</div></div>`).join('') ||
            `<p class="muted">${__('Nada por aqui.')}</p>`
          }</div>
        </section>
        <section class="card">
          <h2>${__('Por conta e cartão')}</h2>
          <div class="list">${
            s.byAccount.map((a) => `<div class="row" style="cursor:default"><div class="main"><div class="title">${esc(a.account)}</div></div><div class="amt num">${brl(a.total)}</div></div>`).join('') || `<p class="muted">${__('Nada por aqui.')}</p>`
          }</div>
          ${s.installmentsNext.n ? `<p class="muted small" style="margin-bottom:0">${s.installmentsNext.n} ${__('compras parceladas continuam nos próximos meses')} (${brl(s.installmentsNext.total)} ${__('só neste mês).')}</p>` : ''}
        </section>
        ${
          s.incomeByCategory.length
            ? `<section class="card"><h2>${__('Receitas por origem')}</h2><div class="list">${s.incomeByCategory
                .map((c) => `<div class="row" data-cat="${c.id}"><div class="ic">${esc(c.icon)}</div><div class="main"><div class="title">${esc(c.name)}</div></div><div class="amt num pos">${brl(c.total)}</div></div>`)
                .join('')}</div></section>`
            : ''
        }
      </div>
    </div>
    <p class="muted small" style="margin-top:16px">${__('Cartões entram no mês de vencimento da fatura; contas, na data do lançamento. Pagamentos de fatura e transferências entre vocês não contam como despesa, para não somar duas vezes.')}</p>`;

  $$('[data-entries]', view).forEach((b) => b.addEventListener('click', () => openEntriesTable(b.dataset.entries)));
  $$('[data-fmonth]', view).forEach((b) =>
    b.addEventListener('click', () => {
      const m = fut.months.find((x) => x.m === b.dataset.fmonth);
      openFutureMonth(m);
    })
  );
  $('#addFin', view)?.addEventListener('click', () => openCommitment({ first_month: new Date().toISOString().slice(0, 7), owner_id: state.user.id, recurring: 1 }, () => render()));
  $$('[data-cid]', view).forEach((b) =>
    b.addEventListener('click', () => openCommitment(fut.commitments.find((c) => String(c.id) === b.dataset.cid), () => render()))
  );
  $$('[data-end]', view).forEach((b) => b.addEventListener('click', () => openEndings(s.endings[Number(b.dataset.end)], Number(b.dataset.end))));
  $('#toggleGroup', view)?.addEventListener('click', () => {
    store('groupCats', grouped ? '0' : '1');
    render();
  });
  bindPie(view);
  bindPainelFilters(view);
  $('#taxKpi', view)?.addEventListener('click', () => openTaxes(s));
  $$('[data-chan]', view).forEach((b) =>
    b.addEventListener('click', () => {
      Object.assign(state.txFilters, { channel: b.dataset.chan, type: 'despesa', all: false, q: '', category: '' });
      location.hash = '#/lancamentos';
    })
  );
  compareCard($('#cmpCard', view), cmp);
  $$('[data-cat]', view).forEach((b) =>
    b.addEventListener('click', () => {
      state.txFilters = { q: '', category: b.dataset.cat, type: '' };
      location.hash = '#/lancamentos';
    })
  );
  $$('[data-q]', view).forEach((b) =>
    b.addEventListener('click', () => {
      state.txFilters = { q: b.dataset.q.split(' ')[0], category: '', type: '' };
      location.hash = '#/lancamentos';
    })
  );
  $$('#evo .col', view).forEach((col) => {
    const show = () => {
      $$('#evo .col').forEach((c) => c.classList.remove('sel'));
      col.classList.add('sel');
      $('#evoTip').innerHTML = evoTip(s.evolution[col.dataset.i]);
    };
    col.addEventListener('mouseenter', show);
    col.addEventListener('focus', show);
    col.addEventListener('click', () => {
      state.month = s.evolution[col.dataset.i].m;
      render();
    });
  });
}

// Filtros do painel: rendas (múltipla escolha, todas marcadas por padrão) e tipo de despesa
const NATURES = [
  ['', __('Todas as despesas')],
  ['essencial', __('Essenciais')],
  ['conforto', __('Conforto')],
  ['outras', __('Outras')],
];
function painelFilters() {
  const srcs = state.sources.filter((s) => state.owner === 'all' || !s.owner_id || String(s.owner_id) === String(state.owner));
  const off = srcs.filter((s) => state.pf.exclude.includes(s.id));
  const label = (!srcs.length ? '' : off.length ? __('{0} de {1} rendas', { 0: srcs.length - off.length, 1: srcs.length }) : __('Todas as rendas')) + (state.pf.liquid ? ` · ${__('líquida')}` : '');
  const anyOn = off.length || state.pf.nature || state.pf.liquid;
  return `<div class="pfilters ${anyOn ? 'on' : ''}">
    ${
      srcs.length
        ? `<details class="msel" id="pfSrc"><summary>💼 ${label}</summary><div class="msel-box">
            <div class="liqseg" role="radiogroup" aria-label="${__('Renda bruta ou líquida')}">
              <label><input type="radio" name="pfLiq" value="0" ${state.pf.liquid ? '' : 'checked'}><span>${__('Bruta')}</span></label>
              <label><input type="radio" name="pfLiq" value="1" ${state.pf.liquid ? 'checked' : ''}><span>${__('Líquida')}</span></label>
            </div>
            <p class="muted small" style="margin:4px 0 10px">${__('Líquida: impostos, contador, descontos em folha e custos de trabalho de cada renda saem das despesas e são descontados da receita.')}</p>
            <p class="muted small" style="margin:0 0 6px">${__('Desmarque uma renda para tirar do painel a entrada e as despesas ligadas a ela.')}</p>
            ${srcs
              .map(
                (s) => `<label class="check"><input type="checkbox" data-src="${s.id}" ${state.pf.exclude.includes(s.id) ? '' : 'checked'}><span>${esc(s.name)}</span></label>`
              )
              .join('')}
            <a class="small" href="#/ajustes">${__('Editar rendas em Ajustes')}</a></div></details>`
        : ''
    }
    <button class="btn ghost sm docsbtn" id="docsBtn">📄 ${__('Documentos de')} ${monthLabel(state.month)}</button>
    <select id="pfNature" aria-label="${__('Tipo de despesa')}">${NATURES.map(([v, l]) => `<option value="${v}" ${v === state.pf.nature ? 'selected' : ''}>${l}</option>`).join('')}</select>
    ${anyOn ? `<button class="linkbtn small" id="pfClear">${__('Limpar filtros')}</button>` : ''}
  </div>`;
}
function bindPainelFilters(view) {
  const box = $('#pfSrc', view);
  let changed = false;
  $$('[data-src]', view).forEach((cb) =>
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.src);
      state.pf.exclude = cb.checked ? state.pf.exclude.filter((x) => x !== id) : [...new Set([...state.pf.exclude, id])];
      pfSave();
      changed = true;
    })
  );
  $$('input[name=pfLiq]', view).forEach((r) =>
    r.addEventListener('change', () => {
      state.pf.liquid = r.value === '1';
      pfSave();
      changed = true;
    })
  );
  // aplica ao fechar a lista (ou ao clicar fora), para dar para desmarcar várias de uma vez
  box?.addEventListener('toggle', () => !box.open && changed && render());
  const outside = (e) => {
    if (!box?.open || box.contains(e.target)) return;
    box.open = false;
  };
  if (bindPainelFilters.outside) document.removeEventListener('click', bindPainelFilters.outside);
  bindPainelFilters.outside = outside;
  document.addEventListener('click', outside);
  $('#docsBtn', view)?.addEventListener('click', () => openMonthDocs(state.month));
  $('#pfNature', view).addEventListener('change', (e) => {
    state.pf.nature = e.target.value;
    pfSave();
    render();
  });
  $('#pfClear', view)?.addEventListener('click', () => {
    state.pf = { exclude: [], nature: '', liquid: false };
    pfSave();
    render();
  });
}

// Impostos do mês: diretos + contador + embutidos nos preços (estimativa por categoria)
function taxKpi(s) {
  const t = s.taxes;
  if (!t) return '';
  const income = s.income + (s.liquid ? t.direct + t.accountant : 0); // na líquida a receita já vem descontada
  const pct = income > 0 ? __(' · {0}% das receitas', { 0: ((t.total / income) * 100).toFixed(0) }) : '';
  return `<button class="kpi click" id="taxKpi" aria-label="${__('Ver impostos do mês')}"><div class="label"><span class="dot" style="background:var(--s4)"></span>${__('Impostos')} <span class="go"><span class="go-t">${__('detalhes')} </span>›</span></div>
    <div class="value num">${brl(t.total)}</div>
    <div class="delta">${__('diretos')}${t.accountant ? __(' e contador') : ''} ${brl(t.direct + t.accountant)} · ${__('embutidos')} ~${brl(t.indirect)}${pct}</div></button>`;
}
function openTaxes(s) {
  const t = s.taxes;
  const rows = (list, withRate) =>
    list
      .map(
        (x) => `<tr><td class="desc">${esc(x.label)}</td>${withRate ? `<td class="r muted">${brl(x.base)}</td><td class="r muted">${Math.round(x.rate * 100)}%</td>` : ''}<td class="r">${brl(x.value)}</td></tr>`
      )
      .join('');
  const { el, close } = sheet(`
    <h3>${__('Impostos')} · ${monthLabel(s.month, true)}</h3>
    <p class="muted small" style="margin-top:4px">${__('Total')} <b class="num">${brl(t.total)}</b>: ${__('diretos')} ${brl(t.direct)} · ${__('contador')} ${brl(t.accountant)} · ${__('embutidos nos preços')} ~${brl(t.indirect)}.</p>
    ${t.items.direct.length ? `<h4 class="docsh">${__('Diretos')} <span class="muted small">${__('(pagos e descontados: Simples, DARF, INSS, IRRF, IOF, guias)')}</span></h4>
      <div class="table-wrap"><table class="simple num entries"><tbody>${rows(t.items.direct)}</tbody><tfoot><tr><td><b>${__('Total')}</b></td><td class="r"><b>${brl(t.direct)}</b></td></tr></tfoot></table></div>` : ''}
    ${t.items.accountant.length ? `<h4 class="docsh">${__('Contador')}</h4><div class="table-wrap"><table class="simple num entries"><tbody>${rows(t.items.accountant)}</tbody></table></div>` : ''}
    ${t.items.indirect.length ? `<h4 class="docsh">${__('Embutidos nos preços')} <span class="muted small">${__('(estimativa)')}</span></h4>
      <div class="table-wrap"><table class="simple num entries"><thead><tr><th>${__('Categoria / tipo')}</th><th class="r">${__('Gasto')}</th><th class="r">${__('Carga')}</th><th class="r">${__('Imposto')}</th></tr></thead>
      <tbody>${rows(t.items.indirect, true)}</tbody><tfoot><tr><td colspan="3"><b>${__('Total estimado')}</b></td><td class="r"><b>${brl(t.indirect)}</b></td></tr></tfoot></table></div>
      <p class="muted small">${__('Estimativa: aplica uma carga média aproximada de tributos (ICMS, PIS/Cofins, IPI, ISS) sobre o que foi gasto em cada categoria. Combustível, farmácia, eletrônicos e financiamentos usam carga própria, pelo nome da compra. Não vem de nota fiscal. Ajuste os percentuais em Ajustes › Impostos embutidos.')}</p>` : ''}
    <div class="actions" style="margin-top:12px"><a class="btn ghost sm" href="#/ajustes" id="taxAj">${__('Ajustar percentuais')}</a><button class="btn ghost sm" id="taxClose">${__('Fechar')}</button></div>`);
  el.classList.add('wide');
  $('#taxClose', el).addEventListener('click', close);
  $('#taxAj', el).addEventListener('click', close);
}

// ---------- telas Metas e Insights ----------
async function viewMetas(view) {
  view.innerHTML = `<div class="empty">${__('Carregando')}…</div>`;
  const list = await api(`/budgets?month=${state.month}&owner=${state.owner}`);
  view.innerHTML = budgetsCard(list, state.month).replace('style="margin-top:14px"', '');
  $$('[data-goals]', view).forEach((b) => b.addEventListener('click', () => openBudgets(() => render())));
}

async function viewInsights(view) {
  view.innerHTML = `<div class="empty">${__('Carregando')}…</div>`;
  const st = await api('/ai/status').catch(() => ({ enabled: false }));
  if (!st.enabled) {
    view.innerHTML = `<section class="card"><h2>💡 ${__('Insights')}</h2>
      <p class="muted small" style="margin:0">${__('A análise por IA está desligada neste servidor. Para ligar, defina')} <code>${__('FF_AI_PROVIDER')}</code> ${__('(Anthropic, API compatível com OpenAI, como um Ollama local, ou webhook). Veja o README.')}</p></section>
      <section class="card" style="margin-top:14px" id="aiUsage"></section>`;
    loadUsage($('#aiUsage', view));
    return;
  }
  await insightsPage(view);
}

// ---------- metas de gasto ----------
const GOAL_STATUS = { ok: ['✅', __('dentro da meta')], perto: ['⚠️', __('perto do limite')], estourou: ['🔴', 'estourou'] };
function budgetsCard(list, month) {
  if (!list.length)
    return `<section class="card" style="margin-top:14px"><div class="cardhead"><h2>🎯 ${__('Metas de gasto')}</h2><button class="linkbtn" data-goals>${__('Definir metas')}</button></div>
      <p class="muted small" style="margin:0">${__('Defina quanto quer gastar por mês em cada categoria (ex.: Restaurantes até R$ 400) e acompanhe aqui, com o previsto do mês.')}</p></section>`;
  const over = list.filter((b) => b.status === 'estourou').length;
  return `<section class="card" style="margin-top:14px">
    <div class="cardhead"><h2>🎯 ${__('Metas do mês')} <small>${monthLabel(month)}${over ? ` · ${over} ${over === 1 ? __('estourou') : __('estouraram')}` : ''}</small></h2><button class="linkbtn" data-goals>${__('Gerenciar metas')}</button></div>
    <div class="goals">${list
      .map((b) => {
        const max = Math.max(b.monthly_limit, b.total) || 1;
        const [ic, label] = GOAL_STATUS[b.status];
        return `<div class="goal ${b.status}">
          <div class="goal-top"><span>${esc(b.icon)} ${esc(b.name)}</span><span class="num"><b>${brl(b.total)}</b> <span class="muted small">${__('de')} ${brl(b.monthly_limit)}</span></span></div>
          <div class="goal-bar" role="img" aria-label="${__('{0}: {1}% da meta, {2}', { 0: esc(b.name), 1: b.pct, 2: label })}">
            <span class="real" style="width:${(b.spent / max) * 100}%"></span><span class="proj" style="width:${(b.projected / max) * 100}%"></span>
            <i class="limit" style="left:${(b.monthly_limit / max) * 100}%"></i></div>
          <div class="goal-sub muted small"><span>${ic} ${label} · ${String(b.pct).replace('.', ',')}%${b.projected ? __(' · inclui {0} previsto', { 0: brl(b.projected) }) : ''}${b.remaining >= 0 ? __(' · sobram {0}', { 0: brl(b.remaining) }) : __(' · {0} acima', { 0: brl(-b.remaining) })}</span>
            <span class="goal-hist" title="${__('Últimos meses')}">${b.history
              .slice(0, -1)
              .map((h) => `<span title="${monthLabel(h.m)}: ${brl(h.total)}">${monthShort(Number(h.m.slice(5)))} ${h.total ? GOAL_STATUS[h.status][0] : '–'}</span>`)
              .join('')}</span></div>
        </div>`;
      })
      .join('')}</div>
    <p class="muted small" style="margin:8px 0 0">${__('Barra cheia: gasto real · clara: previsto até o fim do mês (parcelas e recorrentes) · traço: a meta.')}</p>
  </section>`;
}

async function openBudgets(done) {
  const list = await api(`/budgets/suggestions?month=${state.month}&owner=${state.owner}`);
  const { el, close } = sheet(`
    <h3>${__('Metas de gasto por mês')}</h3>
    <p class="muted small" style="margin-top:4px">${__('Valor mensal por categoria principal (soma as subcategorias). A média é dos últimos 3 meses, para referência. Deixe em branco para não ter meta.')}</p>
    <form id="goalsForm"><div class="table-wrap"><table class="simple num entries"><thead><tr><th>${__('Categoria')}</th><th class="r">${__('Média 3 meses')}</th><th class="r">${__('Meta por mês')}</th></tr></thead><tbody>
      ${list
        .map(
          (c) => `<tr><td class="desc">${esc(c.icon)} ${esc(c.name)}</td><td class="r muted">${c.average ? brl(c.average) : '–'}</td>
            <td class="r"><input type="number" inputmode="decimal" min="0" step="10" class="goalin" data-goal="${c.category_id}" value="${c.limit ?? ''}" placeholder="${c.average ? Math.round(c.average) : ''}" aria-label="${__('Meta de {0}', { 0: esc(c.name) })}"></td></tr>`
        )
        .join('')}</tbody></table></div>
      <div class="actions" style="margin-top:12px"><button class="btn" type="submit">${__('Salvar metas')}</button><button class="btn ghost" type="button" id="goalsCancel">${__('Cancelar')}</button></div></form>`);
  el.classList.add('wide');
  $('#goalsCancel', el).addEventListener('click', close);
  $('#goalsForm', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const items = $$('[data-goal]', el).map((i) => ({ category_id: Number(i.dataset.goal), monthly_limit: i.value === '' ? 0 : Number(i.value) }));
    try {
      await api('/budgets', { method: 'PUT', body: { items } });
      toast(__('Metas salvas'));
      close();
      done();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- insights por IA ----------
const KIND_LABEL = { conta: __('Extratos'), cartao: __('Faturas'), holerite: __('Holerites'), manual: __('Lançamentos manuais') };
const usd = (v) => (v == null ? '–' : __('US$ {0}', { 0: Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 }) }));
const tokens = (v) => Number(v || 0).toLocaleString('pt-BR');

async function insightsPage(view) {
  const [opts, saved, lastR] = await Promise.all([
    api(`/insights/options?owner=${state.owner}`),
    api('/insights/saved').catch(() => []),
    api(`/insights?owner=${state.owner}`).catch(() => null),
  ]);
  const f = (state.insForm ??= { range: '3', from: '', to: '', category_id: '', account: '', goal_amount: '', goal_month: '', guidance: '' });
  const thisMonth = new Date().toISOString().slice(0, 7);
  view.innerHTML = `
    <section class="card">
      <h2>💡 ${__('Insights')} <small>${__('IA')}</small></h2>
      <form id="insForm" class="insform">
        <label class="field"><span>${__('Período')}</span><select name="range">
          ${[['3', __('Últimos 3 meses')], ['6', __('Últimos 6 meses')], ['12', __('Últimos 12 meses')], ['custom', __('Escolher de/até')]].map(([v, l]) => `<option value="${v}" ${f.range === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <div class="field insrange" ${f.range === 'custom' ? '' : 'style="display:none"'}><span>${__('De / até')}</span>
          <div class="filters"><input type="month" name="from" value="${esc(f.from || opts.min_month || '')}" min="${esc(opts.min_month || '')}" max="${esc(opts.max_month || thisMonth)}" aria-label="${__('De')}">
          <input type="month" name="to" value="${esc(f.to || opts.max_month || '')}" min="${esc(opts.min_month || '')}" max="${esc(opts.max_month || thisMonth)}" aria-label="${__('Até')}"></div></div>
        <label class="field"><span>${__('Categoria')}</span><select name="category_id"><option value="">${__('Todas')}</option>
          ${opts.categories.map((c) => `<option value="${c.id}" ${String(f.category_id) === String(c.id) ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>${__('Documento')}</span><select name="account"><option value="">${__('Todos os extratos e faturas')}</option>
          ${['conta', 'cartao', 'holerite', 'manual']
            .map((k) => {
              const list = opts.accounts.filter((x) => x.kind === k);
              return list.length ? `<optgroup label="${KIND_LABEL[k]}">${list.map((x) => `<option value="${esc(x.account)}" ${f.account === x.account ? 'selected' : ''}>${esc(x.account)}${x.owner ? ` · ${esc(x.owner)}` : ''}</option>`).join('')}</optgroup>` : '';
            })
            .join('')}</select></label>
        <div class="field"><span>${__('Objetivo (opcional)')}</span>
          <div class="filters"><input type="text" inputmode="decimal" name="goal_amount" value="${esc(f.goal_amount)}" placeholder="${__('Juntar R$ (ex.: 20.000)')}" aria-label="${__('Valor do objetivo')}">
          <input type="month" name="goal_month" value="${esc(f.goal_month)}" min="${thisMonth}" aria-label="${__('Até quando')}"></div></div>
        <label class="field insguide"><span>${__('Direcionamento (opcional)')}</span><textarea name="guidance" rows="2" maxlength="600" placeholder="${__('Ex.: quero economizar R$ 20 mil até o fim do ano sem cortar a escola das crianças')}">${esc(f.guidance)}</textarea></label>
        <div class="actions"><button class="btn" type="submit" id="insRun">${__('Gerar análise')}</button></div>
      </form>
      <p class="muted small" style="margin:6px 0 0">${__('Vão para a IA só totais por mês e por categoria e as maiores lojas (sem PIX nem nomes de pessoas), mais o seu direcionamento. As contas de economia e do objetivo são feitas pelo app.')}</p>
    </section>
    <section class="card" style="margin-top:14px" id="insResult"></section>
    <section class="card" style="margin-top:14px"><h2>${__('Análises salvas')} <small>${saved.length}</small></h2><div class="list" id="insSaved"></div></section>
    <section class="card" style="margin-top:14px" id="aiUsage"></section>`;

  const form = $('#insForm', view);
  const sync = () => ($('.insrange', form).style.display = form.range.value === 'custom' ? '' : 'none');
  form.range.addEventListener('change', sync);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    Object.assign(f, fd);
    const body = {
      owner: state.owner,
      ...(fd.range === 'custom' ? { from: fd.from, to: fd.to } : { months: Number(fd.range) }),
      category_id: fd.category_id || null,
      account: fd.account || null,
      goal_amount: fd.goal_amount || null,
      goal_month: fd.goal_month || null,
      guidance: fd.guidance || null,
    };
    const btn = $('#insRun', form);
    btn.disabled = true;
    btn.textContent = 'Analisando…';
    try {
      drawInsight($('#insResult', view), await api('/insights', { method: 'POST', body }), () => insightsPage(view));
      loadUsage($('#aiUsage', view));
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = __('Gerar análise');
    }
  });

  const savedBox = $('#insSaved', view);
  savedBox.innerHTML = saved.length
    ? saved
        .map(
          (x) => `<div class="row catrow"><div class="ic">📌</div><div class="main"><div class="title">${esc(x.title || __('Sem título'))}</div>
            <div class="sub muted small">${fmtDate(x.at.slice(0, 10))} · ${esc(insScope(x.params))}${x.created_by ? __(' · por {0}', { 0: esc(x.created_by) }) : ''}</div></div>
            <div class="catsels"><button class="btn ghost sm" data-insopen="${x.id}">${__('Ver')}</button><button class="btn ghost sm" data-insdel="${x.id}" aria-label="${__('Excluir')}">✕</button></div></div>`
        )
        .join('')
    : `<p class="muted small" style="margin:0">${__('Nenhuma ainda. Gere uma análise e toque em "Salvar" para rever depois.')}</p>`;
  $$('[data-insopen]', savedBox).forEach((b) =>
    b.addEventListener('click', async () => {
      drawInsight($('#insResult', view), await api(`/insights/${b.dataset.insopen}`), () => insightsPage(view));
      $('#insResult', view).scrollIntoView({ behavior: 'smooth' });
    })
  );
  $$('[data-insdel]', savedBox).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(__('Excluir esta análise salva?'))) return;
      try {
        await api(`/insights/${b.dataset.insdel}`, { method: 'DELETE' });
        insightsPage(view);
      } catch (err) {
        toast(err.message);
      }
    })
  );
  drawInsight($('#insResult', view), lastR, () => insightsPage(view));
  loadUsage($('#aiUsage', view));
}

function insScope(p) {
  if (!p) return '';
  return [
    `${monthLabel(p.from)} a ${monthLabel(p.to)}`,
    p.category && __('categoria {0}', { 0: p.category }),
    p.account && p.account,
    p.goal_amount && __('objetivo {0} até {1}', { 0: brl(p.goal_amount), 1: monthLabel(p.goal_month) }),
  ]
    .filter(Boolean)
    .join(' · ');
}

function drawInsight(box, r, reload) {
  if (!r) {
    box.innerHTML = `<p class="muted small" style="margin:0">${__('Escolha os filtros acima e gere a primeira análise.')}</p>`;
    return;
  }
  const g = r.goal;
  const hasGoal = Boolean(g);
  box.innerHTML = `
    <div class="cardhead"><h2>${r.saved ? `📌 ${esc(r.title || __('Análise salva'))}` : __('Resultado')} <small>${esc(insScope(r.params))}</small></h2>
      ${r.saved ? '' : `<button class="btn ghost sm" id="insSave">💾 ${__('Salvar')}</button>`}</div>
    <p class="muted small" style="margin:0 0 8px">${__('Gerado em')} ${fmtDate(r.at.slice(0, 10))} · ${r.params?.category || r.params?.account ? __('gasto médio no recorte {0} · ', { 0: brl(r.expense_avg) }) : __('renda média {0} · gasto médio {1} · ', { 0: brl(r.income_avg), 1: brl(r.expense_avg) })}${__('renda média da casa')} ${brl(r.household_income_avg)}</p>
    ${r.params?.guidance ? `<p class="muted small" style="margin:0 0 8px">${__('Direcionamento')}: “${esc(r.params.guidance)}”</p>` : ''}
    <p style="margin:0 0 8px">${esc(r.summary)}</p>
    ${r.highlights.length ? `<ul class="inslist">${r.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul>` : ''}
    ${
      hasGoal
        ? `<div class="goalbox ${g.coverage >= 100 ? 'ok' : 'short'}">
            <b>🎯 ${__('Objetivo')}: ${brl(g.amount)} ${__('até')} ${monthLabel(g.until)}</b> <span class="muted small">(${g.months_left} ${g.months_left === 1 ? __('mês') : __('meses')})</span>
            <div class="goal-bar" role="img" aria-label="${__('Sugestões cobrem {0}% do objetivo', { 0: g.coverage })}"><span class="real" style="width:${Math.min(100, g.coverage)}%"></span></div>
            <div class="small">${__('Precisa sobrar')} <b>${brl(g.needed_monthly)}/${__('mês')}</b>. ${__('As sugestões abaixo juntam')} <b>${brl(g.reached)}</b> ${__('no prazo')}: ${g.coverage >= 100 ? '✅' : '⚠️'} ${String(g.coverage).replace('.', ',')}% ${__('do objetivo.')}</div>
            ${g.feedback ? `<p class="small" style="margin:6px 0 0">${esc(g.feedback)}</p>` : ''}</div>`
        : ''
    }
    ${r.warnings.length ? `<div class="banner" style="margin:8px 0"><b>⚠ ${__('Atenção')}</b><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    ${
      r.savings.length
        ? `<h4 class="docsh">${__('Onde dá para economizar')}</h4>
      <div class="table-wrap"><table class="simple num entries"><thead><tr><th>${__('Categoria')}</th><th class="r">${__('Média/mês')}</th><th class="r">${__('Sugerido')}</th><th class="r">${__('Economia/mês')}</th><th class="r">${__('3 meses')}</th><th class="r">${__('6 meses')}</th><th class="r">${__('12 meses')}</th>${hasGoal ? `<th class="r">${__('Até o prazo')}</th>` : ''}<th></th></tr></thead>
      <tbody>${r.savings
        .map(
          (x, i) => `<tr><td class="desc"><b>${esc(x.category)}</b><div class="muted small">${esc(x.reason)}</div>${x.actions.length ? `<ul class="inslist small">${x.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}</td>
            <td class="r">${brl(x.average)}</td><td class="r">${brl(x.target)}</td><td class="r"><b>${brl(x.monthly)}</b></td><td class="r">${brl(x.in3)}</td><td class="r">${brl(x.in6)}</td><td class="r">${brl(x.in12)}</td>${hasGoal ? `<td class="r">${brl(x.until_goal)}</td>` : ''}
            <td><button class="btn ghost sm" data-usegoal="${i}" title="${__('Criar meta com o valor sugerido')}">${__('Usar como meta')}</button></td></tr>`
        )
        .join('')}</tbody>
      <tfoot><tr><td><b>${__('Total')}</b></td><td></td><td></td><td class="r"><b>${brl(r.total.monthly)}</b></td><td class="r"><b>${brl(r.total.in3)}</b></td><td class="r"><b>${brl(r.total.in6)}</b></td><td class="r"><b>${brl(r.total.in12)}</b></td>${hasGoal ? `<td class="r"><b>${brl(r.total.until_goal)}</b></td>` : ''}<td></td></tr></tfoot></table></div>`
        : ''
    }
    <p class="muted small" style="margin:8px 0 0">${__('Sugestões geradas por IA a partir dos seus totais: confira antes de seguir. Economia = média do período − valor sugerido.')}</p>`;
  $('#insSave', box)?.addEventListener('click', async () => {
    const title = prompt(__('Nome para esta análise:'), insScope(r.params));
    if (title === null) return;
    try {
      await api(`/insights/${r.id}`, { method: 'PATCH', body: { title } });
      toast(__('Análise salva'));
      reload();
    } catch (err) {
      toast(err.message);
    }
  });
  $$('[data-usegoal]', box).forEach((b) =>
    b.addEventListener('click', async () => {
      const x = r.savings[Number(b.dataset.usegoal)];
      const cat = state.categories.find((c) => c.name === x.category);
      if (!cat) return toast(__('Categoria não encontrada.'));
      try {
        await api('/budgets', { method: 'PUT', body: { items: [{ category_id: cat.id, monthly_limit: x.target }] } });
        toast(__('Meta de {0}: {1} por mês', { 0: x.category, 1: brl(x.target) }));
      } catch (err) {
        toast(err.message);
      }
    })
  );
}

// Uso de IA: por ação, período e total
function loadUsage(box, range = state.aiUsageRange || 'month') {
  state.aiUsageRange = range;
  const today = new Date().toISOString().slice(0, 10);
  const ago = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
  const RANGES = { month: [__('Este mês'), `${today.slice(0, 8)}01`, today], d30: [__('Últimos 30 dias'), ago(30), today], d90: [__('Últimos 90 dias'), ago(90), today], all: [__('Tudo'), '', ''] };
  const [, from, to] = RANGES[range];
  api(`/ai/usage?from=${from}&to=${to}`).then((u) => {
    const brlOf = (v) => (u.usd_brl && v != null ? ` <span class="muted small">(${brl(v * u.usd_brl)})</span>` : '');
    const ACTION = { regras: __('🏷️ Regras automáticas'), insights: __('💡 Insights'), extrator: __('🧩 Criar leitor'), outro: __('Outros') };
    const rows = (list, key, label) =>
      list
        .map((x) => `<tr><td>${label(x[key])}</td><td class="r">${x.calls}${x.failed ? ` <span class="muted small">(${x.failed} ${__('com erro)')}</span>` : ''}</td><td class="r">${tokens(x.input_tokens)}</td><td class="r">${tokens(x.output_tokens)}</td><td class="r">${usd(x.cost_usd)}${brlOf(x.cost_usd)}</td></tr>`)
        .join('');
    const t = u.total;
    box.innerHTML = `
      <div class="cardhead"><h2>🧮 ${__('Uso de IA')} <small>${t.calls} ${t.calls === 1 ? __('chamada') : __('chamadas')}</small></h2>
        <select id="aiUsageRange" class="cmpsel" aria-label="${__('Período')}">${Object.entries(RANGES).map(([k, [l]]) => `<option value="${k}" ${k === range ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="kpis usagek">
        <div class="kpi"><div class="label">${__('Custo no período')}</div><div class="value num">${usd(t.cost_usd || 0)}</div><div class="delta">${u.usd_brl ? __('≈ {0} (câmbio {1})', { 0: brl((t.cost_usd || 0) * u.usd_brl), 1: String(u.usd_brl).replace('.', ',') }) : __('em dólar')}</div></div>
        <div class="kpi"><div class="label">${__('Tokens enviados')}</div><div class="value num">${tokens(t.input_tokens)}</div><div class="delta">${__('entrada')}</div></div>
        <div class="kpi"><div class="label">${__('Tokens recebidos')}</div><div class="value num">${tokens(t.output_tokens)}</div><div class="delta">${__('saída, inclui raciocínio')}</div></div>
      </div>
      ${
        t.calls
          ? `<h4 class="docsh">${__('Por ação')}</h4><div class="table-wrap"><table class="simple num entries"><thead><tr><th>${__('Ação')}</th><th class="r">${__('Chamadas')}</th><th class="r">${__('Entrada')}</th><th class="r">${__('Saída')}</th><th class="r">${__('Custo')}</th></tr></thead><tbody>${rows(u.by_action, 'action', (a) => ACTION[a] || esc(a))}</tbody></table></div>
             <h4 class="docsh">${__('Por mês')}</h4><div class="table-wrap"><table class="simple num entries"><thead><tr><th>${__('Mês')}</th><th class="r">${__('Chamadas')}</th><th class="r">${__('Entrada')}</th><th class="r">${__('Saída')}</th><th class="r">${__('Custo')}</th></tr></thead><tbody>${rows(u.by_month, 'month', (m) => monthLabel(m))}</tbody></table></div>`
          : `<p class="muted small">${__('Nenhuma chamada à IA nesse período.')}</p>`
      }
      <p class="muted small" style="margin:8px 0 0">${
        u.price
          ? __('Custo estimado pelos tokens: {0} a {1} (entrada) e {2} (saída) por milhão de tokens, {3}. Confira no painel do provedor; ajuste com FF_AI_PRICE_INPUT/OUTPUT.', { 0: esc(u.price.model), 1: usd(u.price.input), 2: usd(u.price.output), 3: esc(__(u.price.source)) })
          : __('Custo informado pelo webhook (quando ele devolve "usage").')
      }${t.without_price ? __(' {0} chamadas sem preço.', { 0: t.without_price }) : ''}</p>`;
    $('#aiUsageRange', box).addEventListener('change', (e) => loadUsage(box, e.target.value));
  }).catch(() => (box.innerHTML = ''));
}

// Online x presencial: de onde veio a dedução
const CHAN_WHY = { manual: __('marcado por você'), loja: __('regra desta loja'), 'cartão': __('pelo tipo do cartão'), nome: __('pelo nome da loja'), 'provável': __('sem pista; cartão misto') };
const chanWhy = (t) => CHAN_WHY[t.channel_how] || '';
const chanTitle = (t) => `${t.channel === 'online' ? __('Online') : __('Presencial')} · ${chanWhy(t)}`;

function channelCard(s) {
  const b = s.byChannel;
  if (!b || !(b.online + b.presencial)) return '';
  const tot = b.online + b.presencial;
  const pct = (v) => Math.round((v / tot) * 100);
  return `<section class="card" style="margin-top:14px">
    <h2>${__('Compras no cartão')} <small>${__('online x presencial')}</small></h2>
    <div class="chanbar" role="img" aria-label="Online ${pct(b.online)}%, presencial ${pct(b.presencial)}%">
      <span style="width:${pct(b.online)}%;background:var(--s1)"></span><span style="width:${pct(b.presencial)}%;background:var(--s3)"></span></div>
    <div class="chanlegend">
      <button class="linkbtn" data-chan="online"><i style="background:var(--s1)"></i>🌐 ${__('Online')} <b class="num">${brl(b.online)}</b> <span class="muted small">${pct(b.online)}% · ${b.n.online} ${__('compras')}</span></button>
      <button class="linkbtn" data-chan="presencial"><i style="background:var(--s3)"></i>🏪 ${__('Presencial')} <b class="num">${brl(b.presencial)}</b> <span class="muted small">${pct(b.presencial)}% · ${b.n.presencial} ${__('compras')}</span></button>
    </div>
    <p class="muted small" style="margin:6px 0 0">${__('As faturas não dizem onde foi a compra: vem do tipo do cartão (Ajustes › Cartões) e do nome da loja. Corrija tocando na compra.')}</p>
  </section>`;
}

// Documentos do mês: enviados e os que provavelmente ainda faltam
const DOC_ICON = { conta: '🏦', cartao: '💳', holerite: '🧾' };
async function openMonthDocs(month) {
  const d = await api(`/docs?month=${month}`);
  const falta = d.missing.filter((x) => x.status === 'falta');
  const aguarda = d.missing.filter((x) => x.status !== 'falta');
  const row = (x, extra) => `<div class="row" style="cursor:default;align-items:flex-start"><div class="ic">${DOC_ICON[x.kind] || '📄'}</div>
    <div class="main"><div class="title">${esc(x.account)}${x.owner ? ` <span class="muted small">· ${esc(x.owner)}</span>` : ''}</div>
    <div class="sub muted small">${extra}</div></div></div>`;
  const section = (title, list, fn) => (list.length ? `<h4 class="docsh">${title} <span class="muted small">(${list.length})</span></h4><div class="list">${list.map(fn).join('')}</div>` : '');
  const { el, close } = sheet(`
    <h3>${__('Documentos de')} ${monthLabel(month, true)}</h3>
    <p class="muted small" style="margin-top:4px">${__('Pelo que vocês costumam enviar: extratos das contas, faturas dos cartões e holerites.')}</p>
    ${section(__('⚠️ Faltam enviar'), falta, (x) => row(x, `${esc(x.when)}${x.detail ? `<br>${esc(x.detail)}` : ''}`))}
    ${section(__('⏳ Ainda não chegaram'), aguarda, (x) => row(x, esc(x.when)))}
    ${section(__('✅ Enviados'), d.sent, (x) => row(x, `${esc(x.note)}${x.total ? ` · ${brl(x.total)}` : ''}<br><span class="docfile">${esc(x.filename)}</span>`))}
    ${!d.sent.length && !d.missing.length ? `<p class="muted">${__('Nada enviado nem esperado para esse mês.')}</p>` : ''}
    <div class="actions" style="margin-top:12px"><a class="btn sm" href="#/enviar" id="docsSend">📤 ${__('Enviar documentos')}</a><button class="btn ghost sm" id="docsClose">${__('Fechar')}</button></div>`);
  el.classList.add('wide');
  $('#docsClose', el).addEventListener('click', close);
  $('#docsSend', el).addEventListener('click', close);
}

// Parcelas que acabaram no mês anterior, acabam neste e no próximo: quanto fica livre por mês
const ENDING_LABEL = [__('Acabaram em'), __('Acabam em'), __('Acabam em')];
function endingsCard(s) {
  if (!s.endings || !s.endings.some((e) => e.items.length)) return '';
  return `<section class="card" style="margin-top:14px">
    <h2>${__('Contas que terminam')} <small>${__('parcelas e financiamentos na última parcela')}</small></h2>
    <div class="endings">${s.endings
      .map(
        (e, i) => `<button class="ending ${i === 1 ? 'cur' : ''}" data-end="${i}" ${e.items.length ? '' : 'disabled'}>
          <span class="label">${ENDING_LABEL[i]} ${monthLabel(e.m)}</span>
          <span class="value num">${brl(e.total)}</span>
          <span class="sub">${e.items.length ? `${e.items.length === 1 ? __('{0} conta que termina', { 0: 1 }) : __('{0} contas que terminam', { 0: e.items.length })} · ${i === 0 ? __('já livre') : __('livre a partir de {0}', { 0: monthLabel(addMonths(e.m, 1)) })}` : __('nenhuma')}</span>
        </button>`
      )
      .join('')}</div>
  </section>`;
}

function openEndings(e, i) {
  if (!e?.items.length) return;
  const { el, close } = sheet(`
    <h3>${ENDING_LABEL[i]} ${monthLabel(e.m, true)}</h3>
    <p class="muted small" style="margin-top:4px">${__('Última parcela em')} ${monthLabel(e.m, true)}: ${__('a partir de')} ${monthLabel(addMonths(e.m, 1), true)} ${__('sobram')} <b class="num">${brl(e.total)}</b> ${__('por mês.')}</p>
    <div class="table-wrap"><table class="simple num entries"><thead><tr><th>${__('Conta')}</th><th>${__('Parcela')}</th>${state.owner === 'all' ? `<th>${__('Pessoa')}</th>` : ''}<th>${__('Onde')}</th><th class="r">${__('Valor')}</th></tr></thead>
    <tbody>${e.items
      .map(
        (x) => `<tr><td class="desc">${esc(x.description)}${x.projected ? ` <span class="pill proj">${__('previsto')}</span>` : ''}</td><td>${esc(x.installment || '')}</td>${state.owner === 'all' ? `<td>${esc(x.owner || '')}</td>` : ''}<td class="muted">${esc(x.account || '')}</td><td class="r">${brl(x.amount)}</td></tr>`
      )
      .join('')}</tbody>
    <tfoot><tr><td colspan="${state.owner === 'all' ? 4 : 3}"><b>${__('Total por mês')}</b></td><td class="r"><b>${brl(e.total)}</b></td></tr></tfoot></table></div>
    <div class="actions" style="margin-top:12px"><button class="btn ghost sm" id="endclose">${__('Fechar')}</button></div>`);
  el.classList.add('wide');
  $('#endclose', el).addEventListener('click', close);
}

const commonPrefix = (a, b) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
};

// Comparar mês anterior / atual / próximo: todas as despesas, todas as receitas ou uma categoria (até o lançamento)
function compareCard(box, cmp) {
  const sel = store('cmpSel') || 'despesa';
  const grouped = store('groupCats') !== '0';
  const isKind = sel === 'despesa' || sel === 'receita';
  const catId = isKind ? null : Number(sel);
  const cat = catId && catById(catId);
  if (!isKind && !cat) return store('cmpSel', 'despesa'), compareCard(box, cmp);
  const kind = isKind ? sel : cat.kind;
  const inCat = (it) => it.category_id === catId || catById(it.category_id)?.parent_id === catId;

  let rows;
  if (isKind) {
    // uma linha por categoria (ou grupo); tocar abre a categoria
    const map = new Map();
    for (const it of cmp.items.filter((x) => x.kind === kind)) {
      const c = (grouped ? catGroup(it.category_id) : catById(it.category_id)) || { id: it.category_id, name: __('Sem categoria'), icon: '•' };
      const r = map.get(c.id) || { id: c.id, label: `${c.icon} ${c.name}`, values: [0, 0, 0], projected: [0, 0, 0] };
      it.values.forEach((v, i) => ((r.values[i] += v), it.projected[i] && (r.projected[i] = 1)));
      map.set(c.id, r);
    }
    rows = [...map.values()];
  } else {
    // mesmo estabelecimento em subcategorias diferentes (ex.: Saúde num mês, Planos no outro) fica numa linha só
    const map = new Map();
    for (const it of cmp.items.filter(inCat)) {
      const r = map.get(it.key) || { label: it.description, subs: new Set(), values: [0, 0, 0], projected: [0, 0, 0] };
      if (it.category_id !== catId) r.subs.add(catById(it.category_id)?.name);
      if (/ /.test(it.description) && !/ /.test(r.label)) r.label = it.description;
      it.values.forEach((v, i) => ((r.values[i] += v), it.projected[i] && (r.projected[i] = 1)));
      map.set(it.key, r);
    }
    // o cartão muda o nome do mesmo lugar ("BARBEARIA DO ZE" x "BarbeariaDoZeCAMPINASBR"):
    // junta nomes parecidos, sem os prefixos genéricos de PIX/pagamento
    const core = (k) => {
      const c = k.replace(/^(PAGAMENTOCOM(CODIGO)?(QR)?PIX|PAGAMENTOPIX|PIXQRCODEESTATICODES|PIX(ENVIADO|RECEBIDO)(DES|REM)?|PIXTRANSF|TRANSFERENCIA|DESCONTOEMFOLHA|SALARIOBRUTO|LIBERACAODEDINHEIRO|PAGAMENTO|COMPRA)/, '');
      // marketplace: a loja é o que vem depois do "*" (MERCADOLIVRE*BRUNO x MERCADOLIVRE*MAXIMALOJA)
      const m = /^(MERCADOLIVRE|MERCADOPAGO|PAGSEGURO|PAYPAL|EBANX|MP|PG)\*(.+)$/.exec(c);
      return m ? m[2] : c;
    };
    // parecidos: o menor nome inteiro (mín. 10 letras) é começo do outro, ou os dois começam iguais por 12+ letras
    const alike = (a, b) => Math.min(a.length, b.length) >= 10 && commonPrefix(a, b) >= Math.min(12, a.length, b.length);
    const merged = [];
    for (const [k, r] of map) {
      const c = core(k);
      const same = merged.find((m) => m.cores.some((x) => alike(x, c)));
      if (!same) {
        merged.push({ ...r, cores: [c] });
        continue;
      }
      same.cores.push(c);
      r.subs.forEach((x) => same.subs.add(x));
      r.values.forEach((v, i) => ((same.values[i] += v), r.projected[i] && (same.projected[i] = 1)));
      if (!same.alias) same.alias = r.label;
    }
    rows = merged.map((r) => ({ ...r, label: r.alias ? `${r.label} / ${r.alias}` : r.label, sub: [...r.subs].filter(Boolean).join(', ') }));
  }
  rows.sort((a, b) => b.values[1] - a.values[1] || b.values[2] - a.values[2] || b.values[0] - a.values[0]);
  const totals = [0, 1, 2].map((i) => rows.reduce((a, r) => a + r.values[i], 0));
  const LIMIT = 25;
  const shown = rows.slice(0, LIMIT);
  if (rows.length > LIMIT) {
    const rest = rows.slice(LIMIT);
    shown.push({ label: __('Demais ({0})', { 0: rest.length }), values: [0, 1, 2].map((i) => rest.reduce((a, r) => a + r.values[i], 0)), projected: [0, 0, 0] });
  }
  // despesa subindo é ruim; receita subindo é boa
  const diff = (a, b) => {
    if (Math.abs(b - a) < 0.005) return '<span class="muted">=</span>';
    const up = b > a;
    const bad = kind === 'despesa' ? up : !up;
    const pct = a ? `${Math.abs(((b - a) / a) * 100).toFixed(0)}%` : 'novo';
    return `<span class="cmpd ${bad ? 'bad' : 'good'}">${up ? '▲' : '▼'} ${pct}</span>`;
  };
  const cell = (r, i) =>
    `<td class="r${i === 1 ? ' cur' : ''}">${r.values[i] ? brl(r.values[i]) : '<span class="muted">–</span>'}${r.projected[i] ? ` <span class="pill proj" title="${__('inclui previsto')}">${__('prev.')}</span>` : ''}</td>`;
  const opt = (v, label, extra = '') => `<option value="${v}" ${String(v) === sel ? 'selected' : ''} ${extra}>${label}</option>`;
  const catOptions = (k) => catsOrdered(k).map((c) => opt(c.id, `${c.parent_id ? '\u00a0\u00a0\u00a0↳ ' : ''}${esc(c.icon)} ${esc(c.name)}`)).join('');

  box.innerHTML = `
    <div class="cardhead"><h2>${__('Comparar meses')} <small>${__('com o previsto')}</small></h2>
      <select id="cmpSel" class="cmpsel" aria-label="${__('O que comparar')}">
        ${opt('despesa', __('Todas as despesas'))}${opt('receita', __('Todas as receitas'))}
        <optgroup label="Despesa específica">${catOptions('despesa')}</optgroup>
        <optgroup label="Receita específica">${catOptions('receita')}</optgroup>
      </select></div>
    ${!isKind ? `<button class="linkbtn small" id="cmpBack">‹ ${__('Todas as')} ${kind === 'despesa' ? __('despesas') : __('receitas')}</button>` : ''}
    ${
      rows.length
        ? `<div class="table-wrap"><table class="simple num cmp"><thead><tr><th>${isKind ? (grouped ? __('Grupo') : __('Categoria')) : __('Lançamento')}</th>
            ${cmp.months.map((m, i) => `<th class="r${i === 1 ? ' cur' : ''}">${monthLabel(m)}${i === 0 ? ` <small>${__('anterior')}</small>` : i === 1 ? ` <small>${__('atual')}</small>` : ` <small>${__('próximo')}</small>`}</th>`).join('')}
            <th class="r">${__('Atual x anterior')}</th></tr></thead>
          <tbody>${shown
            .map(
              (r) => `<tr ${r.id ? `data-cmp="${r.id}" class="click" tabindex="0" title="${__('Comparar só esta categoria')}"` : ''}><td class="desc" title="${esc(r.label)}${r.sub ? ` · ${esc(r.sub)}` : ''}">${esc(r.label)}${r.sub ? ` <span class="muted small">${esc(r.sub)}</span>` : ''}</td>
                ${[0, 1, 2].map((i) => cell(r, i)).join('')}<td class="r">${diff(r.values[0], r.values[1])}</td></tr>`
            )
            .join('')}</tbody>
          <tfoot><tr><td><b>${__('Total')}</b></td>${totals.map((v, i) => `<td class="r${i === 1 ? ' cur' : ''}"><b>${brl(v)}</b></td>`).join('')}<td class="r">${diff(totals[0], totals[1])}</td></tr></tfoot></table></div>
          <p class="muted small" style="margin:8px 0 0">${__('"prev." = inclui lançamento previsto (parcela a vencer ou recorrente).')}${isKind ? __(' Toque numa linha para ver os lançamentos dela.') : ''}</p>`
        : `<p class="muted">${__('Nada nesses três meses')}${cat ? __(' em {0}', { 0: esc(cat.name) }) : ''}.</p>`
    }`;
  const go = (v) => (store('cmpSel', String(v)), compareCard(box, cmp));
  $('#cmpSel', box).addEventListener('change', (e) => go(e.target.value));
  $('#cmpBack', box)?.addEventListener('click', () => go(kind));
  $$('[data-cmp]', box).forEach((tr) => {
    tr.addEventListener('click', () => go(tr.dataset.cmp));
    tr.addEventListener('keydown', (e) => e.key === 'Enter' && go(tr.dataset.cmp));
  });
}

// Soma as categorias no grupo (categoria-mãe); subcategorias ficam em kids
function groupCategories(rows) {
  const map = new Map();
  for (const r of rows) {
    const g = catGroup(r.id) || r;
    const cur = map.get(g.id) || { id: g.id, name: g.name, icon: g.icon, total: 0, prev: 0, n: 0, kids: [] };
    cur.total += r.total;
    cur.prev += r.prev || 0;
    cur.n += r.n;
    cur.kids.push(r);
    map.set(g.id, cur);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

// Pizza (rosca) das despesas: 7 maiores + "Outros", cores em ordem fixa
function pieCard(cats, total, grouped) {
  const top = cats.slice(0, 7).map((c, i) => ({ ...c, color: `var(--s${i + 1})` }));
  const rest = cats.slice(7);
  if (rest.length) top.push({ id: null, name: __('Demais categorias ({0})', { 0: rest.length }), icon: '•', total: rest.reduce((a, c) => a + c.total, 0), color: 'var(--s8)', others: rest.map((c) => c.name) });
  const sum = top.reduce((a, c) => a + c.total, 0) || 1;
  const R = 80, r = 50, C = 84;
  let ang = -Math.PI / 2;
  const pt = (rad, a) => `${(C + rad * Math.cos(a)).toFixed(2)} ${(C + rad * Math.sin(a)).toFixed(2)}`;
  const paths = top
    .map((c, i) => {
      const frac = c.total / sum;
      const a0 = ang, a1 = ang + frac * 2 * Math.PI;
      ang = a1;
      const pct = `${(frac * 100).toFixed(1).replace('.', ',')}%`;
      const label = `${c.name}: ${brl(c.total)} (${pct})`;
      if (frac > 0.9999) return `<path data-pi="${i}" d="M ${pt(R, -Math.PI / 2)} A ${R} ${R} 0 1 1 ${pt(R, Math.PI * 1.5 - 0.0001)} L ${pt(r, Math.PI * 1.5 - 0.0001)} A ${r} ${r} 0 1 0 ${pt(r, -Math.PI / 2)} Z" fill="${c.color}"><title>${esc(label)}</title></path>`;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      return `<path data-pi="${i}" d="M ${pt(R, a0)} A ${R} ${R} 0 ${big} 1 ${pt(R, a1)} L ${pt(r, a1)} A ${r} ${r} 0 ${big} 0 ${pt(r, a0)} Z" fill="${c.color}"><title>${esc(label)}</title></path>`;
    })
    .join('');
  return `<section class="card">
    <h2>${__('Divisão das despesas')} <small>${grouped ? __('por grupo') : __('por categoria')}</small></h2>
    <div class="pie" id="pie">
      <svg viewBox="0 0 168 168" role="img" aria-label="${__('Gráfico de pizza das despesas do mês')}">${paths}
        <text x="84" y="82" text-anchor="middle" class="center-v num" id="pieV">${esc(brlShort(total))}</text>
        <text x="84" y="98" text-anchor="middle" class="center-l" id="pieL">${__('despesas')}</text></svg>
      <div class="plegend">${top
        .map(
          (c, i) => `<button data-pi="${i}" ${c.id ? `data-cat="${c.id}"` : ''} title="${c.others ? esc(c.others.join(', ')) : __('Ver lançamentos de {0}', { 0: esc(c.name) })}"><i style="background:${c.color}"></i>
            <span class="name">${esc(c.icon)} ${esc(c.name)}</span><span class="num">${brl(c.total)}</span><span class="pct num">${((c.total / sum) * 100).toFixed(0)}%</span></button>`
        )
        .join('')}</div>
    </div>
  </section>`;
}

// Destaca a fatia e mostra valor e % no centro ao passar o mouse ou focar na legenda
function bindPie(view) {
  const pie = $('#pie', view);
  if (!pie) return;
  const v = $('#pieV', pie), l = $('#pieL', pie);
  const v0 = v.textContent, l0 = l.textContent;
  const items = $$('.plegend button', pie);
  const on = (i) => {
    pie.classList.add('focus');
    $$('path', pie).forEach((p) => p.classList.toggle('on', p.dataset.pi === i));
    const b = items.find((x) => x.dataset.pi === i);
    v.textContent = b.querySelector('.pct').textContent;
    l.textContent = b.querySelector('.name').textContent.trim().slice(0, 22);
  };
  const off = () => {
    pie.classList.remove('focus');
    $$('path', pie).forEach((p) => p.classList.remove('on'));
    v.textContent = v0;
    l.textContent = l0;
  };
  $$('[data-pi]', pie).forEach((el) => {
    el.addEventListener('mouseenter', () => on(el.dataset.pi));
    el.addEventListener('focus', () => on(el.dataset.pi));
    el.addEventListener('mouseleave', off);
    el.addEventListener('blur', off);
  });
  $$('path[data-pi]', pie).forEach((p) => p.addEventListener('click', () => items.find((x) => x.dataset.pi === p.dataset.pi)?.click()));
}

const commIcon = (c) => (c.direction === 'entrada' ? '💰' : c.recurring ? '🔁' : '📅');
const commMeta = (c) =>
  __('{0} de {1}/mês · {2}{3}', {
    0: c.direction === 'entrada' ? __('entrada') : __('saída'),
    1: brl(c.amount),
    2: c.recurring ? __('todo mês') : c.left > 0 ? __('faltam {0} · até {1}', { 0: c.left, 1: monthLabel(c.last_month) }) : __('quitado'),
    3: c.owner ? ` · ${esc(c.owner)}` : '',
  });
const commRow = (c) => `<div class="row" data-cid="${c.id}"><div class="ic">${commIcon(c)}</div><div class="main"><div class="title">${esc(c.name)}</div>
  <div class="meta">${commMeta(c)}</div></div><div class="amt num ${c.direction === 'entrada' ? 'pos' : ''}">${c.recurring ? `${brl(c.amount)}<small>/${__('mês')}</small>` : brl(c.left_total)}</div></div>`;

function futureCard(fut) {
  const max = Math.max(...fut.months.map((m) => Math.max(m.total, m.income)), 1);
  const comm = fut.commitments.filter((c) => c.active);
  const has = fut.months.some((m) => m.total || m.income);
  return `<section class="card">
    <h2>${__('Previsão dos próximos meses')} <small>${__('entradas e saídas já conhecidas')}</small></h2>
    ${
      comm.length
        ? `<details class="commlist"><summary>${comm.length} ${comm.length === 1 ? __('item recorrente ou parcelado') : __('itens recorrentes ou parcelados')}</summary><div class="list" style="margin-bottom:10px">${comm.map(commRow).join('')}</div></details>`
        : `<p class="muted small" style="margin-top:0">${__('Cadastre salário, aluguel, assinaturas e financiamentos para ver o orçamento dos próximos meses. Toque num lançamento e use "Repete todo mês?", ou adicione abaixo.')}</p>`
    }
    ${
      has
        ? `<div class="legend small"><span><i style="background:var(--income)"></i>${__('Entradas previstas')}</span><span><i style="background:var(--expense)"></i>${__('Saídas previstas')}</span></div>
          <div class="hbars">${fut.months
            .slice(0, 12)
            .map(
              (m) => `<button class="hbar" data-fmonth="${m.m}" title="${__('Ver a previsão de {0}', { 0: monthLabel(m.m, true) })}">
                <span class="name">${monthLabel(m.m)}</span><span class="val num" style="color:${m.balance >= 0 ? 'var(--pos-text)' : 'var(--danger)'}">${m.income ? `${m.balance >= 0 ? '+' : '−'} ${brl(Math.abs(m.balance))}` : `− ${brl(m.total)}`}</span>
                ${m.income ? `<span class="track"><span class="fill" style="display:block;width:${(m.income / max) * 100}%;background:var(--income)"></span></span>` : ''}
                <span class="track"><span class="fill" style="display:block;width:${(m.total / max) * 100}%;background:var(--expense)"></span></span>
                <span class="sub">${[m.income && __('entradas {0}', { 0: brl(m.income) }), m.recurring && __('recorrentes {0}', { 0: brl(m.recurring) }), m.financing && __('financiamentos {0}', { 0: brl(m.financing) }), m.installments && __('parcelas de cartão {0}', { 0: brl(m.installments) })].filter(Boolean).join(' · ') || __('nada previsto')}</span>
              </button>`
            )
            .join('')}</div>`
        : ''
    }
    <button class="btn ghost sm" id="addFin" style="margin-top:10px">+ ${__('Adicionar entrada ou saída recorrente')}</button>
  </section>`;
}

function openFutureMonth(m) {
  if (!m) return;
  const typeLabel = (i) =>
    i.type === 'entrada' ? __('entrada recorrente') : i.type === 'recorrente' ? __('saída recorrente') : i.type === 'financiamento' ? __('financiamento · faltam {0}', { 0: i.left }) : `${esc(i.account || __('cartão'))}${i.real ? __(' · fatura já enviada') : ''}`;
  const TYPES = [
    ['', __('Tudo')],
    ['entrada', __('Entradas')],
    ['recorrente', __('Recorrentes')],
    ['financiamento', __('Financiamentos')],
    ['parcela', __('Parcelas de cartão')],
  ];
  const sumOf = (list) => list.reduce((s, i) => s + i.amount, 0);
  const f = { type: '', cat: '', card: '' };
  const catName = (id) => (catById(id) ? catPath(id) : __('Sem categoria'));
  const groupId = (id) => catGroup(id)?.id ?? '';
  const { el, close } = sheet(`
    <h3>${__('Previsão de')} ${monthLabel(m.m, true)}</h3>
    <p class="muted small" style="margin-top:4px">${__('Entradas')} <b class="num">${brl(m.income)}</b> · ${__('saídas')} <b class="num">${brl(m.total)}</b> · ${__('saldo previsto')} <b class="num" style="color:${m.balance >= 0 ? 'var(--pos-text)' : 'var(--danger)'}">${brl(m.balance)}</b>.
    ${__('Considera só o que está cadastrado como recorrente e as parcelas de cartão (das faturas já enviadas e as que ainda vão vir); gastos do dia a dia (mercado, combustível) ainda vão somar.')}</p>
    <div class="chips" id="ftype">${TYPES.map(([v, label]) => {
      const list = v ? m.items.filter((i) => i.type === v) : m.items;
      return list.length || !v ? `<button class="chip ${v === '' ? 'on' : ''}" data-ft="${v}">${label} <span class="num">${v ? brl(sumOf(list)) : list.length}</span></button>` : '';
    }).join('')}</div>
    <div class="filters" style="margin-bottom:6px">
      <select id="fcat" aria-label="${__('Categoria')}"></select>
      <select id="fcard" aria-label="${__('Cartão')}" style="display:none"></select>
    </div>
    <div class="table-wrap" id="ftable"></div>
    <div class="actions" style="margin-top:12px"><button class="btn ghost sm" id="fclose">${__('Fechar')}</button></div>`);
  el.classList.add('wide');

  const byType = () => (f.type ? m.items.filter((i) => i.type === f.type) : m.items);
  const fill = () => {
    // categorias e cartões que existem no tipo escolhido (grupo junta as subcategorias)
    const base = byType();
    const groups = new Map();
    for (const i of base) {
      const g = catGroup(i.category_id);
      const key = g ? g.id : '';
      const cur = groups.get(key) || { id: key, label: g ? `${esc(g.icon)} ${g.name}` : __('Sem categoria'), total: 0 };
      cur.total += i.amount;
      groups.set(key, cur);
    }
    if (f.cat !== '' && !groups.has(Number(f.cat)) && !groups.has(f.cat)) f.cat = '';
    $('#fcat', el).innerHTML = `<option value="">${__('Todas as categorias')}</option>${[...groups.values()]
      .sort((a, b) => b.total - a.total)
      .map((g) => `<option value="${g.id}" ${String(g.id) === String(f.cat) ? 'selected' : ''}>${esc(g.label)} · ${brl(g.total)}</option>`)
      .join('')}`;
    const cards = [...new Set(base.filter((i) => i.type === 'parcela').map((i) => i.account))].sort();
    if (!cards.includes(f.card)) f.card = '';
    $('#fcard', el).style.display = f.type !== 'parcela' || cards.length < 2 ? 'none' : '';
    $('#fcard', el).innerHTML = `<option value="">${__('Todos os cartões')}</option>${cards
      .map((c) => `<option ${c === f.card ? 'selected' : ''}>${esc(c)}</option>`)
      .join('')}`;
  };
  const draw = () => {
    const list = byType().filter((i) => (f.cat === '' || String(groupId(i.category_id)) === String(f.cat)) && (!f.card || i.account === f.card));
    const ins = list.filter((i) => i.type === 'entrada').sort((a, b) => b.amount - a.amount);
    const outs = list.filter((i) => i.type !== 'entrada').sort((a, b) => b.amount - a.amount);
    const rows = (l) =>
      l.map((i) => `<tr><td class="desc">${esc(i.name)}${i.n ? ` <span class="pill">${esc(i.n)}</span>` : ''}</td><td class="muted">${typeLabel(i)}</td><td class="muted small">${esc(catName(i.category_id))}</td><td class="r">${brl(i.amount)}</td></tr>`).join('');
    $('#ftable', el).innerHTML = list.length
      ? `<table class="simple num entries"><thead><tr><th>${__('Item')}</th><th>${__('Tipo')}</th><th>${__('Categoria')}</th><th class="r">${__('Valor')}</th></tr></thead>
        ${ins.length ? `<tbody><tr class="group"><td colspan="4">${__('Entradas')}</td></tr>${rows(ins)}<tr><td colspan="3"><b>${__('Total de entradas')}</b></td><td class="r"><b>${brl(sumOf(ins))}</b></td></tr></tbody>` : ''}
        ${outs.length ? `<tbody><tr class="group"><td colspan="4">${__('Saídas')}</td></tr>${rows(outs)}<tr><td colspan="3"><b>${__('Total de saídas')}</b> <span class="muted small">(${outs.length})</span></td><td class="r"><b>${brl(sumOf(outs))}</b></td></tr></tbody>` : ''}
        </table>`
      : `<p class="muted">${__('Nada com esses filtros.')}</p>`;
  };
  $$('[data-ft]', el).forEach((b) =>
    b.addEventListener('click', () => {
      f.type = b.dataset.ft;
      $$('[data-ft]', el).forEach((x) => x.classList.toggle('on', x === b));
      fill();
      draw();
    })
  );
  $('#fcat', el).addEventListener('change', (e) => ((f.cat = e.target.value), draw()));
  $('#fcard', el).addEventListener('change', (e) => ((f.card = e.target.value), draw()));
  fill();
  draw();
  $('#fclose', el).addEventListener('click', close);
}

function evoTip(e) {
  if (!e) return '';
  const bal = e.income - e.expense;
  return `<b>${monthLabel(e.m, true)}</b> · ${__('receitas')} ${brl(e.income)} · ${__('despesas')} ${brl(e.expense)} · ${__('saldo')} <b style="color:${bal >= 0 ? 'var(--pos-text)' : 'var(--danger)'}">${brl(bal)}</b>`;
}

// ---------- lançamentos ----------
async function viewLancamentos(view) {
  const f = state.txFilters;
  const catOpts = (sel) =>
    ['despesa', 'receita', 'neutra']
      .map(
        (k) =>
          `<optgroup label="${{ despesa: __('Despesas'), receita: __('Receitas'), neutra: __('Não contam no balanço') }[k]}">${catsOrdered(k)
            .map((c) => `<option value="${c.id}" ${String(sel) === String(c.id) ? 'selected' : ''}>${c.parent_id ? '\u00a0\u00a0\u00a0↳ ' : ''}${esc(c.icon)} ${esc(c.name)}</option>`)
            .join('')}</optgroup>`
      )
      .join('');
  view.innerHTML = `
    <div class="filters">
      <input type="search" id="fq" placeholder="${__('Buscar por nome ou valor (ex.: netflix, 1.311,95)…')}" value="${esc(f.q)}" enterkeyhint="search">
      <select id="fscope" aria-label="${__('Período da busca')}"><option value="">${__('Só')} ${monthLabel(state.month)}</option><option value="all" ${f.all ? 'selected' : ''}>${__('Todos os meses')}</option></select>
      <select id="fcat"><option value="">${__('Todas as categorias')}</option>${catOpts(f.category)}</select>
      <select id="ftype">
        <option value="">${__('Receitas e despesas')}</option>
        <option value="despesa" ${f.type === 'despesa' ? 'selected' : ''}>${__('Só despesas')}</option>
        <option value="receita" ${f.type === 'receita' ? 'selected' : ''}>${__('Só receitas')}</option>
        <option value="ignorados" ${f.type === 'ignorados' ? 'selected' : ''}>${__('Ignorados (faturas, transferências)')}</option>
      </select>
      <select id="fchan" aria-label="${__('Online ou presencial')}">
        <option value="">${__('Online e presencial')}</option>
        <option value="online" ${f.channel === 'online' ? 'selected' : ''}>🌐 ${__('Compras online')}</option>
        <option value="presencial" ${f.channel === 'presencial' ? 'selected' : ''}>🏪 ${__('Compras presenciais')}</option>
      </select>
    </div>
    <div id="txSum" class="muted small" style="margin:-4px 0 6px"></div>
    <div class="card" style="padding:4px 12px" id="txList"><div class="empty">${__('Carregando')}…</div></div>
    <div class="actions" style="margin-top:12px"><a class="btn ghost sm" id="csv" href="#">⬇️ ${__('Exportar CSV do mês')}</a></div>
    <button class="fab" id="addTx" aria-label="${__('Novo lançamento manual')}">+</button>`;

  let timer;
  const reload = async () => {
    const params = new URLSearchParams({ owner: state.owner });
    if (!f.all) params.set('month', state.month);
    if (f.q) params.set('q', f.q);
    if (f.category) params.set('category', f.category);
    if (f.type) params.set('type', f.type);
    if (f.category && !f.type) params.set('ignored', '1');
    $('#csv').href = `/api/transactions.csv?${params}`;
    if (f.channel) params.set('channel', f.channel);
    const rows = await api(`/transactions?${params}`);
    renderTxList(rows, catOpts, reload);
  };
  $('#fq').addEventListener('input', (e) => {
    f.q = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(reload, 250);
  });
  $('#fscope').addEventListener('change', (e) => ((f.all = e.target.value === 'all'), reload()));
  if (state.focusSearch) {
    state.focusSearch = false;
    $('#fq').focus();
  }
  $('#fcat').addEventListener('change', (e) => ((f.category = e.target.value), reload()));
  $('#ftype').addEventListener('change', (e) => ((f.type = e.target.value), reload()));
  $('#fchan').addEventListener('change', (e) => ((f.channel = e.target.value), reload()));
  $('#addTx').addEventListener('click', () => openNewTx(catOpts, reload));
  reload();
}

function renderTxList(rows, catOpts, reload) {
  const list = $('#txList');
  if (!list) return;
  const counted = rows.filter((r) => !r.ignored);
  const out = counted.filter((r) => r.category_kind === 'despesa').reduce((a, r) => a - r.amount, 0);
  const inc = counted.filter((r) => r.category_kind === 'receita').reduce((a, r) => a + r.amount, 0);
  const proj = rows.filter((r) => r.projected);
  const projOut = proj.filter((r) => r.amount < 0).reduce((a, r) => a - r.amount, 0);
  const projIn = proj.filter((r) => r.amount > 0).reduce((a, r) => a + r.amount, 0);
  $('#txSum').innerHTML = `${rows.length} ${__('lançamentos · entradas')} <b class="num">${brl(inc)}</b> · ${__('saídas')} <b class="num">${brl(out)}</b>${
    proj.length ? `<br>${__('inclui')} ${proj.length} ${__('previstos · saídas')} <b class="num">${brl(projOut)}</b>${projIn ? ` · ${__('entradas')} <b class="num">${brl(projIn)}</b>` : ''}` : ''
  }`;
  if (!rows.length) {
    const where = state.txFilters.all ? __('em nenhum mês') : __('em {0}', { 0: monthLabel(state.month, true) });
    list.innerHTML = `<div class="empty"><div class="big">🔍</div>${__('Nenhum lançamento com esses filtros')} ${where}.${state.txFilters.all ? '' : __(' Experimente buscar em "Todos os meses".')}</div>`;
    return;
  }
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.date)) byDay.set(r.date, []);
    byDay.get(r.date).push(r);
  }
  list.innerHTML = [...byDay.entries()]
    .map(
      ([d, items]) => `<div class="day"><span>${dayLabel(d)}${state.txFilters.all ? __(' de {0}', { 0: d.slice(0, 4) }) : ''}</span></div>` +
        items
          .map(
            (r) => `<div class="row ${r.ignored ? 'ignored' : ''} ${r.projected ? 'projected' : ''}" data-id="${r.id}">
              <div class="ic">${esc(r.icon || '•')}</div>
              <div class="main"><div class="title">${esc(r.description)}${r.installment ? ` <span class="pill">${esc(r.installment)}</span>` : ''}${r.projected ? ` <span class="pill proj">${__('previsto')}</span>` : ''}</div>
                <div class="meta"><span class="catpill">${esc(r.icon || '')} ${esc(catPath(r.category_id, r.category))}</span>${r.channel ? ` <span class="chpill" title="${chanTitle(r)}">${r.channel === 'online' ? __('🌐 online') : __('🏪 presencial')}</span>` : ''} · ${esc(r.account || '')}${(state.txFilters.all || r.projected) && r.kind === 'cartao' ? __(' · fatura {0}', { 0: monthLabel(r.ref_month) }) : ''}${state.owner === 'all' && r.owner ? ` · ${esc(r.owner)}` : ''}</div></div>
              <div class="amt num ${r.amount > 0 ? 'pos' : ''}">${r.amount > 0 ? '+' : '−'} ${brl(Math.abs(r.amount))}</div>
            </div>`
          )
          .join('')
    )
    .join('');
  $$('.row', list).forEach((el) =>
    el.addEventListener('click', () => {
      const r = rows.find((x) => String(x.id) === el.dataset.id);
      if (!r.projected) return openTx(r, catOpts, reload);
      toast(
        r.kind === 'cartao'
          ? __('Parcela prevista para a fatura de {0}. Vira lançamento quando essa fatura for enviada.', { 0: monthLabel(r.ref_month) })
          : __('Previsto pelo item recorrente cadastrado. Some quando o lançamento aparecer no extrato; edite em Ajustes.')
      );
    })
  );
}

function sheet(html) {
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true"><div class="handle"></div>${html}</div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => e.target === bg && close());
  document.addEventListener('keydown', function onKey(e) {
    if (e.key === 'Escape') close(), document.removeEventListener('keydown', onKey);
  });
  return { el: $('.sheet', bg), close };
}

function openTx(t, catOpts, reload) {
  const { el, close } = sheet(`
    <h3>${esc(t.description)}</h3>
    <div class="muted small">${fmtDate(t.date)} · ${esc(t.account || '')}${t.installment ? __(' · parcela {0}', { 0: esc(t.installment) }) : ''}${t.holder ? ` · ${esc(t.holder)}` : ''}</div>
    <div class="num" style="font-size:26px;font-weight:700;margin:10px 0 14px;color:${t.amount > 0 ? 'var(--pos-text)' : 'inherit'}">${t.amount > 0 ? '+' : '−'} ${brl(Math.abs(t.amount))}</div>
    <label class="field"><span>${__('Categoria')}</span><select id="tcat">${catOpts(t.category_id)}</select></label>
    <label class="field"><span>${__('Pessoa')}</span><select id="towner">${state.users.map((u) => `<option value="${u.id}" ${u.id === t.owner_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
    ${
      t.channel
        ? `<label class="field"><span>${__('Onde foi a compra')}</span><select id="tchan">
            <option value="">${t.channel_how === 'manual' ? __('Automático (deduzir de novo)') : __('Automático: {0} ({1})', { 0: t.channel === 'online' ? 'online' : 'presencial', 1: esc(chanWhy(t)) })}</option>
            <option value="online" ${t.channel_how === 'manual' && t.channel === 'online' ? 'selected' : ''}>🌐 ${__('Online')}</option>
            <option value="presencial" ${t.channel_how === 'manual' && t.channel === 'presencial' ? 'selected' : ''}>🏪 ${__('Presencial')}</option></select></label>
          <label class="check" style="margin-top:-6px"><input type="checkbox" id="tchanall"><span>${__('Aplicar a todas as compras desta loja (e às próximas)')}</span></label>`
        : ''
    }
    <label class="check"><input type="checkbox" id="tign" ${t.ignored ? 'checked' : ''}><span>${__('Ignorar no balanço (ex.: pagamento de fatura, transferência entre contas)')}</span></label>
    <label class="field"><span>${__('Observação')}</span><input type="text" id="tnote" value="${esc(t.note || '')}" placeholder="${__('Opcional')}"></label>
    <div class="actions"><button class="btn" id="tsave">${__('Salvar')}</button><button class="btn ghost" id="tcancel">${__('Cancelar')}</button>
    ${t.kind === 'manual' ? `<button class="btn danger" id="tdel">${__('Excluir')}</button>` : ''}</div>
    ${!t.installment || t.kind !== 'cartao' ? `<div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
      <button class="btn ghost sm" id="tfin">🔁 ${__('Repete todo mês?')} ${t.amount > 0 ? __('Marcar como entrada recorrente') : __('Marcar como recorrente ou financiamento')}</button></div>` : ''}`);
  $('#tcancel', el).addEventListener('click', close);
  $('#tfin', el)?.addEventListener('click', async () => {
    close();
    // já tem recorrente para este lançamento? abre ele para editar em vez de criar outro
    const draft = commitmentFromTx(t);
    const list = await api('/commitments').catch(() => []);
    const flat = (x) => normalizeTxt(x).replace(/ /g, '');
    const desc = flat(t.description);
    const found = (list.items || list).find((c) => c.direction === draft.direction && c.pattern && flat(c.pattern).length >= 4 && desc.includes(flat(c.pattern)));
    openCommitment(found || draft, reload);
  });
  $('#tdel', el)?.addEventListener('click', async () => {
    if (!confirm(__('Excluir este lançamento manual?'))) return;
    await api(`/transactions/${t.id}`, { method: 'DELETE' });
    close();
    toast(__('Lançamento excluído'));
    reload();
  });
  $('#tsave', el).addEventListener('click', async () => {
    const body = {};
    const cat = Number($('#tcat', el).value);
    if (cat !== t.category_id) {
      // saída numa categoria de receita (ou entrada em despesa) entra com sinal trocado nos totais
      const k = catById(cat)?.kind;
      if ((t.amount < 0 && k === 'receita') || (t.amount > 0 && k === 'despesa')) {
        const msg =
          t.amount < 0
            ? __('Este lançamento é uma saída, mas "{0}" é uma categoria de receita: ele vai diminuir as receitas em vez de contar como despesa.\n\nPara ligar um imposto ou custo a uma renda (ex.: DAS do MEI), use uma categoria de despesa e a renda em Ajustes › Rendas.\n\nSalvar assim mesmo?', { 0: catById(cat).name })
            : __('Este lançamento é uma entrada, mas "{0}" é uma categoria de despesa: ele vai diminuir as despesas.\n\nSalvar assim mesmo?', { 0: catById(cat).name });
        if (!confirm(msg)) return;
      }
      body.category_id = cat;
      // Mesmo lançamento em outros meses? Pergunta se aplica aos anteriores/posteriores
      const sim = await api(`/transactions/${t.id}/similar`);
      if (sim.before + sim.after > 0) {
        const choice = await askScope(sim, state.categories.find((c) => c.id === cat));
        if (!choice) return;
        body.apply_to = choice.apply_to;
        if (choice.rule_pattern) body.rule_pattern = choice.rule_pattern;
      }
    }
    const owner = Number($('#towner', el).value);
    if (owner !== t.owner_id) body.owner_id = owner;
    const ign = $('#tign', el).checked;
    const catKind = state.categories.find((c) => c.id === cat)?.kind;
    if (ign !== Boolean(t.ignored) && !(body.category_id && (catKind === 'neutra') === ign)) body.ignored = ign;
    const note = $('#tnote', el).value;
    if (note !== (t.note || '')) body.note = note;
    const chSel = $('#tchan', el);
    if (chSel) {
      const all = $('#tchanall', el).checked;
      const was = t.channel_how === 'manual' ? t.channel : '';
      if (chSel.value !== was || all) (body.channel = chSel.value || null), (body.channel_all = all);
    }
    try {
      const r = await api(`/transactions/${t.id}`, { method: 'PATCH', body });
      close();
      toast(r.changed ? __('Salvo · {0} outros lançamentos atualizados', { 0: r.changed }) : __('Salvo'));
      reload();
    } catch (e) {
      toast(e.message);
    }
  });
}

// Pergunta o alcance da troca de categoria. Resolve com { apply_to, rule_pattern } ou null (cancelado).
function askScope(sim, cat) {
  return new Promise((resolve) => {
    const opts = [
      ['only', __('Só este lançamento'), ''],
      sim.before ? ['before', __('Este e os {0} anteriores', { 0: sim.before }), __('meses passados')] : null,
      sim.after ? ['after', __('Este e os {0} posteriores', { 0: sim.after }), __('e os próximos arquivos importados')] : ['after', __('Este e os próximos'), __('próximos arquivos importados')],
      ['all', __('Todos ({0})', { 0: sim.before + sim.after + 1 }), __('anteriores, posteriores e próximos arquivos')],
    ].filter(Boolean);
    const { el, close } = sheet(`
      <h3>${__('Mudar outros iguais?')}</h3>
      <p class="muted small" style="margin-top:4px">${__('Encontramos este mesmo lançamento em outros meses')}: <b>${sim.before}</b> ${__('anteriores e')} <b>${sim.after}</b> ${__('posteriores. Mudar para')} <b>${esc(cat?.icon || '')} ${esc(cat?.name || '')}</b>:</p>
      <div class="list" id="scopeOpts">${opts
        .map(([v, label, sub], i) => `<label class="check" style="margin:6px 0"><input type="radio" name="scope" value="${v}" ${i === opts.length - 1 ? 'checked' : ''}><span><b>${label}</b>${sub ? `<br><span class="muted small">${sub}</span>` : ''}</span></label>`)
        .join('')}</div>
      <label class="field hidden" id="rulebox" style="margin-top:8px"><span>${__('Nos próximos arquivos, aplicar quando a descrição contiver')}</span><input type="text" id="rulepat" value="${esc(sim.pattern)}"></label>
      <div class="actions"><button class="btn" id="sok">${__('Aplicar')}</button><button class="btn ghost" id="scancel">${__('Cancelar')}</button></div>`);
    const sync = () => {
      const v = $('input[name=scope]:checked', el).value;
      $('#rulebox', el).classList.toggle('hidden', !(v === 'after' || v === 'all'));
    };
    $$('input[name=scope]', el).forEach((r) => r.addEventListener('change', sync));
    sync();
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      close();
      resolve(val);
    };
    $('#scancel', el).addEventListener('click', () => finish(null));
    $('#sok', el).addEventListener('click', () => {
      const v = $('input[name=scope]:checked', el).value;
      finish({ apply_to: v, rule_pattern: v === 'after' || v === 'all' ? $('#rulepat', el).value : undefined });
    });
    el.parentElement.addEventListener('click', (e) => e.target === el.parentElement && finish(null));
  });
}

// ---------- financiamentos ----------
function commitmentFromTx(t) {
  const cat = state.categories.find((c) => c.id === t.category_id);
  const inst = /(\d{1,3})\/(\d{1,3})\s*$/.exec(t.description);
  const isFinanc = /FINANC|CRED\s*IMOB|HABITA|PRESTA[CÇ][AÃ]O/i.test(t.description);
  // texto de busca: sem parcela, data, CNPJ/CPF e prefixo de PIX, mas com o nome de quem recebe
  const pattern = t.description
    .replace(/\s*\d+\/\d+\s*$/, '')
    .replace(/^(PAGAMENTO PIX\s*-|PIX ENVIADO\s*(DES:)?|PIX RECEBIDO\s*(REM:)?|Pagamento com (C[óo]digo )?(QR )?Pix|Pix enviado|Pix recebido)\s*/i, '')
    .replace(/\b\d{6,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const name = isFinanc && cat?.key === 'Moradia' ? __('Financiamento do imóvel') : isFinanc && cat?.key === 'Veículo' ? __('Financiamento do carro') : pattern || t.description;
  return {
    name,
    pattern: (pattern.length >= 4 ? pattern : t.description).slice(0, 80),
    amount: Math.abs(t.amount),
    direction: t.amount > 0 ? 'entrada' : 'saida',
    recurring: inst ? 0 : 1,
    remaining: inst ? Math.max(Number(inst[2]) - Number(inst[1]), 0) : '',
    first_month: addMonths(t.ref_month, 1),
    category_id: t.category_id,
    owner_id: t.owner_id,
    hint: inst ? __('Pela descrição, esta é a parcela {0} de {1}.', { 0: inst[1], 1: inst[2] }) : '',
  };
}

function openCommitment(c, reload) {
  const isEdit = Boolean(c.id);
  const dir0 = c.direction || 'saida';
  const catOptsFor = (dir) =>
    state.categories
      .filter((x) => x.kind === (dir === 'entrada' ? 'receita' : 'despesa') && x.key !== COST_KEY)
      .map((x) => `<option value="${x.id}" ${x.id === c.category_id ? 'selected' : ''}>${esc(x.icon)} ${esc(x.name)}</option>`)
      .join('');
  const { el, close } = sheet(`
    <h3>${isEdit ? __('Editar item recorrente') : __('Entrada ou saída recorrente')}</h3>
    <p class="muted small" style="margin-top:4px">${__('Entra na')} <b>${__('Previsão dos próximos meses')}</b> ${__('no painel. No mês em que o lançamento aparecer no extrato, a previsão daquele mês deixa de contá-lo.')}${c.hint ? ` ${esc(c.hint)}` : ''}</p>
    <div class="seg" role="radiogroup" aria-label="${__('Tipo')}" style="margin-bottom:12px">
      <button type="button" data-dir="saida" class="${dir0 === 'saida' ? 'on' : ''}">${__('Saída')}</button>
      <button type="button" data-dir="entrada" class="${dir0 === 'entrada' ? 'on' : ''}">${__('Entrada')}</button>
    </div>
    <label class="field"><span>${__('Nome')}</span><input type="text" id="cname" value="${esc(c.name || '')}" placeholder="${__('Ex.: Salário, Aluguel, Financiamento do imóvel')}"></label>
    <div class="filters" style="margin-bottom:0">
      <label class="field" style="flex:1 1 140px"><span>${__('Valor por mês (R$)')}</span><input type="text" id="camount" inputmode="decimal" value="${c.amount ? String(c.amount.toFixed(2)).replace('.', ',') : ''}"></label>
      <label class="field" style="flex:1 1 140px"><span>${__('Começa em')}</span><input type="month" id="cfirst" value="${esc(c.first_month || '')}"></label>
    </div>
    <label class="check"><input type="checkbox" id="crec" ${c.recurring ? 'checked' : ''}><span>${__('Todo mês, sem data para acabar (salário, aluguel, assinaturas)')}</span></label>
    <label class="field" id="cremWrap"><span>${__('Quantas parcelas faltam')}</span><input type="number" id="cremaining" min="1" max="600" value="${c.remaining || ''}"></label>
    <label class="field"><span>${__('Texto no extrato (para saber se a do mês já aconteceu)')}</span><input type="text" id="cpattern" value="${esc(c.pattern || '')}"></label>
    <div class="filters" style="margin-bottom:0">
      <label class="field" style="flex:1 1 140px"><span>${__('Categoria')}</span><select id="ccat">${catOptsFor(dir0)}</select></label>
      <label class="field" style="flex:1 1 140px"><span>${__('Pessoa')}</span><select id="cowner">${state.users.map((u) => `<option value="${u.id}" ${u.id === c.owner_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
    </div>
    <div class="muted small num" id="cprev" style="margin-bottom:12px"></div>
    <div class="actions"><button class="btn" id="csave">${__('Salvar')}</button><button class="btn ghost" id="ccancel">${__('Cancelar')}</button>
    ${isEdit ? `<button class="btn danger" id="cdel">${__('Excluir')}</button>` : ''}</div>`);
  let dir = dir0;
  $$('[data-dir]', el).forEach((b) =>
    b.addEventListener('click', () => {
      dir = b.dataset.dir;
      $$('[data-dir]', el).forEach((x) => x.classList.toggle('on', x === b));
      $('#ccat', el).innerHTML = catOptsFor(dir);
      preview();
    })
  );
  const preview = () => {
    const rec = $('#crec', el).checked;
    $('#cremWrap', el).style.display = rec ? 'none' : '';
    const v = Number(String($('#camount', el).value).replace(/\./g, '').replace(',', '.')) || 0;
    const n = parseInt($('#cremaining', el).value, 10) || 0;
    const first = $('#cfirst', el).value;
    if (!v || !first) return ($('#cprev', el).innerHTML = '');
    $('#cprev', el).innerHTML = rec
      ? `${dir === 'entrada' ? __('Entrada') : __('Saída')} ${__('de')} <b>${brl(v)}</b> ${__('todo mês a partir de')} <b>${monthLabel(first, true)}</b> · <b>${brl(v * 12)}</b> ${__('por ano')}`
      : n
        ? `${__('Total que falta')}: <b>${brl(v * n)}</b> · ${__('última parcela em')} <b>${monthLabel(addMonths(first, n - 1), true)}</b>`
        : '';
  };
  ['#camount', '#cremaining', '#cfirst', '#crec'].forEach((s) => $(s, el).addEventListener('input', preview));
  preview();
  $('#ccancel', el).addEventListener('click', close);
  $('#cdel', el)?.addEventListener('click', async () => {
    if (!confirm(__('Excluir este item da previsão?'))) return;
    await api(`/commitments/${c.id}`, { method: 'DELETE' });
    close();
    toast(__('Excluído'));
    reload?.();
  });
  $('#csave', el).addEventListener('click', async () => {
    const body = {
      name: $('#cname', el).value,
      amount: $('#camount', el).value,
      direction: dir,
      recurring: $('#crec', el).checked,
      remaining: $('#cremaining', el).value,
      first_month: $('#cfirst', el).value,
      pattern: $('#cpattern', el).value,
      category_id: Number($('#ccat', el).value),
      owner_id: Number($('#cowner', el).value),
    };
    try {
      await api(isEdit ? `/commitments/${c.id}` : '/commitments', { method: isEdit ? 'PUT' : 'POST', body });
      close();
      toast(isEdit ? __('Atualizado') : __('Incluído na previsão'));
      reload?.();
    } catch (e) {
      toast(e.message);
    }
  });
}

// Tabela de entradas (ou saídas) do mês, aberta pelos cards do painel
async function openEntriesTable(type) {
  const params = new URLSearchParams({ month: state.month, owner: state.owner, type });
  const all = (await api(`/transactions?${params}`)).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const label = type === 'receita' ? __('Receitas') : __('Despesas');
  const val = (r) => (type === 'receita' ? r.amount : -r.amount);
  const cols = state.owner === 'all' ? 6 : 5;
  // Uma opção por categoria presente no mês, maior total primeiro
  const cats = [...all.reduce((m, r) => {
    const c = m.get(r.category_id) || { id: r.category_id, icon: r.icon || '', name: catPath(r.category_id, r.category), total: 0, n: 0 };
    c.total += val(r);
    c.n++;
    return m.set(r.category_id, c);
  }, new Map()).values()].sort((a, b) => b.total - a.total);
  const { el, close } = sheet(`
    <h3>${label} · ${monthLabel(state.month, true)}</h3>
    <p class="muted small" style="margin-top:4px" id="esum"></p>
    ${cats.length > 1 ? `<div class="chips" id="echips" role="group" aria-label="${__('Filtrar por categoria')}">
      <button class="chip on" data-ec="">${__('Todas')} <span class="num">${brl(all.reduce((s, r) => s + val(r), 0))}</span></button>
      ${cats.map((c) => `<button class="chip" data-ec="${c.id}">${esc(c.icon)} ${esc(c.name)} <span class="num">${brl(c.total)}</span></button>`).join('')}</div>` : ''}
    <div class="table-wrap"><table class="simple num entries">
      <thead><tr><th>${__('Data')}</th><th>${__('Descrição')}</th><th>${__('Categoria')}</th>${state.owner === 'all' ? `<th>${__('Pessoa')}</th>` : ''}<th>${__('Conta')}</th><th class="r">${__('Valor')}</th></tr></thead>
      <tbody id="ebody"></tbody>
      <tfoot><tr><td colspan="${cols - 1}"><b>${__('Total')}</b></td><td class="r"><b id="etotal"></b></td></tr></tfoot>
    </table></div>
    <div class="actions" style="margin-top:12px"><a class="btn ghost sm" id="ecsv">⬇️ ${__('Exportar CSV')}</a><button class="btn ghost sm" id="eclose">${__('Fechar')}</button></div>`);
  el.classList.add('wide');
  const show = (catId) => {
    const rows = catId ? all.filter((r) => String(r.category_id) === catId) : all;
    const total = rows.reduce((s, r) => s + val(r), 0);
    $('#ebody', el).innerHTML = rows
      .map(
        (r) => `<tr data-id="${r.id}"><td>${fmtDate(r.date).slice(0, 5)}</td><td class="desc">${esc(r.description)}${r.installment ? ` <span class="pill">${esc(r.installment)}</span>` : ''}${r.projected ? ` <span class="pill proj">${__('previsto')}</span>` : ''}</td><td>${esc(r.icon || '')} ${esc(catPath(r.category_id, r.category))}</td>${state.owner === 'all' ? `<td>${esc(r.owner || '')}</td>` : ''}<td class="muted">${esc(r.account || '')}</td><td class="r ${r.amount > 0 ? 'pos' : ''}">${brl(Math.abs(r.amount))}</td></tr>`
      )
      .join('');
    $('#etotal', el).textContent = brl(total);
    $('#esum', el).innerHTML = `${rows.length} ${__('lançamentos · total')} <b class="num">${brl(total)}</b>${state.owner === 'all' ? '' : ` · ${esc(state.users.find((u) => String(u.id) === String(state.owner))?.name || '')}`}`;
    const p = new URLSearchParams(params);
    if (catId) p.set('category', catId);
    $('#ecsv', el).href = `/api/transactions.csv?${p}`;
  };
  $$('[data-ec]', el).forEach((b) =>
    b.addEventListener('click', () => {
      $$('[data-ec]', el).forEach((x) => x.classList.toggle('on', x === b));
      show(b.dataset.ec);
    })
  );
  show('');
  $('#eclose', el).addEventListener('click', close);
}

function openNewTx(catOpts, reload) {
  const today = new Date().toISOString().slice(0, 10);
  const { el, close } = sheet(`
    <h3>${__('Novo lançamento')}</h3>
    <p class="muted small" style="margin-top:0">${__('Para gastos em dinheiro ou contas que não vêm em extrato.')}</p>
    <div class="seg" style="margin:0 0 12px" id="ntype"><button class="on" data-t="despesa">${__('Despesa')}</button><button data-t="receita">${__('Receita')}</button></div>
    <label class="field"><span>${__('Descrição')}</span><input type="text" id="ndesc" required></label>
    <label class="field"><span>${__('Valor (R$)')}</span><input type="text" id="nval" inputmode="decimal" placeholder="0,00"></label>
    <label class="field"><span>${__('Data')}</span><input type="date" id="ndate" value="${today}"></label>
    <label class="field"><span>${__('Categoria')}</span><select id="ncat">${catOpts('')}</select></label>
    <label class="field"><span>${__('Pessoa')}</span><select id="nowner">${state.users.map((u) => `<option value="${u.id}" ${u.id === state.user.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
    <div class="actions"><button class="btn" id="nsave">${__('Adicionar')}</button><button class="btn ghost" id="ncancel">${__('Cancelar')}</button></div>`);
  let type = 'despesa';
  $$('#ntype button', el).forEach((b) =>
    b.addEventListener('click', () => {
      type = b.dataset.t;
      $$('#ntype button', el).forEach((x) => x.classList.toggle('on', x === b));
    })
  );
  $('#ncancel', el).addEventListener('click', close);
  $('#nsave', el).addEventListener('click', async () => {
    try {
      await api('/transactions', {
        method: 'POST',
        body: { type, description: $('#ndesc', el).value, amount: $('#nval', el).value, date: $('#ndate', el).value, category_id: Number($('#ncat', el).value), owner_id: Number($('#nowner', el).value) },
      });
      close();
      toast(__('Lançamento adicionado'));
      await loadMeta();
      reload();
    } catch (e) {
      toast(e.message);
    }
  });
}

// ---------- enviar ----------
function viewEnviar(view) {
  view.innerHTML = `
    <div class="grid two">
      <section class="card">
        <h2>${__('Enviar extratos e faturas')}</h2>
        <label class="drop" id="drop" for="files">
          <div class="big">📄</div>
          <div><b>${__('Toque para escolher')}</b> ${__('ou arraste os arquivos aqui')}</div>
          <div class="muted small">${__('PDF, OFX ou CSV · vários de uma vez · até 15 MB cada')}</div>
        </label>
        <input type="file" id="files" accept=".pdf,.ofx,.csv,.txt,application/pdf,text/csv" multiple class="hidden">
        <details style="margin-top:12px"><summary>${__('Opções (PDF com senha, pessoa padrão)')}</summary>
          <label class="field" style="margin-top:8px"><span>${__('Senha do PDF (se o banco protege o arquivo)')}</span><input type="password" id="pdfpw" autocomplete="off"></label>
          <label class="field"><span>${__('Pessoa quando o titular não for reconhecido')}</span><select id="uowner">${state.users.map((u) => `<option value="${u.id}" ${u.id === state.user.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
        </details>
        <div id="results"></div>
      </section>
      <section class="card">
        <h2>${__('Formatos reconhecidos')}</h2>
        <div class="list small">
          <div class="row" style="cursor:default"><div class="ic">🏦</div><div class="main"><div class="title">${__('Bradesco')}</div><div class="meta">${__('Extrato da conta (app) e fatura do cartão, com adicionais')}</div></div></div>
          <div class="row" style="cursor:default"><div class="ic">🏦</div><div class="main"><div class="title">${__('Itaú')}</div><div class="meta">${__('Extrato da conta e fatura do cartão')}</div></div></div>
          <div class="row" style="cursor:default"><div class="ic">💳</div><div class="main"><div class="title">${__('Mercado Pago')}</div><div class="meta">${__('Fatura do cartão e extrato da conta (PF ou MEI)')}</div></div></div>
          <div class="row" style="cursor:default"><div class="ic">🏦</div><div class="main"><div class="title">${__('Sicredi')}</div><div class="meta">${__('Extrato da conta corrente')}</div></div></div>
          <div class="row" style="cursor:default"><div class="ic">💳</div><div class="main"><div class="title">${__('Banco do Brasil')}</div><div class="meta">${__('Fatura do cartão Ourocard')}</div></div></div>
          <div class="row" style="cursor:default"><div class="ic">📑</div><div class="main"><div class="title">${__('Qualquer banco em OFX')}</div><div class="meta">${__('Exportação "Money/OFX" do internet banking')}</div></div></div>
          <div class="row" style="cursor:default"><div class="ic">📊</div><div class="main"><div class="title">${__('CSV')}</div><div class="meta">${__('Nubank (cartão e conta) e Inter prontos; qualquer outro CSV com mapeamento de colunas')}</div></div></div>
          <div class="row" style="cursor:default"><div class="ic">🧩</div><div class="main"><div class="title">${__('Outros bancos')}</div><div class="meta">${__('Sem leitor? Crie um com IA (ou mapeie as colunas) e ele é reaproveitado nas próximas vezes. Ou use a leitura genérica.')}</div></div></div>
        </div>
        <p class="muted small">${__('Cada arquivo é conferido contra o total impresso pelo banco. Arquivo repetido é recusado e lançamentos já importados por outro arquivo não duplicam.')}</p>
      </section>
    </div>`;

  const input = $('#files');
  const drop = $('#drop');
  input.addEventListener('change', () => send([...input.files]));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.add('over'))));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => (e.preventDefault(), drop.classList.remove('over'))));
  drop.addEventListener('drop', (e) => send([...e.dataTransfer.files]));

  async function send(files) {
    if (!files.length) return;
    const box = $('#results');
    box.innerHTML = `<div class="result">${__('Lendo')} ${files.length} ${__('arquivo(s)')}…</div>`;
    const fd = new FormData();
    files.forEach((f) => fd.append('files', f, f.name));
    const pw = $('#pdfpw').value;
    if (pw) fd.append('password', pw);
    fd.append('owner_id', $('#uowner').value);
    try {
      const { results } = await api('/imports', { method: 'POST', body: fd });
      box.innerHTML = results.map(resultCard).join('');
      bindPendingButtons(box);
      await loadMeta();
      const firstOk = results.find((r) => r.ok && r.dueDate);
      if (firstOk) state.month = firstOk.dueDate.slice(0, 7);
    } catch (e) {
      box.innerHTML = `<div class="result err">${esc(e.message)}</div>`;
    }
    input.value = '';
  }
}

function checkPill(stated, computed) {
  if (stated == null) return `<span class="pill">${__('sem total para conferir')}</span>`;
  const diff = Math.round((stated - computed) * 100) / 100;
  return diff === 0 ? `<span class="pill ok">✓ ${__('confere com o banco')}</span>` : `<span class="pill warn">⚠ ${__('diferença de')} ${brl(Math.abs(diff))}</span>`;
}

function resultCard(r) {
  if (!r.ok && r.code === 'NO_PARSER')
    return `<div class="result warnres" data-result="${esc(r.pending_id)}"><div class="title">${esc(r.filename)}</div>
      <div class="small">${__('Nenhum leitor conhece este')} ${r.format === 'csv' ? 'CSV' : 'PDF'} ${__('ainda. Crie um: ele fica salvo e é usado sozinho nos próximos arquivos iguais.')}</div>
      <div class="actions" style="margin-top:8px">
        <button class="btn sm" data-pending="${esc(r.pending_id)}" data-mode="ai">🤖 ${__('Criar leitor com IA')}</button>
        ${r.format === 'csv' ? `<button class="btn ghost sm" data-pending="${esc(r.pending_id)}" data-mode="map">🧩 ${__('Mapear colunas')}</button>` : `<button class="btn ghost sm" data-pending="${esc(r.pending_id)}" data-mode="generic">${__('Leitura genérica')}</button>`}
      </div></div>`;
  if (!r.ok) return `<div class="result err"><div class="title">${esc(r.filename)}</div><div class="small" style="color:var(--danger)">${esc(r.error)}</div></div>`;
  return `<div class="result">
    <div class="title">${esc(r.filename)}</div>
    <div class="small muted">${esc(r.parser)}${r.holder ? ` · ${esc(r.holder)}` : ''}${r.dueDate ? __(' · vence {0}', { 0: fmtDate(r.dueDate) }) : ''}</div>
    <div class="small" style="margin-top:6px">${r.inserted} ${__('lançamentos importados')}${r.skipped ? __(', {0} já existiam', { 0: r.skipped }) : ''} ${checkPill(r.statedTotal, r.computedTotal)}</div>
    ${r.statedTotal != null ? `<div class="small muted">${__('Conferência')} (${esc(r.totalLabel)}): ${__('banco')} ${brl(r.statedTotal)} · ${__('lido')} ${brl(r.computedTotal)}</div>` : ''}
    ${r.replaced?.length ? `<div class="small" style="margin-top:4px">🔁 ${__('Substituiu a versão anterior ({0}); suas edições foram mantidas.', { 0: esc(r.replaced.join(', ')) })}</div>` : ''}
    ${r.partial ? `<div class="small muted" style="margin-top:4px">${__('Fatura ainda aberta: ficou marcada como parcial. Envie a fechada quando sair; ela substitui esta.')}</div>` : ''}
    ${r.warnings.map((w) => `<div class="small" style="color:var(--warn-text)">⚠ ${esc(w)}</div>`).join('')}
  </div>`;
}

// ---------- leitores de documentos (arquivo sem leitor) ----------
function bindPendingButtons(box) {
  $$('[data-pending]', box).forEach((b) =>
    b.addEventListener('click', () =>
      openExtractor(b.dataset.pending, b.dataset.mode, (r) => {
        const card = $(`[data-result="${CSS.escape(b.dataset.pending)}"]`, box);
        if (card) card.outerHTML = resultCard(r);
        loadMeta();
      })
    )
  );
}

const DATE_FORMATS = ['DD/MM/YYYY', 'DD/MM/YY', 'DD/MM', 'YYYY-MM-DD', 'DD-MM-YYYY', 'DD.MM.YYYY', 'DD MMM', 'DD MMM YYYY'];

function previewHtml(p) {
  if (!p) return '';
  return `<h4 class="docsh">${__('Prévia')}: ${p.count} ${__('lançamentos')} ${checkPill(p.statedTotal, p.computedTotal)}</h4>
    <div class="muted small">${esc(p.account || '')}${p.dueDate ? __(' · vence {0}', { 0: fmtDate(p.dueDate) }) : ''}${p.periodStart ? ` · ${fmtDate(p.periodStart)} a ${fmtDate(p.periodEnd)}` : ''}${p.statedTotal != null ? __(' · banco {0} · lido {1}', { 0: brl(p.statedTotal), 1: brl(p.computedTotal) }) : __(' · total lido {0}', { 0: brl(p.computedTotal) })}</div>
    ${p.warnings.map((w) => `<div class="small" style="color:var(--warn-text)">⚠ ${esc(w)}</div>`).join('')}
    <div class="table-wrap"><table class="simple num entries"><thead><tr><th>${__('Data')}</th><th>${__('Descrição')}</th><th class="r">${__('Valor')}</th></tr></thead><tbody>
    ${p.sample.map((t) => `<tr><td>${fmtDate(t.date)}</td><td class="desc">${esc(t.description)}${t.installment ? ` <span class="pill">${esc(t.installment)}</span>` : ''}${t.payment ? ` <span class="pill">${__('pagamento')}</span>` : ''}</td><td class="r">${brl(t.amount)}</td></tr>`).join('')}
    </tbody></table></div>${p.count > p.sample.length ? `<p class="muted small">${__('e mais')} ${p.count - p.sample.length}…</p>` : ''}`;
}

async function openExtractor(pendingId, mode, done) {
  if (mode === 'generic') {
    try {
      done(await api(`/imports/pending/${pendingId}/import`, { method: 'POST', body: { generic: true } }));
      toast(__('Importado com a leitura genérica: confira os lançamentos'));
    } catch (e) {
      toast(e.message);
    }
    return;
  }
  let info;
  try {
    info = await api(`/imports/pending/${pendingId}`);
  } catch (e) {
    return toast(e.message);
  }
  let template = null;
  let source = 'manual';
  const { el, close } = sheet(`<h3>${__('Novo leitor')} · ${esc(info.filename)}</h3><div id="exBody"></div>`);
  el.classList.add('wide');
  const body = $('#exBody', el);

  const finishBox = () => `
    <div class="filters" style="margin-top:12px"><input type="text" id="exName" value="${esc(template?.name || '')}" placeholder="${__('Nome do leitor (ex.: Santander · Fatura)')}">
      ${template?.doc_kind === 'cartao' ? `<input type="date" id="exDue" aria-label="${__('Vencimento da fatura')}" title="${__('Vencimento da fatura (se não foi encontrado)')}">` : ''}</div>
    <label class="check"><input type="checkbox" id="exSave" checked><span>${__('Salvar este leitor para os próximos arquivos iguais')}</span></label>
    <div class="actions"><button class="btn" id="exImport">${__('Importar')}</button><button class="btn ghost" id="exClose">${__('Cancelar')}</button></div>`;
  const bindFinish = () => {
    $('#exClose', el).addEventListener('click', close);
    $('#exImport', el).addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api(`/imports/pending/${pendingId}/import`, {
          method: 'POST',
          body: { template, save: $('#exSave', el).checked, name: $('#exName', el).value, source, due_date: $('#exDue', el)?.value || null },
        });
        toast(__('{0} lançamentos importados{1}', { 0: r.inserted, 1: r.extractor_id ? ' · leitor salvo' : '' }));
        close();
        done(r);
      } catch (err) {
        toast(err.message);
        e.currentTarget.disabled = false;
      }
    });
  };

  if (mode === 'ai') {
    if (!info.ai) {
      body.innerHTML = `<p>${__('A IA está desligada neste servidor (ou é um webhook).')} ${info.format === 'csv' ? __('Use "Mapear colunas".') : __('Use a leitura genérica ou peça a um administrador para ligar a IA.')}</p>`;
      return;
    }
    body.innerHTML = `<p class="small" style="margin-top:0">${__('A IA recebe uma')} <b>${__('amostra')}</b> ${__('do texto do arquivo (começo e um trecho do meio) com CPF/CNPJ, números de conta e de cartão, e-mails e telefones trocados por zeros. Nomes e valores podem aparecer. Ela devolve só um')} <b>${__('modelo de leitura')}</b> ${__('(não é código), que o app testa no arquivo inteiro antes de você confirmar.')}</p>
      <div class="actions"><button class="btn" id="exAi">${__('Enviar amostra e criar leitor')}</button><button class="btn ghost" id="exCancel">${__('Cancelar')}</button></div><div id="exOut"></div>`;
    $('#exCancel', el).addEventListener('click', close);
    $('#exAi', el).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = __('Criando leitor…');
      try {
        const r = await api(`/imports/pending/${pendingId}/ai`, { method: 'POST' });
        template = r.template;
        source = 'ia';
        body.innerHTML = `<p class="small" style="margin-top:0">${__('Leitor sugerido')}: <b>${esc(template.name)}</b> · ${esc(template.bank)} · ${template.doc_kind === 'cartao' ? __('fatura de cartão') : __('extrato de conta')}</p>
          ${previewHtml(r.preview)}${finishBox()}`;
        bindFinish();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
        btn.textContent = __('Tentar de novo');
      }
    });
    return;
  }

  // mapear colunas (CSV)
  const sug = info.suggestion;
  const header = info.rows[sug.header_row] || info.rows[0] || [];
  const opt = (v, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v || '—')}</option>`;
  const colSel = (name, cur) => `<select name="${name}">${['', ...header].map((h) => opt(h, cur || '')).join('')}</select>`;
  body.innerHTML = `
    <p class="muted small" style="margin-top:0">${__('Primeiras linhas do arquivo')}:</p>
    <div class="table-wrap"><table class="simple entries small">${info.rows.slice(0, 6).map((r, i) => `<tr${i === sug.header_row ? ' class="group"' : ''}>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table></div>
    <form id="exMap" class="insform" style="margin-top:10px">
      <label class="field"><span>${__('Banco')}</span><input type="text" name="bank" value="${esc(sug.bank)}" placeholder="${__('Ex.: C6 Bank')}" required></label>
      <label class="field"><span>${__('Tipo')}</span><select name="doc_kind">${opt('conta', sug.doc_kind).replace('>conta<', `>${__('Extrato de conta')}<`)}${opt('cartao', sug.doc_kind).replace('>cartao<', `>${__('Fatura de cartão')}<`)}</select></label>
      <label class="field"><span>${__('Data')}</span>${colSel('date', sug.columns.date)}</label>
      <label class="field"><span>${__('Formato da data')}</span><select name="date_format">${DATE_FORMATS.map((f) => opt(f, sug.date_format)).join('')}</select></label>
      <label class="field"><span>${__('Descrição')}</span>${colSel('desc1', sug.columns.description[0])}</label>
      <label class="field"><span>${__('Descrição (2ª coluna, opcional)')}</span>${colSel('desc2', sug.columns.description[1])}</label>
      <label class="field"><span>${__('Valor')}</span>${colSel('amount', sug.columns.amount)}</label>
      <label class="field"><span>${__('ou Débito')}</span>${colSel('debit', sug.columns.debit)}</label>
      <label class="field"><span>${__('e Crédito')}</span>${colSel('credit', sug.columns.credit)}</label>
      <label class="field"><span>${__('Decimal')}</span><select name="decimal">${opt(',', sug.decimal).replace('>,<', `>${__('vírgula (1.234,56)')}<`)}${opt('.', sug.decimal).replace('>.<', `>${__('ponto (1,234.56)')}<`)}</select></label>
      <label class="field"><span>${__('Compras/saídas aparecem')}</span><select name="sign"><option value="as_is" ${sug.sign === 'as_is' ? 'selected' : ''}>${__('negativas (-12,50)')}</option><option value="invert" ${sug.sign === 'invert' ? 'selected' : ''}>${__('positivas (12,50)')}</option></select></label>
      <label class="field"><span>${__('Texto do pagamento da fatura (opcional)')}</span><input type="text" name="payment" value="${esc((sug.payment_patterns || []).join(', '))}" placeholder="${__('Ex.: Pagamento recebido')}"></label>
      <div class="actions"><button class="btn ghost" type="submit">${__('Pré-visualizar')}</button></div>
    </form><div id="exOut"></div>`;
  $('#exMap', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const cols = [f.date, f.desc1, f.amount || f.debit, f.credit].filter(Boolean);
    const t = {
      kind: 'csv',
      name: __('{0} · {1} (CSV)', { 0: f.bank, 1: f.doc_kind === 'cartao' ? 'Fatura' : 'Extrato' }),
      bank: f.bank,
      account: `${f.bank} ${f.doc_kind === 'cartao' ? __('Cartão') : __('Conta')}`,
      doc_kind: f.doc_kind,
      detect: { header: [...new Set(cols)] },
      header_row: sug.header_row,
      delimiter: info.delimiter,
      columns: { date: f.date || null, description: [f.desc1, f.desc2].filter(Boolean), amount: f.amount || null, debit: f.amount ? null : f.debit || null, credit: f.amount ? null : f.credit || null },
      date_format: f.date_format,
      decimal: f.decimal,
      sign: f.sign,
      payment_patterns: f.payment ? f.payment.split(',').map((x) => x.trim()).filter(Boolean) : [],
    };
    try {
      const r = await api(`/imports/pending/${pendingId}/preview`, { method: 'POST', body: { template: t } });
      template = r.template;
      $('#exOut', el).innerHTML = previewHtml(r.preview) + finishBox();
      bindFinish();
    } catch (err) {
      $('#exOut', el).innerHTML = `<p class="small" style="color:var(--danger)">${esc(err.message)}</p>`;
    }
  });
}

// ---------- arquivos ----------
function alertsCard(alerts) {
  if (!alerts.length) return `<section class="card ok-card"><h2>✓ ${__('Nenhum documento faltando')}</h2><p class="muted small" style="margin:0">${__('Faturas e extratos recorrentes estão em dia.')}</p></section>`;
  const icon = { alta: '🔴', media: '🟠', baixa: '⚪' };
  return `<section class="card"><h2>${__('Documentos faltando')} <small>${alerts.length}</small></h2>
    <p class="muted small" style="margin-top:0">${__('Enquanto faltarem, os meses afetados mostram receitas ou despesas a menos. Envie em')} <a href="#/enviar">${__('Enviar')}</a>.</p>
    <div class="list">${alerts
      .map(
        (a) => `<div class="row" style="cursor:default;align-items:flex-start"><div class="ic" aria-label="prioridade ${a.level}">${icon[a.level] || '⚠'}</div>
          <div class="main"><div class="title" style="white-space:normal">${esc(a.title)}</div><div class="meta" style="white-space:normal">${esc(a.detail)}</div>
          <div class="actions" style="margin-top:6px">${a.month ? `<button class="btn ghost sm" data-goto="${a.month}">${__('Ver')} ${monthLabel(a.month)}</button>` : ''}<button class="btn ghost sm" data-dismiss="${esc(a.key)}" title="${__('Não vou enviar este documento')}">${__('Dispensar')}</button></div></div></div>`
      )
      .join('')}</div></section>`;
}

async function viewArquivos(view) {
  view.innerHTML = `<div class="card"><div class="empty">${__('Carregando')}…</div></div>`;
  const [rows, alerts] = await Promise.all([api('/imports'), api('/alerts')]);
  state.alerts = alerts;
  const bindAlerts = () => {
    $$('[data-dismiss]', view).forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(__('Dispensar este alerta? Ele não aparecerá mais.'))) return;
        await api('/alerts/dismiss', { method: 'POST', body: { key: b.dataset.dismiss } });
        toast(__('Alerta dispensado'));
        await loadMeta();
        render();
      })
    );
    $$('[data-goto]', view).forEach((b) =>
      b.addEventListener('click', () => {
        state.month = b.dataset.goto;
        location.hash = '#/painel';
      })
    );
  };
  if (!rows.length) {
    view.innerHTML = `<div class="card empty"><div class="big">🗂️</div><p>${__('Nenhum arquivo enviado.')}</p><a class="btn" href="#/enviar">${__('Enviar agora')}</a></div>`;
    return;
  }
  view.innerHTML = `<div class="grid">${alertsCard(alerts)}<section class="card" style="padding:4px 12px"><h2 style="margin:12px 4px 4px">${__('Arquivos enviados')} <small>${rows.length}</small></h2><div class="list">${rows
    .map(
      (r) => `<div class="row" style="cursor:default;align-items:flex-start">
        <div class="ic">${r.kind === 'cartao' ? '💳' : r.kind === 'holerite' ? '🧾' : '🏦'}</div>
        <div class="main">
          <div class="title" style="white-space:normal;word-break:break-word">${esc(r.filename)}</div>
          <div class="meta" style="white-space:normal">${esc(r.account || r.bank || '')}${r.kind === 'holerite' ? (r.due_date ? __(' · pago em {0} · líquido {1}', { 0: fmtDate(r.due_date), 1: brl(r.amount_due) }) : '') : `${r.due_date ? __(' · vence {0}', { 0: fmtDate(r.due_date) }) : ''}${r.period_start ? ` · ${fmtDate(r.period_start)} a ${fmtDate(r.period_end)}` : ''}`}</div>
          <div class="meta" style="white-space:normal">${r.tx_count} ${__('lançamentos · enviado por')} ${esc(r.uploaded_by || '?')} ${__('em')} ${fmtDate(r.created_at.slice(0, 10))} ${r.partial ? `<span class="pill proj">${__('parcial')}</span>` : checkPill(r.stated_total, r.computed_total)}</div>
          ${r.warnings.map((w) => `<div class="small" style="color:var(--warn-text)">⚠ ${esc(w)}</div>`).join('')}
          <div class="actions" style="margin-top:8px"><a class="btn ghost sm" href="/api/imports/${r.id}/file">⬇️ ${__('Original')}</a>${r.kind === 'cartao' ? `<button class="btn ghost sm" data-partial="${r.id}" data-on="${r.partial ? 0 : 1}">${r.partial ? __('Marcar como fechada') : __('Marcar como parcial')}</button>` : ''}<button class="btn danger sm" data-del="${r.id}">${__('Remover')}</button></div>
        </div>
      </div>`
    )
    .join('')}</div></section></div>`;
  bindAlerts();
  $$('[data-del]', view).forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm(__('Remover este arquivo e todos os lançamentos dele?'))) return;
      await api(`/imports/${b.dataset.del}`, { method: 'DELETE' });
      toast(__('Arquivo removido'));
      await loadMeta();
      viewArquivos(view);
    })
  );
  $$('[data-partial]', view).forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/imports/${b.dataset.partial}`, { method: 'PATCH', body: { partial: b.dataset.on === '1' } });
      await loadMeta();
      viewArquivos(view);
    })
  );
}

// ---------- ajustes ----------
async function viewAjustes(view) {
  const [rules, commitments, suggestions] = await Promise.all([api('/rules'), api('/commitments'), api('/commitments/suggestions')]);
  const userRules = rules.filter((r) => r.source === 'usuario');
  const aiRules = rules.filter((r) => r.source === 'ia');
  const defRules = rules.filter((r) => r.source === 'padrao');
  const catOptions = state.categories.map((c) => `<option value="${c.id}">${esc(c.icon)} ${esc(c.name)}</option>`).join('');
  view.innerHTML = `
    <div class="grid two">
      <section class="card">
        <h2>${__('Regras de categoria')}</h2>
        <p class="muted small" style="margin-top:0">${__('Se a descrição contém o texto, o lançamento vai para a categoria. As suas regras valem antes das padrão.')}</p>
        <form id="ruleForm" class="filters">
          <input type="text" name="pattern" placeholder="${__('Texto, ex.: PADARIA DO ZE')}" required>
          <select name="category_id">${catOptions}</select>
          <button class="btn sm" type="submit">${__('Adicionar')}</button>
        </form>
        <div class="list">${userRules.map(ruleRow).join('') || `<p class="muted small">${__('Você ainda não criou regras. Dica: ao corrigir a categoria de um lançamento, marque "aplicar para todos".')}</p>`}</div>
        ${aiRules.length ? `<details><summary>${__('Criadas pela IA')} (${aiRules.length}) <span class="pill">${__('revise')}</span></summary><div class="list">${aiRules.map(ruleRow).join('')}</div></details>` : ''}
        <details><summary>${__('Regras padrão')} (${defRules.length})</summary><div class="list">${defRules.map(ruleRow).join('')}</div></details>
        <div class="actions" style="margin-top:10px">
          <button class="btn ghost sm" id="reapply">${__('Reaplicar regras em tudo')}</button>
          <a class="btn ghost sm" href="/api/rules/export" download>⬇️ ${__('Exportar regras')}</a>
          ${state.user.is_admin ? `<label class="btn ghost sm" style="cursor:pointer">⬆️ ${__('Importar regras')}<input type="file" id="rulesFile" accept="application/json,.json" hidden></label>` : ''}
        </div>
        <p class="muted small" style="margin:6px 0 0">${__('O arquivo exportado leva as regras e as categorias que elas usam. Importar junta com as atuais (cria o que falta, não apaga nada).')}</p>
        <div id="aiBox"></div>
      </section>
      <div class="grid">
        <section class="card">
          <h2>${__('Entradas e saídas recorrentes')}</h2>
          <p class="muted small" style="margin-top:0">${__('Salário, aluguel, assinaturas, financiamento do imóvel e do carro. Aparecem na previsão dos próximos meses no painel.')}</p>
          <div class="list">${commitments.map(commRow).join('') || `<p class="muted small">${__('Nenhum cadastrado.')}</p>`}</div>
          <button class="btn ghost sm" id="addFin2" style="margin-top:8px">+ ${__('Adicionar')}</button>
          ${
            suggestions.length
              ? `<details style="margin-top:14px"><summary><b>${suggestions.length} ${__('lançamentos parecem se repetir todo mês')}</b></summary>
                <p class="muted small" style="margin-top:0">${__('Lançamentos com valor parecido em')} ${suggestions.length > 1 ? __('vários') : __('2 ou mais')} ${__('dos últimos 3 meses. Toque para conferir e incluir.')}</p>
                <div class="list">${suggestions
                  .map(
                    (g, i) => `<div class="row" data-sug="${i}"><div class="ic">${esc(g.icon || '🔁')}</div><div class="main"><div class="title">${esc(g.name)}</div>
                      <div class="meta">${g.direction === 'entrada' ? 'entrada' : __('saída')} · ${esc(g.category)} · ${__('visto em')} ${g.seen} ${__('meses')}${state.users.length > 1 ? ` · ${esc(state.users.find((u) => u.id === g.owner_id)?.name || '')}` : ''}</div></div>
                      <div class="amt num ${g.direction === 'entrada' ? 'pos' : ''}">${brl(g.amount)}</div></div>`
                  )
                  .join('')}</div></details>`
              : ''
          }
        </section>
        <section class="card catgroups">
          <h2>${__('Categorias e grupos')}</h2>
          <p class="muted small" style="margin-top:0">${__('Coloque uma categoria dentro de outra para somar as duas no painel (ex.: Contas da casa dentro de Moradia). Os lançamentos continuam com a subcategoria. Nas despesas, marque se é Essencial ou Conforto para o filtro do painel.')}</p>
          ${['despesa', 'receita']
            .map(
              (k) => `<details ${k === 'despesa' ? 'open' : ''}><summary>${k === 'despesa' ? __('Despesas') : __('Receitas')}</summary><div class="list">${catsOrdered(k)
                .map((c) => {
                  const hasKids = state.categories.some((x) => x.parent_id === c.id);
                  const parents = state.categories.filter((p) => p.kind === k && !p.parent_id && p.id !== c.id && p.key !== COST_KEY);
                  return `<div class="row catrow ${c.parent_id ? 'child' : ''}"><button class="ic editcat" data-editcat="${c.id}" title="${__('Editar nome e emoji')}" aria-label="Editar ${esc(c.name)}">${esc(c.icon)}</button>
                    <button class="main editcat" data-editcat="${c.id}" title="${__('Editar nome e emoji')}"><div class="title">${esc(c.name)} <span class="muted small">✏️</span></div></button>
                    <div class="catsels">${k === 'despesa' ? `<select data-nature="${c.id}" class="natsel" aria-label="${__('Tipo de {0}', { 0: esc(c.name) })}">${[['', __('Outras')], ['essencial', __('Essencial')], ['conforto', __('Conforto')]].map(([v, l]) => `<option value="${v}" ${(c.nature || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
                    ${
                      hasKids
                        ? `<span class="muted small">${__('grupo')}</span>`
                        : `<select data-parent="${c.id}" aria-label="${__('Grupo de {0}', { 0: esc(c.name) })}"><option value="">${__('Sem grupo')}</option>${parents
                            .map((p) => `<option value="${p.id}" ${p.id === c.parent_id ? 'selected' : ''}>${__('em')} ${esc(p.icon)} ${esc(p.name)}</option>`)
                            .join('')}</select>`
                    }</div></div>`;
                })
                .join('')}</div></details>`
            )
            .join('')}
        </section>
        <section class="card">
          <h2>${__('Impostos embutidos')} <small>${__('estimativa')}</small></h2>
          <p class="muted small" style="margin-top:0">${__('Carga média aproximada de tributos no preço de cada categoria, usada no card Impostos do painel. Deixe em branco para usar o padrão. Combustível, farmácia, eletrônicos e financiamentos têm carga própria, pelo nome da compra.')}</p>
          <div class="list" id="taxList"><div class="muted small">${__('Carregando')}…</div></div>
        </section>
        <section class="card">
          <h2>${__('Leitores de documentos')}</h2>
          <p class="muted small" style="margin-top:0">${__('Modelos para ler formatos sem leitor próprio (CSV ou PDF de outros bancos), criados por você ou pela IA ao enviar um arquivo novo. São reaproveitados nos próximos arquivos iguais.')}</p>
          <div class="list" id="exList"><div class="muted small">${__('Carregando')}…</div></div>
        </section>
        <section class="card">
          <h2>${__('Cartões')}</h2>
          <p class="muted small" style="margin-top:0">${__('As faturas não dizem se a compra foi online ou presencial.')} <b>${__('Virtual')}</b>: ${__('tudo conta como online.')} <b>${__('Físico')}</b>: ${__('presencial, menos lojas claramente online (Uber, Shopee…).')} <b>${__('Misto')}</b>: ${__('decide pelo nome da loja.')}</p>
          <div class="list" id="cardList"><div class="muted small">${__('Carregando')}…</div></div>
        </section>
        <section class="card">
          <h2>${__('Rendas')}</h2>
          <p class="muted small" style="margin-top:0">${__('Cada renda junta a entrada e as despesas que existem por causa dela (ex.: PJ com contador e impostos). No painel dá para desmarcar uma renda e ver os números sem ela.')}</p>
          <div class="list">${state.sources
            .map(
              (x) => `<button class="row editcat" data-editsrc="${x.id}" style="width:100%"><div class="ic">💼</div><div class="main"><div class="title">${esc(x.name)} <span class="muted small">✏️</span></div>
                <div class="sub muted small">${esc(state.users.find((u) => u.id === x.owner_id)?.name || __('Todos'))} · ${x.matchers.length} ${x.matchers.length === 1 ? __('regra') : __('regras')}</div></div></button>`
            )
            .join('')}</div>
          <button class="btn ghost sm" id="addSrc" style="margin-top:8px">+ ${__('Nova renda')}</button>
        </section>
        <section class="card">
          <h2>${__('Nova categoria')}</h2>
          <form id="catForm">
            <label class="field"><span>${__('Nome')}</span><input type="text" name="name" required></label>
            <div class="filters"><span class="emojipick"><input type="hidden" name="icon" value="">
                <button type="button" class="btn ghost" id="emojiBtn" aria-haspopup="true" aria-expanded="false"><span id="emojiCur">🙂</span> ${__('Escolher emoji')}</button></span>
              <select name="kind"><option value="despesa">${__('Despesa')}</option><option value="receita">${__('Receita')}</option><option value="neutra">${__('Não conta no balanço')}</option></select></div>
            <div class="emojigrid" id="emojiGrid" hidden></div>
            <button class="btn sm" type="submit">${__('Criar categoria')}</button>
          </form>
        </section>
        <section class="card">
          <h2>${__('Pessoas')}</h2>
          <p class="muted small" style="margin-top:0">${__('Os nomes como aparecem nos extratos servem para separar o que é de cada um (titular, cartão adicional) e reconhecer transferências entre vocês.')}</p>
          ${state.users
            .filter((u) => state.user.is_admin || u.id === state.user.id)
            .map(
              (u) => `<form class="userForm" data-id="${u.id}" style="margin-bottom:12px">
                <label class="field"><span><span class="dot" style="background:${esc(u.color)}"></span> ${esc(u.name)} · ${__('usuário')} <b>${esc(u.username)}</b></span>
                <input type="text" name="aliases" value="${esc(u.aliases)}" placeholder="${__('Nomes nos extratos, separados por vírgula')}"></label>
                <button class="btn ghost sm" type="submit">${__('Salvar')}</button></form>`
            )
            .join('')}
        </section>
        ${
          state.user.is_admin
            ? `<section class="card">
          <h2>${__('Usuários')} <small>${__('administração')}</small></h2>
          <p class="muted small" style="margin-top:0">${__('Quem pode entrar no app. Usuário novo recebe uma senha temporária e cria a própria no primeiro acesso. Quem tem lançamentos pode ser desativado (o histórico continua).')}</p>
          <div class="list" id="adminUsers"><div class="muted small">${__('Carregando')}…</div></div>
          <form id="newUser" style="margin-top:12px">
            <h4 class="docsh" style="margin-top:0">${__('Novo usuário')}</h4>
            <div class="filters"><input type="text" name="username" placeholder="${__('usuário (ex.: ana)')}" autocapitalize="none" pattern="[a-z0-9][a-z0-9._-]{2,31}" required>
              <input type="text" name="name" placeholder="${__('Nome (ex.: Ana)')}" required></div>
            <label class="check"><input type="checkbox" name="is_admin"><span>${__('Administrador (pode gerenciar usuários)')}</span></label>
            <button class="btn sm" type="submit">${__('Criar usuário')}</button>
          </form>
        </section>`
            : ''
        }
        <section class="card">
          <h2>${__('Idioma')}</h2>
          <label class="field"><span>${__('Idioma do app')}</span><select id="langSel">${Object.entries(LOCALES).map(([v, l]) => `<option value="${v}" ${v === I18N.locale ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <p class="muted small" style="margin:0">${__('Vale para você em todos os aparelhos. Nomes de categorias, descrições dos lançamentos e textos dos documentos continuam como estão.')}</p>
        </section>
        <section class="card">
          <h2>${__('Minha senha')}</h2>
          <form id="pwForm">
            <label class="field"><span>${__('Senha atual')}</span><input type="password" name="current" autocomplete="current-password" required></label>
            <label class="field"><span>${__('Nova senha (mín. 10)')}</span><input type="password" name="next" autocomplete="new-password" minlength="10" required></label>
            <button class="btn sm" type="submit">${__('Trocar senha')}</button>
          </form>
        </section>
        <section class="card">
          <h2>${__('Sessão')}</h2>
          <p class="muted small" style="margin-top:0">${__('Conectado como')} <b>${esc(state.user.name)}</b>.</p>
          <button class="btn danger sm" id="logout">${__('Sair')}</button>
        </section>
      </div>
    </div>`;

  const again = () => viewAjustes(view);
  $('#langSel', view).addEventListener('change', (e) => changeLocale(e.target.value));
  bindRulesIO(view, again);
  if (state.user.is_admin) bindAdminUsers(view, again);
  $('#addFin2', view).addEventListener('click', () => openCommitment({ first_month: new Date().toISOString().slice(0, 7), owner_id: state.user.id, recurring: 1 }, again));
  $$('[data-cid]', view).forEach((b) => b.addEventListener('click', () => openCommitment(commitments.find((c) => String(c.id) === b.dataset.cid), again)));
  $$('[data-editcat]', view).forEach((b) => b.addEventListener('click', () => openCategory(catById(Number(b.dataset.editcat)), again)));
  $$('[data-nature]', view).forEach((sel) =>
    sel.addEventListener('change', async () => {
      try {
        await api(`/categories/${sel.dataset.nature}`, { method: 'PATCH', body: { nature: sel.value || null } });
        state.categories = await api('/categories');
        toast(__('Tipo da categoria salvo'));
      } catch (e) {
        toast(e.message);
      }
    })
  );
  api('/extractors').then((ex) => {
    const box = $('#exList', view);
    if (!box) return;
    const SRC = { ia: __('🤖 IA'), manual: __('🧩 manual') };
    box.innerHTML =
      ex.saved
        .map(
          (x) => `<div class="row catrow" style="cursor:default"><div class="ic">${x.kind === 'csv' ? '📊' : '📄'}</div><div class="main"><div class="title">${esc(x.name)}${x.enabled ? '' : ` <span class="pill">${__('desativado')}</span>`}</div>
            <div class="sub muted small">${SRC[x.source] || esc(x.source)} · ${x.doc_kind === 'cartao' ? __('fatura') : __('extrato')} · ${x.kind.toUpperCase() === 'TEXT' ? 'PDF' : 'CSV'} · ${__('usado')} ${x.uses}x</div></div>
            <div class="catsels"><button class="btn ghost sm" data-extog="${x.id}" data-on="${x.enabled ? 0 : 1}">${x.enabled ? __('Desativar') : __('Ativar')}</button><button class="btn ghost sm" data-exdel="${x.id}" aria-label="${__('Excluir')}">✕</button></div></div>`
        )
        .join('') +
      `<p class="muted small" style="margin:8px 0 0">Prontos: ${ex.presets.map((p) => esc(p.name)).join(' · ')}.${ex.saved.length ? '' : __(' Nenhum leitor criado ainda.')}</p>`;
    $$('[data-extog]', box).forEach((b) => b.addEventListener('click', async () => (await api(`/extractors/${b.dataset.extog}`, { method: 'PATCH', body: { enabled: b.dataset.on === '1' } }), again())));
    $$('[data-exdel]', box).forEach((b) =>
      b.addEventListener('click', async () => {
        if (!confirm(__('Excluir este leitor? Os arquivos já importados não mudam.'))) return;
        await api(`/extractors/${b.dataset.exdel}`, { method: 'DELETE' });
        again();
      })
    );
  });
  api('/tax-rates').then((tr) => {
    const box = $('#taxList', view);
    if (!box) return;
    box.innerHTML =
      tr.categories
        .map(
          (c) => `<div class="row taxrow" style="cursor:default"><div class="ic">${esc(c.icon)}</div><div class="main"><div class="title">${esc(c.name)}</div></div>
            <label class="taxin"><input type="number" inputmode="decimal" min="0" max="90" step="1" data-taxrate="${c.id}" value="${c.tax_rate == null ? '' : Math.round(c.tax_rate * 100)}" placeholder="${Math.round(c.default * 100)}" aria-label="${__('Carga de {0} em %', { 0: esc(c.name) })}"><span>%</span></label></div>`
        )
        .join('') +
      `<p class="muted small" style="margin:10px 0 0">${__('Pelo nome da compra')}: ${tr.overrides.map((o) => `${esc(__(o.label))} ${Math.round(o.rate * 100)}%`).join(' · ')}.</p>`;
    $$('[data-taxrate]', box).forEach((inp) =>
      inp.addEventListener('change', async () => {
        try {
          await api(`/tax-rates/${inp.dataset.taxrate}`, { method: 'PATCH', body: { rate: inp.value === '' ? null : Number(inp.value) / 100 } });
          toast(__('Percentual salvo'));
        } catch (e) {
          toast(e.message);
        }
      })
    );
  });
  api('/cards').then((cards) => {
    const box = $('#cardList', view);
    if (!box) return;
    box.innerHTML = cards.length
      ? cards
          .map(
            (c) => `<div class="row catrow" style="cursor:default"><div class="ic">💳</div><div class="main"><div class="title">${esc(c.account)}</div>
              <div class="sub muted small">${esc(c.owner || '')} · ${c.n} ${__('compras')} · 🌐 ${c.online} · 🏪 ${c.presencial}</div></div>
              <div class="catsels"><select data-card="${esc(c.account)}" aria-label="${__('Tipo do {0}', { 0: esc(c.account) })}">${[['virtual', __('Virtual (online)')], ['fisico', __('Físico (presencial)')], ['misto', __('Misto')]]
                .map(([v, l]) => `<option value="${v}" ${c.mode === v ? 'selected' : ''}>${l}</option>`)
                .join('')}</select></div></div>`
          )
          .join('')
      : `<p class="muted small">${__('Nenhuma fatura de cartão enviada ainda.')}</p>`;
    $$('[data-card]', box).forEach((sel) =>
      sel.addEventListener('change', async () => {
        await api('/cards', { method: 'PUT', body: { account: sel.dataset.card, mode: sel.value } });
        toast(__('Tipo do cartão salvo'));
        again();
      })
    );
  });
  $$('[data-editsrc]', view).forEach((b) => b.addEventListener('click', () => openSource(state.sources.find((x) => x.id === Number(b.dataset.editsrc)) || {}, again)));
  $('#addSrc', view)?.addEventListener('click', () => openSource({}, again));
  $$('[data-parent]', view).forEach((sel) =>
    sel.addEventListener('change', async () => {
      try {
        await api(`/categories/${sel.dataset.parent}`, { method: 'PATCH', body: { parent_id: sel.value ? Number(sel.value) : null } });
        state.categories = await api('/categories');
        toast(sel.value ? __('Categoria agrupada') : __('Categoria fora do grupo'));
        again();
      } catch (e) {
        toast(e.message);
      }
    })
  );
  $$('[data-sug]', view).forEach((b) =>
    b.addEventListener('click', () => {
      const g = suggestions[Number(b.dataset.sug)];
      openCommitment({ ...g, recurring: 1, first_month: new Date().toISOString().slice(0, 7) }, again);
    })
  );
  $('#ruleForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api('/rules', { method: 'POST', body: { pattern: fd.get('pattern'), category_id: Number(fd.get('category_id')) } });
      toast(__('Regra criada · {0} lançamentos recategorizados', { 0: r.changed }));
      viewAjustes(view);
    } catch (err) {
      toast(err.message);
    }
  });
  $$('[data-rdel]', view).forEach((b) =>
    b.addEventListener('click', async () => {
      await api(`/rules/${b.dataset.rdel}`, { method: 'DELETE' });
      toast(__('Regra removida'));
      viewAjustes(view);
    })
  );
  $('#reapply').addEventListener('click', async () => {
    const r = await api('/rules/apply', { method: 'POST' });
    toast(__('{0} lançamentos atualizados', { 0: r.changed + r.reconciled }));
  });
  bindEmojiPick(view, (e) => ($('#catForm input[name=icon]', view).value = e));
  $('#catForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/categories', { method: 'POST', body: { name: fd.get('name'), icon: fd.get('icon') || '•', kind: fd.get('kind') } });
      await loadMeta();
      toast(__('Categoria criada'));
      viewAjustes(view);
    } catch (err) {
      toast(err.message);
    }
  });
  $$('.userForm', view).forEach((form) =>
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await api(`/users/${form.dataset.id}`, { method: 'PATCH', body: { aliases: new FormData(form).get('aliases') } });
      const me = await api('/me');
      state.users = me.users;
      toast(__('Salvo'));
    })
  );
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/me/password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } });
      e.target.reset();
      toast(__('Senha alterada'));
    } catch (err) {
      toast(err.message);
    }
  });
  $('#logout').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' });
    state.user = null;
    render();
  });
}

function ruleRow(r) {
  return `<div class="row" style="cursor:default"><div class="ic">${esc(r.icon)}</div><div class="main"><div class="title">${esc(r.pattern)}${r.source === 'ia' ? ` <span class="pill">${__('IA')}</span>` : ''}</div><div class="meta">${esc(r.category)}${r.account ? __(' · só em {0}', { 0: esc(r.account) }) : ''}</div></div>
    ${r.source === 'usuario' ? `<button class="btn ghost sm" data-rdel="${r.id}" aria-label="${__('Remover regra')}">✕</button>` : `<button class="btn ghost sm" data-rdel="${r.id}" aria-label="${__('Remover regra')}" title="${__('Remover')}">✕</button>`}</div>`;
}

boot();
