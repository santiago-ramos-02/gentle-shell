import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AGENT_MODE } from "./agents-config.ts";
import { isFinished, TASK_EVENT, TASK_STATUS, type TaskRecord, type TaskStore } from "./agents-protocol.ts";

// The review host relay runs each reviewer as an in-process model completion,
// not as a Gentle Agents child, so nothing would show it as an agent. gentle-ai
// reports each reviewer run on the shared `pi.events` bus and gentle-agents
// records it in its task store, which already publishes to the TUI card and to
// RPC hosts. The reviewer is a foreground task: the review tool waits for it.

export const REVIEW_REVIEWER_ACTIVITY_EVENT = "gentle-ai:review-reviewer";

/** What the relay knows about one reviewer run, before the caller adds its session. */
export type ReviewReviewerRun =
	| { type: "started"; id: string; agent: string; model: string; thinking: string | undefined; at: number }
	| { type: "finished"; id: string; text: string; at: number }
	| { type: "failed"; id: string; error: string; cancelled: boolean; at: number };

export type ReviewReviewerActivity =
	| (Extract<ReviewReviewerRun, { type: "started" }> & { parentSessionId: string; cwd: string })
	| Exclude<ReviewReviewerRun, { type: "started" }>;

/** Reports a session's reviewer runs on the bus; none without a session to show them in. */
export function reviewReviewerActivityReporter(
	events: Pick<ExtensionAPI["events"], "emit">,
	parentSessionId: string | undefined,
	cwd: string,
): ((run: ReviewReviewerRun) => void) | undefined {
	if (!parentSessionId) return undefined;
	return (run) => {
		const event: ReviewReviewerActivity = run.type === "started" ? { ...run, parentSessionId, cwd } : run;
		events.emit(REVIEW_REVIEWER_ACTIVITY_EVENT, event);
	};
}

function text(value: unknown, limit = 4096): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= limit;
}

/** Validates an untrusted bus payload. */
export function isReviewReviewerActivity(value: unknown): value is ReviewReviewerActivity {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Record<string, unknown>;
	if (!text(event.id, 128) || typeof event.at !== "number" || !Number.isFinite(event.at)) return false;
	switch (event.type) {
		case "started":
			return text(event.agent, 128) && text(event.model, 512) && text(event.parentSessionId, 512) && text(event.cwd)
				&& (event.thinking === undefined || typeof event.thinking === "string");
		case "finished":
			return typeof event.text === "string";
		case "failed":
			return typeof event.error === "string" && typeof event.cancelled === "boolean";
		default:
			return false;
	}
}

/** "review-resilience" reads as "Resilience review". */
function reviewerLabel(agent: string): string {
	const lens = agent.replace(/^review-/, "");
	return `${lens.charAt(0).toUpperCase()}${lens.slice(1)} review`;
}

/**
 * Applies one reviewer event to the store. Returns the record once it finishes,
 * so the caller can persist it; an event for an unknown or finished run is ignored.
 */
export function applyReviewReviewerActivity(store: TaskStore, event: ReviewReviewerActivity): TaskRecord | undefined {
	if (event.type === "started") {
		if (store.get(event.id)) return undefined;
		store.add({
			id: event.id,
			agent: event.agent,
			mode: AGENT_MODE.TASK,
			prompt: `Review the change through the ${event.agent.replace(/^review-/, "")} lens.`,
			label: reviewerLabel(event.agent),
			cwd: event.cwd,
			parentSessionId: event.parentSessionId,
			status: TASK_STATUS.RUNNING,
			createdAt: event.at,
			startedAt: event.at,
			endedAt: null,
			model: event.model,
			thinking: event.thinking,
			sessionPath: null,
			error: null,
			result: null,
			lastStep: "reviewing",
			lastActivityAt: event.at,
			turns: 0,
			toolCalls: 0,
			tokens: 0,
			cost: 0,
		});
		return undefined;
	}
	const current = store.get(event.id);
	if (!current || isFinished(current.status)) return undefined;
	if (event.type === "finished") {
		store.apply(event.id, { type: TASK_EVENT.TEXT, text: event.text }, event.at);
		store.apply(event.id, { type: TASK_EVENT.AGENT_END, text: event.text, outcome: "success" }, event.at);
		store.apply(event.id, { type: TASK_EVENT.TURN_END }, event.at);
		return store.update(event.id, { status: TASK_STATUS.COMPLETED, endedAt: event.at, lastStep: "done" });
	}
	store.apply(event.id, { type: TASK_EVENT.AGENT_END, text: "", outcome: event.cancelled ? "aborted" : "error", diagnostic: event.error }, event.at);
	return store.update(event.id, {
		status: event.cancelled ? TASK_STATUS.CANCELLED : TASK_STATUS.FAILED,
		endedAt: event.at,
		error: event.error,
		lastStep: event.error,
	});
}
