import { describe, expect, it } from 'vitest';
import { decodeEntities, normUrl, parseFeed, parsePage, sha, stripHtml } from '../src/pipeline/feeds';
import { clusterItems, sameEvent, tokens } from '../src/pipeline/cluster';

const NOW = Date.parse('2026-10-03T12:00:00Z');

describe('parseFeed', () => {
  it('parses RSS with CDATA, entities, tracking params and dates', () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title><![CDATA[Fed holds rates &amp; signals patience]]></title>
        <link>https://example.com/a?utm_source=x&amp;id=7#frag</link>
        <pubDate>Fri, 02 Oct 2026 14:00:00 GMT</pubDate>
        <description><![CDATA[<p>The Fed said&nbsp;it will <b>wait</b>. &#8220;Patience&#8221; &#x2014; ok</p>]]></description></item>
      <item><title>No link here</title></item>
    </channel></rss>`;
    const items = parseFeed(xml, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      title: 'Fed holds rates & signals patience',
      url: 'https://example.com/a?id=7',
      snippet: 'The Fed said it will wait . “Patience” — ok',
      published: '2026-10-02T14:00:00.000Z',
    });
  });

  it('parses Atom with self-closing alternate links', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <title>Atom story</title>
      <link rel="self" href="https://example.com/self"/>
      <link rel="alternate" type="text/html" href="https://example.com/story/1"/>
      <updated>2026-10-03T08:30:00Z</updated>
      <summary>Short summary</summary></entry></feed>`;
    const [item] = parseFeed(xml, NOW);
    expect(item?.url).toBe('https://example.com/story/1');
    expect(item?.published).toBe('2026-10-03T08:30:00.000Z');
    expect(item?.snippet).toBe('Short summary');
  });

  it('falls back to "now" for missing/invalid dates and ignores non-http links', () => {
    const xml = `<rss><channel>
      <item><title>Undated</title><link>https://example.com/u</link></item>
      <item><title>Bad scheme</title><link>javascript:alert(1)</link></item></channel></rss>`;
    const items = parseFeed(xml, NOW);
    expect(items).toHaveLength(1);
    expect(items[0]?.published).toBe(new Date(NOW).toISOString());
  });

  it('caps items per feed', () => {
    const xml = '<rss><channel>' + Array.from({ length: 50 }, (_, i) => `<item><title>T${i}</title><link>https://e.com/${i}</link></item>`).join('') + '</channel></rss>';
    expect(parseFeed(xml, NOW)).toHaveLength(20);
  });
});

describe('parsePage', () => {
  const html = `<html><body>
    <a href="/en/media/news/applications-now-open-for-barta-2026"><h3>Applications Now Open for BARTA 2026</h3></a>
    <a href="/en/media/news/gross-external-debt-of-geor-64"><h3>Gross External Debt of Georgia</h3><p>Gross external debt statistics are harmonized with BOP statistics.</p></a>
    <a href="/en/media/news/gross-external-debt-of-geor-64">duplicate link text long enough</a>
    <a href="/en/media/news">All news</a>
    <a href="/en/contact">Contact the National Bank</a>
    <a href="https://nbg.gov.ge/en/media/news/memorandum-signed-hungary?utm_source=x">Memorandum Signed Between the Central Banks</a>
  </body></html>`;

  it('extracts only links matching the pattern, resolves and dedupes them', () => {
    const items = parsePage(html, 'https://nbg.gov.ge/en/media/news', '^/en/media/news/[^/?#]+$', NOW);
    expect(items.map((i) => i.url)).toEqual([
      'https://nbg.gov.ge/en/media/news/applications-now-open-for-barta-2026',
      'https://nbg.gov.ge/en/media/news/gross-external-debt-of-geor-64',
      'https://nbg.gov.ge/en/media/news/memorandum-signed-hungary',
    ]);
    expect(items[1]?.title).toContain('Gross External Debt of Georgia');
    expect(items[1]?.snippet).toContain('harmonized with BOP');
    expect(items[0]?.published).toBe(new Date(NOW).toISOString());
  });

  it('skips anchors whose text is too short to be a headline', () => {
    const items = parsePage('<a href="/n/x">More</a>', 'https://e.com', '^/n/', NOW);
    expect(items).toEqual([]);
  });
});

describe('helpers', () => {
  it('normalises URLs', () => {
    expect(normUrl('https://e.com/a/?utm_medium=x&fbclid=1&keep=1#top')).toBe('https://e.com/a?keep=1');
    expect(normUrl('https://e.com/a/')).toBe(normUrl('https://e.com/a'));
    expect(normUrl('https://e.com/')).toBe('https://e.com');
  });

  it('decodes entities and strips html', () => {
    expect(decodeEntities('&lt;b&gt; &amp;amp; &#65;&#x42; &unknown; &#99999999999;')).toBe('<b> &amp; AB &unknown; ');
    expect(stripHtml('<p>a&nbsp;<i>b</i></p>\n  c')).toBe('a b c');
  });

  it('hashes to a stable 32-char id', async () => {
    const h = await sha('https://e.com/a');
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(await sha('https://e.com/a')).toBe(h);
    expect(await sha('https://e.com/b')).not.toBe(h);
  });
});

describe('clusterItems', () => {
  const items = [
    { id: '1', title: 'Fed holds interest rates steady, signals patience on cuts' },
    { id: '2', title: 'Federal Reserve holds rates steady and signals patience' },
    { id: '3', title: 'Nvidia unveils new AI chip for data centers' },
    { id: '4', title: 'Google launches test satellite carrying four TPU chips' },
    { id: '5', title: 'Nvidia unveils next-generation AI chip aimed at data centers' },
    { id: '6', title: 'Peter Thiel buys $130 million Bel-Air estate' },
  ];

  it('groups the same event across publishers and leaves unrelated items alone', () => {
    const groups = clusterItems(items).map((g) => g.map((i) => i.id).sort());
    expect(groups.sort()).toEqual([['1', '2'], ['3', '5'], ['4'], ['6']].sort());
  });

  it('does not merge items that merely share a company name', () => {
    expect(sameEvent(tokens('Nvidia unveils new AI chip'), tokens('Nvidia faces antitrust probe in China'))).toBe(false);
  });

  it('handles empty input', () => {
    expect(clusterItems([])).toEqual([]);
  });
});
