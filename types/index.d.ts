export type Coordinator = {
  name: string
  terminal?: string
  run?: string
  model?: string
  // Path prefixes: agent terminals under them show as this coordinator's workers.
  worktrees?: string[]
}

export type Config = {
  pollSeconds: number
  staleMinutes: number
  coordinators: Coordinator[]
  workersCommand: string[]
  terminalsCommand: string[]
  screenCommand: string[]
  environments: { name: string; url: string }[]
  readyPath: string
  statusPath: string
  statusField: string
  repos: string[]
  usageCommand: string[]
  usageProviders: string[]
  mailbox: string
  ownerSteps: string
}

export type WorkerState = 'permission' | 'running' | 'input' | 'stale' | 'done' | 'failed'

export type WorkerRow = {
  name: string
  state: WorkerState
  quietMinutes?: number
  pr?: string
  // The terminal it runs in, so one worker is never listed twice; not drawn.
  handle?: string
  // When a dispatched worker left the list; it shows as done for an hour.
  doneAt?: number
}

export type CoordinatorRow = {
  name: string
  terminal: string
  model: string
  quietMinutes?: number
  workers: WorkerRow[]
  isWaitingPermission?: boolean
}

export type EnvRow = { name: string; ready: string; state: string; checkedAt: number }
export type RepoRow = { repo: string; prs: { number: number; isOld: boolean }[] }
export type Machine = { load: number; freePercent: number }
export type MailRow = { at: string; from: string; subject: string }

// One section's last good value, when it was read, and the last error since.
// `value` is absent (and `at` 0) when the first read already failed.
export type Section<T> = { value?: T; at: number; error?: string }

export type Snapshot = {
  config?: Section<Config>
  coordinators?: Section<CoordinatorRow[]>
  environments?: Section<EnvRow[]>
  prs?: Section<RepoRow[]>
  usage?: Section<string[]>
  machine?: Section<Machine>
  steps?: Section<string[]>
  mail?: Section<MailRow[]>
}

declare module 'claude-code' {
  interface PluginState {
    'chief-engineer': { snapshot: Shaped<Snapshot>; isPaneOpen: boolean; collapsed: string[]; expanded: string[] }
  }
}
