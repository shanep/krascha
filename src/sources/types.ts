// Where an agent keeps what its user typed. Krascha reads every agent's
// prompt files through this one shape.

import type { Prompt } from '../reputation/prompts.js';
import type { ToolId } from '../shared/tools.js';

/** A file that holds prompts the user typed. */
export interface PromptFile {
  readonly path: string;
  /** Null for a file that is not there right now, such as a history file not written yet. */
  readonly stamp: { readonly mtimeMs: number; readonly size: number } | null;
  /**
   * A session's own file, which names the session, or a history file that
   * keeps prompts from many sessions after their transcripts are gone.
   */
  readonly kind: 'transcript' | 'history';
  /** The session a transcript belongs to. Null for a history file. */
  readonly sessionId: string | null;
  /** The agent whose file this is. */
  readonly tool?: ToolId;
}

/** What one prompt file holds. */
export interface PromptFileRead {
  readonly prompts: readonly Prompt[];
  /** The session's title, for a transcript that has one. */
  readonly title: string | null;
  /** Tokens the session used, by local date, for a transcript that records them. */
  readonly tokensByDay?: Readonly<Record<string, number>>;
}

/** Where an agent keeps what the user typed. */
export interface UserPrompts {
  /** Every prompt file. A history file that is missing is still listed, with a null stamp, so its old stamp is kept. */
  files: () => Promise<readonly PromptFile[]>;
  /** Reads one file. Called only when its stamp changed since the last scan. */
  read: (file: PromptFile) => Promise<PromptFileRead>;
}
