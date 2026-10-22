import assert from "node:assert/strict";
import test from "node:test";
import { TaskStore } from "../lib/agents-protocol.ts";
import { createRpcActivityPublisher } from "../lib/agents-rpc-publisher.ts";
import {
	applyReviewReviewerActivity,
	isReviewReviewerActivity,
	REVIEW_REVIEWER_ACTIVITY_EVENT,
	reviewReviewerActivityReporter,
	type ReviewReviewerActivity,
} from "../lib/review-reviewer-activity.ts";

const started: ReviewReviewerActivity = {
	type: "started", id: "review-1", agent: "review-resilience", model: "anthropic/claude-opus-5-5",
	thinking: "high", at: 1_000, parentSessionId: "session-1", cwd: "/repo",
};

test("a finished reviewer is a completed foreground task with its reply", () => {
	const store = new TaskStore();
	assert.equal(applyReviewReviewerActivity(store, started), undefined);
	assert.deepEqual(
		(({ agent, mode, label, status, model, parentSessionId }) => ({ agent, mode, label, status, model, parentSessionId }))(store.get("review-1")!),
		{ agent: "review-resilience", mode: "task", label: "Resilience review", status: "running", model: "anthropic/claude-opus-5-5", parentSessionId: "session-1" },
	);
	const finished = applyReviewReviewerActivity(store, { type: "finished", id: "review-1", text: "{\"findings\":[]}", at: 2_000 });
	assert.equal(finished?.status, "completed");
	assert.equal(finished?.result, "{\"findings\":[]}");
	assert.equal(finished?.endedAt, 2_000);
	assert.deepEqual(store.thread("review-1").items.at(-1), { kind: "text", text: "{\"findings\":[]}" });
});

test("a failed reviewer fails its task, and a cancelled one is cancelled", () => {
	const store = new TaskStore();
	applyReviewReviewerActivity(store, started);
	applyReviewReviewerActivity(store, { ...started, id: "review-2" });
	assert.equal(applyReviewReviewerActivity(store, { type: "failed", id: "review-1", error: "provider failed", cancelled: false, at: 2_000 })?.status, "failed");
	assert.equal(store.get("review-1")?.error, "provider failed");
	assert.equal(applyReviewReviewerActivity(store, { type: "failed", id: "review-2", error: "aborted", cancelled: true, at: 2_000 })?.status, "cancelled");
});

test("events for unknown or finished reviewers change nothing", () => {
	const store = new TaskStore();
	assert.equal(applyReviewReviewerActivity(store, { type: "finished", id: "nope", text: "x", at: 1 }), undefined);
	applyReviewReviewerActivity(store, started);
	applyReviewReviewerActivity(store, { type: "finished", id: "review-1", text: "done", at: 2 });
	assert.equal(applyReviewReviewerActivity(store, { type: "failed", id: "review-1", error: "late", cancelled: false, at: 3 }), undefined);
	assert.equal(store.get("review-1")?.status, "completed");
	applyReviewReviewerActivity(store, { ...started, agent: "review-risk" });
	assert.equal(store.get("review-1")?.agent, "review-resilience");
});

test("the reporter adds the session to the start and needs a session", () => {
	const emitted: Array<[string, unknown]> = [];
	const events = { emit: (channel: string, data: unknown) => { emitted.push([channel, data]); } };
	assert.equal(reviewReviewerActivityReporter(events, undefined, "/repo"), undefined);
	const report = reviewReviewerActivityReporter(events, "session-1", "/repo")!;
	report({ type: "started", id: "review-1", agent: "review-resilience", model: "anthropic/claude-opus-5-5", thinking: "high", at: 1_000 });
	report({ type: "finished", id: "review-1", text: "done", at: 2_000 });
	assert.deepEqual(emitted, [
		[REVIEW_REVIEWER_ACTIVITY_EVENT, started],
		[REVIEW_REVIEWER_ACTIVITY_EVENT, { type: "finished", id: "review-1", text: "done", at: 2_000 }],
	]);
	assert.ok(emitted.every(([, data]) => isReviewReviewerActivity(data)));
	assert.equal(isReviewReviewerActivity({ ...started, parentSessionId: "" }), false);
	assert.equal(isReviewReviewerActivity({ type: "failed", id: "review-1", at: 1 }), false);
});

test("a reviewer task is published to RPC hosts like any subagent", () => {
	const store = new TaskStore();
	const pushes: string[][] = [];
	const publisher = createRpcActivityPublisher({
		store,
		ui: { setWidget: (_key, lines) => { pushes.push(lines); } },
		now: () => 0,
		schedule: () => () => {},
		parentSessionId: "session-1",
		onError: (error) => { throw error; },
	});
	publisher.start();
	applyReviewReviewerActivity(store, started);
	applyReviewReviewerActivity(store, { type: "finished", id: "review-1", text: "{\"findings\":[]}", at: 2_000 });
	publisher.flush();
	const last = pushes.at(-1)?.join("\n") ?? "";
	assert.match(last, /review-resilience/);
	assert.match(last, /Resilience review/);
	assert.match(last, /\\"findings\\":\[\]/);
	publisher.stop();
});
