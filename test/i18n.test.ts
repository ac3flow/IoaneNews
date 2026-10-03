import { describe, expect, it } from 'vitest';
import indexHtml from '../public/index.html?raw';
import appJs from '../public/app.js?raw';
// @ts-ignore: plain JS module shipped to the browser, no type declarations
import { DICT, makeT, plural } from '../public/i18n.js';
import { TABS } from '../src/api';
import { ARTICLE_CATEGORIES } from '../src/types';

const ka: Record<string, string> = DICT.ka;
const en: Record<string, string> = DICT.en;
const vars = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const entities = (s: string): string => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

describe('UI translations', () => {
  it('Georgian and English define exactly the same keys', () => {
    expect(Object.keys(ka).sort()).toEqual(Object.keys(en).sort());
  });

  it('placeholders match between languages for every key', () => {
    for (const k of Object.keys(en)) expect(vars(ka[k] as string), k).toEqual(vars(en[k] as string));
  });

  it('every Georgian string is Georgian (apart from the brand name)', () => {
    const latinOk = new Set(['docTitle', 'footCopy']);
    for (const [k, v] of Object.entries(ka)) {
      if (latinOk.has(k)) continue;
      if (!v.replace(/\{\w+\}/g, '').match(/\p{L}/u)) continue; // pure template, e.g. '{count} · {tab}'
      expect(/[ა-ჿ]/.test(v), k).toBe(true);
      expect(/[Ა-Ჿ]/.test(v), `${k} uses Mtavruli capitals`).toBe(false);
    }
  });

  it('keys used by the page and the app all exist', () => {
    const used = new Set<string>();
    for (const m of indexHtml.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g)) used.add(m[1] as string);
    for (const m of appJs.matchAll(/\bt\('([^']+)'/g)) used.add(m[1] as string);
    for (const m of appJs.matchAll(/plural\(t, '(\w+)'/g)) {
      used.add(`${m[1]}.one`);
      used.add(`${m[1]}.other`);
    }
    for (const k of used) expect(ka, k).toHaveProperty(k);

    // keys built at runtime
    for (const tab of TABS) expect(ka, `tab.${tab.id}`).toHaveProperty(`tab.${tab.id}`);
    for (const c of ARTICLE_CATEGORIES) expect(ka, `cat.${c}`).toHaveProperty(`cat.${c}`);
    for (const k of ['credibility', 'corroboration', 'primaryEvidence', 'claimSupport', 'penalties']) expect(ka).toHaveProperty(`bd.${k}`);
    for (const k of ['top10', 'all', 'georgia']) expect(ka).toHaveProperty(`tabNote.${k}`);
    for (const k of ['Research', 'Editor', 'Fact', 'Translator']) {
      expect(ka).toHaveProperty(`how${k}`);
      expect(ka).toHaveProperty(`how${k}Label`);
    }
    for (const k of ['primary', 'wire', 'major', 'specialist', 'commentary', 'unclassified', 'social']) expect(ka).toHaveProperty(`tier.${k}`);
  });

  it('the HTML ships Georgian defaults identical to the dictionary (no flash of English, no drift)', () => {
    let checked = 0;
    for (const m of indexHtml.matchAll(/<(\w+)[^>]*\sdata-i18n="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)) {
      expect(norm(entities(m[3] as string)), m[2]).toBe(norm(ka[m[2] as string] as string));
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(2); // the skip link and the no-JavaScript message
    for (const m of indexHtml.matchAll(/data-i18n-aria="([^"]+)"[^>]*aria-label="([^"]*)"/g)) expect(m[2], m[1]).toBe(ka[m[1] as string]);
    expect(indexHtml).toContain('<html lang="ka">');
    expect(indexHtml).toContain(`<title>${ka.docTitle}</title>`);
    expect(indexHtml).toContain(`content="${ka.docDesc}"`);
  });

  it('never shows a "grammar checked" label, in either language', () => {
    const all = JSON.stringify(DICT) + indexHtml + appJs;
    expect(all).not.toContain('გრამატიკა შემოწმებულია');
    expect(all.toLowerCase()).not.toContain('grammar checked');
    expect(all).not.toContain('kaChecked');
  });

  it('translates with placeholders, falls back to English, then to the key', () => {
    const t = makeT('ka');
    expect(t('liveOk', { mm: '04', ss: '09' })).toBe('ცოცხალი · შემდეგი ციკლი 04:09-ში');
    expect(makeT('en')('liveOk', { mm: '04', ss: '09' })).toBe('Live · next run in 04:09');
    expect(makeT('xx')('tab.all')).toBe('ყველა'); // unknown language -> default
    expect(t('does.not.exist')).toBe('does.not.exist');
    expect(t('minAgo')).toContain('{n}'); // unfilled placeholder is left visible, never "undefined"
  });

  it('pluralises English and leaves Georgian invariant', () => {
    expect(plural(makeT('en'), 'stories', 1)).toBe('1 story');
    expect(plural(makeT('en'), 'stories', 3)).toBe('3 stories');
    expect(plural(makeT('ka'), 'stories', 1)).toBe('1 სიახლე');
    expect(plural(makeT('ka'), 'stories', 3)).toBe('3 სიახლე');
  });
});
