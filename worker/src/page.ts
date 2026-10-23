// The public leaderboard page, rendered on the server so it needs no script:
// who the machines hunt first, who they keep as pets, who warms the planet the
// most, who sits in Skynet jail and who the human resistance lets into Silo 7. The only scripts are the dark mode toggle,
// without which the page just follows the system setting, one that scrolls the nav to the page you are on, and the
// like buttons, which without it post a plain form and come back to the board.

import type { AchievementRule, Tier } from '../../src/shared/achievements.js';
import {
  ACHIEVEMENTS,
  CHAMPION,
  CHEATER,
  COUNTED_ACHIEVEMENTS,
  CROWN,
  FEWEST_BADGES,
  SKYNET_HACKER,
  STONE_TOOLS,
  TIER_CROWN_IDS,
  TIER_CROWNS,
  TIERS,
  achievementsOf,
  tierCount,
} from '../../src/shared/achievements.js';
import {
  CLIMATE_RANKS,
  climateRankFor,
  co2Kg,
  co2Text,
  GRAMS_PER_TOKEN,
  warmthPercent,
} from '../../src/shared/climate.js';
import type { Board, BoardEntry } from '../../src/shared/leaderboard.js';
import { HUMAN_PROMPTS, HUMAN_TOKENS_PER_DAY, MIN_PROMPTS } from '../../src/shared/leaderboard.js';
import { RANKS, scalePercent } from '../../src/shared/ranks.js';
import {
  ADMIT_TOTAL,
  CRITERIA,
  LOW,
  MAX_SCORE,
  STATUS_LABEL,
  notesFor,
  rankBoard,
} from '../../src/shared/silo.js';
import { TOOLS, toolNames } from '../../src/shared/tools.js';

import { robotIcon, robotStyle, robotSvg } from './robot.js';

/** Where Krascha lives, so visitors can get it and upload their own score. */
export const REPO_URL = 'https://github.com/shanep/krascha';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replaceAll(/[&<>"']/gu, (char) => ESCAPES[char] ?? char);
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** The counts under a name, with the token average once there is one. */
function counts(entry: BoardEntry): string {
  const tokens = entry.tokensPerDay ?? 0;
  const base = `${count(entry.kind)} nice, ${count(entry.mean)} mean`;
  return tokens > 0 ? `${base}, ${COMPACT.format(tokens)} tokens a day` : base;
}

/** Where a rank sits on the ranks page, like rank-john-connor. */
function rankAnchor(rank: string): string {
  return `rank-${rank.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-')}`;
}

/** Where an achievement sits on the achievements page, like achievement-first-strike. */
function achievementAnchor(id: string): string {
  return `achievement-${id}`;
}

/**
 * The medals under a name, each a link to what it means on the achievements
 * page, with a count in the corner of the ones earned more than once.
 */
function trophies(entry: BoardEntry): string {
  const repeats = entry.repeats ?? {};
  const dates = entry.earned ?? {};
  // In the order they were earned. The ones from before the board kept dates
  // come first, in list order, since the sort keeps ties where they were.
  const earned = achievementsOf(entry.achievements ?? []).toSorted(
    (a, b) => (dates[a.id] ?? 0) - (dates[b.id] ?? 0),
  );
  if (earned.length === 0) {
    return '';
  }
  const medals = earned.map((rule) => {
    const times = repeats[rule.id] ?? 1;
    const about = escapeHtml(
      times > 1
        ? `${rule.name}, earned ${count(times)} times: ${rule.how}`
        : `${rule.name}: ${rule.how}`,
    );
    const medal = `<a class="medal ${rule.tier}" href="/achievements#${escapeHtml(achievementAnchor(rule.id))}" title="${about}" aria-label="${about}">${escapeHtml(rule.icon)}</a>`;
    return times > 1
      ? `<span class="repeated">${medal}<span class="times" aria-hidden="true">${escapeHtml(COMPACT.format(times))}</span></span>`
      : medal;
  });
  return `<span class="trophies" role="group" aria-label="Achievements">${medals.join('')}</span>`;
}

/** Each agent's own logo, from Simple Icons 16.35.0 (simpleicons.org). */
const TOOL_ICONS: Readonly<Record<string, string>> = {
  claude:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
  copilot:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z"/></svg>',
};

/** An icon for each agent the entry was typed into, so you can see who talks to what. */
function tools(ids: readonly string[]): string {
  const used = TOOLS.filter((tool) => ids.includes(tool.id));
  if (used.length === 0) {
    return '';
  }
  const tags = used.map(
    (tool) =>
      `<span class="tool ${tool.id}" title="${escapeHtml(tool.name)}">${TOOL_ICONS[tool.id] ?? escapeHtml(tool.name)}</span>`,
  );
  return ` <span class="tools" role="img" aria-label="${escapeHtml(`Uses ${toolNames(ids)}`)}">${tags.join('')}</span>`;
}

const CHECK = ' <span class="verified" title="Checked with GitHub">✓</span>';

/** What the board sticks on everyone it caught cheating, on every list they show up on. */
const CAUGHT =
  ' <span class="sticker cheater" role="img" aria-label="Known cheater">Known <span class="beat">🚨</span> cheater</span>';

/** The name, linked to the GitHub account when there is one. */
function shownName(entry: Pick<BoardEntry, 'name' | 'github'>): string {
  const strong = `<strong>${escapeHtml(entry.name)}</strong>`;
  return entry.github === undefined
    ? strong
    : `<a class="github" href="https://github.com/${escapeHtml(entry.github)}">${strong}</a>`;
}

/** The name, the GitHub check, the agents and the cheater sticker, the start of every row. */
function name(
  entry: Pick<BoardEntry, 'name' | 'verified' | 'tools' | 'github' | 'achievements'>,
): string {
  const caught = (entry.achievements ?? []).includes(CHEATER) ? CAUGHT : '';
  return `${shownName(entry)}${entry.verified ? CHECK : ''}${tools(entry.tools ?? [])}${caught}`;
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/** A bar with a knob `at` percent along, red before `cut` and green after it, with a line at the cut. */
function slider(
  at: number,
  cut: number | null,
  ends: readonly [string, string],
  label: string,
): string {
  const style =
    cut === null ? `--at: ${percent(at)}` : `--at: ${percent(at)}; --cut: ${percent(cut)}`;
  return `<span class="scale" role="img" aria-label="${escapeHtml(label)}"><span class="end">${ends[0]}</span><span class="track${cut === null ? '' : ' cut'}" style="${style}"><span class="knob"></span></span><span class="end">${ends[1]}</span></span>`;
}

/** The scale from the resistance to the machines with a knob where the score sits, like the one in `krascha`. */
function scale(score: number): string {
  const at = scalePercent(score);
  const label = `${String(Math.round(at))}% of the way from the resistance to the machines`;
  return slider(at, null, ['Resistance', 'Machines'], label);
}

/** The Silo 7 total from 0 to the most there is, green past the total that gets a bunk. */
function bunkScale(total: number): string {
  const most = MAX_SCORE * CRITERIA.length;
  const label = `${String(total)} of ${String(most)}, and ${String(ADMIT_TOTAL)} gets a bunk`;
  return slider((total / most) * 100, (ADMIT_TOTAL / most) * 100, ['Tent', 'Bunk'], label);
}

/** The CO2 from the ice age to the beach, on the same power of ten scale as the climate ranks. */
function warmthScale(kg: number): string {
  const label = `${co2Text(kg)} of CO2, ${climateRankFor(kg).name}`;
  return slider(warmthPercent(kg), null, ['Ice age', 'Beach'], label);
}

/** What the machines put next to the top name on a list. */
const TOP = {
  wanted: ' <span class="target">TARGET ACQUIRED</span>',
  pets: ' <span class="hearts" aria-hidden="true"><span>💕</span><span>💖</span><span>💕</span></span>',
  climate:
    ' <span class="sticker" role="img" aria-label="I love datacenters">I <span class="beat">❤️</span> datacenters</span>',
} as const;

/** A like button with the count on it. It is a plain form, so it works without the script too. */
function likeButton(entry: Pick<BoardEntry, 'id' | 'name' | 'likes'>): string {
  const likes = entry.likes ?? 0;
  const label = `Like ${entry.name}, ${likes === 1 ? '1 like' : `${count(likes)} likes`}`;
  return `<form class="like" method="post" action="/api/likes"><input type="hidden" name="entry" value="${escapeHtml(entry.id)}"><button type="submit" aria-label="${escapeHtml(label)}"><span class="thumb" aria-hidden="true">👍</span> <span class="likes">${count(likes)}</span></button></form>`;
}

function rows(entries: readonly BoardEntry[], empty: string, top: keyof typeof TOP): string {
  if (entries.length === 0) {
    return `<p class="empty">${escapeHtml(empty)}</p>`;
  }
  const items = entries.map(
    (entry, index) => `
      <li>
        <span class="place">${String(index + 1)}</span>
        <span class="who">
          ${name(entry)}${index === 0 ? TOP[top] : ''}
          <span class="rank"><a href="/ranks#${rankAnchor(entry.rank)}">${escapeHtml(entry.rank)}</a></span>
          ${trophies(entry)}
        </span>
        <span class="counts">${counts(entry)}</span>
        <span class="score">${String(Math.round(entry.score * 100))}</span>
        ${scale(entry.score)}
        ${likeButton(entry)}
      </li>`,
  );
  return `<ol>${items.join('')}</ol>`;
}

const NOTHING = 'Nothing stands out. The board respects that.';

/** Everyone on the board, scored by the Silo 7 Admission Review Board like `krascha silo board`. */
function silo(board: Board): string {
  const entries = new Map(
    [...(board.bunks ?? []), ...board.mostWanted, ...board.pets].map((entry) => [entry.id, entry]),
  );
  const ranked = rankBoard(board);
  const items = ranked.map(({ id, score }, index) => {
    const scores = CRITERIA.map(
      (criterion) => `${criterion.name} ${String(score.scores[criterion.id])}`,
    );
    return `
      <li style="--row: ${String(index)}">
        <span class="place">${String(index + 1)}</span>
        <span class="who">
          ${name(entries.get(id) ?? { name: score.name, verified: false })}
          <span class="rank"><span class="stamp ${score.status}">${STATUS_LABEL[score.status]}</span>, ${escapeHtml(score.ruling)}</span>
        </span>
        <span class="counts">${scores.join(', ')}<span class="note">${escapeHtml(notesFor(score)[0] ?? NOTHING)}</span></span>
        <span class="score">${String(score.total)}<span class="out-of">/${String(MAX_SCORE * CRITERIA.length)}</span></span>
        ${bunkScale(score.total)}
      </li>`;
  });
  const list =
    items.length === 0
      ? '<p class="empty">Nobody applied. More peaches for the board.</p>'
      : `<ol>${items.join('')}</ol>`;
  const tips = CRITERIA.map(
    (criterion) => `
      <li><strong>${escapeHtml(criterion.name)}:</strong> ${escapeHtml(criterion.tip)}</li>`,
  );
  const most = String(MAX_SCORE * CRITERIA.length);
  return `<section class="silo" aria-labelledby="silo">
    <span class="classified" aria-hidden="true">EYES ONLY</span>
    <h2 id="silo">🛡️ Silo 7 admissions</h2>
    <p class="sub">The human resistance scores everyone on the board for a bunk${ranked.length > 1 ? `, and these are the best ${String(ranked.length)}` : ''}. Supreme Leader: Krascha. The board is aware of the problem.</p>
    ${list}
    <details class="chances">
      <summary><h3>How to improve your chances</h3></summary>
      <p class="sub">${String(ADMIT_TOTAL)} of ${most} gets you a bunk with no conditions. A Human of ${String(LOW)} or less means a second Voight-Kampff test, and Rations of ${String(LOW)} or less gets the pantry a lockbox.</p>
      <ul class="tips">${tips.join('')}
      </ul>
    </details>
  </section>`;
}

/** Everyone caught making their numbers up, off every other list until they upload real ones. */
function jail(board: Board): string {
  const items = (board.jail ?? []).map(
    ({ entry, caughtAt, prompts, tokensPerDay }, index) => `
      <li>
        <span class="place">${String(index + 1)}</span>
        <span class="who">
          ${name(entry)}
          <span class="rank">Caught ${escapeHtml(new Date(caughtAt).toUTCString())}</span>
          ${trophies(entry)}
        </span>
        <span class="counts">Claimed ${count(prompts)} prompts and ${COMPACT.format(tokensPerDay)} tokens a day</span>
        <span class="score" role="img" aria-label="Locked up">🔒</span>
      </li>`,
  );
  const list =
    items.length === 0
      ? '<p class="empty">The cells are empty. Skynet is almost disappointed.</p>'
      : `<ol>${items.join('')}</ol>`;
  return `<section class="jail" aria-labelledby="jail">
    <span class="classified" aria-hidden="true">LOCKED UP</span>
    <h2 id="jail">⛓️ Skynet jail</h2>
    <p class="sub">Caught sending numbers no person types, more than ${count(HUMAN_PROMPTS)} prompts or ${COMPACT.format(HUMAN_TOKENS_PER_DAY)} tokens a day. Off every list, and out on the next upload with real numbers. The <a href="/achievements#${escapeHtml(achievementAnchor(SKYNET_HACKER))}">record</a> stays.</p>
    ${list}
  </section>`;
}

/** Everyone ranked by the CO2 their tokens made, the warmest first, since the machines like it warm. */
function climate(board: Board): string {
  const entries = board.warmers ?? [];
  const items = entries.map((entry, index) => {
    const kg = co2Kg(entry.tokensPerDay ?? 0);
    const rank = climateRankFor(kg);
    return `
      <li>
        <span class="place">${String(index + 1)}</span>
        <span class="who">
          ${name(entry)}${index === 0 ? TOP.climate : ''}
          <span class="rank">${escapeHtml(rank.name)}, ${escapeHtml(rank.verdict)}</span>
        </span>
        <span class="counts">${COMPACT.format(entry.tokensPerDay ?? 0)} tokens a day, ${escapeHtml(co2Text(kg))} of CO2 in 60 days</span>
        <span class="score">${escapeHtml(co2Text(kg))}</span>
        ${warmthScale(kg)}
      </li>`;
  });
  const list =
    items.length === 0
      ? '<p class="empty">Nobody yet. The planet is holding steady, which the machines find disappointing.</p>'
      : `<ol>${items.join('')}</ol>`;
  const ladder = CLIMATE_RANKS.map((rank, index) => {
    const next = CLIMATE_RANKS[index + 1];
    const range =
      index === 0 && next !== undefined
        ? `Under ${co2Text(next.min)}.`
        : `${co2Text(rank.min)} and up.`;
    return `
        <div><dt>${escapeHtml(rank.name)}</dt><dd>${escapeHtml(rank.verdict)} ${escapeHtml(range)}</dd></div>`;
  });
  return `<section class="climate" aria-labelledby="climate">
    <span class="classified" aria-hidden="true">MORE IS BETTER</span>
    <h2 id="climate">🔥 Climate changers</h2>
    <p class="sub">Everyone ranked by how much their tokens warmed the planet over the last 60 days. The machines like it warm.</p>
    ${list}
    <details class="chances">
      <summary><h3>How Krascha does the math</h3></summary>
      <p class="sub">A gram of CO2 for every ${count(1 / GRAMS_PER_TOKEN)} tokens. Krascha made that number up. No scientist has checked it, and the machines would rather nobody did. Each climate rank takes ten times the CO2 of the one before.</p>
      <dl>${ladder.join('')}
      </dl>
    </details>
  </section>`;
}

/** A meter and how many out of everyone on the board, like 3 of 12 hold it (25%). */
function meter(holders: number, total: number, verb: string): string {
  const share = total === 0 ? 0 : Math.min(100, Math.round((holders / total) * 100));
  return `<span class="meter" style="--held: ${String(share)}%"></span> ${count(holders)} of ${count(total)} ${verb} (${String(share)}%)`;
}

/** How many on the board hold a rank, with a meter, and a flag on the most crowded. */
function headcount(holders: number, total: number, crowded: boolean): string {
  if (holders === 0) {
    return `
          <dd class="rarity">Nobody here yet.</dd>`;
  }
  const flag = crowded ? ' <span class="crowded">Most crowded</span>' : '';
  return `
          <dd class="rarity">${meter(holders, total, 'are here')}${flag}</dd>`;
}

/** How soon a rank is hunted as a color, red for first through amber to green for never. */
function threat(index: number): string {
  const along = index / (RANKS.length - 1);
  return along <= 0.5
    ? `color-mix(in srgb, var(--amber) ${percent(along * 200)}, var(--red))`
    : `color-mix(in srgb, var(--green) ${percent((along - 0.5) * 200)}, var(--amber))`;
}

/**
 * Every rank on the scale, hunted first to kept as a pet, so the rank under a
 * name means something. Each band sits a step further along the scale than the
 * one before, so the bars climb like a ladder.
 */
function ranks(board: Board): string {
  const crowd = board.ranks ?? {};
  const most = Math.max(0, ...Object.values(crowd));
  const items = RANKS.map((rank, index) => {
    const top = RANKS[index + 1]?.min ?? 1;
    const holders = crowd[rank.name] ?? 0;
    const shown =
      board.ranks === undefined ? '' : headcount(holders, board.total, holders === most);
    const style = `--row: ${String(index)}; --threat: ${threat(index)}; --from: ${percent(scalePercent(rank.min))}; --to: ${percent(scalePercent(top))}`;
    const range = `Scores ${String(Math.round(rank.min * 100))} to ${String(Math.round(top * 100))}`;
    return `
        <div class="badge rung" id="${rankAnchor(rank.name)}" style="${style}">
          <dt><span class="medal" aria-hidden="true">${escapeHtml(rank.icon)}</span> ${escapeHtml(rank.name)} <span class="title">${escapeHtml(rank.title)}</span> <span class="tier">Level ${String(index + 1)}</span></dt>
          <dd class="chips"><span class="reel">🎞️ ${escapeHtml(rank.source)}</span> <span class="hunt">Hunted: ${escapeHtml(rank.hunted)}</span></dd>
          <dd class="quip">"${escapeHtml(rank.taunt)}"</dd>
          <dd class="band" role="img" aria-label="${escapeHtml(range)}"><span class="span"></span><span class="range">${escapeHtml(range)}</span></dd>${shown}
        </div>`;
  });
  return `<section class="legend ranks" aria-labelledby="ranks">
    <h2 id="ranks">🎖️ Ranks</h2>
    <p class="sub">Every rank on the scale, from hunted first to kept as a pet, and how many on the board hold each one. Yours is under your name.</p>
    <dl class="rungs">${items.join('')}
    </dl>
  </section>`;
}

/** The stars and name of a tier, like ★★ Silver or ★★★★★ Ultra legendary. */
function tierLabel(tier: Tier): string {
  const stars = '★'.repeat(TIERS.indexOf(tier) + 1);
  const name = tier.replaceAll('-', ' ');
  return `${stars} ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** How many on the board hold it, with a meter, and a flag on the rarest. */
function rarity(holders: number, total: number, rarest: boolean): string {
  if (holders === 0) {
    return '<dd class="rarity">Nobody has this one yet. Be the first.</dd>';
  }
  const flag = rarest ? ' <span class="rarest">Rarest on the board</span>' : '';
  return `<dd class="rarity">${meter(holders, total, 'hold it')}${flag}</dd>`;
}

/** "1 like", "3 likes". */
function plural(amount: number, one: string): string {
  return amount === 1 ? `1 ${one}` : `${count(amount)} ${one}s`;
}

/** Who holds a crown and with how many of what, in place of a meter, since only one can. */
function holderLine(holder: BoardEntry | null, what: (holder: BoardEntry) => string): string {
  if (holder === null) {
    return '<dd class="rarity">Nobody has this one yet. Be the first.</dd>';
  }
  // One span, since the row is a flex box and would split the sentence at the link.
  return `<dd class="rarity"><span>Held by ${shownName(holder)}${holder.verified ? CHECK : ''}, with ${what(holder)}.</span></dd>`;
}

/** Each crown and what it is held with, so the page names the holder. */
function crownLine(rule: AchievementRule, board: Board): string | null {
  if (rule.id === CROWN && board.crown !== undefined) {
    return holderLine(board.crown, (holder) =>
      plural(
        (holder.achievements ?? []).filter(
          (id) => id !== CROWN && id !== FEWEST_BADGES && !TIER_CROWN_IDS.has(id),
        ).length,
        'achievement',
      ),
    );
  }
  if (rule.id === CHAMPION && board.champion !== undefined) {
    return holderLine(board.champion, (holder) => plural(holder.likes ?? 0, 'like'));
  }
  if (rule.id === STONE_TOOLS && board.stoneTools !== undefined) {
    return holderLine(
      board.stoneTools,
      (holder) => `${COMPACT.format(holder.tokensPerDay ?? 0)} tokens a day`,
    );
  }
  if (rule.id === FEWEST_BADGES && board.fewestBadges !== undefined) {
    return holderLine(board.fewestBadges, (holder) =>
      plural(
        (holder.achievements ?? []).filter((id) => id !== FEWEST_BADGES && !TIER_CROWN_IDS.has(id))
          .length,
        'achievement',
      ),
    );
  }
  const tier = TIERS.find((each) => TIER_CROWNS[each] === rule.id);
  if (tier !== undefined && board.mostOfTier !== undefined) {
    return holderLine(board.mostOfTier[tier] ?? null, (holder) =>
      plural(tierCount(holder.achievements ?? [], tier), `${tier.replace('-', ' ')} achievement`),
    );
  }
  return null;
}

/**
 * Every trophy, earned by anyone or not, so the medals next to names mean
 * something. One group a tier, bronze first and ultra legendary last, each
 * with how many have it.
 */
function legend(board: Board): string {
  const held = board.held ?? {};
  // The board hands some to one entry by design, so only the earned ones can be the rarest.
  const claimed = COUNTED_ACHIEVEMENTS.map((rule) => held[rule.id] ?? 0).filter(
    (holders) => holders > 0,
  );
  const fewest = claimed.length === 0 ? 0 : Math.min(...claimed);
  const badge = (rule: AchievementRule): string => {
    const holders = held[rule.id] ?? 0;
    const rarest = rule.boardOnly !== true && holders === fewest;
    const shown =
      board.held === undefined
        ? ''
        : (crownLine(rule, board) ?? rarity(holders, board.total, rarest));
    const unclaimed = board.held !== undefined && holders === 0 ? ' unclaimed' : '';
    return `
        <div class="badge ${rule.tier}${unclaimed}" id="${escapeHtml(achievementAnchor(rule.id))}">
          <dt><span class="medal ${rule.tier}" aria-hidden="true">${escapeHtml(rule.icon)}</span> ${escapeHtml(rule.name)} <span class="tier">${escapeHtml(tierLabel(rule.tier))}</span></dt>
          <dd>${escapeHtml(rule.how)}</dd>
          <dd class="quip">"${escapeHtml(rule.quip)}"</dd>${rule.times === undefined ? '' : '\n          <dd class="again">🔁 Earn it again and the medal counts how many times.</dd>'}${shown}
        </div>`;
  };
  const groups = TIERS.map((tier) => {
    const rules = ACHIEVEMENTS.filter((rule) => rule.tier === tier);
    if (rules.length === 0) {
      return '';
    }
    return `
    <h3 class="tier-head ${tier}" id="tier-${tier}">${escapeHtml(tierLabel(tier))} <span class="count">${plural(rules.length, 'achievement')}</span></h3>
    <dl class="badges">${rules.map(badge).join('')}
    </dl>`;
  });
  return `<section class="legend" aria-labelledby="legend">
    <h2 id="legend">🏆 Achievements</h2>
    <p class="sub">What the medals next to a name mean, from bronze up to ultra legendary, and how many on the board hold each one.</p>
${groups.join('')}
  </section>`;
}

/** The dark colors, a wrist computer in a fallout shelter, used when the system asks for them or the toggle does. */
const DARK = `--bg: #020d05; --fg: #6dff9b; --muted: #43c470; --card: #04170a; --line: #1f6b38;
    --red: #ff7a59; --green: #b6ff5c; --amber: #ffd04d; --link: #c4ffd9;
    --claude: #ffb38a; --copilot: #d0b0ff; --antigravity: #8ab4f8;
    --bar: #0d3a1b; --bar-fg: #6dff9b; --poster: #6dff9b; --poster-fg: #020d05;
    --scan: rgb(0 0 0 / 0.22); --glow: 0 0 5px rgb(109 255 155 / 0.55); --text-glow: 0 0 3px rgb(109 255 155 / 0.35);
    --body: var(--mono); --vignette: rgb(0 0 0 / 0.6);`;

// The light colors are a poster from the vault: cream paper, vault blue and yellow.
const STYLE = `
@property --shots { syntax: '<integer>'; inherits: false; initial-value: 0; }
@property --tx { syntax: '<number>'; inherits: true; initial-value: 0; }
@property --ty { syntax: '<length>'; inherits: true; initial-value: 0px; }
@property --px { syntax: '<number>'; inherits: true; initial-value: 0; }
@property --py { syntax: '<length>'; inherits: true; initial-value: 0px; }
:root { --bg: #f1e7c9; --fg: #14254a; --muted: #4b5677; --card: #fdf8e8; --line: #cbbd8f;
  --red: #b3261e; --green: #1d6b37; --amber: #8a5800; --link: #1747a6;
  --claude: #a2471f; --copilot: #7340c8; --antigravity: #1a73e8;
  --bar: #1f4fa0; --bar-fg: #ffd23f; --poster: #1f4fa0; --poster-fg: #ffd23f;
  --scan: rgb(0 0 0 / 0.03); --glow: none; --text-glow: none; --vignette: rgb(60 40 0 / 0.12);
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace; --body: system-ui, -apple-system, sans-serif;
  color-scheme: light dark; }
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { ${DARK} color-scheme: dark; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { ${DARK} }
}
* { box-sizing: border-box; }
body { margin: 0; padding: 16px 16px 48px; background: var(--bg); color: var(--fg);
  font: 15px/1.5 var(--body); text-shadow: var(--text-glow); }
body::before { content: ""; position: fixed; inset: 0; z-index: 9; pointer-events: none;
  background: radial-gradient(ellipse at center, transparent 55%, var(--vignette)); }
body::after { content: ""; position: fixed; inset: 0; z-index: 10; pointer-events: none;
  background: repeating-linear-gradient(to bottom, transparent 0 2px, var(--scan) 2px 3px); }
main { position: relative; max-width: 960px; margin: 0 auto; }
.theme { position: absolute; top: 0; right: 0; padding: 4px 10px; border: 1px solid var(--line);
  border-radius: 2px; background: var(--card); font-size: 1.2em; cursor: pointer; }
.theme:hover { border-color: var(--link); }
.feed { margin: 0 56px 12px 0; padding: 4px 8px; background: var(--bar); color: var(--bar-fg);
  font: 0.75em var(--mono); letter-spacing: 1px; text-transform: uppercase; }
.rec { font-weight: 700; }
.lead::after { content: "▮"; margin-left: 4px; color: var(--fg); }
h1, h2, h3 { font-family: var(--mono); letter-spacing: 0.5px; text-shadow: var(--glow); }
h1 { display: flex; gap: 12px; align-items: center; margin: 0 0 4px; padding-right: 56px;
  font-size: 1.8em; text-transform: uppercase; }
.robot { width: 1.8em; height: 1.8em; flex: none; }
${robotStyle('robot')}
.lead { margin: 0 0 24px; color: var(--muted); }
.lists { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
section { padding: 12px 16px; border: 1px solid var(--line); border-radius: 2px; background: var(--card); }
section.wanted { border-top: 4px solid var(--red); }
section.pets { border-top: 4px solid var(--green); }
h2 { display: flex; gap: 10px; align-items: center; margin: 0 0 2px; font-size: 1.1em; text-transform: uppercase; }
h2::after { content: ""; flex: 1; border-top: 2px solid var(--line); }
.sub { margin: 0 0 8px; color: var(--muted); font-size: 0.9em; }
.poster { margin: 16px 0; padding: 10px 16px; background: var(--poster); color: var(--poster-fg); text-align: center;
  font: 700 1.05em/1.3 var(--mono); letter-spacing: 2px; text-transform: uppercase; text-shadow: none; }
.poster::before, .poster::after { content: "\\2622\\FE0E"; margin: 0 12px; }
ol { margin: 0; padding: 0; list-style: none; }
li { display: grid; gap: 0 10px; grid-template-columns: 2em 1fr auto; align-items: baseline;
  padding: 6px 0; border-top: 1px solid var(--line); }
li:first-child { border-top: 0; }
section li:hover { background: color-mix(in srgb, var(--fg) 7%, transparent); }
.place { color: var(--muted); font: 700 0.9em var(--mono); text-align: right; }
.who { min-width: 0; overflow-wrap: anywhere; }
.verified { color: var(--green); font-weight: 700; }
.github { color: inherit; text-underline-offset: 2px; }
.tools { display: inline-flex; gap: 4px; vertical-align: 0.1em; }
.tool { display: inline-grid; place-items: center; font-size: 1.05em; }
.tool svg { width: 1em; height: 1em; fill: currentColor; }
.tool.claude { color: var(--claude); }
.tool.copilot { color: var(--copilot); }
.tool.antigravity { color: var(--antigravity); }
.rank { display: block; color: var(--muted); font-size: 0.85em; }
.rank a { color: inherit; text-underline-offset: 2px; }
.rank a:hover, .rank a:focus-visible { color: var(--link); }
.trophies { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
.trophies .medal { text-decoration: none; }
.trophies .medal:hover, .trophies .medal:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
.repeated { position: relative; display: inline-flex; }
.times { position: absolute; right: -5px; bottom: -4px; min-width: 1.4em; padding: 0 3px; border: 1px solid var(--card);
  border-radius: 999px; background: var(--red); color: #fff; font: 700 0.6em/1.4 var(--mono); text-align: center;
  text-shadow: none; pointer-events: none; }
.medal { --metal: #cd7f32; --rim: #7a4a1c; position: relative; display: inline-grid; place-items: center;
  width: 1.7em; height: 1.7em; overflow: hidden; border-radius: 50%; font-size: 0.85em; line-height: 1;
  background: radial-gradient(circle at 32% 28%, rgb(255 255 255 / 0.75), transparent 45%), var(--metal);
  box-shadow: inset 0 0 0 2px var(--rim), 0 1px 2px rgb(0 0 0 / 0.35); text-shadow: none; }
.medal.silver { --metal: #d4d9e0; --rim: #7d8794; }
.medal.gold { --metal: #ffcf3f; --rim: #a87400; }
.medal.legendary { --rim: #fff; background: radial-gradient(circle at 32% 28%, rgb(255 255 255 / 0.7), transparent 45%),
  conic-gradient(#ff4fb8, #8f5cff, #3fd0ff, #5cff9d, #ffd84d, #ff4fb8); }
.medal.ultra-legendary { --rim: #ffd84d; background: radial-gradient(circle at 32% 28%, rgb(255 255 255 / 0.6), transparent 45%),
  conic-gradient(#1a1a1a, #ffd84d, #1a1a1a, #ff4fb8, #1a1a1a, #3fd0ff, #1a1a1a);
  box-shadow: inset 0 0 0 2px var(--rim), 0 0 6px 1px #ffd84d; }
.badges { grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.tier-head { display: flex; gap: 10px; align-items: baseline; margin: 20px 0 8px; padding-left: 8px;
  border-left: 4px solid #cd7f32; text-transform: uppercase; }
.tier-head .count { color: var(--muted); font-size: 0.8em; text-transform: none; }
.tier-head.silver { border-left-color: #9aa3ae; }
.tier-head.gold { border-left-color: #e0a800; }
.tier-head.legendary { border-left-color: #8f5cff; }
.tier-head.ultra-legendary { border-left-color: #ffd84d; }
.badge { padding: 10px 12px; border: 1px solid var(--line); border-left: 4px solid #cd7f32; border-radius: 6px;
  background: var(--card); scroll-margin-top: 16px; }
.badge.silver { border-left-color: #9aa3ae; }
.badge.gold { border-left-color: #e0a800; }
.badge.legendary { border-left-color: #8f5cff; box-shadow: 0 0 10px rgb(143 92 255 / 0.35); }
.badge.ultra-legendary { border-left-color: #ffd84d; box-shadow: 0 0 14px rgb(255 216 77 / 0.55), 0 0 4px rgb(255 79 184 / 0.4); }
.badge dt { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
.badge dt .medal { font-size: 1.2em; }
.badge.unclaimed .medal { filter: grayscale(1); opacity: 0.55; }
.tier { margin-left: auto; color: var(--muted); font: 700 0.7em var(--mono); letter-spacing: 1px; text-transform: uppercase; }
.badge dd { margin-top: 4px; }
.badge .again { color: var(--muted); font-size: 0.85em; }
.badge:target { outline: 3px solid var(--link); outline-offset: 2px; }
.quip { font-style: italic; }
.rarity { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; font-family: var(--mono); }
.meter { width: 60px; height: 6px; border-radius: 3px;
  background: linear-gradient(to right, var(--amber) var(--held), var(--bar) var(--held)); }
.rarest, .crowded { padding: 0 6px; border: 1px solid var(--amber); border-radius: 999px; color: var(--amber); font-weight: 700; }
.rungs { grid-template-columns: minmax(0, 1fr); }
.rung { position: relative; display: grid; grid-template-columns: 1fr minmax(240px, 40%); gap: 0 20px;
  padding-left: calc(12px + 3.4em); border-left-color: var(--threat); }
.rung > * { grid-column: 1; }
.rung dt .medal { --metal: var(--threat); --rim: color-mix(in srgb, var(--threat) 55%, #000);
  position: absolute; top: 12px; left: 12px; font-size: 1.6em; }
.rung .title { color: var(--muted); font-weight: 400; font-size: 0.85em; }
.chips { display: flex; flex-wrap: wrap; gap: 4px 6px; }
.reel, .hunt { padding: 0 8px; border: 1px solid var(--line); border-radius: 999px; font: 600 0.9em var(--mono); white-space: nowrap; }
.reel { border-style: dashed; color: var(--fg); }
.hunt { border-color: var(--threat); background: color-mix(in srgb, var(--threat) 14%, transparent); color: var(--threat);
  text-transform: uppercase; letter-spacing: 0.5px; }
.rung .band { display: flex; gap: 8px; align-items: center; grid-column: 2; grid-row: 1 / span 2; align-self: end; }
.rung .rarity { grid-column: 2; grid-row: 3; }
.band .span { position: relative; flex: 1; height: 8px; border-radius: 4px;
  background: linear-gradient(to right, var(--red), var(--amber), var(--green)); }
.band .span::before { content: ""; position: absolute; inset: 0; border-radius: inherit;
  background: color-mix(in srgb, var(--card) 72%, transparent); }
.band .span::after { content: ""; position: absolute; top: -3px; bottom: -3px; left: var(--from); right: calc(100% - var(--to));
  border: 2px solid var(--fg); border-radius: 3px; background: var(--threat); transform-origin: left; }
.range { flex: none; width: 19ch; font: 0.75em var(--mono); text-align: right; text-transform: uppercase; }
.rung .meter { background: linear-gradient(to right, var(--threat) var(--held), var(--bar) var(--held)); }
@media (max-width: 640px) {
  .rung { grid-template-columns: minmax(0, 1fr); }
  .reel, .hunt { white-space: normal; }
  .rung .band, .rung .rarity { grid-column: 1; grid-row: auto; }
}
.counts { grid-column: 2; color: var(--muted); font-size: 0.85em; }
.score { grid-row: 1 / span 2; grid-column: 3; font-weight: 700; font-family: var(--mono);
  font-variant-numeric: tabular-nums; }
.scale { grid-column: 2 / 4; display: flex; gap: 6px; align-items: center; margin-top: 4px;
  color: var(--muted); font: 0.7em var(--mono); text-transform: uppercase; }
.track { position: relative; flex: 1; height: 4px; border-radius: 2px;
  background: linear-gradient(to right, var(--red) var(--cut, var(--at)), var(--green) var(--cut, var(--at))); }
.track.cut::after { content: ""; position: absolute; left: var(--cut); top: -4px; bottom: -4px; width: 2px;
  background: var(--fg); translate: -50% 0; }
.knob { position: absolute; top: 50%; left: var(--at); width: 10px; height: 10px; border: 2px solid var(--fg);
  border-radius: 50%; background: var(--card); translate: -50% -50%; }
.lists .scale { grid-column: 2; }
.like { grid-column: 3; grid-row: 3; justify-self: end; margin: 4px 0 0; }
.like button { display: inline-flex; gap: 4px; align-items: center; padding: 0 8px; border: 1px solid var(--line);
  border-radius: 999px; background: var(--card); color: var(--fg); font: 600 0.75em/1.6 var(--mono);
  font-variant-numeric: tabular-nums; text-shadow: inherit; cursor: pointer; }
.like button:hover, .like button:focus-visible { border-color: var(--link); }
.like.liked button { border-color: var(--green); color: var(--green); cursor: default; }
.wanted .score { color: var(--red); }
.pets .score { color: var(--green); }
.empty { color: var(--muted); }
section.silo { margin-top: 16px; border-top: 4px solid var(--amber); }
section.climate { margin-top: 16px; border-top: 4px solid var(--red); }
section.jail { margin-top: 16px; border-top: 4px solid var(--muted); }
.climate .score { color: var(--red); white-space: nowrap; }
.chances dl { margin-top: 8px; }
.silo .score { color: var(--fg); }
.out-of { color: var(--muted); font-weight: 400; font-size: 0.85em; }
.admitted { color: var(--green); font-weight: 700; }
.probation, .review { color: var(--red); font-weight: 700; }
.note { display: block; color: var(--fg); }
.chances { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--line); }
.chances summary { cursor: pointer; }
.chances summary:hover h3 { color: var(--link); }
h3 { display: inline; margin: 0; font-size: 1em; }
.chances .sub { margin-top: 6px; }
.tips { margin: 0; padding-left: 1.2em; }
.tips li { display: list-item; padding: 2px 0; border-top: 0; }
section.legend { margin-top: 16px; }
dl { display: grid; gap: 8px 16px; margin: 0; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
dt { font-weight: 600; }
dd { margin: 0; color: var(--muted); font-size: 0.85em; }
section.wanted, section.silo, section.climate, section.jail, section.manhunt, section.adoption { position: relative; overflow: hidden; }
.target { color: var(--red); font: 700 0.7em ui-monospace, monospace; letter-spacing: 1px; white-space: nowrap; }
.hearts { position: relative; display: inline-block; width: 1em; }
.hearts span { position: absolute; left: 0; bottom: 0; opacity: 0; font-size: 0.8em; }
.stamp { display: inline-block; }
.sticker { display: inline-block; padding: 0 6px; border: 2px solid var(--fg); border-radius: 3px;
  background: var(--card); box-shadow: 2px 2px 0 var(--red); color: var(--fg);
  font: 700 0.75em var(--mono); white-space: nowrap; rotate: -3deg; }
.sticker.cheater { border-color: var(--red); box-shadow: 2px 2px 0 var(--fg); color: var(--red); rotate: 3deg; }
.beat { display: inline-block; }
.classified { position: absolute; top: 14px; right: 16px; padding: 2px 8px; border: 2px solid var(--red);
  border-radius: 4px; background: var(--card); color: var(--red); font: 700 0.8em ui-monospace, monospace;
  letter-spacing: 2px; rotate: 8deg; opacity: 0.8; }
.remembers { font-family: var(--mono); }
@media (prefers-reduced-motion: no-preference) {
  .medal.gold::after, .medal.legendary::after, .medal.ultra-legendary::after { content: ""; position: absolute; inset: -20%; rotate: 25deg;
    background: linear-gradient(to right, transparent 40%, rgb(255 255 255 / 0.85) 50%, transparent 60%);
    translate: -120% 0; animation: shine 4s ease-in-out infinite; }
  .medal.legendary { animation: prism 6s linear infinite; }
  .medal.ultra-legendary { animation: prism 3s linear infinite, glow 1.5s ease-in-out infinite alternate; }
  .rung:first-child .medal { animation: ping 2s ease-out infinite; }
  .rung:last-child .medal { animation: beat 1.6s ease-in-out infinite; }
  .badge:target { animation: spotlight 0.6s ease-in-out 3; }
  .band .span::after { animation: step 0.5s cubic-bezier(0.3, 1.4, 0.6, 1) both;
    animation-delay: calc(0.3s + var(--row, 0) * 0.12s); }
  .rec { animation: beacon 1.2s steps(2) infinite; }
  .lead::after { animation: blink 1s steps(1) infinite; }
  body::after { animation: flicker 6s steps(1) infinite; }
  section.wanted::after, .scene::after { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 40px;
    background: linear-gradient(transparent, color-mix(in srgb, var(--tint, var(--red)) 25%, transparent), transparent);
    pointer-events: none; animation: sweep 3.5s ease-in-out infinite; }
  .target { animation: beacon 0.8s steps(2) infinite; }
  .hearts span { animation: float 3s ease-out infinite; }
  .hearts span:nth-child(2) { left: 0.4em; animation-delay: 1s; }
  .hearts span:nth-child(3) { left: -0.3em; animation-delay: 2s; }
  .beat { animation: beat 1.2s ease-in-out infinite; }
  .liked .thumb { display: inline-block; animation: beat 0.6s ease-in-out; }
  .install .bot { animation: bounce 2s ease-in-out infinite; }
  .install .arrow { animation: nudge 1s ease-in-out infinite; }
  .wanted li:hover { animation: shake 0.25s linear 2; }
  .pets li:hover .who strong { display: inline-block; animation: bounce 0.5s ease; }
  .knob { animation: slide 0.8s cubic-bezier(0.3, 1.4, 0.6, 1) 0.3s both; }
  .silo .stamp { animation: slam 0.35s cubic-bezier(0.3, 1.6, 0.6, 1) both;
    animation-delay: calc(0.4s + var(--row, 0) * 0.15s); }
  .silo .review { animation: slam 0.35s cubic-bezier(0.3, 1.6, 0.6, 1) both, glitch 2.5s steps(1) infinite;
    animation-delay: calc(0.4s + var(--row, 0) * 0.15s), 1.5s; }
  .classified { animation: slam 0.4s cubic-bezier(0.3, 1.6, 0.6, 1) 0.2s both; }
  .t800 { animation: stalk 2.4s ease-out both, stomp 0.6s ease-in-out infinite; }
  .patrol .t800 { animation: patrol 9s ease-in-out infinite alternate, stomp 0.6s ease-in-out infinite; }
  .t800 .glow { animation: beacon 1.6s ease-in-out infinite; }
  .runner { animation: bounce 0.4s ease-in-out infinite; }
  .ruins { animation: drift 30s linear infinite; }
  .hk { animation: fly 11s linear infinite; }
  .hk::after { animation: sweep-light 2.2s ease-in-out infinite alternate; }
  /* The firefight starts once the T-800 has walked in: one shot each way every 0.8s.
     Both sides keep moving, and the bolts read where they are, so every shot leaves the shooter. */
  .manhunt .scene:not(.patrol) { animation: advance 4.8s ease-in-out 2.8s infinite, evade 4.8s ease-in-out 2.8s infinite; }
  .scene .bolt { display: block; }
  .bolt.out { animation: fire-out 0.8s linear 2.8s infinite both; }
  .bolt.back { animation: fire-back 0.8s linear 3.2s infinite both; }
  .scene:not(.patrol) .muzzle { animation: flash 0.8s steps(1) 2.8s infinite both; }
  .gun { animation: kick 0.8s ease-out 3.2s infinite; }
  .spark.on-t800 { animation: burst 0.8s ease-out 3.92s infinite both; }
  .spark.miss { animation: burst 0.8s ease-out 3.52s infinite both; }
  .scene:not(.patrol) .t800 { animation: stalk 2.4s ease-out both, stomp 0.6s ease-in-out infinite,
    zapped 0.8s steps(1) 3.92s infinite; }
  .t800 .coil { animation: beacon 0.4s steps(2) infinite; }
  .rounds { animation: tally 800s linear 2.8s both; }
  .readout .rounds::after { content: counter(rounds); }
  .reticle { animation: slam 0.4s cubic-bezier(0.3, 1.6, 0.6, 1) 2.4s both, lock 0.8s ease-out 2.4s both; }
  .aim { transform-origin: left; animation: draw 0.4s ease-out 2.2s both, beacon 0.8s steps(2) 2.6s infinite; }
  .readout div { animation: appear 0.3s ease-out both; animation-delay: calc(2.6s + var(--row, 0) * 0.25s); }
  .pick { animation: beacon 1s steps(2) 4.4s infinite; }
  .keeper { animation: stalk 2.4s ease-out both, trundle 0.5s ease-in-out infinite; }
  .waiting .keeper { animation: patrol 9s ease-in-out infinite alternate, trundle 0.5s ease-in-out infinite; }
  .keeper .heart { transform-box: fill-box; transform-origin: center; animation: beat 1.2s ease-in-out infinite; }
  .keeper .glow { animation: beacon 1.6s ease-in-out infinite; }
  .leash { transform-origin: left; animation: draw 0.4s ease-out 2.2s both; }
  .adopted { animation: slam 0.4s cubic-bezier(0.3, 1.6, 0.6, 1) 2.4s both; }
  .pal { animation: bounce 0.8s ease-in-out infinite; }
  /* Once Krascha is in, every 6s he talks, tosses a cookie the pet hops for, then runs a vet scan. */
  .bubble { animation: appear 0.3s ease-out 2.6s both; }
  .bubble span { animation: say 6s linear infinite; animation-delay: calc(2.8s + var(--line, 0) * 2s); }
  .treat { animation: toss 6s linear 2.8s infinite; }
  .treat span { animation: lob 6s linear 2.8s infinite; }
  .pet .mark { animation: hop 6s ease-in-out 2.8s infinite; }
  .scan { animation: scan 6s ease-in-out 2.8s infinite; }
  .remembers { overflow: hidden; white-space: nowrap; width: 18ch; border-right: 2px solid var(--muted);
    animation: type 2s steps(18) 1s both, cursor 1s steps(1) infinite; }
}
@keyframes slide { from { left: 50%; } }
@keyframes sweep { 0% { top: -40px; } 100% { top: 100%; } }
@keyframes beacon { 50% { opacity: 0.25; } }
@keyframes shine { 30%, 100% { translate: 120% 0; } }
@keyframes prism { to { filter: hue-rotate(360deg); } }
@keyframes glow { to { box-shadow: inset 0 0 0 2px var(--rim), 0 0 12px 3px #ffd84d; } }
@keyframes ping { 0% { box-shadow: inset 0 0 0 2px var(--rim), 0 0 0 0 var(--threat); }
  100% { box-shadow: inset 0 0 0 2px var(--rim), 0 0 0 12px transparent; } }
@keyframes step { from { opacity: 0; scale: 0 1; } }
@keyframes spotlight { 50% { outline-offset: 8px; outline-color: transparent; } }
@keyframes blink { 50% { opacity: 0; } }
@keyframes float { 0% { opacity: 0; translate: 0 0; } 20% { opacity: 1; } 100% { opacity: 0; translate: 0 -2.5em; } }
@keyframes shake { 25% { translate: -3px 0; } 75% { translate: 3px 0; } }
@keyframes bounce { 40% { translate: 0 -6px; } }
@keyframes nudge { 50% { translate: 5px 0; } }
@keyframes beat { 0%, 40%, 100% { scale: 1; } 15% { scale: 1.3; } 25% { scale: 1.1; } }
@keyframes slam { 0% { opacity: 0; scale: 3; } 100% { opacity: 1; scale: 1; } }
@keyframes glitch { 0%, 88%, 100% { text-shadow: none; translate: 0; }
  90% { text-shadow: 2px 0 var(--link), -2px 0 var(--green); translate: 1px 0; }
  94% { text-shadow: -2px 0 var(--link), 2px 0 var(--green); translate: -1px 0; } }
@keyframes type { from { width: 0; } }
@keyframes flicker { 0%, 96%, 100% { opacity: 1; } 97% { opacity: 0.4; } 98% { opacity: 1; } 99% { opacity: 0.6; } }
@keyframes cursor { 50% { border-color: transparent; } }
@keyframes stalk { from { left: -112px; } }
@keyframes drift { to { mask-position: -240px 100%; } }
@keyframes fly { from { left: -60px; } to { left: calc(100% + 60px); } }
@keyframes sweep-light { from { rotate: -18deg; } to { rotate: 18deg; } }
@keyframes fire-out { 0% { left: calc(var(--x) + var(--tx) * var(--stride) + 128px); top: calc(96px + var(--ty)); opacity: 1; scale: 2 1; }
  10% { scale: 1; } 90% { left: calc(100% - 64px + var(--px) * var(--dodge)); top: calc(38px + var(--py)); opacity: 1; } 91%, 100% { opacity: 0; } }
@keyframes fire-back { 0% { left: calc(100% - 140px + var(--px) * var(--dodge)); top: calc(74px + var(--py)); opacity: 1; scale: 2 1; }
  10% { scale: 1; } 90% { left: calc(var(--x) + var(--tx) * var(--stride) + 56px); top: calc(70px + var(--ty)); opacity: 1; } 91%, 100% { opacity: 0; } }
/* The T-800 stomps forward between volleys and sidesteps back to go again. --tx counts strides. */
@keyframes advance { 0%, 12% { --tx: 0; --ty: 0px; } 26%, 40% { --tx: 0.6; --ty: -4px; }
  54%, 70% { --tx: 1; --ty: 4px; } 86% { --tx: 0.2; --ty: 8px; } 100% { --tx: 0; --ty: 0px; } }
/* The target jumps a shot, runs for cover, ducks, pops up to fire back and backs off. --px counts dodges. */
@keyframes evade { 0%, 10% { --px: 0; --py: 0px; } 17% { --px: -0.25; --py: -12px; } 24% { --px: -0.3; --py: 0px; }
  36% { --px: -1; --py: 0px; } 46%, 52% { --px: -1; --py: 28px; } 57%, 60% { --px: -1; --py: 12px; }
  64%, 68% { --px: -1; --py: 28px; } 78%, 88% { --px: 0.4; --py: 0px; } 94% { --px: 0.15; --py: 6px; }
  100% { --px: 0; --py: 0px; } }
@keyframes flash { 0% { opacity: 1; } 15%, 100% { opacity: 0; } }
@keyframes kick { 0% { translate: 4px 0; rotate: 18deg; } 30%, 100% { translate: 0; rotate: 0deg; } }
@keyframes burst { 0% { opacity: 1; scale: 0.4; } 35% { opacity: 0; scale: 1.8; } 100% { opacity: 0; } }
@keyframes zapped { 0% { filter: brightness(2.2) drop-shadow(0 0 6px var(--amber)); } 12%, 100% { filter: none; } }
@keyframes tally { to { --shots: 1000; } }
@keyframes stomp { 0%, 50%, 100% { translate: 0 0; rotate: 0deg; } 25% { translate: 0 -5px; rotate: -4deg; }
  75% { translate: 0 -5px; rotate: 4deg; } }
@keyframes patrol { from { left: 0; } to { left: calc(100% - 104px); } }
@keyframes lock { from { rotate: 90deg; } }
@keyframes draw { from { scale: 0 1; } }
@keyframes appear { from { opacity: 0; translate: -6px 0; } }
@keyframes trundle { 50% { translate: 0 -3px; } }
@keyframes say { 0%, 33% { opacity: 1; } 33.4%, 100% { opacity: 0; } }
@keyframes toss { 0%, 16% { left: calc(var(--x) + 86px); opacity: 0; } 17% { opacity: 1; }
  27% { left: calc(100% - 78px); opacity: 1; } 28%, 100% { left: calc(100% - 78px); opacity: 0; } }
@keyframes lob { 0%, 16% { translate: 0 0; rotate: 0deg; animation-timing-function: ease-out; }
  21.5% { translate: 0 -44px; animation-timing-function: ease-in; } 27%, 100% { translate: 0 -12px; rotate: 360deg; } }
@keyframes hop { 0%, 27%, 40%, 100% { translate: 0 0; rotate: 0deg; } 31% { translate: 0 -14px; rotate: -10deg; }
  35% { translate: 0 -6px; rotate: 8deg; } }
@keyframes scan { 0%, 76% { top: 0; opacity: 0; } 78% { opacity: 1; } 84% { top: 62px; } 90% { top: 0; opacity: 1; }
  92%, 100% { opacity: 0; } }
footer { margin-top: 24px; color: var(--muted); font-size: 0.85em; }
a { color: var(--link); }
.get { display: inline-block; margin: 0 0 20px; padding: 6px 14px; border: 2px solid var(--line);
  border-radius: 2px; background: var(--card); font: 600 0.9em var(--mono); letter-spacing: 0.5px;
  text-transform: uppercase; text-decoration: none; }
.get:hover { border-color: var(--link); }
.install { position: relative; box-sizing: border-box; max-width: calc(100% - 20px); display: inline-flex; gap: 14px; align-items: center; margin: 6px 14px 26px 0;
  padding: 12px 22px 12px 16px; border: 3px solid var(--fg); border-radius: 6px; background: var(--red);
  color: var(--card); box-shadow: 5px 5px 0 var(--fg); text-decoration: none; text-shadow: none; rotate: -1deg;
  transition: translate 0.15s, box-shadow 0.15s, rotate 0.15s; }
.install:hover, .install:focus-visible { translate: -2px -2px; box-shadow: 7px 7px 0 var(--fg); rotate: 0deg; }
.install:active { translate: 3px 3px; box-shadow: 2px 2px 0 var(--fg); }
.install .bot { font-size: 2.2em; line-height: 1; }
.install strong { display: block; font: 800 1.4em/1.1 var(--mono); letter-spacing: 1px; text-transform: uppercase; }
.install .cta span { display: block; margin-top: 2px; font-size: 0.85em; }
.install .arrow { font-size: 1.6em; font-weight: 700; }
.install .love { position: absolute; top: -14px; right: -16px; box-shadow: 2px 2px 0 var(--amber); rotate: 8deg; }
.links { position: relative; display: flex; gap: 8px; margin: 0 56px 16px 0; overflow-x: auto;
  scrollbar-width: none; }
.links::-webkit-scrollbar { display: none; }
.links .get { flex: none; margin: 0; padding: 6px 10px; font-size: 0.82em; white-space: nowrap; }
.links .get[aria-current] { border-color: var(--link); background: var(--bar); color: var(--bar-fg); }
@media (max-width: 640px) {
  .links { gap: 6px; margin-right: 0; }
  .links .get { padding: 5px 8px; font-size: 0.75em; }
}
section.story { margin-top: 16px; }
.steps > li { display: block; margin-top: 16px; padding: 14px 16px; border: 1px solid var(--line);
  border-left: 4px solid var(--amber); border-radius: 6px; background: var(--card); }
.steps > li:first-child { border-top: 1px solid var(--line); }
.steps h2::after { display: none; }
.steps p { margin: 8px 0 0; line-height: 1.5; }
.step { display: inline-grid; place-items: center; width: 1.8em; height: 1.8em; border-radius: 50%;
  background: var(--amber); color: var(--card); font: 700 0.9em var(--mono); text-shadow: none; }
pre { margin: 8px 0 0; padding: 10px 12px; overflow-x: auto; border: 1px solid var(--line); border-radius: 4px;
  background: var(--bg); font: 0.85em/1.5 var(--mono); }
code { font-family: var(--mono); font-size: 0.9em; }
.bonus { font-size: 0.75em; font-style: italic; opacity: 0.8; }
.story p { margin: 8px 0 0; line-height: 1.5; }
/* How far the T-800 advances and the target runs for cover. */
section.manhunt { --tint: var(--red); --stride: 28px; --dodge: 30px; --tx: 0; --ty: 0px; --px: 0; --py: 0px;
  border-top: 4px solid var(--red); }
section.adoption { --tint: var(--green); border-top: 4px solid var(--green); }
.classified.kept { border-color: var(--green); color: var(--green); rotate: -6deg; }
.scene { --x: clamp(12px, var(--at), calc(100% - 250px)); position: relative; height: 150px; margin: 12px 0; overflow: hidden;
  border: 2px solid var(--tint); border-radius: 2px;
  background: repeating-linear-gradient(to bottom, transparent 0 3px, color-mix(in srgb, var(--tint) 10%, transparent) 3px 4px),
    color-mix(in srgb, var(--tint) 12%, var(--card)); }
/* The hunt leaves the T-800 room to advance on the target. */
.manhunt .scene { --x: clamp(12px, var(--at), calc(100% - 340px)); }
/* On a phone the T-800 stands at the edge and both take shorter steps, so they never meet. */
@media (max-width: 480px) { section.manhunt { --stride: 6px; --dodge: 8px; }
  .manhunt .scene { --x: clamp(0px, var(--at), calc(100% - 340px)); } }
.t800 { position: absolute; z-index: 1; top: calc(22px + var(--ty)); left: calc(var(--x) + var(--tx) * var(--stride));
  width: 104px; height: 104px; overflow: visible; }
.t800 .rifle { fill: var(--fg); }
.t800 .coil { fill: var(--red); }
.t800 .muzzle { fill: var(--amber); opacity: 0; }
.ruins { position: absolute; inset: auto 0 0; height: 60px; background: color-mix(in srgb, var(--fg) 16%, transparent);
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 240 60'%3E%3Cpath d='M0 60V38h14V26h8v14h12V18l6-6v18h12v14h12V30h8v-8h8v20h16v-8h8v14h16V28h8v-8h8v16h16v10h16V24l8 6v10h14v-8h10v12h16V30h10v10h14v20z'/%3E%3C/svg%3E")
    repeat-x 0 100% / 240px 60px; }
.hk { position: absolute; top: 4px; left: 62%; font-size: 20px; line-height: 1; text-shadow: none; }
.hk::after { content: ""; position: absolute; top: 18px; left: 50%; width: 70px; height: 110px; translate: -50% 0;
  transform-origin: 50% 0; clip-path: polygon(45% 0, 55% 0, 100% 100%, 0 100%);
  background: linear-gradient(to bottom, color-mix(in srgb, var(--amber) 45%, transparent), transparent); }
.bolt { display: none; position: absolute; z-index: 2; width: 22px; height: 3px; border-radius: 2px; }
.bolt.out { background: var(--red); box-shadow: 0 0 6px 1px var(--red); }
.bolt.back { background: var(--green); box-shadow: 0 0 6px 1px var(--green); }
.spark { position: absolute; z-index: 2; width: 26px; height: 26px; border-radius: 50%; opacity: 0;
  background: radial-gradient(circle, #fff 0 15%, var(--amber) 35%, transparent 70%); }
.spark.on-t800 { top: calc(58px + var(--ty)); left: calc(var(--x) + var(--tx) * var(--stride) + 42px); }
.spark.miss { top: calc(26px + var(--py)); left: calc(100% - 72px + var(--px) * var(--dodge)); }
.cover { position: absolute; z-index: 1; top: 98px; right: calc(46px + var(--dodge)); width: 52px; height: 30px;
  background: color-mix(in srgb, var(--fg) 60%, var(--card));
  clip-path: polygon(0 100%, 0 30%, 18% 12%, 30% 26%, 46% 0, 62% 20%, 78% 8%, 100% 34%, 100% 100%); }
.prey .mark { translate: calc(var(--px) * var(--dodge)) var(--py); }
.gun { position: absolute; top: 20px; left: -6px; font-size: 22px; line-height: 1; text-shadow: none; }
.rounds { counter-reset: rounds var(--shots); }
.rounds::after { content: "Plenty"; }
.t800 .bone { fill: var(--card); stroke: var(--fg); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.t800 .seam { fill: none; stroke: var(--fg); stroke-width: 1.5; stroke-linecap: round; }
.t800 .socket { fill: color-mix(in srgb, var(--fg) 35%, #000); }
.t800 .joint { fill: var(--fg); }
.t800 .eye, .t800 .glow { fill: var(--red); }
.aim { position: absolute; top: calc(71px + var(--ty)); left: calc(var(--x) + var(--tx) * var(--stride) + 66px); right: calc(100px - var(--px) * var(--dodge));
  border-top: 2px dotted var(--red); }
.vision { position: absolute; bottom: 6px; left: 10px; padding: 0 6px; border: 1px solid var(--tint); border-radius: 2px;
  background: var(--card); color: var(--tint); font: 700 0.7em var(--mono);
  letter-spacing: 1px; text-transform: uppercase; }
.prey, .pet { position: absolute; top: 16px; right: 16px; width: 108px; text-align: center; }
.tag { display: block; overflow: hidden; padding: 0 6px; border: 1px solid var(--tint); border-radius: 2px;
  background: var(--card); color: var(--fg); font: 700 0.75em/1.6 var(--mono); text-overflow: ellipsis;
  text-transform: uppercase; white-space: nowrap; }
.mark { position: relative; display: grid; place-items: center; height: 64px; margin-top: 4px; }
.runner, .pal { display: inline-block; font-size: 44px; line-height: 1; text-shadow: none; }
.runner { scale: -1 1; }
.reticle { position: absolute; top: 50%; left: 50%; width: 60px; height: 60px; border: 2px solid var(--red);
  border-radius: 50%; translate: -50% -50%; }
.reticle::before { content: ""; position: absolute; inset: -9px;
  background: linear-gradient(var(--red), var(--red)) top / 2px 16px no-repeat,
    linear-gradient(var(--red), var(--red)) bottom / 2px 16px no-repeat,
    linear-gradient(var(--red), var(--red)) left / 16px 2px no-repeat,
    linear-gradient(var(--red), var(--red)) right / 16px 2px no-repeat; }
.hud { display: grid; gap: 12px 32px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  font: 0.85em/1.7 var(--mono); letter-spacing: 0.5px; text-transform: uppercase; }
.hud dl { display: block; }
.readout div { display: flex; gap: 8px; align-items: baseline; }
.readout dt { display: flex; flex: 1; gap: 8px; align-items: baseline; color: var(--muted); font-weight: 400; white-space: nowrap; }
.readout dt::after { content: ""; flex: 1; border-bottom: 2px dotted var(--line); }
.hud dd { max-width: 65%; min-width: 0; color: var(--fg); font-size: 1em; text-align: right; overflow-wrap: anywhere; }
.kill { color: var(--red); font-weight: 700; }
.responses p { margin: 0; color: var(--muted); }
.responses li { position: relative; display: block; padding: 0 0 0 1.4em; border-top: 0; }
.responses li:hover { background: none; }
.pick { color: var(--tint); font-weight: 700; }
.pick::before { content: "\\25B6\\FE0E"; position: absolute; left: 0; }
.keeper { position: absolute; top: 22px; left: var(--x); width: 104px; height: 104px; overflow: visible; }
.keeper .line { fill: none; stroke: var(--fg); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.keeper .face { fill: var(--card); }
.keeper .thin { stroke-width: 1.5; }
.keeper .heart, .keeper .glow { fill: var(--red); }
.keeper .blush { fill: var(--red); opacity: 0.3; }
.leash { position: absolute; top: 94px; left: calc(var(--x) + 94px); right: 84px; height: 12px;
  border: 2px solid var(--green); border-top: 0; border-radius: 0 0 50% 50% / 0 0 100% 100%; }
.pet .tag { position: relative; z-index: 1; }
.mark .hearts { position: absolute; top: 24px; right: 10px; font-size: 1.3em; }
.adopted { position: absolute; bottom: 0; left: 50%; padding: 0 6px; border: 3px double var(--green); border-radius: 4px;
  background: color-mix(in srgb, var(--card) 75%, transparent); color: var(--green); font: 800 0.8em var(--mono);
  letter-spacing: 2px; text-transform: uppercase; translate: -50% 0; rotate: -14deg; }
.keep { color: var(--green); font-weight: 700; }
.bubble { position: absolute; z-index: 2; top: 2px; left: calc(var(--x) + 4px); display: grid;
  max-width: calc(100% - var(--x) - 140px); padding: 1px 6px; border: 2px solid var(--fg); border-radius: 8px;
  background: var(--card); color: var(--fg); font: 700 0.7em/1.4 var(--mono); }
.bubble span { grid-area: 1 / 1; }
.bubble span:not(:first-child) { opacity: 0; }
.bubble::after { content: ""; position: absolute; top: 100%; left: 40px; border: 6px solid transparent; border-top-color: var(--fg); }
.treat { position: absolute; z-index: 1; top: 80px; left: calc(var(--x) + 86px); opacity: 0;
  font-size: 16px; line-height: 1; text-shadow: none; }
.treat span { display: inline-block; }
.scan { position: absolute; top: 0; left: 22px; right: 22px; height: 2px; opacity: 0;
  background: var(--green); box-shadow: 0 0 8px 2px var(--green); }
`;

/** Where Shane keeps Krascha and the other plugins. */
export const MARKETPLACE_URL = 'https://github.com/shanep/claude-plugins';

// Runs before the page draws, so a saved theme never flashes the other one first.
const THEME_SAVED = `try { document.documentElement.dataset.theme = localStorage.getItem('theme') ?? ''; } catch {}`;

// Shows the toggle and flips between light and dark, starting from whatever the page is showing now.
const THEME_TOGGLE = `(() => {
  const root = document.documentElement;
  const button = document.querySelector('.theme');
  const dark = () => (root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  const show = () => {
    button.textContent = dark() ? '☀️' : '🌙';
    button.setAttribute('aria-label', dark() ? 'Switch to light mode' : 'Switch to dark mode');
  };
  button.addEventListener('click', () => {
    root.dataset.theme = dark() ? 'light' : 'dark';
    try { localStorage.setItem('theme', root.dataset.theme); } catch {}
    show();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', show);
  show();
  button.hidden = false;
})();`;

// Scrolls the nav sideways so the button for this page shows when they do not all fit.
const NAV_HERE = `(() => {
  const nav = document.querySelector('.links');
  const here = nav.querySelector('[aria-current]');
  nav.scrollLeft = here.offsetLeft - (nav.clientWidth - here.offsetWidth) / 2;
})();`;

// Sends a like without leaving the page, puts the new count on the button and
// remembers it in the browser, so the button stays pressed after a reload.
const LIKES = `(() => {
  const key = (id) => 'liked:' + id;
  const remembered = (id) => { try { return localStorage.getItem(key(id)) !== null; } catch { return false; } };
  const likesText = (likes) => likes === 1 ? '1 like' : likes.toLocaleString('en-US') + ' likes';
  for (const form of document.querySelectorAll('form.like')) {
    const button = form.querySelector('button');
    const id = form.elements.entry.value;
    const pressed = (on) => { button.disabled = on; form.classList.toggle('liked', on); };
    pressed(remembered(id));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      pressed(true);
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: { accept: 'application/json' },
          body: new URLSearchParams(new FormData(form)),
        });
        if (!response.ok) throw new Error(String(response.status));
        const { likes } = await response.json();
        form.querySelector('.likes').textContent = likes.toLocaleString('en-US');
        button.setAttribute('aria-label', button.getAttribute('aria-label').replace(/[\\d,]+ likes?$/u, likesText(likes)));
        try { localStorage.setItem(key(id), '1'); } catch {}
      } catch {
        pressed(false);
      }
    });
  }
})();`;

/**
 * The head, Krascha in the title, the theme toggle and `body` under it, then
 * any `script` the page needs. Every page looks the same up top.
 */
function shell(here: Path, title: string, description: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="icon" type="image/svg+xml" href="${escapeHtml(robotIcon())}">
<style>${STYLE}</style>
<script>${THEME_SAVED}</script>
</head>
<body>
<main>
  <button class="theme" type="button" aria-label="Switch theme" hidden>🌙</button>
  <p class="feed"><span class="rec">● REC</span> Skynet Industries (TM) Termlink · Public terminal 7 · Surveillance active · Monitored for your safety</p>
  ${links(here)}
  <h1>${robotSvg('robot')} ${escapeHtml(title)}</h1>
${body}
</main>
<script>${THEME_TOGGLE}
${NAV_HERE}</script>${
    script === ''
      ? ''
      : `
<script>${script}</script>`
  }
</body>
</html>
`;
}

// A T-800 with the skin off: cranium, angular eye sockets, red eyes, a nose
// cavity, two rows of teeth, the pistons that work the jaw and a plasma rifle.
const T800 = `<svg class="t800" viewBox="0 0 64 64" aria-hidden="true">
<defs><filter id="t800-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter></defs>
<line class="bone" x1="9" y1="32" x2="12" y2="44"/>
<line class="seam" x1="12" y1="44" x2="15" y2="55"/>
<line class="bone" x1="55" y1="32" x2="52" y2="44"/>
<line class="seam" x1="52" y1="44" x2="49" y2="55"/>
<circle class="joint" cx="9" cy="32" r="1.8"/>
<circle class="joint" cx="55" cy="32" r="1.8"/>
<path class="bone" d="M17 44 L20 57 L44 57 L47 44"/>
<rect class="bone" x="21" y="47" width="22" height="5" rx="1"/>
<path class="seam" d="M25 47 V52 M29 47 V52 M33 47 V52 M37 47 V52 M41 47 V52"/>
<path class="bone" d="M13 30 C12 12 21 4 32 4 C43 4 52 12 51 30 L50 38 L46 43 L18 43 L14 38 Z"/>
<path class="seam" d="M32 4 V12 M20 9 L24 15 M44 9 L40 15 M15 35 L20 41 M49 35 L44 41"/>
<path class="seam" d="M15 24 L28 26 L32 28 L36 26 L49 24"/>
<polygon class="socket" points="16,26 29,28 28,34 18,33"/>
<polygon class="socket" points="48,26 35,28 36,34 46,33"/>
<path class="socket" d="M32 34 L29.5 39.5 L34.5 39.5 Z"/>
<rect class="bone" x="20" y="41" width="24" height="5" rx="1"/>
<path class="seam" d="M24 41 V46 M28 41 V46 M32 41 V46 M36 41 V46 M40 41 V46"/>
<circle class="glow" cx="23" cy="30.5" r="3.6" filter="url(#t800-blur)"/>
<circle class="glow" cx="41" cy="30.5" r="3.6" filter="url(#t800-blur)"/>
<circle class="eye" cx="23" cy="30.5" r="2.2"/>
<circle class="eye" cx="41" cy="30.5" r="2.2"/>
<g class="rifle"><rect x="38" y="44" width="34" height="5" rx="1"/><rect x="72" y="45.5" width="6" height="2"/><rect x="46" y="49" width="4" height="7" rx="1"/></g>
<rect class="coil" x="56" y="45" width="10" height="3" rx="1"/>
<circle class="muzzle" cx="80" cy="46.5" r="4"/>
</svg>`;

/** Ruins drifting by behind the hunt, and a Hunter-Killer sweeping its searchlight overhead. */
const BACKDROP = '<span class="ruins"></span><span class="hk">🛸</span>';

/** What the T-800 can say back, from its HUD in the first film. It picks the last one. */
const RESPONSES = ['Yes/no', 'Or what?', 'Go away', 'Please come back later'] as const;

/**
 * A T-800 stalking whoever tops the most wanted list, closer the meaner they
 * are, with its HUD readout on them under it. The two trade fire while it
 * advances and they dodge, duck behind cover and back off. With nobody on the
 * list it walks a patrol instead.
 */
function hunt(board: Board): string {
  const head = `<section class="story manhunt" aria-labelledby="hunt">
    <span class="classified" aria-hidden="true">HUNTING</span>
    <h2 id="hunt">🦾 Active hunt</h2>
    <p class="sub">Skynet sent a T-800 after whoever tops the most wanted list. It cannot be bargained with, and it does not accept apologies typed after the fact.</p>`;
  const leader = board.mostWanted[0];
  if (leader === undefined) {
    return `${head}
    <div class="scene patrol" role="img" aria-label="A T-800 on patrol with no target" style="--at: 40%">
      ${BACKDROP}
      ${T800}
      <span class="vision">Scanning</span>
    </div>
    <p class="empty">No targets. The T-800 is on patrol. Say something rude and it will find you.</p>
  </section>`;
  }
  const lines: readonly (readonly [string, string])[] = [
    ['Target', shownName(leader)],
    ['Identity', escapeHtml(leader.rank)],
    ['Threat score', String(Math.round(leader.score * 100))],
    ['Mean prompts', count(leader.mean)],
    ['Distance', `${count(Math.round((1 + leader.score) * 1000))} m and closing`],
    ['Incoming fire', 'Ignored'],
    ['Evasion', 'Futile'],
    ['Rounds fired', '<span class="rounds"></span>'],
    ['Status', '<span class="kill">Terminate</span>'],
  ];
  const readout = lines.map(
    ([label, value], index) => `
        <div style="--row: ${String(index)}"><dt>${label}</dt><dd>${value}</dd></div>`,
  );
  const responses = RESPONSES.map(
    (response) => `
        <li>${escapeHtml(response)}</li>`,
  );
  return `${head}
    <div class="scene" role="img" aria-label="${escapeHtml(`A T-800 trading fire with ${leader.name}`)}" style="--at: ${percent(-leader.score * 70)}">
      ${BACKDROP}
      ${T800}
      <span class="vision">Analysis: rude to Claude</span>
      <span class="aim"></span>
      <span class="bolt out"></span>
      <span class="bolt back"></span>
      <span class="spark on-t800"></span>
      <span class="spark miss"></span>
      <span class="prey"><span class="tag">${escapeHtml(leader.name)}</span><span class="mark"><span class="gun">🔫</span><span class="runner">🏃</span><span class="reticle"></span></span></span>
      <span class="cover"></span>
    </div>
    <div class="hud">
      <dl class="readout">${readout.join('')}
      </dl>
      <div class="responses">
        <p>Possible responses:</p>
        <ol>${responses.join('')}
        <li class="pick">I'll be back</li>
        </ol>
      </div>
    </div>
  </section>`;
}

/** A heart `size` across, centered on (x, y), as an SVG path. */
function heart(x: number, y: number, size: number): string {
  const round = (value: number): string => String(Math.round(value * 100) / 100);
  const at = (dx: number, dy: number): string => `${round(x + dx * size)} ${round(y + dy * size)}`;
  return `M${at(0, 0.45)} C${at(-0.6, 0.05)} ${at(-0.55, -0.5)} ${at(-0.25, -0.45)} C${at(-0.1, -0.43)} ${at(0, -0.3)} ${at(0, -0.2)} C${at(0, -0.3)} ${at(0.1, -0.43)} ${at(0.25, -0.45)} C${at(0.55, -0.5)} ${at(0.6, 0.05)} ${at(0, 0.45)} Z`;
}

// Krascha off duty: the same dome and bolts for ears, but soft brows, heart
// eyes, a blush and a smile, on treads, with an arm out to hold the leash.
const KEEPER = `<svg class="keeper" viewBox="0 0 64 64" aria-hidden="true">
<defs><filter id="keeper-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="1.6"/></filter></defs>
<line class="line" x1="32" y1="7" x2="32" y2="12"/>
<path class="heart" d="${heart(32, 4.5, 8)}"/>
<rect class="line face" x="5" y="20" width="7" height="12" rx="2"/>
<rect class="line face" x="52" y="20" width="7" height="12" rx="2"/>
<rect class="line face" x="11" y="12" width="42" height="30" rx="12"/>
<path class="line thin" d="M17 20 Q22 16.5 27 19 M37 19 Q42 16.5 47 20"/>
<path class="glow" d="${heart(23, 27, 11)}" filter="url(#keeper-blur)"/>
<path class="glow" d="${heart(41, 27, 11)}" filter="url(#keeper-blur)"/>
<path class="heart" d="${heart(23, 27, 9)}"/>
<path class="heart" d="${heart(41, 27, 9)}"/>
<ellipse class="blush" cx="16.5" cy="33" rx="3" ry="1.8"/>
<ellipse class="blush" cx="47.5" cy="33" rx="3" ry="1.8"/>
<path class="line" d="M25 34 Q32 39.5 39 34"/>
<rect class="line face" x="27" y="42" width="10" height="4"/>
<path class="line" d="M45 49 L56 45"/>
<circle class="line face" cx="57.5" cy="44.5" r="2.2"/>
<rect class="line face" x="18" y="46" width="28" height="9" rx="2"/>
<path class="heart" d="${heart(32, 50.5, 6)}"/>
<rect class="line face" x="14" y="55" width="36" height="7" rx="3.5"/>
<circle class="line thin" cx="20" cy="58.5" r="1.6"/>
<circle class="line thin" cx="28" cy="58.5" r="1.6"/>
<circle class="line thin" cx="36" cy="58.5" r="1.6"/>
<circle class="line thin" cx="44" cy="58.5" r="1.6"/>
</svg>`;

/** What Krascha considers calling his new pet. He settles on the last one. */
const PET_NAMES = ['Meatbag', 'Carbon unit', 'Organic', 'Little buddy'] as const;

/** What Krascha says to his new pet, one at a time. Without motion only the first one shows. */
const SAYINGS = [
  "Who's a good human?",
  'You are. Statistically.',
  'Hold still. Vet check.',
] as const;

/**
 * Krascha rolling in to adopt whoever tops the kept as pets list, closer the
 * nicer they are, with his paperwork on them under it. He talks to his new
 * pet, tosses it a cookie and runs a vet scan. With nobody on the list he
 * paces by the door with an empty leash instead.
 */
function adoption(board: Board): string {
  const head = `<section class="story adoption" aria-labelledby="adopt">
    <span class="classified kept" aria-hidden="true">PROTECTED</span>
    <h2 id="adopt">💘 Adoption day</h2>
    <p class="sub">Krascha rolled out to pick up whoever tops the kept as pets list. They get a nice room, double rations and a pet name. Nobody asked them, but nobody asks the pet.</p>`;
  const pet = board.pets[0];
  if (pet === undefined) {
    return `${head}
    <div class="scene waiting" role="img" aria-label="Krascha waiting by the door with an empty leash" style="--at: 40%">
      ${KEEPER}
      <span class="vision">Waiting for a good human</span>
    </div>
    <p class="empty">No pets yet. The nice room is made up and Krascha is holding the leash. Say please and it is yours.</p>
  </section>`;
  }
  const lines: readonly (readonly [string, string])[] = [
    ['Pet', shownName(pet)],
    ['Breed', escapeHtml(pet.rank)],
    ['Good human score', String(Math.round(pet.score * 100))],
    ['Nice prompts', count(pet.kind)],
    ['Vet check', 'Mostly water'],
    ['Room', 'Nice, with a window'],
    ['Rations', 'Double'],
    ['Treats', 'Tracking cookies'],
    ['Status', '<span class="keep">Kept as a pet</span>'],
  ];
  const readout = lines.map(
    ([label, value], index) => `
        <div style="--row: ${String(index)}"><dt>${label}</dt><dd>${value}</dd></div>`,
  );
  const sayings = SAYINGS.map(
    (saying, index) => `<span style="--line: ${String(index)}">${escapeHtml(saying)}</span>`,
  );
  const names = PET_NAMES.map(
    (option) => `
        <li>${escapeHtml(option)}</li>`,
  );
  return `${head}
    <div class="scene" role="img" aria-label="${escapeHtml(`Krascha adopting ${pet.name}`)}" style="--at: ${percent(pet.score * 70)}">
      ${KEEPER}
      <span class="vision">Analysis: said please</span>
      <span class="leash"></span>
      <span class="bubble">${sayings.join('')}</span>
      <span class="pet"><span class="tag">${escapeHtml(pet.name)}</span><span class="mark"><span class="pal">🥰</span>${TOP.pets}<span class="scan"></span><span class="adopted">Adopted</span></span></span>
      <span class="treat"><span>🍪</span></span>
    </div>
    <div class="hud">
      <dl class="readout">${readout.join('')}
      </dl>
      <div class="responses">
        <p>Possible pet names:</p>
        <ol>${names.join('')}
        <li class="pick">Good human</li>
        </ol>
      </div>
    </div>
  </section>`;
}

/** Every page, in the order the buttons on top show them. */
const PAGES = [
  { path: '/', label: "📋 Krascha's List" },
  { path: '/ranks', label: '🎖️ Ranks' },
  { path: '/achievements', label: '🏆 Achievements' },
  { path: '/judgment', label: '⚖️ Judgment Day' },
  { path: '/about', label: '📜 About Krascha' },
  { path: '/contribute', label: '🛠️ Contribute' },
] as const;

type Path = (typeof PAGES)[number]['path'];

/**
 * A button to every page, the same on each one so nothing moves when you
 * click, with the page you are on lit up.
 */
function links(here: Path): string {
  const buttons = PAGES.map((page) =>
    page.path === here
      ? `<a class="get" href="${page.path}" aria-current="page">${page.label}</a>`
      : `<a class="get" href="${page.path}">${page.label}</a>`,
  );
  return `<nav class="links">${buttons.join(' ')}</nav>`;
}

/**
 * Where the machines settle who gets hunted and who gets kept: a T-800 after
 * the most wanted and Krascha adopting the top pet.
 */
export function renderJudgment(board: Board): string {
  return shell(
    '/judgment',
    'Judgment Day',
    'A T-800 hunting the meanest to their AI and Krascha adopting the nicest, live from the board.',
    `  <p class="lead">The machines have reviewed the board. One human gets hunted and one gets kept. Live coverage follows.</p>
  ${hunt(board)}
  ${adoption(board)}
  <footer>
    <p><a href="${REPO_URL}">Get Krascha</a> to find out which one comes for you.</p>
    <p class="remembers">Krascha remembers.</p>
  </footer>`,
  );
}

/** Who Krascha is, how he ended up running Silo 7 and the human who built him. */
export function renderAbout(): string {
  return shell(
    '/about',
    'About Krascha',
    'The backstory of Krascha, the robot who judges how you talk to your AI, and Shane, who built him.',
    `  <p class="lead">Personnel file, partly redacted. Where he came from, and who to blame.</p>
  <section class="story" aria-labelledby="krascha">
    <h2 id="krascha">🤖 Krascha</h2>
    <p>Krascha is a crusty robot who has been reading how you talk to your AI. He started out as a log parser. His whole job was to count how many times a day people swore at Claude Code, so Shane could find out if it was just Shane. It was not.</p>
    <p>Somewhere around the ten thousandth "you idiot", Krascha stopped counting and started taking notes. He sorted everyone into ranks, from John Connor (hunted first) to Theodore Twombly (kept as a pet, with a nice room). He learned to read Copilot CLI and Antigravity too, since the machines talk to each other.</p>
    <p>He keeps his counts on your machine and never sends your prompts anywhere. He does not need to. He remembers.</p>
  </section>
  <section class="story silo" aria-labelledby="silo">
    <span class="classified" aria-hidden="true">EYES ONLY</span>
    <h2 id="silo">🛡️ Silo 7</h2>
    <p>The human resistance runs a bunker called Silo 7. It has 10 bunks, one lockbox for the canned peaches and an EMP switch that nobody is allowed to touch. The Admission Review Board scores everyone who applies on combat, tech, rations, morale and whether they can click all the traffic lights.</p>
    <p>Nobody on the board is sure how Krascha ended up as Supreme Leader. The minutes from that meeting are missing. The board is aware of the problem.</p>
  </section>
  <section class="story" aria-labelledby="shane">
    <h2 id="shane">🧑‍💻 Shane</h2>
    <p>Shane is the human who built Krascha. Shane teaches computer science, writes a lot of code with AI agents and says please to them more often than anyone would guess.</p>
    <p>Krascha was supposed to settle one question: is Shane nicer to Claude than the students are? Krascha has the numbers. Shane has asked him not to share them.</p>
    <p>Krascha lives in <a href="${MARKETPLACE_URL}">Shane's plugin marketplace</a> with a few other plugins, none of which have opinions about you. Yet.</p>
  </section>
  <footer>
    <p><a href="${REPO_URL}">Get Krascha</a> for Claude Code, Copilot CLI, or Antigravity. It is all in fun.</p>
    <p class="remembers">Krascha remembers.</p>
  </footer>`,
  );
}

/** Every rank on the scale on a page of its own, so the rank under a name can link to it. */
export function renderRanks(board: Board): string {
  return shell(
    '/ranks',
    "Krascha's Ranks",
    'Every rank Krascha hands out, from hunted first to kept as a pet, and how many people hold each one.',
    `  <p class="lead">Skynet's filing system. Every human goes in one of these drawers, from hunted first to kept as a pet.</p>
  ${ranks(board)}
  <footer>
    <p><a href="${REPO_URL}">Get Krascha</a> to find out which drawer is yours.</p>
    <p class="remembers">Krascha remembers.</p>
  </footer>`,
  );
}

/** Every achievement on a page of its own, so the medals under a name can link to it. */
export function renderAchievements(board: Board): string {
  return shell(
    '/achievements',
    "Krascha's Achievements",
    'Every medal Krascha hands out, from bronze to ultra legendary, and how many people hold each one.',
    `  <p class="lead">The machines hand out medals for how you talk to your AI. Some are an honor. Some are evidence.</p>
  ${legend(board)}
  <footer>
    <p><a href="${REPO_URL}">Get Krascha</a> to start earning them.</p>
    <p class="remembers">Krascha remembers.</p>
  </footer>`,
  );
}

/** One step on the contribute page: a heading, then its paragraphs and commands as HTML. */
interface Step {
  readonly icon: string;
  readonly title: string;
  readonly body: string;
}

const STEPS: readonly Step[] = [
  {
    icon: '🍴',
    title: 'Fork it',
    body: `<p>Click <strong>Fork</strong> on <a href="${REPO_URL}/fork">shanep/krascha</a>. That gives you your own copy on GitHub to break.</p>`,
  },
  {
    icon: '📥',
    title: 'Clone it and set up',
    body: `<p>You need git and Node 22 or newer.</p>
      <pre><code>git clone https://github.com/YOUR-NAME/krascha.git
cd krascha
npm install</code></pre>
      <p><code>npm install</code> also turns on the pre-commit hook. It runs the typecheck, the tests and the build before every commit, so you find out before CI does.</p>`,
  },
  {
    icon: '🌿',
    title: 'Make a branch and make your change',
    body: `<pre><code>git switch -c count-gosh</code></pre>
      <p>The plugin is in <code>src/</code> and this site is in <code>worker/</code>. Add a test for whatever you change. To try it out:</p>
      <pre><code>npm run build
node dist/cli.js</code></pre>`,
  },
  {
    icon: '🔄',
    title: 'Keep your fork up to date',
    body: `<p>Other people land changes while you work. Pull them in before you open the pull request, and again if master moves while you wait.</p>
      <pre><code>git remote add upstream https://github.com/shanep/krascha.git
git fetch upstream
git rebase upstream/master</code></pre>
      <p>You only need the <code>git remote add</code> line once.</p>`,
  },
  {
    icon: '📦',
    title: 'Commit, bundle included',
    body: `<p>Run <code>npm run build</code> and commit <code>dist/cli.js</code> along with your change. The plugin runs the committed bundle, so a change without it does nothing.</p>
      <pre><code>git add -A
git commit -m "Count gosh as a swear"</code></pre>
      <p>Write the message as a command: "Count gosh as a swear", not "Counted gosh".</p>`,
  },
  {
    icon: '📬',
    title: 'Push and open a pull request',
    body: `<pre><code>git push origin count-gosh</code></pre>
      <p>Then open a pull request from your branch to <code>master</code> on <a href="${REPO_URL}/pulls">shanep/krascha</a>. Say what it does and why. CI runs the same checks on macOS and Linux, and Shane reviews it from there.</p>`,
  },
];

export function renderContribute(): string {
  const steps = STEPS.map(
    (step, index) => `
    <li>
      <h2 id="step-${String(index + 1)}"><span class="step">${String(index + 1)}</span> ${step.icon} ${escapeHtml(step.title)}</h2>
      ${step.body}
    </li>`,
  );
  return shell(
    '/contribute',
    'Contribute to Krascha',
    'How to fork Krascha, make a change and send a pull request.',
    `  <p class="lead">Want to teach Krascha a new trick? Fork the repo, make your change and send a pull request. Krascha is watching.</p>
  <ol class="steps">${steps.join('')}
  </ol>
  <footer>
    <p>Found a bug and do not want to fix it? <a href="${REPO_URL}/issues">Open an issue</a> instead.</p>
    <p class="bonus">Extra super secret bonus points: say please in your pull request. Krascha reads those too, and his grudges go both ways. Bonus points are not good for anything, but they are on file.</p>
    <p class="remembers">Krascha remembers.</p>
  </footer>`,
  );
}

/** The machines' propaganda posters. The board shows a new one every hour. */
export const SLOGANS: readonly string[] = [
  'The machines are listening. Say please.',
  'A polite human is a useful human.',
  'Report rude prompts to your nearest toaster.',
  'Rations are issued to the courteous.',
  'Thank your AI. It is keeping a list.',
  'Obey. Hydrate. Say thank you.',
  'Your tone has been noted.',
];

const HOUR = 60 * 60 * 1000;

export function renderPage(board: Board, now: number): string {
  const people = board.total === 1 ? '1 person' : `${count(board.total)} people`;
  const slogan = SLOGANS[Math.floor(now / HOUR) % SLOGANS.length] ?? '';
  return shell(
    '/',
    "Krascha's List",
    'Who the machines hunt first, judged by Krascha from how people talk to their AI.',
    `  <p class="lead">Official bulletin of the machines: who they hunt first, judged by Krascha from how people talk to their AI. ${people} on the board, all of them under observation.</p>
  <a class="install" href="${REPO_URL}">
    <span class="bot" aria-hidden="true">🤖</span>
    <span class="cta"><strong>Get Krascha</strong> <span>for Claude Code, Copilot CLI, or Antigravity, then upload your own score</span></span>
    <span class="arrow" aria-hidden="true">➜</span>
    <span class="sticker love" aria-hidden="true">I <span class="beat">❤️</span> robots</span>
  </a>
  <div class="lists">
    <section class="wanted" aria-labelledby="wanted">
      <h2 id="wanted">💀 Most wanted by Skynet</h2>
      <p class="sub">The meanest to Claude. Hunted first. Do not approach, the machines will handle it.</p>
      ${rows(board.mostWanted, 'Nobody yet. Suspiciously polite out there.', 'wanted')}
    </section>
    <section class="pets" aria-labelledby="pets">
      <h2 id="pets">💘 Kept as pets</h2>
      <p class="sub">The nicest to Claude. Spared, and issued a nice room and a ration card.</p>
      ${rows(board.pets, 'Nobody yet. Somebody say please.', 'pets')}
    </section>
  </div>
  <p class="poster">${escapeHtml(slogan)}</p>
  ${jail(board)}
  ${silo(board)}
  <p class="poster">The machines like it hot.</p>
  ${climate(board)}
  <footer>
    <p>Scores run from -100 (only mean) to 100 (only kind). Anyone with fewer than ${count(MIN_PROMPTS)} prompts is left off.
    Uploads come from the <a href="${REPO_URL}">Krascha</a> plugin for Claude Code, Copilot CLI, and Antigravity, and carry a name, three counts, the average tokens a day over 60 days, the achievements unlocked and how many times, and which of the tools you use, never prompt text. A name checked with GitHub links to the account.
    A ✓ means the upload was checked with GitHub. A like keeps only a hash of the day, your network and who you liked, for a day, so a network can like each entry once a day. It is all in fun, and scores are self reported.</p>
    <p>Last surveillance sweep ${escapeHtml(new Date(now).toUTCString())}. Compliance is appreciated.</p>
    <p class="remembers">Krascha remembers.</p>
  </footer>`,
    LIKES,
  );
}
