// Model-facing surface of background jobs: the `bash_background`, `job_stop`,
// and `job_list` tools, the exit notice text, and its transcript card.
// Delivery of the notice belongs to the caller (Gentle Agents' parent
// delivery router), so this module never sends messages itself.

import { keyHint, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BASH_BACKGROUND_TOOL, MAX_RUNNING_JOBS, type JobRecord, type JobRegistry } from "./background-jobs.ts";
import { CARD_TONE, renderCard, type CardTheme } from "./shell-card.ts";
import { sanitizeTerminalText } from "./terminal-theme.ts";

export const JOB_NOTICE_TYPE = "gentle-jobs.notice";
export const JOB_GLYPH = "⧗";

export function formatJobDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const quoted = (job: JobRecord) => `${job.id} ("${job.label}")`;

/** One-line outcome, shared by the notice, the list, and the jobs view. */
export function jobOutcome(job: JobRecord): string {
	if (job.status === "running") return "running";
	if (job.status === "stopped") return "stopped";
	if (job.status === "failed") return `could not run: ${job.error ?? "unknown error"}`;
	return job.exitCode === null || job.exitCode === undefined ? "exited without an exit code" : `exited with code ${job.exitCode}`;
}

/** Model-facing exit notice: everything needed to act without polling. */
export function jobNoticeText(job: JobRecord): string {
	const duration = job.endedAt === undefined ? "" : ` after ${formatJobDuration(job.endedAt - job.startedAt)}`;
	// Only a human stops a job without the agent knowing (job_stop sends no notice).
	const outcome = job.status === "stopped" ? "was stopped by the user" : jobOutcome(job);
	const lines = [`Background job ${quoted(job)} ${outcome}${duration}.`, `Command: ${job.command}`];
	if (job.tail.length > 0) lines.push("Last output:", ...job.tail);
	else lines.push("No output.");
	lines.push(`Full output: ${job.outputPath} (read it with the read tool if you need more).`);
	return lines.join("\n");
}

function listLine(job: JobRecord, now: number): string {
	const ended = job.endedAt ?? now;
	const status = job.status === "exited" ? `exited ${job.exitCode ?? "?"}` : job.status;
	return `${job.id} · ${status} · ${job.label} · ${formatJobDuration(ended - job.startedAt)} · ${job.outputPath}`;
}

type ToolText = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
const text = (value: string, details: Record<string, unknown> = {}): ToolText => ({ content: [{ type: "text", text: value }], details });
const jobDetails = (job: JobRecord) => ({ gentleJobs: { jobId: job.id, label: job.label, status: job.status, exitCode: job.exitCode ?? null, outputPath: job.outputPath } });

export interface BackgroundJobToolsOptions {
	registry: JobRegistry;
	/** The session the tool call runs in; jobs belong to it. */
	sessionId(ctx: ExtensionContext): string;
	now(): number;
	/** Called after a job starts or stops, so views can refresh. */
	onChange?(): void;
}

export function registerBackgroundJobTools(pi: ExtensionAPI, options: BackgroundJobToolsOptions): void {
	const { registry } = options;
	const owned = (ctx: ExtensionContext, id: string) => {
		const job = registry.get(id);
		return job && job.ownerSessionId === options.sessionId(ctx) ? job : undefined;
	};

	pi.registerTool({
		name: BASH_BACKGROUND_TOOL,
		label: "Bash (background)",
		description: [
			"Run a shell command in the background and return a job id at once. You are notified once, automatically, when it exits (exit code, last output lines, output file); do not poll, sleep, or delegate a subagent to wait.",
			"Use it for anything you would otherwise wait on: CI, builds, long tests, deploys, servers.",
			"Put the wait condition inside the command so its exit is the event, e.g. `gh run watch <run-id> --exit-status` or `until curl -sf localhost:3000/health; do sleep 1; done`.",
			`Output goes to a file you can read with the read tool. Stop a job with job_stop; list jobs with job_list. At most ${MAX_RUNNING_JOBS} run at once.`,
		].join(" "),
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["command"],
			properties: {
				command: { type: "string", description: "Shell command to run in the background, in the session working directory." },
				label: { type: "string", maxLength: 80, description: "Short human-readable label, e.g. 'CI for PR 1834'." },
			},
		} as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const input = params as { command?: unknown; label?: unknown };
			if (typeof input.command !== "string" || !input.command.trim()) throw new Error("bash_background requires a non-empty command");
			const job = registry.start({ command: input.command, cwd: ctx.cwd, ownerSessionId: options.sessionId(ctx), label: typeof input.label === "string" ? input.label : undefined });
			options.onChange?.();
			return text(
				`Started background job ${quoted(job)}.\nOutput: ${job.outputPath}\nYou will be notified once when it exits; keep working or end your turn. Stop it with job_stop.`,
				jobDetails(job),
			);
		},
	});

	pi.registerTool({
		name: "job_stop",
		label: "Stop background job",
		description: "Stop a background job started with bash_background, killing its whole process tree. A stopped job sends no exit notice.",
		parameters: { type: "object", additionalProperties: false, required: ["job_id"], properties: { job_id: { type: "string" } } } as never,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const id = (params as { job_id?: unknown }).job_id;
			const job = typeof id === "string" ? owned(ctx, id) : undefined;
			if (!job) throw new Error(`No background job ${String(id)} in this session. Use job_list to see this session's jobs.`);
			const wasRunning = job.status === "running";
			registry.stop(job.id);
			options.onChange?.();
			return text(wasRunning ? `Stopped ${quoted(job)}.` : `${quoted(job)} was already ${jobOutcome(job)}.`, jobDetails(job));
		},
	});

	pi.registerTool({
		name: "job_list",
		label: "List background jobs",
		description: "List this session's background jobs with status, label, elapsed time, and output file.",
		parameters: { type: "object", additionalProperties: false, properties: {} } as never,
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const jobs = registry.list(options.sessionId(ctx));
			if (jobs.length === 0) return text("No background jobs in this session.");
			const now = options.now();
			return text(jobs.map((job) => listLine(job, now)).join("\n"), { gentleJobs: { count: jobs.length } });
		},
	});

	pi.registerMessageRenderer(JOB_NOTICE_TYPE, (message, renderOptions, theme) => {
		const details = (message.details as { gentleJobs?: { label?: string; status?: string; exitCode?: number | null } } | undefined)?.gentleJobs;
		const content = typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const lines = sanitizeTerminalText(content).split("\n");
		const tone = details?.status === "exited" && details.exitCode === 0 ? CARD_TONE.SUCCESS : CARD_TONE.ERROR;
		let hint: string;
		try { hint = keyHint("app.tools.expand", renderOptions.expanded ? "collapse" : "expand"); } catch { hint = renderOptions.expanded ? "collapse" : "expand"; }
		return {
			render(width: number) {
				return renderCard({ title: "Background job", subtitle: details?.label, body: lines, tone, glyph: JOB_GLYPH }, theme as CardTheme, width, { expanded: renderOptions.expanded, previewRows: 3, hint });
			},
			invalidate() {},
		};
	});
}
