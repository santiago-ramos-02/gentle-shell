// Command rules: which shell commands the gentle-ai extension asks about,
// allows, or blocks, and the runtime-guardrails.json files they live in. The
// extension evaluates them before every shell command; the gentle-pi API reads
// and edits the same files for hosts such as T3 Code, so both always agree.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gentlePiConfigHome } from "./agent-home.ts";
import { commandSegments } from "./destructive-command-guard.ts";

export const COMMAND_RULE_ACTIONS = ["allow", "confirm", "block"] as const;
export type CommandRuleAction = (typeof COMMAND_RULE_ACTIONS)[number];

/**
 * Every built-in rule. `autonomousDefault` applies when autonomous mode is on
 * and the rule is not configured; with autonomous mode off every rule confirms.
 * Pattern rules are matched by the extension; data-loss rules come from the
 * destructive-command recognizer.
 */
export const COMMAND_RULES = {
	gitPush: { label: "git push", autonomousDefault: "allow" },
	gitRebase: { label: "git rebase", autonomousDefault: "confirm" },
	gitBranchDeleteForce: { label: "forced git branch deletion", autonomousDefault: "confirm" },
	npmPublish: { label: "npm publish", autonomousDefault: "block" },
	piRemove: { label: "pi remove", autonomousDefault: "confirm" },
	fileDeletion: { label: "recursive file deletion (rm -r, find -delete)", autonomousDefault: "confirm" },
	databaseWipe: { label: "database wipe (DROP, TRUNCATE, DELETE without WHERE)", autonomousDefault: "confirm" },
} as const satisfies Record<string, { label: string; autonomousDefault: CommandRuleAction }>;

export type CommandRuleKey = keyof typeof COMMAND_RULES;
export type DataLossRuleKey = "fileDeletion" | "databaseWipe";
export type PatternRuleKey = Exclude<CommandRuleKey, DataLossRuleKey>;

/**
 * What stays blocked in every configuration, in words a host can show. It
 * describes the extension's DENIED_BASH_PATTERNS, the hard denies of
 * destructive-command-guard.ts, and child safety; keep them in step.
 */
export const ALWAYS_BLOCKED = [
	"rm -r of /, ~, $HOME, . or ..",
	"git reset --hard",
	"git clean -f",
	"git push --force, --force-with-lease or -f",
	"chmod -R 777",
	"chown -R",
	"Any recognized data-loss command run by a subagent",
] as const;

export interface CustomCommandRule {
	pattern: string;
	action: CommandRuleAction;
}

export interface CommandRulesConfig {
	autonomousMode: boolean;
	guardedCommands: Partial<Record<CommandRuleKey, CommandRuleAction>>;
	/** Checked in order; the first pattern matching a command segment wins. */
	customCommands?: CustomCommandRule[];
}

export const SAFE_COMMAND_RULES: CommandRulesConfig = { autonomousMode: false, guardedCommands: {} };

const RULES_FILE = "runtime-guardrails.json";

export function globalCommandRulesPath(configHome = gentlePiConfigHome()): string {
	return join(configHome, RULES_FILE);
}

export function projectCommandRulesPath(cwd: string): string {
	return join(cwd, ".pi", "gentle-ai", RULES_FILE);
}

export function isCommandRuleKey(value: string): value is CommandRuleKey {
	return Object.prototype.hasOwnProperty.call(COMMAND_RULES, value);
}

export function isCommandRuleAction(value: unknown): value is CommandRuleAction {
	return typeof value === "string" && (COMMAND_RULE_ACTIONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collapses whitespace so a pattern and a command compare word by word. */
export function normalizeCommandPattern(pattern: string): string {
	return pattern.trim().replace(/\s+/g, " ");
}

/** A configuration, or undefined when the file is not one. Unknown keys and invalid entries are ignored. */
export function parseCommandRulesFile(raw: string): CommandRulesConfig | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const guardedCommands: CommandRulesConfig["guardedCommands"] = {};
	for (const [key, value] of Object.entries(isRecord(parsed.guardedCommands) ? parsed.guardedCommands : {})) {
		if (isCommandRuleKey(key) && isCommandRuleAction(value)) guardedCommands[key] = value;
	}
	const customCommands: CustomCommandRule[] = [];
	for (const entry of Array.isArray(parsed.customCommands) ? parsed.customCommands : []) {
		if (!isRecord(entry) || typeof entry.pattern !== "string" || !isCommandRuleAction(entry.action)) continue;
		const pattern = normalizeCommandPattern(entry.pattern);
		if (isCommandPattern(pattern)) customCommands.push({ pattern, action: entry.action });
	}
	return { autonomousMode: parsed.autonomousMode === true, guardedCommands, customCommands };
}

/**
 * The rules for commands run in `cwd`.
 *
 * Resolution order (project overrides global):
 *   1. GENTLE_PI_AUTONOMOUS_MODE=1 forces autonomous mode with default actions.
 *   2. The global file, then the project's `.pi/gentle-ai/runtime-guardrails.json`:
 *      its autonomousMode replaces the global one, its rules merge over the
 *      global ones, and its custom commands are checked first.
 *   3. Any read or parse error anywhere fails safe to SAFE_COMMAND_RULES.
 */
export function loadCommandRules(cwd: string, options: { configHome?: string } = {}): CommandRulesConfig {
	try {
		if (process.env.GENTLE_PI_AUTONOMOUS_MODE === "1") return { autonomousMode: true, guardedCommands: {} };
		let merged: CommandRulesConfig = { autonomousMode: false, guardedCommands: {}, customCommands: [] };
		for (const [index, path] of [globalCommandRulesPath(options.configHome), projectCommandRulesPath(cwd)].entries()) {
			if (!existsSync(path)) continue;
			const layer = parseCommandRulesFile(readFileSync(path, "utf8"));
			if (!layer) return SAFE_COMMAND_RULES;
			merged = index === 0 ? layer : {
				autonomousMode: layer.autonomousMode,
				guardedCommands: { ...merged.guardedCommands, ...layer.guardedCommands },
				customCommands: [...(layer.customCommands ?? []), ...(merged.customCommands ?? [])],
			};
		}
		return merged;
	} catch {
		return SAFE_COMMAND_RULES;
	}
}

/** The action a built-in rule takes under `config`. */
export function commandRuleAction(config: CommandRulesConfig, key: CommandRuleKey): CommandRuleAction {
	if (!config.autonomousMode) return "confirm";
	return config.guardedCommands[key] ?? COMMAND_RULES[key].autonomousDefault;
}

/** A usable custom command pattern names its command, so it cannot start with a wildcard. */
export function isCommandPattern(pattern: string): boolean {
	const normalized = normalizeCommandPattern(pattern);
	return normalized !== "" && !normalized.startsWith("*");
}

function customPatternRegExp(pattern: string): RegExp {
	const source = normalizeCommandPattern(pattern)
		.split(" ")
		.map((word) => word === "*"
			? String.raw`(?: \S+)*`
			: ` ${word.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(String.raw`\S*`)}`)
		.join("")
		.slice(1);
	return new RegExp(`^${source}$`);
}

export interface CustomCommandMatch extends CustomCommandRule {
	/** Where the matched segment starts and ends in the command. */
	start: number;
	end: number;
}

/**
 * The custom rule for each command segment that one matches. A pattern must
 * match the whole segment, so `rm -rf node_modules` never covers
 * `rm -rf node_modules /`. A `*` inside a word matches within that word, so
 * `rm -rf dist/*` never covers `rm -rf dist/x /`; a `*` on its own matches
 * any further arguments, so `docker system prune *` covers `docker system prune -af`.
 */
export function matchCustomCommands(command: string, rules: readonly CustomCommandRule[] = []): CustomCommandMatch[] {
	if (rules.length === 0) return [];
	const compiled = rules.map((rule) => ({ rule, regExp: customPatternRegExp(rule.pattern) }));
	const matches: CustomCommandMatch[] = [];
	for (const segment of commandSegments(command)) {
		const text = normalizeCommandPattern(segment.text);
		const found = compiled.find(({ regExp }) => regExp.test(text));
		if (found) matches.push({ ...found.rule, start: segment.start, end: segment.end });
	}
	return matches;
}

/** One file's rules for a host to show, or the reason it cannot be read. */
export function readCommandRulesLayer(path: string):
	| { status: "missing" }
	| { status: "invalid" }
	| { status: "valid"; config: CommandRulesConfig } {
	if (!existsSync(path)) return { status: "missing" };
	try {
		const config = parseCommandRulesFile(readFileSync(path, "utf8"));
		return config === undefined ? { status: "invalid" } : { status: "valid", config };
	} catch {
		return { status: "invalid" };
	}
}

export interface CommandRulesUpdate {
	autonomousMode?: boolean;
	/** A null action removes the rule, so it takes its default again. */
	guardedCommands?: Partial<Record<CommandRuleKey, CommandRuleAction | null>>;
	/** Replaces every custom command. */
	customCommands?: CustomCommandRule[];
}

export class CommandRulesFileError extends Error {
	readonly path: string;

	constructor(path: string) {
		super(`${path} is not a command rules file gentle-pi can read. Fix or remove it first.`);
		this.name = "CommandRulesFileError";
		this.path = path;
	}
}

/** Applies `update` to the file at `path`, keeping every field it does not change. */
export function writeCommandRules(path: string, update: CommandRulesUpdate): void {
	let file: Record<string, unknown> = {};
	if (existsSync(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			throw new CommandRulesFileError(path);
		}
		if (!isRecord(parsed)) throw new CommandRulesFileError(path);
		file = parsed;
	}
	if (update.autonomousMode !== undefined) file.autonomousMode = update.autonomousMode;
	if (update.guardedCommands !== undefined) {
		const guardedCommands = isRecord(file.guardedCommands) ? { ...file.guardedCommands } : {};
		for (const [key, action] of Object.entries(update.guardedCommands)) {
			if (action === null) delete guardedCommands[key];
			else guardedCommands[key] = action;
		}
		file.guardedCommands = guardedCommands;
	}
	if (update.customCommands !== undefined) {
		file.customCommands = update.customCommands.map((rule) => ({ pattern: normalizeCommandPattern(rule.pattern), action: rule.action }));
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}
