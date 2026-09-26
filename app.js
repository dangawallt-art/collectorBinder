'use strict';

/* ================= Config ================= */

const TCG = 'https://api.tcgdex.net/v2/en';
const PTCG = 'https://api.pokemontcg.io/v2';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const RATE_SOURCES = [
  ['https://api.frankfurter.dev/v1/latest?base=EUR&symbols=SEK,USD', r => r.rates],
  ['https://api.frankfurter.app/latest?from=EUR&to=SEK,USD', r => r.rates],
  ['https://open.er-api.com/v6/latest/EUR', r => r.rates],
];
const FALLBACK_RATES = { SEK: 11.0, USD: 1.16 };

const MODELS = [
  ['claude-sonnet-5', 'Claude Sonnet 5 (recommended)'],
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (cheapest)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (most careful)'],
];
const LOOKUP_MODELS = [
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (cheapest, recommended)'],
  ['claude-sonnet-5', 'Claude Sonnet 5 (more careful)'],
];

const STALE_MS = 6 * 3600e3;          // catalog prices older than this refresh on open
const PC_STALE_MS = 7 * 86400e3;      // PriceCharting prices older than this refresh when a card is opened
const CM_STALE_MS = 30 * 86400e3;     // skip Cardmarket numbers older than this in automatic mode
const FOIL_EUR = 10;                  // cards worth at least this get the foil price tag
const MAX_HISTORY = 120;
const IMG_MAX = 1568;
const WEB_FETCH_BETA = 'web-fetch-2025-09-10';

const VARIANT_LABEL = { normal: 'Normal', holo: 'Holo', reverse: 'Reverse holo', firstEdition: '1st edition' };
const SOURCE_LABEL = {
  pcRaw: 'PriceCharting ungraded',
  pcGrade: 'PriceCharting graded',
  tp: 'TCGplayer market',
  cm: 'Cardmarket trend',
  dexCm: 'Cardmarket trend (TCGdex)',
  dexTp: 'TCGplayer market (TCGdex)',
};
const GRADES = [
  ['ungraded', 'Ungraded'],
  ['grade7', 'Grade 7'],
  ['grade8', 'Grade 8'],
  ['grade9', 'Grade 9'],
  ['grade9_5', 'Grade 9.5'],
  ['psa10', 'PSA 10'],
];
const GRADE_LABEL = Object.fromEntries(GRADES);

const SYSTEM_PROMPT = `You identify Pokémon trading cards in photos for a collection app.
Return ONLY a JSON object, with no prose and no code fences, in this shape:
{"cards":[{"name":string,"number":string|null,"setTotal":string|null,"setName":string|null,"setCode":string|null,"variant":"normal"|"holo"|"reverse"|"firstEdition","language":string,"graded":boolean,"gradeCompany":string|null,"grade":string|null,"hp":string|null,"attack":string|null,"illustrator":string|null,"year":string|null,"position":string,"confidence":"high"|"medium"|"low","alternatives":[{"name":string,"number":string|null,"setName":string|null}]}]}

Rules:
- One entry per card whose front is visible clearly enough to identify. Skip card backs.
- name: the card name exactly as on the English printing, including prefixes and suffixes such as "Team Rocket's", "Dark", "Galarian", "Radiant", "M" (Mega), ex, EX, GX, V, VMAX, VSTAR, BREAK, δ, ★. Use lowercase "ex" for Scarlet & Violet era cards and uppercase "EX" for Black & White / XY era cards. For Trainer and Energy cards use the card title. If the card is not in English, give the English name and set "language" to the card's language.
- number: the collector number before the slash, as printed. "4/102" gives "4", "TG05/TG30" gives "TG05", a promo "SWSH050" gives "SWSH050". Use null if you cannot read it.
- setTotal: the part after the slash, e.g. "102". Use null if there is none or you cannot read it.
- setName: the English set name if the set symbol, regulation mark, copyright year or layout makes it clear; otherwise null.
- setCode: the small set abbreviation printed near the number on newer cards (for example "PAL", "SVI", "BRS"); null if there is none.
- variant: "firstEdition" if a 1st Edition stamp is visible; "reverse" if the foil shine covers the card body/frame but not the artwork; "holo" if the artwork box itself is foil; otherwise "normal".
- hp: the HP number; attack: the first attack or ability name; illustrator: the "Illus." name; year: the copyright year at the bottom. Use null for anything you cannot read.
- graded: true if the card is inside a grading slab; then gradeCompany is the company (PSA, BGS, CGC, …) and grade the grade as printed ("10", "9.5").
- position: a short location in the photo such as "top left" or "only card".
- alternatives: up to two other plausible readings when you are not sure; otherwise [].
- If no Pokémon cards are visible, return {"cards":[]}.`;

/* ================= Helpers ================= */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const safeParse = (s, fallback = {}) => { try { return JSON.parse(s) ?? fallback; } catch { return fallback; } };

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

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
const blobToBase64 = async blob => (await blobToDataURL(blob)).split(',')[1];

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
  {
    apiKey: '',
    ptcgKey: '',
    model: MODELS[0][0],
    lookupModel: LOOKUP_MODELS[0][0],
    currency: 'SEK',
    sort: 'value',
    basis: 'pricecharting',
    pcAuto: true,
    confirm: true,
  },
  safeParse(localStorage.getItem(SETTINGS_KEY))
);
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage full or blocked */ }
}

/* ================= Currency ================= */

let rates = safeParse(localStorage.getItem('binder.rates'));
if (!rates.SEK || !rates.USD) rates = { at: 0, ...FALLBACK_RATES, live: false };

async function loadRates(force = false) {
  if (!force && rates.live && Date.now() - rates.at < 12 * 3600e3) return;
  for (const [url, pick] of RATE_SOURCES) {
    try {
      const r = pick(await getJSON(url, {}, 8000));
      if (r?.SEK && r?.USD) {
        rates = { at: Date.now(), SEK: r.SEK, USD: r.USD, live: true };
        localStorage.setItem('binder.rates', JSON.stringify(rates));
        return;
      }
    } catch { /* try the next source */ }
  }
}

function ratesText() {
  const r = `1 EUR = ${rates.SEK.toFixed(2)} SEK, ${rates.USD.toFixed(2)} USD`;
  return rates.live ? `${r}, updated ${relTime(rates.at)}.` : `${r}. Using approximate rates until live rates load.`;
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
  return fmtMoney(eur * rates[cur], cur, signed);
}

const usdToEur = usd => (usd == null ? null : usd / rates.USD);

function entryEUR(e) {
  if (!e) return null;
  if (e.eur != null) return e.eur;
  if (e.usd != null) return usdToEur(e.usd);
  return null;
}

function fmtEntry(e) {
  if (!e) return '–';
  if (e.usd != null && settings.currency !== 'USD') return `${fmt(entryEUR(e))} (${fmtMoney(e.usd, 'USD')})`;
  if (e.eur != null && settings.currency !== 'EUR') return `${fmt(e.eur)} (${fmtMoney(e.eur, 'EUR')})`;
  return fmt(entryEUR(e));
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

/* ================= Problem log ================= */

const LOG_KEY = 'binder.scanlog';
function logProblem(kind, detected, extra = {}) {
  const log = safeParse(localStorage.getItem(LOG_KEY), []);
  log.push({ at: new Date().toISOString(), kind, detected, ...extra });
  while (log.length > 60) log.shift();
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch { /* full */ }
}
const problemLog = () => safeParse(localStorage.getItem(LOG_KEY), []);

/* ================= Names and numbers ================= */

const normName = s => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[’‘`´]/g, "'")
  .replace(/δ/g, ' delta ')
  .replace(/★/g, ' star ')
  .replace(/◇/g, ' prism star ')
  .replace(/&/g, ' and ')
  .replace(/-/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/^m (?=\S)/, 'mega ');

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

function numVariants(n) {
  if (!n) return [];
  const raw = String(n).split('/')[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!raw) return [];
  const stripped = raw.replace(/^([A-Z]*)0+(?=\d)/, '$1');
  const out = new Set([raw, stripped]);
  if (/^\d{1,2}$/.test(stripped)) out.add(stripped.padStart(3, '0'));
  return [...out];
}

const STOP = new Set(['and', 'the', 'of', 'pokemon', 'set']);
function similarity(a, b) {
  const words = s => new Set(normName(s).split(/[^a-z0-9.]+/).filter(w => w && !STOP.has(w)));
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach(w => { if (B.has(w)) hit++; });
  return hit / Math.max(A.size, B.size);
}

const IGNORE_WORDS = new Set(['ex', 'gx', 'vmax', 'vstar', 'union', 'break', 'prime', 'legend', 'star', 'team', 'dark', 'light',
  'shining', 'radiant', 'galarian', 'alolan', 'hisuian', 'paldean', 'rocket', 'mega', 'primal', 'the', 'delta', 'prism', 'and']);

function keyWord(name) {
  const words = normName(name).replace(/'s\b/g, '').split(/[^a-z]+/).filter(w => w.length >= 3 && !IGNORE_WORDS.has(w));
  return words.sort((a, b) => b.length - a.length)[0] || '';
}

const luceneWord = w => String(w).replace(/[^\p{L}\p{N}]/gu, '');

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
  if (!name) return [];
  try {
    const r = await getJSON(`${TCG}/cards?name=${encodeURIComponent(name)}`);
    return Array.isArray(r) ? r : [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

function availableVariants(card) {
  const v = card.variants || {};
  const list = ['normal', 'holo', 'reverse', 'firstEdition'].filter(k => v[k]);
  return list.length ? list : ['normal'];
}

/* ================= pokemontcg.io ================= */

const PTCG_FIELDS = 'id,name,number,rarity,hp,artist,set,tcgplayer,cardmarket,images';

function ptcgHeaders() {
  return settings.ptcgKey ? { 'X-Api-Key': settings.ptcgKey } : {};
}

async function ptcgQuery(q, pageSize = 60, orderBy = '') {
  const url = `${PTCG}/cards?q=${encodeURIComponent(q)}&pageSize=${pageSize}&select=${PTCG_FIELDS}${orderBy ? `&orderBy=${orderBy}` : ''}`;
  const r = await getJSON(url, { headers: ptcgHeaders() }, 20000);
  return Array.isArray(r.data) ? r.data : [];
}

async function ptcgFetchMany(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 40) {
    const chunk = ids.slice(i, i + 40);
    const res = await ptcgQuery(chunk.map(id => `id:"${id}"`).join(' OR '), 250);
    res.forEach(r => out.set(r.id, r));
  }
  return out;
}

const ptcgMatchCache = new Map();
function findPtcg(card) {
  if (!card) return Promise.resolve(null);
  if (!ptcgMatchCache.has(card.id)) {
    const p = findPtcgUncached(card).catch(() => { ptcgMatchCache.delete(card.id); return null; });
    ptcgMatchCache.set(card.id, p);
  }
  return ptcgMatchCache.get(card.id);
}

async function findPtcgUncached(card) {
  const nums = numVariants(card.localId);
  if (!nums.length) return null;
  const numQ = `(${nums.map(n => `number:"${n}"`).join(' OR ')})`;
  const total = card.set?.cardCount?.official;
  const word = keyWord(card.name);
  const nn = normName(card.name);
  const score = r => {
    const rn = normName(r.name);
    if (word && !rn.includes(word)) return -1;
    let sc = 0;
    if (r.set?.id === card.set?.id) sc += 6;
    if (total && r.set?.printedTotal === total) sc += 3;
    sc += 4 * similarity(r.set?.name, card.set?.name);
    if (rn === nn) sc += 2;
    return sc;
  };
  const queries = [];
  if (card.set?.id) queries.push(`set.id:"${card.set.id}" ${numQ}`);
  if (total) queries.push(`set.printedTotal:${total} ${numQ}`);
  if (word) queries.push(`name:${luceneWord(word)}* ${numQ}`);
  for (const q of queries) {
    let res = [];
    try { res = await ptcgQuery(q); } catch (e) { if (e.status === 429) throw e; continue; }
    const best = res.map(r => ({ r, sc: score(r) })).filter(x => x.sc >= 3).sort((a, b) => b.sc - a.sc)[0];
    if (best) return best.r;
  }
  return null;
}

/* ================= Matches (a card from TCGdex, pokemontcg.io, or both) ================= */

const M = {
  key: m => (m.dex ? `dex:${m.dex.id}` : m.pc ? `ptcg:${m.pc.id}` : `custom:${m.custom?.id}`),
  name: m => m.dex?.name || m.pc?.name || m.custom?.name || '',
  setName: m => m.dex?.set?.name || m.pc?.set?.name || m.custom?.setName || '',
  setId: m => m.dex?.set?.id || m.pc?.set?.id || '',
  number: m => String(m.dex?.localId ?? m.pc?.number ?? m.custom?.number ?? ''),
  total: m => m.dex?.set?.cardCount?.official ?? m.pc?.set?.printedTotal ?? m.custom?.setTotal ?? null,
  rarity: m => m.dex?.rarity || m.pc?.rarity || '',
  imgSmall: m => (m.dex?.image ? `${m.dex.image}/low.webp` : m.pc?.images?.small || ''),
  imgLarge: m => (m.dex?.image ? `${m.dex.image}/high.webp` : m.pc?.images?.large || ''),
};
const matchLabel = m => `${M.name(m)}, ${M.setName(m) || 'unknown set'}${M.number(m) ? `, ${M.number(m)}${M.total(m) ? `/${M.total(m)}` : ''}` : ''}`;
const matchCache = new Map();
const remember = m => { matchCache.set(M.key(m), m); return m; };

function variantsOf(m) {
  if (m.dex) return availableVariants(m.dex);
  const keys = Object.keys(m.pc?.tcgplayer?.prices || {});
  const found = new Set();
  keys.forEach(k => {
    if (/reverse/i.test(k)) found.add('reverse');
    else if (/^1st/i.test(k)) found.add('firstEdition');
    else if (/holo/i.test(k)) found.add('holo');
    else found.add('normal');
  });
  const list = ['normal', 'holo', 'reverse', 'firstEdition'].filter(v => found.has(v));
  return list.length ? list : ['normal', 'holo', 'reverse', 'firstEdition'];
}

function defaultVariant(m, detected) {
  const list = variantsOf(m);
  return detected && list.includes(detected) ? detected : list[0];
}

async function ensurePc(m) {
  if (m.pcChecked || !m.dex) return m;
  m.pc = await findPtcg(m.dex);
  m.pcChecked = true;
  return m;
}

function scoreMatch(m, d) {
  let s = 0;
  const nm = numMatch(d.number, M.number(m));
  s += nm === 2 ? 6 : nm === 1 ? 3 : 0;
  const tot = parseInt(d.setTotal, 10);
  const mt = M.total(m);
  if (tot && mt) {
    if (mt === tot) s += 3;
    else if (m.dex?.set?.cardCount?.total === tot || m.pc?.set?.total === tot) s += 1;
  }
  if (d.setName) s += 4 * similarity(d.setName, M.setName(m));
  if (d.setCode && m.pc?.set?.ptcgoCode && normName(d.setCode) === normName(m.pc.set.ptcgoCode)) s += 3;
  const dn = normName(d.name), mn = normName(M.name(m));
  const kw = keyWord(d.name);
  if (dn && dn === mn) s += 2;
  else if (kw && mn.includes(kw)) s += 1;
  else if (dn) s -= 2;
  const hp = String(d.hp || '').replace(/\D/g, '');
  if (hp && (String(m.pc?.hp || '') === hp || String(m.dex?.hp || '') === hp)) s += 1;
  const ill = m.dex?.illustrator || m.pc?.artist;
  if (d.illustrator && ill && similarity(ill, d.illustrator) >= 0.5) s += 1;
  return s;
}

async function dexCandidates(d, limit = 6) {
  const name = String(d.name || '').trim();
  if (!name) return [];
  let briefs = await searchByName(name);
  const nn = normName(name);
  if (!briefs.some(b => normName(b.name) === nn)) {
    const word = keyWord(name);
    if (word && word !== nn) {
      const more = await searchByName(word);
      const seen = new Set(briefs.map(b => b.id));
      briefs = briefs.concat(more.filter(b => !seen.has(b.id)));
    }
  }
  if (!briefs.length) return [];
  const exact = briefs.filter(b => normName(b.name) === nn);
  const pool = exact.length ? exact : briefs;
  const sets = await getSets();
  const setById = new Map(sets.map(s => [s.id, s]));
  const total = parseInt(d.setTotal, 10);
  const pre = pool.map(b => {
    const set = setById.get(b.id.slice(0, b.id.lastIndexOf('-')));
    let sc = 0;
    const nm = numMatch(d.number, b.localId);
    sc += nm === 2 ? 6 : nm === 1 ? 3 : 0;
    if (total && set?.cardCount) sc += set.cardCount.official === total ? 3 : set.cardCount.total === total ? 1 : 0;
    if (d.setName && set) sc += 4 * similarity(d.setName, set.name);
    if (normName(b.name) === nn) sc += 1;
    return { b, sc };
  }).sort((a, b) => b.sc - a.sc).slice(0, limit);
  const full = await Promise.all(pre.map(x => getCard(x.b.id).catch(() => null)));
  return full.filter(Boolean);
}

async function ptcgCandidates(d) {
  const nums = numVariants(d.number);
  const numQ = nums.length ? `(${nums.map(n => `number:"${n}"`).join(' OR ')})` : '';
  const tot = parseInt(d.setTotal, 10);
  const word = luceneWord(keyWord(d.name));
  const queries = [];
  if (numQ && d.setCode) queries.push(`set.ptcgoCode:"${luceneWord(d.setCode)}" ${numQ}`);
  if (numQ && tot) queries.push(`set.printedTotal:${tot} ${numQ}`);
  if (numQ && word) queries.push(`name:${word}* ${numQ}`);
  if (!numQ && word) queries.push(d.setName ? `name:${word}* set.name:"${String(d.setName).replace(/"/g, '')}"` : `name:${word}*`);
  if (!queries.length) return [];
  const results = await Promise.allSettled(queries.map(q => ptcgQuery(q, 40)));
  const seen = new Map();
  results.forEach(r => (r.value || []).forEach(c => seen.set(c.id, c)));
  return [...seen.values()];
}

function mergeMatches(dexCards, pcCards) {
  const out = dexCards.map(dex => ({ dex, pc: null, pcChecked: false }));
  for (const pc of pcCards) {
    const hit = out.find(m => m.dex && !m.pc
      && numMatch(m.dex.localId, pc.number) === 2
      && (m.dex.set?.id === pc.set?.id
        || similarity(m.dex.set?.name, pc.set?.name) >= 0.5
        || (m.dex.set?.cardCount?.official && m.dex.set.cardCount.official === pc.set?.printedTotal)));
    if (hit) { hit.pc = pc; hit.pcChecked = true; }
    else out.push({ dex: null, pc, pcChecked: true });
  }
  return out;
}

async function searchMatches(d) {
  const [dexR, pcR] = await Promise.allSettled([dexCandidates(d), ptcgCandidates(d)]);
  return mergeMatches(dexR.value || [], pcR.value || []);
}

async function findCandidates(d, limit = 6) {
  let list = (await searchMatches(d)).map(m => ({ m, score: scoreMatch(m, d) }));
  list.sort((a, b) => b.score - a.score);
  if ((!list.length || list[0].score < 5) && Array.isArray(d.alternatives)) {
    for (const alt of d.alternatives.slice(0, 2)) {
      if (!alt?.name) continue;
      const alt2 = { ...d, ...alt };
      const more = (await searchMatches(alt2)).map(m => ({ m, score: scoreMatch(m, alt2) - 1 }));
      list = list.concat(more);
    }
    list.sort((a, b) => b.score - a.score);
  }
  const seen = new Set();
  return list.filter(x => {
    const k = `${normName(M.setName(x.m))}|${normNum(M.number(x.m))}|${normName(M.name(x.m))}`;
    if (seen.has(k)) return false;
    seen.add(k);
    remember(x.m);
    return true;
  }).slice(0, limit);
}

/* ================= Free-text search ================= */

async function textSearch(text) {
  let restText = normName(text);
  if (!restText) return [];
  let setName = null;
  const sets = await getSets();
  let best = null;
  for (const s of sets) {
    const sn = normName(s.name);
    if (sn.length >= 3 && !/^\d+$/.test(sn) && ` ${restText} `.includes(` ${sn} `) && (!best || sn.length > normName(best.name).length)) best = s;
  }
  if (best) {
    setName = best.name;
    restText = ` ${restText} `.replace(` ${normName(best.name)} `, ' ').trim();
  }
  let number = null, total = null;
  const rest = [];
  const tokens = restText.split(/\s+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const mm = tokens[i].match(/^#?([a-z]{0,6}\d+[a-z]?)(?:\/([a-z]{0,4}\d+))?$/);
    if (mm && !number && /\d/.test(mm[1])) { number = mm[1].toUpperCase(); total = mm[2] ? mm[2].replace(/\D/g, '') : null; }
    else rest.unshift(tokens[i]);
  }
  restText = rest.join(' ');
  const name = restText;
  const d = { name: name || null, number, setTotal: total, setName };

  const nums = numVariants(number);
  const parts = [];
  if (name) name.split(/\s+/).map(luceneWord).filter(w => w.length >= 2 && !['and', 'the'].includes(w)).forEach(w => parts.push(`name:${w}*`));
  if (nums.length) parts.push(`(${nums.map(n => `number:"${n}"`).join(' OR ')})`);
  if (setName) parts.push(`set.name:"${setName.replace(/"/g, '')}"`);
  if (total) parts.push(`set.printedTotal:${total}`);

  const ptcgSearch = async () => {
    if (!parts.length) return [];
    const res = await ptcgQuery(parts.join(' '), 30, '-set.releaseDate');
    if (res.length || !setName) return res;
    // Set names differ between catalogs ("Base Set" vs "Base"), so retry without the set filter.
    const loose = parts.filter(p => !p.startsWith('set.name:'));
    if (!loose.length) return [];
    return (await ptcgQuery(loose.join(' '), 60, '-set.releaseDate')).filter(c => similarity(setName, c.set?.name) >= 0.5 || (total && c.set?.printedTotal === +total));
  };
  const [pcR, dexR] = await Promise.allSettled([
    ptcgSearch(),
    name ? dexCandidates({ ...d, name: keyWord(name) || name }, 10) : Promise.resolve([]),
  ]);
  let dexCards = dexR.value || [];
  if (name) {
    const words = name.split(/\s+/).filter(w => w.length >= 2);
    dexCards = dexCards.filter(c => words.every(w => normName(c.name).includes(normName(w))));
  }
  if (number) dexCards = dexCards.filter(c => numMatch(number, c.localId) > 0);
  if (setName) dexCards = dexCards.filter(c => similarity(setName, c.set?.name) >= 0.5);
  const list = mergeMatches(dexCards, pcR.value || []).map(m => ({ m, score: scoreMatch(m, d) }));
  list.sort((a, b) => b.score - a.score);
  return list.slice(0, 20).map(x => remember(x.m));
}

/* ================= Prices ================= */

function pickDex(card, variant) {
  const p = card?.pricing || {};
  const cm = p.cardmarket;
  const tp = p.tcgplayer;
  const hasNormal = !!card?.variants?.normal;
  const foil = variant === 'reverse' || ((variant === 'holo' || variant === 'firstEdition') && hasNormal);
  const out = {};
  if (cm) {
    const read = useFoil => {
      const k = key => cm[useFoil ? `${key}-holo` : key];
      return { eur: k('trend') ?? k('avg') ?? k('avg30') ?? null, avg30: k('avg30') ?? null, low: k('low') ?? null };
    };
    let r = read(foil);
    if (r.eur == null) r = read(!foil);
    if (r.eur != null) out.dexCm = { ...r, at: cm.updated ? Date.parse(cm.updated) : null };
  }
  if (tp) {
    const keys = Object.keys(tp).filter(k => tp[k] && typeof tp[k] === 'object');
    const prefs = {
      normal: [/^normal$/, /^unlimited$/],
      holo: [/^holo(foil)?$/, /^unlimited-holofoil$/, /holo/],
      reverse: [/reverse/],
      firstEdition: [/^1st-edition-holofoil$/, /^1st-edition/],
    }[variant] || [];
    const key = prefs.map(rx => keys.find(k => rx.test(k))).find(Boolean) || keys[0];
    const usd = key ? tp[key].marketPrice ?? tp[key].midPrice ?? null : null;
    if (usd != null) out.dexTp = { usd, key, at: tp.updated ? Date.parse(tp.updated) : null };
  }
  return out;
}

const ptcgDate = s => (s ? Date.parse(String(s).replace(/\//g, '-')) || null : null);

function pickPtcg(pc, variant) {
  const out = {};
  const prices = pc?.tcgplayer?.prices;
  if (prices) {
    const keys = Object.keys(prices).filter(k => prices[k]);
    const prefs = {
      normal: ['normal', 'unlimited', 'unlimitedNormal'],
      holo: ['holofoil', 'unlimitedHolofoil'],
      reverse: ['reverseHolofoil'],
      firstEdition: ['1stEditionHolofoil', '1stEditionNormal', '1stEdition'],
    }[variant] || [];
    const key = prefs.find(k => prices[k]) || (keys.length === 1 ? keys[0] : null) || keys.find(k => k === 'holofoil') || keys[0];
    const e = key ? prices[key] : null;
    const usd = e ? e.market ?? e.mid ?? null : null;
    if (usd != null) out.tp = { usd, low: e.low ?? null, key, at: ptcgDate(pc.tcgplayer.updatedAt), url: pc.tcgplayer.url || null };
  }
  const cp = pc?.cardmarket?.prices;
  if (cp) {
    const rev = variant === 'reverse';
    const eur = rev ? cp.reverseHoloTrend || cp.reverseHoloSell : cp.trendPrice || cp.averageSellPrice;
    if (eur) {
      out.cm = {
        eur,
        avg30: (rev ? cp.reverseHoloAvg30 : cp.avg30) || null,
        low: (rev ? cp.reverseHoloLow : cp.lowPrice) || null,
        at: ptcgDate(pc.cardmarket.updatedAt),
        url: pc.cardmarket.url || null,
      };
    }
  }
  return out;
}

function pcEntries(rec) {
  const out = {};
  const x = rec?.pcx;
  if (!x?.found || !x.prices) return out;
  if (x.prices.ungraded != null) out.pcRaw = { usd: x.prices.ungraded, at: x.at, url: x.url };
  if (rec.grade && x.prices[rec.grade] != null) out.pcGrade = { usd: x.prices[rec.grade], key: rec.grade, at: x.at, url: x.url };
  return out;
}

function snapshot(m, variant, rec) {
  return {
    at: Date.now(),
    src: {
      ...(m?.dex ? pickDex(m.dex, variant) : {}),
      ...(m?.pc ? pickPtcg(m.pc, variant) : {}),
      ...pcEntries(rec),
    },
  };
}

function sourcesOf(snap) {
  if (!snap) return {};
  if (snap.src) return snap.src;
  const out = {};
  if (snap.eur != null) out.dexCm = { eur: snap.eur, avg30: snap.eur30 ?? null, low: snap.eurLow ?? null, at: snap.cmAt ? Date.parse(snap.cmAt) : null };
  if (snap.usd != null) out.dexTp = { usd: snap.usd, key: snap.tpKey, at: snap.tpAt ? Date.parse(snap.tpAt) : null };
  return out;
}

function sourceOrder() {
  if (settings.basis === 'cardmarket') return ['cm', 'pcRaw', 'tp', 'dexCm', 'dexTp'];
  if (settings.basis === 'tcgplayer') return ['tp', 'pcRaw', 'cm', 'dexCm', 'dexTp'];
  return ['pcRaw', 'cm', 'tp', 'dexCm', 'dexTp'];
}

function chosenSource(snap, rec) {
  const src = sourcesOf(snap);
  const has = k => src[k] && entryEUR(src[k]) != null;
  if (rec?.grade && has('pcGrade')) return 'pcGrade';
  if (rec?.source && has(rec.source)) return rec.source;
  const order = sourceOrder();
  const fresh = k => has(k) && !(k === 'cm' && src.cm.at && Date.now() - src.cm.at > CM_STALE_MS);
  return order.find(fresh) || order.find(has) || null;
}

function valueEUR(snap, rec) {
  const k = chosenSource(snap, rec);
  return k ? entryEUR(sourcesOf(snap)[k]) : null;
}

function pushHistory(rec, snap) {
  rec.last = snap;
  const h = (rec.history ||= []);
  const prev = h[h.length - 1];
  if (prev && new Date(prev.at).toDateString() === new Date(snap.at).toDateString()) h[h.length - 1] = snap;
  else h.push(snap);
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
}

function gradeFromDetected(d) {
  if (!d?.graded || !d.grade) return null;
  const g = parseFloat(String(d.grade).replace(',', '.'));
  if (g >= 10) return 'psa10';
  if (g >= 9.5) return 'grade9_5';
  if (g >= 9) return 'grade9';
  if (g >= 8) return 'grade8';
  if (g >= 7) return 'grade7';
  return null;
}

function applyMatch(rec, m, variant) {
  Object.assign(rec, {
    tcgdexId: m.dex?.id || null,
    ptcgId: m.pc?.id || null,
    ptcgChecked: true,
    name: M.name(m),
    setName: M.setName(m),
    setId: M.setId(m),
    localId: M.number(m),
    setTotal: M.total(m),
    rarity: M.rarity(m),
    image: m.dex?.image || '',
    ptcgImg: m.pc?.images || null,
    custom: m.custom || null,
    variant,
    variants: variantsOf(m),
    source: null,
  });
  if (rec.pcx && rec.pcx.forKey !== M.key(m)) rec.pcx = null;
  const snap = snapshot(m, variant, rec);
  rec.first = snap;
  rec.last = snap;
  rec.history = [snap];
  return rec;
}

function makeRecord(m, variant, photoId, detected) {
  const rec = { id: uid(), photoId, addedAt: Date.now(), qty: 1, detected: detected || null, grade: gradeFromDetected(detected), pcx: null };
  return applyMatch(rec, m, variant);
}

function recMatch(rec, dex, pc) {
  if (dex || pc) return { dex: dex || null, pc: pc || null, pcChecked: true };
  if (rec.custom) return { custom: rec.custom };
  return null;
}

const cardNumber = c => (c.setTotal ? `${c.localId}/${c.setTotal}` : c.localId);
const recSmall = c => (c.image ? `${c.image}/low.webp` : c.ptcgImg?.small || '');
const recLarge = c => (c.image ? `${c.image}/high.webp` : c.ptcgImg?.large || '');
const recKey = c => (c.tcgdexId ? `dex:${c.tcgdexId}` : c.ptcgId ? `ptcg:${c.ptcgId}` : `custom:${c.custom?.id || c.id}`);

/* ================= Claude ================= */

function apiErrorText(status, msg) {
  if (status === 401) return 'Your API key was rejected. Check it in Settings.';
  if (status === 403) return 'This API key is not allowed to use that model or tool. Try another model in Settings.';
  if (status === 404) return 'That model was not found. Pick another model in Settings.';
  if (status === 429) return 'Too many requests right now. Wait a minute and try again.';
  if (status === 400 && /credit|balance|billing/i.test(msg)) return 'Your Anthropic account is out of credits. Add credits at console.anthropic.com.';
  if (status === 529 || status >= 500) return 'Claude is busy right now. Try again in a moment.';
  return msg || `Request failed (${status}).`;
}

function extractJSON(text) {
  const s = String(text || '').replace(/```json|```/g, '');
  const end = s.lastIndexOf('}');
  for (let i = s.indexOf('{'); i >= 0 && i < end; i = s.indexOf('{', i + 1)) {
    try { return JSON.parse(s.slice(i, end + 1)); } catch { /* try next brace */ }
  }
  throw new Error('Claude answered in an unexpected format. Try again.');
}

async function callClaude({ model, system, content, tools, beta, maxTokens = 1500 }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (beta) headers['anthropic-beta'] = beta;
  let messages = [{ role: 'user', content }];
  for (let turn = 0; turn < 4; turn++) {
    const body = { model, max_tokens: maxTokens, messages };
    if (system) body.system = system;
    if (tools) body.tools = tools;
    let res;
    try {
      res = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch {
      throw new Error('Could not reach Claude. Check your internet connection.');
    }
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error?.message || ''; } catch { /* no body */ }
      const err = new Error(apiErrorText(res.status, msg));
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (data.stop_reason === 'pause_turn') {
      messages = [...messages, { role: 'assistant', content: data.content }];
      continue;
    }
    return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  throw new Error('Claude took too long. Try again.');
}

const imageBlock = data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });

async function identify(b64) {
  const text = await callClaude({
    model: settings.model,
    system: SYSTEM_PROMPT,
    maxTokens: 2500,
    content: [imageBlock(b64), { type: 'text', text: 'Identify every Pokémon card in this photo. Reply with the JSON object only.' }],
  });
  const json = extractJSON(text);
  return Array.isArray(json.cards) ? json.cards : [];
}

function describeDetected(d) {
  const num = d.number ? ` ${d.number}${d.setTotal ? `/${d.setTotal}` : ''}` : '';
  const bits = [`${d.name || 'unknown name'}${num}`];
  if (d.setName) bits.push(d.setName);
  if (d.setCode) bits.push(`set code ${d.setCode}`);
  if (d.language && !/^en/i.test(d.language)) bits.push(`${d.language} card`);
  return bits.join(', ');
}

async function confirmMatch(b64, d, cands) {
  const content = [
    imageBlock(b64),
    { type: 'text', text: `Look at the card at "${d.position || 'the card'}" in this photo (it was read as ${describeDetected(d)}). Which catalog card below is exactly that printing? Compare the artwork, set symbol, card number and rarity.` },
  ];
  cands.forEach((c, i) => {
    content.push({ type: 'text', text: `Candidate ${i + 1}: ${matchLabel(c.m)}${M.rarity(c.m) ? `, ${M.rarity(c.m)}` : ''}` });
    const url = M.imgSmall(c.m);
    if (url) content.push({ type: 'image', source: { type: 'url', url } });
  });
  content.push({ type: 'text', text: 'Reply with JSON only: {"choice": <candidate number, or 0 if none match>}' });
  const text = await callClaude({ model: settings.model, content, maxTokens: 200 });
  const n = Number(extractJSON(text).choice);
  return Number.isInteger(n) && n >= 0 && n <= cands.length ? n : 0;
}

async function webIdentify(b64, d) {
  const content = [];
  if (b64) content.push(imageBlock(b64));
  content.push({
    type: 'text',
    text: `A Pokémon card could not be found in the card catalogs I use. ${b64 ? `It is the card at "${d.position || 'the card'}" in this photo. ` : ''}It was read as: ${describeDetected(d)}.
Search the web to identify the exact printing (English name, set, collector number). Prefer sources such as pricecharting.com, tcgplayer.com, cardmarket.com, bulbapedia.bulbagarden.net or pkmncards.com.
Reply with JSON only: {"found":true,"name":string,"setName":string,"number":string,"setTotal":string|null,"language":string,"source":string} or {"found":false,"reason":string}`,
  });
  const text = await callClaude({
    model: settings.lookupModel,
    beta: WEB_FETCH_BETA,
    maxTokens: 1200,
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2, max_content_tokens: 8000 },
    ],
    content,
  });
  return extractJSON(text);
}

/* ================= PriceCharting (read by Claude) ================= */

function pcSearchQuery(rec) {
  const name = String(rec.name || '').replace(/[-–]/g, ' ').replace(/[^\p{L}\p{N}' .&]/gu, ' ').replace(/\s+/g, ' ').trim();
  const num = String(rec.localId || '').replace(/^([A-Za-z]*)0+(?=\d)/, '$1');
  const lang = rec.detected?.language && !/^en/i.test(rec.detected.language) ? ` ${rec.detected.language}` : '';
  return `${name} ${num}${lang}`.trim();
}
const pcSearchUrl = q => `https://www.pricecharting.com/search-products?type=prices&q=${encodeURIComponent(q).replace(/%20/g, '+')}`;

async function lookupPriceCharting(rec) {
  const variantNote = rec.variant === 'reverse' ? 'This is the REVERSE HOLO printing (PriceCharting lists it as a separate item marked [Reverse Holo]).'
    : rec.variant === 'firstEdition' ? 'This is the 1ST EDITION printing (PriceCharting marks it [1st Edition]).'
      : 'This is the regular printing, not [Reverse Holo] and not [1st Edition].';
  const lang = rec.detected?.language && !/^en/i.test(rec.detected.language) ? rec.detected.language : 'English';
  const known = rec.pcx?.found && rec.pcx.url;
  const steps = known
    ? `Fetch this PriceCharting product page directly: ${rec.pcx.url}`
    : `Step 1: fetch this PriceCharting search page: ${pcSearchUrl(pcSearchQuery(rec))}
Step 2: in the results, pick the item that is exactly this card (same name, same number "#${rec.localId}", same set; ${lang} version) and fetch its product page (links look like https://www.pricecharting.com/game/...). If the search page already shows a single product page, use it. If nothing matches, try one more search with just the Pokémon name and set name.`;
  const text = await callClaude({
    model: settings.lookupModel,
    beta: WEB_FETCH_BETA,
    maxTokens: 700,
    tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: known ? 1 : 3, max_content_tokens: 12000, allowed_domains: ['pricecharting.com'] }],
    system: 'You read Pokémon card prices from PriceCharting.com using the web_fetch tool. Reply with JSON only.',
    content: [{
      type: 'text',
      text: `Card: ${rec.name}, set "${rec.setName}", number ${cardNumber(rec)}, ${lang}. ${variantNote}
${steps}
Step 3: read the price table at the top of the product page: Ungraded, Grade 7, Grade 8, Grade 9, Grade 9.5, PSA 10 (US dollars).
Reply with JSON only:
{"found":true,"url":string,"title":string,"ungraded":number|null,"grade7":number|null,"grade8":number|null,"grade9":number|null,"grade9_5":number|null,"psa10":number|null}
or {"found":false,"reason":string}`,
    }],
  });
  const j = extractJSON(text);
  const num = v => (v == null || v === '' ? null : Number(String(v).replace(/[^0-9.]/g, '')) || null);
  if (!j.found) return { found: false, reason: j.reason || 'Not found', at: Date.now(), forKey: recKey(rec) };
  const prices = {};
  GRADES.forEach(([k]) => { prices[k] = num(j[k]); });
  if (!Object.values(prices).some(v => v != null)) return { found: false, reason: 'No prices on the page', at: Date.now(), forKey: recKey(rec) };
  const url = /^https:\/\/(www\.)?pricecharting\.com\//.test(j.url || '') ? j.url : null;
  return { found: true, url, title: j.title || '', prices, at: Date.now(), forKey: recKey(rec) };
}

function applyPcx(rec, pcx) {
  const hadRaw = !!rec.pcx?.found;
  rec.pcx = pcx;
  const entries = pcEntries(rec);
  const strip = src => { const s = { ...src }; delete s.pcRaw; delete s.pcGrade; return s; };
  rec.last = { ...(rec.last || { at: Date.now() }), src: { ...strip(sourcesOf(rec.last)), ...entries } };
  if (rec.history?.length) rec.history[rec.history.length - 1] = rec.last;
  if (!hadRaw && rec.first) rec.first = { ...rec.first, src: { ...strip(sourcesOf(rec.first)), ...entries } };
}

/* ================= State ================= */

const state = { cards: [], filter: '', refreshing: false };

async function loadCards() {
  state.cards = await dbAll('cards');
}

const cardValue = c => valueEUR(c.last, c);

function firstValue(c) {
  const k = chosenSource(c.last, c);
  return k ? entryEUR(sourcesOf(c.first)[k]) : null;
}

function totals() {
  let total = 0, change = 0, oldest = null;
  for (const c of state.cards) {
    const v = cardValue(c);
    const f = firstValue(c);
    const q = c.qty || 1;
    if (v != null) total += v * q;
    if (v != null && f != null) change += (v - f) * q;
    if (c.last?.at && (oldest == null || c.last.at < oldest)) oldest = c.last.at;
  }
  const count = state.cards.reduce((n, c) => n + (c.qty || 1), 0);
  return { total, change, oldest, count };
}

function sortedCards() {
  const q = normName(state.filter);
  let list = state.cards;
  if (q) list = list.filter(c => normName(`${c.name} ${c.setName} ${c.localId}`).includes(q));
  list = [...list];
  if (settings.sort === 'value') list.sort((a, b) => (cardValue(b) ?? -1) - (cardValue(a) ?? -1));
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
  $('#total').textContent = fmt(state.cards.length ? t.total : 0);
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
    const pc = pcQueue.length + (pcActive ? 1 : 0);
    setMeta(state.cards.length
      ? `${count}, prices checked ${relTime(t.oldest)}${pc ? `, reading PriceCharting for ${pc}…` : ''}`
      : 'No cards yet');
  }
  $('#refreshBtn').hidden = !state.cards.length;
  $('#refreshBtn').disabled = state.refreshing;
}

function pocketHTML(c) {
  const v = cardValue(c);
  const foil = v != null && v >= FOIL_EUR;
  const src = recSmall(c);
  const extra = [c.grade ? GRADE_LABEL[c.grade] : '', c.qty > 1 ? `×${c.qty}` : ''].filter(Boolean).join(' ');
  return `<button class="pocket" type="button" data-id="${esc(c.id)}" aria-label="${esc(`${c.name}, ${c.setName} ${cardNumber(c)}, ${fmt(v)}`)}">
    <span class="card-img">${src ? `<img loading="lazy" src="${esc(src)}" alt="" onerror="this.remove()">` : `<img loading="lazy" data-photo="${esc(c.photoId)}" alt="">`}</span>
    <span class="pocket-name">${esc(c.name)}</span>
    <span class="tag${foil ? ' foil' : ''}">${esc(fmt(v))}${extra ? ` <small>${esc(extra)}</small>` : ''}</span>
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

/* ================= Catalog price refresh ================= */

async function refreshPrices(force = false) {
  if (state.refreshing) return;
  const due = state.cards.filter(c => (c.tcgdexId || c.ptcgId) && (force || !c.ptcgChecked || !c.last || Date.now() - c.last.at > STALE_MS));
  if (!due.length) {
    if (force) toast('Prices are up to date.');
    return;
  }
  state.refreshing = true;
  renderSummary();
  setMeta(`Updating prices for ${due.length} ${due.length === 1 ? 'card' : 'cards'}…`);
  await loadRates();

  const dex = new Map();
  await runPool(due.filter(r => r.tcgdexId), 4, async rec => {
    try { dex.set(rec.id, await getCard(rec.tcgdexId, true)); } catch { /* keep old numbers */ }
  });

  const ptcg = new Map();
  let ptcgOk = true;
  try {
    const known = [...new Set(due.filter(r => r.ptcgId).map(r => r.ptcgId))];
    if (known.length) (await ptcgFetchMany(known)).forEach((v, k) => ptcg.set(k, v));
  } catch { ptcgOk = false; }
  await runPool(due.filter(r => !r.ptcgChecked && r.tcgdexId), 2, async rec => {
    const card = dex.get(rec.id) || await getCard(rec.tcgdexId).catch(() => null);
    if (!card) return;
    try {
      const pc = await findPtcgUncached(card);
      rec.ptcgId = pc?.id || null;
      if (pc) { ptcg.set(pc.id, pc); rec.ptcgImg = pc.images || null; }
      rec.migrate = true;
    } catch { ptcgOk = false; }
  });

  let failed = 0;
  for (const rec of due) {
    const card = dex.get(rec.id) || null;
    const pc = rec.ptcgId ? ptcg.get(rec.ptcgId) || null : null;
    if (!card && !pc) { failed++; continue; }
    const snap = snapshot({ dex: card, pc }, rec.variant, rec);
    const old = sourcesOf(rec.last);
    if (!card && rec.tcgdexId) { if (old.dexCm) snap.src.dexCm = old.dexCm; if (old.dexTp) snap.src.dexTp = old.dexTp; }
    if (rec.ptcgId && !pc) { if (old.tp) snap.src.tp = old.tp; if (old.cm) snap.src.cm = old.cm; }
    if (rec.migrate) {
      rec.first = snap;
      rec.history = [snap];
      rec.last = snap;
      rec.ptcgChecked = true;
      delete rec.migrate;
    } else {
      pushHistory(rec, snap);
    }
    if (card?.image && !rec.image) rec.image = card.image;
    try { await dbPut('cards', rec); } catch { failed++; }
  }

  state.refreshing = false;
  render();
  if (!ptcgOk) toast('TCGplayer prices could not be loaded right now. Showing the last known prices.');
  else if (failed) toast(`${failed} ${failed === 1 ? 'price' : 'prices'} could not be updated. Try again later.`);
}

/* ================= PriceCharting queue ================= */

const pcQueue = [];
let pcActive = null;

function pcStale(rec) {
  return !rec.pcx || Date.now() - rec.pcx.at > PC_STALE_MS;
}

function enqueuePc(recs, force = false) {
  if (!settings.apiKey) return 0;
  let n = 0;
  for (const rec of [].concat(recs)) {
    if (!rec || pcActive === rec.id || pcQueue.includes(rec.id)) continue;
    if (!force && !pcStale(rec)) continue;
    pcQueue.push(rec.id);
    n++;
  }
  if (n) { renderSummary(); runPcQueue(); }
  return n;
}

async function runPcQueue() {
  if (pcActive) return;
  while (pcQueue.length) {
    const id = pcQueue.shift();
    const rec = state.cards.find(c => c.id === id);
    if (!rec) continue;
    pcActive = id;
    if (detailId === id) renderDetail();
    try {
      const pcx = await lookupPriceCharting(rec);
      if (pcx.found || !rec.pcx?.found) applyPcx(rec, pcx);
      else rec.pcx = { ...rec.pcx, checkedAt: Date.now() };
      await dbPut('cards', rec);
    } catch (e) {
      rec.pcxError = e.message;
      if (e.status === 401 || e.status === 429 || /credits/i.test(e.message)) {
        pcQueue.length = 0;
        toast(e.message);
      }
    }
    pcActive = null;
    render();
    if (detailId === id) renderDetail();
  }
  renderSummary();
}

/* ================= Search widget (review + detail) ================= */

function searchFormHTML(value = '', webButton = true) {
  return `<form class="search" data-search>
      <input type="text" name="q" value="${esc(value)}" placeholder="e.g. kyogre 148 or primal clash kyogre" aria-label="Search for a card" required>
      <button class="btn small" type="submit">Search</button>
      ${webButton ? '<button class="btn small" type="button" data-web>Search the web</button>' : ''}
    </form>
    <div class="results" data-results></div>`;
}

function resultHTML(m) {
  const img = M.imgSmall(m);
  return `<button type="button" class="result" data-pick="${esc(M.key(m))}">
    ${img ? `<img loading="lazy" src="${esc(img)}" alt="" onerror="this.remove()">` : '<img alt="">'}
    <span><b>${esc(M.name(m))}</b>${esc(M.setName(m))}${M.number(m) ? `, ${esc(M.number(m))}${M.total(m) ? `/${esc(M.total(m))}` : ''}` : ''}${M.rarity(m) ? `<br>${esc(M.rarity(m))}` : ''}</span>
  </button>`;
}

async function runSearch(form) {
  const q = form.elements.q.value.trim();
  const out = form.nextElementSibling;
  if (!q) return;
  out.innerHTML = '<p class="hint"><span class="spinner"></span>Searching…</p>';
  try {
    const list = await textSearch(q);
    out.innerHTML = list.length
      ? list.map(resultHTML).join('')
      : `<p class="hint">Nothing found for “${esc(q)}”. Try the English name plus the number, or tap Search the web.</p>`;
  } catch {
    out.innerHTML = '<p class="hint">Search failed. Check your connection and try again.</p>';
  }
}

/* ================= Review (after a scan) ================= */

const review = { jobs: [] };

function findDupe(m, variant) {
  const key = M.key(m);
  return state.cards.find(c => recKey(c) === key && c.variant === variant);
}

function detectedLine(d) {
  const conf = d.confidence && d.confidence !== 'high' ? `, ${d.confidence} confidence` : '';
  return `${describeDetected(d)}${d.graded ? `, graded ${d.gradeCompany || ''} ${d.grade || ''}`.replace(/\s+/g, ' ') : ''}${conf}`;
}

function rowHTML(job, row) {
  const cand = row.cands[row.idx];
  const readAs = `<p class="read-as">Read as: ${esc(detectedLine(row.detected))}</p>`;
  const webState = row.web === 'busy'
    ? '<p class="hint"><span class="spinner"></span>Searching the web…</p>'
    : row.webNote ? `<p class="hint">${esc(row.webNote)}</p>` : '';

  if (!cand) {
    const d = row.detected;
    const q = [d.name, d.number].filter(Boolean).join(' ');
    return `<div class="row" data-job="${job.id}" data-row="${row.id}">
      <div class="row-img"></div>
      <div class="row-body">
        <p class="row-name">No catalog match</p>
        ${readAs}
        ${webState}
        ${row.webCard ? `<button type="button" class="btn small" data-add-custom>Add as ${esc(row.webCard.name)}, ${esc(row.webCard.setName || '')} ${esc(row.webCard.number || '')} (priced from PriceCharting)</button>` : ''}
        ${searchFormHTML(q)}
      </div>
    </div>`;
  }

  const m = cand.m;
  if (!m.pcChecked && m.dex) ensureRowPc(job, row, m);
  const ready = m.pcChecked || !m.dex;
  const snap = snapshot(m, row.variant, null);
  const src = chosenSource(snap, null);
  const v = valueEUR(snap, null);
  const priceLine = ready
    ? `${esc(fmt(v))}${src ? ` <span class="row-src">${esc(SOURCE_LABEL[src])}</span>` : ''}${settings.pcAuto ? '<br><span class="row-src">Raw to PSA 10 range is read from PriceCharting after you add the card.</span>' : ''}`
    : '<span class="spinner"></span>Checking price…';
  const dupe = findDupe(m, row.variant);
  const variantOpts = variantsOf(m).map(k => `<option value="${k}"${k === row.variant ? ' selected' : ''}>${VARIANT_LABEL[k]}</option>`).join('');
  const candOpts = row.cands.length > 1
    ? `<select data-cand aria-label="Other matches">${row.cands.map((c, i) => `<option value="${i}"${i === row.idx ? ' selected' : ''}>${esc(M.setName(c.m) || M.name(c.m))} ${esc(M.number(c.m))}</option>`).join('')}</select>`
    : '';
  const img = M.imgSmall(m);

  return `<div class="row${row.include ? '' : ' off'}" data-job="${job.id}" data-row="${row.id}">
    <div class="row-img">${img ? `<img src="${esc(img)}" alt="" onerror="this.remove()">` : ''}</div>
    <div class="row-body">
      <p class="row-name">${esc(M.name(m))}</p>
      <p class="row-sub">${esc(M.setName(m))}, ${esc(M.number(m))}${M.total(m) ? `/${esc(M.total(m))}` : ''}${M.rarity(m) ? `, ${esc(M.rarity(m))}` : ''}</p>
      ${readAs}
      ${row.checked ? '<p class="read-as">Claude compared the photo with the catalog images to pick this one.</p>' : ''}
      ${row.confirming ? '<p class="hint"><span class="spinner"></span>Comparing with catalog images…</p>' : ''}
      <p class="row-price">${priceLine}</p>
      <div class="row-controls">
        <select data-variant aria-label="Variant">${variantOpts}</select>
        ${candOpts}
        <button type="button" class="btn small" data-research>Wrong card</button>
      </div>
      ${row.searching ? `${webState}${row.webCard && !row.webMatched ? `<button type="button" class="btn small" data-add-custom>Add as ${esc(row.webCard.name)} (priced from PriceCharting)</button>` : ''}${searchFormHTML(`${M.name(m)} ${M.number(m)}`)}` : ''}
      ${dupe ? `<p class="dupe">Already in your binder (×${dupe.qty || 1}). Tick below to add one more.</p>` : ''}
      <label class="check"><input type="checkbox" data-include${row.include ? ' checked' : ''}> ${dupe ? 'Add another copy' : 'Add to binder'}</label>
    </div>
  </div>`;
}

async function ensureRowPc(job, row, m) {
  if (m.pcLoading) return;
  m.pcLoading = true;
  await ensurePc(m);
  m.pcLoading = false;
  rerenderRowById(job, row);
}

function jobHTML(job) {
  let status;
  if (job.status === 'reading') status = '<span class="spinner"></span>Reading cards…';
  else if (job.status === 'matching') status = '<span class="spinner"></span>Finding the cards in the catalogs…';
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
  const n = review.jobs.flatMap(j => j.rows).filter(r => r.include && (r.cands[r.idx] || r.customMatch)).length;
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

function rerenderRowById(job, row) {
  const el = document.querySelector(`#reviewBody [data-job="${job.id}"][data-row="${row.id}"]`);
  if (el) rerenderRow(job, row, el);
}

function setRowMatch(row, m, { keepCands = false } = {}) {
  if (!keepCands) row.cands = [{ m, score: 99 }];
  row.idx = keepCands ? row.cands.findIndex(c => c.m === m) : 0;
  row.variant = defaultVariant(m, row.detected.variant);
  row.include = !findDupe(m, row.variant);
  row.searching = false;
}

function needsConfirm(d, cands) {
  if (!settings.confirm || cands.length < 2) return false;
  return cands[0].score - cands[1].score < 3 || d.confidence !== 'high' || numMatch(d.number, M.number(cands[0].m)) < 2;
}

async function buildRow(job, d) {
  let cands = [];
  try { cands = await findCandidates(d); } catch { /* shown as no match */ }
  const row = { id: uid(), detected: d, cands, idx: 0, variant: 'normal', include: false, searching: false };
  if (cands.length) {
    await ensurePc(cands[0].m).catch(() => {});
    row.variant = defaultVariant(cands[0].m, d.variant);
    row.include = !findDupe(cands[0].m, row.variant);
  } else {
    logProblem('no-match', d);
  }
  return row;
}

async function confirmRow(job, row) {
  const top = row.cands.slice(0, 4);
  row.confirming = true;
  rerenderRowById(job, row);
  try {
    const choice = await confirmMatch(job.b64, row.detected, top);
    if (choice > 0) {
      const m = top[choice - 1].m;
      row.cands = [top[choice - 1], ...row.cands.filter(c => c !== top[choice - 1])];
      row.idx = 0;
      await ensurePc(m).catch(() => {});
      row.variant = defaultVariant(m, row.detected.variant);
      row.include = !findDupe(m, row.variant);
      row.checked = true;
    }
  } catch { /* keep the automatic pick */ }
  row.confirming = false;
  rerenderRowById(job, row);
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
  const jobs = files.map(f => ({ id: uid(), file: f, blob: null, b64: '', url: URL.createObjectURL(f), status: 'reading', rows: [], error: '' }));
  review.jobs.push(...jobs);
  renderReview();
  loadRates();

  for (const job of jobs) {
    if (!review.jobs.includes(job)) continue;
    try {
      job.blob = await downscale(job.file);
      job.b64 = await blobToBase64(job.blob);
      const detected = await identify(job.b64);
      if (!review.jobs.includes(job)) continue;
      job.status = 'matching';
      renderReview();
      job.rows = await Promise.all(detected.map(d => buildRow(job, d)));
      job.status = 'done';
    } catch (e) {
      job.status = 'error';
      job.error = e.message || 'Something went wrong reading this photo.';
    }
    if (!review.jobs.includes(job)) continue;
    renderReview();
    job.rows.filter(r => needsConfirm(r.detected, r.cands)).forEach(r => confirmRow(job, r));
  }
}

async function webSearchRow(job, row) {
  row.web = 'busy';
  row.webNote = '';
  rerenderRowById(job, row);
  try {
    const r = await webIdentify(job.b64, row.detected);
    if (!r.found) {
      row.webNote = `The web search could not identify it${r.reason ? `: ${r.reason}` : ''}.`;
    } else {
      const d2 = { ...row.detected, name: r.name, setName: r.setName, number: r.number, setTotal: r.setTotal, setCode: null, alternatives: [] };
      const cands = await findCandidates(d2);
      logProblem('web-search', row.detected, { web: r, matched: cands.length ? matchLabel(cands[0].m) : null });
      if (cands.length) {
        row.cands = cands;
        row.idx = 0;
        await ensurePc(cands[0].m).catch(() => {});
        row.variant = defaultVariant(cands[0].m, row.detected.variant);
        row.include = !findDupe(cands[0].m, row.variant);
        row.searching = false;
        row.webMatched = true;
        row.webNote = `Found online as ${r.name}, ${r.setName} ${r.number}.`;
      } else {
        row.webCard = { id: uid(), name: r.name, setName: r.setName, number: r.number, setTotal: r.setTotal ? parseInt(r.setTotal, 10) || null : null, language: r.language, source: r.source };
        row.webNote = `Found online as ${r.name}, ${r.setName} ${r.number}, but not in the card catalogs.`;
      }
    }
  } catch (e) {
    row.webNote = e.message || 'The web search failed.';
  }
  row.web = null;
  rerenderRowById(job, row);
}

async function saveReview() {
  let added = 0, bumped = 0;
  const newRecs = [];
  for (const job of review.jobs) {
    const rows = job.rows.filter(r => r.include && (r.cands[r.idx] || r.customMatch));
    if (!rows.length || !job.blob) continue;
    const fresh = [];
    for (const r of rows) {
      const m = r.customMatch || r.cands[r.idx].m;
      const dupe = r.customMatch ? null : findDupe(m, r.variant);
      if (dupe) {
        dupe.qty = (dupe.qty || 1) + 1;
        await dbPut('cards', dupe);
        bumped++;
      } else {
        fresh.push({ r, m });
      }
    }
    if (!fresh.length) continue;
    const photoId = uid();
    await dbPut('photos', { id: photoId, blob: job.blob, addedAt: Date.now() });
    for (const { r, m } of fresh) {
      await ensurePc(m).catch(() => {});
      const rec = makeRecord(m, r.variant, photoId, r.detected);
      await dbPut('cards', rec);
      state.cards.push(rec);
      newRecs.push(rec);
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
  if (settings.pcAuto || newRecs.some(r => r.custom)) enqueuePc(settings.pcAuto ? newRecs : newRecs.filter(r => r.custom));
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
      const m = row.cands[row.idx].m;
      row.variant = defaultVariant(m, row.detected.variant);
      row.include = !findDupe(m, row.variant);
      row.userChanged = true;
      rerenderRow(job, row, rowEl);
    }
  });

  body.addEventListener('click', e => {
    const research = e.target.closest('[data-research]');
    const pick = e.target.closest('[data-pick]');
    const web = e.target.closest('[data-web]');
    const custom = e.target.closest('[data-add-custom]');
    if (research) {
      const { job, row, rowEl } = getRow(research);
      row.searching = !row.searching;
      rerenderRow(job, row, rowEl);
    } else if (pick) {
      const { job, row, rowEl } = getRow(pick);
      const m = matchCache.get(pick.dataset.pick);
      if (!m) return;
      logProblem('picked-by-hand', row.detected, { was: row.cands[row.idx] ? matchLabel(row.cands[row.idx].m) : null, picked: matchLabel(m) });
      setRowMatch(row, m);
      rerenderRow(job, row, rowEl);
      ensureRowPc(job, row, m);
    } else if (web) {
      const { job, row } = getRow(web);
      if (row && row.web !== 'busy') webSearchRow(job, row);
    } else if (custom) {
      const { job, row, rowEl } = getRow(custom);
      if (!row?.webCard) return;
      row.customMatch = { custom: row.webCard };
      row.cands = [{ m: row.customMatch, score: 0 }];
      row.idx = 0;
      row.variant = row.detected.variant || 'normal';
      row.include = true;
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

function sparkSVG(c) {
  const k = chosenSource(c.last, c);
  const pts = (c.history || []).map(h => (k ? entryEUR(sourcesOf(h)[k]) : null)).filter(v => v != null);
  if (pts.length < 2) return '';
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${(i / (pts.length - 1)) * 100},${38 - ((v - min) / span) * 36}`).join(' ');
  return `<div class="spark" aria-label="Price history, ${pts.length} checks">
    <svg viewBox="0 0 100 40" preserveAspectRatio="none"><path d="${d}"/></svg>
    <p class="hint">Lowest ${esc(fmt(min))}, highest ${esc(fmt(max))} over ${pts.length} checks</p>
  </div>`;
}

const TP_KEY_LABEL = k => String(k || '')
  .replace(/^1stEdition/, '1st edition ').replace(/^unlimited/, 'unlimited ')
  .replace(/reverseHolofoil|reverse-holofoil|reverse/i, 'reverse holo')
  .replace(/holofoil|holo$/i, 'holo')
  .replace(/-/g, ' ').trim();

function sourceDetail(k, e) {
  const bits = [];
  if ((k === 'tp' || k === 'dexTp') && e.key) bits.push(TP_KEY_LABEL(e.key));
  if (k === 'pcGrade' && e.key) bits.push(GRADE_LABEL[e.key]);
  if (e.avg30 != null) bits.push(`30-day avg ${fmt(e.avg30)}`);
  if (e.low != null) bits.push(`lowest ${e.usd != null ? fmtMoney(e.low, 'USD') : fmt(e.low)}`);
  if (e.at) bits.push(`updated ${relTime(e.at)}`);
  return bits.join(', ');
}

function ladderHTML(c) {
  const x = c.pcx;
  const busy = pcActive === c.id || pcQueue.includes(c.id);
  const searchLink = `<a href="${esc(pcSearchUrl(pcSearchQuery(c)))}" target="_blank" rel="noopener">search PriceCharting yourself</a>`;
  let body;
  if (busy) {
    body = '<p class="hint"><span class="spinner"></span>Claude is reading the prices on PriceCharting…</p>';
  } else if (x?.found) {
    const rows = GRADES.filter(([k]) => x.prices[k] != null);
    const max = Math.max(...rows.map(([k]) => x.prices[k]));
    const raw = x.prices.ungraded, top = x.prices.psa10;
    body = `<div class="ladder">
      ${rows.map(([k, label]) => {
        const usd = x.prices[k];
        const pct = Math.max(2, (usd / max) * 100);
        const mine = c.grade ? c.grade === k : k === 'ungraded';
        return `<div class="rung${mine ? ' mine' : ''}">
          <span class="rung-label">${esc(label)}</span>
          <span class="rung-bar"><span style="width:${pct.toFixed(1)}%"></span></span>
          <span class="rung-val">${esc(fmt(usdToEur(usd)))}</span>
        </div>`;
      }).join('')}
    </div>
    <p class="hint">The highlighted row is your card${c.grade ? '' : ' (ungraded)'}. Change it under Grade below.</p>
    ${raw && top ? `<p class="hint">A PSA 10 sells for about ${(top / raw).toFixed(top / raw >= 10 ? 0 : 1)}× the ungraded price.</p>` : ''}
    <p class="hint">From eBay sales on <a href="${esc(x.url || pcSearchUrl(pcSearchQuery(c)))}" target="_blank" rel="noopener">PriceCharting</a>${x.title ? ` (${esc(x.title)})` : ''}, read ${esc(relTime(x.at))}. <button type="button" class="text-btn" data-pc>Update</button></p>`;
  } else if (x && !x.found) {
    body = `<p class="hint">Claude could not find this card on PriceCharting${x.reason ? ` (${esc(x.reason)})` : ''}. <button type="button" class="text-btn" data-pc>Try again</button> or ${searchLink}.</p>`;
  } else {
    body = `<p class="hint">${c.pcxError ? `${esc(c.pcxError)} ` : ''}<button type="button" class="btn small" data-pc>Get ungraded to PSA 10 prices</button></p>
      <p class="hint">Claude reads them from PriceCharting. Costs a few US cents per card.</p>`;
  }
  return `<p class="section-title">Ungraded to PSA 10</p>${body}`;
}

async function renderDetail() {
  const c = state.cards.find(x => x.id === detailId);
  if (!c || !$('#detail').open) return;
  const v = cardValue(c);
  const f = firstValue(c);
  const diff = v != null && f != null ? v - f : null;
  const src = sourcesOf(c.last);
  const chosen = chosenSource(c.last, c);
  const keys = ['pcGrade', 'pcRaw', 'tp', 'cm', 'dexCm', 'dexTp'].filter(k => src[k] && entryEUR(src[k]) != null);
  const vals = keys.filter(k => k !== 'pcGrade').map(k => entryEUR(src[k]));
  const disagree = vals.length > 1 && Math.max(...vals) > 2 && Math.max(...vals) / Math.max(Math.min(...vals), 0.01) > 3;
  const photo = await photoURL(c.photoId);
  const usePhoto = (showPhoto || !recLarge(c)) && photo;
  const official = recLarge(c);
  const imgSrc = usePhoto ? photo : official || photo || '';
  const q = encodeURIComponent(`${c.name} ${c.localId}`);
  const tpUrl = src.tp?.url || `https://www.tcgplayer.com/search/pokemon/product?q=${q}`;
  const cmUrl = src.cm?.url || `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(c.name)}`;
  const pcUrl = c.pcx?.found && c.pcx.url ? c.pcx.url : pcSearchUrl(pcSearchQuery(c));
  const variantOpts = (c.variants || ['normal']).map(k => `<option value="${k}"${k === c.variant ? ' selected' : ''}>${VARIANT_LABEL[k]}</option>`).join('');
  const gradeOpts = [['', 'Ungraded (raw)'], ...GRADES.slice(1)].map(([k, l]) => `<option value="${k}"${(c.grade || '') === k ? ' selected' : ''}>${esc(l)}</option>`).join('');

  $('#detailTitle').textContent = c.name;
  $('#detailBody').innerHTML = `
    <div class="detail-top">
      <div>
        <div class="detail-img">${imgSrc ? `<img class="${usePhoto ? '' : 'official'}" src="${esc(imgSrc)}" alt="${usePhoto ? 'Your photo' : esc(c.name)}" onerror="this.remove()">` : ''}</div>
        ${photo && official ? `<button type="button" class="text-btn img-toggle" data-toggle-photo>${usePhoto ? 'Show card image' : 'Show your photo'}</button>` : ''}
      </div>
      <div>
        <p class="detail-value">${esc(fmt(v))}</p>
        <p class="detail-sub">${c.qty > 1 ? `${esc(fmt(v != null ? v * c.qty : null))} for ${c.qty} copies` : c.grade ? `${esc(GRADE_LABEL[c.grade])} value` : 'per card'}</p>
        ${diff != null && Math.abs(diff) >= 0.005 ? `<p class="detail-change ${diff > 0 ? 'up' : 'down'}">${esc(fmt(diff, true))} since you added it</p>` : ''}
        <p class="detail-sub" style="margin-top:12px">${esc(c.setName)}<br>No. ${esc(cardNumber(c))}${c.rarity ? `<br>${esc(c.rarity)}` : ''}${c.custom ? '<br>Not in the card catalogs' : ''}</p>
      </div>
    </div>

    ${ladderHTML(c)}

    <p class="section-title">Prices</p>
    ${keys.length ? `<div class="sources" role="radiogroup" aria-label="Price used for this card's value">
      ${keys.map(k => `<button type="button" class="source${k === chosen ? ' on' : ''}" role="radio" aria-checked="${k === chosen}" data-source="${k}"${k === 'pcGrade' ? ' disabled' : ''}>
        <span class="source-name">${esc(SOURCE_LABEL[k])}<small>${esc(sourceDetail(k, src[k]))}</small></span>
        <span class="source-val">${esc(fmtEntry(src[k]))}</span>
      </button>`).join('')}
    </div>` : '<p class="hint">No prices found for this card yet.</p>'}
    ${disagree ? '<p class="notice">These sources disagree a lot for this card. Tap the price that looks right.</p>' : ''}
    <p class="hint">${c.grade ? 'Graded cards are valued at their PriceCharting grade price.' : c.source ? 'You picked this price for the card. <button type="button" class="text-btn" data-source="auto">Go back to automatic</button>' : 'Tap a price to use it for this card’s value.'}</p>

    ${sparkSVG(c)}
    <p class="hint">Added ${esc(new Date(c.addedAt).toLocaleDateString('sv-SE'))}${f != null ? ` at ${esc(fmt(f))}` : ''}. Checked ${esc(relTime(c.last?.at))}.</p>

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
    <div class="field">
      <label for="detailGrade">Grade</label>
      <select id="detailGrade" data-detail-grade>${gradeOpts}</select>
    </div>

    <div class="links">
      <a class="btn small" href="${esc(pcUrl)}" target="_blank" rel="noopener">PriceCharting</a>
      <a class="btn small" href="${esc(cmUrl)}" target="_blank" rel="noopener">Cardmarket</a>
      <a class="btn small" href="${esc(tpUrl)}" target="_blank" rel="noopener">TCGplayer</a>
    </div>

    <p class="section-title">Wrong card?</p>
    ${searchFormHTML(`${c.name} ${c.localId}`, false)}

    <div class="field" style="margin-top:26px">
      <button type="button" class="btn danger" data-delete>Remove from binder</button>
    </div>`;
}

function openDetail(id) {
  detailId = id;
  showPhoto = false;
  $('#detail').showModal();
  renderDetail();
  const c = state.cards.find(x => x.id === id);
  if (c && settings.pcAuto && c.pcx?.found && pcStale(c)) enqueuePc(c);
}

async function saveDetail(c) {
  await dbPut('cards', c);
  render();
  renderDetail();
}

async function reloadRecMatch(c) {
  const dex = c.tcgdexId ? await getCard(c.tcgdexId, true) : null;
  let pc = null;
  if (c.ptcgId) pc = (await ptcgFetchMany([c.ptcgId]).catch(() => new Map())).get(c.ptcgId) || null;
  else if (dex) pc = await findPtcg(dex);
  return recMatch(c, dex, pc);
}

function wireDetail() {
  const body = $('#detailBody');

  body.addEventListener('click', async e => {
    const c = state.cards.find(x => x.id === detailId);
    if (!c) return;
    if (e.target.closest('[data-toggle-photo]')) {
      showPhoto = !showPhoto;
      renderDetail();
    } else if (e.target.closest('[data-pc]')) {
      c.pcxError = null;
      enqueuePc(c, true);
      renderDetail();
    } else if (e.target.closest('[data-qty]')) {
      c.qty = Math.max(1, (c.qty || 1) + Number(e.target.closest('[data-qty]').dataset.qty));
      await saveDetail(c);
    } else if (e.target.closest('[data-source]')) {
      const k = e.target.closest('[data-source]').dataset.source;
      c.source = k === 'auto' ? null : k;
      await saveDetail(c);
    } else if (e.target.closest('[data-pick]')) {
      const m = matchCache.get(e.target.closest('[data-pick]').dataset.pick);
      if (!m) return;
      await ensurePc(m).catch(() => {});
      logProblem('fixed-in-binder', c.detected, { was: `${c.name}, ${c.setName} ${cardNumber(c)}`, picked: matchLabel(m) });
      applyMatch(c, m, defaultVariant(m, c.detected?.variant));
      await saveDetail(c);
      toast('Card updated.');
      if (settings.pcAuto) enqueuePc(c, true);
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
    const c = state.cards.find(x => x.id === detailId);
    if (!c) return;
    if (e.target.matches('[data-detail-variant]')) {
      const variant = e.target.value;
      const productChanges = [c.variant, variant].some(v => v === 'reverse' || v === 'firstEdition');
      try {
        const m = await reloadRecMatch(c);
        if (productChanges) c.pcx = null;
        if (m) applyMatch(c, m, variant);
        else c.variant = variant;
        await saveDetail(c);
        if (productChanges && settings.pcAuto) enqueuePc(c, true);
      } catch {
        toast('Could not load prices for that variant. Try again.');
      }
    } else if (e.target.matches('[data-detail-grade]')) {
      c.grade = e.target.value || null;
      const entries = pcEntries(c);
      const strip = s => { const o = { ...s }; delete o.pcGrade; return o; };
      c.last = { ...c.last, src: { ...strip(sourcesOf(c.last)), ...(entries.pcGrade ? { pcGrade: entries.pcGrade } : {}) } };
      c.first = { ...c.first, src: { ...strip(sourcesOf(c.first)), ...(entries.pcGrade ? { pcGrade: entries.pcGrade } : {}) } };
      await saveDetail(c);
      if (c.grade && !c.pcx?.found) enqueuePc(c, true);
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
  $('#lookupModel').value = settings.lookupModel;
  $('#currency').value = settings.currency;
  $('#basis').value = settings.basis;
  $('#ptcgKey').value = settings.ptcgKey || '';
  $('#pcAuto').checked = !!settings.pcAuto;
  $('#confirmMatches').checked = !!settings.confirm;
  $('#ratesInfo').textContent = ratesText();
  updateSettingsInfo();
  $('#settings').showModal();
  loadRates().then(() => { $('#ratesInfo').textContent = ratesText(); render(); });
}

async function updateSettingsInfo() {
  const missing = state.cards.filter(c => pcStale(c)).length;
  $('#pcAllInfo').textContent = missing
    ? `${missing} ${missing === 1 ? 'card needs' : 'cards need'} PriceCharting prices. Each costs a few US cents.`
    : 'All cards have recent PriceCharting prices.';
  $('#pcAllBtn').disabled = !missing;
  const log = problemLog();
  $('#logInfo').textContent = log.length ? `${log.length} matching ${log.length === 1 ? 'problem' : 'problems'} saved on this phone.` : 'No matching problems saved.';
  $('#copyLogBtn').disabled = !log.length;
  $('#clearLogBtn').disabled = !log.length;
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

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

function wireSettings() {
  $('#model').innerHTML = MODELS.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('');
  $('#lookupModel').innerHTML = LOOKUP_MODELS.map(([id, label]) => `<option value="${id}">${esc(label)}</option>`).join('');

  $('#apiKey').addEventListener('change', e => { settings.apiKey = e.target.value.trim(); saveSettings(); render(); });
  $('#toggleKey').addEventListener('click', () => {
    const input = $('#apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('#toggleKey').textContent = show ? 'Hide' : 'Show';
  });
  $('#model').addEventListener('change', e => { settings.model = e.target.value; saveSettings(); });
  $('#lookupModel').addEventListener('change', e => { settings.lookupModel = e.target.value; saveSettings(); });
  $('#currency').addEventListener('change', e => { settings.currency = e.target.value; saveSettings(); render(); });
  $('#basis').addEventListener('change', e => { settings.basis = e.target.value; saveSettings(); render(); });
  $('#ptcgKey').addEventListener('change', e => { settings.ptcgKey = e.target.value.trim(); saveSettings(); });
  $('#pcAuto').addEventListener('change', e => { settings.pcAuto = e.target.checked; saveSettings(); });
  $('#confirmMatches').addEventListener('change', e => { settings.confirm = e.target.checked; saveSettings(); });
  $('#pcAllBtn').addEventListener('click', () => {
    const n = enqueuePc(state.cards);
    toast(n ? `Reading PriceCharting for ${n} ${n === 1 ? 'card' : 'cards'} in the background.` : 'Nothing to update.');
    updateSettingsInfo();
  });
  $('#copyLogBtn').addEventListener('click', async () => {
    const ok = await copyText(JSON.stringify(problemLog(), null, 1));
    toast(ok ? 'Copied. Paste it to Claude in the chat.' : 'Copying failed.');
  });
  $('#clearLogBtn').addEventListener('click', () => { localStorage.removeItem(LOG_KEY); updateSettingsInfo(); });
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
    dlg.addEventListener('close', () => { if (dlg.id === 'detail') detailId = null; });
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
