'use strict';

/* ============================== Estado ============================== */

const DEFAULT_SAMPLE = 'El veloz murciélago hindú comía feliz cardillo y kiwi';

const CATEGORIES = {
  mono:    'Monoespaciada',
  sans:    'Sans serif',
  serif:   'Serif',
  script:  'Caligráfica',
  display: 'Decorativa',
  other:   'Sin clasificar',
};

const state = {
  families: [],            // [{ name, styles: FontData[], category }]
  favorites: new Set(),    // nombres de familia (solo en memoria)
  filter: 'all',           // 'all' | 'fav' | clave de CATEGORIES
  search: '',
  sort: 'az',
  view: 'grid',
  sampleText: DEFAULT_SAMPLE,
};

const cardCache = new Map();      // familia -> elemento .card
const familyFaces = new Map();    // familia -> Promise (FontFace de la cara representativa)
const styleFaces = new Map();     // postscriptName -> Promise<string nombre de face única>

/* ============================== Referencias DOM ============================== */

const $ = (id) => document.getElementById(id);
const els = {
  search: $('search'), globalCount: $('global-count'),
  toolbar: $('toolbar'), sampleText: $('sample-text'),
  sizeSlider: $('size-slider'), sizeValue: $('size-value'),
  sortSelect: $('sort-select'), viewGrid: $('view-grid'), viewList: $('view-list'),
  sidebar: $('sidebar'), collectionFilters: $('collection-filters'), categoryFilters: $('category-filters'),
  emptyState: $('empty-state'), unsupportedState: $('unsupported-state'),
  loadingState: $('loading-state'), errorState: $('error-state'),
  errorMessage: $('error-message'), loadBtn: $('load-btn'), retryBtn: $('retry-btn'),
  grid: $('grid'), noResults: $('no-results'),
  panel: $('panel'), panelBackdrop: $('panel-backdrop'), panelClose: $('panel-close'),
  panelTitle: $('panel-title'), panelPreview: $('panel-preview'),
  panelStyles: $('panel-styles'), panelGlyphs: $('panel-glyphs'),
  metaFamily: $('meta-family'), metaPostscript: $('meta-postscript'),
  metaStyle: $('meta-style'), metaCount: $('meta-count'), metaCategory: $('meta-category'),
};

/* ============================== Utilidades ============================== */

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function cssFamily(name) {
  return '"' + String(name).replace(/"/g, '') + '"';
}

function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function inferCategory(name) {
  const n = name.toLowerCase();
  if (/(mono|code|consol|courier|typewriter|term\b|fixed)/.test(n)) return 'mono';
  if (/(script|hand|brush|callig|cursive|signature|marker)/.test(n)) return 'script';
  if (/sans/.test(n)) return 'sans';
  if (/(serif|slab|times|georgia|garamond|roman|bookman|palatino|caslon|baskerv|didot|bodoni|minion|charter)/.test(n)) return 'serif';
  if (/(display|deco\b|poster|stencil|comic|shadow|outline|headline)/.test(n)) return 'display';
  return 'other';
}

// Estilo "representativo" de una familia para la previsualización de la tarjeta.
function pickRepresentative(styles) {
  const exact = styles.find(s => /^(regular|normal)$/i.test(s.style || ''));
  if (exact) return exact;
  const loose = styles.find(s => /(regular|normal|book|roman|medium)/i.test(s.style || '') && !/italic|oblique/i.test(s.style || ''));
  if (loose) return loose;
  const upright = styles.find(s => !/italic|oblique/i.test(s.style || ''));
  return upright || styles[0];
}

/* ============================== Carga de fuentes (API) ============================== */

async function loadFonts() {
  showOnly('loading-state');
  try {
    const fonts = await window.queryLocalFonts();

    if (!fonts.length) {
      showError('El navegador no devolvió ninguna fuente. Verificá el permiso de "Fuentes locales" en la configuración del sitio y reintentá.');
      return;
    }

    const byFamily = new Map();
    for (const font of fonts) {
      if (!byFamily.has(font.family)) byFamily.set(font.family, []);
      byFamily.get(font.family).push(font);
    }

    state.families = [...byFamily.entries()].map(([name, styles]) => ({
      name,
      styles,
      category: inferCategory(name),
    }));

    initUI();
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showError('Denegaste el permiso de acceso a las fuentes. Para continuar, permití "Fuentes locales" para esta página (ícono junto a la barra de direcciones) y reintentá.');
    } else if (err.name === 'SecurityError') {
      showError('El navegador bloqueó el acceso por seguridad. Asegurate de hacer clic en el botón directamente y reintentá.');
    } else {
      showError('Ocurrió un error inesperado: ' + (err.message || err.name || String(err)));
    }
  }
}

function showOnly(id) {
  for (const s of ['empty-state', 'unsupported-state', 'loading-state', 'error-state']) {
    $(s).classList.toggle('hidden', s !== id);
  }
  els.grid.classList.add('hidden');
  els.noResults.classList.add('hidden');
}

function showError(message) {
  showOnly('error-state');
  els.errorMessage.textContent = message;
}

/* ============================== FontFace perezoso ============================== */

// Registra la cara representativa de la familia bajo su propio nombre de familia.
function ensureFamilyFace(family) {
  if (familyFaces.has(family.name)) return familyFaces.get(family.name);
  const promise = (async () => {
    const fontData = pickRepresentative(family.styles);
    const blob = await fontData.blob();
    // El constructor de FontFace acepta ArrayBuffer, no Blob directamente.
    const face = new FontFace(family.name, await blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
  })();
  familyFaces.set(family.name, promise);
  return promise;
}

// Registra un estilo individual bajo un nombre de face único (para el panel de detalle).
function ensureStyleFace(fontData) {
  const key = fontData.postscriptName || fontData.fullName;
  if (styleFaces.has(key)) return styleFaces.get(key);
  const faceName = '__style__' + String(key).replace(/[^a-zA-Z0-9_-]/g, '_');
  const promise = (async () => {
    const blob = await fontData.blob();
    const face = new FontFace(faceName, await blob.arrayBuffer());
    await face.load();
    document.fonts.add(face);
    return faceName;
  })();
  styleFaces.set(key, promise);
  return promise;
}

// Observer: cada tarjeta carga su FontFace recién cuando se acerca al viewport.
const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    io.unobserve(entry.target);
    const card = entry.target;
    const family = state.families.find(f => f.name === card.dataset.family);
    if (!family) continue;
    ensureFamilyFace(family)
      .then(() => {
        card.classList.remove('font-pending');
        card.querySelector('.card-preview').style.fontFamily = cssFamily(family.name);
      })
      .catch(() => {
        card.classList.remove('font-pending');
        card.classList.add('font-error');
      });
  }
}, { root: null, rootMargin: '350px' });

/* ============================== Tarjetas ============================== */

function buildCard(family) {
  const card = document.createElement('div');
  card.className = 'card font-pending';
  card.dataset.family = family.name;

  const head = document.createElement('div');
  head.className = 'card-head';

  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = family.name;
  name.title = family.name;

  const meta = document.createElement('span');
  meta.className = 'card-meta';
  meta.textContent = family.styles.length === 1 ? '1 estilo' : family.styles.length + ' estilos';

  const star = document.createElement('button');
  star.className = 'star-btn';
  star.textContent = '★';
  star.title = 'Marcar como favorita';
  star.setAttribute('aria-pressed', String(state.favorites.has(family.name)));
  star.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFavorite(family.name, star);
  });

  head.append(name, meta, star);

  const preview = document.createElement('div');
  preview.className = 'card-preview';
  preview.textContent = state.sampleText;

  const errMsg = document.createElement('div');
  errMsg.className = 'load-error-msg';
  errMsg.textContent = 'No se pudo cargar esta fuente.';

  card.append(head, preview, errMsg);
  card.addEventListener('click', () => openPanel(family));

  io.observe(card);
  return card;
}

function getCard(family) {
  let card = cardCache.get(family.name);
  if (!card) {
    card = buildCard(family);
    cardCache.set(family.name, card);
  }
  // Sincroniza el texto de muestra: las tarjetas cacheadas fuera del DOM no
  // reciben las actualizaciones en vivo, así que las igualamos en cada render.
  card.querySelector('.card-preview').textContent = state.sampleText;
  return card;
}

function toggleFavorite(familyName, starBtn) {
  if (state.favorites.has(familyName)) {
    state.favorites.delete(familyName);
  } else {
    state.favorites.add(familyName);
  }
  starBtn.setAttribute('aria-pressed', String(state.favorites.has(familyName)));
  updateFilterCounts();
  if (state.filter === 'fav') render();
}

/* ============================== Render principal ============================== */

function visibleFamilies() {
  const q = normalize(state.search.trim());
  let list = state.families;
  if (state.filter === 'fav') {
    list = list.filter(f => state.favorites.has(f.name));
  } else if (state.filter !== 'all') {
    list = list.filter(f => f.category === state.filter);
  }
  if (q) list = list.filter(f => normalize(f.name).includes(q));
  list = [...list].sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  if (state.sort === 'za') list.reverse();
  return list;
}

function render() {
  const list = visibleFamilies();
  els.grid.replaceChildren(...list.map(getCard));
  els.grid.classList.remove('hidden');
  els.noResults.classList.toggle('hidden', list.length > 0);
  els.globalCount.textContent =
    list.length === state.families.length
      ? state.families.length + ' familias'
      : list.length + ' de ' + state.families.length + ' familias';
}

/* ============================== Sidebar (filtros) ============================== */

function buildFilterButton(key, label) {
  const btn = document.createElement('button');
  btn.className = 'filter-btn';
  btn.dataset.filter = key;
  btn.setAttribute('aria-pressed', String(state.filter === key));

  const text = document.createElement('span');
  text.textContent = label;
  const badge = document.createElement('span');
  badge.className = 'badge';

  btn.append(text, badge);
  btn.addEventListener('click', () => {
    state.filter = key;
    for (const b of document.querySelectorAll('.filter-btn')) {
      b.setAttribute('aria-pressed', String(b.dataset.filter === key));
    }
    render();
  });
  return btn;
}

function buildSidebar() {
  els.collectionFilters.replaceChildren(
    buildFilterButton('all', 'Todas'),
    buildFilterButton('fav', 'Favoritas'),
  );
  const catButtons = [];
  for (const key of Object.keys(CATEGORIES)) {
    if (state.families.some(f => f.category === key)) {
      catButtons.push(buildFilterButton(key, CATEGORIES[key]));
    }
  }
  els.categoryFilters.replaceChildren(...catButtons);
  updateFilterCounts();
}

function updateFilterCounts() {
  for (const btn of document.querySelectorAll('.filter-btn')) {
    const key = btn.dataset.filter;
    let count;
    if (key === 'all') count = state.families.length;
    else if (key === 'fav') count = state.favorites.size;
    else count = state.families.filter(f => f.category === key).length;
    btn.querySelector('.badge').textContent = count;
  }
}

/* ============================== Panel de detalle ============================== */

let panelFamily = null;

function openPanel(family) {
  panelFamily = family;
  const representative = pickRepresentative(family.styles);
  const familyCss = cssFamily(family.name);

  els.panelTitle.textContent = family.name;
  els.panelPreview.textContent = state.sampleText;
  els.panelPreview.style.fontFamily = familyCss;
  els.panelGlyphs.style.fontFamily = familyCss;

  els.metaFamily.textContent = family.name;
  els.metaPostscript.textContent = representative.postscriptName || '—';
  els.metaStyle.textContent = representative.style || '—';
  els.metaCount.textContent = family.styles.length;
  els.metaCategory.textContent = CATEGORIES[family.category];

  // Asegura la cara principal (por si la tarjeta aún no entró al viewport).
  ensureFamilyFace(family).catch(() => {});

  // Lista de estilos: cada uno con su propia FontFace.
  const rows = family.styles.map((fontData) => {
    const row = document.createElement('div');
    row.className = 'style-row';

    const sample = document.createElement('div');
    sample.className = 'style-sample';
    sample.textContent = fontData.fullName || fontData.style || family.name;

    const info = document.createElement('div');
    info.className = 'style-info';
    info.textContent = (fontData.style || '—') + ' · ' + (fontData.postscriptName || '—');

    row.append(sample, info);
    ensureStyleFace(fontData)
      .then((faceName) => { sample.style.fontFamily = cssFamily(faceName); })
      .catch(() => { info.textContent += ' · no se pudo cargar'; });
    return row;
  });
  els.panelStyles.replaceChildren(...rows);

  els.panel.classList.add('open');
  els.panelBackdrop.classList.add('open');
}

function closePanel() {
  panelFamily = null;
  els.panel.classList.remove('open');
  els.panelBackdrop.classList.remove('open');
}

els.panelClose.addEventListener('click', closePanel);
els.panelBackdrop.addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panelFamily) closePanel();
});

/* ============================== Controles ============================== */

function initUI() {
  showOnly('');
  els.toolbar.classList.remove('hidden');
  els.sidebar.classList.remove('hidden');
  els.search.disabled = false;
  buildSidebar();
  render();
}

els.loadBtn.addEventListener('click', loadFonts);
els.retryBtn.addEventListener('click', loadFonts);

els.search.addEventListener('input', debounce(() => {
  state.search = els.search.value;
  render();
}, 150));

els.sampleText.addEventListener('input', debounce(() => {
  state.sampleText = els.sampleText.value.trim() || DEFAULT_SAMPLE;
  for (const preview of document.querySelectorAll('.card-preview')) {
    preview.textContent = state.sampleText;
  }
  if (panelFamily) els.panelPreview.textContent = state.sampleText;
}, 120));

els.sizeSlider.addEventListener('input', () => {
  const size = els.sizeSlider.value;
  document.documentElement.style.setProperty('--size', size + 'px');
  els.sizeValue.textContent = size + ' px';
});

els.sortSelect.addEventListener('change', () => {
  state.sort = els.sortSelect.value;
  render();
});

function setView(view) {
  state.view = view;
  els.grid.classList.toggle('list-view', view === 'list');
  els.viewGrid.setAttribute('aria-pressed', String(view === 'grid'));
  els.viewList.setAttribute('aria-pressed', String(view === 'list'));
}
els.viewGrid.addEventListener('click', () => setView('grid'));
els.viewList.addEventListener('click', () => setView('list'));

/* ============================== Arranque ============================== */

if (!('queryLocalFonts' in window)) {
  showOnly('unsupported-state');
}
