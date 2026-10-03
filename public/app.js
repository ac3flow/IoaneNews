// IOANE News front end. No framework, no build step for JS. Hash routes:
//   #/                 front page        #/t/<tab>[?date=&time=]   a list (Top 10, All, Georgia, topics)
//   #/s/<id>           one whole story   #/about                   how stories are made
// All story text is written with textContent (never innerHTML): it is LLM-generated from web sources.

import { columnChart, hbars, kpiTiles, splitBar, timeline } from './charts.js';
import { coverMarkup } from './covers.js';
import { h, icon } from './dom.js';
import { DEFAULT_LANG, LANGS, makeT, plural } from './i18n.js';

const TZ = 'Asia/Tbilisi';
const POLL_MS = 30_000;
const DELAYED_AFTER_MS = 12 * 60_000;
const PAGE = 20;

const FALLBACK_TABS = ['top10', 'all', 'georgia', 'ai-tech', 'economics', 'crypto', 'marketing', 'real-estate', 'global-trade', 'vc-startups'].map((id) => ({ id }));
const TAB_OF_CATEGORY = { 'AI & Tech': 'ai-tech', Economics: 'economics', Crypto: 'crypto', Marketing: 'marketing', 'Real Estate': 'real-estate', 'Global Trade': 'global-trade', 'VC & Startups': 'vc-startups' };
const CATEGORY_ORDER = ['AI & Tech', 'Economics', 'Crypto', 'Marketing', 'Real Estate', 'Global Trade', 'VC & Startups', 'General'];

const $ = (id) => document.getElementById(id);

// ─── storage (can be blocked; everything works without it) ──────────────────
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

// ─── state ──────────────────────────────────────────────────────────────────
function pickLang() {
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS.includes(q)) return q;
  const saved = store.get('lang');
  return LANGS.includes(saved) ? saved : DEFAULT_LANG;
}

const S = {
  lang: pickLang(),
  theme: store.get('theme'), // 'light' | 'dark' | null (follow the system)
  tabs: FALLBACK_TABS,
  meta: null,
  skew: 0, // server clock minus local clock, ms
  seen: null, // newest published_at the reader has been shown
  newStories: false,
  route: { name: 'home', a: null, q: new URLSearchParams() },
  token: 0,
};
let t = makeT(S.lang);

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
const partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // YYYY-MM-DD

function tbParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { day: +p.day, month: +p.month, year: +p.year, hour: +p.hour, minute: +p.minute, weekday: WEEKDAYS.en.indexOf(p.weekday) };
}
const pad2 = (n) => String(n).padStart(2, '0');

function tb(iso) {
  const p = tbParts(Date.parse(iso));
  const short = `${p.day} ${MONTHS[S.lang][p.month - 1]}`;
  return { time: `${pad2(p.hour)}:${pad2(p.minute)}`, short, date: `${short} ${p.year}`, hour: p.hour };
}

/** "შაბათი, 3 ოქტ" / "Saturday 3 Oct" for a Tbilisi calendar date. */
function longDay(ymd) {
  const p = tbParts(Date.parse(`${ymd}T12:00:00+04:00`));
  return `${WEEKDAYS[S.lang][p.weekday]}${S.lang === 'ka' ? ',' : ''} ${p.day} ${MONTHS[S.lang][p.month - 1]}`;
}

const serverNow = () => Date.now() + S.skew;
const todayTb = () => dayFmt.format(new Date(serverNow()));
const toMin = (hhmm) => +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5);
const fromMin = (m) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const snap = (hhmm) => fromMin(toMin(hhmm) - (toMin(hhmm) % 5));
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s ?? '');
const validTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s ?? '');

function ago(iso) {
  const s = Math.max(0, (serverNow() - Date.parse(iso)) / 1000);
  if (s < 60) return t('justNow');
  if (s < 3600) return t('minAgo', { n: Math.floor(s / 60) });
  if (s < 86400) return t('hourAgo', { n: Math.floor(s / 3600) });
  return null;
}
/** Relative for the last day, otherwise "3 Oct, 14:35". */
const whenText = (iso) => ago(iso) ?? `${tb(iso).short}, ${tb(iso).time}`;
const whenTitle = (iso) => t('whenTitle', { date: tb(iso).date, time: tb(iso).time });
const fmtNum = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);

// ─── api ────────────────────────────────────────────────────────────────────
// `fresh` bypasses both the browser cache and ours. Used for the meta poll and explicit refreshes.
const memo = new Map();
async function api(path, { fresh = false } = {}) {
  const hit = memo.get(path);
  if (!fresh && hit && Date.now() - hit.at < 20_000) return hit.value;
  const res = await fetch(path, { cache: fresh ? 'no-store' : 'default', headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const value = await res.json();
  memo.set(path, { at: Date.now(), value });
  return value;
}
const A = (qs) => `/api/articles?lang=${S.lang}&${qs}`;

// ─── routing ────────────────────────────────────────────────────────────────
function parseRoute() {
  const [path, qs = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: seg[0] || 'home', a: seg[1] ?? null, q: new URLSearchParams(qs) };
}
function go(path) {
  const next = `#${path}`;
  if (location.hash === next) render();
  else location.hash = next;
}
const tabPath = (tab, { date, time } = {}) => {
  // both values are validated, so they need no escaping and the URL stays readable: ?date=2026-10-03&time=14:35
  const q = [validDate(date) ? `date=${date}` : '', validTime(time) ? `time=${time}` : ''].filter(Boolean).join('&');
  return `/t/${tab}${q ? `?${q}` : ''}`;
};
const storyHref = (a) => `#/s/${encodeURIComponent(a.id)}`;

// ─── small view helpers ─────────────────────────────────────────────────────
function catName(c) {
  const v = t(`cat.${c}`);
  return v === `cat.${c}` ? c : v;
}
const tabName = (id) => t(`tab.${id}`);
const safeHref = (u) => (/^https?:\/\//i.test(u) ? u : null);
// A Latin name with a hyphenated Georgian ending ("WTO-მ") must not break after the hyphen. U+2060 is an invisible word joiner.
const tx = (s) => String(s ?? '').replace(/([A-Za-z0-9])-(?=[\u10D0-\u10FF])/g, '$1-\u2060');
const kfOf = (a) => a.figures?.find((f) => /\d/.test(f.value) && f.value.length <= 14)?.value ?? null;

function cover(a, cls = '', { kf = false } = {}) {
  const el = h('div', { class: `media ${cls}`.trim() });
  el.innerHTML = coverMarkup(a.id, a.category); // generated from numbers only, never from story text
  const k = kf ? kfOf(a) : null;
  if (k) el.append(h('span', { class: 'kf', text: k }));
  return el;
}

const trustBadge = (a) => h('span', { class: 'trust', title: t('trustLabel', { n: a.trust_score }) }, icon('shield', 13), t('trust', { n: a.trust_score }));

function uniqueSources(a) {
  const seen = new Set();
  return (a.sources ?? []).filter((s) => safeHref(s.url) && !seen.has(s.name) && seen.add(s.name));
}

function sourceChips(a) {
  const list = uniqueSources(a).slice(0, 4);
  if (!list.length) return null;
  return h(
    'div',
    { class: 'src-line' },
    h('span', { class: 'lbl', text: `${t('secSources')}:` }),
    list.map((s) => h('a', { class: 'src-chip', href: s.url, target: '_blank', rel: 'noopener noreferrer nofollow', title: s.title }, s.name, icon('out', 11))),
  );
}

function rankItem(a, n) {
  return h(
    'a',
    { class: 'rank-item', href: storyHref(a) },
    h('span', { class: 'rank-num', 'aria-hidden': 'true', text: n }),
    h(
      'span',
      { class: 'rank-body' },
      h('span', { class: 'kicker accent', text: catName(a.category) }),
      h('span', { class: 'rank-title' }, h('span', { class: 'link-reveal', text: tx(a.headline) })),
      h('span', { class: 'rank-meta' }, h('span', { text: whenText(a.published_at), title: whenTitle(a.published_at) }), trustBadge(a)),
    ),
  );
}

function listItem(a, rank) {
  const tab = TAB_OF_CATEGORY[a.category] ?? 'all';
  return h(
    'article',
    { class: 't-item' },
    h(
      'div',
      { class: `t-grid${rank ? ' ranked' : ''}` },
      rank ? h('span', { class: 'big-rank', 'aria-hidden': 'true', text: rank }) : null,
      h(
        'div',
        { class: 't-copy' },
        h('a', { class: 'kicker accent', href: `#/t/${tab}`, text: catName(a.category) }),
        h(
          'a',
          { href: storyHref(a) },
          h('span', { class: 't-title balance' }, h('span', { class: 'link-reveal', text: tx(a.headline) })),
          h('span', { class: 't-sum', text: tx(a.summary) }),
          h(
            'span',
            { class: 'meta-line' },
            h('time', { datetime: a.published_at, title: whenTitle(a.published_at), text: whenText(a.published_at) }),
            a.georgia_related ? h('span', { class: 'kicker accent', text: t('georgiaTag') }) : null,
            trustBadge(a),
          ),
        ),
        sourceChips(a),
      ),
      h('a', { class: 't-thumb', href: storyHref(a), tabindex: '-1', 'aria-hidden': 'true' }, cover(a, 'ar-16-10', { kf: true })),
    ),
  );
}

function topicPanel(title, tab, list) {
  return h(
    'div',
    { class: 'panel panel-pad' },
    h('div', { class: 'panel-head' }, h('h2', { text: title }), h('a', { class: 'more-link', href: `#/t/${tab}`, text: `${t('fullList')} →` })),
    h('div', { class: 'rank-list' }, list.length ? list.map((a, i) => rankItem(a, i + 1)) : h('p', { class: 'rank-meta', text: t('emptyTab') })),
  );
}

const shell = (...kids) => h('div', { class: 'shell' }, ...kids);
const skeleton = () => shell(h('div', { class: 'lead-grid' }, h('div', { class: 'skel h1' }), h('div', { class: 'skel h1' })), h('div', { class: 'feat-grid' }, h('div', { class: 'skel h2' }), h('div', { class: 'skel h2' }), h('div', { class: 'skel h2' })));

function emptyBox(title, body, action) {
  return shell(h('div', { class: 'panel empty' }, h('h2', { text: title }), h('p', { text: body }), action ?? null));
}
const retryBtn = () => h('button', { type: 'button', class: 'btn', onclick: () => render(true), text: t('retry') });

// ─── live bar ───────────────────────────────────────────────────────────────
function liveBar() {
  const el = shell(
    h(
      'div',
      { class: 'notice', role: 'status' },
      h('span', { class: 'live-line' }, h('span', { class: 'dot live-dot', 'aria-hidden': 'true' }), h('span', { class: 'live-text', text: t('liveConnecting') })),
      h('button', { type: 'button', class: 'newbtn', hidden: !S.newStories, onclick: showNew, text: t('newBtn') }),
    ),
  );
  queueMicrotask(renderLive);
  return el;
}

function renderLive() {
  const m = S.meta;
  if (!m) return;
  const last = m.lastRunAt ? Date.parse(m.lastRunAt) : null;
  const remaining = Math.max(0, Date.parse(m.nextRunAt) - serverNow());
  let text;
  let cls = 'live';
  if (last === null) {
    text = t('liveWaiting');
    cls = 'late';
  } else if (serverNow() - last > DELAYED_AFTER_MS) {
    text = t('liveDelayed', { time: tb(m.lastRunAt).time });
    cls = 'late';
  } else {
    text = remaining === 0 ? t('liveRunning') : t('liveOk', { mm: pad2(Math.floor(remaining / 60000)), ss: pad2(Math.floor((remaining % 60000) / 1000)) });
  }
  for (const el of document.querySelectorAll('.live-text')) el.textContent = text;
  for (const el of document.querySelectorAll('.live-dot')) el.className = `dot live-dot ${cls}`;
  for (const el of document.querySelectorAll('.newbtn')) el.hidden = !S.newStories;
}

async function refreshMeta() {
  try {
    const m = await api('/api/meta', { fresh: true });
    S.skew = Date.parse(m.now) - Date.now();
    const had = S.tabs !== FALLBACK_TABS;
    S.meta = m;
    if (Array.isArray(m.tabs) && m.tabs.length) S.tabs = m.tabs;
    if (S.seen === null) S.seen = m.lastPublishedAt;
    S.newStories = !!(m.lastPublishedAt && S.seen && m.lastPublishedAt > S.seen);
    if (!had) renderNav();
    renderLive();
  } catch {
    for (const el of document.querySelectorAll('.live-text')) el.textContent = t('liveOffline');
    for (const el of document.querySelectorAll('.live-dot')) el.className = 'dot live-dot off';
  }
}

function showNew() {
  S.seen = S.meta?.lastPublishedAt ?? S.seen;
  S.newStories = false;
  memo.clear();
  render(true);
}

// ─── time search ────────────────────────────────────────────────────────────
function timeBar(tab, q) {
  const date = h('input', { type: 'date', value: validDate(q.get('date')) ? q.get('date') : '' });
  const time = h('input', { type: 'time', step: '300', value: validTime(q.get('time')) ? q.get('time') : '' });
  const active = validDate(q.get('date')) || validTime(q.get('time'));
  return h(
    'form',
    {
      class: 'panel timebar',
      onsubmit: (e) => {
        e.preventDefault();
        go(tabPath(tab, { date: date.value, time: time.value ? snap(time.value) : '' }));
      },
    },
    h('h2', { text: t('tsTitle') }),
    h('label', { class: 'field' }, h('span', { text: t('tsDate') }), date),
    h('label', { class: 'field' }, h('span', { text: t('tsTime') }), time),
    h('button', { type: 'submit', class: 'btn', text: t('tsGo') }),
    active ? h('button', { type: 'button', class: 'btn ghost', onclick: () => go(`/t/${tab}`), text: t('tsClear') }) : null,
    h('p', { class: 'hint', text: t('tsHint') }),
  );
}

function filterText(q) {
  const date = validDate(q.get('date')) ? q.get('date') : null;
  const time = validTime(q.get('time')) ? snap(q.get('time')) : null;
  if (time) return t(date ? 'filterDayTime' : 'filterAnyDayTime', { day: date ? longDay(date) : '', from: time, to: fromMin(toMin(time) + 4) });
  return date ? t('filterDay', { day: longDay(date) }) : null;
}

// ─── dashboard (home) ───────────────────────────────────────────────────────
function dashCard(title, sub, body) {
  return h('div', { class: 'panel dash-card' }, h('h3', { text: title }), sub ? h('p', { class: 'sub', text: sub }) : null, body);
}

function dashboard(stats) {
  if (!stats || !stats.total) return shell(h('section', { class: 'sec' }, h('div', { class: 'sec-head' }, h('h2', { text: t('dashTitle') })), h('p', { class: 'foot-note', text: t('dashNone') })));
  const hours = stats.perHour.map((p) => ({ n: p.n, label: pad2(tb(p.at).hour), tip: `${pad2(tb(p.at).hour)}:00 · ${plural(t, 'stories', p.n)}` }));
  const peak = hours.reduce((p, x) => (x.n > p.n ? x : p), hours[0]);
  const kpi = (v, l) => h('div', { class: 'panel kpi-big' }, h('b', { text: v }), h('span', { text: l }));
  return shell(
    h(
      'section',
      { class: 'sec', 'aria-labelledby': 'dash-h' },
      h('div', { class: 'sec-head' }, h('h2', { id: 'dash-h', text: t('dashTitle') })),
      h(
        'div',
        { class: 'kpi-strip' },
        kpi(String(stats.total), t('kpiTotal')),
        kpi(String(stats.last24h), t('kpiLast24')),
        kpi(stats.avgTrust == null ? '–' : String(stats.avgTrust), t('kpiAvg')),
        kpi(S.meta?.lastPublishedAt ? tb(S.meta.lastPublishedAt).time : '–', t('kpiUpdated')),
      ),
      h(
        'div',
        { class: 'dash-grid' },
        dashCard(t('dashPerHour'), t('dashPerHourNote'), [columnChart(hours, { aria: `${t('dashPerHour')}: ${plural(t, 'stories', stats.last24h)}` }), peak.n > 0 ? h('p', { class: 'foot-note', text: t('peak', { n: peak.n, time: `${peak.label}:00` }) }) : null]),
        dashCard(t('dashByCat'), null, hbars(stats.byCategory.slice(0, 8).map((c) => ({ label: catName(c.category), value: c.n, text: String(c.n) })))),
        dashCard(t('dashTrust'), null, hbars(stats.trustSpread.map((b) => ({ label: b.band, value: b.n, text: String(b.n) })), { firstAccent: false })),
        dashCard(t('dashTiers'), t('dashTiersNote'), stats.sourceTiers.length ? splitBar(stats.sourceTiers.map((x) => ({ label: t(`tier.${x.tier}`), n: x.n, text: String(x.n) }))) : null),
      ),
    ),
  );
}

// ─── views ──────────────────────────────────────────────────────────────────
async function viewHome() {
  const [latest, stats] = await Promise.all([api(A('tab=all&limit=50')), api('/api/stats').catch(() => null)]);
  const list = latest.articles;
  const parts = [liveBar()];

  if (!list.length) {
    parts.push(emptyBox(t('emptyTitle'), t('emptyBody')), dashboard(null));
    return parts;
  }

  // Lead: the most trusted stories of the last day and a half (or of everything, if it is a slow day).
  const fresh = list.filter((a) => serverNow() - Date.parse(a.published_at) < 36 * 3600_000);
  const pool = fresh.length >= 3 ? fresh : list;
  const ranked = [...pool].sort((a, b) => b.trust_score - a.trust_score || (a.published_at < b.published_at ? 1 : -1));
  const [top, ...rest] = ranked;
  const side = rest.slice(0, 3);
  const feats = rest.slice(3, 6);
  const shown = new Set([top, ...side, ...feats]);

  const hero = h(
    'a',
    { class: 'hero', href: storyHref(top) },
    cover(top, 'scrim'),
    h(
      'div',
      { class: 'hero-body' },
      h('div', { class: 'hero-tags' }, h('span', { class: 'pill', text: catName(top.category) }), h('span', { class: 'hero-flag', text: t('topStory') }), trustBadge(top)),
      h('h1', { class: 'balance', text: tx(top.headline) }),
      h('p', { class: 'dek', text: tx(top.summary) }),
      h('div', { class: 'meta-line' }, h('time', { datetime: top.published_at, title: whenTitle(top.published_at), text: whenText(top.published_at) }), h('span', { text: plural(t, 'sources', uniqueSources(top).length) })),
    ),
  );
  parts.push(
    shell(
      h(
        'div',
        { class: `lead-grid${side.length ? '' : ' solo'}` },
        hero,
        side.length
          ? h(
              'aside',
              { class: 'panel panel-pad lead-side' },
              h('div', { class: 'panel-head' }, h('h2', { text: t('alsoTop') })),
              h('div', { class: 'rank-list' }, side.map((a, i) => rankItem(a, i + 2))),
              h('a', { class: 'more-link', href: '#/t/top10', text: `${t('allTop10')} →` }),
            )
          : null,
      ),
      feats.length
        ? h(
            'div',
            { class: 'feat-grid' },
            feats.map((a) =>
              h(
                'a',
                { class: 'feat', href: storyHref(a) },
                cover(a, 'scrim'),
                h('div', { class: 'feat-body' }, h('span', { class: 'pill', text: catName(a.category) }), h('h3', { text: tx(a.headline) }), h('time', { datetime: a.published_at, text: whenText(a.published_at) })),
              ),
            ),
          )
        : null,
    ),
  );

  parts.push(shell(timeBar('all', new URLSearchParams())), dashboard(stats));

  // Latest stories (chronological) beside topic panels.
  const latestRows = list.filter((a) => !shown.has(a)).slice(0, 10);
  const groups = CATEGORY_ORDER.map((c) => ({ c, items: list.filter((a) => a.category === c).sort((a, b) => b.trust_score - a.trust_score).slice(0, 4) })).filter((g) => g.items.length);
  const georgia = list.filter((a) => a.georgia_related).sort((a, b) => b.trust_score - a.trust_score).slice(0, 4);
  if (latestRows.length) {
    parts.push(
      shell(
        h(
          'section',
          { class: 'sec' },
          h('div', { class: 'split-grid' }, h('div', {}, h('div', { class: 'sec-head' }, h('h2', { text: t('latest') }), h('a', { class: 'more-link', href: '#/t/all', text: `${t('allStories')} →` })), latestRows.map((a) => listItem(a))), h('div', { class: 'side-stack' }, georgia.length ? topicPanel(tabName('georgia'), 'georgia', georgia) : null, groups.slice(0, 2).map((g) => topicPanel(catName(g.c), TAB_OF_CATEGORY[g.c] ?? 'all', g.items)))),
        ),
      ),
    );
  }
  const used = latestRows.length ? 2 : 0;
  const more = groups.slice(used);
  if (more.length)
    parts.push(
      shell(h('section', { class: 'sec' }, h('div', { class: 'sec-head' }, h('h2', { text: t('byTopic') })), h('div', { class: 'topic-grid' }, more.map((g) => topicPanel(catName(g.c), TAB_OF_CATEGORY[g.c] ?? 'all', g.items))))),
    );
  return parts;
}

async function viewTab(r) {
  const id = r.a ?? 'all';
  if (!S.tabs.some((x) => x.id === id)) return viewNotFound();
  const date = validDate(r.q.get('date')) ? r.q.get('date') : '';
  const time = validTime(r.q.get('time')) ? snap(r.q.get('time')) : '';
  const base = `tab=${id}&limit=${PAGE}${date ? `&date=${date}` : ''}${time ? `&time=${time}` : ''}`;
  const first = await api(A(base));
  const ranked = id === 'top10';
  const filter = filterText(r.q);
  const isCat = !['top10', 'all', 'georgia'].includes(id);

  const rows = h('div', { class: 'list-wrap' }, first.articles.map((a, i) => listItem(a, ranked ? i + 1 : 0)));
  const holder = h('div', {});
  let cursor = first.nextBefore;
  const more = h('button', { type: 'button', class: 'btn ghost loadmore', text: t('more'), hidden: !cursor });
  more.addEventListener('click', async () => {
    more.disabled = true;
    try {
      const next = await api(A(`${base}&before=${encodeURIComponent(cursor)}`));
      rows.append(...next.articles.map((a) => listItem(a, 0)));
      cursor = next.nextBefore;
      more.hidden = !cursor;
    } catch (e) {
      holder.replaceChildren(h('p', { class: 'foot-note', text: t('errBody', { err: e.message }) }));
    }
    more.disabled = false;
  });

  document.title = `${tabName(id)} · ${t('docTitle')}`;
  return [
    liveBar(),
    shell(
      h('div', { class: 'page-top' }, h('h1', { text: tabName(id) }), h('p', { text: isCat ? t('tabNoteCat', { name: tabName(id) }) : t(`tabNote.${id}`) })),
      timeBar(id, r.q),
      filter ? h('p', { class: 'filter-line' }, h('span', { text: filter }), h('span', { class: 'muted', text: plural(t, 'stories', first.articles.length) })) : null,
      first.articles.length ? [rows, more, holder] : h('div', { class: 'panel empty' }, h('h2', { text: filter ? t('emptySlotTitle') : t('emptyTitle') }), h('p', { text: filter ? t('emptySlotBody') : t('emptyBody') })),
    ),
  ];
}

function breakdownBlock(trust, a) {
  const b = trust?.breakdown;
  if (!b) return null;
  const rows = [
    ['credibility', 40],
    ['corroboration', 25],
    ['primaryEvidence', 20],
    ['claimSupport', 15],
  ].map(([key, max]) => ({ label: t(`bd.${key}`), value: ((b[key] ?? 0) / max) * 100, text: `${b[key] ?? 0} / ${max}` }));
  if (b.penalties < 0) rows.push({ label: t('bd.penalties'), value: -Math.min(100, (Math.abs(b.penalties) / 30) * 100), text: String(b.penalties) });
  return [hbars(rows, { max: 100, firstAccent: false }), h('p', { class: 'foot-note', text: t('scoreFoot', { n: trust.independentSources ?? '?', score: a.trust_score }) })];
}

function vizBlock(title, body, note) {
  return body ? h('div', { class: 'viz-block' }, h('p', { class: 'viz-title' }, h('span', { text: title }), note ? h('small', { text: note }) : null), body) : null;
}

function vizPanel(a, data) {
  const tiles = (a.figures ?? []).filter((f) => f.label && /\d/.test(f.value) && f.value.length <= 18).slice(0, 4);
  const chart = data.chart;
  const events = (data.timeline ?? []).filter((e) => safeHref(e.url));
  return h(
    'section',
    { class: 'panel panel-pad art-viz', 'aria-labelledby': 'viz-h' },
    h('h2', { id: 'viz-h', class: 'h-sm', text: t('vizTitle') }),
    vizBlock(t('vizKey'), tiles.length ? kpiTiles(tiles.map((f) => ({ label: f.label, value: f.value }))) : null),
    chart ? vizBlock(chart.title, hbars(chart.items.map((i) => ({ label: i.label, value: i.value, text: `${fmtNum(i.value)}${chart.unit ? ` ${chart.unit}` : ''}` }))), null) : null,
    vizBlock(t('vizScore'), breakdownBlock(data.trust, a) ?? h('p', { class: 'foot-note', text: t('scoreNone') })),
    events.length ? vizBlock(t('vizTimeline'), timeline(events.map((e) => ({ when: `${tb(e.at).short}, ${tb(e.at).time}`, who: e.name, url: e.url }))), t('vizTimelineNote')) : null,
  );
}

async function viewStory(r) {
  if (!r.a) return viewNotFound();
  let data;
  try {
    data = await api(`/api/articles/${encodeURIComponent(r.a)}?lang=${S.lang}`);
  } catch (e) {
    if (String(e.message).includes('404')) return viewNotFound();
    throw e;
  }
  const a = data.article;
  const tab = TAB_OF_CATEGORY[a.category] ?? 'all';
  const related = (await api(A(`tab=${tab}&limit=6`)).catch(() => ({ articles: [] }))).articles.filter((x) => x.id !== a.id).slice(0, 3);
  const srcs = uniqueSources({ sources: a.sources });
  const paras = a.what_happened.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const indep = data.trust?.independentSources ?? srcs.length;

  document.title = `${a.headline} · ${t('docTitle')}`;
  const about = h(
    'div',
    { class: 'panel panel-pad about art-about' },
    h('p', { class: 'kicker muted', text: t('aboutTitle') }),
    h(
      'dl',
      {},
      h('div', {}, h('dt', { text: t('aboutCategory') }), h('dd', {}, h('a', { href: `#/t/${tab}`, text: catName(a.category) }))),
      h('div', {}, h('dt', { text: t('aboutPublished') }), h('dd', { class: 'tnum', title: whenTitle(a.published_at), text: `${tb(a.published_at).date}, ${tb(a.published_at).time}` })),
      h('div', {}, h('dt', { text: t('aboutTrust') }), h('dd', {}, trustBadge(a))),
      h('div', {}, h('dt', { text: t('aboutIndep') }), h('dd', { class: 'tnum', text: String(indep) })),
      a.fact_checked ? h('div', {}, h('dt', { text: t('aboutFacts') }), h('dd', {}, h('span', { class: 'vbadge' }, icon('check', 14), t('verified')))) : null,
    ),
  );

  const read = h(
    'div',
    { class: 'panel read-panel' },
    h('section', {}, h('h2', { class: 'h-md', text: t('secWhat') }), h('div', { class: 'prose sp-top' }, paras.map((p) => h('p', { text: tx(p) })))),
    h('section', { class: 'sumbox', 'aria-labelledby': 'why-h' }, h('h2', { id: 'why-h', text: t('secWhy') }), h('p', { text: tx(a.why_it_matters) })),
    a.figures.length
      ? h('section', { class: 'block' }, h('h2', { class: 'h-sm', text: t('secFigures') }), h('ul', { class: 'fig-list' }, a.figures.map((f) => (f.label ? h('li', {}, h('span', { text: f.label }), h('b', { text: f.value })) : h('li', { class: 'plain' }, h('b', { text: f.value }))))))
      : null,
    a.affected_entities.length ? h('section', { class: 'block' }, h('h2', { class: 'h-sm', text: t('secAffected') }), h('div', { class: 'chips' }, a.affected_entities.map((e) => h('span', { class: 'chip', text: e })))) : null,
    a.risks_uncertainty ? h('section', { class: 'sumbox risk', 'aria-labelledby': 'risk-h' }, h('h2', { id: 'risk-h', text: t('secRisks') }), h('p', { text: tx(a.risks_uncertainty) })) : null,
    srcs.length
      ? h(
          'section',
          { class: 'block', 'aria-labelledby': 'src-h' },
          h('h2', { id: 'src-h', class: 'h-sm', text: t('secSources') }),
          h('p', { class: 'src-note', text: t('srcNote') }),
          h(
            'ul',
            { class: 'src-list' },
            srcs.map((s) =>
              h(
                'li',
                {},
                h(
                  'a',
                  { class: 'src', href: s.url, target: '_blank', rel: 'noopener noreferrer nofollow' },
                  h('span', {}, h('b', { text: s.name }), h('small', { text: s.title }), h('span', { class: 'src-meta' }, h('span', { text: t(`tier.${s.tier}`) }), h('span', { title: t('srcWeight', { n: s.trust_score }), text: `${s.trust_score} / 5` }))),
                  h('span', { class: 'go' }, t('srcOpen'), icon('out', 15)),
                ),
              ),
            ),
          ),
        )
      : null,
    related.length ? h('section', { class: 'related block', 'aria-labelledby': 'rel-h' }, h('h2', { id: 'rel-h', class: 'h-md', text: t('related') }), related.map((x) => listItem(x))) : null,
  );

  const hero = h(
    'header',
    { class: 'art-hero' },
    cover(a, 'flush'),
    h(
      'div',
      { class: 'shell' },
      h(
        'div',
        { class: 'art-hero-in' },
        h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/', text: t('crumbHome') }), h('span', { 'aria-hidden': 'true', text: '/' }), h('a', { class: 'cur', href: `#/t/${tab}`, text: catName(a.category) })),
        h('h1', { class: 'balance', text: tx(a.headline) }),
        h('p', { class: 'dek', text: tx(a.summary) }),
        h(
          'div',
          { class: 'meta-line' },
          h('time', { class: 'ico', datetime: a.published_at, title: whenTitle(a.published_at) }, icon('clock', 14), `${tb(a.published_at).date}, ${tb(a.published_at).time}`),
          trustBadge(a),
          a.georgia_related ? h('span', { text: t('georgiaTag') }) : null,
          h('span', { text: plural(t, 'sources', srcs.length) }),
        ),
      ),
    ),
  );

  return [h('div', { class: 'progress', 'aria-hidden': 'true' }, h('i', { id: 'prog' })), h('article', {}, hero, shell(h('div', { class: 'art-wrap' }, h('div', { class: 'art-grid' }, read, h('div', { class: 'art-side' }, about, vizPanel(a, data))))))];
}

function viewAbout() {
  document.title = `${t('aboutPageTitle')} · ${t('docTitle')}`;
  const steps = ['Research', 'Editor', 'Fact', 'Translator'].map((k) => [t(`how${k}Label`), t(`how${k}`)]);
  const weights = [['5.0', 'w5'], ['4.5', 'w45'], ['4.0', 'w4'], ['3.5', 'w35'], ['2.5', 'w25'], ['1.0', 'w1']];
  return shell(
    h(
      'div',
      { class: 'page-top' },
      h('h1', { text: t('aboutPageTitle') }),
      h('p', { text: t('aboutPageLead') }),
      h('ol', { class: 'steps' }, steps.map(([label, text]) => h('li', {}, h('b', { text: label }), ' ', text))),
      h('h2', { class: 'h-md sp-top-lg', text: t('aboutWeights') }),
      h('ul', { class: 'weights' }, weights.map(([w, k]) => h('li', {}, h('b', { text: w }), h('span', { text: t(k) })))),
      h('h2', { class: 'h-md sp-top-lg', text: t('howGatesTitle') }),
      h('p', { text: t('howGates') }),
    ),
  );
}

function viewNotFound() {
  return emptyBox(t('notFound'), t('notFoundBody'), h('a', { class: 'btn', href: '#/', text: t('backHome') }));
}

// ─── chrome: header, nav, footer ────────────────────────────────────────────
function wordmark(extra = {}) {
  return h('a', { class: 'wordmark', href: '#/', ...extra }, h('b', { text: 'IOANE' }), h('span', { text: '.News' }));
}

function renderHeader() {
  const other = S.lang === 'ka' ? 'en' : 'ka';
  $('hdr').replaceChildren(
    h(
      'div',
      { class: 'shell' },
      h(
        'div',
        { class: 'hdr-row' },
        wordmark({ 'aria-label': t('brandAria') }),
        h(
          'div',
          { class: 'hdr-tools' },
          h('button', { type: 'button', class: 'search-btn', onclick: openSearch, 'aria-label': t('searchAria') }, icon('search'), h('span', { text: t('searchPlaceholder') }), h('kbd', { text: '/' })),
          h('button', { type: 'button', class: 'icon-btn search-icon', onclick: openSearch, 'aria-label': t('searchAria') }, icon('search')),
          h('button', { type: 'button', class: 'icon-btn lang-btn', onclick: () => setLang(other), 'aria-label': `${t('langAria')}: ${other.toUpperCase()}`, lang: other }, h('i', { class: S.lang === 'ka' ? 'on' : '', text: 'ქარ' }), h('i', { 'aria-hidden': 'true', text: '/' }), h('i', { class: S.lang === 'en' ? 'on' : '', text: 'EN' })),
          h('button', { type: 'button', class: 'icon-btn', onclick: toggleTheme, 'aria-label': t('themeAria') }, icon(isDark() ? 'sun' : 'moon')),
        ),
      ),
    ),
    h('nav', { class: 'nav', 'aria-label': t('navAria') }, h('div', { class: 'shell' }, h('button', { type: 'button', class: 'nav-arrow', 'aria-label': t('navLeft'), onclick: () => scrollNav(-1) }, icon('left', 16)), h('div', { class: 'nav-scroll', id: 'nav-scroll' }), h('button', { type: 'button', class: 'nav-arrow', 'aria-label': t('navRight'), onclick: () => scrollNav(1) }, icon('right', 16)))),
  );
  renderNav();
}

function scrollNav(dir) {
  $('nav-scroll')?.scrollBy({ left: dir * 260 });
}

function renderNav() {
  const box = $('nav-scroll');
  if (!box) return;
  const r = S.route;
  const cur = r.name === 'home' ? 'home' : r.name === 't' ? (r.a ?? 'all') : null;
  box.replaceChildren(h('a', { href: '#/', 'aria-current': cur === 'home' ? 'page' : null, text: t('crumbHome') }), ...S.tabs.map((tab) => h('a', { href: `#/t/${tab.id}`, 'aria-current': cur === tab.id ? 'page' : null, text: tabName(tab.id) })));
  box.querySelector('[aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function renderFooter() {
  $('foot').replaceChildren(
    h(
      'div',
      { class: 'shell' },
      h(
        'div',
        { class: 'foot-grid' },
        h('div', {}, wordmark({ 'aria-label': t('brandAria') }), h('p', { class: 'foot-tag', text: t('footTag') })),
        h(
          'div',
          { class: 'foot-cols' },
          h('div', {}, h('h2', { text: t('footTopics') }), h('ul', {}, S.tabs.map((tab) => h('li', {}, h('a', { href: `#/t/${tab.id}`, text: tabName(tab.id) }))))),
          h('div', {}, h('h2', { text: t('footPages') }), h('ul', {}, h('li', {}, h('a', { href: '#/', text: t('crumbHome') })), h('li', {}, h('a', { href: '#/about', text: t('aboutPageTitle') })))),
        ),
      ),
      h('div', { class: 'foot-base' }, h('span', { text: t('footCopy', { year: new Date().getFullYear() }) }), h('span', { text: t('footTime') })),
    ),
  );
}

// ─── theme and language ─────────────────────────────────────────────────────
const isDark = () => (S.theme ? S.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme() {
  if (S.theme) document.documentElement.setAttribute('data-theme', S.theme);
  else document.documentElement.removeAttribute('data-theme');
}
function toggleTheme() {
  S.theme = isDark() ? 'light' : 'dark';
  store.set('theme', S.theme);
  applyTheme();
  renderHeader();
}

function setLang(lang) {
  if (lang === S.lang) return;
  S.lang = lang;
  t = makeT(lang);
  store.set('lang', lang);
  applyLang();
  renderHeader();
  renderFooter();
  render(true);
}
function applyLang() {
  document.documentElement.lang = S.lang;
  document.title = t('docTitle');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('docDesc'));
  $('skip').textContent = t('skip');
  $('q').placeholder = t('searchPlaceholder');
  $('q').setAttribute('aria-label', t('searchAria'));
  $('modal-close').textContent = t('searchClose');
  $('modal').setAttribute('aria-label', t('searchAria'));
}

// ─── search ─────────────────────────────────────────────────────────────────
let searchTimer = 0;
let searchFrom = null;
function openSearch() {
  searchFrom = document.activeElement;
  $('modal').classList.add('open');
  $('res').replaceChildren(h('p', { class: 'modal-hint', text: t('searchStart') }));
  $('q').value = '';
  $('q').focus();
}
function closeSearch() {
  $('modal').classList.remove('open');
  searchFrom?.focus?.();
}
async function runSearch() {
  const q = $('q').value.trim();
  if (q.length < 2) return $('res').replaceChildren(h('p', { class: 'modal-hint', text: t('searchStart') }));
  try {
    const j = await api(A(`tab=all&limit=8&q=${encodeURIComponent(q)}`));
    if ($('q').value.trim() !== q) return; // superseded by newer typing
    $('res').replaceChildren(
      ...(j.articles.length
        ? j.articles.map((a) => h('a', { href: storyHref(a), onclick: closeSearch }, h('small', { text: `${catName(a.category)} · ${whenText(a.published_at)}` }), h('b', { text: tx(a.headline) })))
        : [h('p', { class: 'modal-hint', text: t('searchNone') })]),
    );
  } catch (e) {
    $('res').replaceChildren(h('p', { class: 'modal-hint', text: t('errBody', { err: e.message }) }));
  }
}
$('q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});
$('modal-close').addEventListener('click', closeSearch);
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) closeSearch();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('modal').classList.contains('open')) return closeSearch();
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
  if ((e.key === '/' && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) {
    e.preventDefault();
    openSearch();
  }
});

// ─── render ─────────────────────────────────────────────────────────────────
const VIEWS = { home: viewHome, t: viewTab, s: viewStory, about: viewAbout };

async function render(keepScroll = false) {
  const r = (S.route = parseRoute());
  const token = ++S.token;
  renderNav();
  document.querySelector('.progress')?.remove();
  const main = $('main');
  main.replaceChildren(skeleton());
  if (!keepScroll) window.scrollTo(0, 0);
  document.title = t('docTitle');
  let out;
  try {
    out = await (VIEWS[r.name] ?? viewNotFound)(r);
  } catch (e) {
    out = emptyBox(t('errTitle'), t('errBody', { err: e.message }), retryBtn());
  }
  if (token !== S.token) return; // a newer navigation took over
  const nodes = [out].flat().filter(Boolean);
  main.replaceChildren(...nodes);
  renderLive();
  onScroll();
}

function onScroll() {
  $('hdr').classList.toggle('stuck', window.scrollY > 4);
  const bar = $('prog');
  if (bar) {
    const doc = document.documentElement;
    const max = doc.scrollHeight - doc.clientHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, window.scrollY / max) : 0})`;
  }
}

// ─── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  applyTheme();
  applyLang();
  S.route = parseRoute();
  renderHeader();
  renderFooter();
  addEventListener('hashchange', () => render());
  addEventListener('scroll', onScroll, { passive: true });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => !S.theme && renderHeader());
  await refreshMeta();
  renderFooter();
  await render();
  setInterval(renderLive, 1000);
  setInterval(refreshMeta, POLL_MS);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refreshMeta());
}
boot();
