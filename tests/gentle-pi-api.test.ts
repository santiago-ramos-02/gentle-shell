import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// The gentle-pi API as a host runs it: one process per call, parameters on stdin,
// newline-delimited JSON out, through the generated runtime modules.

const bin = join(import.meta.dirname, "..", "bin", "gentle-pi-api.mjs");
const root = mkdtempSync(join(tmpdir(), "gentle-pi-api-"));
after(() => rmSync(root, { recursive: true, force: true }));

function sandbox(name: string) {
	const base = join(root, name);
	const configHome = join(base, "config");
	const agentHome = join(base, "agent");
	const project = join(base, "project");
	mkdirSync(join(agentHome, "agents"), { recursive: true });
	mkdirSync(project, { recursive: true });
	writeFileSync(
		join(agentHome, "agents", "worker.md"),
		"---\nname: worker\ndescription: Does the work.\n---\nWork.\n",
	);
	const call = (method: string, params: unknown = {}) => {
		const run = spawnSync(process.execPath, [bin, method], {
			input: JSON.stringify(params),
			encoding: "utf8",
			env: { ...process.env, GENTLE_PI_CONFIG_HOME: configHome, GENTLE_PI_AGENT_HOME: agentHome },
		});
		const lines = run.stdout.trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(lines.length, 1, run.stderr);
		return lines[0];
	};
	const ok = (method: string, params: unknown = {}) => {
		const line = call(method, params);
		assert.equal(line.type, "result", JSON.stringify(line));
		return line.data;
	};
	return { configHome, agentHome, project, call, ok };
}

test("applying a profile routes its agents and sets the orchestrator, like /gentle:profiles", () => {
	const { configHome, agentHome, project, ok } = sandbox("apply");
	ok("profiles.create", { name: "deep" });
	ok("profiles.save", {
		name: "deep",
		routing: { worker: { model: "openai/alpha", thinking: "high" }, orchestrator: { model: "anthropic/beta" } },
	});
	const applied = ok("profiles.apply", { name: "deep", cwd: project });
	assert.equal(applied.scope, "global");
	assert.equal(applied.orchestratorChanged, true);

	assert.match(readFileSync(join(agentHome, "agents", "worker.md"), "utf8"), /^model: openai\/alpha\nthinking: high$/m);
	assert.deepEqual(JSON.parse(readFileSync(join(configHome, "models.json"), "utf8")).worker, {
		model: "openai/alpha",
		thinking: "high",
	});
	const settings = JSON.parse(readFileSync(join(agentHome, "settings.json"), "utf8"));
	assert.equal(settings.defaultProvider, "anthropic");
	assert.equal(settings.defaultModel, "beta");

	const state = ok("state", { cwd: project });
	assert.equal(state.active, "deep");
	assert.ok(state.agents.includes("worker"));

	// Saving the active profile applies it again, so agents never run stale routing.
	ok("profiles.save", { name: "deep", routing: { worker: { model: "openai/gamma" } } });
	assert.match(readFileSync(join(agentHome, "agents", "worker.md"), "utf8"), /^model: openai\/gamma$/m);
	assert.doesNotMatch(readFileSync(join(agentHome, "agents", "worker.md"), "utf8"), /^thinking:/m);
});

test("where a pin governs the repository, applying moves only the clone's pin", () => {
	const { configHome, project, ok, call } = sandbox("pin");
	execFileSync("git", ["init", "-q", project]);
	ok("profiles.create", { name: "fast" });
	ok("profiles.create", { name: "deep" });
	const pinned = ok("pin.set", { cwd: project, name: "fast" });
	assert.ok(existsSync(pinned.path));
	assert.deepEqual(ok("state", { cwd: project }).project.pinned, { profile: "fast", source: "local" });

	const applied = ok("profiles.apply", { name: "deep", cwd: project });
	assert.equal(applied.scope, "pin");
	assert.equal(existsSync(join(configHome, "models.json")), false);
	assert.deepEqual(ok("state", { cwd: project }).project.pinned, { profile: "deep", source: "local" });

	// `global` applies everywhere even though the pin still wins here.
	assert.equal(ok("profiles.apply", { name: "fast", cwd: project, global: true }).scope, "global");
	assert.equal(ok("state").active, "fast");

	ok("pin.clear", { cwd: project });
	assert.equal(ok("state", { cwd: project }).project.pinned, null);
	assert.equal(call("pin.set", { cwd: project, name: "missing" }).error.code, "missing_profile");
});

test("persona is set everywhere, or overridden and restored for one project", () => {
	const { project, ok } = sandbox("persona");
	ok("persona.set", { mode: "neutral" });
	assert.equal(ok("state").persona, "neutral");
	ok("persona.set", { cwd: project, mode: "gentleman" });
	assert.deepEqual(ok("state", { cwd: project }).project.persona, { effective: "gentleman", override: "gentleman" });
	ok("persona.set", { cwd: project, mode: null });
	assert.deepEqual(ok("state", { cwd: project }).project.persona, { effective: "neutral", override: null });
});

test("bad calls answer with a coded error line", () => {
	const { call } = sandbox("errors");
	assert.equal(call("nope").error.code, "unknown_method");
	assert.equal(call("profiles.create", { name: "bad name" }).error.code, "invalid_name");
	assert.equal(call("profiles.apply", { name: "missing", cwd: root }).error.code, "missing_profile");
	assert.equal(call("state", { cwd: "relative" }).error.code, "invalid_params");
});

test("command rules are read with every built-in rule and edited without losing other fields", () => {
	const { configHome, project, ok, call } = sandbox("command-rules");
	const initial = ok("state", { cwd: project }).commandRules;
	assert.equal(initial.autonomousMode, false);
	assert.deepEqual(initial.rules.map((rule: { key: string }) => rule.key), [
		"gitPush", "gitRebase", "gitBranchDeleteForce", "npmPublish", "piRemove", "fileDeletion", "databaseWipe",
	]);
	assert.ok(initial.rules.every((rule: { action: unknown }) => rule.action === null));
	assert.ok(initial.alwaysBlocked.includes("git reset --hard"));
	assert.equal(initial.project, null);

	const path = join(configHome, "runtime-guardrails.json");
	mkdirSync(configHome, { recursive: true });
	writeFileSync(path, JSON.stringify({ note: "kept", guardedCommands: { gitRebase: "allow" } }));
	ok("commandRules.set", {
		autonomousMode: true,
		guardedCommands: { fileDeletion: "allow", gitRebase: null },
		customCommands: [{ pattern: "  rm -rf   node_modules ", action: "allow" }],
	});
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		note: "kept",
		guardedCommands: { fileDeletion: "allow" },
		autonomousMode: true,
		customCommands: [{ pattern: "rm -rf node_modules", action: "allow" }],
	});
	const edited = ok("state").commandRules;
	assert.equal(edited.autonomousMode, true);
	assert.equal(edited.rules.find((rule: { key: string }) => rule.key === "fileDeletion").action, "allow");
	assert.deepEqual(edited.customCommands, [{ pattern: "rm -rf node_modules", action: "allow" }]);

	const projectRules = join(project, ".pi", "gentle-ai", "runtime-guardrails.json");
	mkdirSync(join(project, ".pi", "gentle-ai"), { recursive: true });
	writeFileSync(projectRules, "{");
	assert.deepEqual(ok("state", { cwd: project }).commandRules.project, { path: projectRules, readable: false });

	assert.equal(call("commandRules.set", { guardedCommands: { rmEverything: "allow" } }).error.code, "invalid_params");
	assert.equal(call("commandRules.set", { customCommands: [{ pattern: " ", action: "allow" }] }).error.code, "invalid_params");
	assert.equal(call("commandRules.set", { customCommands: [{ pattern: "* -rf", action: "allow" }] }).error.code, "invalid_params");
	writeFileSync(path, "not json");
	assert.equal(call("commandRules.set", { autonomousMode: false }).error.code, "invalid_store");
	assert.equal(readFileSync(path, "utf8"), "not json");
	assert.match(ok("state").commandRules.error, /is not a command rules file/);
});
