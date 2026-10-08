# Command rules

Before Pi runs a shell command, gentle-pi checks it against its command rules. Each rule asks first (`confirm`), lets the command run (`allow`), or stops it (`block`). Hosts such as T3 Code edit the global rules through the gentle-pi API (`state` reads them, `commandRules.set` changes them); you can also edit the files by hand.

## Files

- Global: `~/.pi/gentle-ai/runtime-guardrails.json` (or `$GENTLE_PI_CONFIG_HOME/runtime-guardrails.json`).
- One project: `<project>/.pi/gentle-ai/runtime-guardrails.json`. Its `autonomousMode` replaces the global one, its rules merge over the global ones, and its custom commands are checked first.

A file gentle-pi cannot read makes every guarded command ask, and the API refuses to overwrite it.

```json
{
  "autonomousMode": true,
  "guardedCommands": { "gitPush": "allow", "fileDeletion": "confirm" },
  "customCommands": [
    { "pattern": "rm -rf node_modules", "action": "allow" },
    { "pattern": "rm -rf packages/sdk/convex/generated/*", "action": "allow" },
    { "pattern": "docker system prune *", "action": "block" }
  ]
}
```

## Rules

Rules apply only with `autonomousMode` on. With it off, every guarded command asks, whatever the rules say.

| Key | Covers | Default with autonomous mode on |
|---|---|---|
| `gitPush` | `git push` | allow |
| `gitRebase` | `git rebase` | confirm |
| `gitBranchDeleteForce` | `git branch -D` and forced deletes | confirm |
| `npmPublish` | `npm publish` | block |
| `piRemove` | `pi remove` | confirm |
| `fileDeletion` | recursive `rm`, `find -delete` | confirm |
| `databaseWipe` | SQL `DROP`, `TRUNCATE`, `DELETE` without `WHERE` | confirm |

## Custom commands

A custom command matches one whole command between shell operators (`;`, `&&`, `|`, …), with whitespace collapsed. In `cd w && rm -rf node_modules`, the pattern `rm -rf node_modules` decides the `rm` part only, and `rm -rf node_modules /tmp` does not match it. A `*` inside a word matches within that word, so `rm -rf dist/*` never covers `rm -rf dist/x /`. A `*` on its own matches any further arguments. A pattern must start with the command it covers. The first matching custom command decides its part of the command over the built-in rules, and custom commands can also guard commands no built-in rule covers.

## Always blocked

No rule or custom command changes these: recursive `rm` of `/`, `~`, `$HOME`, `.` or `..`; `git reset --hard`; `git clean -f`; force pushes; `chmod -R 777`; `chown -R`. Delegated children still block every recognized data-loss command; see [YOLO mode](yolo-mode.md#recognized-data-loss-boundary).
