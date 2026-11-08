/**
 * The arena.ai agent/code leaderboard.
 *
 * The site sits behind a browser challenge, so the extension does not call it
 * from the service: a snapshot of the leaderboard is published with the
 * repository and the service re-reads that snapshot on every Fetch (kept ten
 * minutes), falling back to the copy bundled at build time. `arena:refresh`
 * regenerates the snapshot from the page's React Server Components payload,
 * which carries the same rows the table renders.
 */
export const ARENA_PAGE_URL = 'https://arena.ai/leaderboard/agent/code';

/** Where the refresh reads the rows: the page's RSC variant. */
export const arenaHeaders = (): Record<string, string> => ({
  rsc: '1',
  accept: 'text/x-component',
});

/** The snapshot the service reads before a Fetch; bundled copy is the fallback. */
export const ARENA_SNAPSHOT_URL =
  'https://raw.githubusercontent.com/tw-frontend/openchamber-providers/main/service/arena-snapshot.json';

export type ArenaRow = {
  rank: number;
  name: string;
  organization?: string;
  /** Net improvement over the baseline, as a percentage (23.38). */
  score: number;
  sessions?: number;
};

export type ArenaSnapshot = {
  updated?: string;
  rows: ArenaRow[];
};

export const EMPTY_ARENA: ArenaSnapshot = { rows: [] };

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const asText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const rowOf = (item: unknown): ArenaRow | undefined => {
  if (!item || typeof item !== 'object') return undefined;
  const row = item as Record<string, unknown>;
  const rank = asNumber(row.rank);
  const name = asText(row.name);
  const score = asNumber(row.score);
  if (rank === undefined || !name || score === undefined) return undefined;
  const entry: ArenaRow = { rank, name, score };
  const organization = asText(row.organization);
  if (organization) entry.organization = organization;
  const sessions = asNumber(row.sessions);
  if (sessions !== undefined) entry.sessions = sessions;
  return entry;
};

/** The published snapshot (`arena-snapshot.json`): `{ updated, rows: […] }`. */
export const parseArenaSnapshot = (data: unknown): ArenaSnapshot => {
  let value = data;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return EMPTY_ARENA;
    }
  }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const list = Array.isArray(record.rows) ? record.rows : [];
  const rows: ArenaRow[] = [];
  for (const item of list) {
    const row = rowOf(item);
    if (row) rows.push(row);
  }
  rows.sort((left, right) => left.rank - right.rank);
  const updated = asText(record.updated);
  return updated ? { updated, rows } : { rows };
};

/** The balanced `{…}` or `[…]` that follows `"key":`, or null. */
const sliceValue = (payload: string, key: string, open: '{' | '['): string | null => {
  const at = payload.indexOf(`"${key}":${open}`);
  if (at < 0) return null;
  const start = at + key.length + 3;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < payload.length; index += 1) {
    const char = payload[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return payload.slice(start, index + 1);
    }
  }
  return null;
};

/**
 * The leaderboard inside the page's RSC payload. Each row carries the display
 * name, a rank, the average net improvement as a 0–1 fraction with its
 * confidence interval, and the session count.
 */
export const parseArenaLeaderboard = (payload: string): ArenaSnapshot => {
  const raw = sliceValue(payload, 'snapshot', '{');
  if (!raw) return EMPTY_ARENA;
  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return EMPTY_ARENA;
  }
  const list = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const rows: ArenaRow[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const avg = row.avgScore && typeof row.avgScore === 'object' ? row.avgScore as Record<string, unknown> : {};
    const value = asNumber(avg.value);
    const name = asText(row.model);
    const rank = asNumber(row.rank);
    if (value === undefined || !name || rank === undefined) continue;
    const entry: ArenaRow = { rank, name, score: value * 100 };
    const organization = asText(row.modelOrganization);
    if (organization) entry.organization = organization;
    const sessions = asNumber(row.sessions);
    if (sessions !== undefined) entry.sessions = sessions;
    rows.push(entry);
  }
  rows.sort((left, right) => left.rank - right.rank);
  const updated = asText(snapshot.lastUpdated);
  return updated ? { updated, rows } : { rows };
};

/* ------------------------------------------------------------ model matching */

const compact = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** `(Max)`, `(High)` … name the effort level, not another model. */
const stripTuning = (name: string): string =>
  name.replace(/\((?:max|high|xhigh|low|medium|none|thinking|no thinking)\)/gi, '');

/** A trailing run of digits longer than a model number: a release date. */
const stripDate = (key: string): string => key.replace(/\d{3,}$/, '');

/**
 * The leaderboard row serving a model ID. The leaderboard names models the way
 * people do (`Claude Fable 5.1 (Max)`), so the ID's slug and the name are
 * compared compacted; a release date at the end is ignored.
 */
export const arenaRowFor = (modelID: string, rows: ArenaRow[]): ArenaRow | undefined => {
  const full = compact(modelID);
  const slug = compact(modelID.split('/').pop() ?? modelID);
  const dated = stripDate(slug);
  for (const row of rows) {
    const key = compact(stripTuning(row.name));
    if (key === slug || key === full) return row;
  }
  if (dated.length < 8) return undefined;
  for (const row of rows) {
    const key = stripDate(compact(stripTuning(row.name)));
    if (key === dated) return row;
  }
  return undefined;
};
