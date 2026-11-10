/**
 * The Codex CLI ("Luna") runner: drives the `codex` binary installed and
 * signed in on the server machine itself, the same way Paseo and T3 Code do —
 * one long-lived `codex app-server` child per user, spoken to over
 * newline-delimited JSON-RPC on stdio (initialize, thread/start,
 * thread/resume, turn/start, turn/interrupt). The CLI does its own auth from
 * its own CODEX_HOME: no OAuth flow, no API key, and this process never
 * reads or forwards a token. Detection is "a working binary with its own
 * sign-in"; when that exists, the provider simply appears.
 *
 * The chat the user types into IS the CLI session: one Codex thread per
 * canvas, every message a turn on it, so follow-ups carry the thread's own
 * memory and the canvas reaches the session through the doop MCP server the
 * user already configured in the CLI.
 *
 * clientInfo.name follows Paseo's reserved non-originating name so requests
 * keep Codex's default CLI identity in provider usage logs rather than
 * showing up as a third-party originator — the traffic is shaped exactly
 * like the user's own CLI use, which is the point of this provider.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { env } from './env.ts'
import type { LocalHarnessRequest } from './localAgentRuns.ts'
import type { LocalAgentResult } from '../shared/localAgent.ts'
import {
  DEFAULT_CODEX_EFFORT,
  isCodexEffort,
  isCodexModel,
  type CodexEffort,
  type CodexRunPreference,
} from '../shared/codexLocal.ts'

/* ------------------------------------------------------------------ */
/* detection                                                          */
/* ------------------------------------------------------------------ */

export interface CodexDetection {
  available: boolean
  path?: string
  version?: string
  /** why it is unavailable, for the Settings line and logs */
  reason?: string
  checkedAt: number
}

const PROBE_TTL_MS = 30_000
let cached: CodexDetection | null = null

export function codexHome(): string {
  return env.CODEX_HOME ?? join(homedir(), '.codex')
}

/** The CLI's own sign-in. We never read the file; its presence is the signal. */
function authPresent(): boolean {
  try {
    return statSync(join(codexHome(), 'auth.json')).size > 0
  } catch {
    return false
  }
}

function candidatePaths(): string[] {
  if (env.DOOP_CODEX_PATH) return [env.DOOP_CODEX_PATH]
  // eslint-disable-next-line no-restricted-syntax -- PATH is the process search path used to locate the CLI binary, not app configuration
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, 'codex'))
  const home = homedir()
  return [
    ...fromPath,
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
    join(home, '.local/bin/codex'),
    join(home, '.npm-global/bin/codex'),
    join(home, '.volta/bin/codex'),
  ]
}

function executable(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function runVersion(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(path, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(null)
    }, 5_000)
    child.stdout?.on('data', (chunk) => (out += chunk))
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? out.trim().slice(0, 120) || 'unknown' : null)
    })
  })
}

/** Re-checks at most every PROBE_TTL_MS; tests pass force to re-read a
 *  changed environment. Never throws: an unavailable CLI is a state, not an
 *  error. */
export async function probeCodex(force = false): Promise<CodexDetection> {
  if (!force && cached && Date.now() - cached.checkedAt < PROBE_TTL_MS) return cached
  let detection: CodexDetection
  if (env.DOOP_CODEX_DISABLED) {
    detection = { available: false, reason: 'disabled', checkedAt: Date.now() }
  } else {
    const path = candidatePaths().find(executable)
    if (!path) {
      detection = { available: false, reason: 'no codex binary found', checkedAt: Date.now() }
    } else if (!authPresent()) {
      detection = { available: false, path, reason: 'codex is not signed in', checkedAt: Date.now() }
    } else {
      const version = await runVersion(path)
      detection = version
        ? { available: true, path, version, checkedAt: Date.now() }
        : { available: false, path, reason: 'codex --version failed', checkedAt: Date.now() }
    }
  }
  cached = detection
  return detection
}

/** The last probe's answer for sync callers (default resolution); false
 *  until the first async probe lands. */
export function codexDetected(): boolean {
  return cached?.available === true
}

/* ------------------------------------------------------------------ */
/* the JSON-RPC client: one app-server child, many threads            */
/* ------------------------------------------------------------------ */

const CLIENT_INFO = { name: 'codex_app_server_daemon', title: 'Doop local runner', version: '0.1.0' }
const RUN_TIMEOUT_MS = 30 * 60_000

interface RpcReply {
  id?: number
  result?: unknown
  error?: { message?: string }
  method?: string
  params?: Record<string, unknown>
}

interface ActiveTurn {
  threadId: string
  turnId: string | null
  text: string
  timer: ReturnType<typeof setTimeout>
  resolve: (result: LocalAgentResult) => void
}

export class CodexAppServer {
  private child: ChildProcess | null = null
  private nextId = 1
  private buffer = ''
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private ready: Promise<void> | null = null
  /** live threads: canvas key -> Codex thread id (threads outlive the child:
   *  after a respawn they are re-opened with thread/resume) */
  private threads = new Map<string, string>()
  private loadedThreads = new Set<string>()
  private turn: ActiveTurn | null = null
  private queue: (() => void)[] = []

  constructor(private binary: string) {}

  threadId(key: string): string | undefined {
    return this.threads.get(key)
  }

  private onLine(line: string) {
    if (!line.trim()) return
    let msg: RpcReply
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const waiter = this.pending.get(msg.id)!
      this.pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(msg.error.message ?? 'codex app-server error'))
      else waiter.resolve(msg.result)
      return
    }
    if (msg.method) this.onNotification(msg.method, msg.params ?? {})
  }

  private onNotification(method: string, params: Record<string, unknown>) {
    const turn = this.turn
    if (!turn) return
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      turn.text += params.delta
      return
    }
    if (method === 'item/completed') {
      const item = params.item as { type?: string; text?: string } | undefined
      if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) turn.text = item.text
      return
    }
    if (method === 'turn/started') {
      const t = params.turn as { id?: string } | undefined
      if (t?.id) turn.turnId = t.id
      return
    }
    if (method === 'turn/completed') {
      const t = params.turn as { status?: string; error?: { message?: string } | null } | undefined
      const status = t?.status ?? 'completed'
      clearTimeout(turn.timer)
      this.turn = null
      const done = turn.resolve
      this.dequeue()
      if (status === 'completed' && turn.text) done({ success: true, text: turn.text })
      else if (status === 'interrupted') done({ success: false, text: 'Task stopped.' })
      else if (status === 'completed') done({ success: false, text: 'Codex finished without a reply. Retry the task.' })
      else done({ success: false, text: `Codex run failed${t?.error?.message ? `: ${t.error.message}` : '.'}` })
    }
  }

  private dequeue() {
    const next = this.queue.shift()
    if (next) setImmediate(next)
  }

  /** One turn at a time per app-server; later messages wait their turn. */
  private slot(): Promise<void> {
    if (!this.turn) return Promise.resolve()
    return new Promise((resolve) => this.queue.push(resolve))
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.child
    if (!child?.stdin) return Promise.reject(new Error('codex app-server is not running'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      child.stdin!.write(`${JSON.stringify({ method, params, id })}\n`)
    })
  }

  private async ensureStarted(): Promise<void> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      const child = spawn(this.binary, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })
      this.child = child
      child.stdout!.on('data', (chunk) => {
        this.buffer += chunk
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() ?? ''
        for (const line of lines) this.onLine(line)
      })
      child.on('exit', () => {
        this.child = null
        this.ready = null
        this.loadedThreads.clear()
        for (const [, waiter] of this.pending) waiter.reject(new Error('codex app-server exited'))
        this.pending.clear()
        const turn = this.turn
        if (turn) {
          clearTimeout(turn.timer)
          this.turn = null
          turn.resolve({ success: false, text: 'Codex app-server stopped mid-run. Retry the task.' })
          this.dequeue()
        }
      })
      await this.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } })
      /* the handshake asks for one notification back */
      this.child.stdin!.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`)
    })()
    return this.ready
  }

  private async ensureThread(key: string, model: string, developerInstructions: string): Promise<string> {
    const existing = this.threads.get(key)
    if (existing) {
      if (this.loadedThreads.has(existing)) return existing
      try {
        await this.request('thread/resume', { threadId: existing, excludeTurns: true })
        this.loadedThreads.add(existing)
        return existing
      } catch {
        /* the stored rollout is gone or unreadable — start fresh */
        this.threads.delete(key)
      }
    }
    const result = (await this.request('thread/start', {
      model,
      cwd: tmpdir(),
      approvalPolicy: 'never',
      sandbox: 'read-only',
      ...(developerInstructions ? { developerInstructions } : {}),
    })) as { thread?: { id?: string } }
    const id = result?.thread?.id
    if (!id) throw new Error('codex app-server did not return a thread id')
    this.threads.set(key, id)
    this.loadedThreads.add(id)
    return id
  }

  /** One chat message: one turn on the canvas's thread. */
  async runTurn(
    key: string,
    run: CodexRunPreference,
    system: string,
    prompt: string,
    signal: AbortSignal | undefined,
  ): Promise<LocalAgentResult> {
    await this.slot()
    await this.ensureStarted()
    const threadId = await this.ensureThread(key, run.model, system)
    return new Promise<LocalAgentResult>((resolve) => {
      const turn: ActiveTurn = {
        threadId,
        turnId: null,
        text: '',
        timer: setTimeout(() => {
          void this.interrupt()
          this.finishTurn({ success: false, text: 'Codex run timed out. Retry the task.' })
        }, RUN_TIMEOUT_MS),
        resolve,
      }
      this.turn = turn
      signal?.addEventListener(
        'abort',
        () => {
          void this.interrupt()
          this.finishTurn({ success: false, text: 'Task stopped.' })
        },
        { once: true },
      )
      this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        model: run.model,
        effort: run.effort,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
      })
        .then((result) => {
          /* the reply already carries the turn id; an early stop can then
             still interrupt before the turn/started notification lands */
          const t = (result as { turn?: { id?: string } } | undefined)?.turn
          if (t?.id && this.turn === turn) turn.turnId = t.id
        })
        .catch((err: Error) => this.finishTurn({ success: false, text: `Codex run could not start: ${err.message}` }))
    })
  }

  private finishTurn(result: LocalAgentResult) {
    const turn = this.turn
    if (!turn) return
    clearTimeout(turn.timer)
    this.turn = null
    turn.resolve(result)
    this.dequeue()
  }

  private async interrupt() {
    const turn = this.turn
    if (!turn?.turnId) return
    await this.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.turnId }).catch(() => {})
  }

  /** Stop the child and forget live state; thread ids stay for resume. */
  async stop() {
    this.child?.kill('SIGTERM')
  }
}

/* ------------------------------------------------------------------ */
/* runs: one app-server per user, one thread per canvas               */
/* ------------------------------------------------------------------ */

export class CodexLocalRuns {
  private servers = new Map<string, CodexAppServer>()

  online(): boolean {
    return codexDetected()
  }

  private serverFor(userId: string, binary: string): CodexAppServer {
    let server = this.servers.get(userId)
    if (!server) {
      server = new CodexAppServer(binary)
      this.servers.set(userId, server)
    }
    return server
  }

  async start(userId: string, run: CodexRunPreference, request: LocalHarnessRequest): Promise<LocalAgentResult> {
    const model = isCodexModel(run.model) ? run.model : env.DOOP_CODEX_MODEL
    const effort: CodexEffort = isCodexEffort(run.effort) ? run.effort : DEFAULT_CODEX_EFFORT
    const detection = await probeCodex()
    if (!detection.available || !detection.path) {
      return { success: false, text: `Codex CLI is not available on this machine (${detection.reason ?? 'unknown'}).` }
    }
    const key = `${userId}:${request.canvasId}`
    return this.serverFor(userId, detection.path).runTurn(
      key,
      { model, effort },
      request.system,
      request.prompt,
      request.signal,
    )
  }

  async cancel(userId: string): Promise<void> {
    await this.servers.get(userId)?.stop()
    this.servers.delete(userId)
  }
}

export const codexLocalRuns = new CodexLocalRuns()
