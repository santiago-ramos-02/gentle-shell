// The gentle-pi API: model profiles, pins, and persona for hosts other than Pi's
// own UI, such as a desktop app managing Gentle AI in Pi. Each call takes JSON
// parameters and returns JSON; bin/gentle-pi-api.mjs frames it as one call per
// process with newline-delimited JSON, the same shape as `gentle-ai api`.
// Every read and write goes through the same library functions the extension's
// commands use, so a host and `/gentle:profiles` always agree.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import {
	clearProfilePinSync,
	evaluateProfilePin,
	readProfilePinStatus,
	writeProfilePinSync,
	type ProfilePinReadResult,
} from "./agent-profile-pin.ts";
import {
	AgentProfileError,
	createProfile,
	emptyProfilesFile,
	profilesFilePath,
	readProfilesFileResult,
	updateProfile,
	writeProfilesFileSync,
	type AgentProfilesFile,
} from "./agent-profiles.ts";
import { normalizeModelConfig } from "./model-routing-authority.ts";
import {
	gentleAiConfigHome,
	modelAssignmentNames,
	personaConfigPath,
	projectPersonaConfigPath,
	readPersonaFile,
	type PersonaMode,
} from "./model-routing.ts";
import { applyProfile, type ProfileApplyResult } from "./profile-operations.ts";

export const GENTLE_PI_API_VERSION = 1;

export class GentlePiApiError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "GentlePiApiError";
		this.code = code;
	}
}

type Params = Record<string, unknown>;

function stringParam(params: Params, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value === "") throw new GentlePiApiError("invalid_params", `${key} is required.`);
	return value;
}

function cwdParam(params: Params): string {
	const cwd = stringParam(params, "cwd");
	if (!isAbsolute(cwd)) throw new GentlePiApiError("invalid_params", "cwd must be an absolute path.");
	return cwd;
}

function personaParam(value: unknown): PersonaMode {
	if (value === "gentleman" || value === "neutral") return value;
	throw new GentlePiApiError("invalid_params", "mode must be gentleman or neutral.");
}

function layerParam(params: Params): "local" | "repo" {
	const layer = params.layer ?? "local";
	if (layer === "local" || layer === "repo") return layer;
	throw new GentlePiApiError("invalid_params", "layer must be local or repo.");
}

function profilesPath(): string {
	return profilesFilePath(gentleAiConfigHome());
}

/** The profile store, empty when there is none yet. A store that cannot be read is an error. */
function loadProfiles(): AgentProfilesFile {
	const read = readProfilesFileResult(profilesPath());
	if (read.status === "invalid") {
		throw new GentlePiApiError("invalid_store", `${profilesPath()} is not a profiles file gentle-pi can read.`);
	}
	return read.status === "valid" ? read.file : emptyProfilesFile();
}

function pinLayer(read: ProfilePinReadResult): string | null {
	return read.status === "valid" ? read.profile : null;
}

function readState(cwd: string | undefined) {
	const store = readProfilesFileResult(profilesPath());
	const file = store.status === "valid" ? store.file : emptyProfilesFile();
	const globalPersona = readPersonaFile(personaConfigPath("")) ?? "gentleman";
	const project = cwd === undefined ? null : (() => {
		const pins = readProfilePinStatus(cwd);
		const evaluation = evaluateProfilePin(pins, file.profiles);
		const override = readPersonaFile(projectPersonaConfigPath(cwd)) ?? null;
		return {
			// Pins live in the repository, so a folder outside Git cannot have one.
			pinAvailable: pins !== undefined,
			pins: pins === undefined ? null : { local: pinLayer(pins.local), repo: pinLayer(pins.repo) },
			pinned: evaluation.winner === undefined ? null : { profile: evaluation.winner.profile, source: evaluation.winner.source },
			persona: { effective: override ?? globalPersona, override },
		};
	})();
	return {
		profiles: Object.entries(file.profiles).map(([name, routing]) => ({ name, routing })),
		active: file.active ?? null,
		...(store.status === "invalid" ? { profilesError: `${profilesPath()} is not a profiles file gentle-pi can read.` } : {}),
		persona: globalPersona,
		// The agents a profile can route, including the orchestrator key.
		agents: cwd === undefined ? null : ["orchestrator", ...modelAssignmentNames(cwd)],
		project,
	};
}

function describeApplyFailure(name: string, result: Exclude<ProfileApplyResult, { status: "applied" | "pinned" }>): string {
	const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
	switch (result.status) {
		case "pin-failed":
			return `Could not pin profile "${name}" in ${result.localPath}: ${reason(result.error)}`;
		case "claim-failed":
			return `Could not update ${profilesPath()}: ${reason(result.error)}`;
		case "failed": {
			const step = { models: "write the routing", materialize: "update the agents", orchestrator: "set the orchestrator" }[result.stage];
			return `Could not ${step} for profile "${name}": ${reason(result.error)}. Restored: ${result.restored}.`;
		}
	}
}

async function apply(name: string, cwd: string, global: boolean) {
	const result = await applyProfile({ cwd, profilesPath: profilesPath(), file: loadProfiles(), name, global });
	if (result === undefined) throw new GentlePiApiError("missing_profile", `Profile does not exist: ${name}.`);
	if (result.status === "pinned") return { scope: "pin" as const, pinPath: result.localPath };
	if (result.status !== "applied") throw new GentlePiApiError("apply_failed", describeApplyFailure(name, result));
	return {
		scope: "global" as const,
		updated: result.updated,
		orchestratorChanged: result.orchestrator?.writtenTo !== undefined,
		unresolvedPin: result.unresolvedPin,
	};
}

function pinStatus(cwd: string) {
	const pins = readProfilePinStatus(cwd);
	if (pins === undefined) throw new GentlePiApiError("not_a_repository", "Profile pins need a Git repository.");
	return pins;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const methods = {
	state: async (params: Params) => readState(params.cwd === undefined ? undefined : cwdParam(params)),
	"profiles.create": async (params: Params) => {
		writeProfilesFileSync(profilesPath(), createProfile(loadProfiles(), stringParam(params, "name"), {}));
		return {};
	},
	/**
	 * Replaces a profile's routing. The active profile is applied again so the routing
	 * agents run with matches it, the same as saving it from `/gentle:profiles`.
	 */
	"profiles.save": async (params: Params) => {
		const name = stringParam(params, "name");
		const routing = normalizeModelConfig(params.routing);
		if (routing === undefined) throw new GentlePiApiError("invalid_params", "routing must map agents to a model and effort.");
		const file = loadProfiles();
		const next = updateProfile(file, name, routing);
		writeProfilesFileSync(profilesPath(), next);
		if (file.active !== name) return {};
		// Without a project, only agents outside any project are materialized.
		const cwd = params.cwd === undefined ? homedir() : cwdParam(params);
		return apply(name, cwd, true);
	},
	/**
	 * Applies a profile. Where a pin governs `cwd`, only the clone's pin moves, unless
	 * `global` asks for the global routing and orchestrator regardless.
	 */
	"profiles.apply": async (params: Params) => apply(stringParam(params, "name"), cwdParam(params), params.global === true),
	"pin.set": async (params: Params) => {
		const pins = pinStatus(cwdParam(params));
		const name = stringParam(params, "name");
		if (!Object.prototype.hasOwnProperty.call(loadProfiles().profiles, name)) {
			throw new GentlePiApiError("missing_profile", `Profile does not exist: ${name}.`);
		}
		const path = layerParam(params) === "local" ? pins.localPath : pins.repoPath;
		writeProfilePinSync(path, name);
		return { path };
	},
	"pin.clear": async (params: Params) => {
		const pins = pinStatus(cwdParam(params));
		const path = layerParam(params) === "local" ? pins.localPath : pins.repoPath;
		clearProfilePinSync(path);
		return { path };
	},
	/** Sets the persona everywhere, or with `cwd` a project's own persona; a null mode there removes it. */
	"persona.set": async (params: Params) => {
		if (params.cwd === undefined) {
			const path = personaConfigPath("");
			writeJson(path, { mode: personaParam(params.mode) });
			return { path };
		}
		const path = projectPersonaConfigPath(cwdParam(params));
		if (params.mode === null) {
			if (existsSync(path)) rmSync(path);
		} else writeJson(path, { mode: personaParam(params.mode) });
		return { path };
	},
} satisfies Record<string, (params: Params) => Promise<unknown>>;

export type GentlePiApiMethod = keyof typeof methods;

function isMethod(method: string): method is GentlePiApiMethod {
	return Object.prototype.hasOwnProperty.call(methods, method);
}

export type GentlePiApiLine =
	| { type: "result"; data: unknown }
	| { type: "error"; error: { code: string; message: string } };

/** Runs one API call. Failures become an error line; this never throws. */
export async function runGentlePiApi(method: string, params: unknown): Promise<GentlePiApiLine> {
	if (method === "describe") {
		return { type: "result", data: { apiVersion: GENTLE_PI_API_VERSION, methods: ["describe", ...Object.keys(methods)] } };
	}
	if (!isMethod(method)) {
		return { type: "error", error: { code: "unknown_method", message: `Unknown method: ${method}.` } };
	}
	const input: Params = typeof params === "object" && params !== null && !Array.isArray(params) ? { ...params } : {};
	try {
		return { type: "result", data: await methods[method](input) };
	} catch (error) {
		const code = error instanceof GentlePiApiError || error instanceof AgentProfileError ? error.code : "failed";
		return { type: "error", error: { code, message: error instanceof Error ? error.message : String(error) } };
	}
}
