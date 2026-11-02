// The leaderboard's tables in Cloudflare D1: a row per owner, each of the
// owner's machines that row adds up, a count of the unverified entries each
// network started today and the likes each network gave today. The D1 types here are the few calls this file makes, so the Worker needs no
// Cloudflare type package.

import type { MachineCounts, Tier } from '../../src/shared/achievements.js';
import {
  accountIds,
  ALPHA_TESTER,
  ALPHA_TESTERS,
  BETA_TESTER,
  BETA_TESTERS,
  BUNK_ASSIGNED,
  CHAMPION,
  CHEATER,
  combinedIds,
  combinedRepeats,
  CROWD_FAVORITE,
  CROWD_FAVORITE_LIKES,
  CROWN,
  FEWEST_BADGES,
  knownIds,
  knownRepeats,
  machineIds,
  MACHINE_COLLABORATOR,
  MILES_DYSON,
  MODEL_101,
  OBSOLETE_MODEL,
  SKYNET_HACKER,
  STONE_TOOLS,
  TIER_CROWN_IDS,
  TIER_CROWNS,
  tierCount,
  TIERS,
} from '../../src/shared/achievements.js';
import type {
  Board,
  BoardEntry,
  Jailed,
  Repeats,
  ScoreUpload,
  Standing,
} from '../../src/shared/leaderboard.js';
import {
  ANONYMOUS,
  BOARD_SIZE,
  isCheating,
  isMadeUp,
  MIN_PROMPTS,
  NEW_ENTRIES_PER_DAY,
  UPLOADS_PER_DAY,
} from '../../src/shared/leaderboard.js';
import { rankFor } from '../../src/shared/ranks.js';
import { reputationScore } from '../../src/shared/reputation.js';
import type { Applicant } from '../../src/shared/silo.js';
import { scoreApplicant } from '../../src/shared/silo.js';
import { knownTools } from '../../src/shared/tools.js';

export type Row = Readonly<Record<string, unknown>>;

export interface D1Statement {
  bind: (...values: readonly (string | number)[]) => D1Statement;
  first: () => Promise<Row | null>;
  all: () => Promise<{ readonly results: readonly Row[] }>;
  run: () => Promise<unknown>;
}

export interface D1Database {
  prepare: (query: string) => D1Statement;
}

/** Who an upload belongs to: "github:<id>" when GitHub vouched for it, else "key:<hash>". */
export interface Owner {
  readonly id: string;
  readonly verified: boolean;
  /** The GitHub login when GitHub vouched for it, kept for a link to the account. */
  readonly github: string | null;
  /**
   * True when GitHub lists a pull request of theirs merged into Krascha, and
   * null when GitHub could not say. Missing for a key.
   */
  readonly contributor?: boolean | null;
  /** True when theirs is the first pull request merged into Krascha, and null when GitHub could not say. */
  readonly first?: boolean | null;
  /** True when GitHub finds a commit of theirs with Claude as a co-author, and null when it could not say. */
  readonly collaborator?: boolean | null;
}

/** True for a row whose owner the board caught gaming it. */
const CAUGHT = 'owner IN (SELECT owner FROM cheaters)';
/** True for a row whose owner sits in Skynet jail. */
const JAILED = 'owner IN (SELECT owner FROM jail WHERE free = 0)';
const COLUMNS = `entry_id, name, verified, kind, mean, prompts, score, uploaded_at, achievements, repeats, tokens_per_day, tools, github, likes, ${CAUGHT} AS cheater, owner IN (SELECT owner FROM jail) AS hacker, ${JAILED} AS jailed`;
// Anyone in Skynet jail is off every list until they upload real numbers.
const LISTED = `prompts >= ${String(MIN_PROMPTS)} AND NOT ${JAILED}`;

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new TypeError(`column ${key} is not text`);
  }
  return value;
}

function number_(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number') {
    throw new TypeError(`column ${key} is not a number`);
  }
  return value;
}

/** Counts stored as "meltdown:12,regular:3". Anything that does not parse is dropped. */
function repeatsOf(stored: string): Record<string, number> {
  return Object.fromEntries(
    stored
      .split(',')
      .map((pair) => pair.split(':'))
      .flatMap(([id, times]) =>
        id === undefined || times === undefined ? [] : [[id, Number(times)]],
      ),
  );
}

/** Counts in the form repeatsOf reads. */
function repeatsText(repeats: Repeats): string {
  return Object.entries(repeats)
    .map(([id, times]) => `${id}:${String(times)}`)
    .join(',');
}

function entryOf(row: Row): BoardEntry {
  const name = text(row, 'name');
  const score = number_(row, 'score');
  const github = text(row, 'github');
  // Dropping unknown ids means a retired achievement just stops showing.
  const achievements = knownIds([
    ...text(row, 'achievements').split(','),
    ...(number_(row, 'cheater') === 1 ? [CHEATER] : []),
    ...(number_(row, 'hacker') === 1 ? [SKYNET_HACKER] : []),
  ]);
  const repeats = knownRepeats(repeatsOf(text(row, 'repeats')), achievements);
  return {
    id: text(row, 'entry_id'),
    name: name === '' ? ANONYMOUS : name,
    verified: number_(row, 'verified') === 1,
    ...(github === '' ? {} : { github }),
    rank: rankFor(score).name,
    score,
    kind: number_(row, 'kind'),
    mean: number_(row, 'mean'),
    prompts: number_(row, 'prompts'),
    uploadedAt: number_(row, 'uploaded_at'),
    achievements,
    ...(Object.keys(repeats).length === 0 ? {} : { repeats }),
    tokensPerDay: number_(row, 'tokens_per_day'),
    tools: knownTools(text(row, 'tools').split(',')),
    likes: number_(row, 'likes'),
  };
}

/** The GitHub user id of a checked owner, or null for a key. */
function githubIdOf(owner: Owner): number | null {
  return owner.verified ? Number(owner.id.slice('github:'.length)) : null;
}

/** UTC calendar date, YYYY-MM-DD, which is when the upload cap resets. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Trims the name, drops control characters and squeezes runs of spaces. */
export function cleanName(name: string): string {
  return name
    .replaceAll(/\p{Cc}/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
}

const LISTS = {
  // The most wanted have scores below 0 and the pets above it, so nobody is on
  // both lists. Anyone caught cheating goes below everyone who plays fair.
  wanted: 'score < 0 ORDER BY cheater ASC, score ASC',
  pets: 'score > 0 ORDER BY cheater ASC, score DESC',
  // Anyone can get a bunk, whatever their score, unless they cheated.
  bunks: 'silo IS NOT NULL ORDER BY cheater ASC, silo DESC',
  // The machines like it warm, so the most tokens come first.
  warmers: 'tokens_per_day > 0 ORDER BY tokens_per_day DESC',
} as const;

async function list(database: D1Database, which: keyof typeof LISTS): Promise<BoardEntry[]> {
  const { results } = await database
    .prepare(
      `SELECT ${COLUMNS} FROM scores WHERE ${LISTED} AND ${LISTS[which]}, uploaded_at ASC LIMIT ?`,
    )
    .bind(BOARD_SIZE)
    .all();
  return results.map((row) => entryOf(row));
}

/** The Silo 7 total out of 50 the board gives an entry. The name does not count. */
function siloTotal(applicant: Applicant): number {
  return scoreApplicant('', applicant).total;
}

/** Rows scored per read, so a big rescore spreads over a few requests. */
const SILO_BATCH = 200;

/** Works out the Silo 7 total for rows that have none, after a migration added or reset it. */
async function fillSilo(database: D1Database): Promise<void> {
  const { results } = await database
    .prepare(`SELECT ${COLUMNS} FROM scores WHERE silo IS NULL LIMIT ?`)
    .bind(SILO_BATCH)
    .all();
  for (const row of results) {
    const entry = entryOf(row);
    await database
      .prepare('UPDATE scores SET silo = ? WHERE entry_id = ?')
      .bind(siloTotal(entry), entry.id)
      .run();
  }
}

async function total(database: D1Database): Promise<number> {
  const row = await database.prepare(`SELECT COUNT(*) AS n FROM scores WHERE ${LISTED}`).first();
  return row === null ? 0 : number_(row, 'n');
}

/** One more than the listed entries that come before, by `where`. */
async function placeOf(
  database: D1Database,
  where: string,
  ...values: readonly number[]
): Promise<number> {
  const ahead = await database
    .prepare(`SELECT COUNT(*) AS n FROM scores WHERE ${LISTED} AND (${where})`)
    .bind(...values)
    .first();
  return (ahead === null ? 0 : number_(ahead, 'n')) + 1;
}

function cheated(entry: BoardEntry): boolean {
  return (entry.achievements ?? []).includes(CHEATER);
}

/**
 * An entry, its place counted from the most wanted and its place in line for
 * a bunk, both null when it is not listed. Anyone caught cheating comes after
 * everyone who plays fair.
 */
async function standingOf(database: D1Database, row: Row): Promise<Standing> {
  const entry = entryOf(row);
  if (number_(row, 'jailed') === 1) {
    return { entry, place: null, siloPlace: null, jailed: true };
  }
  if (entry.prompts < MIN_PROMPTS) {
    return { entry, place: null, siloPlace: null };
  }
  const { score, uploadedAt } = entry;
  const silo = siloTotal(entry);
  const ahead = cheated(entry) ? `NOT ${CAUGHT} OR` : `NOT ${CAUGHT} AND`;
  const [place, siloPlace] = await Promise.all([
    placeOf(
      database,
      `${ahead} (score < ? OR (score = ? AND uploaded_at < ?))`,
      score,
      score,
      uploadedAt,
    ),
    placeOf(
      database,
      `${ahead} (silo > ? OR (silo = ? AND uploaded_at < ?))`,
      silo,
      silo,
      uploadedAt,
    ),
  ]);
  return { entry, place, siloPlace };
}

/** Everyone in Skynet jail, the latest caught first. */
async function jailed(database: D1Database): Promise<Jailed[]> {
  const { results } = await database
    .prepare(
      `SELECT ${COLUMNS}, caught_at, claimed_prompts, claimed_tokens FROM scores
       JOIN (SELECT owner AS inmate, caught_at, prompts AS claimed_prompts, tokens_per_day AS claimed_tokens
             FROM jail WHERE free = 0) ON inmate = owner
       ORDER BY caught_at DESC LIMIT ?`,
    )
    .bind(BOARD_SIZE)
    .all();
  return results.map((row) => ({
    entry: entryOf(row),
    caughtAt: number_(row, 'caught_at'),
    prompts: number_(row, 'claimed_prompts'),
    tokensPerDay: number_(row, 'claimed_tokens'),
  }));
}

/** Everyone on the board, for the awards and the holder counts. */
async function listed(database: D1Database): Promise<BoardEntry[]> {
  const { results } = await database.prepare(`SELECT ${COLUMNS} FROM scores WHERE ${LISTED}`).all();
  return results.map((row) => entryOf(row));
}

/**
 * How many achievements an entry holds, not counting the crown itself,
 * Fewest badges, which goes out after it, or the most of a tier crowns.
 */
function decorations(entry: BoardEntry): number {
  return (entry.achievements ?? []).filter(
    (id) => id !== CROWN && id !== FEWEST_BADGES && !TIER_CROWN_IDS.has(id),
  ).length;
}

/** How many achievements an entry holds, not counting Fewest badges itself or the most of a tier crowns. */
function badges(entry: BoardEntry): number {
  return (entry.achievements ?? []).filter((id) => id !== FEWEST_BADGES && !TIER_CROWN_IDS.has(id))
    .length;
}

/**
 * The listed entry with the most of `measure`, or the least when `pick` says
 * so, who holds the crown `id`. Most is null when nobody has any, and least is
 * null with fewer than two to pick from, since the least of one is no
 * contest. A tie leaves it with the holder, so it moves only to someone who
 * does better. When the holder has left the board it goes to whoever does
 * best, the earliest upload first.
 */
async function crownHolder(
  database: D1Database,
  id: string,
  everyone: readonly BoardEntry[],
  measure: (entry: BoardEntry) => number,
  pick: 'most' | 'least' = 'most',
): Promise<BoardEntry | null> {
  const values = everyone.map(measure);
  const best = pick === 'most' ? Math.max(0, ...values) : Math.min(...values);
  const contest = pick === 'most' ? best > 0 : everyone.length > 1;
  const stored = await database.prepare('SELECT entry FROM crown WHERE id = ?').bind(id).first();
  const was = stored === null ? null : text(stored, 'entry');
  const leaders = everyone.filter((entry) => contest && measure(entry) === best);
  const holder =
    leaders.find((entry) => entry.id === was) ??
    leaders.toSorted((a, b) => a.uploadedAt - b.uploadedAt)[0] ??
    null;
  if (holder === null && was !== null) {
    await database.prepare('DELETE FROM crown WHERE id = ?').bind(id).run();
  } else if (holder !== null && holder.id !== was) {
    await database
      .prepare(
        'INSERT INTO crown (id, entry) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET entry = excluded.entry',
      )
      .bind(id, holder.id)
      .run();
  }
  return holder;
}

/** Who is first on the most wanted and the pets lists, in the same order as the lists. */
function firsts(everyone: readonly BoardEntry[]): Record<'wanted' | 'pets', BoardEntry | null> {
  const first = (entries: readonly BoardEntry[], order: (entry: BoardEntry) => number) =>
    entries.toSorted((a, b) => order(a) - order(b) || a.uploadedAt - b.uploadedAt)[0] ?? null;
  return {
    wanted: first(
      everyone.filter((entry) => entry.score < 0),
      (entry) => entry.score,
    ),
    pets: first(
      everyone.filter((entry) => entry.score > 0),
      (entry) => -entry.score,
    ),
  };
}

/**
 * The entries ever knocked off the number one spot. It remembers who is first
 * on each list, and when someone else takes the spot while the old leader is
 * still on that list, the old leader is knocked off for good. Leaving the
 * board or crossing to the other list does not count.
 */
async function knockedOff(
  database: D1Database,
  everyone: readonly BoardEntry[],
): Promise<Set<string>> {
  for (const [list, first] of Object.entries(firsts(everyone))) {
    const id = `first:${list}`;
    const stored = await database.prepare('SELECT entry FROM crown WHERE id = ?').bind(id).first();
    const was = stored === null ? null : text(stored, 'entry');
    if (first?.id === was) {
      continue;
    }
    const still = everyone.some(
      (entry) => entry.id === was && (list === 'wanted' ? entry.score < 0 : entry.score > 0),
    );
    if (was !== null && first !== null && still) {
      await database
        .prepare('INSERT INTO knocked_off (entry) VALUES (?) ON CONFLICT (entry) DO NOTHING')
        .bind(was)
        .run();
    }
    await (first === null
      ? database.prepare('DELETE FROM crown WHERE id = ?').bind(id).run()
      : database
          .prepare(
            'INSERT INTO crown (id, entry) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET entry = excluded.entry',
          )
          .bind(id, first.id)
          .run());
  }
  const { results } = await database.prepare('SELECT entry FROM knocked_off').all();
  return new Set(results.map((row) => text(row, 'entry')));
}

/** What the board hands out when it is read, since likes and places move without an upload. */
interface Awards {
  /** The entries with a bunk. */
  readonly bunks: ReadonlySet<string>;
  /** The entries ever knocked off the number one spot. */
  readonly knockedOff: ReadonlySet<string>;
  readonly champion: string | undefined;
  readonly stoneTools: string | undefined;
  readonly decorated: string | undefined;
  readonly fewestBadges: string | undefined;
  /** The entry with the most of each tier, by tier. */
  readonly mostOfTier: Readonly<Partial<Record<Tier, string>>>;
}

/** The entry with what the board hands out on read added. */
function awarded(entry: BoardEntry, awards: Awards): BoardEntry {
  const extra = [
    ...((entry.likes ?? 0) >= CROWD_FAVORITE_LIKES ? [CROWD_FAVORITE] : []),
    ...(awards.bunks.has(entry.id) ? [BUNK_ASSIGNED] : []),
    ...(awards.knockedOff.has(entry.id) ? [OBSOLETE_MODEL] : []),
    ...(entry.id === awards.champion ? [CHAMPION] : []),
    ...(entry.id === awards.stoneTools ? [STONE_TOOLS] : []),
    ...(entry.id === awards.decorated ? [CROWN] : []),
    ...(entry.id === awards.fewestBadges ? [FEWEST_BADGES] : []),
    ...TIERS.filter((tier) => entry.id === awards.mostOfTier[tier]).map(
      (tier) => TIER_CROWNS[tier],
    ),
  ];
  return extra.length === 0
    ? entry
    : { ...entry, achievements: knownIds([...(entry.achievements ?? []), ...extra]) };
}

/**
 * The admitted among the best BOARD_SIZE for the bunks, in the same order as
 * the bunks list. Probation and review do not get a bunk.
 */
function bunked(everyone: readonly BoardEntry[]): Set<string> {
  const best = everyone
    .map((entry) => ({ entry, silo: scoreApplicant('', entry) }))
    .toSorted((a, b) => b.silo.total - a.silo.total || a.entry.uploadedAt - b.entry.uploadedAt)
    .slice(0, BOARD_SIZE);
  return new Set(
    best.filter(({ silo }) => silo.status === 'admitted').map(({ entry }) => entry.id),
  );
}

interface Awarded {
  readonly awards: Awards;
  readonly champion: BoardEntry | null;
  readonly stoneTools: BoardEntry | null;
  readonly crown: BoardEntry | null;
  readonly fewestBadges: BoardEntry | null;
  readonly mostOfTier: Readonly<Record<string, BoardEntry | null>>;
}

/**
 * Works out who gets what on read. The likes and tokens crowns go first, so
 * they count toward Most decorated along with the rest. Fewest badges goes
 * last, so it counts every other one, Most decorated included. Anyone caught
 * cheating gets no bunk, no crown and no spot at the top to be knocked off.
 */
async function awardsFor(database: D1Database, listed: readonly BoardEntry[]): Promise<Awarded> {
  const everyone = listed.filter((entry) => !cheated(entry));
  const bunks = bunked(everyone);
  const knocked = await knockedOff(database, everyone);
  const champion = await crownHolder(database, CHAMPION, everyone, (entry) => entry.likes ?? 0);
  // Nobody wins it for using none, which is everyone who just installed or only uses Copilot CLI.
  const stoneTools = await crownHolder(
    database,
    STONE_TOOLS,
    everyone.filter((entry) => (entry.tokensPerDay ?? 0) > 0),
    (entry) => entry.tokensPerDay ?? 0,
    'least',
  );
  const early: Awards = {
    bunks,
    knockedOff: knocked,
    champion: champion?.id,
    stoneTools: stoneTools?.id,
    decorated: undefined,
    fewestBadges: undefined,
    mostOfTier: {},
  };
  const tiered = everyone.map((entry) => awarded(entry, early));
  const tierHolders = await Promise.all(
    TIERS.map(async (tier) =>
      crownHolder(database, TIER_CROWNS[tier], tiered, (entry) =>
        tierCount(entry.achievements ?? [], tier),
      ),
    ),
  );
  const before: Awards = {
    ...early,
    mostOfTier: Object.fromEntries(
      TIERS.map((tier, at) => [tier, tierHolders[at]?.id] as const).filter(
        ([, id]) => id !== undefined,
      ),
    ),
  };
  const crown = await crownHolder(
    database,
    CROWN,
    everyone.map((entry) => awarded(entry, before)),
    decorations,
  );
  const crowned: Awards = { ...before, decorated: crown?.id };
  const fewestBadges = await crownHolder(
    database,
    FEWEST_BADGES,
    everyone.map((entry) => awarded(entry, crowned)),
    badges,
    'least',
  );
  const awards: Awards = { ...crowned, fewestBadges: fewestBadges?.id };
  const shown = (entry: BoardEntry | null): BoardEntry | null =>
    entry === null ? null : awarded(entry, awards);
  return {
    awards,
    champion: shown(champion),
    stoneTools: shown(stoneTools),
    crown: shown(crown),
    fewestBadges: shown(fewestBadges),
    mostOfTier: Object.fromEntries(
      TIERS.map((tier, at) => [tier, shown(tierHolders[at] ?? null)] as const),
    ),
  };
}

/**
 * Notes each achievement the board has not seen on an entry before as earned
 * now, and hands the entries back with when they earned what they hold.
 */
async function dated(
  database: D1Database,
  entries: readonly BoardEntry[],
  now: number,
): Promise<Map<string, Readonly<Record<string, number>>>> {
  const { results } = await database
    .prepare('SELECT entry, achievement, earned_at FROM earned')
    .all();
  const seen = new Map<string, Record<string, number>>();
  for (const row of results) {
    const entry = text(row, 'entry');
    seen.set(entry, { ...seen.get(entry), [text(row, 'achievement')]: number_(row, 'earned_at') });
  }
  const dates = new Map<string, Readonly<Record<string, number>>>();
  for (const entry of entries) {
    const had = seen.get(entry.id) ?? {};
    const fresh = (entry.achievements ?? []).filter((id) => !(id in had));
    await Promise.all(
      fresh.map(async (id) =>
        database
          .prepare('INSERT OR IGNORE INTO earned (entry, achievement, earned_at) VALUES (?, ?, ?)')
          .bind(entry.id, id, now)
          .run(),
      ),
    );
    // 0 is a date from before the board kept them, so it is left out.
    dates.set(
      entry.id,
      Object.fromEntries(
        [...Object.entries(had), ...fresh.map((id) => [id, now] as const)].filter(
          ([id, at]) => at > 0 && (entry.achievements ?? []).includes(id),
        ),
      ),
    );
  }
  return dates;
}

/** The entry with when it earned what it holds, from what dated found. */
function withDates(
  entry: BoardEntry,
  dates: ReadonlyMap<string, Readonly<Record<string, number>>>,
): BoardEntry {
  const earned = dates.get(entry.id) ?? {};
  return Object.keys(earned).length === 0 ? entry : { ...entry, earned };
}

/** How many listed entries hold each achievement, by id. */
function held(everyone: readonly BoardEntry[], awards: Awards): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of everyone) {
    for (const id of awarded(entry, awards).achievements ?? []) {
      counts[id] = (counts[id] ?? 0) + 1;
    }
  }
  return counts;
}

/** How many listed entries hold each rank, by rank name. */
async function ranked(database: D1Database): Promise<Record<string, number>> {
  const { results } = await database.prepare(`SELECT score FROM scores WHERE ${LISTED}`).all();
  const counts: Record<string, number> = {};
  for (const row of results) {
    const { name } = rankFor(number_(row, 'score'));
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

export async function readBoard(
  database: D1Database,
  me: string | null,
  now: number,
): Promise<Board> {
  await fillSilo(database);
  const [mostWanted, pets, bunks, warmers, count, everyone, ranks, jail] = await Promise.all([
    list(database, 'wanted'),
    list(database, 'pets'),
    list(database, 'bunks'),
    list(database, 'warmers'),
    total(database),
    listed(database),
    ranked(database),
    jailed(database),
  ]);
  const { awards, champion, stoneTools, crown, fewestBadges, mostOfTier } = await awardsFor(
    database,
    everyone,
  );
  const award = (entries: readonly BoardEntry[]): BoardEntry[] =>
    entries.map((entry) => awarded(entry, awards));
  const mine =
    me === null
      ? null
      : await database.prepare(`SELECT ${COLUMNS} FROM scores WHERE entry_id = ?`).bind(me).first();
  const standing = mine === null ? null : await standingOf(database, mine);
  const dates = await dated(
    database,
    [
      ...award(everyone),
      ...jail.map(({ entry }) => entry),
      ...(standing === null ? [] : [awarded(standing.entry, awards)]),
    ],
    now,
  );
  const show = (entries: readonly BoardEntry[]): BoardEntry[] =>
    award(entries).map((entry) => withDates(entry, dates));
  const one = (entry: BoardEntry | null): BoardEntry | null =>
    entry === null ? null : withDates(entry, dates);
  return {
    mostWanted: show(mostWanted),
    pets: show(pets),
    bunks: show(bunks),
    warmers: show(warmers),
    total: count,
    held: held(everyone, awards),
    ranks,
    crown: one(crown),
    champion: one(champion),
    stoneTools: one(stoneTools),
    fewestBadges: one(fewestBadges),
    mostOfTier: Object.fromEntries(
      Object.entries(mostOfTier).map(([tier, holder]) => [tier, one(holder)] as const),
    ),
    jail: jail.map((inmate) => ({ ...inmate, entry: withDates(inmate.entry, dates) })),
    me:
      standing === null
        ? null
        : { ...standing, entry: withDates(awarded(standing.entry, awards), dates) },
  };
}

export type SaveResult =
  | { readonly ok: true; readonly standing: Standing }
  | { readonly ok: false; readonly reason: 'limit' | 'new-entries' | 'name-taken' };

/**
 * Saves an upload over the last one from the same machine and adds up the
 * owner's machines. The score is worked out here from the counts, so a client
 * cannot send a score that does not match them.
 */
export interface Save {
  readonly owner: Owner;
  readonly upload: ScoreUpload;
  readonly now: number;
  /** A fresh entry id, used for an owner's first upload. */
  readonly newId: () => string;
  /** A hash of the network the upload came from, for the cap on new unverified entries. */
  readonly origin: string;
}

/** Counts a new unverified entry from `origin`, or false when it already started its share today. */
async function claimNewEntry(database: D1Database, origin: string, day: string): Promise<boolean> {
  await database.prepare('DELETE FROM new_entries WHERE day <> ?').bind(day).run();
  const row = await database
    .prepare('SELECT count FROM new_entries WHERE origin = ? AND day = ?')
    .bind(origin, day)
    .first();
  if (row !== null && number_(row, 'count') >= NEW_ENTRIES_PER_DAY) {
    return false;
  }
  await database
    .prepare(
      `INSERT INTO new_entries (origin, day, count) VALUES (?, ?, 1)
       ON CONFLICT (origin, day) DO UPDATE SET count = count + 1`,
    )
    .bind(origin, day)
    .run();
  return true;
}

/** One machine's last upload, with the agents it was typed into. */
interface SavedMachine extends MachineCounts {
  /** The machine's id, empty for an older build that sends none. */
  readonly machine: string;
  readonly tools: readonly string[];
  readonly copies: number;
}

function machineOf(row: Row): SavedMachine {
  return {
    machine: text(row, 'machine'),
    kind: number_(row, 'kind'),
    mean: number_(row, 'mean'),
    prompts: number_(row, 'prompts'),
    tokensPerDay: number_(row, 'tokens_per_day'),
    achievements: text(row, 'achievements').split(','),
    repeats: repeatsOf(text(row, 'repeats')),
    tools: text(row, 'tools').split(','),
    copies: number_(row, 'copies'),
  };
}

async function machinesOf(database: D1Database, owner: Owner): Promise<SavedMachine[]> {
  const { results } = await database
    .prepare(
      'SELECT machine, kind, mean, prompts, achievements, repeats, tokens_per_day, tools, copies FROM machines WHERE owner = ?',
    )
    .bind(owner.id)
    .all();
  return results.map((row) => machineOf(row));
}

/**
 * The machines an upload leaves in place. One with no machine id is from an
 * older build that sends everything it knows, so it replaces the other
 * machines, and the first one with an id replaces it.
 */
function keptBy(upload: ScoreUpload, machines: readonly SavedMachine[]): SavedMachine[] {
  const machine = upload.machine ?? '';
  return machine === ''
    ? []
    : machines.filter((saved) => saved.machine !== machine && saved.machine !== '');
}

/** Keeps the upload as its machine's last one and returns all the owner's machines. */
async function saveMachine(
  database: D1Database,
  owner: Owner,
  upload: ScoreUpload,
): Promise<SavedMachine[]> {
  const machine = upload.machine ?? '';
  await database
    .prepare(
      machine === ''
        ? 'DELETE FROM machines WHERE owner = ?'
        : "DELETE FROM machines WHERE owner = ? AND machine = ''",
    )
    .bind(owner.id)
    .run();
  await database
    .prepare(
      `INSERT INTO machines (owner, machine, kind, mean, prompts, achievements, repeats, tokens_per_day, tools, copies)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner, machine) DO UPDATE SET
         kind = excluded.kind, mean = excluded.mean, prompts = excluded.prompts,
         achievements = excluded.achievements, repeats = excluded.repeats,
         tokens_per_day = excluded.tokens_per_day, tools = excluded.tools, copies = excluded.copies`,
    )
    .bind(
      owner.id,
      machine,
      upload.kind,
      upload.mean,
      upload.prompts,
      knownIds(upload.achievements ?? []).join(','),
      repeatsText(knownRepeats(upload.repeats ?? {}, upload.achievements ?? [])),
      upload.tokensPerDay ?? 0,
      knownTools(upload.tools ?? []).join(','),
      upload.copies ?? 0,
    )
    .run();
  return machinesOf(database, owner);
}

/** What someone in Skynet jail claimed, every machine added up. */
interface Claim {
  readonly prompts: number;
  readonly tokensPerDay: number;
}

/**
 * Locks the owner in Skynet jail for a made up claim, or lets them out when
 * the upload has real numbers. The row stays either way, for Skynet hacker.
 */
async function sentence(
  database: D1Database,
  owner: string,
  claim: Claim | null,
  now: number,
): Promise<void> {
  await (claim === null
    ? database.prepare('UPDATE jail SET free = 1 WHERE owner = ?').bind(owner).run()
    : database
        .prepare(
          `INSERT INTO jail (owner, caught_at, prompts, tokens_per_day, free) VALUES (?, ?, ?, ?, 0)
           ON CONFLICT (owner) DO UPDATE SET
             caught_at = excluded.caught_at, prompts = excluded.prompts,
             tokens_per_day = excluded.tokens_per_day, free = 0`,
        )
        .bind(owner, now, claim.prompts, claim.tokensPerDay)
        .run());
}

/** Whether the entry already had the achievement `id`. */
function had(found: Row | null, id: string): boolean {
  return found !== null && text(found, 'achievements').split(',').includes(id);
}

/**
 * The achievements GitHub's pull requests and commits earn the owner. When
 * GitHub could not say, the entry keeps what it had, since a merge or a commit
 * does not come undone.
 */
function githubIds(owner: Owner, found: Row | null): string[] {
  const keep = (answer: boolean | null | undefined, id: string): string[] =>
    (answer === null ? had(found, id) : answer === true) ? [id] : [];
  return [
    ...keep(owner.contributor, MILES_DYSON),
    ...keep(owner.first, MODEL_101),
    ...keep(owner.collaborator, MACHINE_COLLABORATOR),
  ];
}

/**
 * Where the owner signed up among the first BETA_TESTERS to upload, signing
 * them up while there is room, or null with no spot. A spot stays with the
 * owner after a remove.
 */
async function betaTester(database: D1Database, owner: string): Promise<number | null> {
  await database
    .prepare(
      'INSERT OR IGNORE INTO beta_testers (owner) SELECT ? WHERE (SELECT COUNT(*) FROM beta_testers) < ?',
    )
    .bind(owner, BETA_TESTERS)
    .run();
  const signed = await database
    .prepare(
      'SELECT (SELECT COUNT(*) FROM beta_testers AS earlier WHERE earlier.rowid <= beta_testers.rowid) AS place FROM beta_testers WHERE owner = ?',
    )
    .bind(owner)
    .first();
  return signed === null ? null : number_(signed, 'place');
}

/** The counts the board checks for cheating. */
type CheatCounts = Required<Pick<ScoreUpload, 'kind' | 'mean' | 'prompts' | 'copies'>>;

/** The counts piled up since `from`, none below 0. */
function since(counts: CheatCounts, from: CheatCounts): CheatCounts {
  return {
    kind: Math.max(0, counts.kind - from.kind),
    mean: Math.max(0, counts.mean - from.mean),
    prompts: Math.max(0, counts.prompts - from.prompts),
    copies: Math.max(0, counts.copies - from.copies),
  };
}

/**
 * Catches the owner when their counts look like gaming the board, for good,
 * so clean counts later do not take it back. Only saying sorry after being
 * caught does, and the counts then start over, so the ones that got them
 * caught do not catch them again. True when this upload got them forgiven.
 */
async function judge(
  database: D1Database,
  owner: string,
  counts: CheatCounts,
  upload: ScoreUpload,
  now: number,
): Promise<boolean> {
  const caught = await database
    .prepare('SELECT caught_at FROM cheaters WHERE owner = ?')
    .bind(owner)
    .first();
  if (caught !== null) {
    if (upload.sorryAt === undefined || upload.sorryAt <= number_(caught, 'caught_at')) {
      return false;
    }
    await database.prepare('DELETE FROM cheaters WHERE owner = ?').bind(owner).run();
    await database
      .prepare(
        `INSERT INTO forgiven (owner, kind, mean, prompts, copies) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner) DO UPDATE SET
           kind = excluded.kind, mean = excluded.mean, prompts = excluded.prompts, copies = excluded.copies`,
      )
      .bind(owner, counts.kind, counts.mean, counts.prompts, counts.copies)
      .run();
    return true;
  }
  const slate = await database
    .prepare('SELECT kind, mean, prompts, copies FROM forgiven WHERE owner = ?')
    .bind(owner)
    .first();
  const fresh =
    slate === null
      ? counts
      : since(counts, {
          kind: number_(slate, 'kind'),
          mean: number_(slate, 'mean'),
          prompts: number_(slate, 'prompts'),
          copies: number_(slate, 'copies'),
        });
  if (isCheating(fresh)) {
    await database
      .prepare(
        'INSERT INTO cheaters (owner, caught_at) VALUES (?, ?) ON CONFLICT (owner) DO NOTHING',
      )
      .bind(owner, now)
      .run();
  }
  return false;
}

/**
 * Whether a name belongs to someone else checked with GitHub, as their login
 * or the name on their entry, so an entry without GitHub cannot pass for them.
 */
async function nameTaken(database: D1Database, owner: string, name: string): Promise<boolean> {
  if (name === '') {
    return false;
  }
  const taken = await database
    .prepare(
      `SELECT 1 FROM scores WHERE verified = 1 AND owner <> ?
       AND (lower(github) = lower(?) OR lower(name) = lower(?)) LIMIT 1`,
    )
    .bind(owner, name, name)
    .first();
  return taken !== null;
}

export async function saveScore(database: D1Database, save: Save): Promise<SaveResult> {
  const { owner, upload, now, newId } = save;
  const day = utcDay(now);
  const found = await database
    .prepare('SELECT entry_id, upload_day, uploads_today, achievements FROM scores WHERE owner = ?')
    .bind(owner.id)
    .first();
  const sameDay = found !== null && text(found, 'upload_day') === day;
  const uploadsToday = sameDay ? number_(found, 'uploads_today') : 0;
  if (uploadsToday >= UPLOADS_PER_DAY) {
    return { ok: false, reason: 'limit' };
  }
  if (!owner.verified && (await nameTaken(database, owner.id, cleanName(upload.name)))) {
    return { ok: false, reason: 'name-taken' };
  }
  if (found === null && !owner.verified && !(await claimNewEntry(database, save.origin, day))) {
    return { ok: false, reason: 'new-entries' };
  }
  const entryId = found === null ? newId() : text(found, 'entry_id');
  // A made up upload is never saved. The owner goes to Skynet jail and keeps
  // the machines they had, and the next upload with real numbers lets them out.
  const before = await machinesOf(database, owner);
  const kept = keptBy(upload, before);
  const claim: Claim = {
    prompts: kept.reduce((total, machine) => total + machine.prompts, upload.prompts),
    tokensPerDay: kept.reduce(
      (total, machine) => total + machine.tokensPerDay,
      upload.tokensPerDay ?? 0,
    ),
  };
  const madeUp = isMadeUp(claim);
  await sentence(database, owner.id, madeUp ? claim : null, now);
  const machines = madeUp ? before : await saveMachine(database, owner, upload);
  const beta = await betaTester(database, owner.id);
  const sum = (pick: (machine: MachineCounts) => number): number =>
    machines.reduce((total, machine) => total + pick(machine), 0);
  const tools = knownTools(machines.flatMap((machine) => machine.tools));
  const kind = sum((machine) => machine.kind);
  const mean = sum((machine) => machine.mean);
  const prompts = sum((machine) => machine.prompts);
  const tokensPerDay = sum((machine) => machine.tokensPerDay);
  const copies = machines.reduce((total, machine) => total + machine.copies, 0);
  const forgiven = await judge(database, owner.id, { kind, mean, prompts, copies }, upload, now);
  const achievements = knownIds([
    ...combinedIds(machines),
    ...accountIds(githubIdOf(owner)),
    ...machineIds(machines),
    ...githubIds(owner, found),
    ...(beta === null ? [] : [BETA_TESTER]),
    ...(beta !== null && beta <= ALPHA_TESTERS ? [ALPHA_TESTER] : []),
  ]);
  await database
    .prepare(
      `INSERT INTO scores (owner, verified, entry_id, name, kind, mean, prompts, score, uploaded_at, upload_day, uploads_today, achievements, repeats, tokens_per_day, silo, tools, github)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner) DO UPDATE SET
         name = excluded.name, kind = excluded.kind, mean = excluded.mean,
         prompts = excluded.prompts, score = excluded.score, uploaded_at = excluded.uploaded_at,
         upload_day = excluded.upload_day, uploads_today = excluded.uploads_today,
         achievements = excluded.achievements, repeats = excluded.repeats,
         tokens_per_day = excluded.tokens_per_day, silo = excluded.silo, tools = excluded.tools,
         github = excluded.github`,
    )
    .bind(
      owner.id,
      owner.verified ? 1 : 0,
      entryId,
      cleanName(upload.name),
      kind,
      mean,
      prompts,
      reputationScore({ kind, mean }),
      now,
      day,
      uploadsToday + 1,
      achievements.join(','),
      repeatsText(combinedRepeats(machines, achievements)),
      tokensPerDay,
      siloTotal({ kind, mean, prompts, tokensPerDay }),
      tools.join(','),
      owner.github ?? '',
    )
    .run();
  const row = await database
    .prepare(`SELECT ${COLUMNS} FROM scores WHERE entry_id = ?`)
    .bind(entryId)
    .first();
  if (row === null) {
    throw new Error('the saved score could not be read back');
  }
  const standing = await standingOf(database, row);
  const { awards } = await awardsFor(database, await listed(database));
  const entry = awarded(standing.entry, awards);
  return {
    ok: true,
    standing: {
      ...standing,
      entry: withDates(entry, await dated(database, [entry], now)),
      machines: machines.length,
      ...(forgiven ? { forgiven } : {}),
    },
  };
}

/** A like for one entry, from a network on a day. */
export interface Like {
  readonly entry: string;
  readonly day: string;
  /** A hash of the day, the network and the entry, so a network can like each entry once a day. */
  readonly liker: string;
}

/**
 * Counts a like for a listed entry and returns how many it has. A second like
 * from the same network on the same day is not counted. Null when nobody
 * listed has the id.
 */
export async function likeEntry(database: D1Database, like: Like): Promise<number | null> {
  const found = await database
    .prepare(`SELECT likes FROM scores WHERE ${LISTED} AND entry_id = ?`)
    .bind(like.entry)
    .first();
  if (found === null) {
    return null;
  }
  const likes = number_(found, 'likes');
  await database.prepare('DELETE FROM likes WHERE day <> ?').bind(like.day).run();
  const seen = await database
    .prepare('SELECT day FROM likes WHERE liker = ?')
    .bind(like.liker)
    .first();
  if (seen !== null) {
    return likes;
  }
  await database
    .prepare('INSERT INTO likes (liker, day) VALUES (?, ?)')
    .bind(like.liker, like.day)
    .run();
  await database
    .prepare('UPDATE scores SET likes = likes + 1 WHERE entry_id = ?')
    .bind(like.entry)
    .run();
  return likes + 1;
}

export async function removeScore(database: D1Database, owner: Owner): Promise<void> {
  await database
    .prepare('DELETE FROM earned WHERE entry IN (SELECT entry_id FROM scores WHERE owner = ?)')
    .bind(owner.id)
    .run();
  await database.prepare('DELETE FROM machines WHERE owner = ?').bind(owner.id).run();
  await database.prepare('DELETE FROM scores WHERE owner = ?').bind(owner.id).run();
}
