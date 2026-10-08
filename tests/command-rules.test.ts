import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { __testing } from "../extensions/gentle-ai.ts";

const { classifyGuardedCommand, evaluateGuardedCommand, guardedCommandTitle, loadRuntimeGuardrailsConfig } = __testing;

test("recursive deletion and database wipes take their configured action only in autonomous mode", () => {
	for (const action of ["allow", "confirm", "block"] as const) {
		const config = { autonomousMode: true, guardedCommands: { fileDeletion: action, databaseWipe: action } };
		assert.equal(classifyGuardedCommand("rm -rf packages/sdk/generated", config), action);
		assert.equal(classifyGuardedCommand("find cache -delete", config), action);
		assert.equal(classifyGuardedCommand(`psql -c 'DROP TABLE users'`, config), action);
	}
	const off = { autonomousMode: false, guardedCommands: { fileDeletion: "allow" as const } };
	assert.equal(classifyGuardedCommand("rm -rf packages/sdk/generated", off), "confirm");
	assert.equal(classifyGuardedCommand("rm -rf packages/sdk/generated", { autonomousMode: true, guardedCommands: {} }), "confirm");
	const allowed = { autonomousMode: true, guardedCommands: { fileDeletion: "allow" as const } };
	assert.equal(classifyGuardedCommand("rm -rf ~", allowed), "block", "hard denies stay blocked");
	assert.equal(classifyGuardedCommand("rm -rf dist && git rebase main", allowed), "confirm", "other rules still apply");
});

test("a custom command decides its whole segment and nothing beyond it", () => {
	const config = {
		autonomousMode: true,
		guardedCommands: {},
		customCommands: [
			{ pattern: "rm -rf packages/sdk/convex/generated/*", action: "allow" as const },
			{ pattern: "rm -rf node_modules", action: "allow" as const },
			{ pattern: "docker system prune *", action: "block" as const },
			{ pattern: "rm -rf build*", action: "allow" as const },
			{ pattern: "git rebase main", action: "allow" as const },
		],
	};
	assert.equal(classifyGuardedCommand("cd .t3/slices/w && rm -rf packages/sdk/convex/generated/{app,auth,core}; git status", config), "allow");
	assert.equal(classifyGuardedCommand(`rm -rf "node_modules"`, config), "allow");
	assert.equal(classifyGuardedCommand("git rebase main", config), "allow");
	assert.equal(classifyGuardedCommand("rm -rf node_modules /tmp/data", config), "confirm", "a pattern covers the whole segment only");
	assert.equal(classifyGuardedCommand("rm -rf packages/sdk/convex/generated/app data", config), "confirm", "* stays within one word");
	assert.equal(classifyGuardedCommand("rm -rf node_modules && rm -rf dist", config), "confirm", "other segments are still guarded");
	assert.equal(classifyGuardedCommand("sudo rm -rf node_modules", config), "confirm");
	assert.equal(classifyGuardedCommand("docker system prune -af", config), "block", "custom commands can guard anything");
	assert.equal(classifyGuardedCommand("docker system prune", config), "block", "a lone * also matches no arguments");
	assert.equal(classifyGuardedCommand("rm -rf build-cache", config), "allow");
	assert.equal(classifyGuardedCommand("rm -rf build-cache /", config), "block");
	assert.equal(classifyGuardedCommand("rm -rf build-cache data", config), "confirm");
	assert.equal(classifyGuardedCommand("echo docker system prune", config), "not-guarded");
	assert.equal(classifyGuardedCommand("rm -rf node_modules", { ...config, autonomousMode: false }), "confirm");
	assert.equal(classifyGuardedCommand("docker system prune", { ...config, autonomousMode: false }), "not-guarded");

	const prompt = evaluateGuardedCommand("docker system prune", {
		...config,
		customCommands: [{ pattern: "docker system prune", action: "confirm" as const }],
	});
	assert.equal(guardedCommandTitle(prompt.key, prompt.matches), "Allow guarded docker system prune?");
});

test("custom commands never waive hard denies", () => {
	const config = {
		autonomousMode: true,
		guardedCommands: {},
		customCommands: [
			{ pattern: "rm -rf *", action: "allow" as const },
			{ pattern: "git reset --hard", action: "allow" as const },
			{ pattern: "git push -f origin main", action: "allow" as const },
		],
	};
	for (const command of ["rm -rf /", "rm -rf .", "git reset --hard", "git push -f origin main"]) {
		assert.equal(classifyGuardedCommand(command, config), "block", command);
	}
});

test("project custom commands are checked before global ones; invalid entries are ignored", () => {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-command-rules-"));
	try {
		const home = join(root, "home");
		const cwd = join(root, "repo");
		writeConfig(home, "runtime-guardrails.json", {
			autonomousMode: true,
			customCommands: [{ pattern: "rm -rf dist", action: "allow" }, { pattern: "", action: "allow" }, { pattern: "* -rf", action: "allow" }, { pattern: "x", action: "maybe" }],
		});
		writeConfig(cwd, ".pi/gentle-ai/runtime-guardrails.json", {
			autonomousMode: true,
			guardedCommands: { fileDeletion: "block" },
			customCommands: [{ pattern: "rm  -rf   dist", action: "confirm" }],
		});
		const config = loadRuntimeGuardrailsConfig(cwd, { gentlePiConfigHome: home });
		assert.deepEqual(config.customCommands, [
			{ pattern: "rm -rf dist", action: "confirm" },
			{ pattern: "rm -rf dist", action: "allow" },
		]);
		assert.equal(config.guardedCommands.fileDeletion, "block");
		assert.equal(classifyGuardedCommand("rm -rf dist", config), "confirm");
		assert.equal(classifyGuardedCommand("rm -rf build", config), "block");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function writeConfig(dir: string, relPath: string, content: unknown): void {
	const full = join(dir, relPath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, JSON.stringify(content, null, 2));
}
