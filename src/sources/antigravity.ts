// The prompts a person typed to Antigravity (Gemini), and the tokens it used.
// Session transcripts live under ~/.gemini/{antigravity-cli,antigravity,antigravity-ide}/brain/<session-id>/
// as .system_generated/logs/transcript.jsonl (or transcript.jsonl). What the person typed is in
// USER_INPUT steps with source USER_EXPLICIT. Model calls leave PLANNER_RESPONSE steps
// with input_tokens, cache_read_tokens, and output_tokens.

import path from 'node:path';

import { readAllLines, readJsonOrUndefined } from '../files.js';
import type { Prompt } from '../reputation/prompts.js';
import { typedText } from '../reputation/prompts.js';
import { dayOf } from '../reputation/summarize.js';
import { ANTIGRAVITY_PREFIX } from '../shared/tools.js';

import { shortTitle } from './claude.js';
import { listDir, stampOf } from './listing.js';
import type { PromptFile, PromptFileRead, UserPrompts } from './types.js';

const TRANSCRIPT_PRIMARY = path.join('.system_generated', 'logs', 'transcript.jsonl');
const TRANSCRIPT_FALLBACK = 'transcript.jsonl';
const USER_REQUEST_TAG = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/u;

/** ~/.gemini, or ANTIGRAVITY_HOME or GEMINI_HOME. */
export function antigravityDir(home: string, env: NodeJS.ProcessEnv): string {
  return env['ANTIGRAVITY_HOME'] ?? env['GEMINI_HOME'] ?? path.join(home, '.gemini');
}

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Extracts what the user typed between <USER_REQUEST> tags, or the whole prompt. */
export function extractAntigravityPromptText(rawContent: string): string | null {
  const match = USER_REQUEST_TAG.exec(rawContent);
  const matchedText = match?.[1];
  const text = (matchedText !== undefined ? matchedText : rawContent).trim();
  const cleaned = typedText(text);
  if (cleaned === null || cleaned.startsWith('/') || cleaned.startsWith('!')) {
    return null;
  }
  return cleaned;
}

export function antigravityPrompt(
  line: string,
  file: PromptFile,
  promptIndex: number,
): Prompt | null {
  if (!line.includes('"USER_INPUT"')) {
    return null;
  }
  const parsed = parseJson(line);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const type = Reflect.get(parsed, 'type');
  const source = Reflect.get(parsed, 'source');
  if (type !== 'USER_INPUT' || source !== 'USER_EXPLICIT') {
    return null;
  }
  const content = Reflect.get(parsed, 'content');
  if (typeof content !== 'string') {
    return null;
  }
  const text = extractAntigravityPromptText(content);
  if (text === null) {
    return null;
  }
  const createdAt = Reflect.get(parsed, 'created_at');
  const at = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  const stepIdx = Reflect.get(parsed, 'step_index');
  const step = typeof stepIdx === 'number' ? stepIdx : promptIndex;
  return {
    id: `${ANTIGRAVITY_PREFIX}${file.sessionId ?? ''}:${String(step)}`,
    sessionId: file.sessionId ?? '',
    at: Number.isNaN(at) ? (file.stamp?.mtimeMs ?? 0) : at,
    text,
  };
}

/** A model call's tokens and the local date it was made, or null for other steps. */
export function antigravityUsage(
  line: string,
  file: PromptFile,
): { day: string; tokens: number } | null {
  if (!line.includes('"PLANNER_RESPONSE"')) {
    return null;
  }
  const parsed = parseJson(line);
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  if (Reflect.get(parsed, 'type') !== 'PLANNER_RESPONSE') {
    return null;
  }
  // In Antigravity transcripts, input_tokens is only the uncached prompt tokens,
  // while cache_read_tokens is the cached prompt tokens. They do not overlap
  // (input_tokens can be smaller than cache_read_tokens), so both must be added
  // to get the total prompt tokens.
  const inputTokens = Reflect.get(parsed, 'input_tokens');
  const cacheReadTokens = Reflect.get(parsed, 'cache_read_tokens');
  const outputTokens = Reflect.get(parsed, 'output_tokens');
  const total =
    (typeof inputTokens === 'number' && inputTokens > 0 ? inputTokens : 0) +
    (typeof cacheReadTokens === 'number' && cacheReadTokens > 0 ? cacheReadTokens : 0) +
    (typeof outputTokens === 'number' && outputTokens > 0 ? outputTokens : 0);
  if (total === 0) {
    return null;
  }
  const createdAt = Reflect.get(parsed, 'created_at');
  const at = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  return {
    day: dayOf(Number.isNaN(at) ? (file.stamp?.mtimeMs ?? 0) : at),
    tokens: total,
  };
}

export function antigravityTitle(title: string | null | undefined): string | null {
  if (title === null || title === undefined || title.trim() === '') {
    return null;
  }
  return shortTitle(title.trim());
}

async function loadMetadataTitles(geminiDir: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const candidates = [
    path.join(geminiDir, 'antigravity-cli', 'cache', 'conversation_metadata.json'),
    path.join(geminiDir, 'antigravity', 'cache', 'conversation_metadata.json'),
    path.join(geminiDir, 'antigravity-ide', 'cache', 'conversation_metadata.json'),
    path.join(geminiDir, 'cache', 'conversation_metadata.json'),
  ];
  for (const candidate of candidates) {
    const data = await readJsonOrUndefined(candidate);
    if (typeof data === 'object' && data !== null) {
      const convos = Reflect.get(data, 'conversations');
      if (typeof convos === 'object' && convos !== null) {
        for (const [id, val] of Object.entries(convos)) {
          if (typeof val === 'object' && val !== null) {
            const summary = Reflect.get(val, 'summary');
            if (typeof summary === 'object' && summary !== null) {
              const title = Reflect.get(summary, 'Title');
              if (typeof title === 'string' && title.trim() !== '') {
                titles.set(id, title.trim());
              }
            }
          }
        }
      }
    }
  }
  return titles;
}

async function read(
  file: PromptFile,
  metadataTitles: Map<string, string>,
): Promise<PromptFileRead> {
  const prompts: Prompt[] = [];
  const tokensByDay: Record<string, number> = {};
  let promptIdx = 0;
  for await (const line of readAllLines(file.path)) {
    const prompt = antigravityPrompt(line, file, promptIdx);
    if (prompt !== null) {
      prompts.push(prompt);
      promptIdx += 1;
    }
    const usage = antigravityUsage(line, file);
    if (usage !== null) {
      tokensByDay[usage.day] = (tokensByDay[usage.day] ?? 0) + usage.tokens;
    }
  }
  const rawTitle = file.sessionId !== null ? metadataTitles.get(file.sessionId) : null;
  return {
    prompts,
    title: antigravityTitle(rawTitle),
    tokensByDay,
  };
}

export function antigravityUserPrompts(geminiDir: string): UserPrompts {
  let cachedTitles: Map<string, string> | null = null;

  return {
    files: async (): Promise<PromptFile[]> => {
      const candidates = [
        path.join(geminiDir, 'antigravity-cli', 'brain'),
        path.join(geminiDir, 'antigravity', 'brain'),
        path.join(geminiDir, 'antigravity-ide', 'brain'),
        path.join(geminiDir, 'brain'),
      ];
      const files: PromptFile[] = [];
      const seen = new Set<string>();

      for (const brainDir of candidates) {
        for (const entry of await listDir(brainDir)) {
          if (!entry.isDirectory()) {
            continue;
          }
          const sessionPath = path.join(brainDir, entry.name);
          const primary = path.join(sessionPath, TRANSCRIPT_PRIMARY);
          const fallback = path.join(sessionPath, TRANSCRIPT_FALLBACK);
          let target = primary;
          let stamp = await stampOf(primary);
          if (stamp === null) {
            stamp = await stampOf(fallback);
            if (stamp !== null) {
              target = fallback;
            }
          }
          if (stamp !== null && !seen.has(target)) {
            seen.add(target);
            files.push({
              path: target,
              stamp,
              kind: 'transcript',
              sessionId: entry.name,
              tool: 'antigravity',
            });
          }
        }
      }
      return files;
    },
    read: async (file: PromptFile): Promise<PromptFileRead> => {
      if (cachedTitles === null) {
        cachedTitles = await loadMetadataTitles(geminiDir);
      }
      return await read(file, cachedTitles);
    },
  };
}
