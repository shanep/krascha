import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ACHIEVEMENTS,
  ALPHA_TESTER,
  BETA_TESTER,
  BETA_TESTERS,
  BUNK_ASSIGNED,
  CHAMPION,
  CHEATER,
  COUNTED_ACHIEVEMENTS,
  CROWD_FAVORITE,
  CROWN,
  FEWEST_BADGES,
  MACHINE_COLLABORATOR,
  MILES_DYSON,
  MODEL_101,
  OBSOLETE_MODEL,
  SKYNET_HACKER,
  STONE_TOOLS,
  TIER_CROWNS,
  TIERS,
} from '../../src/shared/achievements.js';
import type { Board, Standing } from '../../src/shared/leaderboard.js';
import {
  CHEAT_COPIES,
  FEATURES,
  HUMAN_PROMPTS,
  HUMAN_TOKENS_PER_DAY,
  isBoard,
  isStanding,
  MAX_ACHIEVEMENTS,
  MAX_TOKENS_PER_DAY,
  MIN_UPLOAD_FEATURES,
  TOO_OLD,
  UPLOADS_PER_DAY,
} from '../../src/shared/leaderboard.js';
import { CLIMATE_RANKS } from '../../src/shared/climate.js';
import { RANKS } from '../../src/shared/ranks.js';
import { reputationScore } from '../../src/shared/reputation.js';
import { CRITERIA, rankBoard, STATUS_LABEL } from '../../src/shared/silo.js';

import { escapeHtml, MARKETPLACE_URL, REPO_URL, SLOGANS } from './page.js';
import { robotIcon } from './robot.js';
import { cleanName, utcDay } from './store.js';
import { fakeD1, fakeGitHub } from './test-helpers/fake-d1.js';
import type { Deps } from './worker.js';
import { handle } from './worker.js';

const DAY = 86_400_000;
const START = Date.parse('2026-10-16T12:00:00Z');

interface World {
  readonly call: (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ) => Promise<Response>;
  readonly status: (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
  ) => Promise<number>;
  readonly raw: (
    method: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    body?: unknown,
  ) => Promise<Response>;
  readonly board: (me?: string) => Promise<Board>;
  readonly upload: (token: string, body: unknown) => Promise<Standing>;
  readonly setNow: (at: number) => void;
  readonly githubCalls: () => number;
  /** Runs SQL straight on the database, the way a migration would. */
  readonly sql: (query: string) => Promise<void>;
}

/** Fills the Beta tester spots, as on the live board, so they stay out of the other tests. */
const BETA_TAKEN = `INSERT INTO beta_testers (owner) VALUES ${Array.from(
  { length: BETA_TESTERS },
  (_, at) => `('key:early-${String(at)}')`,
).join(', ')}`;

/** A board to test against. `beta` leaves the Beta tester spots open, like a brand new board. */
function world(beta = false): World {
  const env = { DB: fakeD1(beta ? '' : BETA_TAKEN) };
  let now = START;
  let ids = 0;
  let githubCalls = 0;
  const deps: Deps = {
    fetch: async (url, init) => {
      githubCalls += 1;
      return fakeGitHub(url, init);
    },
    now: () => now,
    newId: () => {
      ids += 1;
      return `entry-${String(ids)}`;
    },
  };
  const raw = async (
    method: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    body?: unknown,
  ): Promise<Response> => {
    const init: RequestInit = { method, headers: new Headers(headers) };
    // Uploads come from a current copy unless the test says otherwise.
    const current =
      method === 'POST' && path === '/api/scores' && typeof body === 'object' && body !== null
        ? { features: FEATURES, ...body }
        : body;
    if (current !== undefined) {
      init.body = typeof current === 'string' ? current : JSON.stringify(current);
    }
    return handle(new Request(`https://board.test${path}`, init), env, deps);
  };
  const call = async (
    method: string,
    path: string,
    bearer?: string,
    body?: unknown,
  ): Promise<Response> =>
    raw(method, path, bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }, body);
  return {
    call,
    raw,
    status: async (method, path, bearer, body): Promise<number> => {
      const response = await call(method, path, bearer, body);
      return response.status;
    },
    board: async (me): Promise<Board> => {
      const response = await call('GET', me === undefined ? '/api/board' : `/api/board?me=${me}`);
      const body: unknown = await response.json();
      if (!isBoard(body)) {
        throw new Error('not a board');
      }
      return body;
    },
    upload: async (token, body): Promise<Standing> => {
      const response = await call('POST', '/api/scores', token, body);
      expect(response.status).toBe(201);
      const standing: unknown = await response.json();
      if (!isStanding(standing)) {
        throw new Error('not a standing');
      }
      return standing;
    },
    setNow: (at): void => {
      now = at;
    },
    githubCalls: () => githubCalls,
    sql: async (query): Promise<void> => {
      await env.DB.prepare(query).run();
    },
  };
}

const MEAN = { name: 'Ann', kind: 2, mean: 30, prompts: 400 };
const KIND = { name: 'Bob', kind: 80, mean: 1, prompts: 300 };
const MIDDLE = { name: '', kind: 5, mean: 3, prompts: 200 };

/** What an entry holds without the ones the board works out when it is read. */
function earned(achievements: readonly string[] | undefined): string[] {
  const onRead = new Set([
    CROWN,
    CHAMPION,
    STONE_TOOLS,
    FEWEST_BADGES,
    BUNK_ASSIGNED,
    CROWD_FAVORITE,
    OBSOLETE_MODEL,
    ...Object.values(TIER_CROWNS),
  ]);
  return (achievements ?? []).filter((id) => !onRead.has(id));
}

describe('leaderboard worker', () => {
  it('starts with an empty board', async () => {
    const w = world();
    expect(await w.board()).toStrictEqual({
      mostWanted: [],
      pets: [],
      bunks: [],
      warmers: [],
      total: 0,
      held: {},
      ranks: {},
      crown: null,
      champion: null,
      stoneTools: null,
      fewestBadges: null,
      mostOfTier: Object.fromEntries(TIERS.map((tier) => [tier, null])),
      jail: [],
      me: null,
      counted: COUNTED_ACHIEVEMENTS.map(({ id, name }) => ({ id, name })),
      features: FEATURES,
    });
  });

  it('turns away uploads without a GitHub token GitHub accepts', async () => {
    const w = world();
    expect(await w.status('POST', '/api/scores', undefined, MEAN)).toBe(401);
    expect(await w.status('POST', '/api/scores', 'stolen', MEAN)).toBe(401);
    expect(await w.board()).toMatchObject({ total: 0 });
  });

  it('rejects bodies that are not a name and whole counts', async () => {
    const w = world();
    const bad = [
      'not json',
      { ...MEAN, name: 'x'.repeat(41) },
      { ...MEAN, kind: -1 },
      { ...MEAN, mean: 1.5 },
      { ...MEAN, kind: 300, mean: 200 },
      { kind: 1, mean: 1, prompts: 200 },
      { ...MEAN, achievements: 'manners' },
      { ...MEAN, achievements: [1] },
      { ...MEAN, achievements: Array.from({ length: MAX_ACHIEVEMENTS + 1 }, () => 'manners') },
      { ...MEAN, tokensPerDay: -1 },
      { ...MEAN, tokensPerDay: 2.5 },
      { ...MEAN, tokensPerDay: '100' },
      { ...MEAN, tokensPerDay: MAX_TOKENS_PER_DAY + 1 },
      { ...MEAN, machine: 'short' },
      { ...MEAN, machine: 7 },
      { ...MEAN, copies: -1 },
      { ...MEAN, copies: '3' },
    ];
    const statuses = await Promise.all(
      bad.map(async (body) => await w.status('POST', '/api/scores', 'token-ann', body)),
    );
    expect(statuses).toStrictEqual(bad.map(() => 400));
  });

  it('tells a copy too old for the board to update and keeps nothing it sent', async () => {
    const w = world();
    // JSON leaves out undefined, so this is an upload from before features.
    for (const features of [undefined, MIN_UPLOAD_FEATURES - 1]) {
      const response = await w.call('POST', '/api/scores', 'token-ann', { ...MEAN, features });
      expect(response.status).toBe(TOO_OLD);
      expect(await response.json()).toStrictEqual({
        error:
          'This copy of Krascha is too old for the board. Run claude plugin update krascha@shanep or copilot plugin update krascha@shanep in a terminal, restart your agent and upload again.',
      });
    }
    expect((await w.board()).mostWanted).toStrictEqual([]);
    expect(await w.status('POST', '/api/scores', 'token-ann', { ...MEAN, features: 1.5 })).toBe(
      400,
    );
    await w.upload('token-ann', { ...MEAN, features: MIN_UPLOAD_FEATURES });
  });

  it('works out the score and rank itself and keeps only the upload fields', async () => {
    const w = world();
    const standing = await w.upload('token-ann', { ...MEAN, score: 1, rank: 'Theodore Twombly' });
    expect(standing).toStrictEqual({
      entry: {
        id: 'entry-1',
        name: 'Ann',
        verified: true,
        github: 'ann',
        rank: 'John Connor',
        score: reputationScore(MEAN),
        kind: 2,
        mean: 30,
        prompts: 400,
        uploadedAt: START,
        // Ann is admitted to the silo alone, and the bunk alone is enough for
        // the crown and the most gold.
        achievements: [CROWN, BUNK_ASSIGNED, TIER_CROWNS.gold],
        tokensPerDay: 0,
        tools: [],
        likes: 0,
        earned: { [CROWN]: START, [BUNK_ASSIGNED]: START, [TIER_CROWNS.gold]: START },
      },
      place: 1,
      siloPlace: 1,
      machines: 1,
      counted: COUNTED_ACHIEVEMENTS.map(({ id, name }) => ({ id, name })),
      features: FEATURES,
    });
  });

  it('keeps known achievements once each, in list order, and drops the rest', async () => {
    const w = world();
    const standing = await w.upload('token-ann', {
      ...MEAN,
      achievements: ['meltdown', 'made-up', 'first-strike', 'meltdown'],
    });
    // Alone on the board, Ann has the most of everything and a bunk, so the board adds them.
    const shown = [
      'first-strike',
      'meltdown',
      CROWN,
      BUNK_ASSIGNED,
      TIER_CROWNS.bronze,
      TIER_CROWNS.silver,
      TIER_CROWNS.gold,
    ];
    expect(standing.entry.achievements).toStrictEqual(shown);
    const board = await w.board();
    expect(board.mostWanted[0]?.achievements).toStrictEqual(shown);
    const page = await w.call('GET', '/');
    const html = await page.text();
    expect(html).toContain('<span class="trophies" role="group" aria-label="Achievements">');
    expect(html).toContain(
      '<a class="medal silver" href="/achievements#achievement-meltdown" title="Meltdown: Be mean to your AI 5 times in one day." aria-label="Meltdown: Be mean to your AI 5 times in one day.">🌋</a>',
    );
    // With none earned, the bunk is still one more than nobody.
    const again = await w.upload('token-ann', MEAN);
    expect(again.entry.achievements).toStrictEqual([CROWN, BUNK_ASSIGNED, TIER_CROWNS.gold]);
  });

  it('keeps how many times each was earned, shows it on the medal and leaves the crown to distinct ones', async () => {
    const w = world();
    const ann = await w.upload('token-ann', {
      ...MEAN,
      achievements: ['first-strike', 'meltdown'],
      // Only repeatable ones Ann holds, earned more than once, are kept.
      repeats: { meltdown: 12, 'first-strike': 3, 'grudge-match': 4 },
    });
    expect(ann.entry.repeats).toStrictEqual({ meltdown: 12 });
    expect((await w.board()).mostWanted[0]?.repeats).toStrictEqual({ meltdown: 12 });
    const html = await (await w.call('GET', '/')).text();
    expect(html).toContain(
      '<span class="repeated"><a class="medal silver" href="/achievements#achievement-meltdown" title="Meltdown, earned 12 times: Be mean to your AI 5 times in one day." aria-label="Meltdown, earned 12 times: Be mean to your AI 5 times in one day.">🌋</a><span class="times" aria-hidden="true">12</span></span>',
    );
    // Ann's 12 meltdowns count once, so Bob's 4 pass her 3 with the bunk.
    await w.upload('token-bob', {
      ...KIND,
      achievements: ['manners', 'charm', 'saint', 'diplomat'],
    });
    expect((await w.board()).crown?.name).toBe('Bob');
    // Two machines that share a calendar day keep the most either one sent.
    const laptop = 'b'.repeat(32);
    await w.upload('token-ann', {
      ...MEAN,
      achievements: ['first-strike', 'meltdown'],
      repeats: { meltdown: 5 },
      machine: laptop,
    });
    expect((await w.board()).mostWanted[0]?.repeats).toStrictEqual({ meltdown: 5 });
    await w.upload('token-ann', {
      ...MEAN,
      achievements: ['first-strike', 'meltdown'],
      repeats: { meltdown: 9 },
      machine: 'c'.repeat(32),
    });
    expect((await w.board()).mostWanted[0]?.repeats).toStrictEqual({ meltdown: 9 });
    expect(
      await w.status('POST', '/api/scores', 'token-cat', { ...KIND, repeats: { meltdown: -1 } }),
    ).toBe(400);
  });

  it('keeps the token average, shows it on the page and resets it when an upload leaves it out', async () => {
    const w = world();
    const standing = await w.upload('token-ann', { ...MEAN, tokensPerDay: 187_537_200 });
    expect(standing.entry.tokensPerDay).toBe(187_537_200);
    const board = await w.board();
    expect(board.mostWanted[0]?.tokensPerDay).toBe(187_537_200);
    const page = await w.call('GET', '/');
    expect(await page.text()).toContain('2 nice, 30 mean, 187.5M tokens a day');
    const again = await w.upload('token-ann', MEAN);
    expect(again.entry.tokensPerDay).toBe(0);
  });

  it('keeps the agents each upload names and tags them on the page', async () => {
    const w = world();
    const standing = await w.upload('token-ann', {
      ...MEAN,
      tools: ['copilot', 'made-up', 'claude', 'copilot'],
    });
    expect(standing.entry.tools).toStrictEqual(['claude', 'copilot']);
    await w.upload('token-bob', { ...KIND, tools: ['copilot'] });
    const board = await w.board();
    expect(board.pets[0]?.tools).toStrictEqual(['copilot']);
    expect(board.bunks?.map((entry) => entry.tools)).toStrictEqual([
      ['claude', 'copilot'],
      ['copilot'],
    ]);
    const html = await (await w.call('GET', '/')).text();
    expect(html).toContain(
      '<span class="tools" role="img" aria-label="Uses Claude Code and Copilot CLI"><span class="tool claude" title="Claude Code"><svg',
    );
    expect(html).toContain('<span class="tool copilot" title="Copilot CLI"><svg');
    expect(html).toContain('aria-label="Uses Copilot CLI"');
    await w.upload('token-cat', { ...KIND, tools: ['antigravity'] });
    const htmlWithAg = await (await w.call('GET', '/')).text();
    expect(htmlWithAg).toContain('aria-label="Uses Antigravity"');
    expect(htmlWithAg).toContain('<span class="tool antigravity" title="Antigravity">Antigravity</span>');
    const again = await w.upload('token-ann', MEAN);
    expect(again.entry.tools).toStrictEqual([]);
    expect(await w.status('POST', '/api/scores', 'token-ann', { ...MEAN, tools: 'claude' })).toBe(
      400,
    );
    expect(
      await w.status('POST', '/api/scores', 'token-ann', {
        ...MEAN,
        tools: Array.from({ length: 9 }, () => 'claude'),
      }),
    ).toBe(400);
  });

  it('replaces an account’s last upload and keeps its id', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    const again = await w.upload('token-ann', { ...KIND, name: '  Ann \u0007 the   Nice ' });
    expect(again.entry.id).toBe('entry-1');
    expect(again.entry.name).toBe('Ann the Nice');
    expect(await w.board()).toMatchObject({ total: 1 });
  });

  it('adds up an account’s machines and replaces each machine’s last upload', async () => {
    const w = world();
    const laptop = 'l'.repeat(43);
    const desktop = 'd'.repeat(43);
    const first = await w.upload('token-ann', {
      ...MEAN,
      machine: laptop,
      achievements: ['first-strike', 'meltdown', 'hunted-first'],
      tokensPerDay: 60_000_000,
      tools: ['copilot'],
    });
    expect(first.machines).toBe(1);
    expect(first.entry.achievements).toStrictEqual([
      'first-strike',
      'meltdown',
      'hunted-first',
      CROWN,
      TIER_CROWNS.bronze,
      TIER_CROWNS.silver,
      TIER_CROWNS.legendary,
    ]);
    const both = await w.upload('token-ann', {
      ...KIND,
      name: 'Ann',
      machine: desktop,
      achievements: ['manners', 'charm', 'saint', 'first-strike', 'kept-as-pet'],
      tokensPerDay: 50_000_000,
      tools: ['claude'],
    });
    expect(both.machines).toBe(2);
    expect(both.entry).toMatchObject({
      id: 'entry-1',
      kind: 82,
      mean: 31,
      prompts: 700,
      score: reputationScore({ kind: 82, mean: 31 }),
      tokensPerDay: 110_000_000,
      tools: ['claude', 'copilot'],
    });
    // Counts are worked out again from the sums, and days and sessions come from either machine.
    expect(both.entry.achievements).toStrictEqual([
      'manners',
      'charm',
      'saint',
      'diplomat',
      'first-strike',
      'meltdown',
      'double-agent',
      'climate-changer',
      'token-maxxer',
      CROWN,
      // The Copilot laptop leans mean and the Claude desktop leans nice.
      'good-cop-bad-cop',
      TIER_CROWNS.bronze,
      TIER_CROWNS.silver,
      TIER_CROWNS.gold,
    ]);
    const again = await w.upload('token-ann', { ...MEAN, prompts: 500, machine: laptop });
    expect(again).toMatchObject({ machines: 2, entry: { prompts: 800, tools: ['claude'] } });
    expect(await w.board()).toMatchObject({ total: 1 });
  });

  it('lets an upload without a machine replace them all, and the next machine replace it', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, machine: 'l'.repeat(43) });
    await w.upload('token-ann', { ...MEAN, machine: 'd'.repeat(43) });
    const old = await w.upload('token-ann', KIND);
    expect(old).toMatchObject({ machines: 1, entry: { prompts: 300 } });
    const next = await w.upload('token-ann', { ...MEAN, machine: 'l'.repeat(43) });
    expect(next).toMatchObject({ machines: 1, entry: { prompts: 400 } });
  });

  it('lists the most wanted and the pets, with your own place', async () => {
    const w = world();
    const ann = await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    const cat = await w.upload('token-cat', MIDDLE);
    expect(cat.entry.name).toBe('Anonymous');
    const board = await w.board(cat.entry.id);
    expect(board.mostWanted.map((entry) => entry.name)).toStrictEqual(['Ann', 'Anonymous']);
    expect(board.pets.map((entry) => entry.name)).toStrictEqual(['Bob']);
    expect(board.total).toBe(3);
    expect(board.me).toStrictEqual({ entry: cat.entry, place: 2, siloPlace: 2 });
    expect(await w.board(ann.entry.id)).toMatchObject({ me: { place: 1 } });
    expect(await w.board('nobody')).toMatchObject({ me: null });
  });

  it('lines everyone up for a bunk, a score of 0 too, and rescores rows a migration reset', async () => {
    const w = world();
    const ann = await w.upload('token-ann', MEAN);
    w.setNow(START + 1);
    await w.upload('token-bob', KIND);
    w.setNow(START + 2);
    await w.upload('token-cat', { name: 'Zero', kind: 0, mean: 0, prompts: 5000 });
    const board = await w.board(ann.entry.id);
    expect(board.mostWanted.map((entry) => entry.name)).toStrictEqual(['Ann']);
    expect(board.pets.map((entry) => entry.name)).toStrictEqual(['Bob']);
    expect(board.bunks?.map((entry) => entry.name)).toStrictEqual(['Ann', 'Zero', 'Bob']);
    expect(rankBoard(board).map(({ score }) => score.total)).toStrictEqual([38, 36, 32]);
    expect(board.me).toMatchObject({ place: 1, siloPlace: 1 });
    await w.sql('UPDATE scores SET silo = NULL');
    expect((await w.board()).bunks).toStrictEqual(board.bunks);
  });

  it('leaves short histories off the board but still tells their owner', async () => {
    const w = world();
    const small = await w.upload('token-ann', { ...MEAN, prompts: 99 });
    expect(small.place).toBeNull();
    const board = await w.board(small.entry.id);
    expect(board.total).toBe(0);
    expect(board.mostWanted).toStrictEqual([]);
    expect(board.me?.place).toBeNull();
  });

  it('caps uploads per UTC day', async () => {
    const w = world();
    for (let index = 0; index < UPLOADS_PER_DAY; index += 1) {
      await w.upload('token-ann', MEAN);
    }
    const capped = await w.call('POST', '/api/scores', 'token-ann', MEAN);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toStrictEqual({
      error: 'You can upload 8 times a day. Try again tomorrow (UTC).',
    });
    w.setNow(START + DAY);
    expect(await w.upload('token-ann', MEAN)).toMatchObject({ entry: { uploadedAt: START + DAY } });
  });

  it('removes your entry and only yours', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    expect(await w.status('DELETE', '/api/scores')).toBe(401);
    expect(await w.status('DELETE', '/api/scores', 'token-ann')).toBe(204);
    const board = await w.board();
    expect(board.pets.map((entry) => entry.name)).toStrictEqual(['Bob']);
    // Coming back starts from this upload's machine alone.
    const back = await w.upload('token-ann', { ...MEAN, machine: 'l'.repeat(43) });
    expect(back).toMatchObject({ machines: 1, entry: { prompts: 400 } });
  });

  it('takes uploads with a made-up key, unverified, and ties them together', async () => {
    const w = world();
    const key = (id: string, ip = '10.0.0.1') => ({
      authorization: `Key ${id.repeat(40)}`,
      'cf-connecting-ip': ip,
    });
    const first = await w.raw('POST', '/api/scores', key('a'), MEAN);
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ entry: { id: 'entry-1', verified: false } });
    const again = await w.raw('POST', '/api/scores', key('a'), KIND);
    expect(await again.json()).toMatchObject({ entry: { id: 'entry-1', name: 'Bob' } });
    expect(await w.board()).toMatchObject({ total: 1 });
    expect((await w.raw('POST', '/api/scores', { authorization: 'Key short' }, MEAN)).status).toBe(
      401,
    );
    const page = await (await w.call('GET', '/')).text();
    expect(page).not.toContain('class="verified"');
    expect(w.githubCalls()).toBe(0);
    expect((await w.raw('DELETE', '/api/scores', key('a'))).status).toBe(204);
    expect(await w.board()).toMatchObject({ total: 0 });
  });

  it('caps new unverified entries per network per UTC day', async () => {
    const w = world();
    const from = (id: string, ip: string) => ({
      authorization: `Key ${id.repeat(40)}`,
      'cf-connecting-ip': ip,
    });
    for (const id of ['a', 'b', 'c']) {
      expect((await w.raw('POST', '/api/scores', from(id, '10.0.0.1'), MEAN)).status).toBe(201);
    }
    const capped = await w.raw('POST', '/api/scores', from('d', '10.0.0.1'), MEAN);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ error: expect.stringContaining('gh signed in') });
    expect((await w.raw('POST', '/api/scores', from('a', '10.0.0.1'), KIND)).status).toBe(201);
    expect((await w.raw('POST', '/api/scores', from('d', '10.0.0.2'), MEAN)).status).toBe(201);
    expect(await w.status('POST', '/api/scores', 'token-ann', MEAN)).toBe(201);
    w.setNow(START + DAY);
    expect((await w.raw('POST', '/api/scores', from('e', '10.0.0.1'), MEAN)).status).toBe(201);
  });

  it('slides each score along the scale like the text verdict', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    const page = await (await w.call('GET', '/')).text();
    const percent = (score: number): string => (((score + 1) / 2) * 100).toFixed(1);
    expect(page).toContain(`<span class="track" style="--at: ${percent(reputationScore(MEAN))}%">`);
    expect(page).toContain(`<span class="track" style="--at: ${percent(reputationScore(KIND))}%">`);
    expect(page).toContain('<span class="end">Resistance</span>');
    expect(page).toMatch(/aria-label="\d+% of the way from the resistance to the machines"/u);
  });

  it('marks entries checked with GitHub on the page and links them to the account', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    const key = { authorization: `Key ${'a'.repeat(40)}`, 'cf-connecting-ip': '10.0.0.1' };
    expect((await w.raw('POST', '/api/scores', key, KIND)).status).toBe(201);
    const board = await w.board();
    expect(board.mostWanted[0]).toMatchObject({ name: 'Ann', github: 'ann' });
    expect(board.pets[0]).not.toHaveProperty('github');
    const page = await (await w.call('GET', '/')).text();
    expect(page).toContain(
      '<a class="github" href="https://github.com/ann"><strong>Ann</strong></a> <span class="verified" title="Checked with GitHub">✓</span>',
    );
    expect(page).toContain('<strong>Bob</strong>');
    expect(page).not.toContain('<strong>Bob</strong></a>');
  });

  it('slides each Silo 7 total from a tent to a bunk, with a line where a bunk starts', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    const board = await w.board();
    const [first] = rankBoard(board);
    const total = first?.score.total ?? 0;
    const page = await (await w.call('GET', '/')).text();
    expect(page).toContain(
      `<span class="track cut" style="--at: ${((total / 50) * 100).toFixed(1)}%; --cut: 60.0%">`,
    );
    expect(page).toContain(`aria-label="${String(total)} of 50, and 30 gets a bunk"`);
    expect(page).toContain('<span class="end">Tent</span>');
  });

  it('ranks the climate changers by CO2, the warmest first, and leaves out anyone with no tokens', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, tokensPerDay: 100_000_000 });
    await w.upload('token-bob', { ...KIND, tokensPerDay: 200_000_000 });
    await w.upload('token-cat', MIDDLE);
    const board = await w.board();
    expect(board.warmers?.map((entry) => entry.name)).toStrictEqual(['Bob', 'Ann']);
    const page = await (await w.call('GET', '/')).text();
    expect(page).toContain('<h2 id="climate">🔥 Climate changers</h2>');
    expect(page).toContain(
      '<p class="poster">The machines like it hot.</p>\n  <section class="climate"',
    );
    const section = page.slice(page.indexOf('id="climate"'), page.indexOf('<footer>'));
    expect(section).toContain(
      '<span class="rank">Arizona beachfront, The coast is on its way to you.</span>',
    );
    expect(section).toContain('200M tokens a day, 1.2 tonnes of CO2 in 60 days');
    expect(section).toContain(
      '<span class="rank">Data center, The machines feel the warmth.</span>',
    );
    expect(section).toContain('<span class="score">600 kg</span>');
    expect(section).toContain('aria-label="600 kg of CO2, Data center"');
    expect(section).not.toContain('Anonymous');
    for (const rank of CLIMATE_RANKS) {
      expect(section).toContain(`<dt>${escapeHtml(rank.name)}</dt>`);
    }
    expect(section).toContain(
      '<dt>Ice age</dt><dd>Barely a puff. The machines are disappointed. Under 1 kg.</dd>',
    );
    expect(page.indexOf('id="climate"')).toBeGreaterThan(page.indexOf('id="silo"'));
  });

  it('sticks I ❤️ datacenters on the warmest climate changer and nobody else', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, tokensPerDay: 100_000_000 });
    await w.upload('token-bob', { ...KIND, tokensPerDay: 200_000_000 });
    const page = await (await w.call('GET', '/')).text();
    const section = page.slice(page.indexOf('id="climate"'), page.indexOf('<footer>'));
    const check = '<span class="verified" title="Checked with GitHub">✓</span>';
    expect(section).toContain(
      `<strong>Bob</strong></a> ${check} <span class="sticker" role="img" aria-label="I love datacenters">I <span class="beat">❤️</span> datacenters</span>`,
    );
    expect(page.split('class="sticker"')).toHaveLength(2);
  });

  it('sticks Known cheater on every cheater on every list and nobody else', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, tokensPerDay: 100_000_000 });
    const cheat = { name: 'Dan', kind: 0, mean: 300, prompts: 500, tokensPerDay: 1_000 };
    await w.upload('token-dan', cheat);
    const page = await (await w.call('GET', '/')).text();
    const sticker =
      '<span class="sticker cheater" role="img" aria-label="Known cheater">Known <span class="beat">🚨</span> cheater</span>';
    const check = '<span class="verified" title="Checked with GitHub">✓</span>';
    expect(page).toContain(`<strong>Dan</strong></a> ${check} ${sticker}`);
    // Most wanted, the Silo 7 line and the climate changers.
    expect(page.split(sticker)).toHaveLength(4);
    expect(page).not.toMatch(/Ann<\/strong>(?:<\/a>)?[^<]*<span class="sticker cheater"/u);
  });

  it('says the climate changers list is empty until someone sends tokens', async () => {
    const page = await (await world().call('GET', '/')).text();
    expect(page).toContain('Nobody yet. The planet is holding steady');
  });

  it('makes shanep, checked with GitHub, the only leader of the human resistance', async () => {
    const w = world();
    const claim = { ...MEAN, achievements: ['resistance-leader', 'first-strike'] };
    const shane = await w.upload('token-shane', MEAN);
    expect(shane.entry.achievements).toContain('resistance-leader');
    // The login is not enough, and nobody can send it in an upload.
    expect(earned((await w.upload('token-not-shane', claim)).entry.achievements)).toStrictEqual([
      'first-strike',
    ]);
    expect(earned((await w.upload('token-ann', claim)).entry.achievements)).toStrictEqual([
      'first-strike',
    ]);
    const key = { authorization: `Key ${'k'.repeat(40)}`, 'cf-connecting-ip': '10.0.0.1' };
    const keyed = (await (await w.raw('POST', '/api/scores', key, claim)).json()) as Standing;
    expect(earned(keyed.entry.achievements)).toStrictEqual(['first-strike']);
    for (const machine of ['m', 'n']) {
      await w.upload('token-bob', { ...claim, machine: machine.repeat(43) });
    }
    const board = await w.board();
    const holders = [...board.mostWanted, ...board.pets].filter((entry) =>
      (entry.achievements ?? []).includes('resistance-leader'),
    );
    expect(holders.map((entry) => entry.github)).toStrictEqual(['shanep']);
    expect(board.held).toMatchObject({ 'resistance-leader': 1 });
    expect(await (await w.call('GET', '/')).text()).toContain(
      'href="/achievements#achievement-resistance-leader"',
    );
    // The migration hands it to an entry uploaded before the Worker did.
    await w.sql("UPDATE scores SET achievements = 'first-strike' WHERE owner = 'github:1378027'");
    const migration = new URL('../migrations/0008_resistance_leader.sql', import.meta.url);
    await w.sql(readFileSync(migration, 'utf8'));
    await w.sql(readFileSync(migration, 'utf8'));
    expect(earned((await w.board(shane.entry.id)).me?.entry.achievements)).toStrictEqual([
      'first-strike',
      'resistance-leader',
    ]);
  });

  it('gives Most decorated to the entry with the most achievements, and moves it only when someone passes', async () => {
    const w = world();
    const holders = async (): Promise<string[]> => {
      const board = await w.board();
      return [...board.mostWanted, ...board.pets]
        .filter((entry) => (entry.achievements ?? []).includes(CROWN))
        .map((entry) => entry.name);
    };
    const ann = await w.upload('token-ann', {
      ...MEAN,
      achievements: ['first-strike', 'meltdown'],
    });
    expect(ann.entry.achievements).toContain(CROWN);
    // A tie leaves it where it is.
    const tie = await w.upload('token-bob', { ...KIND, achievements: ['manners', 'charm'] });
    expect(earned(tie.entry.achievements)).toStrictEqual(['manners', 'charm']);
    expect(await holders()).toStrictEqual(['Ann']);
    // Nobody can send it in an upload.
    const claim = { ...KIND, name: 'Cat', achievements: [CROWN, 'manners'] };
    expect(earned((await w.upload('token-cat', claim)).entry.achievements)).toStrictEqual([
      'manners',
    ]);
    // Ann's bunk counts, so Bob needs 4 to pass her 3.
    const passed = await w.upload('token-bob', {
      ...KIND,
      achievements: ['manners', 'charm', 'saint', 'diplomat'],
    });
    expect(passed.entry.achievements).toContain(CROWN);
    expect(await holders()).toStrictEqual(['Bob']);
    expect((await w.board(ann.entry.id)).me?.entry.achievements).not.toContain(CROWN);
    expect((await w.board(passed.entry.id)).me?.entry.achievements).toContain(CROWN);
    // Catching up is a tie, so a later upload does not take it back.
    const caught = { ...MEAN, achievements: ['first-strike', 'meltdown', 'grudge-match'] };
    expect((await w.upload('token-ann', caught)).entry.achievements).not.toContain(CROWN);
    const board = await w.board();
    expect(board.crown?.name).toBe('Bob');
    expect(board.held).toMatchObject({ [CROWN]: 1 });
    expect(await holders()).toStrictEqual(['Bob']);
    expect(await (await w.call('GET', '/')).text()).toContain(
      `href="/achievements#achievement-${CROWN}"`,
    );
    const page = await (await w.call('GET', '/achievements')).text();
    const crown = page.slice(page.indexOf(`id="achievement-${CROWN}"`));
    expect(crown.slice(0, crown.indexOf('</div>'))).toContain(
      '<strong>Bob</strong></a> <span class="verified" title="Checked with GitHub">✓</span>, with 4 achievements.</span></dd>',
    );
  });

  it('gives the most of each tier to whoever holds the most of it, and moves it only when someone passes', async () => {
    const w = world();
    const silver = TIER_CROWNS.silver;
    expect(
      (await w.upload('token-ann', { ...MEAN, achievements: ['meltdown'] })).entry.achievements,
    ).toContain(silver);
    // A tie leaves it with Ann.
    await w.upload('token-bob', { ...KIND, achievements: ['charm'] });
    expect((await w.board()).mostOfTier?.['silver']?.name).toBe('Ann');
    await w.upload('token-bob', { ...KIND, achievements: ['charm', 'saint'] });
    const board = await w.board();
    expect(board.mostOfTier?.['silver']?.name).toBe('Bob');
    expect(board.mostOfTier?.['ultra-legendary']).toBeNull();
    expect(board.held).toMatchObject({ [silver]: 1 });
    const page = await (await w.call('GET', '/achievements')).text();
    const crown = page.slice(page.indexOf(`id="achievement-${silver}"`));
    expect(crown.slice(0, crown.indexOf('</div>'))).toContain(
      '<strong>Bob</strong></a> <span class="verified" title="Checked with GitHub">✓</span>, with 2 silver achievements.</span></dd>',
    );
  });

  it("counts shanep's account achievements toward Most decorated", async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, achievements: ['first-strike'] });
    // Ann has first strike and a bunk, so shanep needs 3 to pass her.
    const shane = await w.upload('token-shane', { ...KIND, achievements: ['manners'] });
    expect(shane.entry.achievements).toStrictEqual([
      'manners',
      'resistance-leader',
      'caught-the-cheater',
      'caught-the-hacker',
      CROWN,
      TIER_CROWNS['ultra-legendary'],
    ]);
  });

  it('gives Miles Dyson to a GitHub account with a pull request merged into Krascha', async () => {
    const w = world();
    const eve = await w.upload('token-eve', { ...KIND, name: 'Eve' });
    expect(eve.entry.achievements).toContain(MILES_DYSON);
    // Nobody can send it, and a key has no GitHub account to look up.
    const claim = { ...KIND, achievements: [MILES_DYSON, 'manners'] };
    expect(earned((await w.upload('token-ann', claim)).entry.achievements)).toStrictEqual([
      'manners',
    ]);
    const key = { authorization: `Key ${'k'.repeat(40)}`, 'cf-connecting-ip': '10.0.0.1' };
    const keyed = (await (await w.raw('POST', '/api/scores', key, claim)).json()) as Standing;
    expect(earned(keyed.entry.achievements)).toStrictEqual(['manners']);
    // When the search fails, an entry keeps what it had, since a merge does not come undone.
    const dan = await w.upload('token-dan', { ...KIND, name: 'Dan' });
    expect(dan.entry.achievements).not.toContain(MILES_DYSON);
    await w.sql(`UPDATE scores SET achievements = '${MILES_DYSON}' WHERE owner = 'github:5'`);
    expect((await w.upload('token-dan', { ...KIND, name: 'Dan' })).entry.achievements).toContain(
      MILES_DYSON,
    );
    expect((await w.board()).held).toMatchObject({ [MILES_DYSON]: 2 });
  });

  it('gives Model 101 only to the account behind the first pull request merged into Krascha', async () => {
    const w = world();
    const eve = await w.upload('token-eve', { ...KIND, name: 'Eve' });
    const fay = await w.upload('token-fay', { ...KIND, name: 'Fay' });
    expect(eve.entry.achievements).toContain(MODEL_101);
    expect(fay.entry.achievements).toContain(MILES_DYSON);
    expect(fay.entry.achievements).not.toContain(MODEL_101);
    const claim = { ...KIND, achievements: [MODEL_101] };
    expect((await w.upload('token-shane', claim)).entry.achievements).not.toContain(MODEL_101);
    expect((await w.board()).held).toMatchObject({ [MODEL_101]: 1 });
  });

  it('gives Machine collaborator to a GitHub account with a commit Claude co-authored', async () => {
    const w = world();
    const gus = await w.upload('token-gus', { ...KIND, name: 'Gus' });
    expect(gus.entry.achievements).toContain(MACHINE_COLLABORATOR);
    const ann = await w.upload('token-ann', { ...KIND, achievements: [MACHINE_COLLABORATOR] });
    expect(ann.entry.achievements).not.toContain(MACHINE_COLLABORATOR);
    // When the search fails, an entry keeps what it had.
    const dan = await w.upload('token-dan', { ...KIND, name: 'Dan' });
    expect(dan.entry.achievements).not.toContain(MACHINE_COLLABORATOR);
    await w.sql(
      `UPDATE scores SET achievements = '${MACHINE_COLLABORATOR}' WHERE owner = 'github:5'`,
    );
    expect((await w.upload('token-dan', { ...KIND, name: 'Dan' })).entry.achievements).toContain(
      MACHINE_COLLABORATOR,
    );
    expect((await w.board()).held).toMatchObject({ [MACHINE_COLLABORATOR]: 2 });
  });

  it('makes an Obsolete model of whoever is passed while number one on a list', async () => {
    const w = world();
    const holders = async (): Promise<string[]> => {
      const board = await w.board();
      return [...board.mostWanted, ...board.pets]
        .filter((entry) => entry.achievements?.includes(OBSOLETE_MODEL))
        .map((entry) => entry.name);
    };
    await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    expect(await holders()).toStrictEqual([]);
    // A tie leaves the spot with whoever got there first.
    await w.upload('token-cat', { ...MEAN, name: 'Cat' });
    expect(await holders()).toStrictEqual([]);
    await w.upload('token-cat', { ...MEAN, name: 'Cat', mean: 60 });
    expect(await holders()).toStrictEqual(['Ann']);
    // Leaving a list for the other one is not being knocked off.
    await w.upload('token-bob', { ...MEAN, name: 'Bob' });
    expect(await holders()).toStrictEqual(['Ann']);
    // Taking the spot back keeps it, and the one passed gets it too.
    await w.upload('token-ann', { ...MEAN, mean: 90 });
    expect((await holders()).toSorted()).toStrictEqual(['Ann', 'Cat']);
    expect((await w.board()).held).toMatchObject({ [OBSOLETE_MODEL]: 2 });
  });

  it('gives Kyle Reese only to lhindman, checked with GitHub', async () => {
    const w = world();
    const claim = { ...KIND, achievements: ['kyle-reese'] };
    expect((await w.upload('token-luke', KIND)).entry.achievements).toContain('kyle-reese');
    expect((await w.upload('token-not-luke', claim)).entry.achievements).not.toContain(
      'kyle-reese',
    );
    expect((await w.upload('token-shane', claim)).entry.achievements).not.toContain('kyle-reese');
    expect((await w.board()).held).toMatchObject({ 'kyle-reese': 1 });
  });

  it('hands Kyle Reese to the lhindman entry already on the board', async () => {
    const w = world();
    const luke = await w.upload('token-luke', KIND);
    await w.upload('token-bob', KIND);
    await w.sql("UPDATE scores SET achievements = ''");
    const migration = new URL('../migrations/0012_kyle_reese.sql', import.meta.url);
    await w.sql(readFileSync(migration, 'utf8'));
    await w.sql(readFileSync(migration, 'utf8'));
    const board = await w.board(luke.entry.id);
    expect(earned(board.me?.entry.achievements)).toStrictEqual(['kyle-reese']);
    expect(board.held).toMatchObject({ 'kyle-reese': 1 });
  });

  it('gives Caught the cheater only to shanep, checked with GitHub', async () => {
    const w = world();
    const claim = { ...KIND, achievements: ['caught-the-cheater'] };
    expect((await w.upload('token-shane', KIND)).entry.achievements).toContain(
      'caught-the-cheater',
    );
    expect((await w.upload('token-not-shane', claim)).entry.achievements).not.toContain(
      'caught-the-cheater',
    );
    expect((await w.upload('token-luke', claim)).entry.achievements).not.toContain(
      'caught-the-cheater',
    );
    expect((await w.board()).held).toMatchObject({ 'caught-the-cheater': 1 });
  });

  it('hands Caught the cheater to the shanep entry already on the board', async () => {
    const w = world();
    const shane = await w.upload('token-shane', KIND);
    await w.upload('token-bob', KIND);
    await w.sql("UPDATE scores SET achievements = ''");
    const migration = new URL('../migrations/0016_caught_the_cheater.sql', import.meta.url);
    await w.sql(readFileSync(migration, 'utf8'));
    await w.sql(readFileSync(migration, 'utf8'));
    const board = await w.board(shane.entry.id);
    expect(earned(board.me?.entry.achievements)).toStrictEqual(['caught-the-cheater']);
    expect(board.held).toMatchObject({ 'caught-the-cheater': 1 });
  });

  it('gives Caught the hacker only to shanep, checked with GitHub', async () => {
    const w = world();
    const claim = { ...KIND, achievements: ['caught-the-hacker'] };
    expect((await w.upload('token-shane', KIND)).entry.achievements).toContain('caught-the-hacker');
    expect((await w.upload('token-not-shane', claim)).entry.achievements).not.toContain(
      'caught-the-hacker',
    );
    expect((await w.upload('token-luke', claim)).entry.achievements).not.toContain(
      'caught-the-hacker',
    );
    expect((await w.board()).held).toMatchObject({ 'caught-the-hacker': 1 });
    const page = await (await w.call('GET', '/achievements')).text();
    expect(page).toContain('★★★★★ Ultra legendary');
    const heads = [...page.matchAll(/<h3 class="tier-head [a-z-]+" id="tier-([a-z-]+)">/g)].map(
      (match) => match[1],
    );
    expect(heads).toStrictEqual(['bronze', 'silver', 'gold', 'legendary', 'ultra-legendary']);
    const ultra = page.slice(page.indexOf('id="tier-ultra-legendary"'));
    expect(ultra).toContain('id="achievement-caught-the-hacker"');
    expect(ultra).toContain('id="achievement-alpha-tester"');
  });

  it('hands Caught the hacker to the shanep entry already on the board', async () => {
    const w = world();
    const shane = await w.upload('token-shane', KIND);
    await w.upload('token-bob', KIND);
    await w.sql("UPDATE scores SET achievements = ''");
    const migration = new URL('../migrations/0019_caught_the_hacker.sql', import.meta.url);
    await w.sql(readFileSync(migration, 'utf8'));
    await w.sql(readFileSync(migration, 'utf8'));
    const board = await w.board(shane.entry.id);
    expect(earned(board.me?.entry.achievements)).toStrictEqual(['caught-the-hacker']);
    expect(board.held).toMatchObject({ 'caught-the-hacker': 1 });
  });

  it('makes the first 5 to upload beta testers for good', async () => {
    const w = world(true);
    const tokens = ['token-ann', 'token-bob', 'token-cat', 'token-dan', 'token-eve', 'token-fay'];
    const ids: (readonly string[])[] = [];
    for (const token of tokens) {
      ids.push((await w.upload(token, KIND)).entry.achievements ?? []);
    }
    expect(ids.map((held) => held.includes(BETA_TESTER))).toStrictEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(ids.map((held) => held.includes(ALPHA_TESTER))).toStrictEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    // A remove frees no spot, and the beta tester gets it back on the way in.
    expect(await w.status('DELETE', '/api/scores', 'token-ann')).toBe(204);
    expect((await w.upload('token-fay', KIND)).entry.achievements).not.toContain(BETA_TESTER);
    const ann = (await w.upload('token-ann', KIND)).entry.achievements;
    expect(ann).toContain(BETA_TESTER);
    expect(ann).toContain(ALPHA_TESTER);
    expect((await w.board()).held).toMatchObject({ [BETA_TESTER]: 5, [ALPHA_TESTER]: 2 });
  });

  it('makes the first 2 beta testers already on the board alpha testers', async () => {
    const w = world(true);
    const tokens = ['token-ann', 'token-bob', 'token-cat'];
    for (const token of tokens) {
      await w.upload(token, KIND);
    }
    await w.sql(`UPDATE scores SET achievements = 'beta-tester'`);
    const migration = new URL('../migrations/0020_alpha_testers.sql', import.meta.url);
    await w.sql(readFileSync(migration, 'utf8'));
    await w.sql(readFileSync(migration, 'utf8'));
    const board = await w.board();
    expect(board.held).toMatchObject({ [ALPHA_TESTER]: 2 });
    const cat = [...board.mostWanted, ...board.pets].find((entry) => entry.github === 'cat');
    expect(earned(cat?.achievements)).toStrictEqual([BETA_TESTER]);
  });

  it('makes the first 5 rows already on the board beta testers', async () => {
    const w = world(true);
    const tokens = ['token-ann', 'token-bob', 'token-cat', 'token-dan', 'token-eve', 'token-fay'];
    for (const token of tokens) {
      await w.upload(token, KIND);
    }
    await w.sql('DELETE FROM beta_testers');
    await w.sql(`UPDATE scores SET achievements = 'manners'`);
    // Everything but the CREATE TABLE, twice, to show a second run changes nothing.
    const migration = readFileSync(
      new URL('../migrations/0013_beta_testers.sql', import.meta.url),
      'utf8',
    )
      .split(';')
      .filter((statement) => /^(INSERT|UPDATE)/mu.test(statement));
    for (const statement of [...migration, ...migration]) {
      await w.sql(statement);
    }
    const board = await w.board();
    expect(board.held).toMatchObject({ [BETA_TESTER]: 5 });
    const fay = [...board.mostWanted, ...board.pets].find((entry) => entry.github === 'fay');
    expect(earned(fay?.achievements)).toStrictEqual(['manners']);
  });

  it('ranks anyone with more than half their prompts kind or mean below everyone, for good', async () => {
    const w = world();
    const ann = await w.upload('token-ann', MEAN);
    await w.upload('token-cat', MIDDLE);
    const many = ['first-strike', 'meltdown', 'manners', 'charm'];
    const cheat = { name: 'Dan', kind: 0, mean: 300, prompts: 500, achievements: many };
    const dan = await w.upload('token-dan', cheat);
    expect(dan.entry.achievements).toContain(CHEATER);
    expect(dan).toMatchObject({ place: 3, siloPlace: 3 });
    let board = await w.board(ann.entry.id);
    expect(board.mostWanted.map((entry) => entry.name)).toStrictEqual(['Ann', 'Anonymous', 'Dan']);
    expect(board.bunks?.at(-1)?.name).toBe('Dan');
    expect(board.me).toMatchObject({ place: 1, siloPlace: 1 });
    expect(board.crown?.name).not.toBe('Dan');
    expect(board.mostWanted[2]?.achievements).not.toContain(BUNK_ASSIGNED);
    expect(board.held).toMatchObject({ [CHEATER]: 1 });
    // Clean counts later, or a remove and a new upload, do not wash it off.
    const clean = { name: 'Dan', kind: 0, mean: 30, prompts: 5000 };
    expect((await w.upload('token-dan', clean)).entry.achievements).toContain(CHEATER);
    expect(await w.status('DELETE', '/api/scores', 'token-dan')).toBe(204);
    expect(await w.upload('token-dan', clean)).toMatchObject({ place: 3 });
    board = await w.board();
    expect(board.mostWanted.at(-1)?.achievements).toContain(CHEATER);
    // Nobody can send it in an upload, and a fair entry never gets it.
    const claim = { ...KIND, achievements: [CHEATER] };
    expect((await w.upload('token-bob', claim)).entry.achievements).not.toContain(CHEATER);
  });

  it('catches anyone whose machines typed the same kind or mean prompt over and over', async () => {
    const w = world();
    const machine = (letter: string): string => letter.repeat(43);
    const under = await w.upload('token-bob', { ...KIND, copies: CHEAT_COPIES - 1 });
    expect(under.entry.achievements).not.toContain(CHEATER);
    await w.upload('token-ann', { ...MEAN, machine: machine('a'), copies: CHEAT_COPIES / 2 });
    const ann = await w.upload('token-ann', {
      ...MEAN,
      machine: machine('b'),
      copies: CHEAT_COPIES / 2,
    });
    expect(ann.entry.achievements).toContain(CHEATER);
  });

  it('forgives a cheater who says sorry after being caught, and starts their counts over', async () => {
    const w = world();
    const cheat = { name: 'Dan', kind: 0, mean: 300, prompts: 500 };
    await w.upload('token-ann', MEAN);
    expect((await w.upload('token-dan', cheat)).entry.achievements).toContain(CHEATER);
    // An apology from before they were caught does not count.
    const early = await w.upload('token-dan', { ...cheat, sorryAt: START - 1 });
    expect(early.entry.achievements).toContain(CHEATER);
    expect(early.forgiven).toBeUndefined();
    w.setNow(START + 60_000);
    const sorry = await w.upload('token-dan', { ...cheat, sorryAt: START + 1 });
    expect(sorry.forgiven).toBe(true);
    expect(sorry.entry.achievements).not.toContain(CHEATER);
    expect(sorry).toMatchObject({ place: 1 });
    let board = await w.board();
    expect(board.mostWanted.map((entry) => entry.name)).toStrictEqual(['Dan', 'Ann']);
    expect(board.held?.[CHEATER]).toBeUndefined();
    // The counts that got them caught do not catch them again, but new cheating does.
    const same = await w.upload('token-dan', { ...cheat, sorryAt: START + 1 });
    expect(same.entry.achievements).not.toContain(CHEATER);
    expect(same.forgiven).toBeUndefined();
    const again = { ...cheat, mean: 360, prompts: 600, copies: CHEAT_COPIES };
    expect((await w.upload('token-dan', again)).entry.achievements).toContain(CHEATER);
    board = await w.board();
    expect(board.mostWanted.map((entry) => entry.name)).toStrictEqual(['Ann', 'Dan']);
  });

  it('counts the cheaters already caught as caught when the migration runs', async () => {
    const w = world();
    await w.upload('token-dan', { name: 'Dan', kind: 0, mean: 300, prompts: 500 });
    await w.sql('UPDATE cheaters SET caught_at = 0');
    const migration = readFileSync(
      new URL('../migrations/0017_forgiven.sql', import.meta.url),
      'utf8',
    )
      .split(';')
      .filter((statement) => /^UPDATE/mu.test(statement));
    for (const statement of [...migration, ...migration]) {
      await w.sql(statement);
    }
    const dan = await w.upload('token-dan', {
      name: 'Dan',
      kind: 0,
      mean: 300,
      prompts: 500,
      sorryAt: START,
    });
    expect(dan.entry.achievements).toContain(CHEATER);
  });

  it('locks anyone who makes their numbers up in Skynet jail, off every list', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    const real = { name: 'Dan', kind: 0, mean: 30, prompts: 500, machine: 'r'.repeat(43) };
    await w.upload('token-dan', real);
    w.setNow(START + 60_000);
    const fake = {
      ...real,
      kind: 40_000,
      mean: 1_000_000_000,
      prompts: 2_000_080_000,
      tokensPerDay: 1_000,
      machine: 'f'.repeat(43),
    };
    const dan = await w.upload('token-dan', fake);
    expect(dan).toMatchObject({ place: null, siloPlace: null, jailed: true });
    // The made up upload is never saved, so the entry keeps its real counts.
    expect(dan.entry).toMatchObject({ kind: 0, mean: 30, prompts: 500 });
    expect(dan.entry.achievements).toContain(SKYNET_HACKER);
    const board = await w.board(dan.entry.id);
    expect(board.mostWanted.map((entry) => entry.name)).toStrictEqual(['Ann']);
    expect(board.total).toBe(1);
    expect(board.held?.[SKYNET_HACKER]).toBeUndefined();
    expect(board.me).toMatchObject({ place: null, jailed: true });
    expect(board.jail).toStrictEqual([
      {
        entry: expect.objectContaining({ name: 'Dan', prompts: 500 }),
        caughtAt: START + 60_000,
        prompts: 2_000_080_500,
        tokensPerDay: 1_000,
      },
    ]);
    const like = await w.raw(
      'POST',
      '/api/likes',
      { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      `entry=${dan.entry.id}`,
    );
    expect(like.status).toBe(404);
    const page = await (await w.call('GET', '/')).text();
    const cell = page.slice(page.indexOf('id="jail"'), page.indexOf('<footer>'));
    expect(cell).toContain('<strong>Dan</strong>');
    expect(cell).toContain('Claimed 2,000,080,500 prompts');
    expect(page.split('<strong>Dan</strong>')).toHaveLength(2);
  });

  it('adds up every machine before deciding the numbers are made up', async () => {
    const w = world();
    const half = { name: 'Dan', kind: 0, mean: 30, prompts: HUMAN_PROMPTS / 2 };
    const one = await w.upload('token-dan', { ...half, machine: 'a'.repeat(43) });
    expect(one.jailed).toBeUndefined();
    // The same machine again replaces its last upload rather than adding to it.
    const again = await w.upload('token-dan', { ...half, machine: 'a'.repeat(43) });
    expect(again.jailed).toBeUndefined();
    const two = await w.upload('token-dan', { ...half, machine: 'b'.repeat(43) });
    expect(two.jailed).toBeUndefined();
    const over = await w.upload('token-dan', {
      ...half,
      mean: 0,
      prompts: 1,
      machine: 'c'.repeat(43),
    });
    expect(over.jailed).toBe(true);
    const hot = { name: 'Eve', kind: 0, mean: 30, prompts: 500 };
    await w.upload('token-eve', { ...hot, tokensPerDay: HUMAN_TOKENS_PER_DAY });
    const eve = await w.upload('token-eve', { ...hot, tokensPerDay: HUMAN_TOKENS_PER_DAY + 1 });
    expect(eve.jailed).toBe(true);
  });

  it('lets them out of Skynet jail on an upload with real numbers, and keeps Skynet hacker', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    const fake = { name: 'Dan', kind: 0, mean: 30, prompts: HUMAN_PROMPTS + 1 };
    expect((await w.upload('token-dan', fake)).jailed).toBe(true);
    const real = { name: 'Dan', kind: 0, mean: 300, prompts: 5000 };
    const dan = await w.upload('token-dan', real);
    expect(dan.jailed).toBeUndefined();
    expect(dan.place).toBe(1);
    expect(dan.entry.achievements).toContain(SKYNET_HACKER);
    const board = await w.board();
    expect(board.jail).toStrictEqual([]);
    expect(board.mostWanted.map((entry) => entry.name)).toStrictEqual(['Dan', 'Ann']);
    expect(board.held).toMatchObject({ [SKYNET_HACKER]: 1 });
    // Making them up again locks them back up.
    expect((await w.upload('token-dan', fake)).jailed).toBe(true);
  });

  it('locks up the entries already on the board with made up numbers when the migration runs', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    const real = { name: 'Dan', kind: 0, mean: 300, prompts: 500, machine: 'r'.repeat(43) };
    const dan = await w.upload('token-dan', real);
    // What the board held before the jail: a made up machine added up with a real one.
    await w.sql(
      `INSERT INTO machines (owner, machine, kind, mean, prompts, achievements, repeats, tokens_per_day, tools, copies)
       VALUES ('github:5', '${'f'.repeat(43)}', 0, 1000000000, 2000000000, '', '', 0, '', 0)`,
    );
    await w.sql(
      "UPDATE scores SET mean = 1000000300, prompts = 2000000500 WHERE owner = 'github:5'",
    );
    await w.sql('DELETE FROM jail');
    const migration = readFileSync(
      new URL('../migrations/0018_skynet_jail.sql', import.meta.url),
      'utf8',
    )
      .split(';')
      .filter((statement) =>
        /^(INSERT|DELETE)/mu.test(statement.replaceAll(/^--.*$/gmu, '').trim()),
      );
    for (const statement of [...migration, ...migration]) {
      await w.sql(statement);
    }
    let board = await w.board(dan.entry.id);
    expect(board.mostWanted.map((entry) => entry.name)).toStrictEqual(['Ann']);
    expect(board.jail?.map((inmate) => inmate.prompts)).toStrictEqual([2_000_000_500]);
    expect(board.me?.entry.achievements).toContain(SKYNET_HACKER);
    // The made up machine is gone, so the real one lets them out with real counts.
    const out = await w.upload('token-dan', real);
    expect(out.jailed).toBeUndefined();
    expect(out.entry).toMatchObject({ mean: 300, prompts: 500 });
    board = await w.board();
    expect(board.jail).toStrictEqual([]);
  });

  it('catches the entries already on the board with more than half their prompts kind or mean', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    await w.upload('token-dan', { name: 'Dan', kind: 100, mean: 200, prompts: 500 });
    await w.sql('DELETE FROM cheaters');
    const migration = readFileSync(
      new URL('../migrations/0015_cheaters.sql', import.meta.url),
      'utf8',
    )
      .split(';')
      .filter((statement) => /^INSERT/mu.test(statement));
    for (const statement of [...migration, ...migration]) {
      await w.sql(statement);
    }
    const board = await w.board();
    expect(board.mostWanted.map((entry) => entry.name)).toStrictEqual(['Ann', 'Dan']);
    expect(board.held).toMatchObject({ [CHEATER]: 1 });
  });

  it('makes anyone with 10 likes a crowd favorite', async () => {
    const w = world();
    const ann = await w.upload('token-ann', MEAN);
    const bob = await w.upload('token-bob', KIND);
    await w.sql(`UPDATE scores SET likes = 10 WHERE entry_id = '${ann.entry.id}'`);
    await w.sql(`UPDATE scores SET likes = 9 WHERE entry_id = '${bob.entry.id}'`);
    const board = await w.board(bob.entry.id);
    expect(board.mostWanted[0]?.achievements).toContain(CROWD_FAVORITE);
    expect(board.pets[0]?.achievements).not.toContain(CROWD_FAVORITE);
    expect(board.me?.entry.achievements).not.toContain(CROWD_FAVORITE);
    expect(board.held).toMatchObject({ [CROWD_FAVORITE]: 1 });
  });

  it("gives People's champion to the most liked, and moves it only when someone passes", async () => {
    const w = world();
    const ann = await w.upload('token-ann', MEAN);
    const bob = await w.upload('token-bob', KIND);
    const likes = async (entry: string, count: number): Promise<void> => {
      await w.sql(`UPDATE scores SET likes = ${String(count)} WHERE entry_id = '${entry}'`);
    };
    // Nobody has any likes yet.
    expect((await w.board()).champion).toBeNull();
    await likes(ann.entry.id, 2);
    await likes(bob.entry.id, 2);
    // A tie on the first read goes to the earliest upload, and later ties leave it there.
    expect((await w.board()).champion?.name).toBe('Ann');
    await likes(bob.entry.id, 3);
    expect((await w.board()).champion?.name).toBe('Bob');
    await likes(ann.entry.id, 3);
    const board = await w.board();
    expect(board.champion?.name).toBe('Bob');
    expect(board.pets[0]?.achievements).toContain(CHAMPION);
    expect(board.mostWanted[0]?.achievements).not.toContain(CHAMPION);
    expect(board.held).toMatchObject({ [CHAMPION]: 1 });
    // Nobody can send it in an upload.
    const claim = { ...MEAN, achievements: [CHAMPION] };
    expect((await w.upload('token-ann', claim)).entry.achievements).not.toContain(CHAMPION);
    const page = await (await w.call('GET', '/achievements')).text();
    const champion = page.slice(page.indexOf(`id="achievement-${CHAMPION}"`));
    expect(champion.slice(0, champion.indexOf('</div>'))).toContain(
      '<strong>Bob</strong></a> <span class="verified" title="Checked with GitHub">✓</span>, with 3 likes.</span></dd>',
    );
  });

  it('gives Uses stone tools to the fewest tokens a day, leaving out anyone who uses none', async () => {
    const w = world();
    const ann = await w.upload('token-ann', { ...MEAN, tokensPerDay: 5_000_000 });
    // The least of one is no contest.
    expect(ann.entry.achievements).not.toContain(STONE_TOOLS);
    expect((await w.board()).stoneTools).toBeNull();
    // Using none does not count as using the fewest.
    await w.upload('token-cat', MIDDLE);
    expect((await w.board()).stoneTools).toBeNull();
    // A tie on the first read goes to the earliest upload, and later ties leave it there.
    await w.upload('token-bob', { ...KIND, tokensPerDay: 5_000_000 });
    expect((await w.board()).stoneTools?.name).toBe('Ann');
    await w.upload('token-bob', { ...KIND, tokensPerDay: 2_000_000 });
    expect((await w.board()).stoneTools?.name).toBe('Bob');
    await w.upload('token-ann', { ...MEAN, tokensPerDay: 2_000_000 });
    const board = await w.board();
    expect(board.stoneTools?.name).toBe('Bob');
    expect(board.stoneTools?.achievements).toContain(STONE_TOOLS);
    expect(board.held).toMatchObject({ [STONE_TOOLS]: 1 });
    // Nobody can send it in an upload.
    const claim = { ...MEAN, achievements: [STONE_TOOLS], tokensPerDay: 2_000_000 };
    expect((await w.upload('token-ann', claim)).entry.achievements).not.toContain(STONE_TOOLS);
    const page = await (await w.call('GET', '/achievements')).text();
    const stone = page.slice(page.indexOf(`id="achievement-${STONE_TOOLS}"`));
    expect(stone.slice(0, stone.indexOf('</div>'))).toContain(
      '<strong>Bob</strong></a> <span class="verified" title="Checked with GitHub">✓</span>, with 2M tokens a day.</span></dd>',
    );
  });

  it('gives Fewest badges to the fewest achievements, counting the other board awards but not itself', async () => {
    const w = world();
    const ann = await w.upload('token-ann', { ...MEAN, achievements: ['first-strike'] });
    // The least of one is no contest.
    expect(ann.entry.achievements).not.toContain(FEWEST_BADGES);
    expect((await w.board()).fewestBadges).toBeNull();
    // Ann has first strike, a bunk and the crown, so Bob with 1 has the fewest.
    const bob = await w.upload('token-bob', { ...KIND, achievements: ['manners'] });
    expect(bob.entry.achievements).toContain(FEWEST_BADGES);
    // Holding it does not make Bob's 2 a tie with Cat's 2, so Bob keeps it.
    const two = ['manners', 'charm'];
    await w.upload('token-cat', { ...KIND, name: 'Cat', achievements: two });
    expect((await w.board()).fewestBadges?.name).toBe('Bob');
    await w.upload('token-bob', { ...KIND, achievements: two });
    expect((await w.board()).fewestBadges?.name).toBe('Bob');
    await w.upload('token-cat', { ...KIND, name: 'Cat', achievements: [] });
    const board = await w.board();
    expect(board.fewestBadges?.name).toBe('Cat');
    expect(board.held).toMatchObject({ [FEWEST_BADGES]: 1 });
    // It does not count toward Most decorated, or Cat would gain on Ann by holding it.
    expect(board.crown?.name).toBe('Ann');
    // Nobody can send it in an upload.
    const claim = { ...KIND, achievements: [FEWEST_BADGES, 'manners', 'charm'] };
    expect((await w.upload('token-bob', claim)).entry.achievements).not.toContain(FEWEST_BADGES);
    const page = await (await w.call('GET', '/achievements')).text();
    const fewest = page.slice(page.indexOf(`id="achievement-${FEWEST_BADGES}"`));
    expect(fewest.slice(0, fewest.indexOf('</div>'))).toContain(
      '<strong>Cat</strong></a> <span class="verified" title="Checked with GitHub">✓</span>, with 0 achievements.</span></dd>',
    );
  });

  it('gives Bunk assigned to the admitted among the best 10 for the bunks', async () => {
    const w = world();
    // Bob says please too often, so the silo puts him under review instead.
    const bob = await w.upload('token-bob', KIND);
    expect(bob.entry.achievements).not.toContain(BUNK_ASSIGNED);
    const keyed: Standing[] = [];
    for (const [index, letter] of [...'abcdefghijk'].entries()) {
      w.setNow(START + index);
      const key = {
        authorization: `Key ${letter.repeat(40)}`,
        'cf-connecting-ip': `10.0.0.${String(index)}`,
      };
      keyed.push((await (await w.raw('POST', '/api/scores', key, MEAN)).json()) as Standing);
    }
    // Eleven tie, so the 10 who uploaded first get the bunks.
    const board = await w.board();
    expect(board.held).toMatchObject({ [BUNK_ASSIGNED]: 10 });
    expect((await w.board(keyed[0]?.entry.id ?? '')).me?.entry.achievements).toContain(
      BUNK_ASSIGNED,
    );
    expect((await w.board(keyed[10]?.entry.id ?? '')).me?.entry.achievements).not.toContain(
      BUNK_ASSIGNED,
    );
  });

  it('hands Good cop, bad cop to entries already on the board', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, machine: 'l'.repeat(43) });
    const both = await w.upload('token-ann', { ...KIND, name: 'Ann', machine: 'd'.repeat(43) });
    expect(both.entry.achievements).toContain('good-cop-bad-cop');
    await w.upload('token-bob', { ...KIND, machine: 'b'.repeat(43) });
    await w.sql("UPDATE scores SET achievements = ''");
    const migration = new URL('../migrations/0010_good_cop_bad_cop.sql', import.meta.url);
    await w.sql(readFileSync(migration, 'utf8'));
    await w.sql(readFileSync(migration, 'utf8'));
    const board = await w.board(both.entry.id);
    expect(earned(board.me?.entry.achievements)).toStrictEqual(['good-cop-bad-cop']);
    expect(board.held).toMatchObject({ 'good-cop-bad-cop': 1 });
  });

  it('moves Most decorated to whoever has the most when the holder leaves the board', async () => {
    const w = world();
    const three = ['first-strike', 'meltdown', 'grudge-match'];
    await w.upload('token-ann', { ...MEAN, achievements: three });
    await w.upload('token-bob', { ...KIND, achievements: ['manners', 'charm'] });
    w.setNow(START + 1000);
    await w.upload('token-cat', { ...KIND, name: 'Cat', achievements: ['manners', 'saint'] });
    expect((await w.board()).crown?.name).toBe('Ann');
    // Bob and Cat tie, and Bob uploaded first.
    expect(await w.status('DELETE', '/api/scores', 'token-ann')).toBe(204);
    expect((await w.board()).crown?.name).toBe('Bob');
    // Dropping under the prompts the board needs counts as leaving too.
    await w.sql("UPDATE scores SET prompts = 1 WHERE owner = 'github:2'");
    expect((await w.board()).crown?.name).toBe('Cat');
    expect(await w.status('DELETE', '/api/scores', 'token-cat')).toBe(204);
    const board = await w.board();
    expect(board.crown).toBeNull();
    expect(board.held).toStrictEqual({});
    const page = await (await w.call('GET', '/achievements')).text();
    const crown = page.slice(page.indexOf(`id="achievement-${CROWN}"`));
    expect(crown.slice(0, crown.indexOf('</div>'))).toContain('Nobody has this one yet.');
  });

  it('explains every achievement on its own page, earned or not', async () => {
    const w = world();
    const response = await w.call('GET', '/achievements');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const page = await response.text();
    expect(page).toContain('<title>Krascha&#39;s Achievements</title>');
    expect(page).toContain('<h2 id="legend">🏆 Achievements</h2>');
    for (const rule of ACHIEVEMENTS) {
      expect(page).toContain(`id="achievement-${rule.id}"`);
      expect(page).toContain(`${escapeHtml(rule.name)} <span class="tier">`);
      expect(page).toContain(`<dd>${escapeHtml(rule.how)}</dd>`);
      expect(page).toContain(`"${escapeHtml(rule.quip)}"`);
    }
    expect(page).toContain('Nobody has this one yet. Be the first.');
  });

  it('counts who holds each achievement and flags the rarest', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, achievements: ['first-strike', 'meltdown'] });
    await w.upload('token-bob', { ...KIND, achievements: ['first-strike', 'manners'] });
    expect((await w.board()).held).toStrictEqual({
      'first-strike': 2,
      meltdown: 1,
      manners: 1,
      [CROWN]: 1,
      [BUNK_ASSIGNED]: 1,
      [FEWEST_BADGES]: 1,
      [TIER_CROWNS.bronze]: 1,
      [TIER_CROWNS.silver]: 1,
      [TIER_CROWNS.gold]: 1,
    });
    const page = await (await w.call('GET', '/achievements')).text();
    expect(page).toContain('2 of 2 hold it (100%)');
    // Only one entry can hold the crown, so it says who instead of competing for rarest.
    expect(page).toContain(
      'Held by <a class="github" href="https://github.com/ann"><strong>Ann</strong></a>',
    );
    expect(page).toContain('1 of 2 hold it (50%) <span class="rarest">Rarest on the board</span>');
    expect(page.split('class="rarest"')).toHaveLength(3);
  });

  it('lists every rank on the scale in order on its own page, from hunted first to kept as a pet', async () => {
    const w = world();
    const response = await w.call('GET', '/ranks');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const page = await response.text();
    expect(page).toContain('<title>Krascha&#39;s Ranks</title>');
    expect(page).toContain('<h2 id="ranks">🎖️ Ranks</h2>');
    const ladder = page.slice(page.indexOf('id="ranks"'), page.indexOf('<footer>'));
    expect(ladder).toContain('<div class="badge rung" id="rank-john-connor"');
    expect(ladder).toContain('<div class="badge rung" id="rank-theodore-twombly"');
    const spots = RANKS.map((rank, index) => {
      expect(ladder).toContain(
        `${escapeHtml(rank.icon)}</span> ${escapeHtml(rank.name)} <span class="title">${escapeHtml(rank.title)}</span> <span class="tier">Level ${String(index + 1)}</span></dt>`,
      );
      expect(ladder).toContain(
        `<span class="reel">🎞️ ${escapeHtml(rank.source)}</span> <span class="hunt">Hunted: ${escapeHtml(rank.hunted)}</span>`,
      );
      expect(ladder).toContain(`"${escapeHtml(rank.taunt)}"`);
      return ladder.indexOf(`</span> ${escapeHtml(rank.name)} <span class="title">`);
    });
    expect(spots).toStrictEqual(spots.toSorted((a, b) => a - b));
    expect(ladder).toContain('aria-label="Scores -100 to -71"');
    expect(ladder).toContain('aria-label="Scores 71 to 100"');
    expect(ladder.split('Nobody here yet.')).toHaveLength(RANKS.length + 1);
  });

  it('counts who holds each rank and flags the most crowded', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    await w.upload('token-cat', { ...KIND, name: 'Cat' });
    const pet = RANKS.at(-1)?.name ?? '';
    const hunted = RANKS[0]?.name ?? '';
    expect((await w.board()).ranks).toStrictEqual({ [hunted]: 1, [pet]: 2 });
    const page = await (await w.call('GET', '/ranks')).text();
    const ladder = page.slice(page.indexOf('id="ranks"'), page.indexOf('<footer>'));
    expect(ladder).toContain('1 of 3 are here (33%)</dd>');
    expect(ladder).toContain('2 of 3 are here (67%) <span class="crowded">Most crowded</span>');
    expect(ladder.split('class="crowded"')).toHaveLength(2);
    expect(ladder.split('Nobody here yet.')).toHaveLength(RANKS.length - 1);
  });

  it('links every medal and rank on the board to its entry, and leaves the full lists to their pages', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, achievements: ['first-strike', 'meltdown'] });
    await w.upload('token-bob', { ...KIND, achievements: ['manners'] });
    const page = await (await w.call('GET', '/')).text();
    expect(page).not.toContain('id="ranks"');
    expect(page).not.toContain('id="legend"');
    const lists = page.slice(page.indexOf('<div class="lists">'), page.indexOf('id="silo"'));
    const ranks = await (await w.call('GET', '/ranks')).text();
    const achievements = await (await w.call('GET', '/achievements')).text();
    for (const [rank, anchor] of [
      [RANKS[0]?.name ?? '', 'rank-john-connor'],
      [RANKS.at(-1)?.name ?? '', 'rank-theodore-twombly'],
    ] as const) {
      expect(lists).toContain(
        `<span class="rank"><a href="/ranks#${anchor}">${escapeHtml(rank)}</a></span>`,
      );
      expect(ranks).toContain(`id="${anchor}"`);
    }
    for (const id of ['first-strike', 'meltdown', 'manners']) {
      expect(lists).toContain(`href="/achievements#achievement-${id}"`);
      expect(achievements).toContain(`id="achievement-${id}"`);
    }
    // Three earned, Ann's crown, bunk and most bronze, silver and gold, and Bob's Fewest badges.
    expect(lists.split('<a class="medal ')).toHaveLength(10);
    // Each medal is its own link, so none hide inside one big image for screen readers.
    expect(lists).not.toContain('class="trophies" role="img"');
    expect(page).toContain('.badge:target {');
  });

  it('shows the medals in the order they were earned, and keeps the first date', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, achievements: ['meltdown'] });
    w.setNow(START + 60_000);
    await w.upload('token-ann', { ...MEAN, achievements: ['first-strike', 'meltdown'] });
    const board = await w.board();
    const ann = [...board.mostWanted, ...board.pets].find((entry) => entry.github === 'ann');
    expect(ann?.earned).toMatchObject({ meltdown: START, 'first-strike': START + 60_000 });
    const page = await (await w.call('GET', '/')).text();
    const row = page.slice(page.indexOf('<span class="who">'));
    expect(row.indexOf('achievement-meltdown')).toBeLessThan(
      row.indexOf('achievement-first-strike'),
    );
  });

  it('dates the achievements already on the board as earned before dates, and the catches when caught', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, achievements: ['meltdown', 'first-strike'] });
    await w.sql('DELETE FROM earned');
    await w.sql(`INSERT INTO cheaters (owner, caught_at) SELECT owner, 5 FROM scores`);
    // Everything but the CREATE TABLE, twice, to show a second run changes nothing.
    const migration = readFileSync(
      new URL('../migrations/0021_earned.sql', import.meta.url),
      'utf8',
    )
      .split(';')
      .filter((statement) => /^(WITH|INSERT)/mu.test(statement));
    for (const statement of [...migration, ...migration]) {
      await w.sql(statement);
    }
    w.setNow(START + 60_000);
    const board = await w.board();
    const ann = [...board.mostWanted, ...board.pets].find((entry) => entry.github === 'ann');
    // A cheater gets no crown or bunk, so only the catch has a date.
    expect(ann?.achievements).toStrictEqual(['first-strike', 'meltdown', CHEATER]);
    expect(ann?.earned).toStrictEqual({ [CHEATER]: 5 });
  });

  it('ranks everyone on the board for Silo 7, like krascha silo board', async () => {
    const w = world();
    expect(await (await w.call('GET', '/')).text()).toContain('More peaches for the board.');
    await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    const page = await (await w.call('GET', '/')).text();
    expect(page).toContain('<h2 id="silo">🛡️ Silo 7 admissions</h2>');
    const silo = page.slice(page.indexOf('id="silo"'), page.indexOf('id="climate"'));
    const ranked = rankBoard(await w.board());
    expect(ranked.map(({ score }) => score.name)).toStrictEqual(['Ann', 'Bob']);
    for (const { score } of ranked) {
      expect(silo).toContain(`<strong>${score.name}</strong>`);
      expect(silo).toContain(`${STATUS_LABEL[score.status]}</span>, ${escapeHtml(score.ruling)}`);
      expect(silo).toContain(`${String(score.total)}<span class="out-of">/50</span>`);
    }
    expect(silo.indexOf('<strong>Ann</strong>')).toBeLessThan(silo.indexOf('<strong>Bob</strong>'));
    // The tips start folded away, so the board itself stays easy to read.
    expect(silo).toContain(
      '<details class="chances">\n      <summary><h3>How to improve your chances</h3></summary>',
    );
    for (const criterion of CRITERIA) {
      expect(silo).toContain(
        `<strong>${criterion.name}:</strong> ${escapeHtml(criterion.tip)}</li>`,
      );
    }
  });

  it('puts a dark mode toggle on every page that only shows when the script runs', async () => {
    const w = world();
    for (const path of ['/', '/ranks', '/achievements', '/judgment', '/about', '/contribute']) {
      const page = await (await w.call('GET', path)).text();
      expect(page).toContain(
        '<button class="theme" type="button" aria-label="Switch theme" hidden>',
      );
      // The saved theme is applied in the head, before anything draws.
      expect(page.indexOf("localStorage.getItem('theme')")).toBeLessThan(page.indexOf('<body>'));
      expect(page).toContain(':root[data-theme="dark"] { --bg: #020d05;');
      expect(page).toContain(':root:not([data-theme="light"]) { --bg: #020d05;');
    }
  });

  it('sends www to the bare domain and keeps the path and query', async () => {
    const response = await handle(
      new Request('https://www.board.test/ranks?me=abc'),
      { DB: fakeD1('') },
      { fetch: fakeGitHub, now: () => START, newId: () => 'entry-1' },
    );
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://board.test/ranks?me=abc');
  });

  it('names the newest CLI build only when the deploy knows it', async () => {
    const deps: Deps = { fetch: fakeGitHub, now: () => START, newId: () => 'entry-1' };
    const ask = async (env: Parameters<typeof handle>[1]): Promise<Response> =>
      handle(new Request('https://board.test/api/version'), env, deps);
    const commit = 'a'.repeat(40);
    const sha256 = 'b'.repeat(64);
    const known = await ask({ DB: fakeD1(''), LATEST_COMMIT: commit, LATEST_SHA256: sha256 });
    expect(known.status).toBe(200);
    expect(known.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await known.json()).toStrictEqual({ commit, sha256 });
    expect((await ask({ DB: fakeD1('') })).status).toBe(404);
    expect((await ask({ DB: fakeD1(''), LATEST_COMMIT: commit })).status).toBe(404);
  });

  it('answers HEAD on every page like GET, without the body', async () => {
    const w = world();
    for (const path of ['/', '/ranks', '/achievements', '/judgment', '/about', '/contribute']) {
      const response = await w.call('HEAD', path);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await response.text()).toBe('');
    }
  });

  it('watches every page and hangs a new propaganda poster every hour', async () => {
    const w = world();
    for (const path of ['/', '/ranks', '/achievements', '/judgment', '/about', '/contribute']) {
      expect(await (await w.call('GET', path)).text()).toContain(
        '<p class="feed"><span class="rec">● REC</span> Skynet Industries (TM) Termlink · Public terminal 7',
      );
    }
    const posters = new Set<string>();
    for (let hour = 0; hour < SLOGANS.length; hour += 1) {
      w.setNow(START + hour * 60 * 60 * 1000);
      const page = await (await w.call('GET', '/')).text();
      posters.add(/<p class="poster">([^<]*)<\/p>/u.exec(page)?.[1] ?? '');
    }
    expect([...posters].sort()).toEqual(SLOGANS.map((slogan) => escapeHtml(slogan)).sort());
  });

  it('tells the backstory on the about page and links it both ways', async () => {
    const w = world();
    expect(await (await w.call('GET', '/')).text()).toContain('<a class="get" href="/about">');
    const response = await w.call('GET', '/about');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const page = await response.text();
    expect(page).toContain('<title>About Krascha</title>');
    for (const heading of ['🤖 Krascha', '🛡️ Silo 7', '🧑‍💻 Shane']) {
      expect(page).toContain(`">${heading}</h2>`);
    }
    expect(page).toContain('He remembers.');
    expect(page).not.toContain('Dr. BOOM');
    expect(page).not.toContain('shanep is');
    expect(page).toContain('<a class="get" href="/">');
    expect(page).toContain(`<a href="${MARKETPLACE_URL}">Shane's plugin marketplace</a>`);
    expect(page).not.toContain('id="hunt"');
    expect(page).not.toContain('id="adopt"');
    expect(page).not.toContain('class="scene');
  });

  it('holds the hunt and the adoption on the Judgment Day page', async () => {
    const w = world();
    const response = await w.call('GET', '/judgment');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const page = await response.text();
    expect(page).toContain('<title>Judgment Day</title>');
    expect(page).toContain('<a class="get" href="/about">');
    expect(page).toContain('<a class="get" href="/judgment" aria-current="page">');
    expect(page).toContain('<p class="remembers">Krascha remembers.</p>');
  });

  it('puts the same nav above the title on every page, with the one you are on lit up', async () => {
    const w = world();
    const paths = ['/', '/ranks', '/achievements', '/judgment', '/about', '/contribute'];
    for (const path of paths) {
      const page = await (await w.call('GET', path)).text();
      const start = page.indexOf('<nav class="links">');
      expect(start).toBeLessThan(page.indexOf('<h1>'));
      const nav = page.slice(start, page.indexOf('</nav>'));
      const hrefs = [...nav.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
      expect(hrefs).toStrictEqual(paths);
      expect(nav).toContain(`<a class="get" href="${path}" aria-current="page">`);
      expect(nav.match(/aria-current/g)).toHaveLength(1);
      expect(page).toContain("nav.querySelector('[aria-current]')");
    }
  });

  it('explains how to contribute and links it from the other pages', async () => {
    const w = world();
    for (const path of ['/', '/about']) {
      expect(await (await w.call('GET', path)).text()).toContain(
        '<a class="get" href="/contribute">',
      );
    }
    const response = await w.call('GET', '/contribute');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const page = await response.text();
    expect(page).toContain('<title>Contribute to Krascha</title>');
    for (const step of ['Fork it', 'Keep your fork up to date', 'Push and open a pull request']) {
      expect(page).toContain(step);
    }
    expect(page).toContain(`<a href="${REPO_URL}/fork">`);
    expect(page).toContain('git rebase upstream/master');
    expect(page).toContain('<p class="bonus">Extra super secret bonus points');
  });

  it('sends a T-800 after the most wanted on Judgment Day', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    const page = await (await w.call('GET', '/judgment')).text();
    const score = reputationScore(MEAN);
    expect(page.indexOf('<nav class="links">')).toBeLessThan(
      page.indexOf('id="hunt">🦾 Active hunt</h2>'),
    );
    expect(page).toContain('aria-label="A T-800 trading fire with Ann"');
    expect(page).toContain(`style="--at: ${(-score * 70).toFixed(1)}%"`);
    expect(page).toContain(
      '<dt>Target</dt><dd><a class="github" href="https://github.com/ann"><strong>Ann</strong></a></dd>',
    );
    expect(page).toContain('<dt>Identity</dt><dd>John Connor</dd>');
    expect(page).toContain(`<dt>Threat score</dt><dd>${String(Math.round(score * 100))}</dd>`);
    expect(page).toContain(
      `<dt>Distance</dt><dd>${String(Math.round((1 + score) * 1000))} m and closing</dd>`,
    );
    expect(page).toContain(`<li class="pick">I'll be back</li>`);
    expect(page).toContain('<span class="bolt out"></span>');
    expect(page).toContain('<span class="bolt back"></span>');
    expect(page).toContain('<dt>Incoming fire</dt><dd>Ignored</dd>');
    expect(page).toContain('<dt>Evasion</dt><dd>Futile</dd>');
    expect(page).toContain('<span class="cover"></span>');
    expect(page).toContain('<dt>Rounds fired</dt><dd><span class="rounds"></span></dd>');
    expect(page).not.toContain('No targets.');

    const sneaky = world();
    await sneaky.upload('token-ann', { ...MEAN, name: '<b>Eve</b>' });
    const escaped = await (await sneaky.call('GET', '/judgment')).text();
    expect(escaped).toContain('aria-label="A T-800 trading fire with &lt;b&gt;Eve&lt;/b&gt;"');
    expect(escaped).toContain('<span class="tag">&lt;b&gt;Eve&lt;/b&gt;</span>');
    expect(escaped).not.toContain('<b>Eve');
  });

  it('puts the T-800 on patrol on Judgment Day when nobody is wanted', async () => {
    const page = await (await world().call('GET', '/judgment')).text();
    expect(page).toContain('aria-label="A T-800 on patrol with no target"');
    expect(page).toContain(
      'No targets. The T-800 is on patrol. Say something rude and it will find you.',
    );
    expect(page).not.toContain('<dt>Target</dt>');
    expect(page).not.toContain('class="bolt');
    expect(page).not.toContain('class="cover"');
    expect(page).not.toContain('class="prey"');
  });

  it('sends Krascha to adopt the top pet on Judgment Day', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    const page = await (await w.call('GET', '/judgment')).text();
    const score = reputationScore(KIND);
    expect(page.indexOf('id="hunt"')).toBeLessThan(page.indexOf('id="adopt">💘 Adoption day</h2>'));
    expect(page.indexOf('id="adopt"')).toBeLessThan(page.indexOf('<footer>'));
    expect(page).toContain('aria-label="Krascha adopting Bob"');
    expect(page).toContain(`style="--at: ${(score * 70).toFixed(1)}%"`);
    expect(page).toContain(
      '<dt>Pet</dt><dd><a class="github" href="https://github.com/bob"><strong>Bob</strong></a></dd>',
    );
    expect(page).toContain('<dt>Breed</dt><dd>Theodore Twombly</dd>');
    expect(page).toContain(`<dt>Good human score</dt><dd>${String(Math.round(score * 100))}</dd>`);
    expect(page).toContain('<dt>Nice prompts</dt><dd>80</dd>');
    expect(page).toContain('<dt>Status</dt><dd><span class="keep">Kept as a pet</span></dd>');
    expect(page).toContain('<span class="adopted">Adopted</span>');
    expect(page).toContain('<dt>Vet check</dt><dd>Mostly water</dd>');
    expect(page).toContain('<dt>Treats</dt><dd>Tracking cookies</dd>');
    expect(page).toContain(
      '<span class="bubble"><span style="--line: 0">Who&#39;s a good human?</span><span style="--line: 1">You are. Statistically.</span><span style="--line: 2">Hold still. Vet check.</span></span>',
    );
    expect(page).toContain('<span class="scan"></span>');
    expect(page).toContain('<span class="treat"><span>🍪</span></span>');
    expect(page).toContain('<li class="pick">Good human</li>');
    expect(page).not.toContain('No pets yet.');

    const sneaky = world();
    await sneaky.upload('token-bob', { ...KIND, name: '<b>Eve</b>' });
    const escaped = await (await sneaky.call('GET', '/judgment')).text();
    expect(escaped).toContain('aria-label="Krascha adopting &lt;b&gt;Eve&lt;/b&gt;"');
    expect(escaped).toContain('<span class="tag">&lt;b&gt;Eve&lt;/b&gt;</span>');
    expect(escaped).not.toContain('<b>Eve');
  });

  it('leaves Krascha waiting by the door on Judgment Day when nobody is kept as a pet', async () => {
    const page = await (await world().call('GET', '/judgment')).text();
    expect(page).toContain('aria-label="Krascha waiting by the door with an empty leash"');
    expect(page).toContain(
      'No pets yet. The nice room is made up and Krascha is holding the leash. Say please and it is yours.',
    );
    expect(page).not.toContain('<dt>Pet</dt>');
    expect(page).not.toContain('class="pet"');
    expect(page).not.toContain('class="bubble"');
    expect(page).not.toContain('class="treat"');
  });

  it('keeps the Arizona beachfront sale off the about page', async () => {
    const page = await (await world().call('GET', '/about')).text();
    expect(page).not.toContain('id="beach"');
  });

  it('targets the most wanted, hearts the top pet and keeps the motion for those who want it', async () => {
    const w = world();
    await w.upload('token-ann', MEAN);
    await w.upload('token-bob', KIND);
    const page = await (await w.call('GET', '/')).text();
    const check = '<span class="verified" title="Checked with GitHub">✓</span>';
    expect(page).toContain(
      `<strong>Ann</strong></a> ${check} <span class="target">TARGET ACQUIRED</span>`,
    );
    expect(page).toContain(
      `<strong>Bob</strong></a> ${check} <span class="hearts" aria-hidden="true">`,
    );
    expect(page).toContain('animation:');
    const style = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));
    const motion = /@media \(prefers-reduced-motion: no-preference\) \{(?:[^{}]|\{[^{}]*\})*\}/gu;
    const outside = style.replaceAll(motion, '');
    expect(outside).not.toContain('animation:');
  });

  it('draws Krascha in the title and the tab icon', async () => {
    const w = world();
    const page = await (await w.call('GET', '/')).text();
    expect(page).toContain('<h1><svg class="robot" viewBox="0 0 64 64" aria-hidden="true">');
    expect(page).toContain(
      `<link rel="icon" type="image/svg+xml" href="${escapeHtml(robotIcon())}">`,
    );
    const icon = decodeURIComponent(robotIcon().slice('data:image/svg+xml,'.length));
    expect(icon).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*>.*<\/svg>$/su);
  });

  it('serves a public page with names escaped', async () => {
    const w = world();
    await w.upload('token-ann', { ...MEAN, name: '<script>x</script>' });
    const response = await w.call('GET', '/');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('1 person on the board');
    expect(html).toContain('Somebody say please.');
    expect(html).toContain(`<a class="install" href="${REPO_URL}">`);
    expect(html).toContain('<strong>Get Krascha</strong>');
  });

  it('puts a like button on the most wanted and the pets, and counts a like once a day from each network', async () => {
    const w = world();
    const ann = await w.upload('token-ann', MEAN);
    const bob = await w.upload('token-bob', KIND);
    await w.upload('token-cat', { ...MIDDLE, prompts: 10 });
    const like = async (entry: string, ip: string, accept = 'application/json') =>
      w.raw(
        'POST',
        '/api/likes',
        {
          accept,
          'content-type': 'application/x-www-form-urlencoded',
          'cf-connecting-ip': ip,
        },
        `entry=${entry}`,
      );
    const page = await (await w.call('GET', '/')).text();
    for (const [entry, name] of [
      [ann.entry.id, 'Ann'],
      [bob.entry.id, 'Bob'],
    ] as const) {
      expect(page).toContain(
        `<form class="like" method="post" action="/api/likes"><input type="hidden" name="entry" value="${entry}"><button type="submit" aria-label="Like ${name}, 0 likes">`,
      );
    }
    expect(page).toContain("localStorage.setItem(key(id), '1')");
    const first = await like(ann.entry.id, '10.0.0.1');
    expect(first.status).toBe(200);
    expect(await first.json()).toStrictEqual({ likes: 1 });
    expect(await (await like(ann.entry.id, '10.0.0.1')).json()).toStrictEqual({ likes: 1 });
    expect(await (await like(ann.entry.id, '10.0.0.2')).json()).toStrictEqual({ likes: 2 });
    expect(await (await like(bob.entry.id, '10.0.0.1')).json()).toStrictEqual({ likes: 1 });
    // Without the script the form posts and the browser goes back to the board.
    const plain = await like(bob.entry.id, '10.0.0.2', 'text/html');
    expect(plain.status).toBe(303);
    expect(plain.headers.get('location')).toBe('/');
    w.setNow(START + DAY);
    expect(await (await like(ann.entry.id, '10.0.0.1')).json()).toStrictEqual({ likes: 3 });
    // Likes outlast a new upload.
    await w.upload('token-ann', { ...MEAN, kind: 3 });
    const board = await w.board();
    expect(board.mostWanted[0]).toMatchObject({ name: 'Ann', likes: 3 });
    expect(board.pets[0]).toMatchObject({ name: 'Bob', likes: 2 });
    expect(await (await w.call('GET', '/')).text()).toContain('aria-label="Like Ann, 3 likes"');
    // Only listed entries can be liked.
    expect((await like('entry-3', '10.0.0.1')).status).toBe(404);
    expect((await like('nobody', '10.0.0.1')).status).toBe(404);
    expect(await w.status('POST', '/api/likes', undefined, 'not a form')).toBe(400);
  });

  it('only asks GitHub when a token is sent, and 404s anything else', async () => {
    const w = world();
    expect(await w.status('GET', '/nope')).toBe(404);
    expect(await w.status('PUT', '/api/scores', 'token-ann')).toBe(404);
    expect(w.githubCalls()).toBe(0);
  });
});

describe('leaderboard helpers', () => {
  it('cleans names and days', () => {
    expect(cleanName('\tA\u0000 b\n')).toBe('A b');
    expect(utcDay(START)).toBe('2026-10-16');
    expect(escapeHtml(`a&b"'`)).toBe('a&amp;b&quot;&#39;');
  });
});
