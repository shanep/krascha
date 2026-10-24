// The agents Krascha reads, by the names the board shows. A prompt's id says
// which one it was typed into, so the CLI can tell the board what you use
// without sending anything else.

export const TOOLS = [
  { id: 'claude', name: 'Claude Code' },
  { id: 'copilot', name: 'Copilot CLI' },
  { id: 'antigravity', name: 'Antigravity' },
] as const;

export type ToolId = (typeof TOOLS)[number]['id'];

/** Copilot CLI prompt ids start with this. Claude Code's start with t: or h:. */
export const COPILOT_PREFIX = 'c:';
/** Antigravity prompt ids start with this. */
export const ANTIGRAVITY_PREFIX = 'a:';

export function toolOf(promptId: string): ToolId {
  if (promptId.startsWith(COPILOT_PREFIX)) {
    return 'copilot';
  }
  if (promptId.startsWith(ANTIGRAVITY_PREFIX)) {
    return 'antigravity';
  }
  return 'claude';
}

/** The ids Krascha knows, once each and in list order, so a retired or made up one just stops showing. */
export function knownTools(ids: readonly string[]): ToolId[] {
  return TOOLS.filter((tool) => ids.includes(tool.id)).map((tool) => tool.id);
}

/** "Claude Code", "Copilot CLI", "Antigravity", or combined names. Empty for an upload that did not say. */
export function toolNames(ids: readonly string[]): string {
  const known = new Set<string>(knownTools(ids));
  const names = TOOLS.filter((tool) => known.has(tool.id)).map((tool) => tool.name);
  if (names.length <= 1) {
    return names[0] ?? '';
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
