# Changelog

## 0.2.1

- A worker name shows once with its newest state; done workers fold into one `+N done` line.
- New red state `waiting for permission` for a coordinator or worker whose screen shows a permission dialog (`screenCommand`, read once per remote poll).
- Usage lines keep only the key percentages.
- A cut-off row (owner step, worker, repo) opens in full when pressed, and closes on the next press.
- README: screenshot with demo data and copy-paste install steps at the top; inline is the default; the right dock needs `CLAUDE_CODE_NO_FLICKER=1` and 110+ columns; left is not possible in Claude Code 2.1.309.

## 0.2.0

- Sidebar redesign: icons, severity colours, actions, worktree workers.
