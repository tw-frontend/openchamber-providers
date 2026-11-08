/**
 * Regenerate `service/arena-snapshot.json` from the arena.ai agent/code
 * leaderboard.
 *
 * The page sits behind a browser challenge, so this works only from a network
 * Cloudflare admits (a browser-like request from a trusted address) or through
 * a proxy that does. When it fails, the committed snapshot stays as it was and
 * the command exits non-zero with the reason.
 *
 *   npm run arena:refresh                 # HTTPS_PROXY / ARENA_PROXY honoured
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetch as undiciFetch } from 'undici';
import { dispatcherFor } from '../service/models';
import { ARENA_PAGE_URL, arenaHeaders, parseArenaLeaderboard } from '../service/arena';

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/5.140.179.13 Safari/537.36';

const main = async (): Promise<void> => {
  const proxy = (process.env.ARENA_PROXY ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '').trim();
  const response = await undiciFetch(ARENA_PAGE_URL, {
    headers: { ...arenaHeaders(), 'user-agent': USER_AGENT },
    redirect: 'follow',
    dispatcher: dispatcherFor(ARENA_PAGE_URL, proxy),
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(
      `arena.ai answered HTTP ${response.status}: the site challenges non-browser clients. `
      + 'Run this from a network it admits, or set ARENA_PROXY to one that does. Snapshot left unchanged.',
    );
    process.exitCode = 1;
    return;
  }
  const snapshot = parseArenaLeaderboard(text);
  if (snapshot.rows.length === 0) {
    console.error('The payload carried no leaderboard rows. Snapshot left unchanged.');
    process.exitCode = 1;
    return;
  }
  const target = join(process.cwd(), 'service', 'arena-snapshot.json');
  writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`arena snapshot: ${snapshot.rows.length} rows, updated ${snapshot.updated ?? 'unknown'}`);
};

void main().catch((error: unknown) => {
  console.error(`arena refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
