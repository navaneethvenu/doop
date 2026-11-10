/**
 * The Codex CLI ("Luna") installed on the same machine the server runs on:
 * the user's own ChatGPT sign-in lives in the CLI, so there is nothing to
 * connect — the moment the binary and its auth exist, the Doop Agent can run
 * on it. The chat the user types into IS the CLI session: the first message
 * starts `codex exec`, follow-ups resume the same thread, and the canvas
 * tools reach it through the doop MCP server the user already added to the
 * CLI's own config.
 *
 * The model menu is a single free-form id: the CLI knows what its account
 * can run, and a wrong id fails the run with the CLI's own error. Keep the
 * shape rule strict enough that the id stays a safe bare CLI argument.
 */
export const DEFAULT_CODEX_MODEL = 'gpt-5.6-luna'

/** A model id safe to pass as a bare CLI argument (no spaces or shell food). */
export const CODEX_MODEL_ID = /^[a-z0-9][a-z0-9.-]{0,98}$/i

export function isCodexModel(value: unknown): value is string {
  return typeof value === 'string' && CODEX_MODEL_ID.test(value)
}

/** `-c model_reasoning_effort=...`: how hard it thinks per turn. */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
export type CodexEffort = (typeof CODEX_EFFORTS)[number]

/* Luna's standing setting: low unless the person says otherwise. */
export const DEFAULT_CODEX_EFFORT: CodexEffort = 'low'

export const CODEX_EFFORT_OPTIONS: { id: CodexEffort; name: string; blurb: string }[] = [
  { id: 'low', name: 'Low', blurb: 'Fastest — fine for small, mechanical edits' },
  { id: 'medium', name: 'Medium', blurb: 'A good everyday setting for design work' },
  { id: 'high', name: 'High', blurb: 'More thinking per turn — for layouts that have to be right' },
  { id: 'xhigh', name: 'Extra high', blurb: 'Deeper still; slower turns' },
]

export function isCodexEffort(value: unknown): value is CodexEffort {
  return CODEX_EFFORTS.some((effort) => effort === value)
}

export interface CodexRunPreference {
  model: string
  effort: CodexEffort
}
