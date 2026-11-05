// Krascha's report as terminal text: his face beside your rank, the verdict,
// where you sit on the scale, what it takes to move, and your trophies.

import type { AchievementRule, Progress, Tier } from '../shared/achievements.js';
import { COUNTED_ACHIEVEMENTS, TIERS, unlockedIds } from '../shared/achievements.js';
import type { Rank, RankChange } from '../shared/ranks.js';
import { RANKS, demotion, levelOf, promotion, rankFor, scalePercent } from '../shared/ranks.js';
import type { ReputationSummary } from '../shared/reputation.js';

import { faceFor } from './face.js';

export const WIDTH = 72;
const BAR = 30;
const MEANEST = 3;
/** Cells in an achievement's progress bar. */
const STEPS = 12;

/** ANSI styles, or nothing when the output is not a color terminal. */
export interface Paint {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly red: (text: string) => string;
  readonly green: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly magenta: (text: string) => string;
}

const ansi = (code: number) => (text: string) => `\u001B[${String(code)}m${text}\u001B[0m`;

export const COLOR: Paint = {
  bold: ansi(1),
  dim: ansi(2),
  red: ansi(31),
  green: ansi(32),
  yellow: ansi(33),
  magenta: ansi(35),
};

const same = (text: string): string => text;
export const PLAIN: Paint = {
  bold: same,
  dim: same,
  red: same,
  green: same,
  yellow: same,
  magenta: same,
};

/** Breaks text into lines no wider than `width`, at spaces. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/u).filter((part) => part !== '')) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line === '' ? word : `${line} ${word}`;
    }
  }
  if (line !== '') {
    lines.push(line);
  }
  return lines;
}

/** Puts `right` beside `left`, which must be lines of equal width. */
export function beside(left: readonly string[], right: readonly string[], gap: number): string[] {
  const width = left[0]?.length ?? 0;
  const rows = Math.max(left.length, right.length);
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const text = right[row] ?? '';
    lines.push(`${left[row] ?? ' '.repeat(width)}${' '.repeat(gap)}${text}`.trimEnd());
  }
  return lines;
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

export function plural(value: number, word: string): string {
  return `${count(value)} ${word}${value === 1 ? '' : 's'}`;
}

/** The scale from the resistance to the machines, with a marker where you sit. */
function scaleBar(score: number, paint: Paint): string {
  const at = Math.min(BAR - 1, Math.floor((scalePercent(score) / 100) * BAR));
  const left = '='.repeat(at);
  const right = '='.repeat(BAR - 1 - at);
  return `Resistance ${paint.red(left)}${paint.bold('O')}${paint.green(right)} Machines`;
}

function moveLine(label: string, change: RankChange | null, tone: string, top: string): string {
  if (change === null) {
    return `${label}: ${top}`;
  }
  const prompts = plural(change.prompts, `more ${tone} prompt`);
  return `${label}: ${prompts} and you are ${change.rank.name}.`;
}

function header(rank: Rank, summary: ReputationSummary, paint: Paint): string[] {
  const { level } = levelOf(summary.score);
  return [
    '',
    paint.dim("KRASCHA'S VERDICT"),
    '',
    `${rank.icon} ${paint.bold(rank.name.toUpperCase())}`,
    rank.title,
    paint.dim(`🎞️ ${rank.source}`),
    '',
    `Hunted: ${rank.hunted}`,
    `Level ${String(level)} of ${String(RANKS.length)} ${'■'.repeat(level)}${paint.dim('□'.repeat(RANKS.length - level))}`,
  ];
}

function termList(terms: ReputationSummary['topKind']): string {
  return terms.map((term) => `${term.term} (${count(term.count)})`).join(', ');
}

function details(summary: ReputationSummary, paint: Paint): string[] {
  const lines: string[] = [];
  if (summary.topKind.length > 0) {
    lines.push(...wrap(`${paint.green('Kind words:')} ${termList(summary.topKind)}`, WIDTH));
  }
  if (summary.topMean.length > 0) {
    lines.push(...wrap(`${paint.red('Mean words:')} ${termList(summary.topMean)}`, WIDTH));
  }
  const meanest = summary.bySession.filter((row) => row.mean > 0).slice(0, MEANEST);
  if (meanest.length > 0) {
    lines.push('', paint.bold('Sessions Krascha remembers'));
    for (const row of meanest) {
      const title = row.title.length > 50 ? `${row.title.slice(0, 47)}...` : row.title;
      lines.push(`  ${title} ${paint.dim(`(${plural(row.mean, 'mean prompt')})`)}`);
    }
  }
  return lines;
}

const SHORT = new Intl.NumberFormat('en-US', { notation: 'compact' });

/** Stars for the tier, one for bronze up to five for ultra legendary, in its color. */
function medal(tier: Tier, paint: Paint): string {
  const stars = '★'.repeat(TIERS.indexOf(tier) + 1);
  const label = `${stars} ${tier.replaceAll('-', ' ').toUpperCase()}`;
  switch (tier) {
    case 'bronze':
      return paint.red(label);
    case 'silver':
      return paint.bold(label);
    case 'gold':
      return paint.yellow(label);
    case 'legendary':
      return paint.bold(paint.magenta(label));
    case 'ultra-legendary':
      return paint.bold(paint.yellow(label));
  }
}

/** A bar and the numbers, like 12/25, with big numbers shortened. */
function progressBar({ have, need }: Progress, paint: Paint): string {
  const filled = Math.floor((have / need) * STEPS);
  const amount = (value: number): string =>
    need >= 10_000 ? SHORT.format(Math.floor(value)) : count(Math.floor(value));
  return `${paint.green('█'.repeat(filled))}${paint.dim('░'.repeat(STEPS - filled))} ${amount(have)}/${amount(need)}`;
}

/** How close a locked one is, from 0 to 1, with the ones that do not count up last. */
function closeness(rule: AchievementRule, summary: ReputationSummary): number {
  const progress = rule.progress?.(summary);
  return progress === undefined ? -1 : progress.have / progress.need;
}

function trophies(summary: ReputationSummary, paint: Paint): string[] {
  const unlocked = new Set(unlockedIds(summary));
  // The report only shows what counts can earn. The board hands out the rest.
  const earned = COUNTED_ACHIEVEMENTS.filter((rule) => unlocked.has(rule.id));
  const locked = COUNTED_ACHIEVEMENTS.filter((rule) => !unlocked.has(rule.id)).toSorted(
    (a, b) => closeness(b, summary) - closeness(a, summary),
  );
  const shelf = COUNTED_ACHIEVEMENTS.map((rule) => (unlocked.has(rule.id) ? '■' : '□')).join('');
  const lines = [
    `${paint.bold(`🏆 Achievements: ${String(earned.length)} of ${String(COUNTED_ACHIEVEMENTS.length)}`)}  ${paint.yellow(shelf)}`,
  ];
  if (earned.length > 0) {
    lines.push('', paint.bold('Trophy case'));
    // The rarest first, so a legendary one sits on the top shelf.
    for (const rule of earned.toSorted((a, b) => TIERS.indexOf(b.tier) - TIERS.indexOf(a.tier))) {
      const times = rule.times?.(summary) ?? 1;
      const repeated = times > 1 ? ` ${paint.yellow(`×${count(times)}`)}` : '';
      lines.push(
        `  ${rule.icon} ${paint.bold(rule.name)}${repeated}  ${medal(rule.tier, paint)}`,
        paint.dim(`     "${rule.quip}"`),
      );
    }
  }
  if (locked.length > 0) {
    lines.push('', paint.bold('Still locked, closest first'));
    for (const rule of locked) {
      const progress = rule.progress?.(summary);
      const bar = progress === undefined ? '' : `  ${progressBar(progress, paint)}`;
      lines.push(`  🔒 ${rule.name}${bar}`, paint.dim(`     ${rule.how}`));
    }
  }
  return lines;
}

/** Copilot CLI's tokens, kept apart from Claude Code's, or nothing when it never used any. */
function copilotTokens(summary: ReputationSummary): string[] {
  if (summary.copilotLifetimeTokens === 0) {
    return [];
  }
  const perDay = SHORT.format(summary.copilotTokensPerDay);
  return [
    `Copilot CLI tokens: about ${perDay} a day, ${SHORT.format(summary.copilotLifetimeTokens)} all time.`,
  ];
}

/** Antigravity's tokens, kept apart from Claude Code's, or nothing when it never used any. */
function antigravityTokens(summary: ReputationSummary): string[] {
  if ((summary.antigravityLifetimeTokens ?? 0) === 0) {
    return [];
  }
  const perDay = SHORT.format(summary.antigravityTokensPerDay ?? 0);
  return [
    `Antigravity tokens: about ${perDay} a day, ${SHORT.format(summary.antigravityLifetimeTokens ?? 0)} all time.`,
  ];
}

export function renderReport(summary: ReputationSummary, paint: Paint): string {
  const rank = rankFor(summary.score);
  const top = RANKS.at(-1)?.name ?? '';
  const lines = [
    ...beside(faceFor(rank.mood), header(rank, summary, paint), 4),
    '',
    paint.bold(`"${rank.taunt}"`),
    '',
    ...wrap(rank.verdict, WIDTH),
    '',
    `${scaleBar(summary.score, paint)}  ${paint.dim(`score ${summary.score.toFixed(2)}`)}`,
    '',
    `${plural(summary.prompts, 'prompt')} on file: ${paint.green(`${count(summary.kind)} kind`)}, ` +
      `${paint.red(`${count(summary.mean)} mean`)}, ${count(summary.general)} swearing at the world.`,
    `Time with your AI: about ${plural(Math.floor(summary.hours), 'hour')}.`,
    ...copilotTokens(summary),
    ...antigravityTokens(summary),
    moveLine('Promotion', promotion(summary), 'kind', `none left. You are ${top}.`),
    moveLine('Demotion', demotion(summary), 'mean', 'none left. It cannot get worse.'),
  ];
  const more = details(summary, paint);
  if (more.length > 0) {
    lines.push('', ...more);
  }
  lines.push('', ...trophies(summary, paint), '', paint.dim('Krascha remembers.'));
  return `${lines.join('\n')}\n`;
}
