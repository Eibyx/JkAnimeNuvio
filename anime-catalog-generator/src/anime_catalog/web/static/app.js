/* Anime Catalog Generator — interfaz web local (sin dependencias ni CDN).
 * Toda la lógica de filtros, agrupación y mapping vive en el servidor (motor Python existente);
 * este archivo solo construye la configuración, lanza trabajos y muestra resultados. */
'use strict';
(() => {
  const CSRF = document.querySelector('meta[name="csrf-token"]').content;
  const main = document.getElementById('main');
  const titleEl = document.getElementById('page-title');
  let cleanup = [];
  let OPTIONS = null;
  let STATUS = null;

  // ------------------------------------------------------------------ utilidades DOM
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value') el.value = v;
      else if (k === 'style') el.style.cssText = v; // CSSOM: permitido por la CSP (sin estilos en línea)
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  // replaceChildren() convierte null en el texto "null": se filtran los huecos.
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
    return el;
  }
  const ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    jobs: '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    list: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h10M7 13h10M7 17h6"/>',
    play: '<path d="M7 5l12 7-12 7z"/>',
    sync: '<path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3"/><path d="M18 3v4h-4M6 21v-4h4"/>',
    save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    retry: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v4h4"/>',
  };
  function icon(name) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name] || '';
    return s;
  }
  const fmtNum = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('es-ES'));
  function fmtAgo(ts) {
    if (!ts) return '—';
    const s = Math.round(Date.now() / 1000 - ts);
    if (s < 60) return 'hace unos segundos';
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
    return new Date(ts * 1000).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function fmtDur(sec) {
    if (sec === null || sec === undefined) return '—';
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m} min ${s} s` : `${s} s`;
  }
  const STATUS_LABEL = {
    confirmed: ['Confirmado', 'ok'], high_confidence: ['Alta confianza', 'ok'], needs_review: ['Revisar', 'warn'],
    unmapped: ['Sin mapping', 'bad'], conflict: ['Conflicto', 'bad'], excluded: ['Excluido', ''],
    queued: ['En cola', 'info'], running: ['En curso', 'accent'], done: ['Completado', 'ok'], failed: ['Error', 'bad'],
    cancelled: ['Cancelado', 'warn'], interrupted: ['Interrumpido', 'warn'], ok: ['Correcto', 'ok'], updated: ['Actualizado', 'ok'],
    unchanged: ['Sin cambios', 'info'], 'no descargado': ['No descargado', 'warn'],
  };
  function badge(status, text) {
    const [label, kind] = STATUS_LABEL[status] || [status || '—', ''];
    return h('span', { class: `badge ${kind}` }, h('span', { class: 'dot' }), text || label);
  }

  // ------------------------------------------------------------------ API
  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: { Accept: 'application/json' } };
    if (init.method !== 'GET') init.headers['X-CSRF-Token'] = CSRF;
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    if (opts.signal) init.signal = opts.signal;
    const res = await fetch(path, init);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.detail) ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  function toast(msg, kind = '') {
    const t = h('div', { class: `toast ${kind}` }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
  }
  function showError(err) { toast(err.message || String(err), 'bad'); }

  // ------------------------------------------------------------------ modal
  function modal({ title, body, actions }) {
    const wrap = document.getElementById('modal');
    document.getElementById('modal-title').textContent = title;
    const b = document.getElementById('modal-body');
    fill(b, body);
    const a = document.getElementById('modal-actions');
    fill(a, );
    const prevFocus = document.activeElement;
    const close = () => { wrap.hidden = true; document.removeEventListener('keydown', onKey); if (prevFocus) prevFocus.focus(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    for (const act of actions || []) {
      const btn = h('button', { class: `btn ${act.kind || ''}`, type: 'button', onclick: async () => {
        if (act.onClick) { const r = await act.onClick(btn); if (r === false) return; }
        close();
      } }, act.label);
      if (act.disabled) btn.disabled = true;
      if (act.ref) act.ref(btn);
      a.append(btn);
    }
    wrap.hidden = false;
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    document.addEventListener('keydown', onKey);
    setTimeout(() => (a.querySelector('.btn') || b).focus(), 30);
    return close;
  }

  // ------------------------------------------------------------------ tema
  const THEMES = ['auto', 'light', 'dark'];
  function applyTheme(t) {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }
  function getTheme() { try { return localStorage.getItem('theme') || 'auto'; } catch { return 'auto'; } }
  function setTheme(t) { try { localStorage.setItem('theme', t); } catch { /* sin almacenamiento */ } applyTheme(t); }
  applyTheme(getTheme());
  document.getElementById('btn-theme').addEventListener('click', () => {
    const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
    setTheme(next);
    toast(`Tema: ${{ auto: 'automático', light: 'claro', dark: 'oscuro' }[next]}`);
  });

  // ------------------------------------------------------------------ navegación
  const NAV = [
    { hash: '#/', label: 'Inicio', icon: 'home' },
    { hash: '#/crear', label: 'Crear', icon: 'plus' },
    { hash: '#/trabajos', label: 'Trabajos', icon: 'jobs' },
    { hash: '#/explorador', label: 'Explorador', icon: 'search' },
    { hash: '#/listas', label: 'Listas', icon: 'list' },
  ];
  function renderNav() {
    for (const id of ['nav-side', 'nav-bottom']) {
      const nav = document.getElementById(id);
      fill(nav, ...NAV.map((n) => h('a', { href: n.hash, dataset: { hash: n.hash } }, icon(n.icon), h('span', {}, n.label))));
    }
  }
  function markNav(hash) {
    const root = '#/' + (hash.split('/')[1] || '').split('?')[0];
    document.querySelectorAll('[data-hash]').forEach((a) => {
      const match = a.dataset.hash === (root === '#/' ? '#/' : root);
      if (match) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function parseHash() {
    const raw = location.hash || '#/';
    const [path, query] = raw.slice(1).split('?');
    const parts = path.split('/').filter(Boolean);
    return { parts, query: new URLSearchParams(query || '') };
  }
  const back = document.getElementById('btn-back');
  back.addEventListener('click', () => history.back());

  async function route() {
    for (const fn of cleanup) { try { fn(); } catch { /* ignorar */ } }
    cleanup = [];
    const { parts, query } = parseHash();
    markNav(location.hash || '#/');
    back.hidden = parts.length < 2;
    fill(main, h('div', { class: 'loading-view' }, h('div', { class: 'spinner' }), h('p', {}, 'Cargando…')));
    const view = parts[0] || '';
    try {
      if (view === '') await viewDashboard();
      else if (view === 'crear') await viewGenerator(query);
      else if (view === 'trabajos' && parts[1]) await viewJob(parts[1]);
      else if (view === 'trabajos') await viewJobs();
      else if (view === 'explorador' && parts[1]) await viewMappingDetail(decodeURIComponent(parts[1]));
      else if (view === 'explorador') await viewExplorer(query);
      else if (view === 'listas' && parts[1]) await viewListItems(parts[1], query);
      else if (view === 'listas') await viewLists();
      else if (view === 'ajustes') await viewSettings();
      else { setTitle('No encontrado'); fill(main, h('div', { class: 'empty' }, 'Página no encontrada.')); }
    } catch (err) {
      fill(main, h('div', { class: 'callout bad' }, `No se pudo cargar: ${err.message}`));
    }
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }
  function setTitle(t) { titleEl.textContent = t; document.title = `${t} · Anime Catalog`; }
  window.addEventListener('hashchange', route);

  async function loadStatus() {
    try { STATUS = await api('/api/status'); } catch { STATUS = null; }
    const ind = document.getElementById('jobs-indicator');
    if (STATUS && STATUS.active_jobs) {
      ind.hidden = false;
      ind.textContent = `${STATUS.active_jobs} en curso`;
    } else ind.hidden = true;
    return STATUS;
  }
  // Sondeo ligero del indicador solo con la pestaña visible (ahorro de batería).
  setInterval(() => { if (document.visibilityState === 'visible') loadStatus(); }, 8000);

  async function getOptions() {
    if (!OPTIONS) OPTIONS = await api('/api/options');
    return OPTIONS;
  }

  // ------------------------------------------------------------------ componentes
  function kpi(label, value, hint, href) {
    const body = [h('span', { class: 'label' }, label), h('span', { class: 'value' }, value), hint ? h('span', { class: 'hint' }, hint) : null];
    return href ? h('a', { class: 'card kpi', href, style: 'color:inherit;text-decoration:none' }, body) : h('div', { class: 'card kpi' }, body);
  }
  function progressBar(percent, active) {
    const known = percent !== null && percent !== undefined;
    const bar = h('div', { class: `progress ${!known && active ? 'indeterminate' : ''}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' });
    if (known) bar.setAttribute('aria-valuenow', String(percent));
    bar.append(h('span', { style: `width:${known ? percent : (active ? 35 : 0)}%` }));
    return bar;
  }
  function table(columns, rows, onRow) {
    const thead = h('thead', {}, h('tr', {}, columns.map((c) => h('th', { scope: 'col' }, c.label))));
    const tbody = h('tbody', {}, rows.map((r) => {
      const tr = h('tr', onRow ? { style: 'cursor:pointer', tabindex: '0', onclick: () => onRow(r), onkeydown: (e) => { if (e.key === 'Enter') onRow(r); } } : {},
        columns.map((c) => { const v = c.render ? c.render(r) : r[c.key]; return h('td', { class: c.num ? 'num' : '' }, v === null || v === undefined || v === '' ? '—' : v); }));
      return tr;
    }));
    return h('div', { class: 'table-wrap' }, h('table', {}, thead, tbody));
  }
  function pager(data, onPage) {
    const known = data.pages !== null && data.pages !== undefined;
    const hasPrev = data.page > 1;
    const hasNext = known ? data.page < data.pages : !!data.has_more;
    return h('div', { class: 'pager' },
      h('button', { class: 'btn small', disabled: !hasPrev, onclick: () => onPage(data.page - 1) }, '‹ Anterior'),
      h('span', { class: 'muted small' }, known ? `Página ${data.page} de ${data.pages} · ${fmtNum(data.total)} elementos` : `Página ${data.page}`),
      h('button', { class: 'btn small', disabled: !hasNext, onclick: () => onPage(data.page + 1) }, 'Siguiente ›'));
  }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function section(title, summary, open, ...body) {
    return h('details', { class: 'section', open }, h('summary', {}, title, summary ? h('span', { class: 'sum' }, summary) : null), h('div', { class: 'body' }, body));
  }

  // ================================================================== DASHBOARD
  async function viewDashboard() {
    setTitle('Inicio');
    const d = await api('/api/dashboard');
    await loadStatus();
    const s = d.settings;
    const nodes = [];
    nodes.push(h('div', { class: 'card hero fade-in' },
      h('h2', {}, 'Crea un catálogo de anime'),
      h('p', {}, 'Filtra AniList o MyAnimeList, agrupa las temporadas de cada serie y sincroniza la lista con MDBList.'),
      h('div', { class: 'row' }, h('a', { class: 'btn', href: '#/crear' }, icon('plus'), 'Nuevo catálogo'),
        h('a', { class: 'btn ghost', href: '#/explorador', style: 'color:#fff' }, 'Explorar mappings'))));
    if (!s.mdblist) nodes.push(h('div', { class: 'callout warn' }, 'Falta la API key de MDBList: puedes simular catálogos, pero para crear listas configúrala en ', h('a', { href: '#/ajustes' }, 'Ajustes'), '.'));
    if (!s.tmdb) nodes.push(h('div', { class: 'callout' }, 'Sin TMDB los IDs no se validan (quedan como «alta confianza»). Añade la clave en ', h('a', { href: '#/ajustes' }, 'Ajustes'), ' para confirmar los mappings.'));
    nodes.push(h('div', { class: 'grid kpis' },
      kpi('Catálogos', fmtNum(d.catalogs), `${fmtNum(d.profiles)} perfiles guardados`),
      kpi('Animes identificados', fmtNum(d.anime_identified), 'series canónicas y películas'),
      kpi('Series', fmtNum(d.series), 'TMDB TV'),
      kpi('Películas', fmtNum(d.movies), 'TMDB Movie'),
      kpi('Mappings resueltos', fmtNum(d.mappings_resolved), 'confirmados o de alta confianza'),
      kpi('Pendientes', fmtNum(d.mappings_pending), 'revisión, conflictos o sin mapping', '#/explorador?tab=revision'),
      kpi('Duplicados eliminados', fmtNum(d.duplicates_removed), 'última ejecución de cada catálogo'),
      kpi('Última sincronización', d.last_sync ? fmtAgo(d.last_sync.finished_at || d.last_sync.started_at) : 'Nunca', d.last_sync ? d.last_sync.catalog : 'sin escrituras en MDBList')));
    if (d.active_jobs.length) {
      nodes.push(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'En curso')),
        h('ul', { class: 'list' }, d.active_jobs.map((j) => h('li', {}, h('div', { class: 'grow' }, h('a', { href: `#/trabajos/${j.id}` }, j.title),
          h('div', { class: 'muted small' }, j.phase), progressBar(j.percent, true)), badge(j.status))))));
    }
    const ds = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Datasets de mappings'),
      h('button', { class: 'btn small', onclick: () => startDatasets(false) }, icon('sync'), 'Actualizar')),
    h('ul', { class: 'list' }, d.datasets.map((x) => h('li', {}, h('div', { class: 'grow' }, h('strong', {}, x.source),
      h('div', { class: 'muted small ellipsis' }, x.version ? `${x.version} · ${fmtNum(x.rows)} filas` : (x.enabled_by_default ? 'Se descargará al crear el primer catálogo' : 'Opcional (desactivado por defecto)'))),
    badge(x.status === 'ok' ? 'ok' : x.status)))));
    const runs = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Últimas ejecuciones'), h('a', { href: '#/listas?tab=historial', class: 'small' }, 'Historial')),
      d.recent_runs.length ? h('ul', { class: 'list' }, d.recent_runs.map((r) => h('li', {}, h('div', { class: 'grow' }, h('div', { class: 'ellipsis' }, h('strong', {}, r.catalog)),
        h('div', { class: 'muted small' }, `${r.dry_run ? 'Simulación' : 'Sincronización'} · ${fmtAgo(r.started_at)} · ${fmtNum(r.valid_titles)} válidos · ${fmtNum(r.new_titles)} nuevos${r.added ? ` · ${r.added} añadidos` : ''}`)), badge(r.status))))
        : h('div', { class: 'empty' }, 'Todavía no hay ejecuciones.'));
    nodes.push(h('div', { class: 'grid two' }, ds, runs));
    fill(main, ...nodes);
  }

  async function startDatasets(force) {
    try {
      const job = await api('/api/jobs/datasets', { method: 'POST', body: { force } });
      location.hash = `#/trabajos/${job.id}`;
    } catch (e) { showError(e); }
  }

  // ================================================================== GENERADOR
  const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  function setPath(obj, path, value) {
    const keys = path.split('.');
    let o = obj;
    for (const k of keys.slice(0, -1)) { if (o[k] === null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
    o[keys[keys.length - 1]] = value;
  }
  function loadDraft() { try { return JSON.parse(localStorage.getItem('generator-draft') || 'null'); } catch { return null; } }
  function saveDraft(d) { try { localStorage.setItem('generator-draft', JSON.stringify(d)); } catch { /* sin almacenamiento */ } }

  async function viewGenerator(query) {
    setTitle('Crear catálogo');
    const opts = await getOptions();
    await loadStatus();
    let form = structuredClone(opts.defaults);
    const ui = { dateMode: 'range', expressionYaml: '', profile: '' };
    const draft = loadDraft();
    if (draft && !query.get('perfil') && !query.get('nuevo')) { form = draft.form; Object.assign(ui, draft.ui || {}); }
    if (query.get('perfil')) {
      const p = await api(`/api/profiles/${encodeURIComponent(query.get('perfil'))}`);
      form = p.config; ui.profile = p.name; ui.expressionYaml = '';
    }
    if (query.get('lista')) { setPath(form, 'mdblist.list_id', Number(query.get('lista'))); if (query.get('nombre')) setPath(form, 'catalog.name', query.get('nombre')); }
    if (form.filters.expression) { ui.expressionYaml = '# expresión cargada del perfil (se conserva)\n'; ui.keepExpression = form.filters.expression; }
    detectDateMode();

    function detectDateMode() {
      const f = form.filters;
      if (f.date_from || f.date_to) ui.dateMode = 'dates';
      else if ((f.decades || []).length) ui.dateMode = 'decades';
      else if ((f.years || []).length) ui.dateMode = 'years';
      else if (f.start_year || f.end_year) ui.dateMode = 'range';
      else if (!draft) ui.dateMode = 'range';
    }
    const persist = debounce(() => saveDraft({ form, ui }), 400);
    const get = (p) => getPath(form, p);
    const set = (p, v) => { setPath(form, p, v); persist(); refreshSummaries(); };
    const summaries = [];
    function refreshSummaries() { for (const fn of summaries) fn(); }

    // ----- campos enlazados
    function text(path, label, attrs = {}) {
      const id = `f-${path.replace(/\W/g, '-')}`;
      const inp = h('input', { id, type: 'text', value: get(path) ?? '', ...attrs, oninput: (e) => set(path, e.target.value.trim() || null) });
      return h('div', { class: 'field' }, h('label', { for: id }, label), inp, attrs.help ? h('span', { class: 'help' }, attrs.help) : null);
    }
    function number(path, label, attrs = {}) {
      const id = `f-${path.replace(/\W/g, '-')}`;
      const v = get(path);
      const inp = h('input', { id, type: 'number', inputmode: 'decimal', value: v ?? '', min: attrs.min, max: attrs.max, step: attrs.step || 'any', placeholder: attrs.placeholder,
        oninput: (e) => set(path, e.target.value === '' ? null : Number(e.target.value)) });
      return h('div', { class: 'field' }, h('label', { for: id }, label), inp, attrs.help ? h('span', { class: 'help' }, attrs.help) : null);
    }
    function sw(path, label, help, onChange) {
      const inp = h('input', { type: 'checkbox', checked: !!get(path), role: 'switch', onchange: (e) => { set(path, e.target.checked); if (onChange) onChange(e.target.checked); } });
      return h('label', { class: 'switch' }, h('span', { class: 'txt' }, h('span', {}, label), help ? h('span', { class: 'help muted small' }, help) : null), inp);
    }
    function select(path, label, choices, attrs = {}) {
      const id = `f-${path.replace(/\W/g, '-')}`;
      const cur = get(path);
      const s = h('select', { id, onchange: (e) => { const v = e.target.value; set(path, v === '' ? null : (attrs.numeric ? Number(v) : v)); if (attrs.onChange) attrs.onChange(v); } },
        choices.map(([v, l]) => h('option', { value: v, selected: String(cur ?? '') === String(v) ? 'selected' : null }, l)));
      return h('div', { class: 'field' }, h('label', { for: id }, label), s, attrs.help ? h('span', { class: 'help' }, attrs.help) : null);
    }
    function seg(path, choices, onChange) {
      const wrap = h('div', { class: 'seg', role: 'group' });
      const render = () => fill(wrap, ...choices.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(get(path) === v),
        onclick: () => { set(path, v); render(); if (onChange) onChange(v); } }, l)));
      render();
      return wrap;
    }
    // Chips de tres estados: neutro -> incluir -> excluir -> neutro (NOT = excluir).
    function triChips(basePath, values, { exclude = true, upper = false } = {}) {
      const wrap = h('div', { class: 'chips' });
      const norm = (v) => (upper ? String(v).toUpperCase() : v);
      const lists = () => {
        let b = get(basePath);
        if (!b) { b = { include: [], exclude: [] }; setPath(form, basePath, b); }
        b.include = b.include || []; b.exclude = b.exclude || [];
        return b;
      };
      const stateOf = (v) => { const b = lists(); return b.include.map(norm).includes(norm(v)) ? 'include' : (b.exclude.map(norm).includes(norm(v)) ? 'exclude' : 'none'); };
      const render = () => fill(wrap, ...values.map((v) => {
        const st = stateOf(v);
        return h('button', { type: 'button', class: 'chip', 'data-state': st, 'aria-label': `${v}: ${st === 'include' ? 'incluido' : st === 'exclude' ? 'excluido' : 'sin filtrar'}`,
          onclick: () => {
            const b = lists();
            b.include = b.include.filter((x) => norm(x) !== norm(v));
            b.exclude = b.exclude.filter((x) => norm(x) !== norm(v));
            if (st === 'none') b.include.push(v); else if (st === 'include' && exclude) b.exclude.push(v);
            set(basePath, b); render();
          } }, st === 'include' ? '＋ ' : st === 'exclude' ? '− ' : '', v);
      }));
      render();
      wrap.rerender = render;
      return wrap;
    }
    function toggleChips(path, values, labels) {
      const wrap = h('div', { class: 'chips' });
      const render = () => fill(wrap, ...values.map((v) => {
        const cur = get(path) || [];
        const on = cur.includes(v);
        return h('button', { type: 'button', class: 'chip', 'aria-pressed': String(on), onclick: () => {
          const now = (get(path) || []).filter((x) => x !== v);
          if (!on) now.push(v);
          set(path, now); render();
        } }, (labels && labels[v]) || v);
      }));
      render();
      return wrap;
    }
    function rangePair(base, label, help) {
      return h('div', { class: 'field' }, h('span', { class: 'label' }, label),
        h('div', { class: 'fields c2' }, number(`${base}.min`, 'Mínimo', { placeholder: 'sin mínimo' }), number(`${base}.max`, 'Máximo', { placeholder: 'sin máximo' })),
        help ? h('span', { class: 'help' }, help) : null);
    }
    function summaryOf(fn) { const span = h('span', {}); const upd = () => { span.textContent = fn(); }; summaries.push(upd); upd(); return span; }

    // ----- secciones
    const listSelect = h('div', {});
    async function loadLists() {
      if (!STATUS || !STATUS.settings.mdblist) { fill(listSelect, h('p', { class: 'muted small' }, 'Configura MDBList en Ajustes para elegir una lista existente.')); return; }
      try {
        const lists = await api('/api/mdblist/lists');
        fill(listSelect, select('mdblist.list_id', 'Lista de destino', [['', 'Usar/crear la lista con el nombre del catálogo'], ...lists.map((l) => [String(l.id), `${l.name} (${fmtNum(l.items)} elementos)`])],
          { numeric: true, help: 'Si eliges una lista existente se usa por su ID (evita ambigüedades por nombre).' }));
      } catch (e) { fill(listSelect, h('p', { class: 'muted small' }, `No se pudieron cargar tus listas: ${e.message}`)); }
    }

    const basics = section('Catálogo y fuente', null, true,
      text('catalog.name', 'Nombre de la lista', { maxlength: 120, required: true, help: 'Se usará como nombre de la lista en MDBList.' }),
      text('catalog.description', 'Descripción (opcional)'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Fuente de datos'),
        seg('source.primary', [['anilist', 'AniList'], ['myanimelist', 'MyAnimeList'], ['hybrid', 'Híbrido']], () => { refreshScoreUI(); }),
        h('span', { class: 'help' }, 'Híbrido: AniList como fuente principal y MyAnimeList (Jikan) para completar la puntuación MAL.')),
      sw('source.enrich_mal_scores', 'Completar puntuación de MyAnimeList', 'Consulta Jikan (≈1 solicitud/s) solo para los animes evaluados.'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Formatos'), toggleChips('filters.formats', opts.formats)));

    // Fechas
    const dateBody = h('div', { class: 'stack' });
    const decadesList = [1960, 1970, 1980, 1990, 2000, 2010, 2020];
    function renderDates() {
      const f = form.filters;
      const modeSeg = h('div', { class: 'seg', role: 'group' }, [['range', 'Rango de años'], ['decades', 'Décadas'], ['years', 'Años sueltos'], ['dates', 'Fechas exactas'], ['none', 'Sin fecha']].map(([v, l]) =>
        h('button', { type: 'button', 'aria-pressed': String(ui.dateMode === v), onclick: () => {
          ui.dateMode = v;
          for (const k of ['start_year', 'end_year', 'date_from', 'date_to']) f[k] = null;
          f.decades = []; f.years = [];
          persist(); refreshSummaries(); renderDates();
        } }, l)));
      let body;
      if (ui.dateMode === 'range') body = h('div', { class: 'fields c2' }, number('filters.start_year', 'Año inicial', { min: 1900, max: 2100, step: 1 }), number('filters.end_year', 'Año final (inclusive)', { min: 1900, max: 2100, step: 1 }));
      else if (ui.dateMode === 'decades') body = h('div', { class: 'field' }, h('span', { class: 'label' }, 'Décadas'), toggleChips('filters.decades', decadesList, Object.fromEntries(decadesList.map((d) => [d, `${d}s`]))));
      else if (ui.dateMode === 'years') {
        const inp = h('input', { type: 'text', inputmode: 'numeric', value: (f.years || []).join(', '), placeholder: '2018, 2021, 2024',
          oninput: (e) => set('filters.years', e.target.value.split(/[\s,;]+/).map(Number).filter((n) => n >= 1900 && n <= 2100)) });
        body = h('div', { class: 'field' }, h('label', {}, 'Años (separados por comas)'), inp);
      } else if (ui.dateMode === 'dates') {
        const d = (path, label) => h('div', { class: 'field' }, h('label', {}, label), h('input', { type: 'date', value: get(path) || '', oninput: (e) => set(path, e.target.value || null) }));
        body = h('div', { class: 'stack' }, h('div', { class: 'fields c2' }, d('filters.date_from', 'Desde'), d('filters.date_to', 'Hasta')),
          select('filters.partial_dates', 'Fechas incompletas (p. ej. solo «2020»)', [['strict', 'Estricto: todo el periodo dentro del rango'], ['overlap', 'Solapamiento: basta con que coincida en parte']]));
      } else body = h('p', { class: 'muted small' }, 'Sin filtro de fecha: se recorre todo el catálogo (más lento). Con estudio(s) y sin fecha se consultan directamente sus obras.');
      const excl = h('input', { type: 'text', inputmode: 'numeric', value: (f.exclude_years || []).join(', '), placeholder: 'ninguno',
        oninput: (e) => set('filters.exclude_years', e.target.value.split(/[\s,;]+/).map(Number).filter((n) => n >= 1900 && n <= 2100)) });
      fill(dateBody, modeSeg, body,
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Temporadas'), toggleChips('filters.seasons', opts.seasons, { WINTER: 'Invierno', SPRING: 'Primavera', SUMMER: 'Verano', FALL: 'Otoño' })),
        h('div', { class: 'field' }, h('label', {}, 'Excluir años'), excl),
        sw('filters.include_future', 'Incluir estrenos futuros', 'Por defecto no se añaden animes que aún no se han estrenado.'),
        select('filters.unknown_dates', 'Animes sin fecha conocida', [['exclude', 'Excluir'], ['include', 'Incluir']]));
    }
    renderDates();
    const dates = section('Fechas y temporadas', summaryOf(() => {
      const f = form.filters;
      if (ui.dateMode === 'range') return `${f.start_year || '…'}–${f.end_year || '…'}`;
      if (ui.dateMode === 'decades') return (f.decades || []).map((d) => `${d}s`).join(', ') || 'elige décadas';
      if (ui.dateMode === 'years') return (f.years || []).join(', ') || 'elige años';
      if (ui.dateMode === 'dates') return `${f.date_from || '…'} → ${f.date_to || '…'}`;
      return 'sin fecha';
    }), true, dateBody);

    // Agrupación
    const groupingSwitch = h('input', { type: 'checkbox', role: 'switch', checked: !!(form.canonical.enabled && form.canonical.collapse_seasons), onchange: (e) => {
      const on = e.target.checked;
      form.canonical.enabled = on; form.canonical.collapse_seasons = on; form.canonical.first_only = on;
      if (!on) { form.filters.temporal_mode = 'entry_release_year'; form.filters.metadata_scope = 'entry'; }
      persist(); renderTemporal();
    } });
    const temporalBox = h('div', { class: 'stack' });
    function renderTemporal() {
      const on = form.canonical.enabled;
      const modes = [
        ['original_release_year', 'Estreno original', 'La serie entra si su PRIMERA temporada se estrenó en el rango. Attack on Titan (2013) no entra en 2020-2026.'],
        ['any_season_release_year', 'Cualquier temporada', 'Entra si alguna temporada de emisión se estrenó en el rango. Se añade la serie una sola vez.'],
        ['entry_release_year', 'Entrada individual', 'Cada entrada se evalúa con sus propios datos (fecha, nota, tags) y después se agrupa.'],
      ];
      fill(temporalBox, 
        h('div', { class: 'choice-cards', role: 'radiogroup', 'aria-label': 'Modo temporal' }, modes.map(([v, l, d]) => h('label', { class: 'choice' },
          h('input', { type: 'radio', name: 'tmode', value: v, checked: form.filters.temporal_mode === v, disabled: !on && v !== 'entry_release_year' ? 'disabled' : null,
            onchange: () => { form.filters.temporal_mode = v; form.filters.metadata_scope = v === 'entry_release_year' ? 'entry' : (form.filters.metadata_scope === 'entry' ? 'canonical' : form.filters.metadata_scope); persist(); renderTemporal(); } }),
          h('span', {}, h('strong', {}, l), h('span', { class: 'muted small' }, d))))),
        form.filters.temporal_mode !== 'entry_release_year'
          ? select('filters.metadata_scope', 'Puntuación, géneros, tags y estudios se evalúan sobre…', [['canonical', 'La serie original (canónica)'], ['any_member', 'Cualquier temporada del grupo']],
            { help: 'Las temporadas pueden tener notas, tags o estudios distintos (p. ej. AoT Final Season es de MAPPA).' })
          : h('p', { class: 'muted small' }, 'En modo «entrada individual» los metadatos se evalúan sobre cada entrada.'),
        on ? h('details', {}, h('summary', { class: 'small muted' }, 'Opciones avanzadas de agrupación'), h('div', { class: 'stack' },
          sw('canonical.first_only', 'Una sola entrada por serie (first-only)'),
          sw('canonical.merge_unmapped_sequels', 'Agrupar continuaciones nuevas sin mapping', 'Una temporada recién anunciada se agrega a su serie; nunca une dos series distintas.'),
          sw('canonical.complete_shows_from_mappings', 'Buscar la temporada 1 con el índice inverso de mappings'),
          sw('canonical.preserve_independent_movies', 'Películas siempre como obras independientes'))) : h('div', { class: 'callout warn' }, 'Sin agrupación cada entrada se trata por separado (las temporadas que comparten TMDB se deduplican igualmente).'));
    }
    renderTemporal();
    const grouping = section('Agrupar temporadas', summaryOf(() => (form.canonical.enabled ? { original_release_year: 'estreno original', any_season_release_year: 'cualquier temporada', entry_release_year: 'entrada individual' }[form.filters.temporal_mode] : 'desactivado')), true,
      h('label', { class: 'switch' }, h('span', { class: 'txt' }, h('span', {}, 'Agrupar temporadas de una misma serie'),
        h('span', { class: 'help muted small' }, 'Primera temporada, continuaciones y partes divididas se reúnen en la serie original. Remakes, spin-offs y películas quedan separados.')), groupingSwitch),
      temporalBox);

    // Puntuación
    const scoreBox = h('div', { class: 'stack' });
    function refreshScoreUI() {
      const s = form.filters.score;
      const enabled = !!s;
      const toggle = h('label', { class: 'switch' }, h('span', {}, 'Filtrar por puntuación'), h('input', { type: 'checkbox', role: 'switch', checked: enabled,
        onchange: (e) => { form.filters.score = e.target.checked ? { provider: form.source.primary === 'myanimelist' ? 'myanimelist' : 'anilist', field: form.source.primary === 'myanimelist' ? 'score' : 'averageScore', min: null, max: null, normalize: false, min_votes: null, missing: 'exclude' } : null; persist(); refreshSummaries(); refreshScoreUI(); } }));
      if (!enabled) { fill(scoreBox, toggle); return; }
      const isMal = s.provider === 'myanimelist';
      const scale = isMal && !s.normalize ? 10 : 100;
      const slider = (key) => {
        const val = s[key] ?? (key === 'min' ? 0 : scale);
        const out = h('output', { class: 'mono' }, s[key] ?? '—');
        const r = h('input', { type: 'range', min: 0, max: scale, step: scale === 10 ? 0.1 : 1, value: val, 'aria-label': key === 'min' ? 'Puntuación mínima' : 'Puntuación máxima',
          oninput: (e) => { s[key] = Number(e.target.value); out.textContent = s[key]; persist(); refreshSummaries(); } });
        return h('div', { class: 'field' }, h('div', { class: 'row between' }, h('span', { class: 'label' }, key === 'min' ? 'Mínimo' : 'Máximo'), out), r,
          h('button', { type: 'button', class: 'btn ghost small', onclick: () => { s[key] = null; persist(); refreshScoreUI(); } }, 'Sin límite'));
      };
      fill(scoreBox, toggle,
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Proveedor de la puntuación'),
          seg('filters.score.provider', [['anilist', 'AniList (0-100)'], ['myanimelist', 'MyAnimeList (0-10)']], (v) => {
            s.field = v === 'myanimelist' ? 'score' : 'averageScore'; s.min = null; s.max = null; s.min_votes = null;
            if (v === 'myanimelist' && form.source.primary === 'anilist') { form.source.enrich_mal_scores = true; toast('Se activará la consulta de puntuaciones de MyAnimeList (Jikan).'); }
            persist(); refreshScoreUI();
          })),
        !isMal ? select('filters.score.field', 'Campo', [['averageScore', 'Average Score (media ponderada)'], ['meanScore', 'Mean Score (media simple)']])
          : h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s.normalize, onchange: (e) => { s.normalize = e.target.checked; s.min = null; s.max = null; persist(); refreshScoreUI(); } }),
            h('span', {}, 'Escala porcentual (0-100)', h('span', { class: 'help muted small', style: 'display:block' }, 'Interpreta mínimo y máximo como porcentaje (8,0 en MAL = 80 %).'))),
        h('div', { class: 'fields c2' }, slider('min'), slider('max')),
        isMal ? number('filters.score.min_votes', 'Mínimo de votos en MAL', { min: 0, step: 1, placeholder: 'sin mínimo' }) : null,
        select('filters.score.missing', 'Animes sin puntuación', [['exclude', 'Excluir'], ['include', 'Incluir']]),
        h('p', { class: 'muted small' }, 'Las escalas nunca se mezclan: AniList puntúa 0-100 y MyAnimeList 0-10.'));
    }
    refreshScoreUI();
    const score = section('Puntuación', summaryOf(() => { const s = form.filters.score; return s ? `${s.provider === 'anilist' ? 'AniList' : 'MAL'} ${s.min ?? '…'}–${s.max ?? '…'}` : 'sin filtro'; }), false, scoreBox);

    // Géneros y tags
    const genreChips = triChips('filters.genres', opts.genres);
    const tagBox = h('div', { class: 'chips' });
    let tagQuery = '';
    let tagCat = '';
    const categories = [...new Set(opts.tags.map((t) => t.category).filter(Boolean))].sort();
    function renderTags() {
      const b = form.filters.tags || { include: [], exclude: [] };
      const chosen = new Set([...(b.include || []), ...(b.exclude || [])]);
      const q = tagQuery.toLowerCase();
      const matches = opts.tags.filter((t) => (!t.adult || form.filters.include_adult) && (!tagCat || t.category === tagCat) && (!q || t.name.toLowerCase().includes(q)) && !chosen.has(t.name)).slice(0, 60).map((t) => t.name);
      const chips = triChips('filters.tags', [...chosen, ...matches]);
      fill(tagBox, chips);
      if (!opts.tags.length) tagBox.append(h('p', { class: 'muted small' }, opts.note || 'Lista de tags no disponible.'));
    }
    renderTags();
    const rankOut = h('output', { class: 'mono' }, String((form.filters.tags || {}).min_rank ?? 0));
    const genres = section('Géneros y tags', summaryOf(() => {
      const g = form.filters.genres || {}; const t = form.filters.tags || {};
      const n = (g.include || []).length + (g.exclude || []).length + (t.include || []).length + (t.exclude || []).length;
      return n ? `${n} seleccionados` : 'sin filtro';
    }), false,
    h('p', { class: 'chips-legend' }, 'Toca una vez para incluir (＋), otra para excluir (−, operador NOT) y otra para quitar.'),
    h('div', { class: 'field' }, h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Géneros'), seg('filters.genres.mode', [['OR', 'Alguno (OR)'], ['AND', 'Todos (AND)']])), genreChips),
    h('div', { class: 'field' }, h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Tags de AniList'), seg('filters.tags.mode', [['OR', 'Alguno (OR)'], ['AND', 'Todos (AND)']])),
      h('div', { class: 'fields c2' }, h('input', { type: 'search', placeholder: 'Buscar tag (Isekai, Magic…)', 'aria-label': 'Buscar tag', oninput: debounce((e) => { tagQuery = e.target.value.trim(); renderTags(); }, 200) }),
        h('select', { 'aria-label': 'Categoría de tag', onchange: (e) => { tagCat = e.target.value; renderTags(); } }, h('option', { value: '' }, 'Todas las categorías'), categories.map((c) => h('option', { value: c }, c)))),
      tagBox),
    h('div', { class: 'field' }, h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Relevancia mínima del tag'), rankOut),
      h('input', { type: 'range', min: 0, max: 100, step: 5, value: (form.filters.tags || {}).min_rank ?? 0, 'aria-label': 'Relevancia mínima del tag',
        oninput: (e) => { if (!form.filters.tags) form.filters.tags = { include: [], exclude: [], mode: 'OR' }; form.filters.tags.min_rank = Number(e.target.value); rankOut.textContent = `${e.target.value} %`; persist(); } }),
      h('span', { class: 'help' }, 'Porcentaje de relevancia del tag en AniList (no es la nota del anime).')),
    sw('filters.tags.include_spoilers', 'Contar tags marcados como spoiler'));

    // Estudios
    const studioSel = h('div', { class: 'chips' });
    const studioRes = h('div', { class: 'chips' });
    function renderStudios() { const c = triChips('filters.studios', [...(get('filters.studios.include') || []), ...(get('filters.studios.exclude') || [])]); fill(studioSel, c); }
    renderStudios();
    const searchStudios = debounce(async (q) => {
      if (q.length < 2) { fill(studioRes, ); return; }
      fill(studioRes, h('span', { class: 'muted small' }, 'Buscando…'));
      try {
        const found = await api(`/api/studios?q=${encodeURIComponent(q)}`);
        fill(studioRes, ...(found.length ? found.map((s) => h('button', { type: 'button', class: 'chip', onclick: () => {
          const b = form.filters.studios || { include: [], exclude: [], mode: 'OR', main_only: false };
          if (!b.include.includes(s.name) && !b.exclude.includes(s.name)) b.include.push(s.name);
          set('filters.studios', b); renderStudios();
        } }, '＋ ', s.name, s.animation ? '' : ' (productora)')) : [h('span', { class: 'muted small' }, 'Sin resultados')]));
      } catch (e) { fill(studioRes, h('span', { class: 'muted small' }, e.message)); }
    }, 350);
    const studios = section('Estudios', summaryOf(() => { const s = form.filters.studios || {}; return [...(s.include || []), ...(s.exclude || []).map((x) => `−${x}`)].join(', ') || 'sin filtro'; }), false,
      h('div', { class: 'field' }, h('label', {}, 'Buscar estudio en AniList'), h('input', { type: 'search', placeholder: 'MAPPA, Madhouse, Bones…', oninput: (e) => searchStudios(e.target.value.trim()) }), studioRes),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Seleccionados (toca para alternar incluir/excluir)'), studioSel),
      h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Combinación'), seg('filters.studios.mode', [['OR', 'Alguno'], ['AND', 'Todos']])),
      sw('filters.studios.main_only', 'Solo como estudio principal', 'Desactivado: también cuenta como estudio participante.'),
      sw('filters.studios.animation_studios_only', 'Solo estudios de animación (ignorar productoras)'));

    // Otros filtros
    const emission = (() => {
      const f = form.filters;
      const cur = f.finished_only ? 'finished' : f.airing_only ? 'airing' : f.upcoming_only ? 'upcoming' : 'any';
      const wrap = h('div', { class: 'seg', role: 'group' });
      const render = (c) => fill(wrap, ...[['any', 'Cualquiera'], ['finished', 'Finalizado'], ['airing', 'En emisión'], ['upcoming', 'Próximos']].map(([v, l]) =>
        h('button', { type: 'button', 'aria-pressed': String(c === v), onclick: () => {
          f.finished_only = v === 'finished'; f.airing_only = v === 'airing'; f.upcoming_only = v === 'upcoming';
          if (v === 'upcoming') f.include_future = true;
          persist(); render(v);
        } }, l)));
      render(cur);
      return wrap;
    })();
    const STATUS_ES = { FINISHED: 'Finalizado', RELEASING: 'En emisión', NOT_YET_RELEASED: 'No estrenado', CANCELLED: 'Cancelado', HIATUS: 'En pausa' };
    const others = section('Otros filtros', null, false,
      rangePair('filters.popularity', 'Popularidad (miembros en AniList)'),
      rangePair('filters.episodes', 'Episodios'),
      rangePair('filters.duration', 'Duración por episodio (minutos)'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Estado de emisión'), emission),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Estado (incluir/excluir)'), triChips('filters.status', opts.statuses.map((s) => s), { upper: true })),
      h('p', { class: 'muted small' }, Object.entries(STATUS_ES).map(([k, v]) => `${k} = ${v}`).join(' · ')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'País de origen'), triChips('filters.country', opts.countries, { upper: true })),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Fuente de adaptación'), triChips('filters.source', opts.adaptation_sources, { upper: true })),
      sw('filters.include_adult', 'Incluir contenido adulto', 'Desactivado por defecto.', () => renderTags()),
      sw('filters.exclude_sequels', 'Excluir secuelas'),
      sw('filters.exclude_spinoffs', 'Excluir spin-offs'),
      sw('filters.exclude_side_stories', 'Excluir historias paralelas (OVA/especiales derivados)'),
      sw('filters.exclude_compilations', 'Excluir recopilatorios'),
      sw('filters.exclude_remakes', 'Excluir remakes'),
      sw('filters.exclude_specials', 'Excluir especiales'),
      h('div', { class: 'fields c3' },
        select('filters.sort', 'Ordenar por', [['start_date', 'Fecha de estreno'], ['score', 'Puntuación'], ['popularity', 'Popularidad'], ['favourites', 'Favoritos'], ['title', 'Título']]),
        select('filters.order', 'Orden', [['asc', 'Ascendente'], ['desc', 'Descendente']]),
        number('filters.limit', 'Límite de resultados', { min: 1, step: 1, placeholder: 'sin límite' })),
      h('div', { class: 'field' }, h('label', { for: 'expr' }, 'Expresión avanzada AND / OR / NOT (YAML, opcional)'),
        h('textarea', { id: 'expr', spellcheck: 'false', placeholder: 'and:\n  - not: {genres: {include: [Horror]}}\n  - or:\n      - genres: {include: [Fantasy]}\n      - tags: {include: [Magic], min_rank: 50}',
          oninput: (e) => { ui.expressionYaml = e.target.value; ui.keepExpression = null; persist(); } }, ui.keepExpression ? '' : ui.expressionYaml),
        ui.keepExpression ? h('span', { class: 'help' }, 'El perfil cargado tiene una expresión; escribe aquí para sustituirla.') : null,
        h('span', { class: 'help' }, 'Se combina con AND con el resto de filtros. La valida el mismo motor del CLI.')));

    // MDBList y mapping
    const mdb = section('Lista de MDBList', summaryOf(() => `modo ${form.mdblist.mode}${form.mdblist.list_id ? ` · lista ${form.mdblist.list_id}` : ''}`), false,
      listSelect,
      select('mdblist.mode', 'Modo de sincronización', [['append', 'Añadir: solo agrega lo que falta (nunca borra)'], ['sync', 'Sincronizar: agrega y, si lo permites, quita lo que añadió esta app'],
        ['create', 'Crear: crea la lista (falla si existe, salvo reutilizar)'], ['replace', 'Reemplazar: deja la lista igual al catálogo (pide confirmación)']]),
      sw('mdblist.allow_removals', 'Permitir quitar elementos gestionados (modo sync)', 'Nunca se eliminan elementos que añadiste a mano.'),
      sw('mdblist.private', 'Lista privada (al crearla)'),
      number('mdblist.batch_size', 'Tamaño de lote', { min: 1, max: 1000, step: 1 }));
    const mapping = section('Mapping (avanzado)', null, false,
      h('div', { class: 'field' }, h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Confianza mínima para añadir'), summaryOf(() => Number(form.mapping.minimum_confidence).toFixed(2))),
        h('input', { type: 'range', min: 0.5, max: 1, step: 0.01, value: form.mapping.minimum_confidence, 'aria-label': 'Confianza mínima', oninput: (e) => set('mapping.minimum_confidence', Number(e.target.value)) }),
        h('span', { class: 'help' }, 'Por debajo, el anime queda pendiente de revisión y no se añade.')),
      sw('mapping.verify_tmdb', 'Validar los IDs en TMDB (si hay clave)'),
      sw('mapping.allow_title_search', 'Permitir búsqueda por título como último recurso'),
      sw('mapping.movie_allow_show_mapping', 'Permitir que una película se mapee como serie', 'Desactivado: una película solo representada como especial queda en revisión.'));

    // Perfiles
    const profSel = h('select', { 'aria-label': 'Perfil guardado' }, h('option', { value: '' }, 'Perfiles guardados…'));
    api('/api/profiles').then((ps) => { for (const p of ps) profSel.append(h('option', { value: p.name, selected: p.name === ui.profile ? 'selected' : null }, `${p.name}${p.valid ? '' : ' (inválido)'}`)); }).catch(() => {});
    const profiles = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Perfil'),
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { try { localStorage.removeItem('generator-draft'); } catch { /* */ } location.hash = '#/crear?nuevo=1'; } }, 'Empezar de cero')),
    h('div', { class: 'toolbar' }, profSel,
      h('button', { class: 'btn small', type: 'button', onclick: () => { if (profSel.value) location.hash = `#/crear?perfil=${encodeURIComponent(profSel.value)}`; } }, 'Cargar'),
      h('button', { class: 'btn small', type: 'button', onclick: importYaml }, 'Importar YAML'),
      h('button', { class: 'btn small', type: 'button', onclick: showYaml }, 'Ver YAML')));

    const errorBox = h('div', {});
    const payload = () => ({ config: form, expression_yaml: ui.keepExpression ? null : (ui.expressionYaml || '').trim() || null });
    async function validate() {
      fill(errorBox, );
      try { return await api('/api/config/validate', { method: 'POST', body: payload() }); } catch (e) {
        fill(errorBox, h('div', { class: 'callout bad', role: 'alert', style: 'white-space:pre-wrap' }, e.message));
        errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return null;
      }
    }
    async function showYaml() {
      const v = await validate();
      if (!v) return;
      const ta = h('textarea', { readonly: true, style: 'min-height:320px' }, v.yaml);
      modal({ title: 'Configuración en YAML', body: ta, actions: [
        { label: 'Copiar', onClick: async () => { try { await navigator.clipboard.writeText(v.yaml); toast('Copiado'); } catch { ta.select(); } return false; } },
        { label: 'Descargar', onClick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([v.yaml], { type: 'text/yaml' })), download: `${(form.catalog.name || 'catalogo').replace(/\W+/g, '-').toLowerCase()}.yaml` }); a.click(); return false; } },
        { label: 'Cerrar', kind: 'primary' }] });
    }
    function importYaml() {
      const ta = h('textarea', { style: 'min-height:260px', placeholder: 'catalog:\n  name: "Mi catálogo"\nfilters:\n  start_year: 2020' });
      modal({ title: 'Importar YAML', body: ta, actions: [{ label: 'Cancelar' }, { label: 'Importar', kind: 'primary', onClick: async () => {
        try { const r = await api('/api/config/from-yaml', { method: 'POST', body: { yaml: ta.value } }); saveDraft({ form: r.config, ui: { dateMode: 'range' } }); location.hash = `#/crear?t=${Date.now()}`; toast('Configuración importada', 'ok'); } catch (e) { showError(e); return false; }
        return true;
      } }] });
    }
    async function saveProfile() {
      const v = await validate();
      if (!v) return;
      const inp = h('input', { type: 'text', value: ui.profile || (form.catalog.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), 'aria-label': 'Nombre del perfil' });
      modal({ title: 'Guardar perfil YAML', body: h('div', { class: 'field' }, h('label', {}, 'Nombre de archivo (sin .yaml)'), inp), actions: [{ label: 'Cancelar' }, { label: 'Guardar', kind: 'primary', onClick: async () => {
        try {
          const cfg = v.config;
          await api(`/api/profiles/${encodeURIComponent(inp.value.trim())}`, { method: 'PUT', body: { config: cfg } });
          ui.profile = inp.value.trim(); persist(); toast('Perfil guardado', 'ok');
        } catch (e) { showError(e); return false; }
        return true;
      } }] });
    }
    async function simulate() {
      const v = await validate();
      if (!v) return;
      try { const job = await api('/api/jobs/catalog', { method: 'POST', body: { config: v.config, apply: false } }); location.hash = `#/trabajos/${job.id}`; } catch (e) { showError(e); }
    }
    async function syncNow() {
      const v = await validate();
      if (!v) return;
      confirmSync(v.config, null);
    }
    const bar = h('div', { class: 'actionbar' },
      h('button', { class: 'btn', type: 'button', onclick: saveProfile }, icon('save'), 'Guardar perfil'),
      h('button', { class: 'btn', type: 'button', onclick: simulate }, icon('play'), 'Simular'),
      h('button', { class: 'btn primary', type: 'button', onclick: syncNow }, icon('sync'), 'Sincronizar con MDBList'));
    fill(main, h('div', { class: 'stack fade-in' }, profiles, errorBox, basics, dates, grouping, score, genres, studios, others, mdb, mapping), bar);
    cleanup.push(() => bar.remove());
    loadLists();
  }

  // Confirmación explícita antes de escribir en MDBList.
  function confirmSync(config, plan) {
    if (!STATUS || !STATUS.settings.mdblist) {
      modal({ title: 'Falta la API key de MDBList', body: h('p', {}, 'Configura tu clave en Ajustes para poder sincronizar. Mientras tanto puedes simular.'),
        actions: [{ label: 'Cerrar' }, { label: 'Ir a Ajustes', kind: 'primary', onClick: () => { location.hash = '#/ajustes'; } }] });
      return;
    }
    const mode = config.mdblist.mode;
    let confirmBtn;
    const ack = h('input', { type: 'checkbox', onchange: () => update() });
    const ackReplace = h('input', { type: 'checkbox', onchange: () => update() });
    const needsReplace = mode === 'replace';
    function update() { confirmBtn.disabled = !(ack.checked && (!needsReplace || ackReplace.checked)); }
    const body = h('div', { class: 'stack' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Lista'), h('dd', {}, config.mdblist.list_id ? `ID ${config.mdblist.list_id}` : config.catalog.name),
        h('dt', {}, 'Modo'), h('dd', {}, { append: 'Añadir (nunca borra)', sync: config.mdblist.allow_removals ? 'Sincronizar con eliminaciones de lo gestionado' : 'Sincronizar sin eliminar', create: 'Crear lista', replace: 'Reemplazar contenido' }[mode] || mode),
        plan ? [h('dt', {}, 'Se añadirán'), h('dd', {}, `${fmtNum(plan.to_add)} títulos (${fmtNum(plan.already_present)} ya estaban)`)] : null,
        plan && plan.to_remove ? [h('dt', {}, 'Se eliminarán'), h('dd', {}, `${fmtNum(plan.to_remove)} elementos`)] : null),
      plan && plan.remove_preview && plan.remove_preview.length ? h('details', {}, h('summary', {}, 'Vista previa de eliminaciones'), h('ul', {}, plan.remove_preview.slice(0, 50).map((x) => h('li', {}, `${x.type}:${x.tmdb_id} ${x.title || ''}`)))) : null,
      !plan ? h('div', { class: 'callout' }, 'Consejo: «Simular» primero muestra exactamente qué se añadirá. El cálculo se repite antes de escribir, así que no se duplican elementos.') : null,
      h('label', { class: 'check' }, ack, h('span', {}, 'Entiendo que se escribirá en mi cuenta de MDBList.')),
      needsReplace ? h('label', { class: 'check' }, ackReplace, h('span', {}, 'Confirmo que el modo reemplazar puede ELIMINAR elementos de la lista.')) : null);
    modal({ title: 'Sincronizar con MDBList', body, actions: [{ label: 'Cancelar' }, { label: 'Sincronizar', kind: 'primary', disabled: true, ref: (b) => { confirmBtn = b; },
      onClick: async () => {
        try {
          const job = await api('/api/jobs/catalog', { method: 'POST', body: { config, apply: true, confirm: true, confirm_replace: needsReplace && ackReplace.checked } });
          location.hash = `#/trabajos/${job.id}`;
        } catch (e) { showError(e); return false; }
        return true;
      } }] });
  }

  // ================================================================== TRABAJOS
  async function viewJobs() {
    setTitle('Trabajos');
    const wrap = h('div', { class: 'stack fade-in' });
    fill(main, wrap);
    async function refresh() {
      const jobs = await api('/api/jobs');
      if (!jobs.length) { fill(wrap, h('div', { class: 'card empty' }, 'No hay trabajos. ', h('a', { href: '#/crear' }, 'Crea un catálogo'), '.')); return false; }
      fill(wrap, ...jobs.map((j) => h('a', { class: 'result-card', href: `#/trabajos/${j.id}` },
        h('div', { class: 'row between' }, h('span', { class: 'title ellipsis' }, j.title), badge(j.status)),
        h('div', { class: 'muted small' }, `${j.phase} · ${fmtAgo(j.created_at)}${j.error_count ? ` · ${j.error_count} errores` : ''}`),
        ['queued', 'running'].includes(j.status) ? progressBar(j.percent, true) : null)));
      return jobs.some((j) => ['queued', 'running'].includes(j.status));
    }
    let active = await refresh();
    const timer = setInterval(async () => { if (active && document.visibilityState === 'visible') { try { active = await refresh(); } catch { /* */ } } }, 2500);
    cleanup.push(() => clearInterval(timer));
  }

  async function viewJob(id) {
    setTitle('Trabajo');
    let snap = await api(`/api/jobs/${id}`);
    setTitle(snap.title);
    const head = h('div', {});
    const prog = h('div', { class: 'card' });
    const extra = h('div', {});
    const results = h('div', {});
    fill(main, h('div', { class: 'stack fade-in' }, head, prog, extra, results));
    let renderedResults = false;

    function render(s) {
      snap = s;
      const active = ['queued', 'running'].includes(s.status);
      fill(head, h('div', { class: 'row between' }, h('div', { class: 'row' }, badge(s.status), h('span', { class: 'muted small' }, `Creado ${fmtAgo(s.created_at)}`)),
        h('div', { class: 'row' },
          active ? h('button', { class: 'btn small danger', disabled: s.cancel_requested, onclick: async () => { try { await api(`/api/jobs/${id}/cancel`, { method: 'POST' }); toast('Cancelando en un punto seguro…'); } catch (e) { showError(e); } } }, icon('stop'), s.cancel_requested ? 'Cancelando…' : 'Cancelar') : null,
          ['failed', 'interrupted', 'cancelled'].includes(s.status) ? h('button', { class: 'btn small', onclick: async () => { try { const j = await api(`/api/jobs/${id}/retry`, { method: 'POST' }); location.hash = `#/trabajos/${j.id}`; } catch (e) { showError(e); } } }, icon('retry'), 'Reintentar') : null)));
      const known = s.total !== null && s.total !== undefined;
      if (!active) {
        const totalPhases = s.phases.length;
        fill(prog,
          h('div', { class: 'card-head' }, h('h2', {}, s.phase), s.status === 'done' ? h('strong', {}, '100 %') : null),
          progressBar(s.status === 'done' ? 100 : null, false),
          h('div', { class: 'stats-line', style: 'margin-top:.6rem' },
            h('span', {}, 'Duración: ', h('b', {}, fmtDur(s.elapsed_s))),
            h('span', {}, 'Fases: ', h('b', {}, totalPhases)),
            s.error_count ? h('span', {}, 'Errores: ', h('b', { style: 'color:var(--bad)' }, s.error_count)) : null));
      } else {
      fill(prog,
        h('div', { class: 'card-head' }, h('h2', {}, s.phase), s.percent !== null && s.percent !== undefined ? h('strong', {}, `${s.percent} %`) : null),
        progressBar(s.percent, active),
        h('div', { class: 'stats-line', style: 'margin-top:.6rem', 'aria-live': 'polite' },
          h('span', {}, 'Procesados: ', h('b', {}, fmtNum(s.processed)), known ? ` de ${fmtNum(s.total)}` : ' (total aún desconocido)'),
          h('span', {}, 'Velocidad: ', h('b', {}, s.rate_per_s ? `${s.rate_per_s}/s` : '—')),
          h('span', {}, 'Tiempo: ', h('b', {}, fmtDur(s.elapsed_s))),
          s.error_count ? h('span', {}, 'Errores: ', h('b', { style: 'color:var(--bad)' }, s.error_count)) : null),
        s.last_item ? h('p', { class: 'muted small ellipsis', style: 'margin-top:.4rem' }, `Último: ${s.last_item}`) : null);
      }
      fill(extra, 
        s.errors.length ? h('div', { class: 'callout bad' }, h('strong', {}, 'Errores'), h('ul', {}, s.errors.slice(-10).map((e) => h('li', {}, e)))) : null,
        s.pending.length ? h('details', { class: 'card' }, h('summary', {}, `Títulos pendientes de revisión (${fmtNum(s.pending_count)})`), h('ul', { class: 'small' }, s.pending.map((p) => h('li', {}, p)))) : null,
        s.phases.length ? h('details', { class: 'card', open: active ? 'open' : null }, h('summary', {}, 'Fases y registro'),
          h('ul', { class: 'timeline' }, s.phases.map((p) => h('li', {}, h('span', { class: `tick ${p.end ? '' : 'run'}` }), h('span', { class: 'grow' }, p.name),
            h('span', { class: 'muted small' }, p.end ? fmtDur(p.end - p.start) : 'en curso')))),
          s.log.length ? h('div', { class: 'logbox' }, s.log.join('\n')) : null) : null);
      if (!active && s.result && !renderedResults) { renderedResults = true; renderResults(s); }
    }

    function renderResults(s) {
      const r = s.result;
      if (s.kind === 'datasets') {
        fill(results, h('div', { class: 'card' }, h('h2', {}, 'Datasets'), table([{ label: 'Fuente', key: 'source' }, { label: 'Estado', render: (x) => badge(x.status) },
          { label: 'Versión', key: 'version' }, { label: 'Filas', key: 'rows', num: true, render: (x) => fmtNum(x.rows) }, { label: 'Mensaje', key: 'message' }], r.datasets)));
        return;
      }
      const st = r.stats || {};
      const L = r.list || {};
      const kpis = h('div', { class: 'grid kpis' },
        kpi('Encontrados', fmtNum(st.found)), kpi('Tras filtros', fmtNum(st.filtered)), kpi('Temporadas agrupadas', fmtNum(st.seasons_grouped)),
        kpi('Títulos válidos', fmtNum(st.valid_titles), `${fmtNum(st.tv)} series · ${fmtNum(st.movies)} películas`),
        kpi('Ya en MDBList', fmtNum(st.already_in_list)), kpi(r.dry_run ? 'Se añadirían' : 'Nuevos', fmtNum(st.new_titles)),
        kpi('Pendientes', fmtNum((st.needs_review || 0) + (st.conflicts || 0) + (st.unmapped || 0)), `${fmtNum(st.unmapped)} sin mapping · ${fmtNum(st.conflicts)} conflictos`),
        kpi(r.dry_run ? 'Duplicados descartados' : 'Añadidos', r.dry_run ? fmtNum(st.duplicates_removed) : fmtNum(st.added)));
      const listCard = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, r.dry_run ? 'Simulación (MDBList sin cambios)' : 'Sincronización'),
        r.dry_run && s.status === 'done' ? h('button', { class: 'btn primary small', onclick: () => confirmSync(s.params.config, L) }, icon('sync'), 'Sincronizar con MDBList') : null),
      h('dl', { class: 'kv' }, h('dt', {}, 'Lista'), h('dd', {}, `${L.name || '—'}${L.id ? ` (id ${L.id})` : ''}${L.will_create ? ' · se creará' : ''}${L.created ? ' · creada' : ''}`),
        h('dt', {}, 'Fuentes de mapping'), h('dd', {}, Object.entries(r.mapping_sources || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'),
        h('dt', {}, 'Datasets'), h('dd', { class: 'small' }, Object.entries(r.dataset_versions || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—')),
      (L.notes || []).length ? h('div', { class: 'callout' }, h('ul', {}, L.notes.map((n) => h('li', {}, n)))) : null,
      r.sync && (r.sync.not_found.length || r.sync.failed.length) ? h('div', { class: 'callout warn' }, h('strong', {}, 'No se pudieron agregar'),
        h('ul', {}, r.sync.not_found.map((x) => h('li', {}, `${x[0]}:${x[1]} — MDBList no lo encontró`)), r.sync.failed.slice(0, 50).map((x) => h('li', {}, `${x[0]}:${x[1]} — pendiente (se reintentará)`)))) : null,
      r.sync && r.sync.errors.length ? h('div', { class: 'callout bad' }, h('ul', {}, r.sync.errors.map((e) => h('li', {}, e)))) : null);
      fill(results, kpis, listCard, resultTabs(id));
    }

    render(snap);
    if (['queued', 'running'].includes(snap.status)) {
      const es = new EventSource(`/api/jobs/${id}/events`);
      es.addEventListener('progress', (ev) => { try { render(JSON.parse(ev.data)); } catch { /* */ } });
      es.addEventListener('end', async () => { es.close(); try { render(await api(`/api/jobs/${id}`)); } catch { /* */ } loadStatus(); });
      es.onerror = () => { /* EventSource reintenta solo */ };
      cleanup.push(() => es.close());
    }
  }

  function resultTabs(jobId) {
    const tabs = [['titles', 'Títulos'], ['review', 'Revisión'], ['excluded', 'Excluidos'], ['duplicates', 'Duplicados']];
    let cur = 'titles';
    let page = 1;
    let q = '';
    const tabBar = h('div', { class: 'tabs', role: 'tablist' });
    const body = h('div', {});
    const search = h('input', { type: 'search', placeholder: 'Filtrar resultados…', 'aria-label': 'Filtrar resultados', oninput: debounce((e) => { q = e.target.value.trim(); page = 1; load(); }, 250) });
    const COLS = {
      titles: [{ label: 'Título', render: (r) => r.title }, { label: 'Año', key: 'canonical_year' }, { label: 'Tipo', render: (r) => (r.media_type ? (r.media_type === 'tv' ? 'Serie' : 'Película') : '—') },
        { label: 'TMDB', key: 'tmdb_id' }, { label: 'Fuente', key: 'mapping_source' }, { label: 'Estado', render: (r) => badge(r.mapping_status) },
        { label: 'Conf.', render: (r) => Number(r.confidence).toFixed(2) }, { label: 'Temporadas', render: (r) => String((r.members || '').split(' ').filter(Boolean).length) }],
      excluded: [{ label: 'Título', key: 'title' }, { label: 'Año', key: 'year' }, { label: 'Formato', key: 'format' }, { label: 'Fase', key: 'stage' }, { label: 'Motivo', render: (r) => (r.reasons || []).join(' · ') }],
      duplicates: [{ label: 'Tipo', key: 'kind' }, { label: 'Clave', key: 'key' }, { label: 'Conservado', key: 'kept' }, { label: 'Descartados', render: (r) => (r.dropped || []).join(', ') }, { label: 'Motivo', key: 'reason' }],
    };
    COLS.review = [...COLS.titles.slice(0, 6), { label: 'Conflictos', key: 'conflicts' }];
    function renderTabs() {
      fill(tabBar, ...tabs.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(k === cur), onclick: () => { cur = k; page = 1; renderTabs(); load(); } }, l)));
    }
    async function load() {
      fill(body, h('div', { class: 'skeleton', style: 'height:120px' }));
      try {
        const data = await api(`/api/jobs/${jobId}/rows?section=${cur}&page=${page}&size=25&q=${encodeURIComponent(q)}`);
        const open = (r) => { const uid = r.canonical_uid || r.uid; if (uid) location.hash = `#/explorador/${encodeURIComponent(uid)}`; };
        fill(body, data.items.length ? table(COLS[cur], data.items, ['titles', 'review', 'excluded'].includes(cur) ? open : null) : h('div', { class: 'empty' }, 'Sin elementos.'),
          pager(data, (p) => { page = p; load(); }));
      } catch (e) { fill(body, h('div', { class: 'callout bad' }, e.message)); }
    }
    renderTabs();
    load();
    return h('div', { class: 'card' }, h('h2', {}, 'Resultados'), tabBar, h('div', { class: 'toolbar' }, search), body);
  }

  // ================================================================== EXPLORADOR
  async function viewExplorer(query) {
    setTitle('Mapping Explorer');
    const tab = query.get('tab') || 'buscar';
    const tabBar = h('div', { class: 'tabs', role: 'tablist' }, [['buscar', 'Buscar'], ['revision', 'Revisión pendiente']].map(([k, l]) =>
      h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => { location.hash = `#/explorador?tab=${k}`; } }, l)));
    const body = h('div', { class: 'stack' });
    fill(main, h('div', { class: 'stack fade-in' }, tabBar, body));
    if (tab === 'revision') return reviewQueue(body, query);
    const by = h('select', { 'aria-label': 'Buscar por' }, [['title', 'Nombre'], ['anilist', 'AniList ID'], ['mal', 'MyAnimeList ID'], ['anidb', 'AniDB ID'], ['tmdb', 'TMDB ID'], ['tvdb', 'TVDB ID'], ['imdb', 'IMDb ID']]
      .map(([v, l]) => h('option', { value: v, selected: query.get('by') === v ? 'selected' : null }, l)));
    const q = h('input', { type: 'search', placeholder: 'One Piece, 21, tt0388629…', value: query.get('q') || '', 'aria-label': 'Buscar' });
    const results = h('div', { class: 'stack' });
    let page = Number(query.get('page') || 1);
    async function run() {
      if (!q.value.trim()) { fill(results, h('div', { class: 'empty' }, 'Busca un anime por nombre o por cualquier identificador.')); return; }
      fill(results, h('div', { class: 'skeleton', style: 'height:80px' }));
      try {
        const data = await api(`/api/mappings/search?by=${by.value}&q=${encodeURIComponent(q.value.trim())}&page=${page}&size=20`);
        fill(results, 
          data.note ? h('div', { class: 'callout' }, data.note) : null,
          ...(data.items.length ? data.items.map((it) => h('a', { class: 'result-card', href: `#/explorador/${encodeURIComponent(it.uid)}` },
            h('div', { class: 'row between' }, h('span', { class: 'title' }, it.title), badge(it.status)),
            h('div', { class: 'muted small' }, [it.year, it.format, it.uid, it.tmdb_id ? `TMDB ${it.media_type}:${it.tmdb_id}` : null, it.source ? `vía ${it.source}` : null, it.conflicts ? `${it.conflicts} conflicto(s)` : null].filter(Boolean).join(' · ')),
            h('div', { class: `meter ${it.confidence >= 0.9 ? '' : it.confidence >= 0.7 ? 'warn' : 'bad'}`, title: `Confianza ${it.confidence}` }, h('span', { style: `width:${Math.round(it.confidence * 100)}%` }))))
            : [h('div', { class: 'empty' }, 'Sin resultados.')]),
          data.items.length ? pager(data, (p) => { page = p; run(); }) : null);
      } catch (e) { fill(results, h('div', { class: 'callout bad' }, e.message)); }
    }
    const formEl = h('form', { class: 'card', onsubmit: (e) => { e.preventDefault(); page = 1; history.replaceState(null, '', `#/explorador?by=${by.value}&q=${encodeURIComponent(q.value.trim())}`); run(); } },
      h('div', { class: 'toolbar' }, by, q, h('button', { class: 'btn primary', type: 'submit' }, icon('search'), 'Buscar')),
      h('p', { class: 'muted small', style: 'margin:0' }, 'Los IDs se resuelven con los índices locales (AniBridge, Kometa, Fribb); el nombre se busca en AniList y en la base local.'));
    fill(body, formEl, results);
    run();
  }

  async function reviewQueue(body, query) {
    let status = query.get('status') || '';
    let page = 1;
    const list = h('div', {});
    const sel = h('select', { 'aria-label': 'Estado', onchange: (e) => { status = e.target.value; page = 1; load(); } },
      [['', 'Todos'], ['needs_review', 'Revisar'], ['conflict', 'Conflicto'], ['unmapped', 'Sin mapping']].map(([v, l]) => h('option', { value: v, selected: v === status ? 'selected' : null }, l)));
    async function load() {
      const data = await api(`/api/review?status=${status}&page=${page}&size=25`);
      fill(list, data.items.length ? table([{ label: 'Título', key: 'title' }, { label: 'UID', key: 'uid' }, { label: 'Estado', render: (r) => badge(r.status) },
        { label: 'Motivo', render: (r) => (r.reason || '').slice(0, 160) }, { label: 'Catálogo', key: 'catalog' }], data.items, (r) => { location.hash = `#/explorador/${encodeURIComponent(r.uid)}`; })
        : h('div', { class: 'empty' }, 'No hay mappings pendientes de revisión. 🎉'), pager(data, (p) => { page = p; load(); }));
    }
    fill(body, h('div', { class: 'card' }, h('div', { class: 'toolbar' }, sel), list));
    await load();
  }

  async function viewMappingDetail(uid) {
    setTitle('Mapping');
    const d = await api(`/api/mappings/detail?uid=${encodeURIComponent(uid)}`);
    setTitle(d.entry.title);
    const m = d.mapping;
    const ext = (label, value, url) => [h('dt', {}, label), h('dd', {}, value ? (url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, String(value)) : String(value)) : '—')];
    const tmdbUrl = m.tmdb_id ? `https://www.themoviedb.org/${m.media_type === 'movie' ? 'movie' : 'tv'}/${m.tmdb_id}` : null;
    const valChecks = m.validation && m.validation.performed ? Object.entries(m.validation.checks || {}) : [];
    const ovr = d.override;
    const overrideForm = (() => {
      const action = h('select', {}, [['map', 'Asignar TMDB'], ['exclude', 'Excluir siempre'], ['canonical', 'Pertenece a otra serie']].map(([v, l]) => h('option', { value: v }, l)));
      const mtype = h('select', {}, h('option', { value: 'tv' }, 'Serie (TV)'), h('option', { value: 'movie' }, 'Película'));
      const tid = h('input', { type: 'number', inputmode: 'numeric', placeholder: 'TMDB ID' });
      const canon = h('input', { type: 'text', placeholder: 'anilist:21' });
      const note = h('input', { type: 'text', placeholder: 'Motivo (opcional)' });
      const mapFields = h('div', { class: 'fields c2' }, mtype, tid);
      const canonFields = h('div', {}, canon);
      const sync = () => { mapFields.hidden = action.value !== 'map'; canonFields.hidden = action.value !== 'canonical'; };
      action.onchange = sync; sync();
      return h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('/api/overrides', { method: 'POST', body: { uid: d.entry.uid, action: action.value, media_type: mtype.value, tmdb_id: tid.value ? Number(tid.value) : null, canonical_uid: canon.value.trim() || null, note: note.value.trim() || null } });
          toast('Corrección guardada (se aplica en la próxima ejecución)', 'ok'); route();
        } catch (err) { showError(err); }
      } }, action, mapFields, canonFields, note, h('button', { class: 'btn primary', type: 'submit' }, 'Guardar corrección'));
    })();
    fill(main, h('div', { class: 'stack fade-in' },
      h('div', { class: 'card' }, h('div', { class: 'row between' }, h('div', {}, h('h2', {}, d.entry.title), h('div', { class: 'muted small' }, [d.entry.romaji !== d.entry.title ? d.entry.romaji : null, d.entry.format, d.entry.start].filter(Boolean).join(' · '))), badge(m.status)),
        h('div', { class: 'stats-line', style: 'margin-top:.5rem' }, h('span', {}, 'Tipo: ', h('b', {}, m.media_type === 'movie' ? 'Película' : m.media_type === 'tv' ? 'Serie' : '—')),
          h('span', {}, 'Fuente: ', h('b', {}, m.source || '—')), h('span', {}, 'Confianza: ', h('b', {}, Number(m.confidence).toFixed(2))),
          h('span', {}, 'Se añadiría: ', h('b', {}, m.addable ? 'sí' : 'no'))),
        h('div', { class: `meter ${m.confidence >= 0.9 ? '' : m.confidence >= 0.7 ? 'warn' : 'bad'}`, style: 'margin-top:.5rem' }, h('span', { style: `width:${Math.round(m.confidence * 100)}%` }))),
      h('div', { class: 'grid two' },
        h('div', { class: 'card' }, h('h3', {}, 'Identificadores'), h('dl', { class: 'kv' },
          ext('AniList', d.entry.anilist_id, d.entry.anilist_id ? `https://anilist.co/anime/${d.entry.anilist_id}` : null),
          ext('MyAnimeList', d.entry.mal_id, d.entry.mal_id ? `https://myanimelist.net/anime/${d.entry.mal_id}` : null),
          ext('AniDB', (m.anidb || []).join(', '), m.anidb && m.anidb[0] ? `https://anidb.net/anime/${m.anidb[0]}` : null),
          ext('TMDB', m.tmdb_id ? `${m.media_type}:${m.tmdb_id}` : null, tmdbUrl),
          ext('TVDB', m.tvdb_id), ext('IMDb', m.imdb_id, m.imdb_id ? `https://www.imdb.com/title/${m.imdb_id}/` : null),
          ext('Esta entrada', d.entry_mapping.tmdb_id ? `${d.entry_mapping.media_type}:${d.entry_mapping.tmdb_id}${(d.entry_mapping.seasons || []).length ? ` (temporada${d.entry_mapping.seasons.length > 1 ? 's' : ''} ${d.entry_mapping.seasons.join(', ')})` : ''}` : d.entry_mapping.status))),
        h('div', { class: 'card' }, h('h3', {}, 'Serie canónica'), h('p', {}, h('a', { href: `#/explorador/${encodeURIComponent(d.canonical.uid)}` }, `${d.canonical.title} (${d.canonical.year || '?'})`), d.canonical.uid === d.entry.uid ? ' — es esta entrada' : ''),
          h('ul', { class: 'list' }, d.members.map((x) => h('li', {}, h('a', { class: 'grow ellipsis', href: `#/explorador/${encodeURIComponent(x.uid)}` }, x.title), h('span', { class: 'muted small' }, `${x.format || '?'} · ${x.year || '?'}`)))),
          h('details', {}, h('summary', { class: 'small muted' }, 'Criterio de agrupación'), h('ul', { class: 'small' }, d.grouping.map((g) => h('li', {}, g)))))),
      h('div', { class: 'card' }, h('h3', {}, 'Validación'),
        m.validation && m.validation.performed ? h('dl', { class: 'kv' }, valChecks.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : h('p', { class: 'muted' }, m.tmdb_available ? 'No realizada.' : 'Sin TMDB_API_KEY: el ID no se ha validado contra TMDB.'),
        m.conflicts.length ? h('div', { class: 'callout warn' }, h('strong', {}, 'Conflictos'), h('ul', {}, m.conflicts.map((c) => h('li', {}, c)))) : null,
        h('details', {}, h('summary', {}, 'Evidencias'), h('ul', { class: 'small' }, m.evidence.map((e) => h('li', {}, e))))),
      h('div', { class: 'card' }, h('h3', {}, 'Candidatos por fuente'), d.candidates.length ? table([{ label: 'Fuente', key: 'source' }, { label: 'Tipo', key: 'type' }, { label: 'TMDB', key: 'tmdb_id' },
        { label: 'Temporadas', render: (c) => c.seasons.map((s) => `s${s}`).join(' ') }, { label: 'Vía', key: 'route' }], d.candidates) : h('p', { class: 'muted' }, 'Ningún dataset tiene un candidato TMDB.'),
      h('p', { class: 'muted small', style: 'margin-top:.5rem' }, Object.entries(d.dataset_versions).map(([k, v]) => `${k} ${v}`).join(' · '))),
      h('div', { class: 'card' }, h('h3', {}, 'Corrección manual'),
        ovr ? h('div', { class: 'callout ok' }, `Override activo: ${ovr.action}${ovr.tmdb_id ? ` ${ovr.media_type}:${ovr.tmdb_id}` : ''}${ovr.canonical_uid ? ` → ${ovr.canonical_uid}` : ''}${ovr.note ? ` (${ovr.note})` : ''} `,
          h('button', { class: 'btn small', onclick: async () => { try { await api(`/api/overrides/${encodeURIComponent(d.entry.uid)}`, { method: 'DELETE' }); toast('Override eliminado'); route(); } catch (e) { showError(e); } } }, 'Quitar')) : null,
        h('p', { class: 'muted small' }, 'Las correcciones se guardan en la base local y en overrides.yaml; no se pierden al actualizar los datasets.'),
        overrideForm)));
  }

  // ================================================================== LISTAS
  async function viewLists() {
    setTitle('Listas de MDBList');
    await loadStatus();
    const tab = parseHash().query.get('tab') || 'listas';
    const tabBar = h('div', { class: 'tabs', role: 'tablist' }, [['listas', 'Mis listas'], ['historial', 'Historial']].map(([k, l]) =>
      h('button', { role: 'tab', 'aria-selected': String(k === tab), onclick: () => { location.hash = `#/listas?tab=${k}`; } }, l)));
    const body = h('div', { class: 'stack' });
    fill(main, h('div', { class: 'stack fade-in' }, tabBar, body));
    if (tab === 'historial') return history_(body);
    if (!STATUS.settings.mdblist) { fill(body, h('div', { class: 'callout warn' }, 'Configura tu API key de MDBList en ', h('a', { href: '#/ajustes' }, 'Ajustes'), ' para ver y gestionar tus listas.')); return; }
    const lists = await api('/api/mdblist/lists');
    const createBtn = h('button', { class: 'btn primary', onclick: () => {
      const name = h('input', { type: 'text', placeholder: 'Anime 2020-2026' });
      const priv = h('input', { type: 'checkbox' });
      const ack = h('input', { type: 'checkbox' });
      modal({ title: 'Crear lista en MDBList', body: h('div', { class: 'stack' }, h('div', { class: 'field' }, h('label', {}, 'Nombre'), name),
        h('label', { class: 'check' }, priv, h('span', {}, 'Privada')), h('label', { class: 'check' }, ack, h('span', {}, 'Confirmo crear la lista en mi cuenta de MDBList.'))),
      actions: [{ label: 'Cancelar' }, { label: 'Crear', kind: 'primary', onClick: async () => {
        if (!ack.checked) { toast('Marca la confirmación', 'bad'); return false; }
        try { const r = await api('/api/mdblist/lists', { method: 'POST', body: { name: name.value, private: priv.checked, confirm: true } }); toast(`Lista creada (id ${r.id})`, 'ok'); route(); } catch (e) { showError(e); return false; }
        return true;
      } }] });
    } }, icon('plus'), 'Nueva lista');
    fill(body, h('div', { class: 'row between' }, h('p', { class: 'muted small', style: 'margin:0' }, `${lists.length} listas`), createBtn),
      ...(lists.length ? lists.map((l) => h('div', { class: 'card' }, h('div', { class: 'row between' }, h('div', { class: 'grow' }, h('strong', {}, l.name), h('div', { class: 'muted small' }, `id ${l.id} · ${fmtNum(l.items)} elementos · ${fmtNum(l.managed)} gestionados por esta app${l.private ? ' · privada' : ''}`))),
        h('div', { class: 'row', style: 'margin-top:.6rem' }, h('a', { class: 'btn small', href: `#/listas/${l.id}` }, 'Ver contenido'),
          h('a', { class: 'btn small primary', href: `#/crear?lista=${l.id}&nombre=${encodeURIComponent(l.name)}` }, icon('plus'), 'Agregar animes'))))
        : [h('div', { class: 'card empty' }, 'Aún no tienes listas.')]));
  }

  async function viewListItems(id) {
    setTitle(`Lista ${id}`);
    let page = 1;
    let q = '';
    let media = '';
    const body = h('div', {});
    async function load() {
      fill(body, h('div', { class: 'skeleton', style: 'height:120px' }));
      try {
        const data = await api(`/api/mdblist/lists/${id}/items?page=${page}&size=25&q=${encodeURIComponent(q)}&media=${media}`);
        fill(body, data.items.length ? table([{ label: 'Título', key: 'title' }, { label: 'Año', key: 'year' }, { label: 'Tipo', render: (r) => (r.type === 'tv' ? 'Serie' : 'Película') },
          { label: 'TMDB', key: 'tmdb_id' }, { label: 'Origen', render: (r) => (r.managed ? badge('ok', 'Esta app') : badge('', 'Manual/otro')) }], data.items) : h('div', { class: 'empty' }, 'Lista vacía.'),
        pager(data, (p) => { page = p; load(); }));
      } catch (e) { fill(body, h('div', { class: 'callout bad' }, e.message)); }
    }
    fill(main, h('div', { class: 'card fade-in' },
      h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Buscar título o TMDB ID', oninput: debounce((e) => { q = e.target.value.trim(); page = 1; load(); }, 300) }),
        h('select', { onchange: (e) => { media = e.target.value; page = 1; load(); } }, h('option', { value: '' }, 'Series y películas'), h('option', { value: 'tv' }, 'Series'), h('option', { value: 'movie' }, 'Películas')),
        h('a', { class: 'btn primary', href: `#/crear?lista=${id}` }, icon('plus'), 'Agregar animes')), body));
    load();
  }

  async function history_(body) {
    let page = 1;
    const box = h('div', {});
    async function load() {
      const data = await api(`/api/runs?page=${page}&size=15`);
      fill(box, data.items.length ? h('div', { class: 'stack' }, data.items.map((r) => {
        const det = h('details', { class: 'card' }, h('summary', {}, h('span', { class: 'row between', style: 'display:inline-flex;width:calc(100% - 20px)' }, h('span', {}, h('strong', {}, r.catalog), ' ', h('span', { class: 'muted small' }, `${r.dry_run ? 'simulación' : 'sincronización'} · ${fmtAgo(r.started_at)}`)), badge(r.status))),
          h('div', { class: 'stats-line', style: 'margin:.5rem 0' }, h('span', {}, 'Válidos ', h('b', {}, fmtNum(r.valid_titles))), h('span', {}, 'Nuevos ', h('b', {}, fmtNum(r.new_titles))), h('span', {}, 'Añadidos ', h('b', {}, fmtNum(r.added))), h('span', {}, 'Errores ', h('b', {}, fmtNum(r.errors))), r.list_id ? h('span', {}, 'Lista ', h('b', {}, r.list_id)) : null));
        det.addEventListener('toggle', async () => {
          if (!det.open || det.dataset.loaded) return;
          det.dataset.loaded = '1';
          try {
            const items = await api(`/api/runs/${encodeURIComponent(r.run_id)}/items`);
            const bad = items.filter((x) => x.status !== 'done');
            det.append(items.length ? h('div', { class: 'stack' }, h('p', { class: 'small muted' }, `${items.length} operaciones · ${bad.length} sin completar`),
              bad.length ? table([{ label: 'Tipo', key: 'media_type' }, { label: 'TMDB', key: 'tmdb_id' }, { label: 'Acción', key: 'action' }, { label: 'Estado', key: 'status' }, { label: 'Error', key: 'error' }], bad.slice(0, 200)) : h('p', { class: 'small' }, 'Todas las operaciones se completaron.'))
              : h('p', { class: 'small muted' }, r.dry_run ? 'Simulación: no se escribió nada.' : 'Sin operaciones de escritura.'));
          } catch (e) { det.append(h('p', { class: 'small' }, e.message)); }
        });
        return det;
      })) : h('div', { class: 'card empty' }, 'Sin ejecuciones.'), pager(data, (p) => { page = p; load(); }));
    }
    fill(body, box);
    await load();
  }

  // ================================================================== AJUSTES
  async function viewSettings() {
    setTitle('Ajustes');
    const [st, status, dash] = await Promise.all([api('/api/settings'), api('/api/status'), api('/api/dashboard')]);
    const KEYS = [['MDBLIST_API_KEY', 'MDBList API key', 'mdblist.com → Preferences → API Access'], ['TMDB_API_KEY', 'TMDB API Key (v3)', 'themoviedb.org → Settings → API'],
      ['TMDB_READ_ACCESS_TOKEN', 'TMDB Read Access Token (v4)', 'Alternativa a la API Key'], ['TVDB_API_KEY', 'TVDB API key (opcional)', ''], ['TVDB_SUBSCRIBER_PIN', 'TVDB PIN (opcional)', '']];
    const inputs = {};
    const keyRows = KEYS.map(([k, label, help]) => {
      inputs[k] = h('input', { type: 'password', autocomplete: 'off', placeholder: st.keys[k] ? '•••••••• (configurada)' : 'sin configurar', 'aria-label': label });
      return h('div', { class: 'field' }, h('div', { class: 'row between' }, h('label', {}, label), st.keys[k] ? badge('ok', 'Configurada') : badge('', 'No configurada')), inputs[k],
        h('div', { class: 'row between' }, h('span', { class: 'help' }, help), st.keys[k] ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => saveKeys({ [k]: '' }) }, 'Quitar') : null));
    });
    async function saveKeys(values) {
      try { await api('/api/settings/keys', { method: 'POST', body: values }); OPTIONS = null; toast('Ajustes guardados', 'ok'); route(); } catch (e) { showError(e); }
    }
    const theme = h('select', { onchange: (e) => setTheme(e.target.value), 'aria-label': 'Tema' }, [['auto', 'Automático (sistema)'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([v, l]) => h('option', { value: v, selected: getTheme() === v ? 'selected' : null }, l)));
    const force = h('input', { type: 'checkbox' });
    const p = status.platform;
    fill(main, h('div', { class: 'stack fade-in' },
      h('form', { class: 'card stack', onsubmit: (e) => { e.preventDefault(); const vals = {}; for (const [k] of KEYS) if (inputs[k].value.trim()) vals[k] = inputs[k].value.trim(); if (!Object.keys(vals).length) { toast('No hay cambios'); return; } saveKeys(vals); } },
        h('h2', {}, 'Claves de API'),
        h('p', { class: 'muted small' }, `Se guardan solo en este dispositivo (${st.home ? `${st.home}/.env` : '.env'}, permisos 600). Nunca se envían al navegador ni aparecen en las respuestas.`),
        keyRows, h('button', { class: 'btn primary', type: 'submit' }, 'Guardar claves')),
      h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h2', {}, 'Datasets de mappings'), h('div', { class: 'row' }, h('label', { class: 'check small' }, force, 'Forzar'), h('button', { class: 'btn small', onclick: () => startDatasets(force.checked) }, icon('sync'), 'Actualizar ahora'))),
        table([{ label: 'Fuente', key: 'source' }, { label: 'Estado', render: (x) => badge(x.status === 'ok' ? 'ok' : x.status) }, { label: 'Versión', key: 'version' },
          { label: 'Filas', render: (x) => fmtNum(x.rows) }, { label: 'Licencia', key: 'license' }], dash.datasets),
        h('p', { class: 'muted small', style: 'margin-top:.5rem' }, 'Las descargas son condicionales (ETag): si no hay cambios no se vuelve a bajar nada. Las correcciones manuales nunca se pierden.')),
      h('div', { class: 'card stack' }, h('h2', {}, 'Apariencia'), h('div', { class: 'field' }, h('label', {}, 'Tema'), theme)),
      h('div', { class: 'card' }, h('h2', {}, 'Sistema'), h('dl', { class: 'kv' },
        h('dt', {}, 'Versión'), h('dd', {}, status.version),
        h('dt', {}, 'Plataforma'), h('dd', {}, `${p.system} ${p.machine}${p.termux ? ' · Termux' : ''}`),
        h('dt', {}, 'Python / SQLite'), h('dd', {}, `${p.python} / ${p.sqlite}`),
        h('dt', {}, 'Datos'), h('dd', { class: 'mono small' }, st.database),
        h('dt', {}, 'Perfiles'), h('dd', { class: 'mono small' }, st.profiles_dir),
        h('dt', {}, 'Reportes'), h('dd', { class: 'mono small' }, st.reports_dir)),
      h('p', { class: 'muted small', style: 'margin-top:.6rem' }, 'La interfaz solo escucha en este dispositivo (127.0.0.1). Las operaciones de escritura llevan un token anti-CSRF.'))));
  }

  // ------------------------------------------------------------------ arranque
  renderNav();
  loadStatus().finally(route);
})();
