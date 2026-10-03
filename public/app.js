// IOANE News UI. No framework, no build step for JS. All story text is written with
// textContent (never innerHTML): it is LLM-generated from web sources, so it is untrusted.

import { DEFAULT_LANG, LANGS, makeT, plural } from './i18n.js';

const TZ = 'Asia/Tbilisi';
const SLOTS = 288; // 24h in 5-minute slots
const POLL_MS = 30_000;
const DELAYED_AFTER_MS = 12 * 60_000;

const TABS_FALLBACK = ['top10', 'all', 'georgia', 'ai-tech', 'economics', 'crypto', 'marketing', 'real-estate', 'global-trade', 'vc-startups'].map((id) => ({ id }));

const $ = (id) => document.getElementById(id);

const state = {
  lang: DEFAULT_LANG,
  tabs: TABS_FALLBACK,
  tab: 'all',
  date: null, // YYYY-MM-DD, Tbilisi; null = any day
  time: null, // HH:MM, snapped to 5 minutes; null = any time
  articles: [],
  nextBefore: null,
  loading: false,
  error: null,
  meta: null,
  skew: 0, // server clock minus local clock, ms
  seenPublished: null,
  slots: {},
  hover: -1,
};

// ─── DOM helpers ────────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid != null) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : null);

// ─── language ───────────────────────────────────────────────────────────────
let t = makeT(state.lang);
function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(q)) return q;
  try {
    const saved = localStorage.getItem('lang');
    if (LANGS.includes(saved)) return saved;
  } catch {
    /* storage can be blocked; the default applies */
  }
  return DEFAULT_LANG;
}

// ─── time (Asia/Tbilisi) ────────────────────────────────────────────────────
// Intl supplies only the numbers (in Tbilisi time). Month and weekday NAMES come from tables, because
// not every browser ships Georgian locale data and Intl silently falls back to English without it.
const MONTHS = {
  ka: ['იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ', 'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};
const WEEKDAYS = {
  ka: ['კვირა', 'ორშაბათი', 'სამშაბათი', 'ოთხშაბათი', 'ხუთშაბათი', 'პარასკევი', 'შაბათი'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};
const EN_WEEKDAYS = WEEKDAYS.en;
const partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // YYYY-MM-DD

function tbParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: +p.day, month: +p.month, year: +p.year, hour: +p.hour, minute: +p.minute, weekday: EN_WEEKDAYS.indexOf(p.weekday) };
}

function tb(iso) {
  const p = tbParts(Date.parse(iso));
  return {
    time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
    date: `${p.day} ${MONTHS[state.lang][p.month - 1]} ${p.year}`,
    hour: p.hour,
    minute: p.minute,
  };
}

/** "შაბათი, 3 ოქტ" / "Saturday 3 Oct" for a Tbilisi calendar date. */
function longDay(ymd) {
  const p = tbParts(Date.parse(`${ymd}T12:00:00+04:00`));
  const head = WEEKDAYS[state.lang][p.weekday];
  return `${head}${state.lang === 'ka' ? ',' : ''} ${p.day} ${MONTHS[state.lang][p.month - 1]}`;
}
const serverNow = () => Date.now() + state.skew;
const todayTb = () => dayFmt.format(new Date(serverNow()));
const nowSlotIdx = () => {
  const t = tb(new Date(serverNow()).toISOString());
  return t.hour * 12 + Math.floor(t.minute / 5);
};
const toMin = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const snap = (m) => m - (m % 5);
const tapeDate = () => state.date ?? todayTb();

function ago(iso) {
  const s = Math.max(0, (serverNow() - Date.parse(iso)) / 1000);
  if (s < 60) return t('justNow');
  if (s < 3600) return t('minAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('hourAgo', { n: Math.floor(s / 3600) });
  return null;
}

// ─── api ────────────────────────────────────────────────────────────────────
// `fresh` bypasses the browser cache. Used for the meta poll and every explicit refresh, so the
// "new stories" button and the countdown never act on a response that is up to 30s old.
async function api(path, signal, fresh = false) {
  const res = await fetch(path, { signal, cache: fresh ? 'no-store' : 'default', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── URL state ──────────────────────────────────────────────────────────────
function readUrl() {
  const q = new URLSearchParams(location.search);
  const tab = q.get('tab');
  if (tab && state.tabs.some((x) => x.id === tab)) state.tab = tab;
  const date = q.get('date');
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) state.date = date;
  const time = q.get('time');
  if (time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) state.time = fromMin(snap(toMin(time)));
}
function writeUrl() {
  const q = new URLSearchParams();
  if (state.lang !== DEFAULT_LANG) q.set('lang', state.lang);
  if (state.tab !== 'all') q.set('tab', state.tab);
  if (state.date) q.set('date', state.date);
  if (state.time) q.set('time', state.time);
  const s = q.toString();
  history.replaceState(null, '', s ? `?${s}` : location.pathname);
}

// ─── header: live pill ──────────────────────────────────────────────────────
function renderLive() {
  const dot = $('live-dot');
  const text = $('live-text');
  const m = state.meta;
  if (!m) return;
  const last = m.lastRunAt ? Date.parse(m.lastRunAt) : null;
  const next = Date.parse(m.nextRunAt);
  const remaining = Math.max(0, next - serverNow());
  const mm = String(Math.floor(remaining / 60000)).padStart(2, '0');
  const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, '0');
  if (last === null) {
    dot.className = 'size-2 rounded-full bg-slate-500';
    text.textContent = t('liveWaiting');
  } else if (serverNow() - last > DELAYED_AFTER_MS) {
    dot.className = 'size-2 rounded-full bg-amber-500';
    text.textContent = t('liveDelayed', { time: tb(m.lastRunAt).time });
  } else {
    dot.className = 'size-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgb(16_185_129/0.2)] motion-safe:animate-pulse';
    text.textContent = remaining === 0 ? t('liveRunning') : t('liveOk', { mm, ss });
  }
}

async function refreshMeta() {
  try {
    const m = await api('/api/meta', undefined, true);
    state.skew = Date.parse(m.now) - Date.now();
    const prevTabs = state.tabs;
    state.meta = m;
    if (Array.isArray(m.tabs) && m.tabs.length) state.tabs = m.tabs;
    if (prevTabs !== state.tabs) renderTabs();
    if (state.seenPublished === null) state.seenPublished = m.lastPublishedAt;
    $('newbar').hidden = !(m.lastPublishedAt && state.seenPublished && m.lastPublishedAt > state.seenPublished);
    renderLive();
    renderTape();
  } catch {
    $('live-text').textContent = t('liveOffline');
    $('live-dot').className = 'size-2 rounded-full bg-rose-500';
  }
}

// ─── tabs ───────────────────────────────────────────────────────────────────
function renderTabs() {
  const row = $('tabs-row');
  row.replaceChildren(
    ...state.tabs.map((tab) =>
      h(
        'button',
        {
          type: 'button',
          class: 'tab',
          'data-kind': tab.id === 'top10' ? 'top' : null,
          'aria-current': String(tab.id === state.tab),
          onclick: () => selectTab(tab.id),
        },
        tab.id === 'top10' ? svg('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': 'true' }, svg('path', { d: 'm12 2 3 6.5 7 .9-5.1 4.9 1.3 7L12 17.8 5.8 21.3l1.3-7L2 9.4l7-.9z' })) : null,
        t(`tab.${tab.id}`),
        tab.id === 'georgia' ? h('span', { class: 'size-1.5 rounded-full bg-emerald-400', 'aria-hidden': 'true' }) : null,
      ),
    ),
  );
  updateTabFade();
}

function updateTabFade() {
  const row = $('tabs-row');
  const l = row.scrollLeft > 4;
  const r = row.scrollLeft + row.clientWidth < row.scrollWidth - 4;
  row.dataset.fade = l && r ? 'both' : l ? 'left' : r ? 'right' : 'none';
}
$('tabs-row').addEventListener('scroll', updateTabFade, { passive: true });
new ResizeObserver(updateTabFade).observe($('tabs-row'));

function selectTab(id) {
  if (id === state.tab) return;
  state.tab = id;
  renderTabs();
  $('tabs-row').querySelector('[aria-current="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  loadSlots();
  load();
}

// ─── the tape ───────────────────────────────────────────────────────────────
const tape = $('tape');
const tip = $('tape-tip');
let colors = null;
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function slotAt(e) {
  const r = tape.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - r.left, 0), r.width - 0.01);
  return { idx: Math.floor((x / r.width) * SLOTS), x };
}

function renderTape() {
  colors ??= { brand: css('--color-brand'), gold: css('--color-gold'), line: css('--color-line') };
  const dpr = window.devicePixelRatio || 1;
  const w = tape.clientWidth;
  const hgt = tape.clientHeight;
  if (!w || !hgt) return;
  if (tape.width !== Math.round(w * dpr) || tape.height !== Math.round(hgt * dpr)) {
    tape.width = Math.round(w * dpr);
    tape.height = Math.round(hgt * dpr);
  }
  const g = tape.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hgt);

  const day = tapeDate();
  const today = day === todayTb();
  const nowIdx = today ? nowSlotIdx() : Infinity;
  const sel = state.time ? Math.floor(toMin(state.time) / 5) : -1;
  const sw = w / SLOTS;
  const bw = Math.max(1, sw - (sw > 2.2 ? 1 : 0.35));

  // hour gridlines every 3h
  g.fillStyle = colors.line;
  for (let i = 0; i <= 8; i++) g.fillRect(Math.min(Math.round((i * w) / 8), w - 1), 0, 1, hgt);

  if (sel >= 0) {
    g.fillStyle = 'rgba(245,158,11,0.12)';
    g.fillRect(sel * sw - 1, 0, sw + 2, hgt);
  }
  for (let i = 0; i < SLOTS; i++) {
    const n = state.slots[i] || 0;
    const future = i > nowIdx;
    const x = i * sw;
    let bh;
    let fill;
    if (i === sel) {
      bh = hgt;
      fill = colors.gold;
    } else if (n > 0) {
      bh = hgt * [0, 0.45, 0.65, 0.88][Math.min(n, 3)];
      fill = colors.brand;
    } else {
      bh = hgt * (future ? 0.1 : 0.17);
      fill = future ? '#111a2e' : '#334155';
    }
    g.fillStyle = fill;
    g.fillRect(x, hgt - bh, n > 0 || i === sel ? Math.max(2, sw) : bw, bh);
  }
  if (state.hover >= 0 && state.hover !== sel) {
    g.fillStyle = 'rgba(226,232,240,0.9)';
    g.fillRect(state.hover * sw, 0, Math.max(1, bw), hgt);
  }
  if (today && nowIdx < SLOTS) {
    g.fillStyle = colors.brand;
    g.beginPath();
    g.arc(nowIdx * sw + sw / 2, 3.5, 3, 0, Math.PI * 2);
    g.fill();
  }

  // keep the slider semantics in step
  const total = Object.values(state.slots).reduce((a, b) => a + b, 0);
  $('tape-title').textContent = today ? t('tapeToday', { day: longDay(day) }) : longDay(day);
  if (state.time) {
    const m = toMin(state.time);
    tape.setAttribute('aria-valuenow', String(m));
    tape.setAttribute('aria-valuetext', t('tapeValue', { from: fromMin(m), to: fromMin(m + 4) }));
  } else {
    tape.removeAttribute('aria-valuenow');
    tape.setAttribute('aria-valuetext', total ? t('tapeNoneN', { n: total }) : t('tapeNone'));
  }
}

async function loadSlots(fresh = false) {
  const key = `${tapeDate()}|${state.tab === 'top10' ? 'all' : state.tab}`;
  try {
    const j = await api(`/api/slots?date=${tapeDate()}&tab=${state.tab === 'top10' ? 'all' : state.tab}`, undefined, fresh);
    if (key !== `${tapeDate()}|${state.tab === 'top10' ? 'all' : state.tab}`) return; // superseded
    state.slots = j.slots;
  } catch {
    state.slots = {};
  }
  renderTape();
}

let commitTimer = 0;
function setTime(hhmm, { immediate = false, fromTape = false } = {}) {
  state.time = hhmm;
  if (fromTape && hhmm && !state.date) state.date = tapeDate();
  syncInputs();
  renderTape();
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => load(), immediate ? 0 : 160);
}

function syncInputs() {
  $('time').value = state.time ?? '';
  $('date').value = state.date ?? '';
  $('time').dataset.active = String(!!state.time);
  $('date').dataset.active = String(!!state.date);
  $('clear').hidden = !(state.time || state.date);
}

let dragging = false;
tape.addEventListener('pointerdown', (e) => {
  tape.setPointerCapture(e.pointerId);
  dragging = true;
  state.hover = slotAt(e).idx;
  setTime(fromMin(state.hover * 5), { fromTape: true });
});
tape.addEventListener('pointermove', (e) => {
  const { idx, x } = slotAt(e);
  state.hover = idx;
  const n = state.slots[idx] || 0;
  tip.textContent = `${fromMin(idx * 5)} · ${plural(t, 'stories', n)}`;
  tip.classList.remove('hidden');
  tip.style.left = `${Math.min(Math.max(x, 60), tape.clientWidth - 60)}px`;
  if (dragging) setTime(fromMin(idx * 5), { fromTape: true });
  else renderTape();
});
const endDrag = () => {
  if (dragging) {
    dragging = false;
    clearTimeout(commitTimer);
    load();
  }
};
tape.addEventListener('pointerup', endDrag);
tape.addEventListener('pointercancel', endDrag);
tape.addEventListener('pointerleave', () => {
  state.hover = -1;
  tip.classList.add('hidden');
  renderTape();
});
tape.addEventListener('keydown', (e) => {
  const cur = state.time ? toMin(state.time) : snap(nowSlotIdx() * 5);
  const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 60, PageDown: -60 }[e.key];
  if (step !== undefined) setTime(fromMin(Math.min(1435, Math.max(0, cur + step))), { fromTape: true });
  else if (e.key === 'Home') setTime('00:00', { fromTape: true });
  else if (e.key === 'End') setTime('23:55', { fromTape: true });
  else if (e.key === 'Escape' && state.time) setTime(null, { immediate: true });
  else return;
  e.preventDefault();
});
new ResizeObserver(renderTape).observe(tape);

$('time').addEventListener('change', (e) => {
  const v = e.target.value;
  setTime(v ? fromMin(snap(toMin(v))) : null, { immediate: true });
});
$('date').addEventListener('change', (e) => {
  state.date = e.target.value || null;
  syncInputs();
  loadSlots();
  load();
});
$('clear').addEventListener('click', () => {
  state.date = null;
  state.time = null;
  syncInputs();
  loadSlots();
  load();
});
$('when').addEventListener('submit', (e) => e.preventDefault());

// ─── cards ──────────────────────────────────────────────────────────────────
function ring(score) {
  const r = 17;
  const c = 2 * Math.PI * r;
  return svg(
    'svg',
    { width: 48, height: 48, viewBox: '0 0 44 44', role: 'img', 'aria-label': t('trustLabel', { n: score }), class: 'shrink-0' },
    svg('title', {}, t('trustLabel', { n: score })),
    svg('circle', { cx: 22, cy: 22, r, fill: 'none', 'stroke-width': 4, class: 'stroke-slate-800' }),
    svg('circle', { cx: 22, cy: 22, r, fill: 'none', 'stroke-width': 4, 'stroke-linecap': 'round', 'stroke-dasharray': `${(Math.max(0, Math.min(100, score)) / 100) * c} ${c}`, transform: 'rotate(-90 22 22)', class: 'stroke-amber-500' }),
    svg('text', { x: 22, y: 26.5, 'text-anchor': 'middle', class: 'fill-amber-300 font-mono text-[13px] font-semibold' }, String(score)),
  );
}

const section = (label, ...kids) => h('section', {}, h('h3', { class: 'eyebrow mb-2' }, label), ...kids);
const para = (t) => h('p', { class: 'text-pretty text-[15px] leading-relaxed text-slate-300', text: t });

const tierKey = (w) => (w < 2 ? 'social' : w >= 5 ? 'primary' : w >= 4.5 ? 'wire' : w >= 4 ? 'major' : w >= 3.5 ? 'specialist' : w >= 2.5 ? 'commentary' : 'unclassified');

function sourceItem(s) {
  const href = safeHref(s.url);
  return h(
    'li',
    { class: 'flex items-start gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3' },
    h(
      'div',
      { class: 'w-14 shrink-0 pt-0.5', title: t('srcWeight', { n: s.trust_score }) },
      h('p', { class: 'font-mono text-xs font-semibold text-amber-300', text: s.trust_score.toFixed(1) }),
      (() => {
        const bar = h('div', { class: 'mt-1 h-1 overflow-hidden rounded-full bg-slate-800' }, h('div', { class: 'h-full rounded-full bg-amber-500' }));
        bar.firstChild.style.width = `${(Math.min(5, s.trust_score) / 5) * 100}%`;
        return bar;
      })(),
    ),
    h(
      'div',
      { class: 'min-w-0' },
      h('p', { class: 'text-sm font-semibold text-slate-100' }, s.name, h('span', { class: 'font-normal text-slate-500', text: ` · ${t(`tier.${tierKey(s.trust_score)}`)}` })),
      href
        ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'mt-0.5 block truncate text-sm text-emerald-400 underline-offset-2 hover:underline' }, s.title, ' ↗')
        : h('p', { class: 'mt-0.5 truncate text-sm text-slate-500', text: s.title }),
    ),
  );
}

const BREAKDOWN = [['credibility', 40], ['corroboration', 25], ['primaryEvidence', 20], ['claimSupport', 15]];

function breakdownView(a, trust) {
  if (!trust?.breakdown) return h('p', { class: 'text-sm text-slate-500', text: t('scoreNone') });
  const b = trust.breakdown;
  return h(
    'div',
    { class: 'grid gap-2.5' },
    ...BREAKDOWN.map(([key, max]) => {
      const v = Number(b[key] ?? 0);
      const fill = h('div', { class: 'h-full rounded-full bg-amber-500' });
      fill.style.width = `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
      return h(
        'div',
        { class: 'grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1' },
        h('span', { class: 'text-sm text-slate-300', text: t(`bd.${key}`) }),
        h('span', { class: 'font-mono text-xs text-slate-400', text: `${v % 1 ? v.toFixed(1) : v} / ${max}` }),
        h('div', { class: 'col-span-2 h-1.5 overflow-hidden rounded-full bg-slate-800' }, fill),
      );
    }),
    h('p', { class: 'mt-1 font-mono text-xs text-slate-500', text: t('scoreFoot', { n: trust.independentSources ?? '?', score: a.trust_score }) }),
  );
}

const detailCache = new Map(); // `${lang}:${id}` -> detail

function buildPanel(a, id) {
  const slot = h('div', { class: 'text-sm text-slate-500', text: t('scoreLoading') });
  const panel = h(
    'div',
    { id, hidden: true, class: 'mt-5 grid gap-5 border-t border-slate-800 pt-5' },
    section(t('secWhat'), para(a.what_happened)),
    section(t('secWhy'), para(a.why_it_matters)),
    a.figures.length
      ? section(
          t('secFigures'),
          h(
            'dl',
            { class: 'grid gap-2 sm:grid-cols-2' },
            ...a.figures.map((f) =>
              h('div', { class: 'rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2' }, f.label ? h('dt', { class: 'eyebrow', text: f.label }) : null, h('dd', { class: 'mt-0.5 font-mono text-sm text-slate-100', text: f.value })),
            ),
          ),
        )
      : null,
    a.affected_entities.length
      ? section(t('secAffected'), h('ul', { class: 'flex flex-wrap gap-1.5' }, ...a.affected_entities.map((e) => h('li', { class: 'rounded-md bg-slate-800/80 px-2 py-1 text-xs text-slate-300', text: e }))))
      : null,
    section(t('secRisks'), h('div', { class: 'border-l-2 border-amber-500/70 pl-3' }, para(a.risks_uncertainty))),
    section(t('secSources'), h('ul', { class: 'grid gap-2' }, ...a.sources.map(sourceItem))),
    section(t('secScore'), slot),
  );
  panel._slot = slot;
  return panel;
}

async function fillBreakdown(a, panel) {
  if (panel._filled) return;
  panel._filled = true;
  try {
    const key = `${state.lang}:${a.id}`;
    if (!detailCache.has(key)) detailCache.set(key, await api(`/api/articles/${encodeURIComponent(a.id)}?lang=${state.lang}`));
    panel._slot.replaceWith(breakdownView(a, detailCache.get(key).trust));
  } catch (e) {
    panel._filled = false;
    panel._slot.textContent = t('scoreFail', { err: e.message });
  }
}

function card(a, rankMode) {
  const id = `s-${a.id}`;
  const when = tb(a.published_at);
  const rel = ago(a.published_at);
  const panel = buildPanel(a, `${id}-panel`);
  const label = h('span', { text: t('read') });
  const chevron = svg('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', class: 'transition-transform', 'aria-hidden': 'true' }, svg('path', { d: 'm6 9 6 6 6-6' }));
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'mt-4 inline-flex items-center gap-2 rounded-md text-sm font-semibold text-emerald-400 hover:text-emerald-300',
      'aria-expanded': 'false',
      'aria-controls': panel.id,
      onclick: () => {
        const open = panel.hidden;
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', String(open));
        label.textContent = open ? t('hide') : t('read');
        chevron.classList.toggle('rotate-180', open);
        if (open) fillBreakdown(a, panel);
      },
    },
    label,
    chevron,
  );

  const rank = rankMode
    ? h('span', { class: `display w-9 shrink-0 pt-0.5 text-right text-4xl font-extrabold leading-none sm:w-11 sm:text-5xl ${a.rank <= 3 ? 'text-amber-500' : 'text-transparent [-webkit-text-stroke:1.5px_var(--color-gold)]'}`, 'aria-label': t('rank', { n: a.rank }), text: String(a.rank) })
    : null;

  const body = h(
    'div',
    { class: 'min-w-0 flex-1' },
    h(
      'div',
      { class: 'flex items-start gap-3 sm:gap-4' },
      h(
        'div',
        { class: 'min-w-0 flex-1' },
        h(
          'div',
          { class: 'flex flex-wrap items-center gap-1.5' },
          h('span', { class: 'tag bg-slate-800 text-slate-300', text: t(`cat.${a.category}`) }),
          a.georgia_related ? h('span', { class: 'tag bg-emerald-500/15 text-emerald-300' }, h('span', { class: 'size-1.5 rounded-full bg-emerald-400', 'aria-hidden': 'true' }), t('georgiaTag')) : null,
        ),
        h('h2', { id: `${id}-h`, class: 'display mt-2.5 text-balance text-xl font-bold leading-snug text-white sm:text-2xl', text: a.headline }),
      ),
      ring(a.trust_score),
    ),
    h('p', { class: 'mt-3 text-pretty text-[15px] leading-relaxed text-slate-300', text: a.summary }),
    h(
      'p',
      { class: 'mt-4 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-xs text-slate-500' },
      h('time', { datetime: a.published_at, title: t('whenTitle', { date: when.date, time: when.time }), class: 'text-slate-300', text: `${when.time} · ${when.date}` }),
      h('span', { text: t('tbilisi') }),
      rel ? h('span', { text: `· ${rel}` }) : null,
      h('span', { text: `· ${plural(t, 'sources', a.sources.length)}` }),
      a.grammar_checked ? h('span', { class: 'text-emerald-400/80', text: `· ${a.lang === 'ka' ? t('kaChecked') : t('edited')}` }) : null,
      a.fact_checked ? h('span', { class: 'text-emerald-400/80', text: `· ${t('factChecked')}` }) : null,
    ),
    btn,
    panel,
  );

  return h('li', {}, h('article', { class: 'card p-5 sm:p-6', 'aria-labelledby': `${id}-h` }, rank ? h('div', { class: 'flex gap-3 sm:gap-4' }, rank, body) : body));
}

// ─── feed ───────────────────────────────────────────────────────────────────
function skeletons() {
  return Array.from({ length: 3 }, () =>
    h('li', { 'aria-hidden': 'true' }, h('div', { class: 'card grid gap-3 p-6' }, h('div', { class: 'skeleton h-4 w-24 rounded' }), h('div', { class: 'skeleton h-7 w-4/5 rounded' }), h('div', { class: 'skeleton h-4 w-full rounded' }), h('div', { class: 'skeleton h-4 w-2/3 rounded' }))),
  );
}

function emptyView() {
  const filtered = state.time || state.date;
  return h(
    'li',
    {},
    h(
      'div',
      { class: 'rounded-2xl border border-dashed border-slate-700 p-8 text-center' },
      h('p', { class: 'display text-xl font-bold text-white', text: filtered ? t('emptySlotTitle') : t('emptyTitle') }),
      h('p', { class: 'mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-400', text: filtered ? t('emptySlotBody') : t('emptyBody') }),
      filtered ? h('button', { type: 'button', class: 'btn btn-primary mt-5', onclick: () => $('clear').click() }, t('clear')) : null,
    ),
  );
}

function errorView() {
  return h(
    'li',
    {},
    h(
      'div',
      { class: 'rounded-2xl border border-rose-500/40 bg-rose-500/5 p-6 text-center', role: 'alert' },
      h('p', { class: 'display text-lg font-bold text-white', text: t('errTitle') }),
      h('p', { class: 'mt-1 text-sm text-slate-400', text: t('errBody', { err: state.error }) }),
      h('button', { type: 'button', class: 'btn btn-primary mt-4', onclick: () => load({ fresh: true }) }, t('retry')),
    ),
  );
}

function describeFilter() {
  const from = state.time;
  const to = from ? fromMin(toMin(from) + 4) : null;
  if (from && state.date) return t('filterDayTime', { day: longDay(state.date), from, to });
  if (from) return t('filterAnyDayTime', { from, to });
  if (state.date) return longDay(state.date);
  return null;
}

let rendered = 0;
function renderFeed({ append = false } = {}) {
  const feed = $('feed');
  const top = state.tab === 'top10';
  feed.setAttribute('aria-busy', String(state.loading));
  if (state.loading && !append) {
    feed.replaceChildren(...skeletons());
    rendered = 0;
  } else if (state.error && !state.articles.length) {
    feed.replaceChildren(errorView());
    rendered = 0;
  } else if (!state.articles.length) {
    feed.replaceChildren(emptyView());
    rendered = 0;
  } else if (append) {
    state.articles.slice(rendered).forEach((a) => feed.append(card(a, top)));
    rendered = state.articles.length;
  } else {
    feed.replaceChildren(...state.articles.map((a) => card(a, top)));
    rendered = state.articles.length;
  }

  const label = t(`tab.${state.tab}`);
  const f = describeFilter();
  const n = state.articles.length;
  const count = plural(t, 'stories', n).replace(String(n), `${n}${state.nextBefore ? '+' : ''}`);
  $('result').textContent = state.loading && !append ? t('loading') : [top ? t('resultTop') : t('resultCount', { count, tab: label }), f].filter(Boolean).join(' · ');
  $('more').hidden = !state.nextBefore || state.loading;
}

let seq = 0;
let controller = null;
async function load({ append = false, fresh = false } = {}) {
  controller?.abort();
  controller = new AbortController();
  const mine = ++seq;
  state.loading = true;
  state.error = null;
  if (!append) {
    state.articles = [];
    state.nextBefore = null;
  }
  writeUrl();
  syncInputs();
  renderFeed({ append });

  const q = new URLSearchParams({ tab: state.tab, limit: '20', lang: state.lang });
  if (state.date) q.set('date', state.date);
  if (state.time) q.set('time', state.time);
  if (append && state.nextBefore) q.set('before', state.nextBefore);
  try {
    const j = await api(`/api/articles?${q}`, controller.signal, fresh);
    if (mine !== seq) return;
    state.articles = append ? [...state.articles, ...j.articles] : j.articles;
    state.nextBefore = j.nextBefore;
    if (!append) {
      state.seenPublished = state.meta?.lastPublishedAt ?? state.seenPublished;
      $('newbar').hidden = true;
    }
  } catch (e) {
    if (e.name === 'AbortError' || mine !== seq) return;
    state.error = e.message;
  }
  state.loading = false;
  renderFeed({ append: append && !state.error });
}

$('morebtn').addEventListener('click', () => load({ append: true }));
$('newbtn').addEventListener('click', () => {
  loadSlots(true);
  load({ fresh: true });
  scrollTo({ top: 0, behavior: 'smooth' });
});

// ─── language switch ────────────────────────────────────────────────────────
function applyStatic() {
  t = makeT(state.lang);
  document.documentElement.lang = state.lang;
  document.title = t('docTitle');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('docDesc'));
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const b of document.querySelectorAll('#langs [data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === state.lang));
}

function setLang(lang) {
  if (lang === state.lang || !LANGS.includes(lang)) return;
  state.lang = lang;
  try {
    localStorage.setItem('lang', lang);
  } catch {
    /* storage can be blocked; the choice just won't persist */
  }
  applyStatic();
  renderTabs();
  renderLive();
  renderTape();
  load({ fresh: true });
}
for (const b of document.querySelectorAll('#langs [data-lang]')) b.addEventListener('click', () => setLang(b.dataset.lang));

// ─── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  state.lang = pickLang();
  applyStatic();
  readUrl();
  $('date').max = todayTb();
  renderTabs();
  syncInputs();
  renderTape();
  await refreshMeta();
  $('date').max = todayTb();
  readUrl(); // tabs may have been replaced by the server's list
  renderTabs();
  syncInputs();
  loadSlots();
  load();

  setInterval(renderLive, 1000);
  setInterval(() => {
    if (!document.hidden) refreshMeta();
  }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshMeta();
      loadSlots(true);
    }
  });
}
boot();
