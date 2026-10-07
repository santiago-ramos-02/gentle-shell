# Background jobs — native background command monitoring

Branch: `feat/background-jobs`. Related: gentle-shell#1171 (orchestrator invents `sleep` to wait).
References: Claude Code background Bash (`run_in_background`, task notification, `TaskStop`, `Monitor`) and `@ksankar/pi-monitor`.

## Specs

- S1 — Problem, verbatim (L1): "quiero que agreguemos algo nativo a gentle shell para monitorizar ejecuciones en background, ahora mismo o gastamos un sub agente o el orquestador se queda esperando tontamente cno un sleep, ej: a que termine un ci."
- S2 — Shape, verbatim (L3, L5): "como lo que tiene claude code"; "Para gentle-shell, el mapeo mínimo sería: un flag `background` en la herramienta de shell que retorne un id, un registro de procesos vivos en el runtime de la sesión, y un hook en el loop de agente que, al terminar el proceso, encole un mensaje sintético y dispare un turno nuevo. El `Monitor` por líneas es una segunda etapa opcional sobre la misma infraestructura."
- S3 — `bash_background` runs a command with Pi's own shell execution (configured `shellPath` and `shellCommandPrefix`, process group, tree kill) and returns a job id and output file path immediately; the turn is not blocked. It is a sibling tool, not a `bash` override (L6).
- S4 — When the job exits, the parent is notified exactly once with a synthetic message (job id, label, command, exit code, duration, last output lines, output path) through the gentle-agents parent delivery router: steer into a running turn, or store + wake an idle parent. No polling.
- S5 — Wait conditions live inside the command (L5): "si querés esperar una condición, la condición se mete DENTRO del comando backgrounded", e.g. `until grep -q "Ready in" dev.log; do sleep 0.5; done` or `gh run watch <id> --exit-status`. The exit is the notification.
- S6 — stdout and stderr go to the output file, not the context; the model reads it with `read`.
- S7 — `job_stop` kills the job's whole process tree and sends no exit notice (the agent stopped it). A job a human stops from `/gentle:jobs` is reported once ("stopped by the user"), because the agent was promised a notice (L10). `job_list` lists the session's jobs with status.
- S8 — Jobs live in memory, are owned by the starting session, are capped at 25 running, and are killed on session shutdown.
- S9 — Human surface, verbatim (L7): "tendriamos que tener un modal como el de /gentle:agents para ver todos los procesos de monitoreo que hay para esta sesion"; plus a footer count of running jobs. Docs and orchestrator guidance tell the model to use `bash_background` instead of `sleep` loops or a subagent to wait.
- S10 — Stage 2, optional, needs a user decision before starting: `monitor`, one event per stdout line, 200 ms batching, mandatory timeout (max 30 min), auto-kill on event flood.

## Tasks

- T1 — S4: output tail core in `lib/background-jobs.ts`; inline; done, commits `848fb9c3e` (superseded scope), `bb9b3a258`.
- T2 — S3, S6, S7, S8: job registry on Pi `createLocalBashOperations` (output file, stop, cap); inline; done, commit `bb9b3a258`.
- T3 — S3-S8: tools `bash_background`/`job_stop`/`job_list` wired into the gentle-agents parent delivery router, shell guards cover `bash_background`; inline; done, commit 4d266722d.
- T4 — S9: `/gentle:jobs` overlay, footer count, palette entry, docs, orchestrator guidance; inline; done, commit 6eb41231f.
- T5 — S10: `monitor`; blocked on user decision.

## Log

- L1 (user): "quiero que agreguemos algo nativo a gentle shell para monitorizar ejecuciones en background, ahora mismo o gastamos un sub agente o el orquestador se queda esperando tontamente cno un sleep, ej: a que termine un ci."
- L2 (user, scope choice): "algo como esto https://pi.dev/packages/@ksankar/pi-monitor?name=background+monitor"
- L3 (user): "como lo que tiene claude code"
- L4 (decision, orchestrator): build natively (no third-party package) to reuse the gentle-agents parent delivery router. `CheckLater` out of scope.
- L5 (user, pasted Claude Code analysis): three pieces — `Bash` with `run_in_background` (one notification on exit, output to file, synthetic user message re-invokes the model, conditions inside the command), `Monitor` (one event per stdout line, mandatory timeout max 30 min, 200 ms batching, killed on flood), `TaskStop`. "Para gentle-shell, el mapeo mínimo sería: un flag `background` en la herramienta de shell que retorne un id, un registro de procesos vivos en el runtime de la sesión, y un hook en el loop de agente que, al terminar el proceso, encole un mensaje sintético y dispare un turno nuevo. El `Monitor` por líneas es una segunda etapa opcional sobre la misma infraestructura."
- L5 consequences: S3-S7 rewritten (pi-monitor `match`/`silence` and `bg_output` dropped; conditions go inside the command); S10 added as optional stage 2; T1 reopened to shrink the core.
- L6 (evidence): native `bash` must not be re-registered — commit `68080ea1f` removed the quiet-tools Bash override because it lost configured `shellPath`/`shellCommandPrefix` on Windows, and Pi rejects duplicate `bash` registrations from other tool-card packages. Pi exports `createLocalBashOperations({ shellPath })` (same executor as native bash: shell resolution, stdin transport, detached group, tree kill on abort, tracked PIDs) and `SettingsManager` (`getShellPath`, `getShellCommandPrefix`).
- L7 (user): "tendriamos que tener un modal como el de /gentle:agents para ver todos los procesos de monitoreo que hay para esta sesion" — S9 rewritten, T4 scope.
- L8 (user): "todo en un pr con size exception perdon que no dije nada" — one PR for the whole feature with a size exception; no chained PRs.
- L9 (evidence): `pnpm test` all three stages pass (unit 5039 tests incl. new), `check-types` no regressions, `check:runtime-modules` and `verify-package-files` pass. `orchestrator-delegation.md` guidance compacted to one line to stay under its 20,500 B budget (20,479 B).
- L10 (evidence, gentle-ai-verify): S3-S9 pass, no guard bypass; real-shell smoke kills the whole tree. Defect found: a human stop from the overlay left the agent waiting for a notice that never came. S7 rewritten; fixed with a "stopped by the user" notice.
- L11 (evidence, RDD): lineage review-a12f41f0623b2c3e, tier high (process_boundary), 4 lenses, **approved** and acknowledged (authority burned) on candidate tree 6bf3335 (main..f2b23768c). 16 advisory findings, none blocking; notable follow-ups: unbounded partial tail line (lib/background-jobs.ts:38-48), UTF-8 chunk split in tail (lib/background-jobs.ts:132), temp log dir retention, sleep-based test sync.
- L12 (delivery, user-authorized "Cerrar #1171 directamente"): #1171 labeled status:approved; branch pushed; PR gentle-shell#1835 (Closes #1171, type:feature, size:exception). CI at open: test (ubuntu-24.04) pass, others pending.
- L13 (user: "Si"): added job-notice regression tests mirroring #1833 for failed idle forward (requeue + bounded retry) and compaction hold (session_compact, session_compact_failed); mutation-checked (removing requeue or the hold route fails them); moved the misplaced settle comment.
