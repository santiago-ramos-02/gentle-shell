// Model routing, persona, and agent discovery for Gentle AI in Pi: where each
// setting lives, how it is read, and how routing is materialized into the
// stores subagent launches resolve. The extension, and the gentle-pi API other
// hosts use, both read and write through these functions so they cannot drift.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { updatePackageManagedSddAgentOwnership } from "./agent-assets.ts";
import { gentlePiConfigHome, resolveGentlePiAgentHome } from "./agent-home.ts";
import { resolveProfilePin } from "./agent-profile-pin.ts";
import { isProfileOrchestratorKey } from "./agent-profiles.ts";
import {
	normalizeModelConfig,
	normalizeRoutingEntry,
	readSavedModelConfig as readModelRoutingAuthority,
	readSavedModelConfigAsync as readModelRoutingAuthorityAsync,
	type AgentModelConfig,
	type AgentRoutingEntry,
	type ModelConfigFileResult,
} from "./model-routing-authority.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function gentlePiAgentHome(): string {
	return resolveGentlePiAgentHome();
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export type PersonaMode = "gentleman" | "neutral";

export const JUDGMENT_DAY_AGENT_NAMES = [
	"jd-judge-a",
	"jd-judge-b",
	"jd-fix-agent",
] as const;

export const CORE_MODEL_AGENT_NAMES = JUDGMENT_DAY_AGENT_NAMES;
export const CORE_MODEL_AGENT_NAME_SET = new Set<string>(CORE_MODEL_AGENT_NAMES);

export type AgentSource = "project" | "user" | "builtin";

export interface AgentEntry {
	name: string;
	source: AgentSource;
	filePath?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function gentleAiConfigHome(): string {
	return gentlePiConfigHome();
}

export function modelConfigPath(_cwd: string): string {
	return join(gentleAiConfigHome(), "models.json");
}

export function modelExportPath(_cwd: string): string {
	return join(gentleAiConfigHome(), "models.export.json");
}

export const MODEL_EXPORT_KIND = "gentle-pi.agent_model_routing";
export const MODEL_EXPORT_VERSION = 1;

export function legacyProjectModelConfigPath(cwd: string): string {
	return join(cwd, ".pi", "gentle-ai", "models.json");
}

export function projectPersonaConfigPath(cwd: string): string {
	return join(cwd, ".pi", "gentle-ai", "persona.json");
}

export function personaConfigPath(_cwd: string): string {
	return join(gentleAiConfigHome(), "persona.json");
}

export function readPersonaFile(path: string): PersonaMode | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!isRecord(parsed)) return undefined;
		return parsed.mode === "neutral" ? "neutral" : "gentleman";
	} catch {
		return undefined;
	}
}

export function readPersonaMode(cwd: string): PersonaMode {
	return (
		readPersonaFile(projectPersonaConfigPath(cwd)) ??
		readPersonaFile(personaConfigPath(cwd)) ??
		"gentleman"
	);
}

export function writePersonaMode(cwd: string, mode: PersonaMode): string[] {
	const paths = [personaConfigPath(cwd)];
	const projectPath = projectPersonaConfigPath(cwd);
	if (existsSync(projectPath)) paths.push(projectPath);
	for (const path of paths) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ mode }, null, 2)}\n`);
	}
	return paths;
}

export function readSavedModelConfig(cwd: string): ModelConfigFileResult {
	const projectPath = legacyProjectModelConfigPath(cwd);
	const result = readModelRoutingAuthority(modelConfigPath(cwd), projectPath);
	return result.status === "invalid" && result.path === projectPath
		? { status: "valid", config: {} }
		: result;
}

export async function readSavedModelConfigAsync(
	cwd: string,
): Promise<ModelConfigFileResult> {
	const projectPath = legacyProjectModelConfigPath(cwd);
	const result = await readModelRoutingAuthorityAsync(modelConfigPath(cwd), projectPath);
	return result.status === "invalid" && result.path === projectPath
		? { status: "valid", config: {} }
		: result;
}

export function readModelConfig(cwd: string): AgentModelConfig {
	const result = readSavedModelConfig(cwd);
	return result.status === "valid" ? result.config : {};
}

export async function readModelConfigAsync(
	cwd: string,
): Promise<AgentModelConfig> {
	const result = await readSavedModelConfigAsync(cwd);
	return result.status === "valid" ? result.config : {};
}

export function writeModelConfig(cwd: string, config: AgentModelConfig): void {
	const path = modelConfigPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	const cleaned = normalizeModelConfig(config) ?? {};
	writeFileSync(path, `${JSON.stringify(cleaned, null, 2)}\n`);
}

export async function writeModelConfigAsync(cwd: string, config: AgentModelConfig): Promise<void> {
	const path = modelConfigPath(cwd);
	await mkdir(dirname(path), { recursive: true });
	const cleaned = normalizeModelConfig(config) ?? {};
	await writeFile(path, `${JSON.stringify(cleaned, null, 2)}\n`);
}

export function parseModelExport(value: unknown): AgentModelConfig | undefined {
	if (!isRecord(value)) return undefined;
	if (value.kind !== MODEL_EXPORT_KIND || value.version !== MODEL_EXPORT_VERSION) return undefined;
	return normalizeModelConfig(value.agents);
}

export function cloneModelConfig(config: AgentModelConfig): AgentModelConfig {
	return Object.fromEntries(
		Object.entries(config).map(([name, entry]) => [name, { ...entry }]),
	);
}

export function updateFrontmatterRouting(
	content: string,
	entry: AgentRoutingEntry | undefined,
): string {
	if (!content.startsWith("---\n")) return content;
	const endIndex = content.indexOf("\n---", 4);
	if (endIndex === -1) return content;
	const frontmatter = content.slice(4, endIndex);
	const body = content.slice(endIndex);
	const lines = frontmatter
		.split("\n")
		.filter(
			(line) => !line.startsWith("model:") && !line.startsWith("thinking:"),
		);
	const toInsert: string[] = [];
	if (entry?.model) toInsert.push(`model: ${entry.model}`);
	if (entry?.thinking) toInsert.push(`thinking: ${entry.thinking}`);
	if (toInsert.length > 0) {
		const descriptionIndex = lines.findIndex((line) =>
			line.startsWith("description:"),
		);
		const insertIndex =
			descriptionIndex >= 0 ? descriptionIndex + 1 : Math.min(1, lines.length);
		lines.splice(insertIndex, 0, ...toInsert);
	}
	return `---\n${lines.join("\n")}${body}`;
}

/**
 * The routing an agent file currently carries, read the same way
 * `updateFrontmatterRouting` writes it: top-level `model:` and `thinking:`
 * frontmatter lines. Anything else is "no routing", not an error.
 */
export function readFrontmatterRouting(content: string): AgentRoutingEntry | undefined {
	if (!content.startsWith("---\n")) return undefined;
	const endIndex = content.indexOf("\n---", 4);
	if (endIndex === -1) return undefined;
	const raw: Record<string, string> = {};
	for (const line of content.slice(4, endIndex).split("\n")) {
		if (line.startsWith("model:")) raw.model = line.slice("model:".length).trim();
		else if (line.startsWith("thinking:")) raw.thinking = line.slice("thinking:".length).trim();
	}
	if (raw.model === undefined && raw.thinking === undefined) return undefined;
	const entry = normalizeRoutingEntry(raw);
	return entry && !isClearRoutingEntry(entry) ? entry : undefined;
}

export function routingEntryFromModelProfile(value: unknown): AgentRoutingEntry | undefined {
	if (!isRecord(value)) return undefined;
	const entry = normalizeRoutingEntry({ model: value.model, thinking: value.effort });
	return entry && !isClearRoutingEntry(entry) ? entry : undefined;
}

export function mergeMaterializedRouting(
	profile: AgentRoutingEntry | undefined,
	frontmatter: AgentRoutingEntry | undefined,
): AgentRoutingEntry | undefined {
	if (!profile) return frontmatter;
	if (!frontmatter) return profile;
	return normalizeRoutingEntry({
		model: profile.model ?? frontmatter.model,
		thinking: profile.thinking ?? frontmatter.thinking,
	});
}

export function readSubagentModelProfiles(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) && isRecord(parsed.model_profiles) ? parsed.model_profiles : {};
	} catch {
		return {};
	}
}

export async function readSubagentModelProfilesAsync(path: string): Promise<Record<string, unknown>> {
	if (!(await pathExists(path))) return {};
	try {
		const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
		return isRecord(parsed) && isRecord(parsed.model_profiles) ? parsed.model_profiles : {};
	} catch {
		return {};
	}
}

/**
 * The routing an agent is materialized with — what subagent launches actually
 * resolve — regardless of what `models.json` records: the runtime reads
 * `subagents.json` model profiles first and the agent frontmatter otherwise,
 * independently for each routing field.
 */
export function readMaterializedRoutingEntry(
	cwd: string,
	agent: AgentEntry,
	profilesByPath: Map<string, Record<string, unknown>>,
): AgentRoutingEntry | undefined {
	const profilesPath = agentModelProfileConfigPath(cwd, agent.source);
	let profiles = profilesByPath.get(profilesPath);
	if (!profiles) {
		profiles = readSubagentModelProfiles(profilesPath);
		profilesByPath.set(profilesPath, profiles);
	}
	const fromProfile = routingEntryFromModelProfile(profiles[agent.name]);
	if (!agent.filePath || !existsSync(agent.filePath)) return fromProfile;
	try {
		return mergeMaterializedRouting(fromProfile, readFrontmatterRouting(readFileSync(agent.filePath, "utf8")));
	} catch {
		return fromProfile;
	}
}

export async function readMaterializedRoutingEntryAsync(
	cwd: string,
	agent: AgentEntry,
	profilesByPath: Map<string, Record<string, unknown>>,
): Promise<AgentRoutingEntry | undefined> {
	const profilesPath = agentModelProfileConfigPath(cwd, agent.source);
	let profiles = profilesByPath.get(profilesPath);
	if (!profiles) {
		profiles = await readSubagentModelProfilesAsync(profilesPath);
		profilesByPath.set(profilesPath, profiles);
	}
	const fromProfile = routingEntryFromModelProfile(profiles[agent.name]);
	if (!agent.filePath || !(await pathExists(agent.filePath))) return fromProfile;
	try {
		return mergeMaterializedRouting(fromProfile, readFrontmatterRouting(await readFile(agent.filePath, "utf8")));
	} catch {
		return fromProfile;
	}
}

/**
 * The routing a launch would resolve: a winning per-repository pin replaces subagent
 * routing wholesale, so when one wins it is the effective routing. The launch
 * resolver decides, so the profile shown as effective is exactly the profile a launch
 * would use -- there is no second precedence rule here.
 */
export function pinnedEffectiveModelConfig(cwd: string): AgentModelConfig | undefined {
	const resolution = resolveProfilePin({ cwd, configHome: gentleAiConfigHome() });
	return resolution === undefined ? undefined : cloneModelConfig(resolution.modelProfiles);
}

/**
 * The routing in effect: `models.json` where it speaks, and the materialized
 * stores the runtime resolves from for every discoverable agent it is silent
 * about. A sparse `models.json` therefore never hides routing that is still
 * live (#1012). A winning pin outranks both. Reading never writes.
 */
export function readEffectiveModelConfig(cwd: string): AgentModelConfig {
	return pinnedEffectiveModelConfig(cwd) ?? readGlobalEffectiveModelConfig(cwd);
}

/** The routing in effect once the pin is set aside: what a global save materializes. */
export function readGlobalEffectiveModelConfig(cwd: string): AgentModelConfig {
	const effective = cloneModelConfig(readModelConfig(cwd));
	const profilesByPath = new Map<string, Record<string, unknown>>();
	for (const agent of listDiscoverableAgents(cwd)) {
		if (isProviderReviewRole(agent.name) || agent.name in effective) continue;
		const entry = readMaterializedRoutingEntry(cwd, agent, profilesByPath);
		if (entry) effective[agent.name] = entry;
	}
	return effective;
}

export async function readEffectiveModelConfigAsync(cwd: string): Promise<AgentModelConfig> {
	const pinned = pinnedEffectiveModelConfig(cwd);
	if (pinned) return pinned;
	return readGlobalEffectiveModelConfigFromAsync(cwd, await readModelConfigAsync(cwd));
}

/**
 * The saved global routing merged with the materialized stores of every
 * discoverable agent it is silent about — the same effective view
 * `readEffectiveModelConfigAsync` builds, but starting from an already-read
 * saved routing so callers that must distinguish an unreadable authority can
 * keep that distinction while still seeing materialized routes.
 */
export async function readGlobalEffectiveModelConfigFromAsync(
	cwd: string,
	base: AgentModelConfig,
): Promise<AgentModelConfig> {
	const effective = cloneModelConfig(base);
	const profilesByPath = new Map<string, Record<string, unknown>>();
	for (const agent of await listDiscoverableAgentsAsync(cwd)) {
		if (isProviderReviewRole(agent.name) || agent.name in effective) continue;
		const entry = await readMaterializedRoutingEntryAsync(cwd, agent, profilesByPath);
		if (entry) effective[agent.name] = entry;
	}
	return effective;
}

/**
 * A profile is a complete routing snapshot: applying it must leave every
 * discoverable agent it omits on inherit, not on whatever was materialized
 * before. Padding the omitted agents with clear entries makes
 * `applyModelConfig` remove their model profiles and frontmatter routing, the
 * same way `/gentle:models` clears an agent set to inherit.
 */
export async function withOmittedAgentsClearedAsync(
	cwd: string,
	config: AgentModelConfig,
): Promise<AgentModelConfig> {
	const completed = cloneModelConfig(config);
	for (const agent of await listDiscoverableAgentsAsync(cwd)) {
		if (isProviderReviewRole(agent.name) || agent.name in completed) continue;
		completed[agent.name] = {};
	}
	return completed;
}

export function parseAgentName(filePath: string): string | undefined {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const name = content.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
	if (!name) return undefined;
	const packageName = content
		.match(/^package:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]
		?.trim();
	return packageName ? `${packageName}.${name}` : name;
}

export async function parseAgentNameAsync(
	filePath: string,
): Promise<string | undefined> {
	let content: string;
	try {
		content = await readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
	const name = content.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
	if (!name) return undefined;
	const packageName = content
		.match(/^package:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]
		?.trim();
	return packageName ? `${packageName}.${name}` : name;
}

export function listAgentFilesRecursive(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "skills") continue;
			files.push(...listAgentFilesRecursive(path));
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".md") &&
			!entry.name.endsWith(".chain.md")
		)
			files.push(path);
	}
	return files;
}

export async function listAgentFilesRecursiveAsync(dir: string): Promise<string[]> {
	if (!(await pathExists(dir))) return [];
	const files: string[] = [];
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "skills") continue;
			files.push(...(await listAgentFilesRecursiveAsync(path)));
		} else if (
			entry.isFile() &&
			entry.name.endsWith(".md") &&
			!entry.name.endsWith(".chain.md")
		) {
			files.push(path);
		}
	}
	return files;
}

export function listAgentsFromDir(dir: string, source: AgentSource): AgentEntry[] {
	return listAgentFilesRecursive(dir)
		.map((filePath): AgentEntry | undefined => {
			const name = parseAgentName(filePath);
			return name ? { name, source, filePath } : undefined;
		})
		.filter((entry): entry is AgentEntry => entry !== undefined);
}

export async function listAgentsFromDirAsync(
	dir: string,
	source: AgentSource,
): Promise<AgentEntry[]> {
	const filePaths = await listAgentFilesRecursiveAsync(dir);
	const entries: AgentEntry[] = [];
	for (const filePath of filePaths) {
		const name = await parseAgentNameAsync(filePath);
		if (name) entries.push({ name, source, filePath });
	}
	return entries;
}

export interface DiscoverableNonBuiltinAgentRoot {
	dir: string;
	source: AgentSource;
	/** The package installer owns this directory, so packageAssetAudit reports it. */
	packageManaged: boolean;
}

export function discoverableNonBuiltinAgentRoots(cwd: string): DiscoverableNonBuiltinAgentRoot[] {
	const globalAgentHome = gentlePiAgentHome();
	const roots: DiscoverableNonBuiltinAgentRoot[] = [
		{ dir: join(globalAgentHome, "agents"), source: "user", packageManaged: true },
		{ dir: join(globalAgentHome, "subagents"), source: "user", packageManaged: false },
		{ dir: join(homedir(), ".agents"), source: "user", packageManaged: false },
		{ dir: join(cwd, ".agents"), source: "project", packageManaged: false },
		{ dir: join(cwd, ".pi", "agents"), source: "project", packageManaged: false },
		{ dir: join(cwd, ".pi", "subagents"), source: "project", packageManaged: false },
	];
	const unique = new Map<string, DiscoverableNonBuiltinAgentRoot>();
	for (const root of roots) {
		let canonical: string;
		try {
			canonical = realpathSync(root.dir);
		} catch {
			canonical = resolve(root.dir);
		}
		const existing = unique.get(canonical);
		if (existing) {
			// Reinsert so a later alias keeps true later-root precedence even when
			// another physical root appears between the duplicate entries. A merged
			// package-managed root must keep its installer-owned path: ownership
			// updates validate that lexical path against the managed manifest root.
			const managedRoot = existing.packageManaged ? existing : root.packageManaged ? root : undefined;
			unique.delete(canonical);
			unique.set(canonical, {
				dir: managedRoot?.dir ?? root.dir,
				source: root.source,
				packageManaged: managedRoot !== undefined,
			});
		} else unique.set(canonical, root);
	}
	return [...unique.values()];
}

export function builtinAgentDirs(cwd: string): string[] {
	return [
		join(PACKAGE_ROOT, "..", "pi-subagents-j0k3r", "agents"),
		join(cwd, ".pi", "npm", "node_modules", "pi-subagents-j0k3r", "agents"),
		join(homedir(), ".local", "lib", "node_modules", "pi-subagents-j0k3r", "agents"),
		join(PACKAGE_ROOT, "..", "pi-subagents", "agents"),
		join(cwd, ".pi", "npm", "node_modules", "pi-subagents", "agents"),
		join(homedir(), ".local", "lib", "node_modules", "pi-subagents", "agents"),
	];
}

export function listDiscoverableAgents(cwd: string): AgentEntry[] {
	const builtinDirs = builtinAgentDirs(cwd);
	const agents = [
		...builtinDirs.flatMap((dir) => listAgentsFromDir(dir, "builtin")),
		...discoverableNonBuiltinAgentRoots(cwd).flatMap(({ dir, source }) =>
			listAgentsFromDir(dir, source),
		),
	];
	const byName = new Map<string, AgentEntry>();
	for (const agent of agents) byName.set(agent.name, agent);
	return orderDiscoverableAgents(Array.from(byName.values()));
}

export async function listDiscoverableAgentsAsync(cwd: string): Promise<AgentEntry[]> {
	const builtinDirs = builtinAgentDirs(cwd);
	const agents: AgentEntry[] = [];
	for (const dir of builtinDirs) {
		agents.push(...(await listAgentsFromDirAsync(dir, "builtin")));
	}
	for (const { dir, source } of discoverableNonBuiltinAgentRoots(cwd)) {
		agents.push(...(await listAgentsFromDirAsync(dir, source)));
	}
	const byName = new Map<string, AgentEntry>();
	for (const agent of agents) byName.set(agent.name, agent);
	return orderDiscoverableAgents(Array.from(byName.values()));
}

export function orderDiscoverableAgents(agents: AgentEntry[]): AgentEntry[] {
	const coreFirst = CORE_MODEL_AGENT_NAMES.map((name) =>
		agents.find((agent) => agent.name === name),
	).filter((agent): agent is AgentEntry => agent !== undefined);
	const rest = agents
		.filter((agent) => !CORE_MODEL_AGENT_NAME_SET.has(agent.name))
		.sort((left, right) => left.name.localeCompare(right.name));
	return [...coreFirst, ...rest];
}

export function isClearRoutingEntry(entry: AgentRoutingEntry): boolean {
	return entry.model === undefined && entry.thinking === undefined;
}

export function agentModelProfileConfigPath(cwd: string, source: AgentSource): string {
	return source === "project"
		? join(cwd, ".pi", "subagents.json")
		: join(gentlePiAgentHome(), "subagents.json");
}

export function modelProfileForRoutingEntry(
	entry: AgentRoutingEntry | undefined,
): Record<string, string> | undefined {
	if (!entry || isClearRoutingEntry(entry)) return undefined;
	const profile: Record<string, string> = {};
	if (entry.model) profile.model = entry.model;
	if (entry.thinking) profile.effort = entry.thinking;
	return Object.keys(profile).length > 0 ? profile : undefined;
}

export function updateSubagentModelProfileAtPath(
	path: string,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): boolean {
	let config: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (isRecord(parsed)) config = { ...parsed };
		} catch {
			config = {};
		}
	}
	const modelProfiles = isRecord(config.model_profiles)
		? { ...config.model_profiles }
		: {};
	const profile = modelProfileForRoutingEntry(entry);
	// A write that would leave the profile as it is (including removing a
	// profile that was never there) is not an update and touches no file.
	if (JSON.stringify(modelProfiles[name]) === JSON.stringify(profile)) return false;
	if (profile) {
		if (options.preserveExisting && isRecord(modelProfiles[name])) return false;
		modelProfiles[name] = profile;
	} else delete modelProfiles[name];
	if (Object.keys(modelProfiles).length > 0) config.model_profiles = modelProfiles;
	else delete config.model_profiles;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
	return true;
}

export async function updateSubagentModelProfileAtPathAsync(
	path: string,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): Promise<boolean> {
	let config: Record<string, unknown> = {};
	if (await pathExists(path)) {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			if (isRecord(parsed)) config = { ...parsed };
		} catch {
			config = {};
		}
	}
	const modelProfiles = isRecord(config.model_profiles)
		? { ...config.model_profiles }
		: {};
	const profile = modelProfileForRoutingEntry(entry);
	// A write that would leave the profile as it is (including removing a
	// profile that was never there) is not an update and touches no file.
	if (JSON.stringify(modelProfiles[name]) === JSON.stringify(profile)) return false;
	if (profile) {
		if (options.preserveExisting && isRecord(modelProfiles[name])) return false;
		modelProfiles[name] = profile;
	} else delete modelProfiles[name];
	if (Object.keys(modelProfiles).length > 0) config.model_profiles = modelProfiles;
	else delete config.model_profiles;
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
	return true;
}

export function updateSubagentModelProfile(
	cwd: string,
	source: AgentSource,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): boolean {
	return updateSubagentModelProfileAtPath(
		agentModelProfileConfigPath(cwd, source),
		name,
		entry,
		options,
	);
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

/**
 * Pi's own global settings file, which is where the orchestrator model lives.
 * Profiles own the three `default*` keys there; nothing else in this extension
 * reads or writes that file.
 */
export function orchestratorSettingsPath(): string {
	return join(gentlePiAgentHome(), "settings.json");
}

export function removeLegacyAgentOverridesFromSettings(
	settingsPath: string,
	settings: Record<string, unknown>,
): void {
	const subagents = isRecord(settings.subagents)
		? { ...settings.subagents }
		: undefined;
	if (!subagents) return;
	delete subagents.agentOverrides;
	if (Object.keys(subagents).length > 0) settings.subagents = subagents;
	else delete settings.subagents;
	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export function isValidJsonObjectFileOrMissing(path: string): boolean {
	if (!existsSync(path)) return true;
	try {
		return isRecord(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return false;
	}
}

export const PROVIDER_REVIEW_ROLES = ["review-refuter", "review-validator"] as const;

export function isProviderReviewRole(name: string): boolean {
	return PROVIDER_REVIEW_ROLES.some((role) => role === name);
}

export function modelAssignmentNames(cwd: string): string[] {
	return [...new Set([
		...PROVIDER_REVIEW_ROLES,
		...listDiscoverableAgents(cwd).map((agent) => agent.name),
	])];
}

export const PROVIDER_ROUTING_DEFAULT_LABELS = {
	model: "Pi persisted default model",
	effort: "Pi persisted default effort",
} as const;

export type RoutingDefaultField = keyof typeof PROVIDER_ROUTING_DEFAULT_LABELS;

export function routingDefaultLabel(name: string, field: RoutingDefaultField): string {
	return isProviderReviewRole(name) ? PROVIDER_ROUTING_DEFAULT_LABELS[field] : "inherit";
}

export function migrateLegacyProjectModelOverrides(cwd: string): number {
	const settingsPath = projectSettingsPath(cwd);
	if (!existsSync(settingsPath)) return 0;
	let settings: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (!isRecord(parsed)) return 0;
		settings = { ...parsed };
	} catch {
		return 0;
	}
	const subagents = isRecord(settings.subagents) ? settings.subagents : undefined;
	const agentOverrides = isRecord(subagents?.agentOverrides)
		? subagents.agentOverrides
		: undefined;
	if (!agentOverrides) return 0;
	const agentsByName = new Map(listDiscoverableAgents(cwd).map((agent) => [agent.name, agent]));
	const migratableEntries = Object.entries(agentOverrides)
		.filter(([name]) => !isProviderReviewRole(name))
		.map(([name, value]) => ({ name, entry: normalizeRoutingEntry(value) }))
		.filter((item): item is { name: string; entry: AgentRoutingEntry } =>
			item.entry !== undefined && !isClearRoutingEntry(item.entry),
		);
	const targetPaths = new Set(
		migratableEntries.map(({ name }) =>
			agentModelProfileConfigPath(cwd, agentsByName.get(name)?.source ?? "project"),
		),
	);
	if (![...targetPaths].every(isValidJsonObjectFileOrMissing)) return 0;
	let migrated = 0;
	for (const { name, entry } of migratableEntries) {
		const source = agentsByName.get(name)?.source ?? "project";
		if (updateSubagentModelProfile(cwd, source, name, entry, { preserveExisting: true })) migrated += 1;
	}
	removeLegacyAgentOverridesFromSettings(settingsPath, settings);
	return migrated;
}

export async function updateSubagentModelProfileAsync(
	cwd: string,
	source: AgentSource,
	name: string,
	entry: AgentRoutingEntry | undefined,
	options: { preserveExisting?: boolean } = {},
): Promise<boolean> {
	return updateSubagentModelProfileAtPathAsync(
		agentModelProfileConfigPath(cwd, source),
		name,
		entry,
		options,
	);
}

export function applyModelConfig(
	cwd: string,
	config: AgentModelConfig,
): { updated: number; skipped: number } {
	let updated = 0;
	let skipped = 0;
	const seenAgents = new Set<string>();
	for (const agent of listDiscoverableAgents(cwd)) {
		if (isProviderReviewRole(agent.name)) continue;
		seenAgents.add(agent.name);
		const entry = config[agent.name];
		if (entry === undefined) {
			skipped += 1;
			continue;
		}
		if (agent.source === "builtin") {
			if (updateSubagentModelProfile(cwd, agent.source, agent.name, entry)) updated += 1;
			else skipped += 1;
			continue;
		}
		if (!agent.filePath || !existsSync(agent.filePath)) {
			skipped += 1;
		} else {
			const original = readFileSync(agent.filePath, "utf8");
			const next = updateFrontmatterRouting(original, entry);
			if (next === original) {
				skipped += 1;
			} else {
				if (!updatePackageManagedSddAgentOwnership(agent.filePath, original, next)) {
					writeFileSync(agent.filePath, next);
				}
				updated += 1;
			}
		}
		if (updateSubagentModelProfile(cwd, agent.source, agent.name, entry)) updated += 1;
		else skipped += 1;
	}
	for (const [name, entry] of Object.entries(config)) {
		if (isProviderReviewRole(name)) continue;
		// The orchestrator is routing, not an agent: its model lives in Pi's global
		// settings.json and must never reach subagents.json.
		if (isProfileOrchestratorKey(name)) continue;
		if (!seenAgents.has(name) && isClearRoutingEntry(entry)) {
			if (updateSubagentModelProfile(cwd, "user", name, entry)) updated += 1;
			else skipped += 1;
		}
	}
	return { updated, skipped };
}

export async function applyModelConfigAsync(
	cwd: string,
	config: AgentModelConfig,
): Promise<{ updated: number; skipped: number }> {
	let updated = 0;
	let skipped = 0;
	const seenAgents = new Set<string>();
	for (const agent of await listDiscoverableAgentsAsync(cwd)) {
		if (isProviderReviewRole(agent.name)) continue;
		seenAgents.add(agent.name);
		const entry = config[agent.name];
		if (entry === undefined) {
			skipped += 1;
			continue;
		}
		if (agent.source === "builtin") {
			if (await updateSubagentModelProfileAsync(cwd, agent.source, agent.name, entry))
				updated += 1;
			else skipped += 1;
			continue;
		}
		if (!agent.filePath || !(await pathExists(agent.filePath))) {
			skipped += 1;
		} else {
			const original = await readFile(agent.filePath, "utf8");
			const next = updateFrontmatterRouting(original, entry);
			if (next === original) {
				skipped += 1;
			} else {
				if (!updatePackageManagedSddAgentOwnership(agent.filePath, original, next)) {
					await writeFile(agent.filePath, next);
				}
				updated += 1;
			}
		}
		if (await updateSubagentModelProfileAsync(cwd, agent.source, agent.name, entry))
			updated += 1;
		else skipped += 1;
	}
	for (const [name, entry] of Object.entries(config)) {
		if (isProviderReviewRole(name)) continue;
		if (isProfileOrchestratorKey(name)) continue;
		if (!seenAgents.has(name) && isClearRoutingEntry(entry)) {
			if (await updateSubagentModelProfileAsync(cwd, "user", name, entry))
				updated += 1;
			else skipped += 1;
		}
	}
	return { updated, skipped };
}

