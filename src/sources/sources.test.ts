import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { scanInto } from '../reputation/scan.js';
import { emptyIndex } from '../reputation/store.js';
import { dayOf } from '../reputation/summarize.js';

import { claudeDir, claudeTitle } from './claude.js';
import { copilotDir, copilotTitle, copilotUserPrompts } from './copilot.js';
import { antigravityDir, antigravityTitle, antigravityUserPrompts } from './antigravity.js';

async function tempDir(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'krascha-sources-'));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function event(type: string, id: string, data: object): string {
  return JSON.stringify({ type, id, timestamp: '2026-09-24T15:55:50.092Z', parentId: null, data });
}

describe('claudeTitle', () => {
  it('prefers the rename, then the generated title, then the last prompt', () => {
    const last = JSON.stringify({ type: 'last-prompt', lastPrompt: 'fix   the\nbuild' });
    const ai = JSON.stringify({ type: 'ai-title', aiTitle: 'Fix the build' });
    const custom = JSON.stringify({ type: 'custom-title', customTitle: 'My build' });
    expect(claudeTitle([last])).toBe('fix the build');
    expect(claudeTitle([last, ai])).toBe('Fix the build');
    expect(claudeTitle([custom, last, ai])).toBe('My build');
    expect(claudeTitle(['not json', '{}'])).toBeNull();
  });

  it('cuts a long title', () => {
    const line = JSON.stringify({ type: 'ai-title', aiTitle: 'x'.repeat(200) });
    expect(claudeTitle([line])).toHaveLength(120);
  });
});

describe('copilotTitle', () => {
  it('reads the name line of workspace.yaml', () => {
    expect(copilotTitle('id: 1\nname: Fix the build\ncwd: /x\n')).toBe('Fix the build');
    expect(copilotTitle("name: 'Quoted name'\n")).toBe('Quoted name');
    expect(copilotTitle('name:\n')).toBeNull();
    expect(copilotTitle(null)).toBeNull();
  });
});

describe('agent folders', () => {
  it('honors CLAUDE_CONFIG_DIR, COPILOT_HOME, ANTIGRAVITY_HOME and GEMINI_HOME', () => {
    expect(claudeDir('/home/me', {})).toBe(path.join('/home/me', '.claude'));
    expect(claudeDir('/home/me', { CLAUDE_CONFIG_DIR: '/c' })).toBe('/c');
    expect(copilotDir('/home/me', {})).toBe(path.join('/home/me', '.copilot'));
    expect(copilotDir('/home/me', { COPILOT_HOME: '/p' })).toBe('/p');
    expect(antigravityDir('/home/me', {})).toBe(path.join('/home/me', '.gemini'));
    expect(antigravityDir('/home/me', { ANTIGRAVITY_HOME: '/a' })).toBe('/a');
    expect(antigravityDir('/home/me', { GEMINI_HOME: '/g' })).toBe('/g');
  });
});

describe('copilotUserPrompts', () => {
  it('counts what was typed in each session and skips commands and other events', async () => {
    const root = await tempDir();
    const session = path.join(root, 'session-state', 's1');
    await mkdir(session, { recursive: true });
    await mkdir(path.join(root, 'session-state', 'empty'));
    await writeFile(path.join(root, 'session-state', 'stray.txt'), 'x');
    const lines = [
      event('session.start', 'e0', { sessionId: 's1' }),
      event('user.message', 'e1', { content: 'thanks, you rock', transformedContent: 'other' }),
      event('user.message', 'e2', { content: '/model gpt' }),
      event('assistant.message', 'e3', { content: 'you idiot' }),
      event('user.message', 'e4', { content: 'what is wrong with you' }),
      'not json',
    ];
    await writeFile(path.join(session, 'events.jsonl'), `${lines.join('\n')}\n`);
    await writeFile(path.join(session, 'workspace.yaml'), 'name: Copilot work\n');
    const index = emptyIndex();
    const result = await scanInto(index, { sources: [copilotUserPrompts(root)], now: 1 });
    expect(result.newPrompts).toBe(2);
    expect([...index.prompts.keys()]).toStrictEqual(['c:e1', 'c:e4']);
    expect(index.prompts.get('c:e1')).toStrictEqual({
      sessionId: 's1',
      at: Date.parse('2026-09-24T15:55:50.092Z'),
      print: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(index.kind.has('c:e1')).toBe(true);
    expect(index.hits.get('c:e4')?.target).toBe('agent');
    expect(index.sessions.get('s1')).toStrictEqual({
      source: 'transcript',
      title: 'Copilot work',
      tool: 'copilot',
    });
  });

  it('counts the tokens every model call used, cached ones once', async () => {
    const root = await tempDir();
    const session = path.join(root, 'session-state', 's1');
    await mkdir(session, { recursive: true });
    const usage = (inputTokens: number, outputTokens: number): object => ({
      usage: { model: 'gpt', inputTokens, outputTokens, cacheReadTokens: inputTokens - 1 },
    });
    const lines = [
      event('session.usage_record', 'u1', usage(18_551, 86)),
      event('session.usage_record', 'u2', usage(19_145, 492)),
      event('session.usage_record', 'u3', { usage: { inputTokens: 'lots' } }),
      event('session.shutdown', 'u4', { modelMetrics: { gpt: { usage: usage(1, 1) } } }),
    ];
    await writeFile(path.join(session, 'events.jsonl'), `${lines.join('\n')}\n`);
    const index = emptyIndex();
    await scanInto(index, { sources: [copilotUserPrompts(root)], now: 1 });
    const day = dayOf(Date.parse('2026-09-24T15:55:50.092Z'));
    expect(index.tokens.get('s1')).toStrictEqual({ [day]: 38_274 });
  });

  it('finds nothing when Copilot was never run', async () => {
    const result = await scanInto(emptyIndex(), {
      sources: [copilotUserPrompts('/nope')],
      now: 1,
    });
    expect(result.filesRead).toBe(0);
  });
});

describe('antigravityTitle', () => {
  it('collapses whitespace and cuts long titles', () => {
    expect(antigravityTitle('  Fix   the \n build  ')).toBe('Fix the build');
    expect(antigravityTitle('x'.repeat(200))).toHaveLength(120);
    expect(antigravityTitle('')).toBeNull();
    expect(antigravityTitle('   ')).toBeNull();
    expect(antigravityTitle(null)).toBeNull();
  });
});

describe('antigravityUserPrompts', () => {
  it('counts what was typed in each session and skips commands and other steps', async () => {
    const root = await tempDir();
    const session = path.join(root, 'antigravity-cli', 'brain', 'g1');
    const logsDir = path.join(session, '.system_generated', 'logs');
    await mkdir(logsDir, { recursive: true });
    await mkdir(path.join(root, 'antigravity-cli', 'brain', 'empty'));
    const cacheDir = path.join(root, 'antigravity-cli', 'cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      path.join(cacheDir, 'conversation_metadata.json'),
      JSON.stringify({
        conversations: {
          g1: { summary: { Title: 'Reliable UDP Project' } },
        },
      }),
    );
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-09-24T15:55:50.092Z',
        content: '<USER_REQUEST>\nthanks, you rock\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-09-24T15:56:50.092Z',
        content: '<USER_REQUEST>\n/model gemini-pro\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-24T15:57:00.000Z',
        content: 'you idiot',
      }),
      JSON.stringify({
        step_index: 3,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        created_at: '2026-09-24T15:57:50.092Z',
        content: '<USER_REQUEST>\nwhat is wrong with you\n</USER_REQUEST>',
      }),
      'not json',
    ];
    await writeFile(path.join(logsDir, 'transcript.jsonl'), `${lines.join('\n')}\n`);
    const index = emptyIndex();
    const result = await scanInto(index, { sources: [antigravityUserPrompts(root)], now: 1 });
    expect(result.newPrompts).toBe(2);
    expect([...index.prompts.keys()]).toStrictEqual(['a:g1:0', 'a:g1:3']);
    expect(index.prompts.get('a:g1:0')).toStrictEqual({
      sessionId: 'g1',
      at: Date.parse('2026-09-24T15:55:50.092Z'),
      print: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(index.kind.has('a:g1:0')).toBe(true);
    expect(index.hits.get('a:g1:3')?.target).toBe('agent');
    expect(index.sessions.get('g1')).toStrictEqual({
      source: 'transcript',
      title: 'Reliable UDP Project',
      tool: 'antigravity',
    });
  });

  it('counts tokens used from PLANNER_RESPONSE steps', async () => {
    const root = await tempDir();
    const session = path.join(root, 'brain', 'g1');
    await mkdir(session, { recursive: true });
    const lines = [
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-24T15:55:50.092Z',
        input_tokens: 10_000,
        cache_read_tokens: 5000,
        output_tokens: 500,
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        created_at: '2026-09-24T16:00:00.000Z',
        input_tokens: 20_000,
        cache_read_tokens: 10_000,
        output_tokens: 1000,
      }),
    ];
    await writeFile(path.join(session, 'transcript.jsonl'), `${lines.join('\n')}\n`);
    const index = emptyIndex();
    await scanInto(index, { sources: [antigravityUserPrompts(root)], now: 1 });
    const day = dayOf(Date.parse('2026-09-24T15:55:50.092Z'));
    expect(index.tokens.get('g1')).toStrictEqual({ [day]: 46_500 });
  });

  it('finds nothing when Antigravity was never run', async () => {
    const result = await scanInto(emptyIndex(), {
      sources: [antigravityUserPrompts('/nope')],
      now: 1,
    });
    expect(result.filesRead).toBe(0);
  });
});
