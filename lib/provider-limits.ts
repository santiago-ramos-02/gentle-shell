import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Subscription limits are per account, not per session, so the parent and every
// subagent process record the rate-limit headers of their own provider responses
// in one file in the agent home, and the RPC host is shown the latest of each.

/** The header family a provider's subscription limits arrive in. */
export type ProviderLimitsFamily = "anthropic" | "codex";

export interface ProviderLimits {
	provider: ProviderLimitsFamily;
	/** Epoch milliseconds of the response the headers came from. */
	checkedAt: number;
	/** Lowercased rate-limit headers only; never auth, cookies, or request ids. */
	headers: Record<string, string>;
}

export const PROVIDER_LIMITS_FILE = "gentle-provider-limits.json";

const ANTHROPIC_PREFIX = "anthropic-ratelimit-unified-";
// Codex's main allowance only; model-specific limits carry other prefixes.
const CODEX_HEADER = /^x-codex-(?:primary|secondary)-(?:used-percent|window-minutes|reset-at|reset-after-seconds)$/;
const MAX_HEADERS = 40;
const MAX_VALUE_CHARS = 200;

/** The subscription rate-limit headers in one provider response, or null when it carries none. */
export function pickProviderLimits(headers: Record<string, string>, checkedAt: number): ProviderLimits | null {
	const picked: Record<string, string> = {};
	let provider: ProviderLimitsFamily | undefined;
	for (const [rawName, value] of Object.entries(headers)) {
		const name = rawName.toLowerCase();
		const family = name.startsWith(ANTHROPIC_PREFIX) ? "anthropic" : CODEX_HEADER.test(name) ? "codex" : undefined;
		if (family === undefined || typeof value !== "string") continue;
		if (provider !== undefined && provider !== family) continue;
		provider = family;
		picked[name] = value.slice(0, MAX_VALUE_CHARS);
		if (Object.keys(picked).length >= MAX_HEADERS) break;
	}
	return provider === undefined ? null : { provider, checkedAt, headers: picked };
}

function parseLimits(text: string): ProviderLimits[] {
	const parsed: unknown = JSON.parse(text);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter((entry): entry is ProviderLimits =>
		typeof entry === "object" && entry !== null &&
		(entry.provider === "anthropic" || entry.provider === "codex") &&
		typeof entry.checkedAt === "number" &&
		typeof entry.headers === "object" && entry.headers !== null);
}

/** Every provider's latest limits in `file`, or none when it is missing or unreadable. */
export function readProviderLimits(file: string): ProviderLimits[] {
	try {
		return parseLimits(readFileSync(file, "utf8"));
	} catch {
		return [];
	}
}

/** Replaces `limits.provider`'s entry in `file` unless the file already holds a newer one. */
export function recordProviderLimits(file: string, limits: ProviderLimits): void {
	const others = readProviderLimits(file);
	const current = others.find((entry) => entry.provider === limits.provider);
	if (current !== undefined && current.checkedAt > limits.checkedAt) return;
	const next = [...others.filter((entry) => entry.provider !== limits.provider), limits];
	mkdirSync(dirname(file), { recursive: true });
	// Rename over the old file so a concurrent reader never sees half of it.
	const temporary = `${file}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(next)}\n`);
	renameSync(temporary, file);
}

/** Reads `file` again only after it changes, for a publisher that asks on every push. */
export function cachedProviderLimits(file: string): () => ProviderLimits[] {
	let stamp: string | undefined;
	let limits: ProviderLimits[] = [];
	return () => {
		let next: string;
		try {
			const stat = statSync(file);
			next = `${stat.mtimeMs}:${stat.size}`;
		} catch {
			next = "missing";
		}
		if (next !== stamp) {
			stamp = next;
			limits = readProviderLimits(file);
		}
		return limits;
	};
}

export function providerLimitsFile(agentHome: string): string {
	return join(agentHome, PROVIDER_LIMITS_FILE);
}
