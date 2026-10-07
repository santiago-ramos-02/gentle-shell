// Background jobs.
//
// A background job runs a shell command while the parent keeps working or
// stays idle, so waiting on CI, a build, or a server never costs a sleep loop
// or a subagent. A wait condition lives inside the command itself (for
// example `until grep -q ready log; do sleep 1; done` or
// `gh run watch <id> --exit-status`): the job's exit is the notification.
//
// The registry owns live jobs and reports each job's own exit exactly once
// through `onSettled`. A stopped job reports nothing: whoever stopped it
// already knows. Execution goes through Pi's own shell operations
// (`createLocalBashOperations`), so the configured shell, the command
// transport, process groups, and process-tree kill match native Bash.

import { createWriteStream, type WriteStream } from "node:fs";
import { join } from "node:path";

/** The background sibling of Pi's native `bash` tool. */
export const BASH_BACKGROUND_TOOL = "bash_background";
/**
 * Tools whose `command` input runs in a shell. Command guards (confirmation,
 * YOLO, child safety) must cover every one of them, or the background tool
 * would bypass them.
 */
export const SHELL_COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", BASH_BACKGROUND_TOOL]);

/** Lines kept for the exit notice and job listings. */
export const TAIL_LINES = 20;
/** Running jobs allowed at once across the process. */
export const MAX_RUNNING_JOBS = 25;

/** Collects the last TAIL_LINES lines of a stream of output chunks. */
export function createOutputTail() {
	const complete: string[] = [];
	let partial = "";
	const clean = (line: string) => (line.endsWith("\r") ? line.slice(0, -1) : line);
	return {
		push(text: string) {
			const parts = (partial + text).split("\n");
			partial = parts.pop() ?? "";
			for (const part of parts) {
				complete.push(clean(part));
				if (complete.length > TAIL_LINES) complete.shift();
			}
		},
		lines(): string[] {
			const all = partial.length > 0 ? [...complete, clean(partial)] : [...complete];
			return all.slice(-TAIL_LINES);
		},
	};
}

/** The subset of Pi's `BashOperations` a job needs. */
export interface JobExecOperations {
	exec(command: string, cwd: string, options: { onData: (data: Buffer) => void; signal?: AbortSignal }): Promise<{ exitCode: number | null }>;
}

export type JobStatus = "running" | "exited" | "stopped" | "failed";

export interface JobRecord {
	readonly id: string;
	readonly label: string;
	readonly command: string;
	readonly cwd: string;
	readonly ownerSessionId: string;
	readonly outputPath: string;
	readonly startedAt: number;
	status: JobStatus;
	exitCode?: number | null;
	error?: string;
	endedAt?: number;
	/** Last output lines; refreshed until the job ends. */
	tail: string[];
}

export interface JobStartRequest {
	command: string;
	cwd: string;
	ownerSessionId: string;
	label?: string;
}

export interface JobRegistryDeps {
	/** Directory receiving one `<id>.log` file per job; read at each start. */
	outputDir(): string;
	now(): number;
	/** Resolved at each start so a changed shell setting applies to the next job. */
	shell(cwd: string): { operations: JobExecOperations; commandPrefix?: string };
	/** Called once when a job ends on its own (exited or failed), never for a stop. */
	onSettled(job: JobRecord): void;
}

export function createJobRegistry(deps: JobRegistryDeps) {
	const jobs = new Map<string, JobRecord>();
	const aborts = new Map<string, AbortController>();
	let counter = 0;

	const running = () => [...jobs.values()].filter((job) => job.status === "running").length;

	const finish = async (job: JobRecord, output: WriteStream, update: () => void) => {
		update();
		await new Promise<void>((resolve) => output.end(resolve));
		aborts.delete(job.id);
	};

	const start = (request: JobStartRequest): JobRecord => {
		if (running() >= MAX_RUNNING_JOBS) {
			throw new Error(`${MAX_RUNNING_JOBS} background jobs are already running; stop one with job_stop first.`);
		}
		const { operations, commandPrefix } = deps.shell(request.cwd);
		const id = `job-${++counter}`;
		const job: JobRecord = {
			id,
			label: request.label?.trim() || request.command,
			command: request.command,
			cwd: request.cwd,
			ownerSessionId: request.ownerSessionId,
			outputPath: join(deps.outputDir(), `${id}.log`),
			startedAt: deps.now(),
			status: "running",
			tail: [],
		};
		const output = createWriteStream(job.outputPath);
		output.on("error", () => { /* A lost log must not crash the session; the tail survives. */ });
		const tail = createOutputTail();
		const abort = new AbortController();
		jobs.set(id, job);
		aborts.set(id, abort);
		const execCommand = commandPrefix ? `${commandPrefix}\n${request.command}` : request.command;
		const onData = (data: Buffer) => {
			output.write(data);
			tail.push(data.toString("utf8"));
			job.tail = tail.lines();
		};
		operations.exec(execCommand, request.cwd, { onData, signal: abort.signal }).then(
			({ exitCode }) => finish(job, output, () => {
				if (job.status !== "running") return;
				job.status = "exited";
				job.exitCode = exitCode;
				job.endedAt = deps.now();
			}),
			(error: unknown) => finish(job, output, () => {
				if (job.status !== "running") return;
				job.status = "failed";
				job.error = error instanceof Error ? error.message : String(error);
				job.endedAt = deps.now();
			}),
		).then(() => {
			if (job.status === "exited" || job.status === "failed") deps.onSettled(job);
		});
		return job;
	};

	const stop = (id: string): JobRecord | undefined => {
		const job = jobs.get(id);
		if (!job) return undefined;
		if (job.status === "running") {
			job.status = "stopped";
			job.endedAt = deps.now();
			aborts.get(id)?.abort();
		}
		return job;
	};

	return {
		start,
		stop,
		get: (id: string) => jobs.get(id),
		/** Jobs in start order, optionally only those one session owns. */
		list: (ownerSessionId?: string) => [...jobs.values()].filter((job) => ownerSessionId === undefined || job.ownerSessionId === ownerSessionId),
		running,
		stopAll: () => { for (const id of jobs.keys()) stop(id); },
	};
}

export type JobRegistry = ReturnType<typeof createJobRegistry>;
