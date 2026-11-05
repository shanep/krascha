// How hard you run Claude: the average tokens a day over the last
// TOKEN_WINDOW_DAYS days, from the daily totals in Claude Code's usage stats.
// Someone newer than the window is averaged over the days since their first.
// Claude Code only adds to its stats now and then, so the window ends on the
// last day they were worked out through, not today, or every day the stats
// lag would count as a day with no tokens. Copilot CLI's tokens come from the index instead, and are kept apart.

import type { DailyUsage } from '../usage.js';
import { TOKEN_WINDOW_DAYS } from '../shared/reputation.js';

import type { ReputationIndex } from './store.js';
import { dayOf } from './summarize.js';

const DAY_MS = 86_400_000;

/** Noon on a YYYY-MM-DD local date, so a daylight saving change never moves it a day. */
function noonOf(date: string): number {
  const [year = 0, month = 1, day = 1] = date.split('-').map(Number);
  return new Date(year, month - 1, day, 12).getTime();
}

function tokensOf(day: DailyUsage): number {
  return Object.values(day.tokensByModel).reduce((sum, tokens) => sum + tokens, 0);
}

/**
 * Whole tokens a day, or 0 with no history. `days` is sorted oldest first, as
 * dailyUsage returns it. The window ends on `through`, a YYYY-MM-DD local
 * date, or today when that is null or later.
 */
export function averageTokensPerDay(
  days: readonly DailyUsage[],
  now: number,
  through: string | null = null,
): number {
  const first = days[0]?.date;
  if (first === undefined) {
    return 0;
  }
  const today = noonOf(dayOf(now));
  const end = through === null ? today : Math.min(today, noonOf(through));
  const start = Math.max(noonOf(first), end - (TOKEN_WINDOW_DAYS - 1) * DAY_MS);
  if (start > end) {
    return 0;
  }
  const span = Math.round((end - start) / DAY_MS) + 1;
  const [from, to] = [dayOf(start), dayOf(end)];
  const tokens = days
    .filter((day) => day.date >= from && day.date <= to)
    .reduce((sum, day) => sum + tokensOf(day), 0);
  return Math.round(tokens / span);
}

/** Every session's tokens in the index added up by day, oldest first, in the shape averageTokensPerDay reads. */
export function indexUsage(
  index: ReputationIndex,
  filter?: (sessionId: string) => boolean,
): DailyUsage[] {
  const totals = new Map<string, number>();
  for (const [sessionId, days] of index.tokens) {
    if (filter !== undefined && !filter(sessionId)) {
      continue;
    }
    for (const [date, tokens] of Object.entries(days)) {
      totals.set(date, (totals.get(date) ?? 0) + tokens);
    }
  }
  return [...totals]
    .map(([date, tokens]) => ({ date, tokensByModel: { all: tokens } }))
    .toSorted((left, right) => left.date.localeCompare(right.date));
}

/** Every token in the days, all time. */
export function totalTokens(days: readonly DailyUsage[]): number {
  return days.reduce((sum, day) => sum + tokensOf(day), 0);
}
