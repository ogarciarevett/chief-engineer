# Task status

Write `.orca/task-status.json` in each running worker's worktree. The panel reads
it; it never writes or estimates progress for a worker. Keep it out of commits.
Each worktree has one current task; terminals sharing it show the same status.

```json
{
  "task": "Fix login redirects",
  "pr": "#12",
  "state": "running",
  "left": "Review, then merge",
  "eta_utc": "2026-10-24T16:00:00Z",
  "updated": "2026-10-24T15:40:00Z"
}
```

All six fields are strings. Use a full UTC timestamp ending in `Z` for `updated`
and `eta_utc`; use an empty `eta_utc` when unknown. `pr` may be a number label or
URL, or empty. `state` and `left` are short descriptions, not inferred estimates.
The panel keeps only these fields, collapses whitespace and masks phone numbers.
Each field is limited to 2,000 characters; the file to 16 KiB. Write a temporary
file then rename it to avoid partial reads. Update it when the task changes.

Tasks groups follow config coordinators. Add `"parent": "Alpha"` to a
sub-coordinator to show it under `Alpha`; parent names must exist and cannot form
cycles. Workers discovered from terminal worktree prefixes belong to the most
specific matching coordinator. Dispatched workers retain their run's coordinator.
The terminal inventory supplies the worktree path; no filesystem scan is used.

One row appears for each active worker terminal, including workers waiting for
input or permission. Done and failed workers are omitted. Columns are task, PR,
state, what is left, ETA (UTC), and last update (UTC). Click a row or select it and
press Enter to read the full text. No valid status file means a terminal-title
row, unknown progress and ETA, and a `title only` marker. An update at least 20
minutes old, missing, or dated in the future is flagged `stale`.

Only the configured session reads files. It uses the existing 10-second local
timer and 15-second cache TTL (one read per distinct active worktree per TTL),
plus the existing remote inventory poll (60 seconds by default, minimum 30).
There are no new processes, per-worker timers, screen reads, or remote polls.
