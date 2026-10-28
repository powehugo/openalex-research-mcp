/**
 * Google Scholar via SerpApi, with a pool of API keys.
 *
 * Keys: SERPAPI_API_KEYS (comma, semicolon, whitespace or newline separated)
 * plus the single SERPAPI_API_KEY. Keys are used in order, so one account is
 * drained before the next is touched.
 *
 * SerpApi answers 401/403 for a bad or deleted key, and 429 both for the
 * hourly throughput cap and for an account that is out of searches. On a 429
 * the free Account API (not counted against quota) tells the two apart:
 *   - out of searches -> parked for 24 h, then re-checked;
 *   - throughput cap  -> parked for 1 h.
 */
import axios, { AxiosError } from 'axios';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const BASE = process.env.SERPAPI_BASE_URL || 'https://serpapi.com';
const TIMEOUT_MS = 45_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type KeyState = { parkedUntil: number; invalid: boolean; reason?: string };

function parseKeys(): string[] {
  const raw = [process.env.SERPAPI_API_KEYS || '', process.env.SERPAPI_API_KEY || ''].join(',');
  return [...new Set(raw.split(/[\s,;]+/).map(k => k.trim()).filter(Boolean))];
}

function mask(key: string): string {
  return `…${key.slice(-4)}`;
}

class SerpApiKeyPool {
  readonly keys = parseKeys();
  private state = new Map<string, KeyState>(this.keys.map(k => [k, { parkedUntil: 0, invalid: false }]));

  get size(): number { return this.keys.length; }

  current(now = Date.now()): string | undefined {
    return this.keys.find(k => {
      const s = this.state.get(k)!;
      return !s.invalid && s.parkedUntil <= now;
    });
  }

  markInvalid(key: string): void {
    const s = this.state.get(key);
    if (s) { s.invalid = true; s.reason = 'rejected by SerpApi (401/403)'; }
  }

  park(key: string, ms: number, reason: string): void {
    const s = this.state.get(key);
    if (s) { s.parkedUntil = Date.now() + ms; s.reason = reason; }
  }

  status(now = Date.now()): { configured: number; available: number; invalid: number; parked: number } {
    let invalid = 0, parked = 0;
    for (const s of this.state.values()) {
      if (s.invalid) invalid += 1;
      else if (s.parkedUntil > now) parked += 1;
    }
    return { configured: this.keys.length, available: this.keys.length - invalid - parked, invalid, parked };
  }

  describe(key: string): { invalid: boolean; parkedUntil: string | null; reason: string | null } {
    const s = this.state.get(key)!;
    return {
      invalid: s.invalid,
      parkedUntil: s.parkedUntil > Date.now() ? new Date(s.parkedUntil).toISOString() : null,
      reason: s.reason ?? null,
    };
  }
}

export const serpApiKeys = new SerpApiKeyPool();

const http = axios.create({ baseURL: BASE, timeout: TIMEOUT_MS, headers: { Accept: 'application/json' } });

/** Free call: does not consume searches. */
async function accountInfo(key: string): Promise<any> {
  return (await http.get('/account.json', { params: { api_key: key } })).data;
}

async function handle429(key: string): Promise<void> {
  try {
    const info = await accountInfo(key);
    const left = Number(info?.total_searches_left ?? info?.plan_searches_left);
    if (Number.isFinite(left) && left <= 0) {
      serpApiKeys.park(key, DAY, 'out of searches');
      return;
    }
  } catch {
    // Fall through to the conservative hourly park.
  }
  serpApiKeys.park(key, HOUR, 'hourly throughput limit');
}

/** Run one SerpApi search, rotating keys on auth and quota errors. */
async function serpSearch(params: Record<string, unknown>): Promise<any> {
  if (!serpApiKeys.size) throw new Error('Google Scholar is disabled until SERPAPI_API_KEYS is configured');
  const tried = new Set<string>();
  for (;;) {
    const key = serpApiKeys.current();
    if (!key || tried.has(key)) {
      throw new Error('All configured SerpApi keys are out of searches, rate-limited, or invalid. Use google_scholar_quota for details.');
    }
    tried.add(key);
    try {
      const data = (await http.get('/search.json', { params: { ...params, api_key: key } })).data;
      if (data?.error && /run out of searches/i.test(String(data.error))) {
        serpApiKeys.park(key, DAY, 'out of searches');
        continue;
      }
      if (data?.error && !/hasn't returned any results/i.test(String(data.error))) {
        throw new Error(`SerpApi: ${data.error}`);
      }
      return data;
    } catch (error) {
      const status = (error as AxiosError)?.response?.status;
      if (status === 401 || status === 403) { serpApiKeys.markInvalid(key); continue; }
      if (status === 429) { await handle429(key); continue; }
      const body: any = (error as AxiosError)?.response?.data;
      if (body?.error) throw new Error(`SerpApi: ${body.error}`);
      throw error;
    }
  }
}

function req(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(Math.floor(n), max)) : fallback;
}

function compactResult(r: any): Record<string, unknown> {
  return {
    position: r.position,
    title: r.title,
    result_id: r.result_id,
    type: r.type ?? null,
    link: r.link ?? null,
    snippet: r.snippet ?? null,
    publication_info: r.publication_info?.summary ?? null,
    authors: (r.publication_info?.authors || []).map((a: any) => ({ name: a.name, author_id: a.author_id })),
    resources: (r.resources || []).map((x: any) => ({ title: x.title, file_format: x.file_format, link: x.link })),
    cited_by: r.inline_links?.cited_by ? { total: r.inline_links.cited_by.total, cites_id: r.inline_links.cited_by.cites_id } : null,
    versions: r.inline_links?.versions ? { total: r.inline_links.versions.total, cluster_id: r.inline_links.versions.cluster_id } : null,
  };
}

export const SCHOLAR_TOOLS: Tool[] = [
  {
    name: 'google_scholar_search',
    description: 'Search Google Scholar through SerpApi. Each call spends one SerpApi search credit, so prefer free OpenAlex/Crossref/Semantic Scholar tools for bulk work and use this for Google Scholar coverage, cited-by lists (cites), or all versions of a paper (cluster). Returns compact results with result_id, cites_id and cluster_id for follow-up calls.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query. Supports Google Scholar operators such as author:"name" and source:"journal". Optional when cites or cluster is given.' },
        cites: { type: 'string', description: 'cites_id from a previous result: list papers citing it (combine with query to search within citing papers)' },
        cluster: { type: 'string', description: 'cluster_id from a previous result: list all versions of that paper' },
        year_from: { type: 'number', description: 'Earliest publication year (as_ylo)' },
        year_to: { type: 'number', description: 'Latest publication year (as_yhi)' },
        sort_by_date: { type: 'boolean', description: 'Only papers added in the past year, newest first (scisbd=1)' },
        start: { type: 'number', description: 'Result offset, e.g. 0, 10, 20' },
        num: { type: 'number', description: 'Results per page, 1-20 (default 10)' },
        language: { type: 'string', description: 'Interface language code, e.g. en or zh-CN' },
        include_patents: { type: 'boolean', description: 'Include patents (default false)' },
        include_citations: { type: 'boolean', description: 'Include citation-only entries (default true)' },
      },
    },
  },
  {
    name: 'google_scholar_author',
    description: 'Get a Google Scholar author profile (affiliation, interests, citation metrics, articles) by author_id via SerpApi. Spends one search credit.',
    inputSchema: {
      type: 'object',
      properties: {
        author_id: { type: 'string', description: 'Google Scholar author id, e.g. from a search result author' },
        sort: { type: 'string', enum: ['citedby', 'pubdate'], description: 'Article order (default: citations)' },
        start: { type: 'number' },
        num: { type: 'number', description: 'Articles to return, up to 100' },
      },
      required: ['author_id'],
    },
  },
  {
    name: 'google_scholar_cite',
    description: 'Get formatted citations (APA, MLA, Chicago, etc.) and BibTeX/EndNote links for a Google Scholar result_id via SerpApi. Spends one search credit.',
    inputSchema: { type: 'object', properties: { result_id: { type: 'string' } }, required: ['result_id'] },
  },
  {
    name: 'google_scholar_quota',
    description: 'Show remaining SerpApi searches for each configured key (keys masked). Uses the free SerpApi Account API and does not spend search credits.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function googleScholarSearch(params: any): Promise<unknown> {
  const q: Record<string, unknown> = { engine: 'google_scholar' };
  if (params.query) q.q = String(params.query).trim();
  if (params.cites) q.cites = String(params.cites).trim();
  if (params.cluster) q.cluster = String(params.cluster).trim();
  if (!q.q && !q.cites && !q.cluster) throw new Error('query, cites or cluster is required');
  if (params.year_from) q.as_ylo = int(params.year_from, 0, 1000, 3000);
  if (params.year_to) q.as_yhi = int(params.year_to, 0, 1000, 3000);
  if (params.sort_by_date) q.scisbd = 1;
  q.start = int(params.start, 0, 0, 1000);
  q.num = int(params.num, 10, 1, 20);
  if (params.language) q.hl = String(params.language);
  q.as_sdt = params.include_patents ? '7' : '0';
  if (params.include_citations === false) q.as_vis = 1;
  const data = await serpSearch(q);
  return {
    total_results: data.search_information?.total_results ?? null,
    query: { q: q.q ?? null, cites: q.cites ?? null, cluster: q.cluster ?? null, start: q.start, num: q.num },
    results: (data.organic_results || []).map(compactResult),
    next_start: data.serpapi_pagination?.next ? Number(q.start) + Number(q.num) : null,
    profiles: data.profiles ?? undefined,
  };
}

export async function googleScholarAuthor(params: any): Promise<unknown> {
  const data = await serpSearch({
    engine: 'google_scholar_author',
    author_id: req(params.author_id, 'author_id'),
    ...(params.sort === 'pubdate' ? { sort: 'pubdate' } : {}),
    start: int(params.start, 0, 0, 10000),
    num: int(params.num, 20, 1, 100),
  });
  return {
    author: data.author ?? null,
    cited_by: data.cited_by ?? null,
    articles: (data.articles || []).map((a: any) => ({
      title: a.title, citation_id: a.citation_id, authors: a.authors, publication: a.publication,
      year: a.year, cited_by: a.cited_by?.value ?? null, cites_id: a.cited_by?.cites_id ?? null, link: a.link,
    })),
    co_authors: data.co_authors ?? [],
  };
}

export async function googleScholarCite(params: any): Promise<unknown> {
  const data = await serpSearch({ engine: 'google_scholar_cite', q: req(params.result_id, 'result_id') });
  return { citations: data.citations ?? [], links: data.links ?? [] };
}

export async function googleScholarQuota(): Promise<unknown> {
  const keys = await Promise.all(serpApiKeys.keys.map(async key => {
    try {
      const info = await accountInfo(key);
      return {
        key: mask(key),
        plan: info.plan_name ?? null,
        searches_per_month: info.searches_per_month ?? null,
        this_month_usage: info.this_month_usage ?? null,
        plan_searches_left: info.plan_searches_left ?? null,
        extra_credits: info.extra_credits ?? null,
        total_searches_left: info.total_searches_left ?? null,
        hourly_limit: info.account_rate_limit_per_hour ?? null,
        ...serpApiKeys.describe(key),
      };
    } catch (error) {
      return { key: mask(key), error: `account lookup failed (${(error as AxiosError)?.response?.status ?? 'network'})`, ...serpApiKeys.describe(key) };
    }
  }));
  const total = keys.reduce((sum, k: any) => sum + (Number(k.total_searches_left) || 0), 0);
  return { total_searches_left: total, keys };
}

export function scholarStatus(): Record<string, unknown> {
  return { enabled: serpApiKeys.size > 0, apiKeys: serpApiKeys.status() };
}
