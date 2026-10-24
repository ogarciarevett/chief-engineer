# orchestrator-bar

One live panel beside your Claude Code chat for people who run many coding agents at once.

[![ci](https://github.com/ogarciarevett/orchestrator-bar/actions/workflows/ci.yml/badge.svg)](https://github.com/ogarciarevett/orchestrator-bar/actions/workflows/ci.yml)
![version 0.3.0](https://img.shields.io/badge/version-0.3.0-blue)
![MIT](https://img.shields.io/badge/licence-MIT-green)

![A Claude Code session in a terminal with the orchestrator-bar panel docked on the right](docs/screenshot.png)

*A normal Claude Code session (left) with the panel docked on the right. Demo data:
two coordinators, their workers, three environments, open PRs, usage, machine load,
owner steps and the mailbox.*

## Install

```
claude plugin install orchestrator-bar --marketplace ogarciarevett/orchestrator-bar --scope user --config configPath=$HOME/.config/orchestrator-bar/config.json
```

## Quick start

```
# 1. Get the example config, then put your coordinators, repos and environments in it,
#    and set "session" to the one session that runs the pane (no key: no session runs it)
mkdir -p ~/.config/orchestrator-bar
curl -fsSL https://raw.githubusercontent.com/ogarciarevett/orchestrator-bar/main/config.example.json -o ~/.config/orchestrator-bar/config.json

# 2. Start Claude Code fullscreen in a terminal at least 110 columns wide
CLAUDE_CODE_NO_FLICKER=1 claude
```

The panel docks on the right of the chat. In a normal (not fullscreen) session it
opens inline above the prompt; `/orchestrator-bar` opens it at any time.
While the pane is closed, a one-line band above the prompt sums up what needs you.

## Why it is different

- **One screen for the work.** Workers, environments, PRs, usage limits, machine load,
  tasks, your open steps and the mailbox stay beside the chat you are already in.
- **It finds stuck agents.** A coordinator or worker that sits on a permission
  dialog turns red and moves to the top.
- **Read-only.** It runs only list and read commands, your own usage command,
  and HTTP GETs. No hosted
  service, no paid API calls, no API key.
- **It never shows secrets.** No message bodies, terminal output or environment
  variables; phone-like numbers are masked.
- **Tested.** the test suite run in CI with `claude plugin test`; the status list below
  says what is done and what is not.

## Install details

At the prompt of a session you can also run
`/plugin install orchestrator-bar --marketplace ogarciarevett/orchestrator-bar`
(answer `y` to add the marketplace, then pick a scope).

Keep the config outside any repo. To change its path later,
use `/config` (field `Config file` of `orchestrator-bar`) or `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "orchestrator-bar": { "options": { "configPath": "/absolute/path/config.json" } } } }
```

To run it from a checkout instead: `claude --plugin-dir /path/to/orchestrator-bar`.

## Upgrading from chief-engineer

Install `orchestrator-bar` with the command above, disable the old plugin, and
move its `configPath` option to the new plugin entry. Keep the same `session`
selector so only that session runs the panel. Use `/orchestrator-bar` to open it.
If the renamed config path does not exist, the plugin reads the corresponding
`chief-engineer` path once and copies it to the new path. It never overwrites an
existing config or changes its session selector. After migration, only the new
path is read. Restart the configured session after updating the plugin.

## What it shows

1. **Coordinators**: one row per coordinator (name, terminal handle, model and
   effort, minutes since its last output), with its workers underneath: task name,
   state (waiting for permission, waiting for input, stale for N minutes, running,
   done, failed) and PR number. Workers are the coordinator's dispatched tasks plus
   every agent terminal under its `worktrees` (title and state only). A worker name
   shows once, with its newest state; done workers fold into one `+N done` line.
   A coordinator or worker whose screen shows a permission dialog is red and
   listed first. Input rows are red, stale rows are yellow.
2. **Tasks**: one row per active worker, grouped by coordinator and sub-coordinator,
   with task, PR, state, what is left, ETA (UTC), and last update. Workers write
   `.orca/task-status.json` in their worktree; missing files fall back to terminal
   titles, with unknown progress and ETA. Updates at least 20 minutes old are
   flagged stale. See [the format and example](docs/task-status.md).
3. **Environments**: per environment, the HTTP code of `/ready`, the state field of
   the status endpoint, and the time of the last check.
4. **Open PRs** per repo: count and numbers; a PR older than 24 hours is yellow.
5. **Usage**: the key percentages (`session 12%`, `weekly 31%`) of your usage
   command for the providers you name, with known reset times; other detail is
   dropped.
6. **Machine**: four lines.
   - `load 11.2 / 18 cores ok`: programs running or waiting for a CPU. `ok` under
     the core count, `busy` from the core count to `limits.load` (30), `overloaded`
     over it. Over the core count programs wait; over 30 the Mac freezes, so stop
     new heavy work.
   - `CPU used 62%`: all cores together, over the last second.
   - `memory used 54% (19.4 of 36 GB)`: the bar fills for used memory.
   - `swap used 5.8 of 7.2 GB`: memory moved to disk. Over 8 GB the Mac slows down.

   Load and swap rows show this help in one line when you press them. A bar is
   yellow from 80 % of its limit and red over it (`limits` in the config). The CPU bar uses a fixed limit of 90 %.
7. **Owner steps**: every open `- ` item of a Markdown file you maintain; `- [x]`
   items are hidden.
8. **Mailbox**: the last 5 messages of an append-only JSONL file (time, sender,
   subject). Message bodies are never shown.

Every section header shows an icon, the age of its last good read, and toggles the
section open or closed. A read that fails keeps the last value and adds a yellow
`⚠ stale:` note; it never closes the pane. The top row sums up what needs you and
has a refresh button (`r` while the pane has the keyboard). PR numbers and owner
step URLs are links. A cut-off row (an owner step, a worker, a repo) shows in full,
wrapped, when you click it or select it and press Enter; press it again to cut it.

The panel opens inline above the prompt by default. The right dock needs Claude
Code's fullscreen layout: start the session with `CLAUDE_CODE_NO_FLICKER=1` in a
terminal at least 110 columns wide. A dock on the left is not possible in Claude
Code 2.1.309; a mod cannot move it. Under 44 columns of pane width the secondary
columns (handles, models, times, meters) drop out.

## Config reference

| Field | Default | Meaning |
| --- | --- | --- |
| `pollSeconds` | `60` | Interval for remote reads (workers, environments, PRs, usage). Never under 30. Local reads (machine, owner steps, mailbox, config) run every 10 s. |
| `staleMinutes` | `30` | A dispatched worker whose terminal is quiet longer than this is stale. |
| `coordinators` | `[]` | `{ name, parent?, terminal?, run?, model?, worktrees? }`. `parent` names a parent coordinator for Tasks grouping; `terminal` is the Orca terminal handle; `run` is the orchestration Run that holds its tasks; `worktrees` is a list of path prefixes whose agent terminals count as its workers. |
| `workersCommand` | `orca orchestration task-list --run {run} --status dispatched --brief --json` | Argv that lists a coordinator's live tasks; `{run}` is replaced. A worker that leaves this list shows as done for an hour. Output over 4 MiB is refused, so keep the filter. |
| `terminalsCommand` | `orca terminal list --json` | Argv that lists terminals with `lastOutputAt`. The output preview is used only to detect a waiting prompt and is never shown or stored. |
| `screenCommand` | `orca terminal read --terminal {handle} --screen --json` | Argv that reads the rendered screen of a shown terminal, once per remote poll, to detect a permission dialog (`Do you want to proceed?`, `Esc to cancel`, `Allow command?`, trust prompts) in its last 20 rows (`Allow command?`, or two of the other markers). Only the match leaves the reader; the screen is never shown or stored. |
| `environments` | `[]` | `{ name, url }`, http or https. |
| `readyPath` | `/ready` | Path whose HTTP code is shown. |
| `statusPath` | `/v1/system/status` | Path that returns JSON with the state. |
| `statusField` | `state` | Field of that JSON to show. |
| `repos` | `[]` | `owner/repo` names; read with `gh pr list` (your own `gh` login). |
| `usageCommand` | `[]` | Argv of a command that prints one `provider: ...` line per provider. Empty hides the section. |
| `usageProviders` | `[]` | Providers to keep from that output; empty keeps every line. |
| `mailbox` | `""` | Path (`~/` allowed, as for `ownerSteps`) of a JSONL file with `{ at, from, subject }` per line. `from` values that match a coordinator's `terminal` show its name. |
| `ownerSteps` | `""` | Path of the Markdown file of open owner steps. |
| `session` | none | The one session that runs the pane: `{ "orcaTerminalHandle": "term_..." }` (matched against `ORCA_TERMINAL_HANDLE`) or `{ "cwd": "/path" }` (the session directory). Every other session registers nothing and starts no process; with no key, no session does. |
| `limits` | `{ "load": 30, "swapGB": 8, "memoryPercent": 60 }` | Machine limits. Load over `load` is overloaded; swap and memory bars turn red over theirs. Set only the ones you change. |

## Rules it keeps

- Read-only commands only: `orca ... list`, `orca terminal read --screen`, `gh pr list`, `sysctl`, `memory_pressure`, `ps -A -o %cpu`,
  `tail`, your usage command, and HTTP GETs.
- No paid API calls and no hosted service.
- It never shows message bodies, terminal output or environment variables.
- Phone-like numbers in any drawn text are masked as `[number]`, and an error
  from unreadable output is shown as `output not readable`, never quoted.
- Reads run on timers outside the prompt, so the prompt never waits for them.

## Status

Implemented and covered by `claude plugin test` (the test suite):

- Config parsing, defaults and validation; one assert-based test per data reader
  (workers, terminal workers, worker merge, permission dialogs, environments, PRs,
  usage, machine, owner steps, mailbox).
- Section headers collapse and reopen their section; a cut-off row opens in full
  and closes again; PR numbers link to GitHub.
- The pane draws all eight sections from a config on the terminal and desktop
  surfaces; only the allowed read-only commands run.
- An environment that does not answer shows as down instead of failing.
- A section whose first read fails shows the error; a status page that is not
  JSON reads as `?`; a section with no source in the config is hidden; a worker that leaves the
  dispatched list shows as done for an hour.
- The band summary while the pane is closed.

Pending:

- Coordinator context percent: not shown; no cheap read-only source yet.
- Machine readings use macOS tools (`sysctl`, `memory_pressure`, `ps`); Linux
  is not supported yet.
- Done is not split from failed for workers that leave the dispatched list.
- Sections cut long lines to the pane width; the pane scrolls with the arrows while it has the keyboard.
- The dock side is Claude Code's: right of the chat in 2.1.309; left is not possible.

## Credits

Patterns (state atoms read while drawing, `$.clock.every` polling, tests that stand
in for `process.run` and `fs.read`) follow the MIT-licensed mods in
[hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods),
especially `mission-control`. No code was copied.

## Licence

MIT
