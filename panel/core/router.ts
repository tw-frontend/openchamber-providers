/**
 * Provider routing helpers behind the per-model provider picker.
 *
 * Pure data code: gate the feature on the base URL, parse manual slug
 * input, format the catalog numbers the panel shows, and order endpoints
 * for display. The routing slugs are OpenRouter endpoint slugs
 * (`deepinfra/turbo`, `google-vertex/us-east5`) used inside the
 * request-body `provider` object.
 */
import type { RouterEndpoint } from '../../service/models';

/**
 * True when the base URL can carry OpenRouter-style provider routing. The
 * overlay is opt-in per model, so any http(s) endpoint qualifies — a
 * self-hosted OpenRouter-compatible gateway included; the request still
 * goes to whatever base URL the provider names.
 */
export const isRouterBaseURL = (baseURL: string): boolean => {
  try {
    const url = new URL(baseURL.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.hostname !== '';
  } catch {
    return false;
  }
};

/**
 * A per-token price from the catalog (e.g. `"0.0000001"`) as dollars per
 * million tokens, the unit OpenRouter quotes. Null stays null.
 */
export const perMillion = (value: number | null): number | null => (
  value === null ? null : value * 1_000_000
);

/** Price text for one direction: `$0.32`, `$14.00`, `$0.0002`, `—`. */
export const priceText = (perToken: number | null): string => {
  const value = perMillion(perToken);
  if (value === null || value < 0) return '—';
  if (value === 0) return '$0';
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  if (value >= 0.0001) return `$${value.toFixed(4)}`;
  return `$${value.toPrecision(2)}`;
};

/** Output speed text: `47 tok/s`, `9.5 tok/s`, `—`. */
export const throughputText = (tokensPerSecond: number | null): string => {
  if (tokensPerSecond === null || tokensPerSecond <= 0) return '—';
  return tokensPerSecond >= 10
    ? `${Math.round(tokensPerSecond)} tok/s`
    : `${tokensPerSecond.toFixed(1)} tok/s`;
};

/** Time-to-first-token text: `0.4s`, `—`. */
export const latencyText = (seconds: number | null): string => (
  seconds !== null && seconds >= 0 ? `${seconds.toFixed(1)}s` : '—'
);

/** Uptime share over the last 30 minutes: `100%`, `97%`. */
export const uptimeText = (percent: number | null): string => (
  percent !== null && percent >= 0 ? `${Math.round(percent)}%` : '—'
);

/** Context window text: `131k`, `1M`. */
export const contextText = (tokens: number | null): string => {
  if (tokens === null || tokens <= 0) return '—';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}k`;
};

export type RouterSort = 'default' | 'price' | 'speed';

/**
 * Endpoint order for display: catalog order, cheapest total price first, or
 * fastest measured throughput first. Endpoints without the measurement sink
 * to the end under both sorts.
 */
export const sortEndpoints = (endpoints: readonly RouterEndpoint[], sort: RouterSort): RouterEndpoint[] => {
  if (sort === 'default') return [...endpoints];
  const total = (endpoint: RouterEndpoint): number => (
    (endpoint.pricing.prompt ?? Infinity) + (endpoint.pricing.completion ?? Infinity)
  );
  const speed = (endpoint: RouterEndpoint): number => (
    endpoint.throughputLast30m ?? -1
  );
  const sorted = [...endpoints];
  if (sort === 'price') {
    sorted.sort((left, right) => total(left) - total(right));
  } else {
    sorted.sort((left, right) => speed(right) - speed(left) || total(left) - total(right));
  }
  return sorted;
};
