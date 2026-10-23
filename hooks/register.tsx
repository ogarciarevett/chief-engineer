// chief-engineer: a docked pane (and a band while it is closed) with the seven
// things a chief coordinator checks all day. Reads only; a failed read keeps the
// last value and shows its age.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Config, Section, Snapshot } from '../types'
import {
  carryDone,
  expandHome,
  mask,
  coordinatorRow,
  envRow,
  machineLevel,
  parseConfig,
  parseEnvStatus,
  parseMachine,
  parseMail,
  parsePrs,
  parseSteps,
  parseTerminals,
  parseUsage,
  parseWorkers,
} from './readers'

const PANE = 'chief-engineer'
const TITLE = 'Chief engineer'
const LOCAL_MS = 10_000
const snapshot = atom({ plugin: 'chief-engineer', key: 'snapshot' } as const, {} as Snapshot, { shape: 'snapshot-1' })
const isPaneOpen = atom({ plugin: 'chief-engineer', key: 'isPaneOpen' } as const, false)

type $ = EngineInterface
type Key = keyof Snapshot

// Runs one reader; on failure the last good value stays and the error is noted.
async function refresh<K extends Key>($: $, key: K, read: () => Promise<NonNullable<Snapshot[K]>['value']>) {
  try {
    const value = await read()
    await update($, snapshot, s => ({ ...s, [key]: { value, at: Date.now() } }))
  } catch (err) {
    // A parse error quotes the input it choked on, so it is replaced, never shown.
    const error = err instanceof SyntaxError ? 'output not readable' : err instanceof Error ? mask(err.message).slice(0, 120) : 'read failed'
    await update($, snapshot, s => ({ ...s, [key]: { ...(s[key] ?? { at: 0 }), error } }))
  }
}

async function run($: $, argv: string[], timeoutMs = 20_000) {
  const r = await $.process.run(argv, { timeoutMs })
  const name = (argv[0] ?? '').split('/').pop()
  if (r.exitCode !== 0) throw new Error(`${name} exited ${r.exitCode}`)
  if (r.isStdoutTruncated) throw new Error(`${name} output is over 4 MiB`)
  return r.stdout
}

async function readConfig($: $, path: string) {
  const home = (await $.env.get('HOME')) ?? ''
  const c = parseConfig(await $.fs.read(expandHome(path, home)))
  return { ...c, mailbox: expandHome(c.mailbox, home), ownerSteps: expandHome(c.ownerSteps, home) }
}

async function readRemote($: $, c: Config) {
  const now = () => Date.now()
  await Promise.all([
    refresh($, 'coordinators', async () => {
      const terminals = parseTerminals(await run($, c.terminalsCommand))
      const prev = (await read($, snapshot)).coordinators?.value ?? []
      return Promise.all(
        c.coordinators.map(async co => {
          const live = co.run ? parseWorkers(await run($, c.workersCommand.map(a => a.replace('{run}', co.run!))), terminals, now(), c.staleMinutes) : []
          const workers = carryDone(prev.find(p => p.name === co.name)?.workers ?? [], live, now())
          return coordinatorRow(co, workers, terminals, now())
        }),
      )
    }),
    refresh($, 'environments', () =>
      Promise.all(
        c.environments.map(async env => {
          const base = env.url.replace(/\/$/, '')
          const [ready, status] = await Promise.all([
            $.http.fetch(base + c.readyPath).then(r => r.status, () => 'down'),
            $.http.fetch(base + c.statusPath).then(r => parseEnvStatus(r.text, c.statusField)).catch(() => '?'),
          ])
          return envRow(env.name, ready, status, now())
        }),
      ),
    ),
    refresh($, 'prs', () =>
      Promise.all(c.repos.map(async repo => parsePrs(repo, await run($, ['gh', 'pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'number,createdAt']), now()))),
    ),
    c.usageCommand.length ? refresh($, 'usage', async () => parseUsage(await run($, c.usageCommand), c.usageProviders)) : undefined,
  ])
}

async function readLocal($: $, c: Config) {
  const names = new Map(c.coordinators.filter(x => x.terminal).map(x => [x.terminal!, x.name]))
  await Promise.all([
    refresh($, 'machine', async () => parseMachine(await run($, ['/usr/sbin/sysctl', '-n', 'vm.loadavg']), await run($, ['/usr/bin/memory_pressure']))),
    c.ownerSteps ? refresh($, 'steps', async () => parseSteps(await $.fs.read(c.ownerSteps))) : undefined,
    c.mailbox ? refresh($, 'mail', async () => parseMail(await run($, ['/usr/bin/tail', '-n', '5', c.mailbox]), names)) : undefined,
  ])
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}
const cut = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(1, w - 1)) + '…' : s)

// Module state: a reload starts it over, which only costs one early read.
let configPath = '~/.config/chief-engineer/config.json'
const busy = { local: false, remote: false }
let lastRemote = 0

async function tick($: $) {
  if (busy.local) return
  busy.local = true
  try {
    await refresh($, 'config', () => readConfig($, configPath))
    const c = (await read($, snapshot)).config?.value
    if (!c) return
    await readLocal($, c)
    if (!busy.remote && Date.now() - lastRemote >= c.pollSeconds * 1000) {
      busy.remote = true
      lastRemote = Date.now()
      void readRemote($, c).finally(() => (busy.remote = false))
    }
  } finally {
    busy.local = false
  }
}

async function open($: $) {
  // Inline, ask for room for all seven sections; a dock ignores it.
  const r = await $.ui.open({ id: PANE, title: TITLE, rows: 48 })
  await update($, isPaneOpen, () => r.isPlaced)
}

export const register: Register = (on, options) => {
  configPath = String(options.configPath || configPath)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'chief', description: 'Open the chief engineer pane' }).catch(() => {})
    void open($).catch(() => {})
    void tick($).catch(() => {})
    $.clock.every(LOCAL_MS, () => void tick($).catch(() => {}))
    return r
  })

  on('command.run', { command: 'chief' }, async $ => {
    await open($)
    return { text: 'Chief engineer pane opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isPaneOpen, () => false)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const w = Math.max(20, e.props.bodyColumns)
    const head = (title: string, sec?: Section<unknown>) => (
      <Text bold>
        {title}{' '}
        <Text dimColor>{!sec ? 'waiting' : sec.at ? ago(sec.at) : 'never read'}</Text>
        {sec?.error ? <Text color="warning"> stale: {cut(sec.error, 40)}</Text> : ''}
      </Text>
    )
    const line = (t: string, color?: string) => <Text color={color}>{cut(mask(t), w)}</Text>

    if (!s.config?.value) return <Box flexDirection="column">{line(s.config?.error ? `Config ${configPath}: ${s.config.error}` : `No config read yet from ${configPath}`, s.config?.error ? 'error' : 'warning')}</Box>

    const cfg = s.config.value
    const m = s.machine?.value
    return (
      <Box flexDirection="column">
        {head('Coordinators', s.coordinators)}
        {(s.coordinators?.value ?? []).flatMap(c => [
          line(`${c.name}  ${c.terminal}  ${c.model}${c.quietMinutes !== undefined ? `  quiet ${c.quietMinutes}m` : ''}`, undefined),
          ...(c.workers.length ? c.workers : []).map(wk =>
            line(
              `  ${wk.name}  ${wk.state === 'stale' ? `stale ${wk.quietMinutes ?? '?'}m` : wk.state === 'input' ? 'waiting for input' : wk.state}${wk.pr ? `  #${wk.pr}` : ''}`,
              wk.state === 'input' ? 'error' : wk.state === 'stale' ? 'warning' : wk.state === 'running' ? undefined : 'subtle',
            ),
          ),
          ...(c.workers.length ? [] : [line('  no active workers', 'subtle')]),
        ])}
        {head('Environments', s.environments)}
        {(s.environments?.value ?? []).map(env => line(`${env.name}  ready ${env.ready}  ${env.state}  at ${new Date(env.checkedAt).toISOString().slice(11, 16)}Z`, env.ready === '200' ? (env.state === 'normal' ? 'success' : 'warning') : 'error'))}
        {head('Open PRs', s.prs)}
        {(s.prs?.value ?? []).map(r => {
          const name = `${cut(r.repo.split('/').pop() ?? r.repo, 24)} ${r.prs.length} `
          // As many numbers as fit the width, then a count of the rest.
          let room = w - name.length - 6
          const shown = r.prs.filter(p => (room -= `#${p.number} `.length) >= 0)
          return (
            <Text>
              {name}
              {shown.map(p => <Text color={p.isOld ? 'warning' : undefined}>#{p.number} </Text>)}
              {shown.length < r.prs.length ? `+${r.prs.length - shown.length}` : ''}
            </Text>
          )
        })}
        {cfg.usageCommand.length ? head('Usage', s.usage) : ''}
        {cfg.usageCommand.length ? (s.usage?.value ?? []).map(u => line(u, /error/.test(u) ? 'subtle' : undefined)) : ''}
        {head('Machine', s.machine)}
        {m ? line(`load ${m.load.toFixed(1)}  free ${m.freePercent}%`, machineLevel(m)) : line('no reading yet', 'subtle')}
        {cfg.ownerSteps ? head('Owner steps', s.steps) : ''}
        {cfg.ownerSteps ? (s.steps?.value?.length ? s.steps.value.map(t => line(`• ${t}`)) : line('none open', 'subtle')) : ''}
        {cfg.mailbox ? head('Mailbox', s.mail) : ''}
        {cfg.mailbox ? (s.mail?.value ?? []).map(r => line(`${r.at}  ${r.from}  ${r.subject}`)) : ''}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isPaneOpen))) return next(e)
    const s = await read($, snapshot)
    if (!s.config?.value) return next(e)
    const { Text } = $.ui.resolve(e)
    const workers = (s.coordinators?.value ?? []).flatMap(c => c.workers)
    const attn = workers.filter(x => x.state === 'input' || x.state === 'stale').length
    const envs = s.environments?.value ?? []
    const prs = (s.prs?.value ?? []).reduce((n, r) => n + r.prs.length, 0)
    const m = s.machine?.value
    const text = [
      `chief: ${workers.filter(x => x.state !== 'done' && x.state !== 'failed').length} workers`,
      `${attn} need you`,
      `envs ${envs.filter(x => x.ready === '200').length}/${envs.length} ready`,
      `${prs} PRs`,
      m ? `load ${m.load.toFixed(0)} free ${m.freePercent}%` : '',
      `${s.steps?.value?.length ?? 0} owner steps`,
      '/chief',
    ].filter(Boolean).join(' · ')
    return <Text color={attn ? 'warning' : 'subtle'}>{cut(text, Math.max(20, e.props.bodyColumns))}</Text>
  })
}
