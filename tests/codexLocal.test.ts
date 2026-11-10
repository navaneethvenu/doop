import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stubEnv, unstubAllEnvs } from './envStub.ts'
import { CodexAppServer, CodexLocalRuns, probeCodex } from '../server/codexLocal.ts'
import type { LocalHarnessRequest } from '../server/localAgentRuns.ts'

/**
 * A fake `codex` binary that speaks the app-server JSON-RPC wire: enough to
 * prove detection, thread lifecycle, turn streaming and interruption without
 * a real Codex CLI (and without any OpenAI traffic) in the sandbox.
 */
const FAKE = `#!/usr/bin/env node
const fs = require('fs')
const readline = require('readline')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('codex-cli 9.9.9-fake')
  process.exit(0)
}
if (args[0] !== 'app-server') process.exit(2)
const log = process.env.FAKE_CODEX_LOG
const record = (obj) => { if (log) fs.appendFileSync(log, JSON.stringify(obj) + '\\n') }
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
let threadCounter = 0
let turnCounter = 0
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.method) record(msg)
  const reply = (result) => write({ id: msg.id, result })
  const notify = (method, params) => write({ method, params })
  switch (msg.method) {
    case 'initialize':
      reply({ userAgent: 'codex/9.9.9-fake', platformFamily: 'unix', platformOs: 'linux' })
      return
    case 'initialized':
      return
    case 'thread/start': {
      const id = 'thr_' + ++threadCounter
      reply({ thread: { id } })
      notify('thread/started', { thread: { id } })
      return
    }
    case 'thread/resume':
      reply({ thread: { id: msg.params.threadId } })
      notify('thread/started', { thread: { id: msg.params.threadId } })
      return
    case 'turn/start': {
      const tid = 'turn_' + ++turnCounter
      reply({ turn: { id: tid, status: 'inProgress' } })
      notify('turn/started', { turn: { id: tid } })
      setTimeout(() => {
        if (process.env.FAKE_CODEX_FAIL) {
          notify('turn/completed', { turn: { id: tid, status: 'failed', error: { message: 'fake upstream error' } } })
          return
        }
        notify('item/agentMessage/delta', { threadId: msg.params.threadId, turnId: tid, delta: 'Hello ' })
        notify('item/agentMessage/delta', { threadId: msg.params.threadId, turnId: tid, delta: 'canvas' })
        notify('item/completed', { item: { type: 'agentMessage', text: 'Hello canvas' } })
        notify('turn/completed', { turn: { id: tid, status: 'completed' } })
      }, Number(process.env.FAKE_CODEX_DELAY_MS || 5))
      return
    }
    case 'turn/interrupt':
      reply({})
      notify('turn/completed', { turn: { id: msg.params.turnId, status: 'interrupted' } })
      return
    default:
      reply({})
  }
})
`

let fake: string
let codexHome: string
let logPath: string

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'doop-fake-codex-'))
  fake = join(dir, 'codex')
  writeFileSync(fake, FAKE)
  chmodSync(fake, 0o755)
  codexHome = join(dir, 'home')
  mkdirSync(codexHome, { recursive: true })
  writeFileSync(join(codexHome, 'auth.json'), '{}')
  logPath = join(dir, 'log.jsonl')
})

type WireEntry = { method?: string; params?: Record<string, unknown> }
function logLines(): WireEntry[] {
  try {
    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as WireEntry)
  } catch {
    return []
  }
}

describe('probeCodex', () => {
  afterEach(unstubAllEnvs)

  it('finds a signed-in CLI through the override path', async () => {
    stubEnv('DOOP_CODEX_PATH', fake)
    stubEnv('CODEX_HOME', codexHome)
    const probe = await probeCodex(true)
    expect(probe.available).toBe(true)
    expect(probe.path).toBe(fake)
    expect(probe.version).toContain('9.9.9-fake')
  })

  it('reports an override path that does not run', async () => {
    stubEnv('DOOP_CODEX_PATH', '/definitely/not/here/codex')
    stubEnv('CODEX_HOME', codexHome)
    const probe = await probeCodex(true)
    expect(probe.available).toBe(false)
    expect(probe.reason).toBe('no codex binary found')
  })

  it('refuses a CLI that is not signed in', async () => {
    stubEnv('DOOP_CODEX_PATH', fake)
    stubEnv('CODEX_HOME', mkdtempSync(join(tmpdir(), 'doop-empty-codex-home-')))
    const probe = await probeCodex(true)
    expect(probe.available).toBe(false)
    expect(probe.reason).toBe('codex is not signed in')
  })

  it('honours the kill switch', async () => {
    stubEnv('DOOP_CODEX_PATH', fake)
    stubEnv('CODEX_HOME', codexHome)
    stubEnv('DOOP_CODEX_DISABLED', '1')
    expect((await probeCodex(true)).available).toBe(false)
  })
})

describe('CodexLocalRuns', () => {
  let runs: CodexLocalRuns | undefined
  afterEach(async () => {
    /* cancel kills the app-server children the test spawned */
    await runs?.cancel('u1')
    await runs?.cancel('u2')
    runs = undefined
    unstubAllEnvs()
  })

  async function setup(): Promise<CodexLocalRuns> {
    stubEnv('DOOP_CODEX_PATH', fake)
    stubEnv('CODEX_HOME', codexHome)
    stubEnv('FAKE_CODEX_LOG', logPath)
    writeFileSync(logPath, '')
    /* seed the 30s probe cache with this test's environment */
    await probeCodex(true)
    runs = new CodexLocalRuns()
    return runs
  }

  const request: LocalHarnessRequest = {
    canvasId: 'canvas_1',
    prompt: 'make a box',
    system: 'the system rules',
    tools: [],
    maxTurns: 2,
    /* the CLI owns its own tools; the harness execute path is never used */
    execute: async (block) => ({ type: 'tool_result', tool_use_id: block.id, content: 'unused' }),
  }
  const run = { model: 'gpt-5.6-luna', effort: 'low' as const }

  it('starts a fresh thread for a canvas and collects the reply', async () => {
    const local = await setup()
    const res = await local.start('u1', run, request)
    expect(res).toEqual({ success: true, text: 'Hello canvas' })
    const log = logLines()
    expect(log.filter((entry) => entry.method === 'initialize')).toHaveLength(1)
    const start = log.find((entry) => entry.method === 'thread/start')
    expect(start?.params?.model).toBe('gpt-5.6-luna')
    expect(start?.params?.approvalPolicy).toBe('never')
    expect(start?.params?.sandbox).toBe('read-only')
    expect(start?.params?.developerInstructions).toBe('the system rules')
    const turn = log.find((entry) => entry.method === 'turn/start')
    expect(turn?.params?.effort).toBe('low')
    expect(turn?.params?.input).toEqual([{ type: 'text', text: 'make a box' }])
  })

  it('keeps the conversation on one thread for the canvas next message', async () => {
    const local = await setup()
    await local.start('u1', run, request)
    await local.start('u1', run, { ...request, prompt: 'make it blue' })
    const log = logLines()
    expect(log.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
    const turns = log.filter((entry) => entry.method === 'turn/start')
    expect(turns).toHaveLength(2)
    expect(turns[0]?.params?.threadId).toBe(turns[1]?.params?.threadId)
  })

  it('re-opens the thread with thread/resume after the app-server respawns', async () => {
    await setup()
    const server = new CodexAppServer(fake)
    try {
      await server.runTurn('u1:canvas_1', run, 'the system rules', 'make a box', undefined)
      await server.stop()
      await new Promise((resolve) => setTimeout(resolve, 100))
      await server.runTurn('u1:canvas_1', run, 'the system rules', 'make it blue', undefined)
    } finally {
      await server.stop()
    }
    const log = logLines()
    expect(log.filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
    expect(log.filter((entry) => entry.method === 'thread/resume')).toHaveLength(1)
  })

  it('surfaces a failed turn with the CLI error', async () => {
    const local = await setup()
    stubEnv('FAKE_CODEX_FAIL', '1')
    const res = await local.start('u1', run, request)
    expect(res.success).toBe(false)
    expect(res.text).toContain('fake upstream error')
  })

  it('interrupts the turn when the caller aborts', async () => {
    const local = await setup()
    stubEnv('FAKE_CODEX_DELAY_MS', '300')
    const controller = new AbortController()
    const promise = local.start('u1', run, { ...request, signal: controller.signal })
    setTimeout(() => controller.abort(), 50)
    const res = await promise
    expect(res.success).toBe(false)
    expect(res.text).toBe('Task stopped.')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(logLines().some((entry) => entry.method === 'turn/interrupt')).toBe(true)
  })

  it('keeps separate app-server processes per user', async () => {
    const local = await setup()
    await local.start('u1', run, request)
    await local.start('u2', run, { ...request, canvasId: 'canvas_2' })
    const log = logLines()
    expect(log.filter((entry) => entry.method === 'initialize')).toHaveLength(2)
  })
})
