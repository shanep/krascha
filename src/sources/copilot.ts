// The prompts a person typed to GitHub Copilot CLI, and the tokens it used.
// Each session has a folder under ~/.copilot/session-state (or COPILOT_HOME)
// holding events.jsonl, one event per line. What the person typed is a
// user.message event's data.content; data.transformedContent is what the model
// was sent. Every model call leaves a session.usage_record event. Its
// inputTokens already count the cached tokens, so input plus output is all of
// it. Checked against Copilot CLI 1.0.102.

import path from 'node:path';

import { z } from 'zod';

import { readAllLines, readOptional } from '../files.js';
import type { Prompt } from '../reputation/prompts.js';
import { typedText } from '../reputation/prompts.js';
import { dayOf } from '../reputation/summarize.js';
import { COPILOT_PREFIX } from '../shared/tools.js';

import { shortTitle } from './claude.js';
import { listDir, stampOf } from './listing.js';
import type { PromptFile, PromptFileRead, UserPrompts } from './types.js';

const EVENTS_FILE = 'events.jsonl';
const WORKSPACE_FILE = 'workspace.yaml';

/** ~/.copilot, or COPILOT_HOME. */
export function copilotDir(home: string, env: NodeJS.ProcessEnv): string {
  return env['COPILOT_HOME'] ?? path.join(home, '.copilot');
}

const messageSchema = z.object({
  type: z.literal('user.message'),
  id: z.string().min(1),
  timestamp: z.string(),
  data: z.object({ content: z.string() }),
});

const usageSchema = z.object({
  type: z.literal('session.usage_record'),
  timestamp: z.string(),
  data: z.object({
    usage: z.object({
      inputTokens: z.number().nonnegative(),
      outputTokens: z.number().nonnegative(),
    }),
  }),
});

function parseJson(line: string): unknown {
  try {
    const value: unknown = JSON.parse(line);
    return value;
  } catch {
    return null;
  }
}

/** Typed prompts in one session's events.jsonl. Slash commands and shell lines are left out. */
export function copilotPrompts(lines: readonly string[], file: PromptFile): Prompt[] {
  const prompts: Prompt[] = [];
  for (const line of lines) {
    const prompt = copilotPrompt(line, file);
    if (prompt !== null) {
      prompts.push(prompt);
    }
  }
  return prompts;
}

function copilotPrompt(line: string, file: PromptFile): Prompt | null {
  const parsed = line.includes('"user.message"') ? messageSchema.safeParse(parseJson(line)) : null;
  const record = parsed?.success === true ? parsed.data : null;
  const text = record === null ? null : typedText(record.data.content);
  if (record === null || text === null || text.startsWith('/') || text.startsWith('!')) {
    return null;
  }
  const at = Date.parse(record.timestamp);
  return {
    id: `${COPILOT_PREFIX}${record.id}`,
    sessionId: file.sessionId ?? '',
    at: Number.isNaN(at) ? (file.stamp?.mtimeMs ?? 0) : at,
    text,
  };
}

/** A model call's tokens and the local date it was made, or null for any other line. */
function copilotUsage(line: string, file: PromptFile): { day: string; tokens: number } | null {
  const parsed = line.includes('"session.usage_record"')
    ? usageSchema.safeParse(parseJson(line))
    : null;
  if (parsed?.success !== true) {
    return null;
  }
  const { timestamp, data } = parsed.data;
  const at = Date.parse(timestamp);
  return {
    day: dayOf(Number.isNaN(at) ? (file.stamp?.mtimeMs ?? 0) : at),
    tokens: data.usage.inputTokens + data.usage.outputTokens,
  };
}

const NAME_LINE = /^name:[ \t]*(.*)$/mu;

/** The session's name from workspace.yaml, which is flat key: value lines. */
export function copilotTitle(yaml: string | null): string | null {
  const raw = yaml?.match(NAME_LINE)?.[1]?.trim() ?? '';
  const unquoted = /^(['"]).*\1$/u.test(raw) ? raw.slice(1, -1) : raw;
  return unquoted === '' ? null : shortTitle(unquoted);
}

async function read(file: PromptFile): Promise<PromptFileRead> {
  const prompts: Prompt[] = [];
  const tokensByDay: Record<string, number> = {};
  for await (const line of readAllLines(file.path)) {
    const prompt = copilotPrompt(line, file);
    if (prompt !== null) {
      prompts.push(prompt);
    }
    const usage = copilotUsage(line, file);
    if (usage !== null) {
      tokensByDay[usage.day] = (tokensByDay[usage.day] ?? 0) + usage.tokens;
    }
  }
  const yaml = await readOptional(path.join(path.dirname(file.path), WORKSPACE_FILE));
  return { prompts, title: copilotTitle(yaml), tokensByDay };
}

export function copilotUserPrompts(homeDir: string): UserPrompts {
  return {
    files: async (): Promise<PromptFile[]> => {
      const sessionsDir = path.join(homeDir, 'session-state');
      const files: PromptFile[] = [];
      for (const entry of await listDir(sessionsDir)) {
        const file = path.join(sessionsDir, entry.name, EVENTS_FILE);
        const stamp = entry.isDirectory() ? await stampOf(file) : null;
        if (stamp !== null) {
          files.push({ path: file, stamp, kind: 'transcript', sessionId: entry.name, tool: 'copilot' });
        }
      }
      return files;
    },
    read,
  };
}
