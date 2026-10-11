import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import {
	BUNDLED_VERIFY_ENV,
	bundledChildEnv,
	bundledPi,
	bundledSetupEnv,
	bundledUpdateNext,
	bundledUpdateNotice,
	bundledUpdatePlan,
	parseBundledUpgradeArgs,
	withBundledNpmCommand,
	resolveBundledInstall,
	type BundledFs,
	type BundledPi,
} from "../lib/gentle-shell-bundled.ts";

// A fake filesystem keyed by exact paths, so every platform's paths are plain
// strings on every runner: realpath maps a link to its target, and any other
// path holding a file to itself; readText returns a regular file's text,
// readLink a symlink's.
function fakeFs({ real = {}, files = {}, links = {} }: { real?: Record<string, string>; files?: Record<string, string>; links?: Record<string, string> }): BundledFs {
	const known = [...Object.keys(files), ...Object.keys(links), ...Object.values(real)];
	const exists = (path: string) => known.some((entry) => entry === path || entry.startsWith(`${path}/`) || entry.startsWith(`${path}\\`));
	return {
		realpath: (path) => real[path] ?? (exists(path) ? path : undefined),
		readText: (path) => files[path],
		readLink: (path) => links[path],
	};
}

const ID = "4.1.0-1.1.0";
const POSIX_ROOT = "/home/ana/.gentle-shell";
const POSIX_VERSION = posix.join(POSIX_ROOT, "versions", ID);
const POSIX_PACKAGE = posix.join(POSIX_VERSION, "node_modules", ".pnpm", "gentle-pi@4.1.0", "node_modules", "gentle-pi");
const PI_PACKAGE = (version: string, path = posix) => path.join(version, "node_modules", "@earendil-works", "pi-coding-agent");

function posixInstall(overrides: { current?: string; marker?: string; link?: string } = {}) {
	return fakeFs({
		real: { [posix.join(POSIX_VERSION, "node_modules", "gentle-pi")]: overrides.link ?? POSIX_PACKAGE },
		files: { [posix.join(POSIX_VERSION, ".gentle-shell-version")]: overrides.marker ?? `${ID}\n`, [posix.join(POSIX_PACKAGE, "package.json")]: "{}" },
		links: { [posix.join(POSIX_ROOT, "current")]: overrides.current ?? `versions/${ID}` },
	});
}

test("resolveBundledInstall finds the version folder current names from the real package root", () => {
	assert.deepEqual(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: posixInstall() }),
		{ root: POSIX_ROOT, id: ID, versionDir: POSIX_VERSION });
});

test("resolveBundledInstall is off unless current names this marked version and its gentle-pi is this package", () => {
	// Kept for rollback, but not the active one.
	assert.equal(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: posixInstall({ current: "versions/4.0.0-1.0.0" }) }), undefined);
	// An unfinished install, or a folder without our marker.
	assert.equal(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: posixInstall({ marker: `installing ${ID} 42\n` }) }), undefined);
	// The version's gentle-pi is another copy, not the running one.
	assert.equal(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: posixInstall({ link: "/elsewhere/gentle-pi" }) }), undefined);
	// A global npm or pnpm install, or a source checkout.
	for (const packageRoot of ["/usr/lib/node_modules/gentle-pi", "/home/ana/.local/share/pnpm/global/5/node_modules/gentle-pi", "/home/ana/src/gentle-shell"]) {
		assert.equal(resolveBundledInstall({ packageRoot, platform: "linux", fs: posixInstall() }), undefined, packageRoot);
	}
	// An id the bundled install never writes.
	const unsafe = posix.join(POSIX_ROOT, "versions", "-x", "node_modules", "gentle-pi");
	assert.equal(resolveBundledInstall({ packageRoot: unsafe, platform: "linux", fs: fakeFs({
		files: { [posix.join(POSIX_ROOT, "versions", "-x", ".gentle-shell-version")]: "-x\n" }, links: { [posix.join(POSIX_ROOT, "current")]: "versions/-x" } }) }), undefined);
});

test("resolveBundledInstall treats only the version being verified as current, for that check", () => {
	const kept = posixInstall({ current: "versions/4.0.0-1.0.0" });
	assert.deepEqual(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: kept, verifying: ID }), { root: POSIX_ROOT, id: ID, versionDir: POSIX_VERSION });
	assert.equal(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: kept, verifying: "4.0.0-1.0.0" }), undefined);
	// The marker and the package location are still required.
	assert.equal(resolveBundledInstall({ packageRoot: POSIX_PACKAGE, platform: "linux", fs: posixInstall({ current: "versions/x", marker: "x\n" }), verifying: ID }), undefined);
});

test("resolveBundledInstall on Windows reads the current pointer file, never a link", () => {
	const root = "C:\\Users\\Ana\\AppData\\Local\\gentle-shell";
	const version = win32.join(root, "versions", ID);
	const packageRoot = win32.join(version, "node_modules", ".pnpm", "gentle-pi@4.1.0", "node_modules", "gentle-pi");
	const files = { [win32.join(version, ".gentle-shell-version")]: `${ID}\n`, [win32.join(root, "current")]: `${ID}\n` };
	const real = { [win32.join(version, "node_modules", "gentle-pi")]: packageRoot };
	assert.deepEqual(resolveBundledInstall({ packageRoot, platform: "win32", fs: fakeFs({ real, files }) }), { root, id: ID, versionDir: version });
	const linked = fakeFs({ real, files: { [win32.join(version, ".gentle-shell-version")]: `${ID}\n` }, links: { [win32.join(root, "current")]: `versions/${ID}` } });
	assert.equal(resolveBundledInstall({ packageRoot, platform: "win32", fs: linked }), undefined);
});

function piFiles(pinned: string, installed: string, path = posix, version = POSIX_VERSION) {
	const pi = PI_PACKAGE(version, path);
	return {
		[path.join(version, "package.json")]: JSON.stringify({ dependencies: { "gentle-pi": "4.1.0", "@earendil-works/pi-coding-agent": pinned } }),
		[path.join(pi, "package.json")]: JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: installed, bin: { pi: "dist/bundle/cli.js" } }),
		[path.join(pi, "dist", "bundle", "cli.js")]: "",
	};
}
const install = { root: POSIX_ROOT, id: ID, versionDir: POSIX_VERSION };
const messageOf = (pi: BundledPi) => ("message" in pi ? pi.message : "");

test("bundledPi returns only the Pi the version pins, inside the version folder", () => {
	assert.deepEqual(bundledPi(install, { platform: "linux", fs: fakeFs({ files: piFiles("1.1.0", "1.1.0") }) }),
		{ ok: true, version: "1.1.0", cli: posix.join(PI_PACKAGE(POSIX_VERSION), "dist", "bundle", "cli.js") });
	const windows = { root: "C:\\G", id: ID, versionDir: `C:\\G\\versions\\${ID}` };
	assert.deepEqual(bundledPi(windows, { platform: "win32", fs: fakeFs({ files: piFiles("1.1.0", "1.1.0", win32, windows.versionDir) }) }),
		{ ok: true, version: "1.1.0", cli: win32.join(PI_PACKAGE(windows.versionDir, win32), "dist", "bundle", "cli.js") });
});

test("bundledPi fails with the version, the pinned Pi and the way to repair it", () => {
	const repair = /Gentle Shell 4\.1\.0-1\.1\.0 .*Pi 1\.1\.0.*gentle-shell upgrade.*installer/s;
	const mismatch = bundledPi(install, { platform: "linux", fs: fakeFs({ files: piFiles("1.1.0", "1.0.0") }) });
	assert.equal(mismatch.ok, false);
	assert.match(messageOf(mismatch), repair);
	assert.match(messageOf(mismatch), /found Pi 1\.0\.0/);
	const files = piFiles("1.1.0", "1.1.0");
	delete files[posix.join(PI_PACKAGE(POSIX_VERSION), "dist", "bundle", "cli.js")];
	const missing = bundledPi(install, { platform: "linux", fs: fakeFs({ files }) });
	assert.match(messageOf(missing), repair);
	// A Pi linked from outside the version folder is not the bundled one.
	const outside = fakeFs({ real: { [PI_PACKAGE(POSIX_VERSION)]: "/usr/lib/node_modules/@earendil-works/pi-coding-agent" }, files: piFiles("1.1.0", "1.1.0") });
	assert.equal(bundledPi(install, { platform: "linux", fs: outside }).ok, false);
});

test("bundledChildEnv keeps the user's environment and adds only the bundled Pi, no Pi override and no Pi update check", () => {
	const user = { PATH: "/home/ana/.nvm/bin:/usr/bin", NODE_OPTIONS: "--max-old-space-size=4096", npm_config_registry: "https://npm.example", npm_config_prefix: "/home/ana/.npm-global",
		GENTLE_SHELL_PI: "/usr/local/bin/pi", GENTLE_PI_AGENTS_PI: "pi", [BUNDLED_VERIFY_ENV]: ID };
	const env = bundledChildEnv(user, { node: "/g/node", cli: "/g/cli.js" });
	assert.deepEqual(env, { PATH: user.PATH, NODE_OPTIONS: user.NODE_OPTIONS, npm_config_registry: user.npm_config_registry, npm_config_prefix: user.npm_config_prefix,
		GENTLE_PI_AGENTS_PI: "/g/node /g/cli.js", PI_SKIP_VERSION_CHECK: "1" });
	// The subagent runner splits that variable on whitespace: a spaced path falls
	// back to its own default, the running node and cli.js.
	const spaced = bundledChildEnv({ GENTLE_PI_AGENTS_PI: "pi" }, { node: "C:\\Users\\Ana Li\\node.exe", cli: "C:\\cli.js" });
	assert.equal("GENTLE_PI_AGENTS_PI" in spaced, false);
});

test("bundledSetupEnv puts only our node and the version's bin ahead of the user's PATH", () => {
	const env = bundledSetupEnv({ PATH: "/usr/bin", NODE_OPTIONS: "--x", npm_config_registry: "r" }, { dirs: ["/g/node-bin", "/g/v/node_modules/.bin"], platform: "linux" });
	assert.deepEqual(env, { PATH: "/g/node-bin:/g/v/node_modules/.bin:/usr/bin", NODE_OPTIONS: "--x", npm_config_registry: "r" });
	const windows = bundledSetupEnv({ Path: "C:\\Windows" }, { dirs: ["C:\\G\\node"], platform: "win32" });
	assert.deepEqual(windows, { Path: "C:\\G\\node;C:\\Windows" });
});

test("withBundledNpmCommand sets only npmCommand and leaves an already bundled settings file as it is", () => {
	const command = ["/g/node", "/g/npm-cli.js", "--userconfig=/g/npmrc"];
	const text = '{\n    "theme": "gentle",\n    "packages": ["npm:x"]\n}\n';
	const added = withBundledNpmCommand(text, command);
	assert.equal(added.status, "write");
	const written = added.status === "write" ? added.text : "";
	assert.deepEqual(JSON.parse(written), { theme: "gentle", packages: ["npm:x"], npmCommand: command });
	assert.match(written, /^\{\n {4}"theme"/);
	assert.ok(written.endsWith("}\n"));
	assert.deepEqual(withBundledNpmCommand(written, command), { status: "unchanged" });
	const replaced = withBundledNpmCommand('{"npmCommand":["npm"]}', command);
	assert.deepEqual(JSON.parse(replaced.status === "write" ? replaced.text : "{}"), { npmCommand: command });
	assert.deepEqual(JSON.parse((withBundledNpmCommand(undefined, command) as { text: string }).text), { npmCommand: command });
	for (const malformed of ["{", "[]", "null"]) assert.deepEqual(withBundledNpmCommand(malformed, command), { status: "malformed" });
});

test("bundledUpdatePlan redirects Pi's own update and keeps the extension updates", () => {
	assert.deepEqual(bundledUpdatePlan(["update"]), { self: true });
	assert.deepEqual(bundledUpdatePlan(["update", "--self"]), { self: true });
	assert.deepEqual(bundledUpdatePlan(["update", "pi"]), { self: true });
	assert.deepEqual(bundledUpdatePlan(["update", "self"]), { self: true });
	assert.deepEqual(bundledUpdatePlan(["update", "--all"]), { self: true, piArgs: ["update", "--extensions"] });
	assert.deepEqual(bundledUpdatePlan(["update", "--self", "--extensions", "--approve"]), { self: true, piArgs: ["update", "--extensions", "--approve"] });
	// Pi reads a self positional with --extensions as "all" too.
	for (const target of ["pi", "self"]) {
		assert.deepEqual(bundledUpdatePlan(["update", target, "--extensions"]), { self: true, piArgs: ["update", "--extensions"] }, target);
		assert.deepEqual(bundledUpdatePlan(["update", "--extensions", target, "-a"]), { self: true, piArgs: ["update", "--extensions", "-a"] }, target);
	}
	// Pi itself refuses conflicting or unknown forms before updating anything.
	for (const passthrough of [["update", "--extensions"], ["update", "npm:x"], ["update", "--models"], ["update", "--extension", "npm:x"], ["update", "--help"],
		["update", "--all", "--self"], ["update", "pi", "--all"], ["update", "pi", "npm:x"], ["update", "--bogus"]]) {
		assert.deepEqual(bundledUpdatePlan(passthrough), { self: false, piArgs: passthrough }, passthrough.join(" "));
	}
});

test("bundledUpdateNext still updates extensions when the upgrade did not complete", () => {
	assert.deepEqual(bundledUpdateNext({ self: false, piArgs: ["update", "npm:x"] }, undefined), { piArgs: ["update", "npm:x"] });
	assert.deepEqual(bundledUpdateNext({ self: true }, 0), { exitCode: 0 });
	assert.deepEqual(bundledUpdateNext({ self: true }, 1), { exitCode: 1 });
	assert.deepEqual(bundledUpdateNext({ self: true }, undefined), { exitCode: 0 });
	assert.deepEqual(bundledUpdateNext({ self: true, piArgs: ["update", "--extensions"] }, 0), { piArgs: ["update", "--extensions"] });
	const failed = bundledUpdateNext({ self: true, piArgs: ["update", "--extensions"] }, 1);
	assert.deepEqual("piArgs" in failed ? failed.piArgs : [], ["update", "--extensions"]);
	assert.match("note" in failed ? String(failed.note) : "", /upgrade did not complete.*extensions/);
});

test("bundledUpdateNotice explains the pinned Pi and runs or names gentle-shell upgrade", () => {
	const interactive = bundledUpdateNotice({ piVersion: "1.1.0", interactive: true }).join("\n");
	assert.match(interactive, /Pi ships pinned with Gentle Shell \(Pi 1\.1\.0\)/);
	assert.match(interactive, /Running 'gentle-shell upgrade'/);
	assert.match(bundledUpdateNotice({ piVersion: "1.1.0", interactive: false }).join("\n"), /Run 'gentle-shell upgrade'/);
});

test("parseBundledUpgradeArgs accepts the release channel and --rollback and refuses the main channel", () => {
	assert.deepEqual(parseBundledUpgradeArgs([]), { action: "upgrade" });
	assert.deepEqual(parseBundledUpgradeArgs(["--channel", "release"]), { action: "upgrade" });
	assert.deepEqual(parseBundledUpgradeArgs(["--channel=release"]), { action: "upgrade" });
	assert.deepEqual(parseBundledUpgradeArgs(["--rollback"]), { action: "rollback" });
	for (const args of [["--channel", "main"], ["--channel=main"]]) {
		const parsed = parseBundledUpgradeArgs(args);
		assert.equal("error" in parsed && parsed.usage, false);
		assert.match("error" in parsed ? parsed.error : "", /release channel only/);
	}
	for (const args of [["--rollback", "--channel", "release"], ["--channel"], ["--nope"]]) {
		const parsed = parseBundledUpgradeArgs(args);
		assert.equal("error" in parsed && parsed.usage, true, args.join(" "));
	}
});

// The real bin, run from a bundled prefix: a copy of bin/ and package.json
// placed where pnpm puts gentle-pi (runtime/ and scripts/ linked from this
// checkout), a fake exact Pi beside it, and `current` naming the version.
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const posixHost = process.platform === "win32" ? "the bundled prefix fixture uses a POSIX current symlink" : false;
const SHELL = JSON.parse(readFileSync(join(repository, "package.json"), "utf8")).version;
const FIXTURE_ID = `${SHELL}-1.1.0`;
const FAKE_PI = [
	"const args = process.argv.slice(2);",
	"if (args.includes('--version')) { console.log('1.1.0'); process.exit(0); }",
	"const pick = ['PATH', 'GENTLE_SHELL_PI', 'GENTLE_PI_AGENTS_PI', 'PI_SKIP_VERSION_CHECK', 'npm_config_prefix', 'npm_config_registry', 'NODE_OPTIONS', 'PI_CODING_AGENT_DIR'];",
	"console.log(JSON.stringify({ cli: process.argv[1], args, env: Object.fromEntries(pick.map((k) => [k, process.env[k]])) }));",
].join("\n");

function bundledPrefix(t: TestContext, { pi = "1.1.0" } = {}) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "gentle-shell-bundled-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const home = join(base, "home");
	const root = join(home, ".gentle-shell");
	const version = join(root, "versions", FIXTURE_ID);
	const modules = join(version, "node_modules");
	const shell = join(modules, ".pnpm", `gentle-pi@${SHELL}`, "node_modules", "gentle-pi");
	mkdirSync(join(shell, "bin"), { recursive: true });
	writeFileSync(join(shell, "bin", "gentle-shell.mjs"), readFileSync(join(repository, "bin", "gentle-shell.mjs")));
	writeFileSync(join(shell, "package.json"), readFileSync(join(repository, "package.json")));
	for (const dir of ["runtime", "scripts"]) symlinkSync(join(repository, dir), join(shell, dir));
	symlinkSync(shell, join(modules, "gentle-pi"));
	const piDir = join(modules, "@earendil-works", "pi-coding-agent");
	mkdirSync(join(piDir, "dist", "bundle"), { recursive: true });
	writeFileSync(join(piDir, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: pi, bin: { pi: "dist/bundle/cli.js" } }));
	writeFileSync(join(piDir, "dist", "bundle", "cli.js"), FAKE_PI);
	writeFileSync(join(version, "package.json"), JSON.stringify({ dependencies: { "gentle-pi": SHELL, "@earendil-works/pi-coding-agent": "1.1.0" } }));
	writeFileSync(join(version, ".gentle-shell-version"), `${FIXTURE_ID}\n`);
	symlinkSync(`versions/${FIXTURE_ID}`, join(root, "current"));
	// The bundled npm the npmCommand entry loads.
	const npmCli = join(root, "runtime", "node-24.21.0", "lib", "node_modules", "npm", "bin", "npm-cli.js");
	mkdirSync(dirname(npmCli), { recursive: true });
	writeFileSync(npmCli, "console.log('11.19.0');\n");
	// A Pi on PATH and in GENTLE_SHELL_PI that must never run.
	const userBin = join(base, "user-bin");
	mkdirSync(userBin);
	writeFileSync(join(userBin, "pi"), "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 });
	const env = { HOME: home, PATH: `${userBin}:/usr/bin:/bin`, GENTLE_SHELL_PI: join(userBin, "pi"), GENTLE_SHELL_NO_AUTO_SETUP: "1",
		NODE_OPTIONS: "--no-warnings", npm_config_registry: "https://npm.example" };
	const entry = join(root, "current", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
	const run = (args: string[], extra: Record<string, string> = {}) => spawnSync(process.execPath, [entry, ...args], { env: { ...env, ...extra }, encoding: "utf8", input: "" });
	return { root, home, userBin, version, piDir, npmCli, run, env, entry: join(shell, "bin", "gentle-shell.mjs") };
}

test("the bundled launcher runs only its version's Pi, with the user's environment and the bundled npm in its own home", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const version = prefix.run(["--version"]);
	assert.equal(version.status, 0, version.stderr);
	assert.match(version.stdout, new RegExp(`^gentle-shell ${SHELL.replaceAll(".", "\\.")}\npi 1\\.1\\.0\n`));
	const launched = prefix.run(["list"]);
	assert.equal(launched.status, 0, launched.stderr);
	const seen = JSON.parse(launched.stdout.trim().split("\n").at(-1) ?? "{}");
	assert.equal(seen.cli, join(realpathSync(prefix.piDir), "dist", "bundle", "cli.js"));
	assert.deepEqual(seen.args, ["list"]);
	assert.equal(seen.env.GENTLE_SHELL_PI, undefined);
	assert.equal(seen.env.PI_SKIP_VERSION_CHECK, "1");
	assert.equal(seen.env.GENTLE_PI_AGENTS_PI, `${process.execPath} ${seen.cli}`);
	// S9: what the agent runs in the user's projects sees the user's tools and settings.
	assert.equal(seen.env.PATH, prefix.env.PATH);
	assert.equal(seen.env.NODE_OPTIONS, "--no-warnings");
	assert.equal(seen.env.npm_config_registry, "https://npm.example");
	assert.equal(seen.env.npm_config_prefix, undefined);
	// Pi's own npm is ours, configured only from the prefix, through the isolated home's settings.
	const settings = JSON.parse(readFileSync(join(prefix.home, ".gentle-shell", "agent", "settings.json"), "utf8"));
	const shim = join(prefix.root, "runtime", "node-24.21.0", "gentle-shell", "npm");
	assert.deepEqual(settings.npmCommand.slice(0, 2), [join(prefix.root, "runtime", "node-24.21.0", "bin", "node"), shim]);
	// The entry named npm exists before Pi is given it, and runs our npm.
	assert.equal(spawnSync(process.execPath, [shim, "--version"], { encoding: "utf8" }).stdout, "11.19.0\n");
	assert.ok(settings.npmCommand.includes(`--userconfig=${join(prefix.root, "pnpm", "config", "npmrc")}`));
	assert.equal(settings.npmCommand.some((part: string) => part.startsWith("--prefix")), false);
	// --link is the user's own Pi home: never given our npm.
	const linked = join(prefix.home, ".pi", "agent");
	mkdirSync(linked, { recursive: true });
	writeFileSync(join(linked, "settings.json"), "{}\n");
	assert.equal(prefix.run(["--link", "list"]).status, 0);
	assert.equal(readFileSync(join(linked, "settings.json"), "utf8"), "{}\n");
});

test("a home holding the npmCommand written before the npm entry existed gets only that key updated", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const node = join(prefix.root, "runtime", "node-24.21.0");
	const flags = [`--userconfig=${join(prefix.root, "pnpm", "config", "npmrc")}`, `--globalconfig=${join(prefix.root, "npm", "npmrc")}`,
		`--cache=${join(prefix.root, "npm", "cache")}`, "--update-notifier=false"];
	// The value written before N1: npm-cli.js directly, and a --prefix flag.
	const previous = [join(node, "bin", "node"), prefix.npmCli, ...flags.slice(0, 3), `--prefix=${join(prefix.root, "npm", "prefix")}`, flags[3]];
	const agent = join(prefix.home, ".gentle-shell", "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "settings.json"), `${JSON.stringify({ theme: "gentle", npmCommand: previous, packages: ["npm:x"] }, null, 2)}\n`);
	assert.equal(prefix.run(["list"]).status, 0);
	const settings = JSON.parse(readFileSync(join(agent, "settings.json"), "utf8"));
	assert.deepEqual(settings, { theme: "gentle", npmCommand: [join(node, "bin", "node"), join(node, "gentle-shell", "npm"), ...flags], packages: ["npm:x"] });
});

test("a runtime without our npm gives Pi no npmCommand and says so", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	rmSync(prefix.npmCli);
	const result = prefix.run(["list"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stderr, /could not give Pi the bundled npm.*Bundled npm missing/);
	const settings = join(prefix.home, ".gentle-shell", "agent", "settings.json");
	assert.equal(existsSync(settings) && "npmCommand" in JSON.parse(readFileSync(settings, "utf8")), false);
});

test("the version check before activation runs that version in bundled mode, never a PATH Pi", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const other = join(prefix.root, "versions", "0.0.1-1.0.0");
	mkdirSync(other);
	writeFileSync(join(other, ".gentle-shell-version"), "0.0.1-1.0.0\n");
	rmSync(join(prefix.root, "current"));
	symlinkSync("versions/0.0.1-1.0.0", join(prefix.root, "current"));
	const verify = (env: Record<string, string>) => spawnSync(process.execPath, [prefix.entry, "--version"], { env: { HOME: prefix.home, PATH: `${prefix.userBin}:/usr/bin:/bin`, ...env },
		encoding: "utf8", input: "" });
	const good = verify({ [BUNDLED_VERIFY_ENV]: FIXTURE_ID });
	assert.equal(good.status, 0, good.stderr);
	assert.match(good.stdout, /\npi 1\.1\.0\n/);
	// The version's own Pi is broken, and the user's Pi prints the expected version.
	writeFileSync(join(prefix.userBin, "pi"), "#!/bin/sh\necho 1.1.0\n", { mode: 0o755 });
	rmSync(join(prefix.piDir, "dist", "bundle", "cli.js"));
	const broken = verify({ [BUNDLED_VERIFY_ENV]: FIXTURE_ID });
	assert.equal(broken.status, 1);
	assert.match(broken.stderr, /bundled Pi 1\.1\.0/);
	// Without the verification input, the same entry is an ordinary launcher that would pass.
	assert.match(verify({}).stdout, /\npi 1\.1\.0\n/);
	// Only --version honors it.
	const list = spawnSync(process.execPath, [prefix.entry, "list"], { env: { HOME: prefix.home, PATH: `${prefix.userBin}:/usr/bin:/bin`, [BUNDLED_VERIFY_ENV]: FIXTURE_ID,
		GENTLE_SHELL_NO_AUTO_SETUP: "1" }, encoding: "utf8", input: "" });
	assert.equal(list.stdout, "1.1.0\n");
});

test("the bundled launcher refuses a Pi that is not the pinned one", { skip: posixHost }, (t) => {
	const result = bundledPrefix(t, { pi: "1.0.0" }).run(["--version"]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, new RegExp(`Gentle Shell ${FIXTURE_ID.replaceAll(".", "\\.")} .*gentle-shell upgrade`, "s"));
	assert.doesNotMatch(result.stdout, /9\.9\.9/);
});

test("gentle-shell update in a bundled install explains the pinned Pi instead of updating it", { skip: posixHost }, (t) => {
	const result = bundledPrefix(t).run(["update"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Pi ships pinned with Gentle Shell \(Pi 1\.1\.0\)/);
	assert.match(result.stdout, /Run 'gentle-shell upgrade'/);
	assert.doesNotMatch(result.stdout, /"args"/);
});

test("gentle-shell update pi --extensions in a bundled install redirects Pi's part and still updates the extensions with the bundled npm", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const result = prefix.run(["update", "pi", "--extensions"]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Pi ships pinned with Gentle Shell \(Pi 1\.1\.0\)/);
	const seen = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
	assert.deepEqual(seen.args, ["update", "--extensions"]);
	assert.ok(JSON.parse(readFileSync(join(prefix.home, ".gentle-shell", "agent", "settings.json"), "utf8")).npmCommand);
});

test("a kept version that current does not name keeps the ordinary launcher, Pi override and Pi update included", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const other = join(prefix.root, "versions", "0.0.1-1.0.0");
	mkdirSync(other);
	writeFileSync(join(other, ".gentle-shell-version"), "0.0.1-1.0.0\n");
	rmSync(join(prefix.root, "current"));
	symlinkSync("versions/0.0.1-1.0.0", join(prefix.root, "current"));
	const update = spawnSync(process.execPath, [prefix.entry, "update"], { env: { HOME: dirname(prefix.root), PATH: "/usr/bin:/bin",
		GENTLE_SHELL_PI: join(dirname(dirname(prefix.root)), "user-bin", "pi"), GENTLE_SHELL_NO_AUTO_SETUP: "1" }, encoding: "utf8", input: "" });
	assert.equal(update.status, 0, update.stderr);
	assert.equal(update.stdout, "9.9.9\n");
});

test("gentle-shell upgrade in a bundled install refuses the main channel and rolls back to the kept version", { skip: posixHost }, (t) => {
	const prefix = bundledPrefix(t);
	const main = prefix.run(["upgrade", "--channel", "main"]);
	assert.equal(main.status, 1);
	assert.match(main.stderr, /release channel only/);
	const none = prefix.run(["upgrade", "--rollback"]);
	assert.equal(none.status, 1);
	assert.match(none.stderr, /No previous Gentle Shell version/);
	assert.equal(readlinkSync(join(prefix.root, "current")), `versions/${FIXTURE_ID}`);
});
