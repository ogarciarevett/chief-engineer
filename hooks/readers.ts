// Pure parsers: each takes what a command or file gave and returns rows to draw.
// No I/O here, so every reader is tested with plain strings.
import type { Config, CoordinatorRow, EnvRow, Limits, Machine, MailRow, RepoRow, WorkerRow } from '../types'

const DEFAULTS: Config = {
  pollSeconds: 60,
  staleMinutes: 30,
  coordinators: [],
  workersCommand: ['orca', 'orchestration', 'task-list', '--run', '{run}', '--status', 'dispatched', '--brief', '--json'],
  terminalsCommand: ['orca', 'terminal', 'list', '--json'],
  screenCommand: ['orca', 'terminal', 'read', '--terminal', '{handle}', '--screen', '--json'],
  environments: [],
  readyPath: '/ready',
  statusPath: '/v1/system/status',
  statusField: 'state',
  repos: [],
  usageCommand: [],
  usageProviders: [],
  mailbox: '',
  ownerSteps: '',
  limits: { load: 30, swapGB: 8, memoryPercent: 60 },
}

// Phone-like numbers never reach the pane: `+` and 9+ digits, or 9+ digits in a row.
export const mask = (s: string) => s.replace(/\+\d[\d ().-]{7,}\d|\b\d{9,}\b/g, '[number]')

export const expandHome = (path: string, home: string) => path.replace(/^~(?=\/)/, home)

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string')

export function parseConfig(text: string): Config {
  const raw = JSON.parse(text) as Record<string, unknown>
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('config is not an object')
  const c = { ...DEFAULTS, ...raw } as Config
  for (const k of ['workersCommand', 'terminalsCommand', 'screenCommand', 'repos', 'usageCommand', 'usageProviders'] as const) {
    if (!isStrings(c[k])) throw new Error(`${k} must be a list of strings`)
  }
  if (!Array.isArray(c.coordinators) || !c.coordinators.every(x => typeof x?.name === 'string' && (x.worktrees === undefined || isStrings(x.worktrees)))) {
    throw new Error('coordinators must be a list of { name, worktrees? }')
  }
  if (!Array.isArray(c.environments) || !c.environments.every(x => typeof x?.name === 'string' && /^https?:\/\//.test(x?.url))) {
    throw new Error('environments must be a list of { name, url } with an http(s) url')
  }
  // Remote reads stay cheap: never poll faster than 30 s.
  c.pollSeconds = Math.max(30, Number(c.pollSeconds) || DEFAULTS.pollSeconds)
  c.staleMinutes = Math.max(1, Number(c.staleMinutes) || DEFAULTS.staleMinutes)
  c.limits = { ...DEFAULTS.limits, ...(raw.limits as object) }
  if (!Object.values(c.limits).every(v => typeof v === 'number' && v > 0)) throw new Error('limits must be positive numbers')
  if (c.session !== undefined && !(typeof c.session === 'object' && c.session !== null && Object.values(c.session).every(v => typeof v === 'string'))) {
    throw new Error('session must be { orcaTerminalHandle?, cwd? }')
  }
  return c
}

// The pane and its readers run in one session only: the one the config names by its
// Orca terminal or its directory. No session key means no session.
export function isChiefSession(c: Pick<Config, 'session'>, handle: string | undefined, cwd: string): boolean {
  const s = c.session ?? {}
  return (!!s.orcaTerminalHandle && s.orcaTerminalHandle === handle) || (!!s.cwd && s.cwd.replace(/\/$/, '') === cwd.replace(/\/$/, ''))
}

const minutesSince = (ms: number | undefined, now: number) => (ms ? Math.max(0, Math.floor((now - ms) / 60000)) : undefined)
const INPUT = ['do you want to', '(y/n)', 'press enter', 'allow this', 'approve?']
const PR = /(?:\bPR\s*#?|#)(\d{2,6})\b/i
export const ORDER = { permission: 0, input: 1, stale: 2, running: 3, failed: 4, done: 5 }
const PERMISSION = ['do you want to', 'esc to cancel', 'do you trust', '❯ 1. yes']

// A permission dialog sits at the bottom of the screen: Codex asks `Allow command?`,
// others show two of the markers (one alone is a menu or chat text). Only that a
// dialog is open leaves this function, never the screen text; unreadable is no dialog.
export function isPermissionPrompt(stdout: string): boolean {
  try {
    const rows = JSON.parse(stdout)?.result?.terminal?.tail
    if (!Array.isArray(rows)) return false
    const bottom = rows.slice(-20).join('\n').toLowerCase()
    return bottom.includes('allow command?') || PERMISSION.filter(k => bottom.includes(k)).length >= 2
  } catch {
    return false
  }
}

type Terminal = { handle: string; lastOutputAt?: number; preview?: string; title?: string; worktreePath?: string; agentIdentity?: string }

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
      rows.push({ name, state, quietMinutes: quiet, pr, handle: t.assignee_handle })
    } else if ((t.status === 'completed' || t.status === 'failed') && t.completed_at) {
      // Settled work stays visible for an hour, then drops off the board.
      const ended = Date.parse(t.completed_at.includes('T') ? t.completed_at : t.completed_at.replace(' ', 'T') + 'Z')
      if (now - ended < 3600_000) rows.push({ name, state: t.status === 'failed' ? 'failed' : 'done', pr })
    }
  }
  return rows.sort((a, b) => ORDER[a.state] - ORDER[b.state])
}

// Agent terminals under a coordinator's worktrees count as its workers too: the title
// and a state, never the preview or the command line. `skip` holds handles shown already.
export function parseTerminalWorkers(stdout: string, worktrees: string[], skip: Set<string>, now: number, staleMinutes: number): WorkerRow[] {
  if (!worktrees.length) return []
  const list = (JSON.parse(stdout)?.result?.terminals ?? []) as Terminal[]
  const waiting = parseTerminals(stdout)
  return list
    .filter(t => t.agentIdentity && !skip.has(t.handle) && worktrees.some(w => (t.worktreePath ?? '').startsWith(w)))
    .map(t => {
      const name = mask((t.title || t.handle.slice(0, 13)).replace(/\s+/g, ' '))
      const quiet = minutesSince(t.lastOutputAt, now)
      const state = waiting.get(t.handle)?.isWaiting ? 'input' : quiet === undefined || quiet > staleMinutes ? 'stale' : 'running'
      return { name, state, quietMinutes: quiet, pr: name.match(PR)?.[1], handle: t.handle } as WorkerRow
    })
}

// A worker that was live last read and is gone now has settled: keep it as done for an hour.
// Matched by terminal when known: agents retitle their terminals as work moves on.
export function carryDone(prev: WorkerRow[], next: WorkerRow[], now: number): WorkerRow[] {
  const key = (w: WorkerRow) => w.handle ?? w.name
  const live = new Set(next.map(key))
  const settled = prev
    .filter(w => !live.has(key(w)) && (w.doneAt === undefined ? w.state !== 'done' && w.state !== 'failed' : now - w.doneAt < 3600_000))
    .map(w => ({ name: w.name, state: 'done' as const, pr: w.pr, doneAt: w.doneAt ?? now, ...(w.handle ? { handle: w.handle } : {}) }))
  return [...next, ...settled]
}

// One row per worker name: a live row beats a carried done one, and of two live
// rows the more urgent one stays.
export function mergeWorkers(rows: WorkerRow[]): WorkerRow[] {
  const live = (w: WorkerRow) => (w.doneAt === undefined ? 0 : 1)
  const sorted = [...rows].sort((a, b) => live(a) - live(b) || ORDER[a.state] - ORDER[b.state])
  const seen = new Set<string>()
  return sorted.filter(w => !seen.has(w.name) && !!seen.add(w.name))
}

export function coordinatorRow(c: Config['coordinators'][number], workers: WorkerRow[], terminals: ReturnType<typeof parseTerminals>, now: number, isWaitingPermission = false): CoordinatorRow {
  const term = c.terminal ? terminals.get(c.terminal) : undefined
  return { name: c.name, terminal: (c.terminal ?? '').slice(0, 13), model: c.model ?? '', quietMinutes: minutesSince(term?.lastOutputAt, now), workers, isWaitingPermission }
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

// Keeps the `word N%` parts of each line (with a known reset time) and drops the rest;
// a line with none of them, like an error, stays as it is.
export function parseUsage(stdout: string, providers: string[]): string[] {
  const lines = stdout.split('\n').filter(l => l.trim())
  return (providers.length ? lines.filter(l => providers.some(p => l.startsWith(p + ':'))) : lines).map(l => {
    const [name = '', rest = ''] = l.split(/:\s*(.*)/)
    const key = rest.split(/;\s*/).filter(p => /^\w+ \d+%/.test(p)).map(p => p.replace(/\s*\(resets \?\)/, ''))
    return mask(key.length ? `${name}: ${key.join('; ')}` : l)
  })
}

// `ps -A -o %cpu` prints a header and one percent per process; their sum over the cores is the Mac's CPU use.
export function parseCpu(ps: string, cores: number): number {
  const pcts = ps.split('\n').map(l => l.trim()).filter(l => /^[\d.]+$/.test(l)).map(Number)
  if (!pcts.length || !cores) return NaN
  return Math.round(Math.min(100, pcts.reduce((a, b) => a + b, 0) / cores))
}

export const MACHINE_TTL_MS = 15_000
// The shared cache `{ at, value }`: its value while it is younger than the TTL, else undefined.
export function cachedMachine(text: string, now: number): Machine | undefined {
  try {
    const c = JSON.parse(text)
    return typeof c?.at === 'number' && now - c.at >= 0 && now - c.at < MACHINE_TTL_MS && typeof c.value?.load === 'number' ? c.value : undefined
  } catch {
    return undefined
  }
}

// `sysctl -n vm.loadavg vm.swapusage hw.ncpu hw.memsize` prints one line per name, in that order.
export function parseMachine(sysctl: string, pressure: string, ps: string): Machine {
  const [loadavg = '', swap = '', ncpu = '', memsize = ''] = sysctl.split('\n')
  const gb = (key: string) => {
    const m = swap.match(new RegExp(`${key} = ([\\d.]+)([MG])`))
    return m ? Number(m[1]) / (m[2] === 'M' ? 1024 : 1) : NaN
  }
  const free = Number(pressure.match(/free percentage:\s*(\d+)/i)?.[1])
  const m: Machine = {
    load: Number(loadavg.match(/[\d.]+/)?.[0]),
    cores: Number(ncpu),
    cpuPercent: parseCpu(ps, Number(ncpu)),
    memoryPercent: 100 - free,
    memoryGB: Number(memsize) / 2 ** 30,
    swapUsedGB: gb('used'),
    swapTotalGB: gb('total'),
  }
  if (!Object.values(m).every(Number.isFinite) || !m.cores || !m.memoryGB) throw new Error('machine stats not readable')
  return m
}

export type Level = 'success' | 'warning' | 'error'
// Red over the limit, yellow from 80 % of it.
export const levelOf = (value: number, limit: number): Level => (value > limit ? 'error' : value > limit * 0.8 ? 'warning' : 'success')

// Under the core count every program gets a CPU; up to the limit they wait; over it the Mac freezes.
export function loadState(m: Machine, limit: number): [Level, string] {
  return m.load > limit ? ['error', 'overloaded'] : m.load >= m.cores ? ['warning', 'busy'] : ['success', 'ok']
}

const RANK = { success: 0, warning: 1, error: 2 }
export function machineLevel(m: Machine, limits: Limits): Level {
  const all = [loadState(m, limits.load)[0], levelOf(m.memoryPercent, limits.memoryPercent), levelOf(m.swapUsedGB, limits.swapGB)]
  return all.reduce((a, b) => (RANK[b] > RANK[a] ? b : a))
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
