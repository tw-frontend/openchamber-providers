/**
 * Local model-list service.
 *
 * The panel runs in a sandboxed iframe with an opaque origin, so it cannot call
 * an arbitrary provider itself. OpenChamber starts this small loopback process
 * on demand and proxies the panel's authenticated `POST /models` through it.
 * The service makes one GET request to the provider's model endpoint and
 * returns the IDs; it keeps no key and logs no request body.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  modelCandidates,
  modelHeaders,
  parseModelOptions,
  endpointCandidates,
  modelPageCandidates,
  endpointHeaders,
  parseEndpoints,
  parseEndpointStats,
  mergeEndpointStats,
  dispatcherFor,
  httpFetch,
  type EndpointStat,
  type ModelOption,
  type RouterEndpoint,
} from './models';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? 0);
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
const BODY_MAX = 64 * 1024;
const RESPONSE_MAX = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

type FetchRequest = {
  baseURL?: unknown;
  apiKey?: unknown;
  protocol?: unknown;
  modelID?: unknown;
  /** Optional proxy for the catalog request, as `http(s)://host:port`. */
  proxy?: unknown;
};

class ServiceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.destroyed || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
};

const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let size = 0;
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > BODY_MAX) {
      reject(new ServiceError(413, 'The request body is too large.'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

/** Resolve the key references OpenCode accepts, so Fetch works with them too. */
const resolveKey = (value: string): string => {
  const env = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (env) {
    const key = process.env[env[1]];
    if (!key) throw new ServiceError(400, `Environment variable ${env[1]} is not set for the service.`);
    return key.trim();
  }
  const file = /^\{file:(.+)\}$/.exec(value);
  if (file) {
    let path = file[1].trim();
    if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      throw new ServiceError(400, `Could not read the API key file: ${path}`);
    }
  }
  return value.trim();
};

/** One GET to a catalog endpoint, with the error mapping both handlers share. */
const requestText = async (url: string, headers: Record<string, string>, proxy = ''): Promise<string> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await httpFetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
      dispatcher: dispatcherFor(url, proxy),
    });
    const text = await response.text();
    if (text.length > RESPONSE_MAX) {
      throw new ServiceError(502, 'The endpoint response is too large.');
    }
    if (!response.ok) {
      // Do not repeat an auth body: it can echo the key or account details.
      const detail = response.status === 401 || response.status === 403
        ? ''
        : text.trim().replace(/\s+/g, ' ').slice(0, 200);
      const statusText = response.statusText ? ` ${response.statusText}` : '';
      throw new ServiceError(
        response.status === 401 || response.status === 403 ? 401 : 502,
        `HTTP ${response.status}${statusText}${detail ? `: ${detail}` : ''}`,
      );
    }
    return text;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ServiceError(504, 'The endpoint did not answer in time.');
    }
    // A proxy or TLS failure hides its reason one level down; keep it, since
    // it is what a coworker needs to fix the proxy setting.
    const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const detail = cause instanceof Error ? `: ${cause.message}` : '';
    throw new ServiceError(502, `${error instanceof Error ? error.message : String(error)}${detail}`);
  } finally {
    clearTimeout(timer);
  }
};

const requestPayload = async (url: string, headers: Record<string, string>, proxy = ''): Promise<unknown> => {
  const text = await requestText(url, headers, proxy);
  try {
    return JSON.parse(text);
  } catch {
    throw new ServiceError(502, 'The endpoint did not return JSON.');
  }
};

const requestModels = async (url: string, protocol: string, apiKey: string): Promise<ModelOption[]> => {
  const payload = await requestPayload(url, modelHeaders(protocol, apiKey));
  const models = parseModelOptions(payload);
  if (models.length === 0) {
    throw new ServiceError(502, 'The endpoint returned no model IDs.');
  }
  return models;
};

const requestEndpoints = async (url: string, proxy: string): Promise<RouterEndpoint[]> => {
  // The catalog is public: never send a provider key to openrouter.ai.
  const payload = await requestPayload(url, endpointHeaders(''), proxy);
  return parseEndpoints(payload);
};

/** Speed and latency from the model page; a page without them yields none. */
const requestEndpointStats = async (url: string, proxy: string): Promise<Record<string, EndpointStat>> => {
  const html = await requestText(url, { accept: 'text/html' }, proxy);
  return parseEndpointStats(html);
};

const handleModels = async (body: string): Promise<ModelOption[]> => {
  let request: FetchRequest;
  try {
    request = JSON.parse(body) as FetchRequest;
  } catch {
    throw new ServiceError(400, 'Expected a JSON body.');
  }
  const baseURL = typeof request.baseURL === 'string' ? request.baseURL.trim() : '';
  const apiKey = typeof request.apiKey === 'string' ? resolveKey(request.apiKey) : '';
  const protocol = typeof request.protocol === 'string' ? request.protocol : 'openai-chat';
  if (!baseURL) throw new ServiceError(400, 'Base URL is required.');
  if (!apiKey) throw new ServiceError(400, 'API key is required.');
  const urls = modelCandidates(baseURL);
  if (urls.length === 0) throw new ServiceError(400, 'Base URL must start with http:// or https://.');

  let last: ServiceError | null = null;
  for (const url of urls) {
    try {
      return await requestModels(url, protocol, apiKey);
    } catch (error) {
      const failure = error instanceof ServiceError ? error : new ServiceError(502, String(error));
      last = failure;
      // A rejected key or a timeout will not improve on a second path.
      if (failure.status === 401 || failure.status === 504) break;
    }
  }
  throw last ?? new ServiceError(502, 'Could not fetch the model list.');
};

/**
 * Provider endpoints for one router model. The catalog lives on openrouter.ai
 * and is public, so no provider key is sent there; the optional proxy is the
 * panel's per-provider setting and beats the environment proxy variables.
 */
const handleProviders = async (body: string): Promise<RouterEndpoint[]> => {
  let request: FetchRequest;
  try {
    request = JSON.parse(body) as FetchRequest;
  } catch {
    throw new ServiceError(400, 'Expected a JSON body.');
  }
  const modelID = typeof request.modelID === 'string' ? request.modelID.trim() : '';
  const proxy = typeof request.proxy === 'string' ? request.proxy.trim() : '';
  if (!modelID) throw new ServiceError(400, 'Model ID is required.');
  const urls = endpointCandidates(modelID);
  if (urls.length === 0) {
    throw new ServiceError(400, 'Model ID must look like author/slug, e.g. meta-llama/llama-3.3-70b-instruct.');
  }
  if (proxy && !/^https?:\/\/\S+$/i.test(proxy)) {
    throw new ServiceError(400, 'Proxy must be an http(s) URL, e.g. http://localhost:10808.');
  }
  // The page carries the speed and latency the catalog API leaves null; the
  // page failing must not cost the price list, so it is best effort.
  const pageURLs = modelPageCandidates(modelID);
  const [endpoints, stats] = await Promise.all([
    requestEndpoints(urls[0]!, proxy),
    pageURLs.length > 0
      ? requestEndpointStats(pageURLs[0]!, proxy).catch(() => ({} as Record<string, EndpointStat>))
      : Promise.resolve({} as Record<string, EndpointStat>),
  ]);
  return mergeEndpointStats(endpoints, stats);
};

const server = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      send(res, 401, { error: 'Unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/models') {
      const models = await handleModels(await readBody(req));
      send(res, 200, { models });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/providers') {
      const endpoints = await handleProviders(await readBody(req));
      send(res, 200, { endpoints });
      return;
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    const failure = error instanceof ServiceError
      ? error
      : new ServiceError(500, error instanceof Error ? error.message : String(error));
    send(res, failure.status, { error: failure.message });
  }
});

if (!PORT || !TOKEN) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required.');
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OpenChamber Providers model service listening on 127.0.0.1:${PORT}`);
});
