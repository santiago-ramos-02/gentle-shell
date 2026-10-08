import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createProfile, emptyProfilesFile, profilesFilePath, setActiveProfile, writeProfilesFileSync } from "../lib/agent-profiles.ts";
import { clearProfilePinSync, localProfilePinPath, repoProfileDeclarationPath, writeProfilePinSync } from "../lib/agent-profile-pin.ts";
import type { AgentModelConfig } from "../lib/model-routing-authority.ts";
import { bindSessionProfile, resetSessionProfileBindingsForTesting } from "../lib/session-profile-binding.ts";
import {
	freezeSessionProfileAtStartup,
	readFrozenInheritedProfile,
	resetFrozenInheritedProfilesForTesting,
	resolveInheritedProfile,
	resolveSessionProfile,
	sessionProfileModelProfiles,
} from "../lib/session-profile-freeze.ts";
import type { WorktreeIdentity, WorktreeResolver } from "../lib/session-worktree-registry.ts";

// Inherited profile freeze (gentle-shell#1064 slice 3b-ii). A parent session that
// never pressed Enter resolves `p → P → G` once and keeps that snapshot;
// children never freeze. The worktree identity is
// injected, so these tests never run Git.

const root = mkdtempSync(join(tmpdir(), "gentle-pi-profile-freeze-"));
after(() => rmSync(root, { recursive: true, force: true }));

const FRONTIER: AgentModelConfig = { worker: { model: "anthropic/claude-opus", thinking: "high" } };
const LOCAL: AgentModelConfig = { worker: { model: "ollama/qwen", thinking: "low" } };
const TEAM: AgentModelConfig = { worker: { model: "openai/gpt-5" }, orchestrator: { model: "openai/gpt-5" } };

let caseIndex = 0;
interface Fixture {
	configHome: string;
	identity: WorktreeIdentity;
	resolveWorktree: WorktreeResolver;
	cwd: string;
	setActive(name: string | undefined): void;
	pinLocal(name: string | undefined): void;
	declareRepo(name: string | undefined): void;
	editProfile(name: string, config: AgentModelConfig): void;
}

function fixture(profiles: Record<string, AgentModelConfig> = { frontier: FRONTIER, local: LOCAL, team: TEAM }): Fixture {
	const base = join(root, `case-${caseIndex++}`);
	const configHome = join(base, "config");
	const identity = { root: join(base, "worktree"), commonDir: join(base, "git-common") };
	mkdirSync(identity.root, { recursive: true });
	let current = profiles;
	let active: string | undefined;
	const write = () => {
		let file = Object.entries(current).reduce((acc, [name, config]) => createProfile(acc, name, config), emptyProfilesFile());
		if (active !== undefined) file = setActiveProfile(file, active);
		writeProfilesFileSync(profilesFilePath(configHome), file);
	};
	write();
	return {
		configHome,
		identity,
		resolveWorktree: () => identity,
		cwd: identity.root,
		setActive(name) { active = name; write(); },
		pinLocal(name) {
			const path = localProfilePinPath(identity.commonDir);
			if (name === undefined) clearProfilePinSync(path); else writeProfilePinSync(path, name);
		},
		declareRepo(name) {
			const path = repoProfileDeclarationPath(identity.root);
			if (name === undefined) clearProfilePinSync(path); else writeProfilePinSync(path, name);
		},
		editProfile(name, config) { current = { ...current, [name]: config }; write(); },
	};
}

function options(f: Fixture, sessionId: string | undefined, env: NodeJS.ProcessEnv = {}) {
	return { sessionId, cwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree, env };
}

beforeEach(() => {
	resetFrozenInheritedProfilesForTesting();
	resetSessionProfileBindingsForTesting();
});

test("resolveInheritedProfile reports the local pin with its origin", () => {
	const f = fixture();
	f.pinLocal("frontier");
	f.declareRepo("team");
	f.setActive("local");
	assert.deepEqual(resolveInheritedProfile({ cwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree }), {
		name: "frontier",
		origin: "local",
		modelProfiles: FRONTIER,
	});
});

test("resolveInheritedProfile falls to the repository declaration, without the orchestrator key", () => {
	const f = fixture();
	f.declareRepo("team");
	f.setActive("local");
	const profile = resolveInheritedProfile({ cwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree });
	assert.deepEqual(JSON.parse(JSON.stringify(profile)), {
		name: "team",
		origin: "repo",
		modelProfiles: { worker: { model: "openai/gpt-5" } },
	});
});

test("resolveInheritedProfile falls to the global active profile in profiles.json", () => {
	const f = fixture();
	f.setActive("local");
	assert.deepEqual(resolveInheritedProfile({ cwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree }), {
		name: "local",
		origin: "global",
		modelProfiles: LOCAL,
	});
});

test("resolveInheritedProfile returns undefined when no layer has a profile", () => {
	const f = fixture();
	assert.equal(resolveInheritedProfile({ cwd: f.cwd, configHome: f.configHome, resolveWorktree: f.resolveWorktree }), undefined);
});

test("resolveInheritedProfile reads the repository declaration of a non-Git project", () => {
	const f = fixture();
	f.declareRepo("team");
	f.setActive("local");
	const profile = resolveInheritedProfile({ cwd: f.cwd, configHome: f.configHome, resolveWorktree: () => undefined });
	assert.equal(profile?.name, "team");
	assert.equal(profile?.origin, "repo");
});

test("a session freezes the inherited profile once: later pin and active changes do not move it", () => {
	const f = fixture();
	f.pinLocal("frontier");
	const first = resolveSessionProfile(options(f, "session-a"));
	assert.equal(first.kind, "inherited");
	f.pinLocal("local");
	f.setActive("team");
	const second = resolveSessionProfile(options(f, "session-a"));
	assert.deepEqual(second, { kind: "inherited", profile: { name: "frontier", origin: "local", modelProfiles: FRONTIER } });
	assert.deepEqual(sessionProfileModelProfiles(second), FRONTIER);
});

test("editing the frozen profile in profiles.json does not change the frozen content", () => {
	const f = fixture();
	f.setActive("frontier");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	f.editProfile("frontier", LOCAL);
	assert.deepEqual(sessionProfileModelProfiles(resolveSessionProfile(options(f, "session-a"))), FRONTIER);
});

test("a session started after the change freezes the new default; the open one keeps its own", () => {
	const f = fixture();
	f.pinLocal("frontier");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	f.pinLocal("local");
	freezeSessionProfileAtStartup(options(f, "session-b"));
	assert.equal(readFrozenInheritedProfile("session-a")?.profile?.name, "frontier");
	assert.equal(readFrozenInheritedProfile("session-b")?.profile?.name, "local");
});

test("startup freeze is idempotent: a second call keeps the first snapshot", () => {
	const f = fixture();
	f.setActive("frontier");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	f.setActive("local");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	assert.equal(readFrozenInheritedProfile("session-a")?.profile?.name, "frontier");
});

test("a session with no profile anywhere freezes 'no profile' and keeps today's routing", () => {
	const f = fixture();
	const first = resolveSessionProfile(options(f, "session-a"));
	assert.deepEqual(first, { kind: "inherited", profile: undefined });
	assert.equal(sessionProfileModelProfiles(first), undefined);
	f.pinLocal("frontier");
	const second = resolveSessionProfile(options(f, "session-a"));
	assert.deepEqual(second, { kind: "inherited", profile: undefined });
	assert.equal(sessionProfileModelProfiles(second), undefined);
});

test("an explicit Enter binding outranks the frozen inherited profile", () => {
	const f = fixture();
	f.pinLocal("frontier");
	freezeSessionProfileAtStartup(options(f, "session-a"));
	bindSessionProfile("session-a", "team", { worker: { model: "openai/gpt-5" } });
	const resolution = resolveSessionProfile(options(f, "session-a"));
	assert.deepEqual(resolution, { kind: "explicit", name: "team", modelProfiles: { worker: { model: "openai/gpt-5" } } });
});

test("subagent children never freeze: they resolve live", () => {
	const f = fixture();
	const env = { GENTLE_PI_AGENTS_CHILD: "1" };
	f.pinLocal("frontier");
	freezeSessionProfileAtStartup(options(f, "child-a", env));
	assert.equal(readFrozenInheritedProfile("child-a"), undefined);
	const resolution = resolveSessionProfile(options(f, "child-a", env));
	assert.equal(resolution.kind, "live");
	assert.equal(readFrozenInheritedProfile("child-a"), undefined);
	f.pinLocal("local");
	assert.deepEqual(sessionProfileModelProfiles(resolveSessionProfile(options(f, "child-a", env))), LOCAL);
});

test("without a session id the resolution is live and nothing is frozen", () => {
	const f = fixture();
	f.pinLocal("frontier");
	const resolution = resolveSessionProfile(options(f, undefined));
	assert.equal(resolution.kind, "live");
	assert.deepEqual(sessionProfileModelProfiles(resolution), FRONTIER);
});
