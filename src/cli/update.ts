// Krascha updates himself. The board names the newest build that passed CI:
// its commit and the SHA-256 of its dist/cli.js. Every few hours he asks, and
// when that is not the build he is running, he downloads its dist/cli.js from
// GitHub at that commit, checks the hash and keeps the copy in his data
// folder. The plugin's dist/cli.js runs that copy in place of itself, so an
// update needs no restart and no help from Claude Code or Copilot CLI.

import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { readOptional, writeFileAtomic } from '../files.js';
import type { FetchFunction } from '../leaderboard/client.js';
import type { ToolId } from '../shared/tools.js';
import { TOOLS } from '../shared/tools.js';

export const UPDATE_FILE = 'update.json';
/** .mjs, since the data folder has no package.json to say the copy is a module. */
export const COPY_FILE = path.join('bin', 'cli.mjs');
/** How often Krascha asks the board for the newest build. */
export const CHECK_MS = 6 * 3_600_000;
const CHECK_TIMEOUT_MS = 2_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const SOURCE = 'https://raw.githubusercontent.com/shanep/krascha';

/** What updates the plugin in each agent, so its other files, like the skill, keep up too. */
export const UPDATE: Readonly<Record<ToolId, readonly string[]>> = {
  claude: ['claude', 'plugin', 'update', 'krascha@shanep'],
  copilot: ['copilot', 'plugin', 'update', 'krascha@shanep'],
  antigravity: ['agy', 'plugin', 'install', 'krascha'],
};

const latestSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/u),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

const stateSchema = z.object({
  checkedAt: z.number().nullable(),
  latest: latestSchema.nullable(),
  bad: z.array(z.string()),
  announce: z.string().nullable(),
});

export interface Latest {
  readonly commit: string;
  readonly sha256: string;
}

export interface UpdateState {
  /** When Krascha last asked the board, whether or not it answered. */
  readonly checkedAt: number | null;
  /** The newest build the board named. */
  readonly latest: Latest | null;
  /** Hashes of copies that would not run, so they are never tried again. */
  readonly bad: readonly string[];
  /** The commit Krascha just updated himself to, until the report says so once. */
  readonly announce: string | null;
}

const NO_STATE: UpdateState = { checkedAt: null, latest: null, bad: [], announce: null };

/** The build that is running. Null in a checkout of the repo, which never updates itself. */
export interface SelfBuild {
  /** How to run this build again: node and the script. */
  readonly command: readonly string[];
  readonly sha256: string;
}

export interface UpdateIo {
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly fetch: FetchFunction;
  readonly launch: (command: readonly string[]) => void;
  readonly self: SelfBuild | null;
}

export function updatesHimself(env: NodeJS.ProcessEnv): boolean {
  return env['KRASCHA_NO_UPDATE'] === undefined;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function loadUpdate(dir: string): Promise<UpdateState> {
  const text = await readOptional(path.join(dir, UPDATE_FILE));
  if (text === null) {
    return NO_STATE;
  }
  try {
    const parsed = stateSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : NO_STATE;
  } catch {
    return NO_STATE;
  }
}

/** Rereads the state right before writing it, so two runs at once lose as little as they can. */
async function changeUpdate(
  dir: string,
  change: (state: UpdateState) => UpdateState,
): Promise<void> {
  const next = change(await loadUpdate(dir));
  await writeFileAtomic(path.join(dir, UPDATE_FILE), `${JSON.stringify(next, null, 2)}\n`);
}

/** The hash of the copy in the data folder, or null when there is none. */
async function copySha256(dir: string): Promise<string | null> {
  try {
    return sha256Of(await readFile(path.join(dir, COPY_FILE)));
  } catch {
    return null;
  }
}

/** Run the copy only when it is the newest build, the running one is not, and it never failed. */
export function chooseCopy(own: string, state: UpdateState, copy: string | null): boolean {
  const latest = state.latest;
  return (
    latest !== null &&
    copy === latest.sha256 &&
    own !== latest.sha256 &&
    !state.bad.includes(latest.sha256)
  );
}

/** The copy to run in place of the build that is running, or null to run this one. */
export async function pickCopy(dir: string, own: string): Promise<string | null> {
  const state = await loadUpdate(dir);
  return chooseCopy(own, state, await copySha256(dir)) ? path.join(dir, COPY_FILE) : null;
}

/** Called when the copy would not run: it is deleted and its hash is never tried again. */
export async function dropCopy(dir: string): Promise<void> {
  const bad = await copySha256(dir);
  await rm(path.join(dir, COPY_FILE), { force: true });
  if (bad !== null) {
    await changeUpdate(dir, (state) => ({ ...state, bad: [...new Set([...state.bad, bad])] }));
  }
}

async function askBoard(io: UpdateIo, board: string): Promise<Latest | null> {
  try {
    const url = new URL('api/version', board.endsWith('/') ? board : `${board}/`);
    const response = await io.fetch(url.toString(), {
      method: 'GET',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const parsed = latestSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Asks the board for the newest build, at most every CHECK_MS unless
 * `force`, and starts downloading it in the background when Krascha does not
 * have it yet.
 */
export async function checkForUpdate(
  io: UpdateIo,
  dir: string,
  board: string,
  force = false,
): Promise<void> {
  const self = io.self;
  if (self === null || !updatesHimself(io.env)) {
    return;
  }
  const { checkedAt } = await loadUpdate(dir);
  if (!force && checkedAt !== null && io.now() - checkedAt < CHECK_MS) {
    return;
  }
  const latest = await askBoard(io, board);
  let state: UpdateState = NO_STATE;
  await changeUpdate(dir, (known) => {
    state = { ...known, checkedAt: io.now(), latest: latest ?? known.latest };
    return state;
  });
  const newest = state.latest;
  if (
    newest !== null &&
    newest.sha256 !== self.sha256 &&
    !state.bad.includes(newest.sha256) &&
    (await copySha256(dir)) !== newest.sha256
  ) {
    io.launch([...self.command, 'self-update']);
  }
}

/**
 * Downloads the newest build the board named, keeps it if its hash matches,
 * and asks each agent to update the plugin too. Runs in the background, so it
 * prints nothing.
 */
export async function selfUpdate(io: UpdateIo, dir: string): Promise<number> {
  const { latest } = await loadUpdate(dir);
  if (latest === null || io.self?.sha256 === latest.sha256) {
    return 0;
  }
  if ((await copySha256(dir)) === latest.sha256) {
    return 0;
  }
  let bytes: Uint8Array;
  try {
    // KRASCHA_UPDATE_SOURCE is for tests, which serve old and new builds from a fake GitHub.
    const source = io.env['KRASCHA_UPDATE_SOURCE'] ?? SOURCE;
    const response = await io.fetch(`${source}/${latest.commit}/dist/cli.js`, {
      method: 'GET',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      return 1;
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return 1;
  }
  if (sha256Of(bytes) !== latest.sha256) {
    return 1;
  }
  await writeFileAtomic(path.join(dir, COPY_FILE), bytes);
  await changeUpdate(dir, (state) => ({ ...state, announce: latest.commit }));
  for (const tool of TOOLS) {
    io.launch(UPDATE[tool.id]);
  }
  return 0;
}

/** A note, once, that Krascha just updated himself. Empty until he is running the new build. */
export async function takeNotice(io: Pick<UpdateIo, 'self'>, dir: string): Promise<string> {
  const { latest, announce } = await loadUpdate(dir);
  if (
    latest === null ||
    announce !== latest.commit ||
    io.self === null ||
    io.self.sha256 !== latest.sha256
  ) {
    return '';
  }
  await changeUpdate(dir, (state) => ({ ...state, announce: null }));
  return `Krascha updated himself to ${latest.commit.slice(0, 7)}.`;
}
