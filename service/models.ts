/**
 * Pure helpers for the model-list and provider-endpoint requests, plus the
 * outbound dispatcher: the cluster firewalls direct egress, so a fetch may
 * need the standard proxy environment variables.
 */
import { Agent, ProxyAgent, type Dispatcher } from 'undici';

const PROXY_URL = process.env.HTTPS_PROXY ?? process.env.https_proxy
  ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? '';
const NO_PROXY = (process.env.NO_PROXY ?? process.env.no_proxy ?? '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase().replace(/^\./, ''))
  .filter(Boolean);

const proxyDispatcher = PROXY_URL ? new ProxyAgent(PROXY_URL) : undefined;
const directDispatcher = new Agent();

/** Dispatcher for an outbound URL: the configured proxy, or a direct agent
 * when the host appears in NO_PROXY. Undefined when no proxy is configured,
 * which leaves the fetch on the runtime default. */
export const dispatcherFor = (url: string): Dispatcher | undefined => {
  if (!proxyDispatcher) return undefined;
  const hostname = new URL(url).hostname.toLowerCase();
  const bypass = NO_PROXY.some((entry) => hostname === entry || hostname.endsWith(`.${entry}`));
  return bypass ? directDispatcher : proxyDispatcher;
};

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
 * Catalog URL for a model's provider endpoints. OpenRouter addresses the
 * catalog as `models/{author}/{slug}/endpoints`, so the model ID must be
 * `author/slug`; a `:free` style variant suffix rides on the request model
 * and never in the URL, so it is stripped here.
 */
export const endpointCandidates = (baseURL: string, modelID: string): string[] => {
  const base = baseURL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/\S+$/i.test(base)) return [];
  const id = modelID.trim();
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return [];
  const author = id.slice(0, slash).trim();
  const slug = id.slice(slash + 1).split(':')[0]!.trim();
  if (!author || !slug) return [];
  return [`${base}/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`];
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
