// Pure parsers: each takes what a command or file gave and returns rows to draw.
// No I/O here, so every reader is tested with plain strings.
import type { Config, CoordinatorRow, EnvRow, Machine, MailRow, RepoRow, WorkerRow } from '../types'

const DEFAULTS: Config = {
  pollSeconds: 60,
  staleMinutes: 30,
  coordinators: [],
  workersCommand: ['orca', 'orchestration', 'task-list', '--run', '{run}', '--status', 'dispatched', '--brief', '--json'],
  terminalsCommand: ['orca', 'terminal', 'list', '--json'],
  environments: [],
  readyPath: '/ready',
  statusPath: '/v1/system/status',
  statusField: 'state',
  repos: [],
  usageCommand: [],
  usageProviders: [],
  mailbox: '',
  ownerSteps: '',
}

// Phone-like numbers never reach the pane: `+` and 9+ digits, or 9+ digits in a row.
export const mask = (s: string) => s.replace(/\+\d[\d ().-]{7,}\d|\b\d{9,}\b/g, '[number]')

export const expandHome = (path: string, home: string) => path.replace(/^~(?=\/)/, home)

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

export function parseConfig(text: string): Config {
  const raw = JSON.parse(text) as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('config is not an object')
  const c = { ...DEFAULTS, ...raw } as Config
  for (const k of ['workersCommand', 'terminalsCommand', 'repos', 'usageCommand', 'usageProviders'] as const) {
    if (!isStrings(c[k])) throw new Error(`${k} must be a list of strings`)
  }
  if (!Array.isArray(c.coordinators) || !c.coordinators.every(x => typeof x?.name === 'string')) {
    throw new Error('coordinators must be a list of { name }')
  }
  if (!Array.isArray(c.environments) || !c.environments.every(x => typeof x?.name === 'string' && /^https?:\/\//.test(x?.url))) {
    throw new Error('environments must be a list of { name, url } with an http(s) url')
  }
  // Remote reads stay cheap: never poll faster than 30 s.
  c.pollSeconds = Math.max(30, Number(c.pollSeconds) || DEFAULTS.pollSeconds)
  c.staleMinutes = Math.max(1, Number(c.staleMinutes) || DEFAULTS.staleMinutes)
  return c
}

const minutesSince = (ms: number | undefined, now: number) => (ms ? Math.max(0, Math.floor((now - ms) / 60000)) : undefined)
const INPUT = ['do you want to', '(y/n)', 'press enter', 'allow this', 'approve?']
const PR = /(?:\bPR\s*#?|#)(\d{2,6})\b/i

type Terminal = { handle: string; lastOutputAt?: number; preview?: string }

// Terminal output is used only to flag a waiting prompt; it is never returned.
export function parseTerminals(stdout: string): Map<string, { quietMinutes?: number; isWaiting: boolean; lastOutputAt?: number }> {
  const list = (JSON.parse(stdout)?.result?.terminals ?? []) as Terminal[]
  const out = new Map<string, { quietMinutes?: number; isWaiting: boolean; lastOutputAt?: number }>()
  for (const t of list) {
    const tail = (t.preview ?? '').slice(-400).toLowerCase()
    out.set(t.handle, { lastOutputAt: t.lastOutputAt, isWaiting: INPUT.some(k => tail.includes(k)) })
  }
  return out
}

type Task = { display_name?: string; task_title?: string; status: string; assignee_handle?: string; completed_at?: string | null; result?: string | null }

export function parseWorkers(stdout: string, terminals: ReturnType<typeof parseTerminals>, now: number, staleMinutes: number): WorkerRow[] {
  const tasks = (JSON.parse(stdout)?.result?.tasks ?? []) as Task[]
  const rows: WorkerRow[] = []
  for (const t of tasks) {
    const name = mask((t.display_name || t.task_title || '?').replace(/\s+/g, ' '))
    let subject = ''
    try {
      subject = t.result ? String(JSON.parse(t.result)?.subject ?? '') : ''
    } catch {}
    const pr = (name + ' ' + subject).match(PR)?.[1]
    if (t.status === 'dispatched') {
      const term = t.assignee_handle ? terminals.get(t.assignee_handle) : undefined
      const quiet = minutesSince(term?.lastOutputAt, now)
      const state = term?.isWaiting ? 'input' : quiet === undefined || quiet > staleMinutes ? 'stale' : 'running'
      rows.push({ name, state, quietMinutes: quiet, pr })
    } else if ((t.status === 'completed' || t.status === 'failed') && t.completed_at) {
      // Settled work stays visible for an hour, then drops off the board.
      const ended = Date.parse(t.completed_at.includes('T') ? t.completed_at : t.completed_at.replace(' ', 'T') + 'Z')
      if (now - ended < 3600_000) rows.push({ name, state: t.status === 'failed' ? 'failed' : 'done', pr })
    }
  }
  const order = { input: 0, stale: 1, running: 2, failed: 3, done: 4 }
  return rows.sort((a, b) => order[a.state] - order[b.state])
}

// A worker that was live last read and is gone now has settled: keep it as done for an hour.
export function carryDone(prev: WorkerRow[], next: WorkerRow[], now: number): WorkerRow[] {
  const names = new Set(next.map(w => w.name))
  const settled = prev
    .filter(w => !names.has(w.name) && (w.doneAt === undefined ? w.state !== 'done' && w.state !== 'failed' : now - w.doneAt < 3600_000))
    .map(w => ({ name: w.name, state: 'done' as const, pr: w.pr, doneAt: w.doneAt ?? now }))
  return [...next, ...settled]
}

export function coordinatorRow(c: Config['coordinators'][number], workers: WorkerRow[], terminals: ReturnType<typeof parseTerminals>, now: number): CoordinatorRow {
  const term = c.terminal ? terminals.get(c.terminal) : undefined
  return { name: c.name, terminal: (c.terminal ?? '').slice(0, 13), model: c.model ?? '', quietMinutes: minutesSince(term?.lastOutputAt, now), workers }
}

export function parseEnvStatus(body: string, field: string): string {
  const v = JSON.parse(body)?.[field]
  return typeof v === 'string' ? v : '?'
}

export function envRow(name: string, readyStatus: number | string, state: string, now: number): EnvRow {
  return { name, ready: String(readyStatus), state, checkedAt: now }
}

export function parsePrs(repo: string, stdout: string, now: number): RepoRow {
  const list = JSON.parse(stdout) as { number: number; createdAt: string }[]
  return { repo, prs: list.map(p => ({ number: p.number, isOld: now - Date.parse(p.createdAt) > 24 * 3600_000 })).sort((a, b) => a.number - b.number) }
}

export function parseUsage(stdout: string, providers: string[]): string[] {
  const lines = stdout.split('\n').filter(l => l.trim())
  return (providers.length ? lines.filter(l => providers.some(p => l.startsWith(p + ':'))) : lines).map(mask)
}

export function parseMachine(loadavg: string, pressure: string): Machine {
  const load = Number(loadavg.match(/[\d.]+/)?.[0])
  const freePercent = Number(pressure.match(/free percentage:\s*(\d+)/i)?.[1])
  if (!Number.isFinite(load) || !Number.isFinite(freePercent)) throw new Error('machine stats not readable')
  return { load, freePercent }
}

// Heavy jobs only under load 20 and over 40 % free; pause above 30 or under 25 % free.
export function machineLevel(m: Machine): 'success' | 'warning' | 'error' {
  if (m.load > 30 || m.freePercent < 25) return 'error'
  if (m.load < 20 && m.freePercent > 40) return 'success'
  return 'warning'
}

// Each `- ` item is a step; indented lines below it continue it; `- [x]` is done.
export function parseSteps(markdown: string): string[] {
  const steps: string[] = []
  for (const line of markdown.split('\n')) {
    if (/^[-*] /.test(line)) steps.push(line.slice(2).trim())
    else if (/^\s+\S/.test(line) && steps.length) steps[steps.length - 1] += ' ' + line.trim()
  }
  return steps.filter(s => !/^\[[xX]\]/.test(s)).map(s => mask(s.replace(/^\[ \]\s*/, '')))
}

// Only time, sender and subject leave the file; the body is never read out.
export function parseMail(jsonl: string, names: Map<string, string>): MailRow[] {
  const rows: MailRow[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    try {
      const m = JSON.parse(line)
      const from = String(m.from ?? '?')
      rows.push({ at: String(m.at ?? '').slice(11, 16), from: names.get(from) ?? mask(from).slice(0, 13), subject: mask(String(m.subject ?? '').replace(/\s+/g, ' ')) })
    } catch {}
  }
  return rows.slice(-5).reverse()
}
