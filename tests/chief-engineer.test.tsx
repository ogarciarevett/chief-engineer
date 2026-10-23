import { expect, mock, test } from 'claude-code/testing'

import {
  carryDone,
  mask,
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
} from '../hooks/readers'

const NOW = Date.parse('2026-10-23T16:00:00Z')
const CONFIG = {
  coordinators: [{ name: 'Alpha', terminal: 'term_alpha', run: 'run_a', model: 'model-x medium' }],
  environments: [{ name: 'Dev', url: 'https://dev.example.test' }],
  repos: ['example-org/web'],
  usageCommand: ['/bin/usage'],
  usageProviders: ['claude'],
  mailbox: '/tmp/inbox.jsonl',
  ownerSteps: '/tmp/steps.md',
}
const terminalsAt = (now: number) => JSON.stringify({
  result: {
    terminals: [
      { handle: 'term_alpha', lastOutputAt: now - 60_000, preview: 'ok' },
      { handle: 'term_w1', lastOutputAt: now - 2 * 60_000, preview: 'Do you want to proceed? (y/n)' },
      { handle: 'term_w2', lastOutputAt: now - 45 * 60_000, preview: 'SECRET=hunter2' },
      { handle: 'term_w3', lastOutputAt: now - 60_000, preview: '' },
    ],
  },
})
const TERMINALS = terminalsAt(NOW)
const TASKS = JSON.stringify({
  result: {
    tasks: [
      { display_name: 'w-input', status: 'dispatched', assignee_handle: 'term_w1' },
      { display_name: 'w-stale PR #1234', status: 'dispatched', assignee_handle: 'term_w2' },
      { display_name: 'w-busy', status: 'dispatched', assignee_handle: 'term_w3' },
      { display_name: 'w-done', status: 'completed', completed_at: '2026-10-23T15:30:00Z', result: '{"subject":"merged PR 77"}' },
      { display_name: 'w-old', status: 'completed', completed_at: '2026-10-23 10:00:00' },
      { display_name: 'w-queued', status: 'ready' },
    ],
  },
})

test('config: defaults fill in, bad shapes are refused, polls stay at 30 s or more', () => {
  const c = parseConfig(JSON.stringify({ ...CONFIG, pollSeconds: 5 }))
  expect(c.pollSeconds).toBe(30)
  expect(c.staleMinutes).toBe(30)
  expect(c.statusPath).toBe('/v1/system/status')
  expect(() => parseConfig('[]')).toThrow()
  expect(() => parseConfig(JSON.stringify({ repos: 'x' }))).toThrow()
  expect(() => parseConfig(JSON.stringify({ environments: [{ name: 'Dev', url: 'ftp://x' }] }))).toThrow()
})

test('workers: input, stale, running, recent done; old and queued drop off; PR numbers found', () => {
  const rows = parseWorkers(TASKS, parseTerminals(TERMINALS), NOW, 30)
  expect(rows.map(r => `${r.name}:${r.state}:${r.pr ?? ''}`)).toEqual([
    'w-input:input:',
    'w-stale PR #1234:stale:1234',
    'w-busy:running:',
    'w-done:done:77',
  ])
  // Terminal output only sets a flag: it never reaches a row.
  expect(JSON.stringify(rows).includes('hunter2')).toBe(false)
})

test('workers: one that leaves the dispatched list shows as done for an hour, then drops', () => {
  const prev = [{ name: 'w-a', state: 'running' as const, pr: '5' }, { name: 'w-b', state: 'stale' as const }]
  const now1 = carryDone(prev, [{ name: 'w-b', state: 'running' }], NOW)
  expect(now1).toEqual([{ name: 'w-b', state: 'running' }, { name: 'w-a', state: 'done', pr: '5', doneAt: NOW }])
  expect(carryDone(now1, [], NOW + 30 * 60_000).map(w => w.name)).toEqual(['w-b', 'w-a'])
  expect(carryDone(now1.slice(1), [], NOW + 61 * 60_000)).toEqual([])
})

test('environments: status field read, anything else is ?', () => {
  expect(parseEnvStatus('{"state":"normal"}', 'state')).toBe('normal')
  expect(parseEnvStatus('{"state":3}', 'state')).toBe('?')
})

test('prs: sorted, older than 24 h flagged', () => {
  const r = parsePrs('o/r', JSON.stringify([{ number: 9, createdAt: '2026-10-23T12:00:00Z' }, { number: 3, createdAt: '2026-10-21T12:00:00Z' }]), NOW)
  expect(r.prs).toEqual([{ number: 3, isOld: true }, { number: 9, isOld: false }])
})

test('usage: keeps the named providers only', () => {
  expect(parseUsage('claude: weekly 29%\ncodex: weekly 22%\n\n', ['claude'])).toEqual(['claude: weekly 29%'])
  expect(parseUsage('a: 1\nb: 2', []).length).toBe(2)
})

test('machine: parsed and coloured by the thresholds', () => {
  const m = parseMachine('{ 4.87 6.35 5.55 }', 'System-wide memory free percentage: 48%')
  expect(m).toEqual({ load: 4.87, freePercent: 48 })
  expect(machineLevel(m)).toBe('success')
  expect(machineLevel({ load: 25, freePercent: 48 })).toBe('warning')
  expect(machineLevel({ load: 31, freePercent: 48 })).toBe('error')
  expect(machineLevel({ load: 5, freePercent: 20 })).toBe('error')
  expect(() => parseMachine('', '')).toThrow()
})

test('owner steps: items with continuations, done ones hidden', () => {
  const md = '# Open owner steps\n\n- Sign in to TestNet\n  and report https://x.test/1\n- [x] Old step\n- [ ] Approve PR https://x.test/2\n'
  expect(parseSteps(md)).toEqual(['Sign in to TestNet and report https://x.test/1', 'Approve PR https://x.test/2'])
})

test('mailbox: last 5, newest first, names mapped, body never kept', () => {
  const lines = Array.from({ length: 7 }, (_, i) => JSON.stringify({ from: 'term_alpha', at: `2026-10-23T16:0${i}:00Z`, subject: `s${i}`, body: 'private' }))
  const rows = parseMail(lines.join('\n') + '\nnot json\n', new Map([['term_alpha', 'Alpha']]))
  expect(rows.map(r => r.subject)).toEqual(['s6', 's5', 's4', 's3', 's2'])
  expect(rows[0]).toEqual({ at: '16:06', from: 'Alpha', subject: 's6' })
  expect(JSON.stringify(rows).includes('private')).toBe(false)
  // Phone-like numbers are masked; times and PR numbers stay.
  const phone = parseMail(JSON.stringify({ from: '+34612345678', at: '2026-10-23T16:00:00Z', subject: 'call +34 612 345 678 about PR #1766' }), new Map())
  expect(phone[0]).toEqual({ at: '16:00', from: '[number]', subject: 'call [number] about PR #1766' })
  expect(mask('2026-10-23 16:00 #12345')).toBe('2026-10-23 16:00 #12345')
})

// Stands for the engine beneath the mod: every read answers from fixtures.
function engine(on: any, opts: { failEnv?: boolean; isPlaced?: boolean; failOrca?: boolean; htmlStatus?: boolean; garbageOrca?: boolean; config?: object } = {}) {
  const runs: string[][] = []
  mock.clock(on)
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'chief' } }))
  on('ui.open', () => ({ value: { isPlaced: opts.isPlaced ?? true } }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.read', (_$: any, e: any) => ({ value: e.path.endsWith('.md') ? '- Approve the release https://x.test/3\n' : JSON.stringify(opts.config ?? CONFIG) }))
  on('http.fetch', (_$: any, e: any) => {
    if (opts.failEnv) throw new Error('offline')
    const body = opts.htmlStatus ? '<html>502 Bad Gateway</html>' : '{"state":"normal"}'
    return { value: e.url.endsWith('/ready') ? { status: 200, ok: true, headers: {}, text: '' } : { status: 200, ok: true, headers: {}, text: body } }
  })
  on('process.run', (_$: any, e: any) => {
    runs.push(e.argv)
    const a = e.argv.join(' ')
    if (opts.garbageOrca && a.startsWith('orca')) return { value: { exitCode: 0, stdout: 'token=abc123 not json', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (opts.failOrca && a.startsWith('orca')) return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    const stdout = a.includes('terminal list')
      ? terminalsAt(Date.now())
      : a.includes('task-list')
        ? TASKS.replaceAll('2026-10-23T15:30:00Z', new Date(Date.now() - 60_000).toISOString())
        : a.startsWith('gh ')
          ? JSON.stringify([{ number: 42, createdAt: '2020-01-01T00:00:00Z' }])
          : a.includes('sysctl')
            ? '{ 4.0 3.0 2.0 }'
            : a.includes('memory_pressure')
              ? 'System-wide memory free percentage: 48%'
              : a.includes('tail')
                ? JSON.stringify({ from: 'term_alpha', at: '2026-10-23T16:05:00Z', subject: 'hello chief', body: 'x' })
                : 'claude: session 4%; weekly 29%\ncodex: weekly 22%'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return runs
}

const PANE = {
  plugin: 'chief-engineer',
  component: 'Pane',
  requestId: 'chief-engineer',
  props: { title: 'Chief engineer', isFocused: false, bodyColumns: 90, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane shows all seven panels from the config, on every surface', async ($, on) => {
  const runs = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    for (const words of [/Coordinators/, /Alpha  term_alpha  model-x medium/, /w-input  waiting for input/, /stale \d+m  #1234/, /Dev  ready 200  normal/, /web 1/, /#42/, /claude: session 4%/, /load 4\.0  free 48%/, /Approve the release/, /Alpha  hello chief/]) {
      expect((await ui.find({ type: 'Text', text: words }))?.text).toMatch(words)
    }
    expect(await ui.find({ type: 'Text', text: /codex/ })).toBe(undefined)
    await ui.unmount()
  }
  // Read-only commands only.
  for (const argv of runs) expect(['orca', 'gh', '/usr/sbin/sysctl', '/usr/bin/memory_pressure', '/usr/bin/tail', '/bin/usage']).toContain(argv[0])
  expect(runs.some(a => a.includes('--run') && a.includes('run_a'))).toBe(true)
})

test('an environment that does not answer reads as down, never a crash', async ($, on) => {
  engine(on, { failEnv: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Dev  ready down/ }))?.text).toMatch(/down/)
  await ui.unmount()
})

test('a section whose first read fails says so instead of waiting', async ($, on) => {
  engine(on, { failOrca: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Coordinators/ }))?.text).toMatch(/never read stale: orca exited 1/)
  // The other sections still draw.
  expect((await ui.find({ type: 'Text', text: /Dev  ready 200/ }))?.text).toMatch(/normal/)
  await ui.unmount()
})

test('a status page that is not JSON reads as ?, and the other rows stay', async ($, on) => {
  engine(on, { htmlStatus: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Dev  ready 200/ }))?.text).toMatch(/Dev  ready 200  \?  at/)
  expect(await ui.find({ type: 'Text', text: /html|Bad Gateway/ })).toBe(undefined)
  await ui.unmount()
})

test('unreadable output is reported without quoting it', async ($, on) => {
  engine(on, { garbageOrca: true })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Coordinators/ }))?.text).toMatch(/stale: output not readable/)
  expect(await ui.find({ type: 'Text', text: /abc123/ })).toBe(undefined)
  await ui.unmount()
})

test('a section left out of the config is hidden', async ($, on) => {
  engine(on, { config: { ...CONFIG, usageCommand: [], mailbox: '', ownerSteps: '' } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Machine/ }))?.text).toMatch(/Machine/)
  for (const gone of [/Usage/, /Owner steps/, /Mailbox/]) expect(await ui.find({ type: 'Text', text: gone })).toBe(undefined)
  await ui.unmount()
})

test('the band sums it up while the pane is closed', async ($, on) => {
  // A pane that is not seated counts as closed.
  engine(on, { isPlaced: false })
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'engine' }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'chief-engineer', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 160 } } as any)
  const text = (await band.find({ type: 'Text', text: /chief:/ }))?.text ?? ''
  expect(text).toMatch(/3 workers · 2 need you · envs 1\/1 ready · 1 PRs/)
  await band.unmount()
})
