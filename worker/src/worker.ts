// The Cloudflare Worker behind Krascha's List. It serves the public page at
// /, every rank at /ranks, every achievement at /achievements, the hunt and
// the adoption at /judgment, the board as JSON at /api/board, the newest
// CLI build at /api/version, takes uploads and removals at /api/scores and likes at /api/likes. An upload proves who it
// belongs to one of two ways. A GitHub token is checked once with GitHub and
// then dropped, never stored or logged, and its entry shows as verified and
// links to the account, so only the user id and login are kept. The same
// check asks GitHub whether they got a pull request merged into Krascha,
// whether theirs was the first, and whether they pushed a commit with Claude as
// a co-author. A key the CLI
// made up is stored only as a hash, so it ties uploads together without saying
// who anyone is.

import { COUNTED_ACHIEVEMENTS, SHANEP } from '../../src/shared/achievements.js';
import type { KnownAchievement } from '../../src/shared/leaderboard.js';
import {
  FEATURES,
  GITHUB_LOGIN_PATTERN,
  isScoreUpload,
  KEY_PATTERN,
  MIN_UPLOAD_FEATURES,
  NEW_ENTRIES_PER_DAY,
  TOO_OLD,
  UPLOADS_PER_DAY,
} from '../../src/shared/leaderboard.js';

import {
  renderAbout,
  renderAchievements,
  renderContribute,
  renderJudgment,
  renderPage,
  renderRanks,
} from './page.js';
import type { D1Database, Owner } from './store.js';
import { cleanName, likeEntry, readBoard, removeScore, saveScore, utcDay } from './store.js';

export interface Env {
  readonly DB: D1Database;
  /** The commit this deploy came from, so the CLI can fetch its dist/cli.js from GitHub. */
  readonly LATEST_COMMIT?: string;
  /** The SHA-256 of that commit's dist/cli.js, so the CLI can check what it fetched. */
  readonly LATEST_SHA256?: string;
}

/** Where a merged pull request earns Miles Dyson. */
const REPO = 'shanep/krascha';

/** Sent with the board and each upload, so a CLI older than this deploy can tell it is behind. */
const COUNTED: readonly KnownAchievement[] = COUNTED_ACHIEVEMENTS.map(({ id, name }) => ({
  id,
  name,
}));

/** What the handler needs from the outside, so tests can stand in for GitHub and the clock. */
export interface Deps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly now: () => number;
  readonly newId: () => string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(body: unknown, status = 200, cache = 'no-store'): Response {
  return Response.json(body, {
    status,
    headers: { ...JSON_HEADERS, 'cache-control': cache },
  });
}

function fail(status: number, error: string): Response {
  return json({ error }, status);
}

/** Hex SHA-256 of some text. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The numeric id and login from GitHub's user response, the only fields kept. */
function githubUserOf(user: unknown): { readonly id: number; readonly login: string } | null {
  if (typeof user !== 'object' || user === null) {
    return null;
  }
  const id: unknown = Reflect.get(user, 'id');
  const login: unknown = Reflect.get(user, 'login');
  return typeof id === 'number' && typeof login === 'string' && GITHUB_LOGIN_PATTERN.test(login)
    ? { id, login }
    : null;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'krascha',
  };
}

/**
 * Whether GitHub lists a pull request by this login merged into Krascha, or
 * null when the search fails. The login comes from the same token, so it is
 * the account's own.
 */
async function mergedPull(token: string, login: string, deps: Deps): Promise<boolean | null> {
  const query = encodeURIComponent(`repo:${REPO} is:pr is:merged author:${login}`);
  const response = await deps.fetch(`https://api.github.com/search/issues?q=${query}&per_page=1`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    return null;
  }
  const found: unknown = await response.json();
  const total: unknown =
    typeof found === 'object' && found !== null ? Reflect.get(found, 'total_count') : undefined;
  return typeof total === 'number' ? total > 0 : null;
}

/**
 * Whether GitHub finds a commit by this login with Claude as a co-author, or
 * null when the search fails. Claude Code signs its commits with a
 * Co-Authored-By trailer at noreply@anthropic.com.
 */
async function claudeCommit(token: string, login: string, deps: Deps): Promise<boolean | null> {
  const query = encodeURIComponent(`"co-authored-by" "noreply@anthropic.com" author:${login}`);
  const response = await deps.fetch(`https://api.github.com/search/commits?q=${query}&per_page=1`, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    return null;
  }
  const found: unknown = await response.json();
  const total: unknown =
    typeof found === 'object' && found !== null ? Reflect.get(found, 'total_count') : undefined;
  return typeof total === 'number' ? total > 0 : null;
}

/**
 * Who opened one pull request in GitHub's list and when it was merged, or
 * null when it was not merged or came from Shane or a bot.
 */
function mergedBy(pull: unknown): { readonly id: number; readonly at: string } | null {
  if (typeof pull !== 'object' || pull === null) {
    return null;
  }
  const at: unknown = Reflect.get(pull, 'merged_at');
  const user: unknown = Reflect.get(pull, 'user');
  const id: unknown = typeof user === 'object' && user !== null ? Reflect.get(user, 'id') : null;
  const type: unknown =
    typeof user === 'object' && user !== null ? Reflect.get(user, 'type') : null;
  return typeof at === 'string' && typeof id === 'number' && id !== SHANEP && type !== 'Bot'
    ? { id, at }
    : null;
}

/**
 * Whether this GitHub user id is behind the first pull request merged into
 * Krascha, or null when GitHub could not say. It reads the oldest 100 closed
 * pull requests and takes the earliest merge, since GitHub only sorts them by
 * when they were opened.
 */
async function firstMerge(token: string, id: number, deps: Deps): Promise<boolean | null> {
  const response = await deps.fetch(
    `https://api.github.com/repos/${REPO}/pulls?state=closed&sort=created&direction=asc&per_page=100`,
    { headers: githubHeaders(token) },
  );
  if (!response.ok) {
    return null;
  }
  const pulls: unknown = await response.json();
  if (!Array.isArray(pulls)) {
    return null;
  }
  const first = pulls
    .map((pull) => mergedBy(pull))
    .filter((merge) => merge !== null)
    .toSorted((a, b) => a.at.localeCompare(b.at))[0];
  return first === undefined ? false : first.id === id;
}

async function githubOwner(token: string, deps: Deps): Promise<Owner | null> {
  const response = await deps.fetch('https://api.github.com/user', {
    headers: githubHeaders(token),
  });
  const user = response.ok ? githubUserOf(await response.json()) : null;
  if (user === null) {
    return null;
  }
  const contributor = await mergedPull(token, user.login, deps);
  return {
    id: `github:${String(user.id)}`,
    verified: true,
    github: user.login,
    contributor,
    // Only a contributor can be first, so everyone else skips the second call.
    first: contributor === true ? await firstMerge(token, user.id, deps) : contributor,
    collaborator: await claudeCommit(token, user.login, deps),
  };
}

/**
 * Who sent the request: "Bearer <GitHub token>" or "Key <key>". Null when
 * there is no credential, GitHub turns the token down, or the key is malformed.
 */
async function ownerOf(request: Request, deps: Deps): Promise<Owner | null> {
  const match = /^(Bearer|Key) (\S+)$/u.exec(request.headers.get('authorization') ?? '');
  const [, scheme, secret] = match ?? [];
  if (secret === undefined) {
    return null;
  }
  if (scheme === 'Bearer') {
    return githubOwner(secret, deps);
  }
  return KEY_PATTERN.test(secret)
    ? { id: `key:${await sha256(secret)}`, verified: false, github: null }
    : null;
}

const NO_OWNER =
  'Send a GitHub token or a Krascha key. GitHub did not accept the token, if you sent one.';

// Every copy of Krascha prints this word for word, back to the first one, so
// it is the only way to reach a copy too old to update himself.
const UPDATE_FIRST =
  'This copy of Krascha is too old for the board. Run claude plugin update krascha@shanep or copilot plugin update krascha@shanep in a terminal, restart your agent and upload again.';

async function upload(request: Request, env: Env, deps: Deps): Promise<Response> {
  const owner = await ownerOf(request, deps);
  if (owner === null) {
    return fail(401, NO_OWNER);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'The upload is not JSON.');
  }
  if (!isScoreUpload(body)) {
    return fail(
      400,
      'The upload needs a short name, whole, non-negative counts, a sane token average, a short list of achievements and how many times each was earned, a short list of agents and a machine id that looks like a Krascha key.',
    );
  }
  if ((body.features ?? 0) < MIN_UPLOAD_FEATURES) {
    return fail(TOO_OLD, UPDATE_FIRST);
  }
  // Only these fields are kept, whatever else the body holds.
  const {
    name,
    kind,
    mean,
    prompts,
    achievements = [],
    repeats = {},
    tokensPerDay = 0,
    tools = [],
    machine,
    copies = 0,
    sorryAt,
  } = body;
  const now = deps.now();
  // The address is only hashed with the day, for the cap on new unverified entries.
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const saved = await saveScore(env.DB, {
    owner,
    upload: {
      name,
      kind,
      mean,
      prompts,
      achievements,
      repeats,
      tokensPerDay,
      tools,
      copies,
      ...(machine === undefined ? {} : { machine }),
      ...(sorryAt === undefined ? {} : { sorryAt }),
    },
    now,
    newId: deps.newId,
    origin: await sha256(`${utcDay(now)} ${address}`),
  });
  if (!saved.ok && saved.reason === 'new-entries') {
    return fail(
      429,
      `Only ${String(NEW_ENTRIES_PER_DAY)} new entries without GitHub can come from one network a day. Try again tomorrow (UTC), or upload with gh signed in.`,
    );
  }
  if (!saved.ok && saved.reason === 'name-taken') {
    return fail(
      409,
      `Someone checked with GitHub is on the board as ${cleanName(name)}. Pick another name, or upload with gh signed in if that is you.`,
    );
  }
  if (!saved.ok) {
    return fail(
      429,
      `You can upload ${String(UPLOADS_PER_DAY)} times a day. Try again tomorrow (UTC).`,
    );
  }
  return json({ ...saved.standing, counted: COUNTED, features: FEATURES }, 201);
}

async function remove(request: Request, env: Env, deps: Deps): Promise<Response> {
  const owner = await ownerOf(request, deps);
  if (owner === null) {
    return fail(401, NO_OWNER);
  }
  await removeScore(env.DB, owner);
  return new Response(null, { status: 204 });
}

/**
 * Likes an entry on the board, named by the form's entry field. The page's
 * script asks for JSON and gets the new count. A plain form post goes back to
 * the board.
 */
async function like(request: Request, env: Env, deps: Deps): Promise<Response> {
  let entry: unknown;
  try {
    entry = (await request.formData()).get('entry');
  } catch {
    return fail(400, 'Send the entry to like as a form.');
  }
  if (typeof entry !== 'string') {
    return fail(400, 'Send the entry to like as a form.');
  }
  const day = utcDay(deps.now());
  // The address is only hashed with the day and the entry, so a network likes each entry once a day.
  const address = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const likes = await likeEntry(env.DB, {
    entry,
    day,
    liker: await sha256(`${day} ${address} ${entry}`),
  });
  if (likes === null) {
    return fail(404, 'Nobody on the board has that id.');
  }
  return (request.headers.get('accept') ?? '').includes('application/json')
    ? json({ likes })
    : new Response(null, { status: 303, headers: { location: '/' } });
}

/**
 * Answers a request. URL filters and link checkers often send HEAD, so it gets
 * the GET answer without the body.
 */
export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  // www is only an alias, so send it to the bare domain and keep one address for the board.
  const url = new URL(request.url);
  if (url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice('www.'.length);
    return Response.redirect(url.toString(), 301);
  }
  if (request.method !== 'HEAD') {
    return answer(request, env, deps);
  }
  const response = await answer(new Request(request, { method: 'GET' }), env, deps);
  return new Response(null, { status: response.status, headers: response.headers });
}

async function answer(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  switch (route) {
    case 'GET /': {
      const board = await readBoard(env.DB, null, deps.now());
      return new Response(renderPage(board, deps.now()), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=60',
        },
      });
    }
    case 'GET /about': {
      return new Response(renderAbout(), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=60',
        },
      });
    }
    case 'GET /ranks': {
      const board = await readBoard(env.DB, null, deps.now());
      return new Response(renderRanks(board), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=60',
        },
      });
    }
    case 'GET /achievements': {
      const board = await readBoard(env.DB, null, deps.now());
      return new Response(renderAchievements(board), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=60',
        },
      });
    }
    case 'GET /judgment': {
      const board = await readBoard(env.DB, null, deps.now());
      return new Response(renderJudgment(board), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=60',
        },
      });
    }
    case 'GET /contribute': {
      return new Response(renderContribute(), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=60',
        },
      });
    }
    case 'GET /api/board': {
      const me = url.searchParams.get('me');
      const board = await readBoard(env.DB, me === '' ? null : me, deps.now());
      const cache = me === null ? 'public, max-age=60' : 'no-store';
      return json({ ...board, counted: COUNTED, features: FEATURES }, 200, cache);
    }
    case 'GET /api/version': {
      const commit = env.LATEST_COMMIT ?? '';
      const sha256 = env.LATEST_SHA256 ?? '';
      if (commit === '' || sha256 === '') {
        return fail(404, 'This deploy does not know its build.');
      }
      return json({ commit, sha256 }, 200, 'public, max-age=300');
    }
    case 'POST /api/scores': {
      return upload(request, env, deps);
    }
    case 'DELETE /api/scores': {
      return remove(request, env, deps);
    }
    case 'POST /api/likes': {
      return like(request, env, deps);
    }
    default: {
      return fail(404, 'Nothing here.');
    }
  }
}

const live: Deps = {
  fetch: async (url, init) => fetch(url, init),
  now: () => Date.now(),
  newId: () => crypto.randomUUID(),
};

// Cloudflare runs a module Worker from its default export.
// eslint-disable-next-line import-x/no-default-export -- the Workers runtime needs it
export default {
  fetch: async (request: Request, env: Env): Promise<Response> => handle(request, env, live),
};
