// Comprehensive source registry + trust hierarchy.
//
// Weights (0–5), from the product spec:
//   5.0  Primary & official  central banks, statistical offices, regulators, ministries, academic journals
//   4.5  Wire services       Reuters, AP
//   4.0  Major financial press
//   3.5  Specialist & tech press, company newsrooms
//   2.5–3.0 Commentary & newsletters
//   1.0–2.0 Social signals   discovery only; need primary confirmation
//
// Sources the spec does not place in a tier were assigned by analogy (exchanges and
// rating agencies 4.0, trade press 3.5, consultancy research 3.0, data aggregators
// 3.0, blogs/newsletters 2.5). Adjust a number here and everything downstream follows.
//
// Not every source can be polled: many have no public feed (Reuters, Bloomberg, AP, ...).
// Those still matter, because the Fact-Checker weighs them when they appear as citations.

import type { ArticleCategory } from '../types';

export type SourceCategoryId =
  | 'global_news' | 'ai_tech' | 'education' | 'economics' | 'georgia' | 'investments' | 'crypto'
  | 'marketing' | 'real_estate' | 'trade' | 'banks' | 'startups' | 'management';

export type TierId = 'primary' | 'wire' | 'major' | 'specialist' | 'commentary' | 'unclassified' | 'social';

export const W = {
  PRIMARY: 5, WIRE: 4.5, MAJOR: 4, SPECIALIST: 3.5, COMMENTARY: 3, NEWSLETTER: 2.5,
  UNCLASSIFIED: 2, SOCIAL: 1.5, X: 1,
} as const;

export const TIER_LABEL: Record<TierId, string> = {
  primary: 'Primary / official',
  wire: 'Wire service',
  major: 'Major press',
  specialist: 'Specialist press',
  commentary: 'Commentary',
  unclassified: 'Unclassified',
  social: 'Social signal',
};

export function tierOf(weight: number, social = false): TierId {
  if (social) return 'social';
  if (weight >= W.PRIMARY) return 'primary';
  if (weight >= W.WIRE) return 'wire';
  if (weight >= W.MAJOR) return 'major';
  if (weight >= W.SPECIALIST) return 'specialist';
  if (weight >= W.NEWSLETTER) return 'commentary';
  return 'unclassified';
}

export interface FeedDef {
  url: string;
  /** 'rss' = RSS/Atom. 'page' = HTML listing; links whose path matches `pattern` become items. */
  kind: 'rss' | 'page';
  pattern?: string;
  hint?: SourceCategoryId;
}

export interface Source {
  id: string;
  name: string;
  weight: number;
  domains: string[];
  aliases: string[];
  feeds: FeedDef[];
  social: boolean;
  georgia: boolean;
}

const rss = (url: string, hint?: SourceCategoryId): FeedDef => ({ url, kind: 'rss', hint });
const page = (url: string, pattern: string, hint?: SourceCategoryId): FeedDef => ({ url, kind: 'page', pattern, hint });

interface Opts { aliases?: string[]; feeds?: FeedDef[]; social?: boolean; georgia?: boolean }
type Def = [name: string, weight: number, domains: string, opts?: Opts];

const slug = (s: string): string => s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const { PRIMARY: P, WIRE, MAJOR: M, SPECIALIST: S, COMMENTARY: C, NEWSLETTER: N, SOCIAL, X } = W;

// ─── Definitions ────────────────────────────────────────────────────────────
// Feeds marked (v) answered with parseable items when probed on 2026-10-03; (a) are the
// ones agent 2 already polls in production. A dead feed never breaks a run: it is
// logged to pipeline_events and skipped.
const DEFS: Def[] = [
  // Wire services
  ['Reuters', WIRE, 'reuters.com', { aliases: ['Reuters RE', 'Reuters Banks', 'Reuters Crypto'] }],
  ['Associated Press', WIRE, 'apnews.com', { aliases: ['AP'] }],

  // Major financial & business press
  ['Bloomberg', M, 'bloomberg.com', { aliases: ['Bloomberg Crypto', 'Bloomberg RE', 'Bloomberg Banks', 'Bloomberg Tech'] }],
  ['Financial Times', M, 'ft.com', { aliases: ['FT', 'FT Property'], feeds: [rss('https://www.ft.com/rss/home', 'global_news')] }], // (v)
  ['Wall Street Journal', M, 'wsj.com', { aliases: ['WSJ'], feeds: [rss('https://feeds.a.dj.com/rss/RSSMarketsMain.xml', 'investments')] }], // (v)
  ['CNBC', M, 'cnbc.com', { feeds: [rss('https://www.cnbc.com/id/20910258/device/rss/rss.html', 'economics'), rss('https://www.cnbc.com/id/15839069/device/rss/rss.html', 'investments')] }], // (a)
  ['The Economist', M, 'economist.com', { aliases: ['Economist Business'], feeds: [rss('https://www.economist.com/finance-and-economics/rss.xml', 'economics')] }], // (v)
  ['Nikkei Asia', M, 'asia.nikkei.com nikkei.com', { feeds: [rss('https://asia.nikkei.com/rss/feed/nar', 'global_news')] }], // (v)
  ["Barron's", M, 'barrons.com'],
  ['BBC Business', M, 'bbc.co.uk bbc.com', { feeds: [rss('https://feeds.bbci.co.uk/news/business/rss.xml', 'global_news')] }], // (v)(a)
  ['NYT Business', M, 'nytimes.com', { feeds: [rss('https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', 'global_news')] }], // (v)
  ['Guardian Business', M, 'theguardian.com', { feeds: [rss('https://www.theguardian.com/uk/business/rss', 'global_news')] }], // (v)
  ['Fortune', S, 'fortune.com', { feeds: [rss('https://fortune.com/feed/', 'global_news')] }], // (v)
  ['Forbes', C, 'forbes.com', { feeds: [rss('https://www.forbes.com/business/feed/', 'global_news')] }], // (v)
  ['Business Insider', S, 'businessinsider.com', { feeds: [rss('https://www.businessinsider.com/rss', 'global_news')] }], // (v)
  ['MarketWatch', S, 'marketwatch.com', { feeds: [rss('https://feeds.content.dowjones.io/public/rss/mw_topstories', 'investments'), rss('https://feeds.content.dowjones.io/public/rss/mw_marketpulse', 'investments')] }], // (v)(a)
  ['Yahoo Finance', C, 'finance.yahoo.com', { feeds: [rss('https://finance.yahoo.com/news/rssindex', 'investments')] }], // (v)
  ['Axios', S, 'axios.com', { aliases: ['Axios Pro Rata'] }],
  ['Semafor Business', S, 'semafor.com'],

  // AI & technology
  ['MIT Tech Review', S, 'technologyreview.com', { feeds: [rss('https://www.technologyreview.com/feed/', 'ai_tech')] }], // (v)
  ['TechCrunch', S, 'techcrunch.com', { aliases: ['TechCrunch Startups'], feeds: [rss('https://techcrunch.com/category/artificial-intelligence/feed/', 'ai_tech'), rss('https://techcrunch.com/category/startups/feed/', 'startups')] }], // (v)(a)
  ['The Verge', S, 'theverge.com', { feeds: [rss('https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', 'ai_tech')] }], // (a)
  ['Ars Technica', S, 'arstechnica.com', { feeds: [rss('https://feeds.arstechnica.com/arstechnica/index', 'ai_tech')] }], // (v)
  ['Wired', S, 'wired.com', { feeds: [rss('https://www.wired.com/feed/rss', 'ai_tech')] }], // (v)
  ['VentureBeat', S, 'venturebeat.com', { feeds: [rss('https://venturebeat.com/category/ai/feed/', 'ai_tech')] }], // (a)
  ['IEEE Spectrum', S, 'spectrum.ieee.org', { feeds: [rss('https://spectrum.ieee.org/feeds/feed.rss', 'ai_tech')] }], // (v)
  ['ZDNET', S, 'zdnet.com', { feeds: [rss('https://www.zdnet.com/news/rss.xml', 'ai_tech')] }], // (v)
  ['Techmeme', N, 'techmeme.com'],
  ['SiliconANGLE', S, 'siliconangle.com', { feeds: [rss('https://siliconangle.com/feed/', 'ai_tech')] }], // (v)
  ['Engadget', S, 'engadget.com', { feeds: [rss('https://www.engadget.com/rss.xml', 'ai_tech')] }], // (v)
  ['The Information', S, 'theinformation.com'],
  ['ScienceDaily', C, 'sciencedaily.com'],
  ['Google AI Blog', S, 'blog.google ai.googleblog.com research.google', { feeds: [rss('https://blog.google/technology/ai/rss/', 'ai_tech')] }], // (v)
  ['Microsoft Research Blog', S, 'microsoft.com', { feeds: [rss('https://www.microsoft.com/en-us/research/feed/', 'ai_tech')] }], // (v)
  ['OpenAI News', S, 'openai.com', { feeds: [rss('https://openai.com/news/rss.xml', 'ai_tech')] }], // (v)
  ['Anthropic News', S, 'anthropic.com'],
  ['NVIDIA Newsroom', S, 'nvidia.com blogs.nvidia.com', { feeds: [rss('https://blogs.nvidia.com/feed/', 'ai_tech')] }], // (v)

  // Academic journals & research (primary)
  ['Nature', P, 'nature.com', { aliases: ['Nature Technology'], feeds: [rss('https://www.nature.com/nature.rss', 'education')] }], // (v)
  ['Science', P, 'science.org', { feeds: [rss('https://www.science.org/rss/news_current.xml', 'education')] }], // (v)
  ['arXiv', P, 'arxiv.org'],
  ['SSRN', P, 'ssrn.com'],
  ['Google Scholar', C, 'scholar.google.com'],

  // Education
  ['Times Higher Education', S, 'timeshighereducation.com'],
  ['Inside Higher Ed', S, 'insidehighered.com', { feeds: [rss('https://www.insidehighered.com/rss.xml', 'education')] }], // (v)
  ['EdSurge', S, 'edsurge.com', { feeds: [rss('https://www.edsurge.com/articles_rss', 'education')] }], // (v)
  ['Education Week', S, 'edweek.org'],
  ['Chronicle of Higher Ed', S, 'chronicle.com'],
  ['UNESCO', P, 'unesco.org'],
  ['OECD', P, 'oecd.org', { aliases: ['OECD Education', 'OECD Housing', 'OECD Trade'] }],
  ['World Bank', P, 'worldbank.org', { aliases: ['World Bank Education', 'World Bank Urban', 'World Bank Trade'] }],
  ['UNICEF Education', P, 'unicef.org'],
  ['US Dept of Ed', P, 'ed.gov'],
  ['EU Commission Education', P, 'education.ec.europa.eu'],
  ['Brookings', M, 'brookings.edu'],
  ['HBS Working Knowledge', S, 'hbswk.hbs.edu'],
  ['Stanford GSB Insights', S, 'gsb.stanford.edu', { aliases: ['Stanford GSB'] }],
  ['MIT Sloan', S, 'mitsloan.mit.edu', { aliases: ['MIT Sloan Management Review'] }],

  // Economics & macro
  ['IMF', P, 'imf.org', { aliases: ['IMF DOTS'] }],
  ['BIS', P, 'bis.org', { aliases: ['Basel Committee'], feeds: [rss('https://www.bis.org/doclist/all_pressrels.rss', 'economics')] }], // (v)
  ['UNCTAD', P, 'unctad.org'],
  ['WTO', P, 'wto.org', { feeds: [rss('https://www.wto.org/library/rss/latest_news_e.xml', 'trade')] }], // (v)
  ['Eurostat', P, 'ec.europa.eu', { aliases: ['Eurostat Trade'] }],
  ['Fed', P, 'federalreserve.gov', { aliases: ['Federal Reserve'], feeds: [rss('https://www.federalreserve.gov/feeds/press_all.xml', 'economics'), rss('https://www.federalreserve.gov/feeds/speeches_and_testimony.xml', 'economics')] }], // (v)
  ['ECB', P, 'ecb.europa.eu', { feeds: [rss('https://www.ecb.europa.eu/rss/press.html', 'economics')] }], // (v)
  ['BEA', P, 'bea.gov', { feeds: [rss('https://apps.bea.gov/rss/rss.xml', 'economics')] }], // (v)
  ['BLS', P, 'bls.gov'],
  ['Census Bureau', P, 'census.gov', { aliases: ['US Census'] }],
  ['UK ONS', P, 'ons.gov.uk'],
  ['Asian Development Bank', P, 'adb.org'],
  ['AfDB', P, 'afdb.org'],
  ['IDB', P, 'iadb.org'],
  ['PIIE', M, 'piie.com'],
  ['NBER', M, 'nber.org', { feeds: [rss('https://www.nber.org/rss/new.xml', 'economics')] }], // (v)

  // Georgia focus. These publish no RSS, so their HTML news listings are scraped by link pattern.
  ['National Bank of Georgia', P, 'nbg.gov.ge', { aliases: ['NBG'], georgia: true, feeds: [page('https://nbg.gov.ge/en/media/news', '^/en/media/news/[^/?#]+$', 'georgia')] }],
  ['GeoStat', P, 'geostat.ge', { georgia: true, feeds: [page('https://www.geostat.ge/en', '^/en/single-news/\\d+', 'georgia')] }],
  ['Ministry of Finance of Georgia', P, 'mof.ge', { georgia: true, feeds: [page('https://www.mof.ge/en', '^/en/n/events/[^/?#]+$', 'georgia')] }],
  ['Revenue Service', P, 'rs.ge', { georgia: true }],
  ['Georgian Stock Exchange', M, 'gse.ge', { aliases: ['Stock Exchange of Georgia'], georgia: true, feeds: [page('https://gse.ge', '^/news/[^/?#]+$', 'georgia')] }],
  // Added beyond the spec so Georgian official data has independent press corroboration.
  ['Civil.ge', S, 'civil.ge', { georgia: true, feeds: [rss('https://civil.ge/feed', 'georgia')] }], // (v)

  // Investments & markets
  ['SEC EDGAR', P, 'sec.gov', { aliases: ['SEC'], feeds: [rss('https://www.sec.gov/news/pressreleases.rss', 'investments')] }], // (v)
  ['BoE', P, 'bankofengland.co.uk', { aliases: ['Bank of England'], feeds: [rss('https://www.bankofengland.co.uk/rss/news', 'economics')] }], // (v)
  ['US Treasury', P, 'treasury.gov home.treasury.gov'],
  ['FINRA', P, 'finra.org'],
  ['FRED', P, 'stlouisfed.org'],
  ['Morningstar', S, 'morningstar.com'],
  ['S&P Global', M, 'spglobal.com', { aliases: ['S&P Global Supply Chain', 'S&P Banking'] }],
  ["Moody's", M, 'moodys.com', { aliases: ["Moody's Banking"] }],
  ['Fitch Ratings', M, 'fitchratings.com', { aliases: ['Fitch Banking'] }],
  ['CME Group', M, 'cmegroup.com'],
  ['Nasdaq', M, 'nasdaq.com'],
  ['NYSE', M, 'nyse.com'],
  ['LSE', M, 'londonstockexchange.com lseg.com'],
  ['Trading Economics', C, 'tradingeconomics.com'],
  ['Investing.com', C, 'investing.com'],
  ['Refinitiv', S, 'refinitiv.com'],

  // Crypto & digital assets
  ['CoinDesk', S, 'coindesk.com', { feeds: [rss('https://www.coindesk.com/arc/outboundfeeds/rss/', 'crypto')] }], // (v)(a)
  ['Cointelegraph', C, 'cointelegraph.com', { feeds: [rss('https://cointelegraph.com/rss', 'crypto')] }], // (v)(a)
  ['The Block', S, 'theblock.co', { feeds: [rss('https://www.theblock.co/rss.xml', 'crypto')] }], // (v)(a)
  ['Decrypt', S, 'decrypt.co', { feeds: [rss('https://decrypt.co/feed', 'crypto')] }], // (v)
  ['Blockworks', S, 'blockworks.co', { feeds: [rss('https://www.blockworks.co/feed', 'crypto')] }], // (v)
  ['DL News', S, 'dlnews.com', { feeds: [rss('https://www.dlnews.com/arc/outboundfeeds/rss/', 'crypto')] }], // (v)
  ['Messari', S, 'messari.io'],
  ['Chainalysis', S, 'chainalysis.com'],
  ['Glassnode', S, 'glassnode.com'],
  ['CoinGecko', C, 'coingecko.com'],
  ['CoinMarketCap', C, 'coinmarketcap.com'],
  ['DefiLlama', C, 'defillama.com'],
  ['Dune', C, 'dune.com'],
  ['Kaiko', S, 'kaiko.com'],
  ['CryptoQuant', C, 'cryptoquant.com'],
  ['FATF', P, 'fatf-gafi.org'],
  ['ESMA', P, 'esma.europa.eu', { feeds: [rss('https://www.esma.europa.eu/rss.xml', 'investments')] }], // (v)

  // Marketing & advertising
  ['Marketing Week', S, 'marketingweek.com'],
  ['Ad Age', S, 'adage.com'],
  ['Adweek', S, 'adweek.com', { feeds: [rss('https://www.adweek.com/feed/', 'marketing')] }], // (v)(a)
  ['Digiday', S, 'digiday.com', { feeds: [rss('https://digiday.com/feed/', 'marketing')] }], // (v)
  ['Campaign', S, 'campaignlive.com'],
  ['The Drum', S, 'thedrum.com'],
  ['SEJ', C, 'searchenginejournal.com'],
  ['SEL', S, 'searchengineland.com', { aliases: ['Search Engine Land'], feeds: [rss('https://searchengineland.com/feed', 'marketing')] }], // (a)
  ['Social Media Examiner', C, 'socialmediaexaminer.com', { feeds: [rss('https://www.socialmediaexaminer.com/feed/', 'marketing')] }], // (v)
  ['HubSpot', C, 'hubspot.com'],
  ['Think with Google', S, 'thinkwithgoogle.com'],
  ['Meta Business', S, 'about.fb.com business.facebook.com meta.com'],
  ['LinkedIn Marketing', C, 'business.linkedin.com marketing.linkedin.com'],
  ['TikTok for Business', C, 'ads.tiktok.com business.tiktok.com'],
  ['Nielsen', M, 'nielsen.com'],
  ['Kantar', S, 'kantar.com'],
  ['WARC', S, 'warc.com'],
  ['IAB', S, 'iab.com'],
  ['Gartner', C, 'gartner.com'],
  ['McKinsey', C, 'mckinsey.com', { aliases: ['McKinsey Insights'], feeds: [rss('https://www.mckinsey.com/insights/rss', 'management')] }], // (v)
  ['Marketing Dive', S, 'marketingdive.com', { feeds: [rss('https://www.marketingdive.com/feeds/news/', 'marketing')] }], // (v)(a)

  // Real estate & property
  ['The Real Deal', S, 'therealdeal.com'],
  ['Bisnow', S, 'bisnow.com', { feeds: [rss('https://www.bisnow.com/rss', 'real_estate')] }], // (v)
  ['GlobeSt', S, 'globest.com'],
  ['Property Week', S, 'propertyweek.com'],
  ['CoStar', S, 'costar.com'],
  ['Zillow Research', S, 'zillow.com'],
  ['Redfin Research', S, 'redfin.com'],
  ['CBRE', S, 'cbre.com'],
  ['JLL', S, 'jll.com'],
  ['Knight Frank', S, 'knightfrank.com'],
  ['Savills', S, 'savills.com'],
  ['Cushman & Wakefield', S, 'cushmanwakefield.com'],
  ['ULI', S, 'uli.org'],
  ['HousingWire', S, 'housingwire.com', { feeds: [rss('https://www.housingwire.com/feed/', 'real_estate')] }], // (v)(a)
  ['Realtor.com News', C, 'realtor.com', { feeds: [rss('https://www.realtor.com/news/feed/', 'real_estate')] }], // (a)

  // Global trade & supply chains
  ['UN Comtrade', P, 'comtradeplus.un.org comtrade.un.org'],
  ['ITC', P, 'intracen.org'],
  ['WCO', P, 'wcoomd.org'],
  ['US ITC', P, 'usitc.gov'],
  ['Freightos', S, 'freightos.com'],
  ['Drewry', S, 'drewry.co.uk'],
  ['CTS', S, 'containerstatistics.com'],
  ['Baltic Exchange', M, 'balticexchange.com'],
  ["Lloyd's List", S, 'lloydslist.com'],
  ['JOC', S, 'joc.com', { feeds: [rss('https://www.joc.com/rss.xml', 'trade')] }], // (v)
  ['The Loadstar', S, 'theloadstar.com', { feeds: [rss('https://theloadstar.com/feed/', 'trade')] }], // (v)
  ['ShippingWatch', S, 'shippingwatch.com'],
  ['Supply Chain Dive', S, 'supplychaindive.com', { feeds: [rss('https://www.supplychaindive.com/feeds/news/', 'trade')] }], // (v)(a)
  ['FreightWaves', S, 'freightwaves.com', { feeds: [rss('https://www.freightwaves.com/news/feed', 'trade')] }], // (v)(a)

  // Banks & financial institutions
  ['FSB', P, 'fsb.org', { feeds: [rss('https://www.fsb.org/feed/', 'banks')] }], // (v)
  ['EBA', P, 'eba.europa.eu', { feeds: [rss('https://www.eba.europa.eu/rss.xml', 'banks')] }], // (v)
  ['OCC', P, 'occ.gov occ.treas.gov'],
  ['FDIC', P, 'fdic.gov'],
  ['American Banker', S, 'americanbanker.com'],
  ['The Banker', S, 'thebanker.com'],
  ['Risk.net', S, 'risk.net'],
  ['Coalition Greenwich', S, 'greenwich.com coalition.com'],
  ['Banking Dive', S, 'bankingdive.com', { feeds: [rss('https://www.bankingdive.com/feeds/news/', 'banks')] }], // (v)(a)
  ['Finextra', S, 'finextra.com', { feeds: [rss('https://www.finextra.com/rss/headlines.aspx', 'banks')] }], // (v)(a)

  // Startups, VC & companies
  ['Crunchbase News', S, 'news.crunchbase.com crunchbase.com', { feeds: [rss('https://news.crunchbase.com/feed/', 'startups')] }], // (v)(a)
  ['Sifted', S, 'sifted.eu', { feeds: [rss('https://sifted.eu/feed', 'startups')] }], // (v)
  ['EU-Startups', S, 'eu-startups.com', { feeds: [rss('https://www.eu-startups.com/feed/', 'startups')] }], // (v)
  ['StrictlyVC', S, 'strictlyvc.com'],
  ['PitchBook', S, 'pitchbook.com'],
  ['CB Insights', S, 'cbinsights.com'],
  ['Dealroom', S, 'dealroom.co'],
  ['Tracxn', C, 'tracxn.com'],
  ['Carta', S, 'carta.com'],
  ['YC', S, 'ycombinator.com'],
  ['Techstars', C, 'techstars.com'],
  ['Sequoia', C, 'sequoiacap.com'],
  ['a16z', C, 'a16z.com'],
  ['First Round', C, 'firstround.com'],
  ['HBR', S, 'hbr.org', { aliases: ['Harvard Business Review'], feeds: [rss('https://feeds.hbr.org/harvardbusiness', 'management')] }], // (a)

  // Management & leadership
  ['Bain Insights', C, 'bain.com'],
  ['BCG', C, 'bcg.com'],
  ['Deloitte Insights', C, 'deloitte.com'],
  ['PwC Insights', C, 'pwc.com'],
  ['Accenture Research', C, 'accenture.com'],
  ['SHRM', S, 'shrm.org'],
  ['LBS Review', S, 'london.edu'],
  ['INSEAD Knowledge', S, 'insead.edu'],
  ['Wharton Knowledge', S, 'knowledge.wharton.upenn.edu wharton.upenn.edu'],
  ['Strategy+Business', C, 'strategy-business.com'],
  ['Chief Executive', N, 'chiefexecutive.net'],
  ['Fast Company', C, 'fastcompany.com'],
  ['Inc.', C, 'inc.com'],
  ['Entrepreneur', N, 'entrepreneur.com'],
  ['Seeking Alpha', N, 'seekingalpha.com'],

  // Social signals: discovery only, never sufficient on their own.
  ['Hacker News', SOCIAL, 'news.ycombinator.com', { social: true, feeds: [rss('https://news.ycombinator.com/rss')] }], // (v)
  ['Reddit', SOCIAL, 'reddit.com redd.it', { social: true }],
  ['X', X, 'x.com twitter.com', { social: true, aliases: ['Twitter'] }],
];

export const SOURCES: Source[] = DEFS.map(([name, weight, domains, opts = {}]) => ({
  id: slug(name),
  name,
  weight,
  domains: domains.split(/\s+/).filter(Boolean),
  aliases: opts.aliases ?? [],
  feeds: opts.feeds ?? [],
  social: opts.social ?? false,
  georgia: opts.georgia ?? false,
}));

// ─── Source categories (verbatim from the spec) ─────────────────────────────
export interface SourceCategory {
  id: SourceCategoryId;
  label: string;
  /** Tab/category an article defaults to when the Research agent has no better signal. */
  articleCategory: ArticleCategory;
  sources: string[];
}

export const SOURCE_CATEGORIES: SourceCategory[] = [
  { id: 'global_news', label: 'Global News & Business', articleCategory: 'General', sources: ['Reuters', 'Bloomberg', 'FT', 'WSJ', 'CNBC', 'The Economist', 'AP', 'BBC Business', 'NYT Business', 'Guardian Business', 'Fortune', 'Forbes', 'Business Insider', 'Nikkei Asia', 'MarketWatch', 'Yahoo Finance', "Barron's", 'Axios', 'Semafor Business'] },
  { id: 'ai_tech', label: 'AI & Technology', articleCategory: 'AI & Tech', sources: ['MIT Tech Review', 'TechCrunch', 'The Verge', 'Ars Technica', 'Wired', 'VentureBeat', 'IEEE Spectrum', 'ZDNET', 'Techmeme', 'SiliconANGLE', 'Engadget', 'The Information', 'Nature Technology', 'ScienceDaily', 'Google AI Blog', 'Microsoft Research Blog', 'OpenAI News', 'Anthropic News', 'NVIDIA Newsroom'] },
  { id: 'education', label: 'Education & Research', articleCategory: 'General', sources: ['Times Higher Education', 'Inside Higher Ed', 'EdSurge', 'Education Week', 'Chronicle of Higher Ed', 'UNESCO', 'OECD Education', 'World Bank Education', 'UNICEF Education', 'US Dept of Ed', 'EU Commission Education', 'Nature', 'Science', 'arXiv', 'SSRN', 'Google Scholar', 'Brookings', 'HBS Working Knowledge', 'Stanford GSB Insights', 'MIT Sloan'] },
  { id: 'economics', label: 'Economics & Macroeconomics', articleCategory: 'Economics', sources: ['IMF', 'World Bank', 'OECD', 'BIS', 'UNCTAD', 'WTO', 'Eurostat', 'Fed', 'ECB', 'BEA', 'BLS', 'Census Bureau', 'UK ONS', 'Asian Development Bank', 'AfDB', 'IDB', 'PIIE', 'NBER'] },
  { id: 'georgia', label: 'Georgia Focus', articleCategory: 'Economics', sources: ['National Bank of Georgia', 'GeoStat', 'Ministry of Finance of Georgia', 'Revenue Service', 'Georgian Stock Exchange'] },
  { id: 'investments', label: 'Investments & Markets', articleCategory: 'Economics', sources: ['SEC EDGAR', 'Fed', 'ECB', 'BoE', 'US Treasury', 'FINRA', 'Morningstar', 'S&P Global', "Moody's", 'Fitch Ratings', 'CME Group', 'Nasdaq', 'NYSE', 'LSE', 'Trading Economics', 'FRED', 'Investing.com', 'Stock Exchange of Georgia', 'Refinitiv'] },
  { id: 'crypto', label: 'Crypto & Digital Assets', articleCategory: 'Crypto', sources: ['CoinDesk', 'Cointelegraph', 'The Block', 'Decrypt', 'Blockworks', 'DL News', 'Bloomberg Crypto', 'Reuters Crypto', 'Messari', 'Chainalysis', 'Glassnode', 'CoinGecko', 'CoinMarketCap', 'DefiLlama', 'Dune', 'Kaiko', 'CryptoQuant', 'FATF', 'SEC', 'ESMA'] },
  { id: 'marketing', label: 'Marketing & Advertising', articleCategory: 'Marketing', sources: ['Marketing Week', 'Ad Age', 'Adweek', 'Digiday', 'Campaign', 'The Drum', 'SEJ', 'SEL', 'Social Media Examiner', 'HubSpot', 'Think with Google', 'Meta Business', 'LinkedIn Marketing', 'TikTok for Business', 'Nielsen', 'Kantar', 'WARC', 'IAB', 'Gartner', 'McKinsey'] },
  { id: 'real_estate', label: 'Real Estate & Property', articleCategory: 'Real Estate', sources: ['Reuters RE', 'Bloomberg RE', 'FT Property', 'The Real Deal', 'Bisnow', 'GlobeSt', 'Property Week', 'CoStar', 'Zillow Research', 'Redfin Research', 'CBRE', 'JLL', 'Knight Frank', 'Savills', 'Cushman & Wakefield', 'ULI', 'OECD Housing', 'World Bank Urban', 'GeoStat', 'NBG'] },
  { id: 'trade', label: 'Global Trade & Supply Chains', articleCategory: 'Global Trade', sources: ['WTO', 'UN Comtrade', 'UNCTAD', 'ITC', 'WCO', 'World Bank Trade', 'OECD Trade', 'Eurostat Trade', 'US Census', 'US ITC', 'IMF DOTS', 'Freightos', 'Drewry', 'S&P Global Supply Chain', 'CTS', 'Baltic Exchange', "Lloyd's List", 'JOC', 'The Loadstar', 'ShippingWatch'] },
  { id: 'banks', label: 'Banks & Financial Institutions', articleCategory: 'Economics', sources: ['BIS', 'FSB', 'IMF', 'Fed', 'ECB', 'BoE', 'NBG', 'EBA', 'OCC', 'FDIC', 'Basel Committee', 'Reuters Banks', 'Bloomberg Banks', 'American Banker', 'The Banker', 'Risk.net', 'S&P Banking', "Moody's Banking", 'Fitch Banking', 'Coalition Greenwich'] },
  { id: 'startups', label: 'Startups, VC & Companies', articleCategory: 'VC & Startups', sources: ['TechCrunch Startups', 'Crunchbase News', 'Sifted', 'EU-Startups', 'VentureBeat', 'The Information', 'StrictlyVC', 'Axios Pro Rata', 'Bloomberg Tech', 'PitchBook', 'CB Insights', 'Dealroom', 'Tracxn', 'Carta', 'YC', 'Techstars', 'Sequoia', 'a16z', 'First Round', 'HBR'] },
  { id: 'management', label: 'Management & Leadership', articleCategory: 'General', sources: ['HBR', 'MIT Sloan', 'McKinsey Insights', 'Bain Insights', 'BCG', 'Deloitte Insights', 'PwC Insights', 'Accenture Research', 'Gartner', 'SHRM', 'Stanford GSB', 'LBS Review', 'INSEAD Knowledge', 'Wharton Knowledge', 'Strategy+Business', 'Economist Business', 'Chief Executive', 'Fast Company', 'Inc.', 'Entrepreneur'] },
];

// ─── Lookups ────────────────────────────────────────────────────────────────
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9+&.]+/g, ' ').trim();

const byName = new Map<string, Source>();
for (const s of SOURCES) {
  byName.set(norm(s.name), s);
  for (const a of s.aliases) byName.set(norm(a), s);
}

export function findSourceByName(name: string): Source | undefined {
  return byName.get(norm(name));
}

export const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));

/** hostname suffix -> source; longest suffix wins (education.ec.europa.eu beats ec.europa.eu). */
const byDomain = new Map<string, Source>();
for (const s of SOURCES) for (const d of s.domains) if (!byDomain.has(d)) byDomain.set(d, s);

export function findSourceByHost(host: string): Source | undefined {
  let h = host.toLowerCase().replace(/^www\./, '');
  while (h.includes('.')) {
    const hit = byDomain.get(h);
    if (hit) return hit;
    h = h.slice(h.indexOf('.') + 1);
  }
  return undefined;
}

export interface FeedRef extends FeedDef {
  id: string;
  source: Source;
}

/** Every pollable feed, in stable order (the round-robin scheduler depends on it). */
export const FEEDS: FeedRef[] = SOURCES.flatMap((s) => s.feeds.map((f, i) => ({ ...f, id: `${s.id}:${i}`, source: s })));

/** Spec category id -> article category used for tabs. */
export function articleCategoryFor(hint: SourceCategoryId | null | undefined): ArticleCategory {
  return SOURCE_CATEGORIES.find((c) => c.id === hint)?.articleCategory ?? 'General';
}
