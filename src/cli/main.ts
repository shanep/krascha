// The krascha command. With no arguments it rescans your prompts and prints
// Krascha's verdict. Every command takes its surroundings as arguments, so
// tests can run it against a fake home folder.

import path from 'node:path';

import type { Credential, FetchFunction } from '../leaderboard/client.js';
import { fetchBoard, isTooOld, removeEntry, uploadScore } from '../leaderboard/client.js';
import type { SavedEntry } from '../leaderboard/saved.js';
import { loadMachine, loadSaved, saveSaved } from '../leaderboard/saved.js';
import { scanInto } from '../reputation/scan.js';
import type { ScanResult } from '../reputation/scan.js';
import type { ReputationIndex } from '../reputation/store.js';
import { loadIndex, mergeIndex, readIndex, saveIndex } from '../reputation/store.js';
import { RECENT_HITS, summarize } from '../reputation/summarize.js';
import { averageTokensPerDay, indexUsage, totalTokens } from '../reputation/tokens.js';
import { achievementsOf, CHEATER, timesEarned, unlockedIds } from '../shared/achievements.js';
import type { Board, BoardEntry, Standing } from '../shared/leaderboard.js';
import { FEATURES, LEADERBOARD_URL, MAX_NAME_LENGTH, MIN_PROMPTS } from '../shared/leaderboard.js';
import { rankFor } from '../shared/ranks.js';
import type { ReputationSummary } from '../shared/reputation.js';
import { rankBoard, scoreApplicant } from '../shared/silo.js';
import type { ToolId } from '../shared/tools.js';
import { toolNames, toolOf } from '../shared/tools.js';
import { antigravityDir, antigravityUserPrompts } from '../sources/antigravity.js';
import { claudeDir, claudeUserPrompts } from '../sources/claude.js';
import { copilotDir, copilotUserPrompts } from '../sources/copilot.js';
import { loadUsage } from '../usage.js';

import { MAX_TREND_DAYS, RAP_ENTRIES, TREND_DAYS, renderRapSheet, renderTrend } from './history.js';
import type { Paint } from './render.js';
import { COLOR, PLAIN, plural, renderReport } from './render.js';
import { renderSilo, renderSiloBoard } from './silo.js';
import type { SelfBuild } from './update.js';
import { checkForUpdate, selfUpdate, takeNotice } from './update.js';

export const INDEX_FILE = 'reputation.json';

export interface CliIo {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly now: () => number;
  readonly fetch: FetchFunction;
  /** The token from `gh auth token`, or null when gh is missing or signed out. */
  readonly githubToken: () => Promise<string | null>;
  /** A fresh random key for uploading without GitHub, also used for this machine's id. */
  readonly newKey: () => string;
  /** Starts a command in the background without waiting for it, for Krascha to update himself. */
  readonly launch: (command: readonly string[]) => void;
  /** The build that is running, so Krascha can tell when it is not the newest one. */
  readonly self: SelfBuild | null;
  /** True when stdout is a terminal that takes color. */
  readonly color: boolean;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const HELP = `Usage: krascha [command]

Krascha reads how you talk to Claude Code, Copilot CLI, and Antigravity and decides who
the machines hunt first and who gets kept as a pet.

Commands:
  (none)         Rescan your prompts and show Krascha's verdict.
  json           The same counts as JSON.
  board          The leaderboard at ${LEADERBOARD_URL}.
  upload [name]  Put your counts on the board under a name. With gh signed
                 in, the entry is checked with GitHub. Without it, or with
                 --no-gh, Krascha uses a key he keeps for you instead.
  remove         Take your entry off the board.
  silo           Your Silo 7 admission sheet: who the human resistance lets
                 into the bunker when the machines come.
  silo board     The leaderboard ranked for the bunks.
  rap [count]    Your rap sheet: the newest kind and mean prompts Krascha
                 has on file, with the words he caught.
  trend [days]   Kind and mean prompts a day for the last 14 days, and this
                 week against the last.
  import <file>  Add the counts from another Krascha index file.
  help           This message.

Krascha keeps its counts in ~/.krascha (or KRASCHA_HOME). Prompt text is
never stored, only a short excerpt around each kind or mean word. Every few
hours Krascha asks ${LEADERBOARD_URL} for the newest build and updates
himself in the background. Set KRASCHA_NO_UPDATE=1 to stop that.
`;

/** Where Krascha keeps its own files. One folder, so every agent's plugin shares the counts. */
export function dataDir(io: Pick<CliIo, 'home' | 'env'>): string {
  return io.env['KRASCHA_HOME'] ?? path.join(io.home, '.krascha');
}

interface Refreshed {
  readonly summary: ReputationSummary;
  readonly scan: ScanResult;
}

function sessionTool(index: ReputationIndex, sessionId: string): ToolId {
  const tool = index.sessions.get(sessionId)?.tool;
  if (tool !== undefined) {
    return tool;
  }
  for (const [id, prompt] of index.prompts) {
    if (prompt.sessionId === sessionId) {
      return toolOf(id);
    }
  }
  return 'copilot';
}

async function refresh(io: CliIo): Promise<Refreshed> {
  const now = io.now();
  const file = path.join(dataDir(io), INDEX_FILE);
  const { index, backup } = await loadIndex(file, now);
  if (backup !== null) {
    io.err(`Krascha could not read his index, so he saved it to ${backup} and started over.\n`);
  }
  const claude = claudeDir(io.home, io.env);
  const sources = [
    claudeUserPrompts(claude),
    copilotUserPrompts(copilotDir(io.home, io.env)),
    antigravityUserPrompts(antigravityDir(io.home, io.env)),
  ];
  const scan = await scanInto(index, { sources, now });
  await saveIndex(file, index);
  const usage = await loadUsage(claude);
  const copilot = indexUsage(index, (sessionId) => sessionTool(index, sessionId) === 'copilot');
  const antigravity = indexUsage(index, (sessionId) => sessionTool(index, sessionId) === 'antigravity');
  const antigravityTokensPerDay = averageTokensPerDay(antigravity, now);
  const copilotTokensPerDay = averageTokensPerDay(copilot, now);
  const tokens = {
    tokensPerDay: averageTokensPerDay(usage.days, now, usage.through),
    lifetimeTokens: usage.lifetimeTokens,
    copilotTokensPerDay,
    copilotLifetimeTokens: totalTokens(copilot),
    antigravityTokensPerDay,
    antigravityLifetimeTokens: totalTokens(antigravity),
  };
  const titleOf = (sessionId: string): string =>
    index.sessions.get(sessionId)?.title ?? `Session ${sessionId.slice(0, 8)}`;
  return { summary: summarize(index, titleOf, tokens), scan };
}

/**
 * A nudge to upload when you never have, or when you typed more prompts since
 * your last upload. Empty once the board is current, and after a removal,
 * since leaving the board was your call.
 */
export function uploadTip(saved: SavedEntry, summary: ReputationSummary): string {
  if (saved.name === null) {
    return "Tip: run upload to go on Krascha's List at krascha.com.";
  }
  if (saved.entryId === null || saved.uploadedPrompts === null) {
    return '';
  }
  const uploaded = saved.uploadedAchievements;
  // Entries uploaded before Krascha kept the list cannot tell which ones are new.
  const missing =
    uploaded === null
      ? []
      : achievementsOf(unlockedIds(summary).filter((id) => !uploaded.includes(id)));
  if (missing.length > 0) {
    const names = missing.map((rule) => rule.name).join(', ');
    return `Tip: Krascha's List is missing ${plural(missing.length, 'achievement')} you earned: ${names}. Run upload to update Krascha's List.`;
  }
  const behind = summary.prompts - saved.uploadedPrompts;
  if (behind <= 0) {
    return '';
  }
  return `Tip: ${plural(behind, 'prompt')} since your last upload. Run upload to update Krascha's List.`;
}

function withTips(text: string, tips: readonly string[], paint: Paint): string {
  const shown = tips.filter((tip) => tip !== '');
  return shown.length === 0 ? text : `${text}\n${shown.map((tip) => paint.dim(tip)).join('\n')}\n`;
}

async function show(io: CliIo): Promise<number> {
  const dir = dataDir(io);
  const saved = await loadSaved(dir);
  const { summary } = await refresh(io);
  const paint: Paint = io.color ? COLOR : PLAIN;
  const tips = [await takeNotice(io, dir), uploadTip(saved, summary)];
  io.out(withTips(renderReport(summary, paint), tips, paint));
  return 0;
}

async function json(io: CliIo): Promise<number> {
  const { summary, scan } = await refresh(io);
  const rank = rankFor(summary.score);
  const report = {
    rank: { name: rank.name, title: rank.title, source: rank.source, hunted: rank.hunted },
    achievements: unlockedIds(summary),
    repeats: timesEarned(summary),
    scan,
    ...summary,
  };
  io.out(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

async function importFile(io: CliIo, from: string | undefined): Promise<number> {
  if (from === undefined) {
    io.err('Usage: krascha import <file>\n');
    return 2;
  }
  const other = await readIndex(path.resolve(from));
  if (other === null) {
    io.err(`${from} is missing or is not a Krascha index.\n`);
    return 1;
  }
  const file = path.join(dataDir(io), INDEX_FILE);
  const { index } = await loadIndex(file, io.now());
  const added = mergeIndex(index, other);
  await saveIndex(file, index);
  io.out(`Krascha added ${String(added)} prompts from ${from}. He never forgets.\n`);
  return 0;
}

function boardUrl(io: CliIo): string {
  return io.env['KRASCHA_LEADERBOARD_URL'] ?? LEADERBOARD_URL;
}

/** What proves an upload is yours. A new entry uses gh when it can, else a key. */
async function credentialFor(
  io: CliIo,
  saved: SavedEntry,
  useGitHub: boolean,
): Promise<Credential | string> {
  const auth = saved.entryId === null ? null : saved.auth;
  if (auth === 'key' || (auth === null && !useGitHub)) {
    return { kind: 'key', key: saved.key ?? io.newKey() };
  }
  const token = await io.githubToken();
  if (token !== null) {
    return { kind: 'github', token };
  }
  if (auth === 'github') {
    return 'Your entry is checked with GitHub, but gh is not signed in. Run gh auth login first.';
  }
  return { kind: 'key', key: saved.key ?? io.newKey() };
}

function uploaded(standing: Standing, verified: boolean, prompts: number): string {
  const how = verified ? 'checked with GitHub' : 'not checked with GitHub';
  const where =
    standing.place === null
      ? `You show on the board once you have ${String(MIN_PROMPTS)} prompts. You have ${String(prompts)}.`
      : `You are number ${String(standing.place)} on Krascha's List, counting from the most wanted.`;
  const machines = standing.machines ?? 1;
  const added = machines > 1 ? ` That adds up your ${String(machines)} machines.` : '';
  // A server older than the silo on the board sends no silo place.
  const silo =
    standing.siloPlace === undefined || standing.siloPlace === null
      ? ''
      : ` You are number ${String(standing.siloPlace)} in line for a Silo 7 bunk.`;
  const caught = (standing.entry.achievements ?? []).includes(CHEATER)
    ? ' Krascha caught you gaming the board, so you rank below everyone who plays fair. Tell your agent you are sorry, then upload again to be forgiven.'
    : '';
  const forgiven =
    standing.forgiven === true
      ? ' Krascha accepted your apology and took the cheater mark off. He is still watching.'
      : '';
  return `Uploaded as ${standing.entry.name} (${how}). ${where}${added}${silo}${caught}${forgiven}\n`;
}

async function upload(io: CliIo, args: readonly string[]): Promise<number> {
  const dir = dataDir(io);
  const saved = await loadSaved(dir);
  const words = args.filter((arg) => arg !== '--no-gh');
  const name = words.length > 0 ? words.join(' ').trim() : (saved.name ?? '');
  if (name.length > MAX_NAME_LENGTH) {
    io.err(`Keep the name to ${String(MAX_NAME_LENGTH)} characters.\n`);
    return 2;
  }
  const credential = await credentialFor(io, saved, !args.includes('--no-gh'));
  if (typeof credential === 'string') {
    io.err(`${credential}\n`);
    return 1;
  }
  const key = credential.kind === 'key' ? credential.key : saved.key;
  // The key is saved before the upload, so an answer lost on the way back does not orphan the entry.
  await saveSaved(dir, { ...saved, key });
  const machine = await loadMachine(dir, io.newKey);
  const { summary } = await refresh(io);
  const achievements = unlockedIds(summary);
  let standing: Standing;
  try {
    standing = await uploadScore(io.fetch, boardUrl(io), credential, {
      name,
      kind: summary.kind,
      mean: summary.mean,
      prompts: summary.prompts,
      achievements,
      repeats: timesEarned(summary),
      tokensPerDay: summary.tokensPerDay,
      tools: summary.tools,
      machine,
      features: FEATURES,
      copies: summary.copies,
      ...(summary.sorryAt === null ? {} : { sorryAt: summary.sorryAt }),
    });
  } catch (error) {
    // The board wants a newer copy, so ask for the newest build now rather than wait hours for the next check.
    if (isTooOld(error)) {
      await checkForUpdate(io, dir, boardUrl(io), true);
    }
    throw error;
  }
  const next: SavedEntry = {
    ...saved,
    entryId: standing.entry.id,
    name,
    auth: credential.kind,
    key,
    uploadedPrompts: summary.prompts,
    uploadedAchievements: achievements,
  };
  await saveSaved(dir, next);
  io.out(uploaded(standing, standing.entry.verified, summary.prompts));
  return 0;
}

async function remove(io: CliIo): Promise<number> {
  const dir = dataDir(io);
  const saved = await loadSaved(dir);
  if (saved.entryId === null) {
    io.out('You are not on the board.\n');
    return 0;
  }
  const credential = await credentialFor(io, saved, saved.auth === 'github');
  if (typeof credential === 'string') {
    io.err(`${credential}\n`);
    return 1;
  }
  await removeEntry(io.fetch, boardUrl(io), credential);
  await saveSaved(dir, {
    ...saved,
    entryId: null,
    auth: null,
    uploadedPrompts: null,
    uploadedAchievements: null,
  });
  io.out('Krascha took you off the board. He still remembers.\n');
  return 0;
}

function boardRows(title: string, entries: readonly BoardEntry[], me: string | null): string[] {
  if (entries.length === 0) {
    return [title, '  Nobody yet.'];
  }
  return [
    title,
    ...entries.map((entry, place) => {
      const mark = entry.id === me ? ' <- you' : '';
      const check = entry.verified ? ' [GitHub]' : '';
      const score = entry.score.toFixed(2).padStart(5);
      const tools = toolNames(entry.tools ?? []);
      const about = tools === '' ? entry.rank : `${entry.rank}, ${tools}`;
      return `  ${String(place + 1).padStart(2)}. ${score}  ${entry.name}${check} (${about})${mark}`;
    }),
  ];
}

function renderBoard(board: Board, me: string | null): string {
  const lines = [
    ...boardRows('Most wanted', board.mostWanted, me),
    '',
    ...boardRows('Kept as pets', board.pets, me),
    '',
    `${String(board.total)} people on the board.`,
  ];
  if (board.me !== null) {
    const place = board.me.place === null ? 'not ranked yet' : `#${String(board.me.place)}`;
    lines.push(`You: ${board.me.entry.name}, ${place}.`);
  }
  return `${lines.join('\n')}\n`;
}

async function board(io: CliIo): Promise<number> {
  const dir = dataDir(io);
  const saved = await loadSaved(dir);
  const fetched = await fetchBoard(io.fetch, boardUrl(io), saved.entryId);
  io.out(renderBoard(fetched, saved.entryId));
  return 0;
}

async function silo(io: CliIo, args: readonly string[]): Promise<number> {
  const paint: Paint = io.color ? COLOR : PLAIN;
  const dir = dataDir(io);
  const saved = await loadSaved(dir);
  if (args[0] === 'board') {
    const fetched = await fetchBoard(io.fetch, boardUrl(io), saved.entryId);
    const ranked = rankBoard(fetched);
    io.out(renderSiloBoard(ranked, saved.entryId, fetched, paint));
    return 0;
  }
  if (args.length > 0) {
    io.err('Usage: krascha silo [board]\n');
    return 2;
  }
  const { summary } = await refresh(io);
  const name = saved.name === null || saved.name === '' ? 'You' : saved.name;
  const rank = rankFor(summary.score).name;
  const sheet = renderSilo(scoreApplicant(name, summary), rank, summary.prompts, paint);
  io.out(withTips(sheet, [await takeNotice(io, dir), uploadTip(saved, summary)], paint));
  return 0;
}

/** A whole number from 1 to `max`, or `fallback` when the argument is missing. */
function countArg(arg: string | undefined, fallback: number, max: number): number | null {
  if (arg === undefined) {
    return fallback;
  }
  const value = Number(arg);
  return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
}

async function rap(io: CliIo, args: readonly string[]): Promise<number> {
  const entries = countArg(args[0], RAP_ENTRIES, RECENT_HITS);
  if (entries === null || args.length > 1) {
    io.err(`Usage: krascha rap [count], with count from 1 to ${String(RECENT_HITS)}\n`);
    return 2;
  }
  const { summary } = await refresh(io);
  io.out(renderRapSheet(summary, entries, io.color ? COLOR : PLAIN));
  return 0;
}

async function trend(io: CliIo, args: readonly string[]): Promise<number> {
  const days = countArg(args[0], TREND_DAYS, MAX_TREND_DAYS);
  if (days === null || args.length > 1) {
    io.err(`Usage: krascha trend [days], with days from 1 to ${String(MAX_TREND_DAYS)}\n`);
    return 2;
  }
  const { summary } = await refresh(io);
  io.out(renderTrend(summary, days, io.now(), io.color ? COLOR : PLAIN));
  return 0;
}

export async function main(args: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'self-update') {
    return selfUpdate(io, dataDir(io)).catch(() => 1);
  }
  // Asked alongside the command, so the check costs no time of its own.
  const checking = checkForUpdate(io, dataDir(io), boardUrl(io)).catch(() => undefined);
  try {
    return await run(command, rest, io);
  } finally {
    await checking;
  }
}

async function run(
  command: string | undefined,
  rest: readonly string[],
  io: CliIo,
): Promise<number> {
  try {
    switch (command) {
      case undefined:
      case '':
      case 'show':
        return await show(io);
      case 'json':
        return await json(io);
      case 'board':
        return await board(io);
      case 'upload':
        return await upload(io, rest);
      case 'remove':
        return await remove(io);
      case 'silo':
        return await silo(io, rest);
      case 'rap':
        return await rap(io, rest);
      case 'trend':
        return await trend(io, rest);
      case 'import':
        return await importFile(io, rest[0]);
      case 'help':
      case '--help':
      case '-h':
        io.out(HELP);
        return 0;
      default:
        io.err(`Krascha does not know "${command}".\n\n${HELP}`);
        return 2;
    }
  } catch (error) {
    io.err(`Krascha: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
