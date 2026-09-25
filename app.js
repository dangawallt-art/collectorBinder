'use strict';

/* ================= Config ================= */

const TCG = 'https://api.tcgdex.net/v2/en';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const RATES_URL = 'https://api.frankfurter.app/latest?from=EUR&to=SEK,USD';

const MODELS = [
  ['claude-sonnet-5', 'Claude Sonnet 5 (recommended)'],
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (cheapest)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (most careful)'],
];

const STALE_MS = 6 * 3600e3;      // refresh prices older than this when the app opens
const FOIL_EUR = 10;              // cards worth at least this get the foil price tag
const MAX_HISTORY = 120;
const IMG_MAX = 1568;

const VARIANT_LABEL = { normal: 'Normal', holo: 'Holo', reverse: 'Reverse holo', firstEdition: '1st edition' };

const SYSTEM_PROMPT = `You identify Pokémon trading cards in photos for a collection app.
Return ONLY a JSON object, with no prose and no code fences, in this shape:
{"cards":[{"name":string,"number":string|null,"setTotal":string|null,"setName":string|null,"variant":"normal"|"holo"|"reverse"|"firstEdition","language":string,"graded":boolean,"position":string,"confidence":"high"|"medium"|"low"}]}

Rules:
- One entry per card whose front is visible clearly enough to identify. Skip card backs.
- name: the card name exactly as on the English printing, including prefixes and suffixes such as "Team Rocket's", "Dark", "Galarian", "Radiant", ex, EX, GX, V, VMAX, VSTAR, BREAK. Use lowercase "ex" for Scarlet & Violet era cards and uppercase "EX" for Black & White / XY era cards. If the card is not in English, give the English name and set "language" to the card's language.
- number: the collector number before the slash, as printed. "4/102" gives "4", "TG05/TG30" gives "TG05", a promo "SWSH050" gives "SWSH050". Use null if you cannot read it.
- setTotal: the part after the slash, e.g. "102". Use null if there is none or you cannot read it.
- setName: the English set name if the set symbol, regulation mark, copyright year or layout makes it clear; otherwise null.
- variant: "firstEdition" if a 1st Edition stamp is visible; "reverse" if the foil shine covers the card body/frame but not the artwork; "holo" if the artwork box itself is foil; otherwise "normal".
- graded: true if the card is inside a grading slab.
- position: a short location in the photo such as "top left" or "only card".
- If no Pokémon cards are visible, return {"cards":[]}.`;

/* ================= Helpers ================= */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const safeParse = s => { try { return JSON.parse(s) || {}; } catch { return {}; } };

function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

async function getJSON(url, opts = {}, timeout = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.body = await res.text().catch(() => '');
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function runPool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This file could not be opened as an image.')); };
    img.src = url;
  });
}

async function downscale(file, max = IMG_MAX, quality = 0.85) {
  let src = null;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back */ }
  if (!src) src = await loadImage(file);
  const w = src.width, h = src.height;
  const s = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * s);
  canvas.height = Math.round(h * s);
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  if (src.close) src.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not process the photo.'))), 'image/jpeg', quality));
}

function relTime(ts) {
  if (!ts) return '';
  const diff = (ts - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86400), 'day');
}

/* ================= Settings ================= */

const SETTINGS_KEY = 'binder.settings';
const settings = Object.assign(
  { apiKey: '', model: MODELS[0][0], currency: 'SEK', sort: 'value' },
  safeParse(localStorage.getItem(SETTINGS_KEY))
);
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage full or blocked */ }
}

/* ================= Currency ================= */

let rates = safeParse(localStorage.getItem('binder.rates'));

async function loadRates() {
  if (rates.at && Date.now() - rates.at < 12 * 3600e3) return;
  try {
    const r = await getJSON(RATES_URL, {}, 10000);
    rates = { at: Date.now(), SEK: r.rates.SEK, USD: r.rates.USD };
    localStorage.setItem('binder.rates', JSON.stringify(rates));
  } catch { /* keep old rates */ }
}

function valueEUR(snap) {
  if (!snap) return null;
  if (snap.eur != null) return snap.eur;
  if (snap.usd != null && rates.USD) return snap.usd / rates.USD;
  return null;
}

function fmtMoney(amount, currency, signed = false) {
  const big = Math.abs(amount) >= 100;
  return new Intl.NumberFormat('sv-SE', {
    style: 'currency',
    currency,
    minimumFractionDigits: big ? 0 : 2,
    maximumFractionDigits: big ? 0 : 2,
    signDisplay: signed ? 'exceptZero' : 'auto',
  }).format(amount);
}

function fmt(eur, signed = false) {
  if (eur == null || Number.isNaN(eur)) return '–';
  const cur = settings.currency;
  if (cur === 'EUR') return fmtMoney(eur, 'EUR', signed);
  const rate = rates[cur];
  return rate ? fmtMoney(eur * rate, cur, signed) : fmtMoney(eur, 'EUR', signed);
}

function fmtUSD(usd) {
  if (usd == null) return '–';
  if (settings.currency === 'USD') return fmtMoney(usd, 'USD');
  if (rates.USD) return `${fmt(usd / rates.USD)} (${fmtMoney(usd, 'USD')})`;
  return fmtMoney(usd, 'USD');
}

/* ================= IndexedDB ================= */

let dbPromise;
function idb() {
  return (dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('binder', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('cards')) d.createObjectStore('cards', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

async function tx(store, mode, fn) {
  const d = await idb();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const dbAll = store => tx(store, 'readonly', s => s.getAll());
const dbGet = (store, id) => tx(store, 'readonly', s => s.get(id));
const dbPut = (store, val) => tx(store, 'readwrite', s => s.put(val));
const dbDel = (store, id) => tx(store, 'readwrite', s => s.delete(id));
const dbClear = store => tx(store, 'readwrite', s => s.clear());

const photoURLs = new Map();
async function photoURL(id) {
  if (!id) return null;
  if (photoURLs.has(id)) return photoURLs.get(id);
  const p = await dbGet('photos', id);
  if (!p?.blob) return null;
  const url = URL.createObjectURL(p.blob);
  photoURLs.set(id, url);
  return url;
}

/* ================= TCGdex ================= */

const cardCache = new Map();
async function getCard(id, fresh = false) {
  if (!fresh && cardCache.has(id)) return cardCache.get(id);
  const c = await getJSON(`${TCG}/cards/${encodeURIComponent(id)}`);
  cardCache.set(id, c);
  return c;
}

let setsPromise;
function getSets() {
  return (setsPromise ||= getJSON(`${TCG}/sets`).catch(() => { setsPromise = null; return []; }));
}

async function searchByName(name) {
  try {
    const r = await getJSON(`${TCG}/cards?name=${encodeURIComponent(name)}`);
    return Array.isArray(r) ? r : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

const normName = s => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘`´]/g, "'")
  .replace(/\s+/g, ' ')
  .trim();

function normNum(s) {
  if (s == null) return '';
  const t = String(s).split('/')[0].toUpperCase().replace(/\s+/g, '');
  return t.replace(/^([A-Z]*)0*(\d)/, '$1$2');
}

function numMatch(a, b) {
  const x = normNum(a), y = normNum(b);
  if (!x || !y) return 0;
  if (x === y) return 2;
  const dx = x.replace(/\D/g, '').replace(/^0+/, ''), dy = y.replace(/\D/g, '').replace(/^0+/, '');
  return dx && dx === dy ? 1 : 0;
}

const STOP = new Set(['and', 'the', 'of', '&', 'pokemon', 'set']);
function similarity(a, b) {
  const words = s => new Set(normName(s).split(/[^a-z0-9.]+/).filter(w => w && !STOP.has(w)));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach(w => { if (B.has(w)) hit++; });
  return hit / Math.max(A.size, B.size);
}

const SUFFIX_RX = /\b(ex|gx|v|vmax|vstar|v-union|lv\.?x|break|prime|legend|star)\b/gi;

async function findCandidates(d, limit = 6) {
  const name = String(d.name || '').trim();
  if (!name) return [];
  let briefs = await searchByName(name);
  if (!briefs.length) {
    const base = name.replace(SUFFIX_RX, '').replace(/\s+/g, ' ').trim();
    if (base && base !== name) briefs = await searchByName(base);
  }
  if (!briefs.length) return [];

  const nn = normName(name);
  const exact = briefs.filter(b => normName(b.name) === nn);
  const pool = exact.length ? exact : briefs;

  const sets = await getSets();
  const setById = new Map(sets.map(s => [s.id, s]));
  const total = parseInt(d.setTotal, 10);

  const scored = pool.map(b => {
    const setId = b.id.slice(0, b.id.lastIndexOf('-'));
    const set = setById.get(setId);
    let score = 0;
    const nm = numMatch(d.number, b.localId);
    score += nm === 2 ? 6 : nm === 1 ? 3 : 0;
    if (total && set?.cardCount) {
      if (set.cardCount.official === total) score += 3;
      else if (set.cardCount.total === total) score += 1;
    }
    if (d.setName && set) score += 4 * similarity(d.setName, set.name);
    if (normName(b.name) === nn) score += 1;
    return { brief: b, score };
  });
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, limit);
  const full = await Promise.all(top.map(x =>
    getCard(x.brief.id).then(card => ({ card, score: x.score })).catch(() => null)));
  return full.filter(Boolean);
}

/* ================= Prices ================= */

function availableVariants(card) {
  const v = card.variants || {};
  const list = ['normal', 'holo', 'reverse', 'firstEdition'].filter(k => v[k]);
  return list.length ? list : ['normal'];
}

function defaultVariant(card, detected) {
  const list = availableVariants(card);
  if (detected && list.includes(detected)) return detected;
  return list[0];
}

function pickPrices(card, variant) {
  const p = card.pricing || {};
  const cm = p.cardmarket;
  const tp = p.tcgplayer;
  const hasNormal = !!card.variants?.normal;
  const foil = variant === 'reverse' || ((variant === 'holo' || variant === 'firstEdition') && hasNormal);

  let eur = null, eur30 = null, eurLow = null;
  if (cm) {
    const read = useFoil => {
      const k = key => cm[useFoil ? `${key}-holo` : key];
      return { trend: k('trend') ?? k('avg') ?? k('avg30') ?? null, avg30: k('avg30') ?? null, low: k('low') ?? null };
    };
    let r = read(foil);
    if (r.trend == null) r = read(!foil);
    eur = r.trend; eur30 = r.avg30; eurLow = r.low;
  }

  let usd = null, tpKey = null;
  if (tp) {
    const keys = Object.keys(tp).filter(k => tp[k] && typeof tp[k] === 'object');
    const prefs = {
      normal: [/^normal$/, /^unlimited$/],
      holo: [/^holo(foil)?$/, /^unlimited-holofoil$/, /holo/],
      reverse: [/reverse/],
      firstEdition: [/^1st-edition-holofoil$/, /^1st-edition/],
    }[variant] || [];
    tpKey = prefs.map(rx => keys.find(k => rx.test(k))).find(Boolean) || keys[0] || null;
    if (tpKey) usd = tp[tpKey].marketPrice ?? tp[tpKey].midPrice ?? null;
  }

  return { eur, eur30, eurLow, usd, tpKey, cmAt: cm?.updated || null, tpAt: tp?.updated || null };
}

function snapshot(card, variant) {
  return { at: Date.now(), ...pickPrices(card, variant) };
}

function pushHistory(rec, snap) {
  rec.last = snap;
  const h = (rec.history ||= []);
  const prev = h[h.length - 1];
  if (prev && new Date(prev.at).toDateString() === new Date(snap.at).toDateString()) h[h.length - 1] = snap;
  else h.push(snap);
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}

function applyCard(rec, card, variant) {
  const snap = snapshot(card, variant);
  Object.assign(rec, {
    tcgdexId: card.id,
    name: card.name,
    setName: card.set?.name || '',
    setId: card.set?.id || '',
    localId: String(card.localId ?? ''),
    setTotal: card.set?.cardCount?.official ?? null,
    rarity: card.rarity || '',
    image: card.image || '',
    variant,
    variants: availableVariants(card),
    first: snap,
    last: snap,
    history: [snap],
  });
  return rec;
}

function makeRecord(card, variant, photoId, detected) {
  return applyCard({ id: uid(), photoId, addedAt: Date.now(), qty: 1, detected: detected || null }, card, variant);
}

const cardNumber = c => (c.setTotal ? `${c.localId}/${c.setTotal}` : c.localId);
const imgSmall = url => (url ? `${url}/low.webp` : '');
const imgLarge = url => (url ? `${url}/high.webp` : '');

/* ================= Claude ================= */

function apiErrorText(status, msg) {
  if (status === 401) return 'Your API key was rejected. Check it in Settings.';
  if (status === 403) return 'This API key is not allowed to use that model. Try another model in Settings.';
  if (status === 404) return 'That model was not found. Pick another model in Settings.';
  if (status === 429) return 'Too many requests right now. Wait a minute and try again.';
  if (status === 400 && /credit|balance|billing/i.test(msg)) return 'Your Anthropic account is out of credits. Add credits at console.anthropic.com.';
  if (status === 529 || status >= 500) return 'Claude is busy right now. Try again in a moment.';
  return msg || `Request failed (${status}).`;
}

function extractJSON(text) {
  const s = text.replace(/```json|```/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Claude answered in an unexpected format. Try the photo again.');
  return JSON.parse(s.slice(a, b + 1));
}

async function identify(blob) {
  const data = await blobToBase64(blob);
  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            { type: 'text', text: 'Identify every Pokémon card in this photo. Reply with the JSON object only.' },
          ],
        }],
      }),
    });
  } catch {
    throw new Error('Could not reach Claude. Check your internet connection.');
  }
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).error?.message || ''; } catch { /* no body */ }
    throw new Error(apiErrorText(res.status, msg));
  }
  const out = await res.json();
  const text = (out.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const json = extractJSON(text);
  return Array.isArray(json.cards) ? json.cards : [];
}

/* ================= State ================= */

const state = { cards: [], filter: '', refreshing: false };

async function loadCards() {
  state.cards = await dbAll('cards');
}

function totals() {
  let total = 0, change = 0, priced = 0, oldest = null;
  for (const c of state.cards) {
    const v = valueEUR(c.last);
    const f = valueEUR(c.first);
    const q = c.qty || 1;
    if (v != null) { total += v * q; priced++; }
    if (v != null && f != null) change += (v - f) * q;
    if (c.last?.at && (oldest == null || c.last.at < oldest)) oldest = c.last.at;
  }
  const count = state.cards.reduce((n, c) => n + (c.qty || 1), 0);
  return { total, change, priced, oldest, count };
}

function sortedCards() {
  const q = normName(state.filter);
  let list = state.cards;
  if (q) list = list.filter(c => normName(`${c.name} ${c.setName} ${c.localId}`).includes(q));
  list = [...list];
  if (settings.sort === 'value') list.sort((a, b) => (valueEUR(b.last) ?? -1) - (valueEUR(a.last) ?? -1));
  else if (settings.sort === 'newest') list.sort((a, b) => b.addedAt - a.addedAt);
  else list.sort((a, b) => a.name.localeCompare(b.name) || a.setName.localeCompare(b.setName));
  return list;
}

/* ================= Render: binder ================= */

function setMeta(text) {
  $('#meta').textContent = text;
}

function renderSummary() {
  const t = totals();
  $('#total').textContent = state.cards.length ? fmt(t.total) : fmt(0);
  const ch = $('#change');
  ch.className = 'change';
  if (state.cards.length && Math.abs(t.change) >= 0.005) {
    ch.classList.add(t.change > 0 ? 'up' : 'down');
    ch.textContent = `${fmt(t.change, true)} since you added them`;
  } else {
    ch.textContent = '';
  }
  if (!state.refreshing) {
    const count = `${t.count} ${t.count === 1 ? 'card' : 'cards'}`;
    setMeta(state.cards.length ? `${count}, prices checked ${relTime(t.oldest)}` : 'No cards yet');
  }
  $('#refreshBtn').hidden = !state.cards.length;
  $('#refreshBtn').disabled = state.refreshing;
}

function pocketHTML(c) {
  const v = valueEUR(c.last);
  const foil = v != null && v >= FOIL_EUR;
  const src = imgSmall(c.image);
  return `<button class="pocket" type="button" data-id="${esc(c.id)}" aria-label="${esc(`${c.name}, ${c.setName} ${cardNumber(c)}, ${fmt(v)}`)}">
    <span class="card-img">${src ? `<img loading="lazy" src="${esc(src)}" alt="" onerror="this.remove()">` : `<img loading="lazy" data-photo="${esc(c.photoId)}" alt="">`}</span>
    <span class="pocket-name">${esc(c.name)}</span>
    <span class="tag${foil ? ' foil' : ''}">${esc(fmt(v))}${c.qty > 1 ? ` <small>×${c.qty}</small>` : ''}</span>
  </button>`;
}

function render() {
  const list = sortedCards();
  const grid = $('#grid');
  grid.innerHTML = list.map(pocketHTML).join('');
  grid.querySelectorAll('img[data-photo]').forEach(async img => {
    const url = await photoURL(img.dataset.photo);
    if (url) img.src = url;
  });
  const empty = !state.cards.length;
  $('#empty').hidden = !empty;
  $('#toolbar').hidden = empty;
  $('#emptyText').textContent = settings.apiKey
    ? "Take a photo of one or more cards and they'll show up here with their current price."
    : 'Add your Anthropic API key in Settings, then take a photo of one or more cards.';
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.sort === settings.sort)));
  renderSummary();
}

/* ================= Price refresh ================= */

async function refreshPrices(force = false) {
  if (state.refreshing) return;
  const due = state.cards.filter(c => c.tcgdexId && (force || !c.last || Date.now() - c.last.at > STALE_MS));
  if (!due.length) {
    if (force) toast('Prices are up to date.');
    return;
  }
  state.refreshing = true;
  renderSummary();
  let done = 0, failed = 0;
  setMeta(`Updating prices 0 of ${due.length}`);
  await loadRates();
  await runPool(due, 4, async rec => {
    try {
      const card = await getCard(rec.tcgdexId, true);
      pushHistory(rec, snapshot(card, rec.variant));
      if (card.image && !rec.image) rec.image = card.image;
      await dbPut('cards', rec);
    } catch {
      failed++;
    }
    done++;
    setMeta(`Updating prices ${done} of ${due.length}`);
  });
  state.refreshing = false;
  render();
  if (failed) toast(`${failed} ${failed === 1 ? 'price' : 'prices'} could not be updated. Try again later.`);
}

/* ================= Search widget (review + detail) ================= */

function searchFormHTML(name = '', number = '') {
  return `<form class="search" data-search>
      <input type="text" name="name" value="${esc(name)}" placeholder="Card name" aria-label="Card name" required>
      <input type="text" name="number" value="${esc(number)}" placeholder="No. e.g. 4/102" aria-label="Card number">
      <button class="btn small" type="submit">Search</button>
    </form>
    <div class="results" data-results></div>`;
}

function resultHTML(card) {
  const v = valueEUR(snapshot(card, defaultVariant(card)));
  const num = card.set?.cardCount?.official ? `${card.localId}/${card.set.cardCount.official}` : card.localId;
  return `<button type="button" class="result" data-pick="${esc(card.id)}">
    ${card.image ? `<img loading="lazy" src="${esc(imgSmall(card.image))}" alt="" onerror="this.remove()">` : '<img alt="">'}
    <span><b>${esc(card.name)}</b>${esc(card.set?.name || '')}, ${esc(num)}<br>${esc(fmt(v))}</span>
  </button>`;
}

async function runSearch(form) {
  const name = form.elements.name.value.trim();
  const number = form.elements.number.value.trim();
  const out = form.nextElementSibling;
  if (!name) return;
  out.innerHTML = '<p class="hint"><span class="spinner"></span>Searching…</p>';
  try {
    const [num, total] = number.split('/');
    const cands = await findCandidates({ name, number: num || null, setTotal: total || null }, 8);
    out.innerHTML = cands.length
      ? cands.map(c => resultHTML(c.card)).join('')
      : `<p class="hint">No cards named “${esc(name)}” found. Check the spelling, or use the English name.</p>`;
  } catch {
    out.innerHTML = '<p class="hint">Search failed. Check your connection and try again.</p>';
  }
}

/* ================= Review (after a scan) ================= */

const review = { jobs: [] };

function findDupe(card, variant) {
  return state.cards.find(c => c.tcgdexId === card.id && c.variant === variant);
}

function rowHTML(job, row) {
  const cand = row.cands[row.idx];
  const detectedLine = [row.detected.name, row.detected.number && (row.detected.setTotal ? `${row.detected.number}/${row.detected.setTotal}` : row.detected.number)].filter(Boolean).join(' ');

  if (!cand) {
    return `<div class="row" data-job="${job.id}" data-row="${row.id}">
      <div class="row-img"></div>
      <div class="row-body">
        <p class="row-name">No match for “${esc(detectedLine || 'unknown card')}”</p>
        <p class="row-sub">Search for it by name and number.</p>
        ${searchFormHTML(row.detected.name || '', detectedLine.replace(row.detected.name || '', '').trim())}
      </div>
    </div>`;
  }

  const card = cand.card;
  const v = valueEUR(snapshot(card, row.variant));
  const num = card.set?.cardCount?.official ? `${card.localId}/${card.set.cardCount.official}` : card.localId;
  const dupe = findDupe(card, row.variant);
  const variantOpts = availableVariants(card).map(k => `<option value="${k}"${k === row.variant ? ' selected' : ''}>${VARIANT_LABEL[k]}</option>`).join('');
  const candOpts = row.cands.length > 1
    ? `<select data-cand aria-label="Other matches">${row.cands.map((c, i) => `<option value="${i}"${i === row.idx ? ' selected' : ''}>${esc(c.card.set?.name || c.card.id)} ${esc(c.card.localId)}</option>`).join('')}</select>`
    : '';

  return `<div class="row${row.include ? '' : ' off'}" data-job="${job.id}" data-row="${row.id}">
    <div class="row-img">${card.image ? `<img src="${esc(imgSmall(card.image))}" alt="" onerror="this.remove()">` : ''}</div>
    <div class="row-body">
      <p class="row-name">${esc(card.name)}</p>
      <p class="row-sub">${esc(card.set?.name || '')}, ${esc(num)}${row.detected.graded ? ', graded' : ''}${row.detected.language && !/^en/i.test(row.detected.language) ? `, ${esc(row.detected.language)} card` : ''}</p>
      <p class="row-price">${esc(fmt(v))}</p>
      <div class="row-controls">
        <select data-variant aria-label="Variant">${variantOpts}</select>
        ${candOpts}
        <button type="button" class="btn small" data-research>Wrong card</button>
      </div>
      ${row.searching ? searchFormHTML(card.name, row.detected.number || '') : ''}
      ${dupe ? `<p class="dupe">Already in your binder (×${dupe.qty || 1}). Tick below to add one more.</p>` : ''}
      <label class="check"><input type="checkbox" data-include${row.include ? ' checked' : ''}> ${dupe ? 'Add another copy' : 'Add to binder'}</label>
    </div>
  </div>`;
}

function jobHTML(job) {
  let status;
  if (job.status === 'reading') status = '<span class="spinner"></span>Reading cards…';
  else if (job.status === 'matching') status = '<span class="spinner"></span>Looking up prices…';
  else if (job.status === 'error') status = esc(job.error);
  else if (!job.rows.length) status = 'No Pokémon cards found in this photo. Try a closer, sharper shot.';
  else status = `${job.rows.length} ${job.rows.length === 1 ? 'card' : 'cards'} found`;
  return `<section class="job">
    <div class="job-head">
      <img src="${esc(job.url)}" alt="Your photo">
      <p class="job-status${job.status === 'error' ? ' error' : ''}">${status}</p>
    </div>
    ${job.rows.map(r => rowHTML(job, r)).join('')}
  </section>`;
}

function renderReview() {
  $('#reviewBody').innerHTML = review.jobs.map(jobHTML).join('');
  updateSaveButton();
}

function updateSaveButton() {
  const n = review.jobs.flatMap(j => j.rows).filter(r => r.include && r.cands[r.idx]).length;
  const btn = $('#saveReview');
  btn.disabled = n === 0;
  btn.textContent = n ? `Add ${n} ${n === 1 ? 'card' : 'cards'}` : 'Add cards';
}

function getRow(el) {
  const rowEl = el.closest('[data-row]');
  if (!rowEl) return {};
  const job = review.jobs.find(j => j.id === rowEl.dataset.job);
  const row = job?.rows.find(r => r.id === rowEl.dataset.row);
  return { job, row, rowEl };
}

function rerenderRow(job, row, rowEl) {
  const tmp = document.createElement('div');
  tmp.innerHTML = rowHTML(job, row);
  rowEl.replaceWith(tmp.firstElementChild);
  updateSaveButton();
}

async function handleFiles(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
  if (!files.length) return;
  if (!settings.apiKey) {
    openSettings('Add your Anthropic API key to start scanning cards.');
    return;
  }
  const dlg = $('#review');
  if (!dlg.open) {
    review.jobs = [];
    dlg.showModal();
  }
  const jobs = files.map(f => ({ id: uid(), file: f, blob: null, url: '', status: 'reading', rows: [], error: '' }));
  for (const job of jobs) {
    job.url = URL.createObjectURL(job.file);
    review.jobs.push(job);
  }
  renderReview();
  loadRates();

  for (const job of jobs) {
    if (!review.jobs.includes(job)) continue;
    try {
      job.blob = await downscale(job.file);
      const detected = await identify(job.blob);
      if (!review.jobs.includes(job)) continue;
      job.status = 'matching';
      renderReview();
      job.rows = await Promise.all(detected.map(async d => {
        let cands = [];
        try { cands = await findCandidates(d); } catch { /* shown as no match */ }
        const card = cands[0]?.card;
        const variant = card ? defaultVariant(card, d.variant) : 'normal';
        return { id: uid(), detected: d, cands, idx: 0, variant, include: !!card && !findDupe(card, variant), searching: false };
      }));
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e.message || 'Something went wrong reading this photo.';
    }
    if (review.jobs.includes(job)) renderReview();
  }
}

async function saveReview() {
  let added = 0, bumped = 0;
  for (const job of review.jobs) {
    const rows = job.rows.filter(r => r.include && r.cands[r.idx]);
    if (!rows.length || !job.blob) continue;
    const fresh = [];
    for (const r of rows) {
      const card = r.cands[r.idx].card;
      const dupe = findDupe(card, r.variant);
      if (dupe) {
        dupe.qty = (dupe.qty || 1) + 1;
        await dbPut('cards', dupe);
        bumped++;
      } else {
        fresh.push(r);
      }
    }
    if (!fresh.length) continue;
    const photoId = uid();
    await dbPut('photos', { id: photoId, blob: job.blob, addedAt: Date.now() });
    for (const r of fresh) {
      const rec = makeRecord(r.cands[r.idx].card, r.variant, photoId, r.detected);
      await dbPut('cards', rec);
      state.cards.push(rec);
      added++;
    }
  }
  closeReview();
  render();
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  const parts = [];
  if (added) parts.push(`Added ${added} ${added === 1 ? 'card' : 'cards'}`);
  if (bumped) parts.push(`${bumped} extra ${bumped === 1 ? 'copy' : 'copies'} counted`);
  if (parts.length) toast(parts.join(', ') + '.');
}

function closeReview() {
  review.jobs.forEach(j => j.url && URL.revokeObjectURL(j.url));
  review.jobs = [];
  const dlg = $('#review');
  if (dlg.open) dlg.close();
}

function wireReview() {
  const body = $('#reviewBody');

  body.addEventListener('change', e => {
    const { job, row, rowEl } = getRow(e.target);
    if (!row) return;
    if (e.target.matches('[data-include]')) {
      row.include = e.target.checked;
      rowEl.classList.toggle('off', !row.include);
      updateSaveButton();
    } else if (e.target.matches('[data-variant]')) {
      row.variant = e.target.value;
      rerenderRow(job, row, rowEl);
    } else if (e.target.matches('[data-cand]')) {
      row.idx = Number(e.target.value);
      row.variant = defaultVariant(row.cands[row.idx].card, row.detected.variant);
      row.include = !findDupe(row.cands[row.idx].card, row.variant);
      rerenderRow(job, row, rowEl);
    }
  });

  body.addEventListener('click', e => {
    const research = e.target.closest('[data-research]');
    const pick = e.target.closest('[data-pick]');
    if (research) {
      const { job, row, rowEl } = getRow(research);
      row.searching = !row.searching;
      rerenderRow(job, row, rowEl);
    } else if (pick) {
      const { job, row, rowEl } = getRow(pick);
      const card = cardCache.get(pick.dataset.pick);
      if (!card) return;
      row.cands = [{ card, score: 99 }];
      row.idx = 0;
      row.variant = defaultVariant(card, row.detected.variant);
      row.include = !findDupe(card, row.variant);
      row.searching = false;
      rerenderRow(job, row, rowEl);
    }
  });

  body.addEventListener('submit', e => {
    if (!e.target.matches('[data-search]')) return;
    e.preventDefault();
    runSearch(e.target);
  });

  $('#saveReview').addEventListener('click', async () => {
    const btn = $('#saveReview');
    btn.disabled = true;
    try { await saveReview(); } catch { toast('Saving failed. Your phone may be low on storage.'); btn.disabled = false; }
  });
}

/* ================= Detail ================= */

let detailId = null;
let showPhoto = false;

function sparkSVG(history) {
  const pts = (history || []).map(s => valueEUR(s)).filter(v => v != null);
  if (pts.length < 2) return '';
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / (pts.length - 1)) * 100},${38 - ((v - min) / span) * 36}`).join(' ');
  return `<div class="spark" aria-label="Price history, ${pts.length} days">
    <svg viewBox="0 0 100 40" preserveAspectRatio="none"><path d="${d}"/></svg>
    <p class="hint">Lowest ${esc(fmt(min))}, highest ${esc(fmt(max))} over ${pts.length} checks</p>
  </div>`;
}

async function renderDetail() {
  const c = state.cards.find(x => x.id === detailId);
  if (!c) return;
  const v = valueEUR(c.last);
  const f = valueEUR(c.first);
  const diff = v != null && f != null ? v - f : null;
  const s = c.last || {};
  const photo = await photoURL(c.photoId);
  const usePhoto = showPhoto && photo;
  const imgSrc = usePhoto ? photo : imgLarge(c.image) || photo || '';
  const q = encodeURIComponent(`${c.name} ${c.localId}`);
  const variantOpts = (c.variants || ['normal']).map(k => `<option value="${k}"${k === c.variant ? ' selected' : ''}>${VARIANT_LABEL[k]}</option>`).join('');

  $('#detailTitle').textContent = c.name;
  $('#detailBody').innerHTML = `
    <div class="detail-top">
      <div>
        <div class="detail-img">${imgSrc ? `<img class="${usePhoto ? '' : 'official'}" src="${esc(imgSrc)}" alt="${usePhoto ? 'Your photo' : esc(c.name)}" onerror="this.remove()">` : ''}</div>
        ${photo && c.image ? `<button type="button" class="text-btn img-toggle" data-toggle-photo>${usePhoto ? 'Show card image' : 'Show your photo'}</button>` : ''}
      </div>
      <div>
        <p class="detail-value">${esc(fmt(v))}</p>
        <p class="detail-sub">${c.qty > 1 ? `${esc(fmt(v != null ? v * c.qty : null))} for ${c.qty} copies` : 'per card'}</p>
        ${diff != null && Math.abs(diff) >= 0.005 ? `<p class="detail-change ${diff > 0 ? 'up' : 'down'}">${esc(fmt(diff, true))} since you added it</p>` : ''}
        <p class="detail-sub" style="margin-top:12px">${esc(c.setName)}<br>No. ${esc(cardNumber(c))}${c.rarity ? `<br>${esc(c.rarity)}` : ''}</p>
      </div>
    </div>

    <table class="prices">
      <caption>Current prices</caption>
      <tr><th scope="row">Cardmarket trend</th><td>${esc(fmt(s.eur))}</td></tr>
      <tr><th scope="row">Cardmarket 30-day average</th><td>${esc(fmt(s.eur30))}</td></tr>
      <tr><th scope="row">Cardmarket lowest listing</th><td>${esc(fmt(s.eurLow))}</td></tr>
      <tr><th scope="row">TCGplayer market</th><td>${esc(fmtUSD(s.usd))}</td></tr>
    </table>
    <p class="hint">Checked ${esc(relTime(s.at))}. Added ${esc(new Date(c.addedAt).toLocaleDateString('sv-SE'))} at ${esc(fmt(f))}.</p>

    ${sparkSVG(c.history)}

    <div class="detail-controls">
      <div class="field" style="margin:0">
        <label for="detailVariant">Variant</label>
        <select id="detailVariant" data-detail-variant>${variantOpts}</select>
      </div>
      <div>
        <span class="label" style="display:block;font-weight:600;font-size:.9375rem;margin-bottom:6px">Copies</span>
        <div class="qty">
          <button type="button" class="btn small" data-qty="-1" aria-label="One fewer">−</button>
          <output>${c.qty || 1}</output>
          <button type="button" class="btn small" data-qty="1" aria-label="One more">+</button>
        </div>
      </div>
    </div>

    <div class="links">
      <a class="btn small" href="https://www.pricecharting.com/search-products?type=prices&q=${q}" target="_blank" rel="noopener">PriceCharting</a>
      <a class="btn small" href="https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(c.name)}" target="_blank" rel="noopener">Cardmarket</a>
      <a class="btn small" href="https://www.tcgplayer.com/search/pokemon/product?q=${q}" target="_blank" rel="noopener">TCGplayer</a>
    </div>

    <p class="section-title">Wrong card?</p>
    ${searchFormHTML(c.name, c.localId)}

    <div class="field" style="margin-top:26px">
      <button type="button" class="btn danger" data-delete>Remove from binder</button>
    </div>`;
}

function openDetail(id) {
  detailId = id;
  showPhoto = false;
  renderDetail();
  $('#detail').showModal();
}

async function saveDetail(c) {
  await dbPut('cards', c);
  render();
  renderDetail();
}

function wireDetail() {
  const body = $('#detailBody');

  body.addEventListener('click', async e => {
    const c = state.cards.find(x => x.id === detailId);
    if (!c) return;
    if (e.target.closest('[data-toggle-photo]')) {
      showPhoto = !showPhoto;
      renderDetail();
    } else if (e.target.closest('[data-qty]')) {
      const n = Math.max(1, (c.qty || 1) + Number(e.target.closest('[data-qty]').dataset.qty));
      c.qty = n;
      await saveDetail(c);
    } else if (e.target.closest('[data-pick]')) {
      const card = cardCache.get(e.target.closest('[data-pick]').dataset.pick);
      if (!card) return;
      applyCard(c, card, defaultVariant(card, c.detected?.variant));
      await saveDetail(c);
      toast('Card updated.');
    } else if (e.target.closest('[data-delete]')) {
      if (!confirm(`Remove ${c.name} from your binder?`)) return;
      await dbDel('cards', c.id);
      state.cards = state.cards.filter(x => x.id !== c.id);
      if (c.photoId && !state.cards.some(x => x.photoId === c.photoId)) {
        await dbDel('photos', c.photoId);
        const url = photoURLs.get(c.photoId);
        if (url) { URL.revokeObjectURL(url); photoURLs.delete(c.photoId); }
      }
      $('#detail').close();
      render();
      toast(`Removed ${c.name}.`);
    }
  });

  body.addEventListener('change', async e => {
    if (!e.target.matches('[data-detail-variant]')) return;
    const c = state.cards.find(x => x.id === detailId);
    if (!c) return;
    try {
      const card = await getCard(c.tcgdexId, true);
      applyCard(c, card, e.target.value);
      await saveDetail(c);
    } catch {
      toast('Could not load prices for that variant. Try again.');
    }
  });

  body.addEventListener('submit', e => {
    if (!e.target.matches('[data-search]')) return;
    e.preventDefault();
    runSearch(e.target);
  });
}

/* ================= Settings ================= */

function openSettings(notice) {
  const n = $('#settingsNotice');
  n.hidden = !notice;
  n.textContent = notice || '';
  $('#apiKey').value = settings.apiKey;
  $('#apiKey').type = 'password';
  $('#toggleKey').textContent = 'Show';
  $('#model').value = settings.model;
  $('#currency').value = settings.currency;
  updateStorageInfo();
  $('#settings').showModal();
}

async function updateStorageInfo() {
  const el = $('#storageInfo');
  if (!navigator.storage?.estimate) { el.textContent = ''; return; }
  try {
    const { usage } = await navigator.storage.estimate();
    const photos = new Set(state.cards.map(c => c.photoId)).size;
    el.textContent = `${state.cards.length} cards and ${photos} photos, about ${(usage / 1048576).toFixed(1)} MB.`;
  } catch { el.textContent = ''; }
}

async function exportData() {
  const cards = await dbAll('cards');
  const photos = await dbAll('photos');
  const photoData = await Promise.all(photos.map(async p => ({ id: p.id, addedAt: p.addedAt, data: await blobToDataURL(p.blob) })));
  const payload = JSON.stringify({ app: 'binder', version: 1, exportedAt: new Date().toISOString(), cards, photos: photoData });
  const name = `binder-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([payload], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Binder backup' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importData(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('That file is not a Binder backup.'); return; }
  if (data?.app !== 'binder' || !Array.isArray(data.cards)) { toast('That file is not a Binder backup.'); return; }
  for (const p of data.photos || []) {
    try {
      const blob = await (await fetch(p.data)).blob();
      await dbPut('photos', { id: p.id, blob, addedAt: p.addedAt });
    } catch { /* skip broken photo */ }
  }
  for (const c of data.cards) if (c?.id) await dbPut('cards', c);
  await loadCards();
  render();
  toast(`Restored ${data.cards.length} cards.`);
  refreshPrices();
}

function wireSettings() {
  const model = $('#model');
  model.innerHTML = MODELS.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('');

  $('#apiKey').addEventListener('change', e => {
    settings.apiKey = e.target.value.trim();
    saveSettings();
    render();
  });
  $('#toggleKey').addEventListener('click', () => {
    const input = $('#apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggleKey').textContent = show ? 'Hide' : 'Show';
  });
  model.addEventListener('change', e => { settings.model = e.target.value; saveSettings(); });
  $('#currency').addEventListener('change', async e => {
    settings.currency = e.target.value;
    saveSettings();
    await loadRates();
    render();
  });
  $('#exportBtn').addEventListener('click', () => exportData().catch(() => toast('Backup failed.')));
  $('#importInput').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) importData(f);
  });
  $('#wipeBtn').addEventListener('click', async () => {
    if (!confirm('Delete every card and photo in this binder? This cannot be undone unless you have a backup.')) return;
    await dbClear('cards');
    await dbClear('photos');
    photoURLs.forEach(u => URL.revokeObjectURL(u));
    photoURLs.clear();
    state.cards = [];
    $('#settings').close();
    render();
    toast('Binder cleared.');
  });
}

/* ================= Init ================= */

function wireDialogs() {
  document.querySelectorAll('dialog').forEach(dlg => {
    dlg.addEventListener('click', e => {
      if (e.target === dlg || e.target.closest('[data-close]')) {
        if (dlg.id === 'review') closeReview();
        else dlg.close();
      }
    });
    dlg.addEventListener('cancel', e => {
      if (dlg.id === 'review') { e.preventDefault(); closeReview(); }
    });
  });
}

function wireMain() {
  $('#settingsBtn').addEventListener('click', () => openSettings());
  $('#refreshBtn').addEventListener('click', () => refreshPrices(true));
  $('#filter').addEventListener('input', e => { state.filter = e.target.value; render(); });
  document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
    settings.sort = b.dataset.sort;
    saveSettings();
    render();
  }));
  $('#grid').addEventListener('click', e => {
    const p = e.target.closest('.pocket');
    if (p) openDetail(p.dataset.id);
  });
  for (const id of ['#cameraInput', '#uploadInput']) {
    $(id).addEventListener('change', e => {
      const files = [...e.target.files];
      e.target.value = '';
      handleFiles(files);
    });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshPrices();
  });
}

async function init() {
  wireDialogs();
  wireMain();
  wireReview();
  wireDetail();
  wireSettings();
  try {
    await loadCards();
  } catch {
    toast('Could not open saved cards. Private browsing may block storage.');
  }
  render();
  await loadRates();
  render();
  refreshPrices();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

init();
