// T3 fork: T3 Code names the gentle-ai it runs in GENTLE_PI_T3_GENTLE_AI, and gentle-pi runs
// that one when it is a T3 fork build, so both drive the same gentle-ai instead of this
// package's pinned upstream copy. A fork build reports a version such as 4.0.0-t3.3707223.
// Otherwise resolveGentleAiBinary keeps the pinned package-local binary.
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export const T3_GENTLE_AI_ENV = "GENTLE_PI_T3_GENTLE_AI";

export interface ForkGentleAiProbe {
	isFile(path: string): boolean;
	/** The version `gentle-ai version` reports, or undefined when it cannot be read. */
	version(path: string): string | undefined;
}

// A binary's version is read once per process; self-updates keep a fork build a fork build.
const versions = new Map<string, string | undefined>();

const hostProbe: ForkGentleAiProbe = {
	isFile: (path) => {
		try {
			return statSync(path).isFile();
		} catch {
			return false;
		}
	},
	version: (path) => {
		if (versions.has(path)) return versions.get(path);
		let version: string | undefined;
		try {
			const banner = execFileSync(path, ["version"], { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
			if (banner.startsWith("gentle-ai ")) version = banner.slice("gentle-ai ".length);
		} catch {
			version = undefined;
		}
		versions.set(path, version);
		return version;
	},
};

export function isForkGentleAiVersion(version: string): boolean {
	return version.includes("-t3.");
}

/** The gentle-ai T3 Code named, when it is an existing T3 fork build. */
export function findForkGentleAiBinary(
	env: Record<string, string | undefined>,
	probe: ForkGentleAiProbe = hostProbe,
): string | undefined {
	const path = env[T3_GENTLE_AI_ENV];
	if (path === undefined || !isAbsolute(path) || !probe.isFile(path)) return undefined;
	const version = probe.version(path);
	return version !== undefined && isForkGentleAiVersion(version) ? path : undefined;
}
