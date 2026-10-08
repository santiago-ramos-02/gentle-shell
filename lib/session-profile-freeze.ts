// Inherited profile freeze (gentle-shell#1064 slice 3b-ii).
//
// A parent session that never pressed Enter in `/gentle:profiles` resolves the
// shared defaults `p → P → G` (local pin, repository declaration, global
// `active` in profiles.json) ONCE, at startup, and keeps that snapshot with its
// origin. Changing a default later only affects new sessions, exactly like Pi's
// "set as default" for the orchestrator model; an open session changes profile
// only through its own Enter.
//
// Precedence, the single rule every consumer reads through
// `resolveSessionProfile`:
//
//   explicit Enter binding  →  frozen inherited snapshot  →  live p → P → G
//
// The live resolution applies only in subagent children (their routing comes
// from the parent through --model) and when no session id is available.
//
// The frozen state is in-process only, like the explicit binding of slice 2: it
// lives on `globalThis` behind a `Symbol.for` key because Pi evaluates this
// module once per extension entrypoint. A resumed session (`--resume`,
// `--continue`, `--session`) therefore freezes again from the current defaults.
// Persisting the freeze as a
// `gentle-pi.session-profile/v1` entry with origin `local | repo | global` is
// the integration point with slice 3b-i.
import { profileRoleEntries, profilesFilePath, readProfilesFileResult } from "./agent-profiles.ts";
import { readProfilePinStatus, resolveProfilePin, resolveUnversionedProjectProfile } from "./agent-profile-pin.ts";
import type { AgentModelConfig } from "./model-routing-authority.ts";
import { readSessionProfileBinding } from "./session-profile-binding.ts";
import type { WorktreeIdentity, WorktreeResolver } from "./session-worktree-registry.ts";

/** Which shared default supplied an inherited profile. */
export type InheritedProfileOrigin = "local" | "repo" | "global";

/** A profile resolved from the shared defaults: its name, its origin, and its role routing. */
export interface InheritedProfile {
	readonly name: string;
	readonly origin: InheritedProfileOrigin;
	readonly modelProfiles: AgentModelConfig;
}

/** A frozen session: `profile` is `undefined` when no layer had a profile at startup. */
export interface FrozenInheritedProfile {
	readonly profile: InheritedProfile | undefined;
}

/**
 * The profile a session uses. `inherited` is the startup snapshot (with or
 * without a profile); `live` carries the current defaults.
 */
export type SessionProfileResolution =
	| { kind: "explicit"; name: string; modelProfiles: AgentModelConfig }
	| { kind: "inherited"; profile: InheritedProfile | undefined }
	| { kind: "live"; profile: InheritedProfile | undefined };

export interface InheritedProfileOptions {
	cwd: string;
	configHome: string;
	resolveWorktree?: WorktreeResolver;
}

export interface SessionProfileOptions extends InheritedProfileOptions {
	sessionId: string | undefined;
	env?: NodeJS.ProcessEnv;
}

interface FreezeRegistry {
	frozen: Map<string, FrozenInheritedProfile>;
}

const freezeRegistryKey = Symbol.for("gentle-pi:session-profile-freeze");

function registry(): FreezeRegistry {
	const holder = globalThis as { [freezeRegistryKey]?: FreezeRegistry };
	(holder[freezeRegistryKey] ??= { frozen: new Map() });
	return holder[freezeRegistryKey]!;
}

function cloneProfiles(profiles: AgentModelConfig): AgentModelConfig {
	return Object.fromEntries(Object.entries(profiles).map(([agent, entry]) => [agent, { ...entry }]));
}

function cloneProfile(profile: InheritedProfile | undefined): InheritedProfile | undefined {
	return profile === undefined ? undefined : { name: profile.name, origin: profile.origin, modelProfiles: cloneProfiles(profile.modelProfiles) };
}

function roleRouting(config: AgentModelConfig): AgentModelConfig {
	return Object.fromEntries(profileRoleEntries(config).map(([agent, entry]) => [agent, { ...entry }]));
}

function isChildSession(env: NodeJS.ProcessEnv): boolean {
	return env.GENTLE_PI_AGENTS_CHILD === "1";
}

/**
 * The shared defaults `p → P → G` for one directory, with the layer that won.
 * Pin layers keep `resolveProfilePin` semantics; outside a Git worktree the
 * repository declaration is read as admission does for non-Git projects; the
 * global layer is the `active` profile of profiles.json. The orchestrator key
 * is never part of the routing. `undefined` means no layer has a profile.
 */
export function resolveInheritedProfile(options: InheritedProfileOptions): InheritedProfile | undefined {
	// One worktree lookup serves both the pin layers and the non-Git check.
	let resolved = false;
	let identity: WorktreeIdentity | undefined;
	const resolveWorktree: WorktreeResolver | undefined = options.resolveWorktree === undefined ? undefined : (cwd, base) => {
		if (!resolved) {
			resolved = true;
			identity = options.resolveWorktree!(cwd, base);
		}
		return identity;
	};
	const pin = resolveProfilePin({ cwd: options.cwd, configHome: options.configHome, resolveWorktree });
	if (pin !== undefined) return { name: pin.profile, origin: pin.source, modelProfiles: pin.modelProfiles };
	if (readProfilePinStatus(options.cwd, resolveWorktree) === undefined) {
		const declaration = resolveUnversionedProjectProfile(options.cwd, options.configHome);
		if (declaration !== undefined) return { name: declaration.profile, origin: "repo", modelProfiles: declaration.modelProfiles };
	}
	const store = readProfilesFileResult(profilesFilePath(options.configHome));
	if (store.status !== "valid" || store.file.active === undefined) return undefined;
	const active = store.file.active;
	if (!Object.prototype.hasOwnProperty.call(store.file.profiles, active)) return undefined;
	return { name: active, origin: "global", modelProfiles: roleRouting(store.file.profiles[active]!) };
}

/** A copy of one session's frozen snapshot, or `undefined` when it never froze. */
export function readFrozenInheritedProfile(sessionId: string | undefined): FrozenInheritedProfile | undefined {
	if (sessionId === undefined) return undefined;
	const frozen = registry().frozen.get(sessionId);
	return frozen === undefined ? undefined : { profile: cloneProfile(frozen.profile) };
}

function freezes(options: SessionProfileOptions): boolean {
	const env = options.env ?? process.env;
	return options.sessionId !== undefined && options.sessionId.length > 0 && !isChildSession(env);
}

// Only called after `freezes(options)`, which guarantees a session id.
function frozenOrFreeze(options: SessionProfileOptions): FrozenInheritedProfile {
	const store = registry().frozen;
	const sessionId = options.sessionId!;
	let frozen = store.get(sessionId);
	if (frozen === undefined) {
		frozen = { profile: cloneProfile(resolveInheritedProfile(options)) };
		store.set(sessionId, frozen);
	}
	return { profile: cloneProfile(frozen.profile) };
}

/**
 * Freeze a parent session's inherited profile at startup. Idempotent: the
 * first snapshot wins, so a session keeps it across `/reload` in the same
 * process. Children never freeze.
 */
export function freezeSessionProfileAtStartup(options: SessionProfileOptions): void {
	if (freezes(options)) frozenOrFreeze(options);
}

/**
 * The single precedence rule for launch, status and Usage. A parent session
 * that has not frozen yet freezes here, so the snapshot never depends on which
 * extension's `session_start` ran first.
 */
export function resolveSessionProfile(options: SessionProfileOptions): SessionProfileResolution {
	const explicit = readSessionProfileBinding(options.sessionId);
	if (explicit !== undefined) return { kind: "explicit", name: explicit.name, modelProfiles: explicit.modelProfiles };
	if (freezes(options)) return { kind: "inherited", profile: frozenOrFreeze(options).profile };
	return { kind: "live", profile: resolveInheritedProfile(options) };
}

/** The routing that replaces subagent model profiles, or `undefined` for today's routing. */
export function sessionProfileModelProfiles(resolution: SessionProfileResolution): AgentModelConfig | undefined {
	return resolution.kind === "explicit" ? resolution.modelProfiles : resolution.profile?.modelProfiles;
}

/** Testing-only reset of every frozen snapshot. */
export function resetFrozenInheritedProfilesForTesting(): void {
	registry().frozen.clear();
}
