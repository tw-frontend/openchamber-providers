/**
 * Pure helpers for the model-list and provider-endpoint requests, plus the
 * outbound dispatcher: the cluster firewalls direct egress, so a fetch may
 * need the standard proxy environment variables.
 */
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { arenaRowFor, type ArenaRow } from './arena';

const PROXY_URL = process.env.HTTPS_PROXY ?? process.env.https_proxy
  ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? '';
const NO_PROXY = (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase().replace(/^\./, ''))
  .filter(Boolean);

const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;
const directDispatcher = new Agent();

/** Proxy agents by URL: the panel may name its own catalog proxy per provider. */
const proxyAgents = new Map<string, ProxyAgent>();

const proxyAgentFor = (proxyURL: string): ProxyAgent => {
  const key = proxyURL.trim();
  let agent = proxyAgents.get(key);
  if (!agent) {
    agent = new ProxyAgent(key);
    proxyAgents.set(key, agent);
  }
  return agent;
};

/** Dispatcher for an outbound URL: an explicit proxy wins, then the configured
 * environment proxy, and a direct agent when the host appears in NO_PROXY.
 * Undefined leaves the fetch on the runtime default. */
export const dispatcherFor = (url: string, proxyURL = ''): Dispatcher | undefined => {
  if (proxyURL.trim()) return proxyAgentFor(proxyURL);
  if (!proxyDispatcher) return undefined;
  const hostname = new URL(url).hostname.toLowerCase();
  const bypass = NO_PROXY.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
  return bypass ? directDispatcher : proxyDispatcher;
};

/**
 * Node's global fetch rejects a dispatcher built from another undici copy
 * (`UND_ERR_INVALID_ARG: invalid onRequestStart method`), so proxied requests
 * go through undici's own fetch, the copy that built the dispatcher.
 */
export const httpFetch = (
  url: string,
  init: Parameters<typeof undiciFetch>[1],
): ReturnType<typeof undiciFetch> => undiciFetch(url, init);

/** URL candidates for a provider's model list, in the order to try them. */
export const modelCandidates = (baseURL: string): string[] => {
  const base = baseURL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return [];
  const paths = [`${base}/models`];
  // A bare origin often exposes the OpenAI-compatible list under /v1, while a
  // base URL that already names /v1 must not double it.
  if (!/\/v1$/i.test(base)) paths.push(`${base}/v1/models`);
  return [...new Set(paths)];
};

/** Headers a provider's model endpoint expects, keyed by its protocol. */
export const modelHeaders = (protocol: string, apiKey: string): Record<string, string> => {
  if (protocol === 'anthropic-messages') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      accept: 'application/json',
    };
  }
  return {
    authorization: `Bearer ${apiKey}`,
    accept: 'application/json',
  };
};

const idOf = (item: unknown): string => {
  if (typeof item === 'string') return item.trim();
  if (!item || typeof item !== 'object') return '';
  const record = item as Record<string, unknown>;
  for (const key of ['id', 'model', 'name']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

/** Model IDs from the shapes OpenAI, Anthropic and compatible gateways return. */
export const parseModelIDs = (payload: unknown): string[] => {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : [];
  const ids: string[] = [];
  for (const item of list) {
    const id = idOf(item);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
};

/* ------------------------------------------------------------- model options */

/**
 * One entry of the model picker: the routing ID, the provider's display name
 * when it sends one, the arena.ai agent/code leaderboard row that ranks it, and
 * — for a routing variant such as `:nitro` or `:floor` — the model it serves.
 *
 * Only the arena leaderboard scores models here: benchmark numbers some catalog
 * payloads carry belong to older benchmark versions, so they are ignored.
 */
export type ModelOption = {
  id: string;
  name?: string;
  /** Agent/code leaderboard row (rank and net improvement) when listed there. */
  arena?: ArenaRow;
  /** Base model ID when `id` carries a `:variant` suffix. */
  sameAs?: string;
};

/** The model a `:variant` suffix (`:nitro`, `:floor`, `:free`, `:batch`) serves. */
export const baseModelID = (id: string): string => {
  const index = id.indexOf(':');
  return index > 0 ? id.slice(0, index) : id;
};

/** Model options from the shapes OpenAI, Anthropic and compatible gateways return. */
export const parseModelOptions = (payload: unknown, arena: ArenaRow[] = []): ModelOption[] => {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.models)
        ? record.models
        : [];
  const options: ModelOption[] = [];
  const byID = new Map<string, ModelOption>();
  for (const item of list) {
    const id = idOf(item);
    if (!id || byID.has(id)) continue;
    const option: ModelOption = { id };
    const name = item && typeof item === 'object' ? (item as Record<string, unknown>).name : undefined;
    if (typeof name === 'string' && name.trim()) option.name = name.trim();
    const row = arenaRowFor(id, arena);
    if (row) option.arena = row;
    byID.set(id, option);
    options.push(option);
  }
  // `:nitro` and `:floor` route to the same model, so they carry its
  // leaderboard row and say which model that is.
  for (const option of options) {
    const base = baseModelID(option.id);
    if (base === option.id) continue;
    option.sameAs = base;
    const source = byID.get(base);
    if (!source) continue;
    if (!option.arena) option.arena = source.arena;
  }
  return options;
};

/* -------------------------------------------------------------- router endpoints */

/**
 * One provider endpoint serving a model, normalised from the OpenRouter
 * catalog. Numbers the panel formats (prices per token, throughput, latency)
 * stay nullable: the catalog omits them when nothing was measured yet.
 */
export type RouterEndpoint = {
  /** Routing slug: `provider[/variant][/region][/tier]`, e.g. `deepinfra/turbo`. */
  slug: string;
  providerName: string;
  contextLength: number | null;
  maxCompletionTokens: number | null;
  quantization: string;
  pricing: {
    prompt: number | null;
    completion: number | null;
    cacheRead: number | null;
    discount: number | null;
  };
  supportedParameters: string[];
  status: number | null;
  uptimeLast30m: number | null;
  uptimeLast1d: number | null;
  latencyLast30m: number | null;
  throughputLast30m: number | null;
};

/**
 * The public OpenRouter catalog. Provider routing is an OpenRouter feature, so
 * the endpoint catalog always comes from openrouter.ai, whatever gateway
 * actually serves the model.
 */
export const OPENROUTER_CATALOG = 'https://openrouter.ai/api/v1';

/**
 * The `author` and `slug` of a catalog model ID. OpenRouter addresses models
 * as `author/slug`, and a `:free` style variant suffix rides on the request
 * model and never in the URL, so it is stripped here.
 */
const modelSegments = (modelID: string): { author: string; slug: string } | null => {
  const id = modelID.trim();
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  const author = id.slice(0, slash).trim();
  const slug = id.slice(slash + 1).split(':')[0]!.trim();
  return author && slug ? { author, slug } : null;
};

/** Catalog URL for a model's provider endpoints. */
export const endpointCandidates = (modelID: string, catalogBase = OPENROUTER_CATALOG): string[] => {
  const base = catalogBase.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(base)) return [];
  const segments = modelSegments(modelID);
  if (!segments) return [];
  const { author, slug } = segments;
  return [`${base}/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`];
};

/**
 * The public model page, whose server-rendered payload carries the per-endpoint
 * speed and latency percentiles. The catalog API leaves `throughput_last_30m`
 * and `latency_last_30m` null, so this page is where those numbers come from.
 */
export const modelPageCandidates = (modelID: string, catalogBase = OPENROUTER_CATALOG): string[] => {
  const base = catalogBase.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(base)) return [];
  const segments = modelSegments(modelID);
  if (!segments) return [];
  const origin = new URL(base).origin;
  const { author, slug } = segments;
  return [`${origin}/${encodeURIComponent(author)}/${encodeURIComponent(slug)}`];
};

/**
 * Headers for the catalog request. Reading the list is public, so a missing
 * key must not send an empty bearer; a present key only raises rate limits.
 */
export const endpointHeaders = (apiKey: string): Record<string, string> => {
  const headers: Record<string, string> = { accept: 'application/json' };
  const key = apiKey.trim();
  if (key) headers.authorization = `Bearer ${key}`;
  return headers;
};

const numberOrNull = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

/**
 * A per-token price from the catalog, or null when there is none. OpenRouter
 * writes `-1` (or a negative) when a price is not set, so non-positive values
 * other than a real zero read as "no price" rather than a bogus cap.
 */
const priceOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 0 ? null : value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed < 0 ? null : parsed;
  }
  return null;
};

const slugify = (name: string): string => (
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
);

/** Provider endpoints from the `models/{author}/{slug}/endpoints` response. */
export const parseEndpoints = (payload: unknown): RouterEndpoint[] => {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const data = isRecord(record.data) ? record.data : {};
  const list = Array.isArray(data.endpoints) ? data.endpoints : [];
  const out: RouterEndpoint[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const providerName = typeof item.provider_name === 'string' ? item.provider_name.trim() : '';
    const tag = typeof item.tag === 'string' ? item.tag.trim() : '';
    const slug = tag || slugify(providerName);
    if (!slug || !providerName) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const pricing = isRecord(item.pricing) ? item.pricing : {};
    out.push({
      slug,
      providerName,
      contextLength: numberOrNull(item.context_length),
      maxCompletionTokens: numberOrNull(item.max_completion_tokens),
      quantization: typeof item.quantization === 'string' ? item.quantization : '',
      pricing: {
        prompt: priceOrNull(pricing.prompt),
        completion: priceOrNull(pricing.completion),
        cacheRead: priceOrNull(pricing.input_cache_read),
        discount: priceOrNull(pricing.discount),
      },
      supportedParameters: Array.isArray(item.supported_parameters)
        ? item.supported_parameters.filter((entry): entry is string => typeof entry === 'string')
        : [],
      status: numberOrNull(item.status),
      uptimeLast30m: numberOrNull(item.uptime_last_30m),
      uptimeLast1d: numberOrNull(item.uptime_last_1d),
      latencyLast30m: numberOrNull(item.latency_last_30m),
      throughputLast30m: numberOrNull(item.throughput_last_30m),
    });
  }
  return out;
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

/* ---------------------------------------------------------- endpoint statistics */

/**
 * Measured behaviour of one endpoint over the last 30 minutes. Percentiles,
 * not means: p50 is what a typical request sees. Units match the catalog
 * fields they fill: tokens per second, and seconds to first token.
 */
export type EndpointStat = {
  /** p50 output speed, tokens per second. */
  throughput: number | null;
  /** p50 latency (time to first token), seconds. */
  latency: number | null;
};

const statNumber = (body: string, key: string): number | null => {
  const match = new RegExp(`"${key}":(-?[\\d.]+(?:[eE][-+]?\\d+)?)`).exec(body);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

/**
 * Per-endpoint speed and latency from a server-rendered OpenRouter model page.
 * The catalog API reports both as null, while the page ships its payload as
 * escaped JSON whose endpoint objects name the routing slug in `provider_slug`
 * and follow it with a flat `stats` object. An endpoint without measurements
 * yields no entry, and the panel keeps its dash placeholder.
 */
export const parseEndpointStats = (html: string): Record<string, EndpointStat> => {
  const out: Record<string, EndpointStat> = {};
  if (!html) return out;
  const text = html.replace(/\\"/g, '"');
  const slugs: Array<{ slug: string; index: number }> = [];
  for (const match of text.matchAll(/"provider_slug":"([^"]+)"/g)) {
    slugs.push({ slug: match[1]!.trim(), index: match.index ?? 0 });
  }
  if (slugs.length === 0) return out;
  for (const match of text.matchAll(/"stats":\{([^}]*)\}/g)) {
    const at = match.index ?? 0;
    // A stats object belongs to the last slug the page printed before it.
    let owner = '';
    for (const candidate of slugs) {
      if (candidate.index > at) break;
      owner = candidate.slug;
    }
    if (!owner) continue;
    const body = match[1]!;
    const throughput = statNumber(body, 'p50_throughput');
    // The page measures latency in milliseconds; the catalog field it fills
    // counts seconds.
    const milliseconds = statNumber(body, 'p50_latency');
    const latency = milliseconds === null ? null : milliseconds / 1000;
    if (throughput === null && latency === null) continue;
    out[owner] = { throughput, latency };
  }
  return out;
};

/**
 * Fill the catalog's empty speed cells from the page measurements; a value the
 * catalog already reports stays authoritative.
 */
export const mergeEndpointStats = (
  endpoints: RouterEndpoint[],
  stats: Record<string, EndpointStat>,
): RouterEndpoint[] => endpoints.map((endpoint) => {
  const stat = stats[endpoint.slug];
  if (!stat) return endpoint;
  return {
    ...endpoint,
    throughputLast30m: endpoint.throughputLast30m ?? stat.throughput,
    latencyLast30m: endpoint.latencyLast30m ?? stat.latency,
  };
});
