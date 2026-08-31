import axios, { AxiosInstance } from 'axios';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

const TIMEOUT_MS = 30_000;
const ARXIV_TIMEOUT_MS = 8_000;
const USER_AGENT = process.env.SCHOLARLY_API_USER_AGENT ||
  'openalex-research-mcp/0.6 (scholarly metadata gateway)';

const pagination = {
  limit: { type: 'number', description: 'Maximum number of results to return' },
  offset: { type: 'number', description: 'Zero-based result offset' },
};

export const EXTERNAL_TOOLS: Tool[] = [
  { name: 'semantic_scholar_search', description: 'Search Semantic Scholar Academic Graph. Use as an independent discovery path alongside OpenAlex.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Plain-text paper query' }, ...pagination, year: { type: 'string', description: 'Year or range, e.g. 2024 or 2022-2026' }, fields_of_study: { type: 'string', description: 'Comma-separated fields of study' }, open_access_pdf: { type: 'boolean', description: 'Require an open-access PDF' } }, required: ['query'] } },
  { name: 'semantic_scholar_get_paper', description: 'Resolve a Semantic Scholar paper by paper ID, DOI, CorpusId, arXiv ID, PMID, or other supported identifier.', inputSchema: { type: 'object', properties: { paper_id: { type: 'string', description: 'Paper identifier, e.g. DOI:10.1038/...' } }, required: ['paper_id'] } },
  { name: 'semantic_scholar_get_citations', description: 'Retrieve papers that cite a seed paper for forward citation chaining.', inputSchema: { type: 'object', properties: { paper_id: { type: 'string' }, ...pagination }, required: ['paper_id'] } },
  { name: 'semantic_scholar_get_references', description: 'Retrieve papers referenced by a seed paper for backward citation chaining.', inputSchema: { type: 'object', properties: { paper_id: { type: 'string' }, ...pagination }, required: ['paper_id'] } },
  { name: 'semantic_scholar_recommend', description: 'Find semantic-neighbor papers from positive and optional negative seed papers using the Recommendations API.', inputSchema: { type: 'object', properties: { positive_paper_ids: { type: 'array', items: { type: 'string' }, description: 'One or more relevant Semantic Scholar paper IDs' }, negative_paper_ids: { type: 'array', items: { type: 'string' }, description: 'Optional irrelevant seed paper IDs' }, limit: { type: 'number', maximum: 500 } }, required: ['positive_paper_ids'] } },
  { name: 'datacite_search', description: 'Search public DataCite DOI metadata for datasets, software, reports, and other research objects. No API key required.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, resource_type_id: { type: 'string', description: 'DataCite resource type, e.g. dataset or software' }, published: { type: 'string', description: 'Published year or range supported by DataCite' }, sort: { type: 'string', description: 'Sort such as relevance, -published, or -citation-count' }, page: { type: 'number' }, page_size: { type: 'number', maximum: 1000 } }, required: ['query'] } },
  { name: 'datacite_get_doi', description: 'Retrieve a complete public DataCite DOI metadata record and related identifiers.', inputSchema: { type: 'object', properties: { doi: { type: 'string' } }, required: ['doi'] } },
  { name: 'arxiv_search', description: 'Search arXiv preprints and return normalized metadata. Uses the official Atom API first and transparently falls back to OpenAlex records hosted by arXiv when the official API is rate-limited or unavailable.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'arXiv query syntax, e.g. all:"mental health" AND all:chatbot' }, start: { type: 'number' }, max_results: { type: 'number', maximum: 100 }, sort_by: { type: 'string', enum: ['relevance', 'lastUpdatedDate', 'submittedDate'] }, sort_order: { type: 'string', enum: ['ascending', 'descending'] } }, required: ['query'] } },
  { name: 'crossref_search', description: 'Search Crossref metadata for DOI discovery and bibliographic validation. No API key required.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, rows: { type: 'number', maximum: 1000 }, offset: { type: 'number' }, filter: { type: 'string', description: 'Crossref filter expression' }, select: { type: 'string', description: 'Comma-separated Crossref fields to return' } }, required: ['query'] } },
  { name: 'crossref_get_doi', description: 'Resolve and validate a DOI against Crossref metadata, including updates, funding, licenses, and trusted-source assertions when present.', inputSchema: { type: 'object', properties: { doi: { type: 'string' } }, required: ['doi'] } },
  { name: 'federal_register_search', description: 'Search official U.S. Federal Register documents, including rules, proposed rules, notices, and presidential documents.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, agency: { type: 'string', description: 'Agency slug used by Federal Register' }, document_type: { type: 'string', enum: ['RULE', 'PRORULE', 'NOTICE', 'PRESDOCU'] }, publication_date_gte: { type: 'string', description: 'YYYY-MM-DD' }, publication_date_lte: { type: 'string', description: 'YYYY-MM-DD' }, order: { type: 'string', enum: ['newest', 'oldest', 'relevance'] }, page: { type: 'number' }, per_page: { type: 'number', maximum: 1000 } }, required: ['query'] } },
  { name: 'federal_register_get_document', description: 'Retrieve one official Federal Register document by document number.', inputSchema: { type: 'object', properties: { document_number: { type: 'string' } }, required: ['document_number'] } },
  { name: 'regulations_gov_search', description: 'Search Regulations.gov documents, dockets, or comments. Available only when DATA_GOV_API_KEY is configured.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, resource: { type: 'string', enum: ['documents', 'dockets', 'comments'] }, sort: { type: 'string' }, page: { type: 'number', maximum: 20 }, page_size: { type: 'number', maximum: 250 } }, required: ['query'] } },
];

function client(baseURL: string, headers: Record<string, string> = {}): AxiosInstance {
  return axios.create({
    baseURL,
    timeout: TIMEOUT_MS,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
  });
}

function required(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function bounded(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(Math.floor(parsed), max)) : fallback;
}

const S2_FIELDS = [
  'paperId', 'corpusId', 'externalIds', 'url', 'title', 'abstract', 'venue',
  'publicationVenue', 'year', 'referenceCount', 'citationCount',
  'influentialCitationCount', 'isOpenAccess', 'openAccessPdf', 'fieldsOfStudy',
  'publicationTypes', 'publicationDate', 'journal', 'authors',
].join(',');

function s2(): AxiosInstance {
  const apiKey = process.env.S2_API_KEY?.trim();
  return client('https://api.semanticscholar.org', apiKey ? { 'x-api-key': apiKey } : {});
}

export async function semanticScholarSearch(params: any): Promise<unknown> {
  const response = await s2().get('/graph/v1/paper/search', { params: {
    query: required(params.query, 'query'),
    limit: bounded(params.limit, 10, 100),
    offset: Math.max(0, Number(params.offset) || 0),
    fields: S2_FIELDS,
    ...(params.year ? { year: String(params.year) } : {}),
    ...(params.fields_of_study ? { fieldsOfStudy: String(params.fields_of_study) } : {}),
    ...(params.open_access_pdf !== undefined ? { openAccessPdf: String(!!params.open_access_pdf) } : {}),
  }});
  return response.data;
}

export async function semanticScholarPaper(params: any): Promise<unknown> {
  const id = encodeURIComponent(required(params.paper_id, 'paper_id'));
  return (await s2().get(`/graph/v1/paper/${id}`, { params: { fields: S2_FIELDS } })).data;
}

export async function semanticScholarEdges(params: any, edge: 'citations' | 'references'): Promise<unknown> {
  const id = encodeURIComponent(required(params.paper_id, 'paper_id'));
  return (await s2().get(`/graph/v1/paper/${id}/${edge}`, { params: {
    limit: bounded(params.limit, 20, 1000),
    offset: Math.max(0, Number(params.offset) || 0),
    fields: S2_FIELDS,
  }})).data;
}

export async function semanticScholarRecommendations(params: any): Promise<unknown> {
  const positivePaperIds = Array.isArray(params.positive_paper_ids)
    ? params.positive_paper_ids.filter((id: unknown) => typeof id === 'string' && id.trim()).slice(0, 100)
    : [];
  const negativePaperIds = Array.isArray(params.negative_paper_ids)
    ? params.negative_paper_ids.filter((id: unknown) => typeof id === 'string' && id.trim()).slice(0, 100)
    : [];
  if (!positivePaperIds.length) throw new Error('positive_paper_ids must contain at least one paper ID');
  return (await s2().post('/recommendations/v1/papers',
    { positivePaperIds, negativePaperIds },
    { params: { limit: bounded(params.limit, 20, 500), fields: S2_FIELDS } },
  )).data;
}

export async function dataCiteSearch(params: any): Promise<unknown> {
  return (await client('https://api.datacite.org').get('/dois', { params: {
    query: required(params.query, 'query'),
    'page[size]': bounded(params.page_size, 10, 1000),
    'page[number]': bounded(params.page, 1, 10000),
    ...(params.resource_type_id ? { 'resource-type-id': params.resource_type_id } : {}),
    ...(params.published ? { published: params.published } : {}),
    ...(params.sort ? { sort: params.sort } : { sort: 'relevance' }),
    detail: 'true',
  }})).data;
}

export async function dataCiteDoi(params: any): Promise<unknown> {
  const doi = encodeURIComponent(required(params.doi, 'doi').replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''));
  return (await client('https://api.datacite.org').get(`/dois/${doi}`, { params: { detail: 'true' } })).data;
}

function xmlText(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!match) return null;
  return decodeXml(match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(parseInt(n, 16)));
}

export async function arxivSearch(params: any): Promise<unknown> {
  const query = required(params.query, 'query');
  const maxResults = bounded(params.max_results, 10, 100);
  let response;
  try {
    response = await axios.get('https://export.arxiv.org/api/query', {
      timeout: ARXIV_TIMEOUT_MS,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml' },
      params: {
        search_query: query,
        start: Math.max(0, Number(params.start) || 0),
        max_results: maxResults,
        sortBy: params.sort_by || 'relevance',
        sortOrder: params.sort_order || 'descending',
      },
      responseType: 'text',
    });
  } catch (error: any) {
    const status = Number(error?.response?.status) || 0;
    const transient = status === 429 || status >= 500 ||
      ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(String(error?.code || ''));
    if (!transient) throw error;
    return arxivOpenAlexFallback(query, params, maxResults, status || String(error?.code || 'unavailable'));
  }
  const xml = String(response.data);
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)].map(match => {
    const entry = match[1];
    const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map(author => decodeXml(author[1].trim()));
    const categories = [...entry.matchAll(/<category[^>]+term=["']([^"']+)["']/gi)].map(category => category[1]);
    const links = [...entry.matchAll(/<link\s+([^>]+)>/gi)].map(link => {
      const attrs = link[1];
      return {
        href: attrs.match(/href=["']([^"']+)["']/i)?.[1] || null,
        rel: attrs.match(/rel=["']([^"']+)["']/i)?.[1] || null,
        type: attrs.match(/type=["']([^"']+)["']/i)?.[1] || null,
      };
    });
    return {
      id: xmlText(entry, 'id'), title: xmlText(entry, 'title'), summary: xmlText(entry, 'summary'),
      published: xmlText(entry, 'published'), updated: xmlText(entry, 'updated'), authors, categories, links,
      doi: xmlText(entry, 'arxiv:doi'), journal_reference: xmlText(entry, 'arxiv:journal_ref'),
      primary_category: entry.match(/<arxiv:primary_category[^>]+term=["']([^"']+)["']/i)?.[1] || null,
    };
  });
  return {
    source: 'arxiv_official_atom_api',
    degraded: false,
    total_results: Number(xmlText(xml, 'opensearch:totalResults') || entries.length),
    start_index: Number(xmlText(xml, 'opensearch:startIndex') || 0),
    items_per_page: Number(xmlText(xml, 'opensearch:itemsPerPage') || entries.length),
    entries,
  };
}

function normalizeArxivQueryForOpenAlex(query: string): string {
  return query
    .replace(/\b(?:all|ti|au|abs|cat|co|jr|rn|id):/gi, '')
    .replace(/\b(?:AND|OR)\b/gi, ' ')
    .replace(/\bANDNOT\b/gi, ' ')
    .replace(/[()"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function arxivOpenAlexFallback(
  query: string,
  params: any,
  maxResults: number,
  officialFailure: string | number,
): Promise<unknown> {
  const normalizedQuery = normalizeArxivQueryForOpenAlex(query) || query;
  const start = Math.max(0, Number(params.start) || 0);
  const sortOrder = params.sort_order === 'ascending' ? '' : '-';
  const sort = params.sort_by === 'submittedDate'
    ? `${sortOrder}publication_date`
    : params.sort_by === 'lastUpdatedDate'
      ? `${sortOrder}updated_date`
      : undefined;
  const apiKey = process.env.OPENALEX_API_KEY?.trim();
  const queryParams = {
    search: normalizedQuery,
    filter: 'locations.source.id:S4306400194',
    'per-page': maxResults,
    page: Math.floor(start / maxResults) + 1,
    select: 'id,display_name,doi,publication_date,updated_date,authorships,locations,primary_topic',
    ...(sort ? { sort } : {}),
  };
  let response;
  try {
    response = await client('https://api.openalex.org').get('/works', { params: {
      ...queryParams,
      ...(apiKey ? { api_key: apiKey } : {}),
    }});
  } catch (error: any) {
    const status = Number(error?.response?.status) || 0;
    if (!apiKey || ![401, 403].includes(status)) throw error;
    response = await client('https://api.openalex.org').get('/works', { params: queryParams });
  }
  const data = response.data || {};
  const results = Array.isArray(data.results) ? data.results : [];
  const entries = results.map((work: any) => {
    const arxivLocation = (Array.isArray(work.locations) ? work.locations : [])
      .find((location: any) => /^https?:\/\/(?:[^/]+\.)?arxiv\.org\//i.test(location?.landing_page_url || ''));
    return {
      id: arxivLocation?.landing_page_url || work.id || null,
      title: work.display_name || null,
      summary: null,
      published: work.publication_date || null,
      updated: work.updated_date || null,
      authors: (work.authorships || []).map((authorship: any) => authorship?.author?.display_name).filter(Boolean),
      categories: work.primary_topic?.subfield?.display_name ? [work.primary_topic.subfield.display_name] : [],
      links: (work.locations || []).map((location: any) => ({
        href: location?.landing_page_url || location?.pdf_url || null,
        rel: location?.is_oa ? 'alternate' : null,
        type: location?.pdf_url ? 'application/pdf' : null,
      })).filter((link: any) => link.href),
      doi: work.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '') || null,
      journal_reference: null,
      primary_category: work.primary_topic?.display_name || null,
      openalex_id: work.id || null,
    };
  });
  return {
    source: 'openalex_arxiv_index_fallback',
    degraded: true,
    notice: `Official arXiv API unavailable (${officialFailure}); returned works with an arXiv repository location from OpenAlex.`,
    total_results: Number(data.meta?.count || entries.length),
    start_index: start,
    items_per_page: entries.length,
    entries,
  };
}

function crossref(): AxiosInstance {
  const email = process.env.CROSSREF_MAILTO?.trim();
  const agent = email ? `${USER_AGENT} (mailto:${email})` : USER_AGENT;
  return client('https://api.crossref.org', { 'User-Agent': agent });
}

export async function crossrefSearch(params: any): Promise<unknown> {
  return (await crossref().get('/works', { params: {
    query: required(params.query, 'query'),
    rows: bounded(params.rows, 10, 1000),
    offset: Math.max(0, Number(params.offset) || 0),
    ...(params.filter ? { filter: params.filter } : {}),
    ...(params.select ? { select: params.select } : {}),
    ...(process.env.CROSSREF_MAILTO ? { mailto: process.env.CROSSREF_MAILTO } : {}),
  }})).data;
}

export async function crossrefDoi(params: any): Promise<unknown> {
  const doi = encodeURIComponent(required(params.doi, 'doi').replace(/^https?:\/\/(dx\.)?doi\.org\//i, ''));
  return (await crossref().get(`/works/${doi}`, { params: process.env.CROSSREF_MAILTO ? { mailto: process.env.CROSSREF_MAILTO } : {} })).data;
}

export async function federalRegisterSearch(params: any): Promise<unknown> {
  const query: Record<string, unknown> = {
    'conditions[term]': required(params.query, 'query'),
    per_page: bounded(params.per_page, 20, 1000),
    page: bounded(params.page, 1, 10000),
    order: params.order || 'newest',
  };
  if (params.agency) query['conditions[agencies][]'] = params.agency;
  if (params.document_type) query['conditions[type][]'] = params.document_type;
  if (params.publication_date_gte) query['conditions[publication_date][gte]'] = params.publication_date_gte;
  if (params.publication_date_lte) query['conditions[publication_date][lte]'] = params.publication_date_lte;
  return (await client('https://www.federalregister.gov').get('/api/v1/documents.json', { params: query })).data;
}

export async function federalRegisterDocument(params: any): Promise<unknown> {
  const documentNumber = encodeURIComponent(required(params.document_number, 'document_number'));
  return (await client('https://www.federalregister.gov').get(`/api/v1/documents/${documentNumber}.json`)).data;
}

export async function regulationsSearch(params: any): Promise<unknown> {
  const apiKey = process.env.DATA_GOV_API_KEY?.trim();
  if (!apiKey) throw new Error('Regulations.gov is disabled until DATA_GOV_API_KEY is configured');
  const resource = ['documents', 'dockets', 'comments'].includes(params.resource) ? params.resource : 'documents';
  return (await client('https://api.regulations.gov', { 'X-Api-Key': apiKey }).get(`/v4/${resource}`, { params: {
    'filter[searchTerm]': required(params.query, 'query'),
    'page[size]': bounded(params.page_size, 20, 250),
    'page[number]': bounded(params.page, 1, 20),
    sort: params.sort || '-postedDate',
  }})).data;
}

export function externalSourceStatus(): Record<string, unknown> {
  return {
    semanticScholar: { enabled: true, apiKeyConfigured: !!process.env.S2_API_KEY },
    dataCite: { enabled: true, authenticationRequired: false },
    arXiv: { enabled: true, authenticationRequired: false },
    crossref: { enabled: true, mailtoConfigured: !!process.env.CROSSREF_MAILTO },
    federalRegister: { enabled: true, authenticationRequired: false },
    regulationsGov: { enabled: !!process.env.DATA_GOV_API_KEY, apiKeyConfigured: !!process.env.DATA_GOV_API_KEY },
    eurLex: { enabled: false, reason: 'Deferred: account and SOAP credentials required' },
  };
}
