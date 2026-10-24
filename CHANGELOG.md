# Changelog

## 0.3.0

- Rename to orchestrator-bar, including the plugin and command; read legacy config paths until safely migrated without changing the session selector.
- Add a Tasks table grouped by coordinator and sub-coordinator with remaining work, UTC ETA and update time, title fallback and 20-minute stale flags.
- Reuse the session gate, existing polling and 15-second cache TTL; no additional collector processes.

## 0.2.3

- The pane and its readers run only in the session named by the new `session` config key (Orca terminal handle or directory); every other session registers nothing and starts no process, and no key means no session. CPU comes from one `ps -A -o %cpu` sum over the cores, never `top`. Machine readings are shared through `~/Library/Caches/orchestrator-bar/machine.json` with a 15 s TTL.

## 0.2.2

- Machine section: `load 11.2 / 18 cores` with `ok`, `busy` or `overloaded`; `CPU used 62%`; `memory used 54% (19.4 of 36 GB)` with the bar filling for used; `swap used 5.8 of 7.2 GB`. Pressing load or swap shows one line on what it means. Bars are coloured by `limits` (load 30, swap 8 GB, memory 60 %).

## 0.2.1

- A worker name shows once with its newest state; done workers fold into one `+N done` line.
- New red state `waiting for permission` for a coordinator or worker whose screen shows a permission dialog (`screenCommand`, read once per remote poll).
- Usage lines keep only the key percentages.
- A cut-off row (owner step, worker, repo) opens in full when pressed, and closes on the next press.
- README: screenshot with demo data and copy-paste install steps at the top; inline is the default; the right dock needs `CLAUDE_CODE_NO_FLICKER=1` and 110+ columns; left is not possible in Claude Code 2.1.309.

## 0.2.0

- Sidebar redesign: icons, severity colours, actions, worktree workers.
