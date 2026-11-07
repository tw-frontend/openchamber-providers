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
import { modelCandidates, modelHeaders, parseModelIDs, endpointCandidates, endpointHeaders, parseEndpoints, type RouterEndpoint } from './models';

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
const requestPayload = async (url: string, headers: Record<string, string>): Promise<unknown> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal,
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
    try {
      return JSON.parse(text);
    } catch {
      throw new ServiceError(502, 'The endpoint did not return JSON.');
    }
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ServiceError(504, 'The endpoint did not answer in time.');
    }
    throw new ServiceError(502, error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
};

const requestModels = async (url: string, protocol: string, apiKey: string): Promise<string[]> => {
  const payload = await requestPayload(url, modelHeaders(protocol, apiKey));
  const models = parseModelIDs(payload);
  if (models.length === 0) {
    throw new ServiceError(502, 'The endpoint returned no model IDs.');
  }
  return models;
};

const requestEndpoints = async (url: string, apiKey: string): Promise<RouterEndpoint[]> => {
  const payload = await requestPayload(url, endpointHeaders(apiKey));
  return parseEndpoints(payload);
};

const handleModels = async (body: string): Promise<string[]> => {
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
 * Provider endpoints for one router model. Reading the OpenRouter catalog is
 * public, so the API key is optional here: it is sent when the panel has one
 * and omitted otherwise.
 */
const handleProviders = async (body: string): Promise<RouterEndpoint[]> => {
  let request: FetchRequest;
  try {
    request = JSON.parse(body) as FetchRequest;
  } catch {
    throw new ServiceError(400, 'Expected a JSON body.');
  }
  const baseURL = typeof request.baseURL === 'string' ? request.baseURL.trim() : '';
  const modelID = typeof request.modelID === 'string' ? request.modelID.trim() : '';
  const apiKey = typeof request.apiKey === 'string' ? resolveKey(request.apiKey) : '';
  if (!baseURL) throw new ServiceError(400, 'Base URL is required.');
  if (!modelID) throw new ServiceError(400, 'Model ID is required.');
  const urls = endpointCandidates(baseURL, modelID);
  if (urls.length === 0) {
    throw new ServiceError(400, 'Model ID must look like author/slug, e.g. meta-llama/llama-3.3-70b-instruct.');
  }
  return requestEndpoints(urls[0]!, apiKey);
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
