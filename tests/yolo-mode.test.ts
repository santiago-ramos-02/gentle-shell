import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureReviewSessionIdentity, grantReviewSessionPermission, hasReviewSessionPermission, revokeReviewSessionPermission } from "../lib/review-session-standing-permission.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGentleAiExtension } from "../extensions/gentle-ai.ts";

export function harness(env: NodeJS.ProcessEnv = {}) {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const tools: string[] = [];
	const notices: string[] = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	let confirmations = 0;
	let sessionId = "yolo-test";
	const ctx = {
		cwd: process.cwd(), mode: "tui", hasUI: true,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (text: string) => notices.push(text),
			setStatus: (key: string, text?: string) => statuses.set(key, text),
			setWidget: (key: string, value: unknown) => widgets.set(key, value),
			confirm: async () => { confirmations++; return false; },
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list);
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command),
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		registerMessageRenderer() {}, registerFlag() {},
		events: { emit() {}, on: () => () => {} },
		getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	createGentleAiExtension({ nativeReviewCli: null, candidateViews: null, processEnv: env,
		resolveTelemetryTriggerBinary: () => { throw new Error("disabled in test"); },
	})(pi);
	return { ctx, commands, tools, notices, statuses, widgets, confirmations: () => confirmations,
		setSessionId: (id: string) => { sessionId = id; },
		command: async (args: string) => { const cmd = commands.get("yolo"); assert.ok(cmd, "/yolo registered"); await cmd.handler(args, ctx); },
		emit: async (name: string, event: unknown) => {
			let result: unknown; for (const fn of handlers.get(name) ?? []) { const next = await fn(event, ctx); if (next !== undefined) result = next; } return result;
		},
	};
}

test("human command on/off/status/toggle/invalid and status/widget clearing", async () => {
	const h = harness();
	assert.equal(h.tools.some((name) => name.includes("yolo")), false);
	await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
	await h.command("on");
	assert.equal(h.statuses.get("gentle:yolo"), "YOLO ON — destructive confirmations remain");
	assert.deepEqual(h.widgets.get("gentle:yolo"), ["YOLO ON — destructive confirmations remain"]);
	await h.command("invalid"); await h.command("status"); assert.match(h.notices.at(-1)!, /ON/);
	await h.command(""); assert.equal(h.statuses.get("gentle:yolo"), undefined);
	assert.equal(h.widgets.get("gentle:yolo"), undefined);
	await h.command(""); await h.command("off"); await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
});

test("revocation wins over an activation still awaiting Git identity", async () => {
	for (const reason of ["off", "reload", "new", "resume", "fork", "quit"]) {
		const h = harness();
		const pending = h.command("on");
		if (reason === "off") await h.command("off");
		else await h.emit("session_shutdown", { reason });
		await pending;
		await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
		assert.equal(h.widgets.get("gentle:yolo"), undefined);
	}
});

test("child, headless, RPC and unidentified repository cannot activate", async () => {
	for (const variant of ["child", "headless", "rpc", "no-repository"]) {
		const h = harness(variant === "child" ? { GENTLE_PI_AGENTS_CHILD: "1" } : {});
		if (variant === "headless") Object.assign(h.ctx, { hasUI: false });
		if (variant === "rpc") Object.assign(h.ctx, { mode: "rpc" });
		if (variant === "no-repository") Object.assign(h.ctx, { cwd: "/" });
		await h.command("on"); assert.notEqual(h.statuses.get("gentle:yolo"), "YOLO ON — destructive confirmations remain");
	}
});

test("structured primary prompt gains and loses directive; named child does not inherit", async () => {
	const h = harness();
	const options = { appendSystemPrompt: "base" };
	const event = { systemPromptOptions: options, prompt: "task", systemPrompt: "base" };
	await h.command("on"); await h.emit("before_agent_start", event);
	assert.match(options.appendSystemPrompt, /YOLO session standing permission/);
	await h.command("off"); await h.emit("before_agent_start", event);
	assert.doesNotMatch(options.appendSystemPrompt, /YOLO session standing permission/);
	await h.command("on");
	await h.emit("before_agent_start", { ...event, agent: { name: "worker" } });
	assert.doesNotMatch(options.appendSystemPrompt, /YOLO session standing permission/);
	assert.ok(await h.emit("tool_call", { toolName: "bash", input: { command: "git push origin main" } }), "named child has no push waiver");
});

test("session loss and shutdown (including reload) revoke visible state", async () => {
	for (const reason of ["new", "resume", "fork", "reload", "quit"]) {
		const h = harness(); await h.command("on");
		const event = { prompt: "task", systemPromptOptions: { appendSystemPrompt: "base" } };
		await h.emit("before_agent_start", event);
		assert.match(event.systemPromptOptions.appendSystemPrompt, /YOLO session standing permission/);
		await h.emit("session_shutdown", { reason });
		assert.equal(h.widgets.get("gentle:yolo"), undefined);
		assert.equal(h.statuses.get("gentle:yolo"), undefined);
		await h.emit("before_agent_start", event);
		assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /YOLO session standing permission/);
		await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
	}
	const h = harness(); await h.command("on"); h.setSessionId("replacement");
	await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
});

test("active YOLO waives only ordinary push after full destructive/guard evaluation", async () => {
	const h = harness();
	const call = (command: string) => h.emit("tool_call", { toolName: "bash", input: { command } });
	assert.deepEqual(await call("git push origin main"), { block: true, reason: "Gentle AI safety policy blocked the command because it was not confirmed." });
	await h.command("on");
	assert.equal(await call("git push origin main"), undefined);
	assert.equal(h.confirmations(), 1);
	for (const command of ["git push origin main && rm -rf ./data", `sh -c "psql -c 'DROP TABLE users'"`, "git push origin main && git rebase main", "git push --force origin main", "git push origin main && npm publish", "git -C /other push origin main", "sh -c 'git push origin main'"]) {
		assert.ok(await call(command), command);
	}
	await h.command("off"); assert.ok(await call("git push origin main"));
});

test("active command path preserves configured push confirmations and blocks, including legacy env override", async () => {
	const configHome = mkdtempSync(join(tmpdir(), "gentle-yolo-config-"));
	const previousHome = process.env.GENTLE_PI_CONFIG_HOME;
	const previousAutonomy = process.env.GENTLE_PI_AUTONOMOUS_MODE;
	process.env.GENTLE_PI_CONFIG_HOME = configHome;
	try {
		for (const envOverride of [undefined, "1"]) {
			if (envOverride === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE;
			else process.env.GENTLE_PI_AUTONOMOUS_MODE = envOverride;
			for (const action of ["confirm", "block"]) {
				writeFileSync(join(configHome, "runtime-guardrails.json"), JSON.stringify({ autonomousMode: false, guardedCommands: { gitPush: action } }));
				const h = harness(); await h.command("on");
				assert.ok(await h.emit("tool_call", { toolName: "bash", input: { command: "git push origin main" } }));
				assert.equal(h.confirmations(), action === "confirm" ? 1 : 0);
			}
		}
	} finally {
		if (previousHome === undefined) delete process.env.GENTLE_PI_CONFIG_HOME; else process.env.GENTLE_PI_CONFIG_HOME = previousHome;
		if (previousAutonomy === undefined) delete process.env.GENTLE_PI_AUTONOMOUS_MODE; else process.env.GENTLE_PI_AUTONOMOUS_MODE = previousAutonomy;
		rmSync(configHome, { recursive: true, force: true });
	}
});

test("YOLO never grants or revokes separate review standing permission and never answers ask_user", async () => {
	const h = harness();
	const identity = await captureReviewSessionIdentity(h.ctx, {}); assert.ok(identity);
	assert.equal(hasReviewSessionPermission(identity), false);
	await h.command("on"); assert.equal(hasReviewSessionPermission(identity), false);
	grantReviewSessionPermission(identity);
	await h.command("off"); assert.equal(hasReviewSessionPermission(identity), true);
	await h.command("on");
	const question = { toolName: "ask_user", input: { question: "Authorize recovery?", options: ["Approve", "Decline"] } };
	const original = structuredClone(question);
	assert.equal(await h.emit("tool_call", question), undefined);
	assert.deepEqual(question, original);
	assert.equal(h.confirmations(), 0);
	assert.equal(hasReviewSessionPermission(identity), true);
	revokeReviewSessionPermission(identity);
});

test("tool input and task text cannot activate; scope/UI loss removes instruction and widget", async () => {
	const h = harness();
	await h.emit("tool_call", { toolName: "bash", input: { command: "echo harmless", yolo: "on" } });
	const event = { prompt: "/yolo on", systemPromptOptions: { appendSystemPrompt: "base" } };
	await h.emit("before_agent_start", event);
	assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /YOLO session standing permission/);
	await h.command("on");
	Object.assign(h.ctx, { cwd: "/" });
	await h.emit("before_agent_start", event);
	assert.equal(h.widgets.get("gentle:yolo"), undefined);
	assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt, /YOLO session standing permission/);
	Object.assign(h.ctx, { cwd: process.cwd() });
	await h.command("status"); assert.match(h.notices.at(-1)!, /OFF/);
	await h.command("on"); Object.assign(h.ctx, { hasUI: false });
	await h.emit("before_agent_start", event);
	assert.equal(h.statuses.get("gentle:yolo"), undefined);
});
