// Feed collection helpers. Ported from agent 2's collector (URL normalisation, regex
// RSS/Atom parsing, UA + timeout), hardened for Atom links and numeric entities, and
// extended with an HTML "page" mode for official sites that publish no RSS.

import type { FeedRef } from '../registry/sources';

export interface RawItem {
  title: string;
  url: string;
  snippet: string;
  /** ISO-8601 UTC. For page feeds this is the time the link was first seen. */
  published: string;
}

export const UA = 'Mozilla/5.0 (compatible; IOANE-brief-agent/1.0)';
const FETCH_TIMEOUT_MS = 8000;
// A feed is re-polled every few minutes, so only the newest items can be new. Fewer items = less CPU.
const MAX_ITEMS_PER_FEED = 12;

export async function sha(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

const TRACKING = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'cmpid', 'mc_cid', 'mc_eid'];

export function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of TRACKING) x.searchParams.delete(k);
    x.pathname = x.pathname.replace(/\/+$/, '') || '/';
    return x.toString().replace(/\/$/, '');
  } catch {
    return u;
  }
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };

export function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => safeCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED[name.toLowerCase()] ?? m);
}

function safeCodePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

export function stripHtml(s: string): string {
  let t = decodeEntities(s || ''); // CDATA and one level of entities (markup escaped as &lt;p&gt;)
  t = t.replace(/<[^>]*>/g, ' ');
  if (t.includes('&')) t = decodeEntities(t); // text entities that were nested inside markup
  return t.replace(/\s+/g, ' ').trim();
}

const TAG_RES = new Map<string, RegExp>();
function tag(block: string, name: string): string {
  let re = TAG_RES.get(name);
  if (!re) {
    re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    TAG_RES.set(name, re);
  }
  return re.exec(block)?.[1] ?? '';
}

function linkOf(block: string): string {
  // Atom: prefer rel="alternate" (or no rel), which may be self-closing.
  for (const m of block.matchAll(/<link\b([^>]*?)\/?>/gi)) {
    const attrs = m[1] ?? '';
    const href = /href=["']([^"']+)["']/i.exec(attrs)?.[1];
    const rel = /rel=["']([^"']+)["']/i.exec(attrs)?.[1];
    if (href && (!rel || rel === 'alternate')) return decodeEntities(href);
  }
  // RSS: <link>https://…</link>
  return stripHtml(tag(block, 'link'));
}

// Workers Free allows ~10 ms of CPU per invocation, so parsing must stay cheap: stop scanning after
// MAX_ITEMS_PER_FEED items (OpenAI's feed has >1,000) and clip long bodies before stripping markup.
const RAW_FIELD_CLIP = 2500;
const clipRaw = (s: string): string => (s.length > RAW_FIELD_CLIP ? s.slice(0, RAW_FIELD_CLIP) : s);

export function parseFeed(xml: string, now: number = Date.now()): RawItem[] {
  const out: RawItem[] = [];
  const blocks = /<(item|entry)[\s>][\s\S]*?<\/\1>/gi;
  let m: RegExpExecArray | null;
  for (let n = 0; n < MAX_ITEMS_PER_FEED && (m = blocks.exec(xml)); n++) {
    const b = m[0];
    const title = stripHtml(tag(b, 'title'));
    const link = linkOf(b);
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const dateRaw = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const d = new Date(stripHtml(dateRaw));
    const published = Number.isNaN(d.getTime()) ? new Date(now) : d;
    const snippet = stripHtml(clipRaw(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded') || tag(b, 'content'))).slice(0, 600);
    out.push({ title, url: normUrl(link), snippet, published: published.toISOString() });
  }
  return out;
}

/** HTML listing -> items. An anchor counts when its resolved path matches `pattern`. */
export function parsePage(html: string, pageUrl: string, pattern: string, now: number = Date.now()): RawItem[] {
  const re = new RegExp(pattern);
  const seen = new Set<string>();
  const out: RawItem[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let abs: URL;
    try {
      abs = new URL(decodeEntities(m[1] ?? ''), pageUrl);
    } catch {
      continue;
    }
    if (!re.test(abs.pathname)) continue;
    const url = normUrl(abs.toString());
    const text = stripHtml(m[2] ?? '');
    if (text.length < 15 || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: clip(text, 140), url, snippet: text.slice(0, 600), published: new Date(now).toISOString() });
    if (out.length >= MAX_ITEMS_PER_FEED) break;
  }
  return out;
}

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 30)).trim();
}

/** Fetch and parse one feed. Throws on HTTP/network failure (callers use allSettled). */
export async function fetchFeed(feed: FeedRef, now: number = Date.now()): Promise<RawItem[]> {
  const res = await fetch(feed.url, {
    headers: { 'user-agent': UA, accept: feed.kind === 'rss' ? 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*' : 'text/html,*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  const items = feed.kind === 'rss' ? parseFeed(body, now) : parsePage(body, feed.url, feed.pattern ?? '.', now);
  if (items.length === 0) throw new Error('no items parsed');
  return items;
}
