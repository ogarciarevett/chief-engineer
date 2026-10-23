# chief-engineer

A Claude Code mod for whoever runs several coordinators and their workers at once.
It keeps one sidebar beside the chat with the seven things a chief checks all
day, live, and a one-line band above the prompt while the pane is closed.

## What it shows

1. **Coordinators**: one row per coordinator (name, terminal handle, model and
   effort, minutes since its last output), with its workers underneath: task name,
   state (running, waiting for input, stale for N minutes, done, failed) and PR
   number. Workers are the coordinator's dispatched tasks plus every agent
   terminal under its `worktrees` (title and state only). Input rows are red,
   stale rows are yellow.
2. **Environments**: per environment, the HTTP code of `/ready`, the state field of
   the status endpoint, and the time of the last check.
3. **Open PRs** per repo: count and numbers; a PR older than 24 hours is yellow.
4. **Usage**: the lines of your usage command for the providers you name, with
   their reset times.
5. **Machine**: load average and free memory percent. Green under load 20 with
   over 40 % free, red above load 30 or under 25 % free, yellow between.
6. **Owner steps**: every open `- ` item of a Markdown file you maintain; `- [x]`
   items are hidden.
7. **Mailbox**: the last 5 messages of an append-only JSONL file (time, sender,
   subject). Message bodies are never shown.

Every section header shows an icon, the age of its last good read, and toggles the
section open or closed. A read that fails keeps the last value and adds a yellow
`⚠ stale:` note; it never closes the pane. The top row sums up what needs you and
has a refresh button (`r` while the pane has the keyboard). PR numbers and owner
step URLs are links.

The sidebar needs Claude Code's fullscreen layout: start the session with
`CLAUDE_CODE_NO_FLICKER=1` in a terminal at least 110 columns wide. Claude Code
places the dock on the right of the chat; a mod cannot move it. On the main-screen
layout, or under 110 columns, the same panel opens inline above the prompt, and
under 44 columns of pane width the secondary columns (handles, models, times,
meters) drop out.

![The pane with placeholder data](docs/screenshot.png)

## Install

At the prompt of a terminal session:

```
/plugin install chief-engineer --marketplace ogarciarevett/chief-engineer
```

From a shell:

```
claude plugin install chief-engineer --marketplace ogarciarevett/chief-engineer
```

Answer `y` to add the marketplace, then pick a scope.

To set the config path in the same step, add
`--config configPath=/absolute/path/config.json` to the shell line.

Otherwise point the mod at your config file. Copy `config.example.json` somewhere
outside any repo, edit it, and set the path in `/config` (field `Config file` of
`chief-engineer`) or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "chief-engineer": { "options": { "configPath": "/absolute/path/config.json" } } } }
```

The pane opens on session start when the terminal is wide enough. `/chief` opens
it at any time.

To run it from a checkout instead: `claude --plugin-dir /path/to/chief-engineer`.

## Config reference

| Field | Default | Meaning |
| --- | --- | --- |
| `pollSeconds` | `60` | Interval for remote reads (workers, environments, PRs, usage). Never under 30. Local reads (machine, owner steps, mailbox, config) run every 10 s. |
| `staleMinutes` | `30` | A dispatched worker whose terminal is quiet longer than this is stale. |
| `coordinators` | `[]` | `{ name, terminal?, run?, model?, worktrees? }`. `terminal` is the Orca terminal handle; `run` is the orchestration Run that holds its tasks; `worktrees` is a list of path prefixes whose agent terminals count as its workers. |
| `workersCommand` | `orca orchestration task-list --run {run} --status dispatched --brief --json` | Argv that lists a coordinator's live tasks; `{run}` is replaced. A worker that leaves this list shows as done for an hour. Output over 4 MiB is refused, so keep the filter. |
| `terminalsCommand` | `orca terminal list --json` | Argv that lists terminals with `lastOutputAt`. The output preview is used only to detect a waiting prompt and is never shown or stored. |
| `environments` | `[]` | `{ name, url }`, http or https. |
| `readyPath` | `/ready` | Path whose HTTP code is shown. |
| `statusPath` | `/v1/system/status` | Path that returns JSON with the state. |
| `statusField` | `state` | Field of that JSON to show. |
| `repos` | `[]` | `owner/repo` names; read with `gh pr list` (your own `gh` login). |
| `usageCommand` | `[]` | Argv of a command that prints one `provider: ...` line per provider. Empty hides the section. |
| `usageProviders` | `[]` | Providers to keep from that output; empty keeps every line. |
| `mailbox` | `""` | Path (`~/` allowed, as for `ownerSteps`) of a JSONL file with `{ at, from, subject }` per line. `from` values that match a coordinator's `terminal` show its name. |
| `ownerSteps` | `""` | Path of the Markdown file of open owner steps. |

## Rules it keeps

- Read-only commands only: `orca ... list`, `gh pr list`, `sysctl`, `memory_pressure`,
  `tail`, your usage command, and HTTP GETs.
- No paid API calls and no hosted service.
- It never shows message bodies, terminal output or environment variables.
- Phone-like numbers in any drawn text are masked as `[number]`, and an error
  from unreadable output is shown as `output not readable`, never quoted.
- Reads run on timers outside the prompt, so the prompt never waits for them.

## Status

Implemented and covered by `claude plugin test` (19 tests):

- Config parsing, defaults and validation; one assert-based test per data reader
  (workers, terminal workers, environments, PRs, usage, machine, owner steps, mailbox).
- Section headers collapse and reopen their section; PR numbers link to GitHub.
- The pane draws all seven sections from a config on the terminal and desktop
  surfaces; only the allowed read-only commands run.
- An environment that does not answer shows as down instead of failing.
- A section whose first read fails shows the error; a status page that is not
  JSON reads as `?`; a section with no source in the config is hidden; a worker that leaves the
  dispatched list shows as done for an hour.
- The band summary while the pane is closed.

Pending:

- Coordinator context percent: not shown; no cheap read-only source yet.
- Machine readings use macOS tools (`sysctl vm.loadavg`, `memory_pressure`); Linux
  is not supported yet.
- Done is not split from failed for workers that leave the dispatched list.
- Sections cut long lines to the pane width; the pane scrolls with the arrows while it has the keyboard.
- The dock side is Claude Code's: right of the chat in 2.1.309.

## Credits

Patterns (state atoms read while drawing, `$.clock.every` polling, tests that stand
in for `process.run` and `fs.read`) follow the MIT-licensed mods in
[hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods),
especially `mission-control`. No code was copied.

## Licence

MIT
