// chief-engineer: a docked pane (and a band while it is closed) with the seven
// things a chief coordinator checks all day. Reads only; a failed read keeps the
// last value and shows its age.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Config, Section, Snapshot, WorkerRow } from '../types'
import {
  carryDone,
  expandHome,
  isPermissionPrompt,
  mask,
  mergeWorkers,
  ORDER,
  coordinatorRow,
  envRow,
  machineLevel,
  parseConfig,
  parseEnvStatus,
  parseMachine,
  parseMail,
  parsePrs,
  parseSteps,
  parseTerminalWorkers,
  parseTerminals,
  parseUsage,
  parseWorkers,
} from './readers'

const PANE = 'chief-engineer'
const TITLE = 'Chief engineer'
const LOCAL_MS = 10_000
const snapshot = atom({ plugin: 'chief-engineer', key: 'snapshot' } as const, {} as Snapshot, { shape: 'snapshot-1' })
const isPaneOpen = atom({ plugin: 'chief-engineer', key: 'isPaneOpen' } as const, false)
const collapsed = atom({ plugin: 'chief-engineer', key: 'collapsed' } as const, [] as string[])
const expanded = atom({ plugin: 'chief-engineer', key: 'expanded' } as const, [] as string[])

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
      const terminalsOut = await run($, c.terminalsCommand)
      const terminals = parseTerminals(terminalsOut)
      const prev = (await read($, snapshot)).coordinators?.value ?? []
      // One shared set, filled in config order, so each terminal is listed under one coordinator only.
      const seen = new Set(c.coordinators.flatMap(x => (x.terminal ? [x.terminal] : [])))
      const dispatched = await Promise.all(
        c.coordinators.map(async co => (co.run ? parseWorkers(await run($, c.workersCommand.map(a => a.replace('{run}', co.run!))), terminals, now(), c.staleMinutes) : [])),
      )
      for (const w of dispatched.flat()) if (w.handle) seen.add(w.handle)
      const mine = c.coordinators.map(co => {
        const rows = parseTerminalWorkers(terminalsOut, co.worktrees ?? [], seen, now(), c.staleMinutes)
        for (const w of rows) seen.add(w.handle!)
        return rows
      })
      // One screen read per shown terminal; a read that fails counts as no dialog.
      const blocked = new Set<string>()
      await Promise.all(
        [...seen].map(h =>
          run($, c.screenCommand.map(a => a.replace('{handle}', h))).then(
            out => void (isPermissionPrompt(out) && blocked.add(h)),
            () => {},
          ),
        ),
      )
      return c.coordinators.map((co, i) => {
        const live = [...dispatched[i]!, ...mine[i]!]
          .map(w => (w.handle && blocked.has(w.handle) ? { ...w, state: 'permission' as const } : w))
          .sort((a, b) => ORDER[a.state] - ORDER[b.state])
        const workers = mergeWorkers(carryDone(prev.find(p => p.name === co.name)?.workers ?? [], live, now()))
        return coordinatorRow(co, workers, terminals, now(), !!co.terminal && blocked.has(co.terminal))
      })
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
  // Inline, room for all seven sections; docked, a sidebar wide enough for one row.
  const r = await $.ui.open({ id: PANE, title: TITLE, rows: 48, columns: 56 })
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
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const s = await read($, snapshot)
    const shut = await read($, collapsed)
    const full = await read($, expanded)
    // A press shows a cut-off row in full, wrapped; another press cuts it again.
    const fold = (id: string, children: RenderChildren, dim = false) => {
      const isFull = full.includes(id)
      return (
        <Button key={`expand-${id}`} plain onPress={() => update($, expanded, list => (isFull ? list.filter(x => x !== id) : [...list, id]))}>
          <Text wrap={isFull ? 'wrap' : 'truncate-end'} dimColor={dim}>{children}</Text>
        </Button>
      )
    }
    const w = Math.max(24, e.props.bodyColumns)
    // Under 44 cells the secondary columns (handles, models, times, meters) drop out.
    const isWide = w >= 44

    const row = (left: RenderChildren, right?: RenderChildren, indent = 0) => (
      <Box flexDirection="row" justifyContent="space-between" columnGap="sm" paddingLeft={indent}>
        <Box flexShrink={1}>{left}</Box>
        {right ? <Box flexShrink={0}>{right}</Box> : ''}
      </Box>
    )
    const meter = (frac: number, color: string, cells = 8) => {
      const n = Math.round(Math.min(1, Math.max(0, frac)) * cells)
      return (
        <Text>
          <Text color={color}>{'█'.repeat(n)}</Text>
          <Text dimColor>{'░'.repeat(cells - n)}</Text>
        </Text>
      )
    }
    const section = (id: string, icon: string, title: string, sec: Section<unknown> | undefined, body: () => RenderChildren, extra?: RenderChildren) => {
      const isOpen = !shut.includes(id)
      return (
        <Box flexDirection="column">
          {row(
            <Button key={`toggle-${id}`} plain onPress={() => update($, collapsed, list => (isOpen ? [...list, id] : list.filter(x => x !== id)))}>
              <Text dimColor>{isOpen ? '▾' : '▸'} </Text>
              <Text weight="bold" color="claude">{icon} </Text>
              <Text weight="bold">{title}</Text>
              {extra ?? ''}
            </Button>,
            <Text dimColor tabular>{!sec ? 'waiting' : sec.at ? ago(sec.at) : 'never read'}</Text>,
          )}
          {sec?.error ? row(<Text color="warning" wrap="truncate-end">⚠ stale: {mask(sec.error)}</Text>, undefined, 2) : ''}
          {isOpen ? body() : ''}
        </Box>
      )
    }

    if (!s.config?.value)
      return (
        <Text color={s.config?.error ? 'error' : 'warning'} wrap="wrap">
          {s.config?.error ? `✗ Config ${configPath}: ${s.config.error}` : `◌ No config read yet from ${configPath}`}
        </Text>
      )

    const cfg = s.config.value
    const coords = s.coordinators?.value ?? []
    const workers = coords.flatMap(c => c.workers)
    const needYou = workers.filter(x => x.state === 'input').length
    const permission = workers.filter(x => x.state === 'permission').length + coords.filter(c => c.isWaitingPermission).length
    const stale = workers.filter(x => x.state === 'stale').length
    const envs = s.environments?.value ?? []
    const down = envs.filter(x => x.ready !== '200').length
    const m = s.machine?.value

    const worker = (wk: WorkerRow) => {
      const [icon, color, label] =
        wk.state === 'permission' ? ['■', 'error', 'waiting for permission']
        : wk.state === 'input' ? ['◐', 'error', 'needs you']
        : wk.state === 'stale' ? ['◌', 'warning', `stale ${wk.quietMinutes ?? '?'}m`]
        : wk.state === 'done' ? ['✓', 'subtle', 'done']
        : wk.state === 'failed' ? ['✗', 'error', 'failed']
        : ['●', 'success', 'running']
      return row(
        fold(`worker-${wk.handle ?? wk.name}`, [<Text color={color}>{icon} </Text>, mask(wk.name)], wk.state === 'done'),
        <Text>
          <Text color={color} weight={wk.state === 'input' || wk.state === 'permission' ? 'bold' : undefined} dimColor={wk.state === 'running'}>{label}</Text>
          {wk.pr ? <Text tabular> #{wk.pr}</Text> : ''}
        </Text>,
        2,
      )
    }

    return (
      <Box flexDirection="column" rowGap="md">
        {row(
          <Text wrap="truncate-end">
            {permission ? <Text color="error" weight="bold">■ {permission} permission  </Text> : ''}
            {needYou ? <Text color="error" weight="bold">◐ {needYou} need you  </Text> : ''}
            {permission || needYou || stale || down ? '' : <Text color="success">● all clear</Text>}
            {stale ? <Text color="warning">◌ {stale} stale  </Text> : ''}
            {down ? <Text color="error">▼ {down} env down</Text> : ''}
          </Text>,
          <Button key="refresh" plain hotkey="r" label="↻ refresh" onPress={() => { lastRemote = 0; void tick($).catch(() => {}) }} />,
        )}
        {section('coordinators', '◆', 'Coordinators', s.coordinators, () =>
          coords.map(c => {
            // Done rows fold into one count line; the rest show one row each.
            const active = c.workers.filter(x => x.state !== 'done')
            const done = c.workers.length - active.length
            return (
              <Box flexDirection="column">
                {row(
                  <Text weight="bold" wrap="truncate-end">{mask(c.name)}</Text>,
                  <Text>
                    <Text dimColor tabular>{isWide ? `${c.terminal}  ${c.model}  ` : ''}</Text>
                    {c.isWaitingPermission ? (
                      <Text color="error" weight="bold">■ waiting for permission</Text>
                    ) : (
                      <Text dimColor tabular>{c.quietMinutes !== undefined ? `${c.quietMinutes}m` : ''}</Text>
                    )}
                  </Text>,
                )}
                {active.map(worker)}
                {done ? row(<Text color="subtle" dimColor>✓ +{done} done</Text>, undefined, 2) : ''}
                {c.workers.length ? '' : row(<Text dimColor>no active workers</Text>, undefined, 2)}
              </Box>
            )
          }),
          workers.length ? <Text dimColor tabular>  {workers.filter(x => x.state !== 'done' && x.state !== 'failed').length}</Text> : undefined,
        )}
        {section('environments', '◎', 'Environments', s.environments, () =>
          envs.map(env => {
            const isUp = env.ready === '200'
            const color = !isUp ? 'error' : env.state === 'normal' ? 'success' : 'warning'
            return row(
              <Text wrap="truncate-end">
                <Text color={color}>{isUp ? '▲' : '▼'} </Text>
                <Text weight="bold">{env.name}</Text>
              </Text>,
              <Text tabular>
                <Text color={color}>{isUp ? env.state : `ready ${env.ready}`}</Text>
                {isWide ? <Text dimColor>  {new Date(env.checkedAt).toISOString().slice(11, 16)}Z</Text> : ''}
              </Text>,
            )
          }),
        )}
        {section('prs', '◇', 'Open PRs', s.prs, () =>
          (s.prs?.value ?? []).map(r => {
            const old = r.prs.filter(p => p.isOld).length
            // Each number costs its digits and a gap; as many as fit, then a count of the rest.
            let room = w - 6
            const shown = r.prs.filter(p => (room -= String(p.number).length + 2) >= 0)
            return (
              <Box flexDirection="column">
                {row(
                  fold(`repo-${r.repo}`, r.repo.split('/').pop() ?? r.repo, !r.prs.length),
                  <Text tabular>
                    {old ? <Text color="warning">◷ {old} old  </Text> : ''}
                    <Text weight="bold" dimColor={!r.prs.length}>{String(r.prs.length).padStart(2)}</Text>
                  </Text>,
                )}
                {shown.length ? (
                  <Box flexDirection="row" flexWrap="wrap" columnGap="sm" paddingLeft={2}>
                    {shown.map(p => (
                      <Link href={`https://github.com/${r.repo}/pull/${p.number}`}>
                        <Text color={p.isOld ? 'warning' : 'suggestion'}>#{p.number}</Text>
                      </Link>
                    ))}
                    {shown.length < r.prs.length ? <Text dimColor>+{r.prs.length - shown.length}</Text> : ''}
                  </Box>
                ) : ''}
              </Box>
            )
          }),
        )}
        {cfg.usageCommand.length
          ? section('usage', '◔', 'Usage', s.usage, () =>
              (s.usage?.value ?? []).map(u => {
                const [name = '', rest = ''] = mask(u).split(/:\s*(.*)/)
                return row(
                  <Text wrap="truncate-end">
                    <Text weight="bold">{name.padEnd(8)} </Text>
                    {rest.split(/(\d+%)/).map(part => {
                      const pct = /^\d+%$/.test(part) ? parseInt(part, 10) : -1
                      return pct < 0 ? <Text dimColor>{part}</Text> : <Text tabular color={pct >= 90 ? 'error' : pct >= 70 ? 'warning' : undefined}>{part}</Text>
                    })}
                  </Text>,
                )
              }),
            )
          : ''}
        {section('machine', '▣', 'Machine', s.machine, () => {
          if (!m) return <Text dimColor>no reading yet</Text>
          const loadLevel = m.load > 30 ? 'error' : m.load < 20 ? 'success' : 'warning'
          const freeLevel = m.freePercent < 25 ? 'error' : m.freePercent > 40 ? 'success' : 'warning'
          return [
            row(<Text>load</Text>, <Text tabular>{isWide ? meter(m.load / 30, loadLevel) : ''} <Text color={loadLevel}>{m.load.toFixed(1).padStart(5)}</Text></Text>),
            row(<Text>free memory</Text>, <Text tabular>{isWide ? meter(m.freePercent / 100, freeLevel) : ''} <Text color={freeLevel}>{`${m.freePercent}%`.padStart(5)}</Text></Text>),
          ]
        })}
        {cfg.ownerSteps
          ? section('steps', '☐', 'Owner steps', s.steps, () =>
              s.steps?.value?.length
                ? s.steps.value.map(t => {
                    const url = t.match(/https?:\/\/\S+/)?.[0]
                    return row(
                      fold(`step-${t.slice(0, 40)}`, [<Text color="warning">☐ </Text>, mask(url ? t.replace(url, '').trim() : t)]),
                      url ? <Link href={url}><Text color="suggestion">open ↗</Text></Link> : undefined,
                    )
                  })
                : <Text dimColor>✓ none open</Text>,
              s.steps?.value?.length ? <Text color="warning" tabular>  {s.steps.value.length}</Text> : undefined,
            )
          : ''}
        {cfg.mailbox
          ? section('mail', '✉', 'Mailbox', s.mail, () =>
              (s.mail?.value ?? []).map(r =>
                row(
                  <Text wrap="truncate-end">
                    {isWide ? <Text dimColor tabular>{r.at}  </Text> : ''}
                    <Text weight="bold">{r.from.padEnd(8)} </Text>
                    {r.subject}
                  </Text>,
                ),
              ),
            )
          : ''}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isPaneOpen))) return next(e)
    const s = await read($, snapshot)
    if (!s.config?.value) return next(e)
    const { Text } = $.ui.resolve(e)
    const workers = (s.coordinators?.value ?? []).flatMap(c => c.workers)
    const input = workers.filter(x => x.state === 'input').length
    const permission = workers.filter(x => x.state === 'permission').length + (s.coordinators?.value ?? []).filter(c => c.isWaitingPermission).length
    const stale = workers.filter(x => x.state === 'stale').length
    const envs = s.environments?.value ?? []
    const down = envs.filter(x => x.ready !== '200').length
    const prs = (s.prs?.value ?? []).reduce((n, r) => n + r.prs.length, 0)
    const m = s.machine?.value
    const steps = s.steps?.value?.length ?? 0
    return (
      <Text wrap="truncate-end">
        <Text color="claude" weight="bold">◆ chief  </Text>
        <Text>● {workers.filter(x => x.state !== 'done' && x.state !== 'failed').length} workers  </Text>
        {permission ? <Text color="error" weight="bold">■ {permission} permission  </Text> : ''}
        {input ? <Text color="error" weight="bold">◐ {input} need you  </Text> : ''}
        {stale ? <Text color="warning">◌ {stale} stale  </Text> : ''}
        <Text color={down ? 'error' : 'success'}>{down ? '▼' : '▲'} envs {envs.length - down}/{envs.length}  </Text>
        <Text>◇ {prs} PRs  </Text>
        {m ? <Text color={machineLevel(m)}>▣ load {m.load.toFixed(0)} free {m.freePercent}%  </Text> : ''}
        {steps ? <Text color="warning">☐ {steps} steps  </Text> : ''}
        <Text dimColor>/chief</Text>
      </Text>
    )
  })
}
