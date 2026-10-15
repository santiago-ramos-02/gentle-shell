import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installPackageAssets } from "../lib/agent-assets.ts";

function withAgentHome(t: { after(fn: () => void): void }): { root: string; lockPath: string } {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-stale-lock-"));
	const agentHome = join(root, "agent-home");
	const previous = process.env.GENTLE_PI_AGENT_HOME;
	process.env.GENTLE_PI_AGENT_HOME = agentHome;
	t.after(() => {
		if (previous === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
		else process.env.GENTLE_PI_AGENT_HOME = previous;
		rmSync(root, { recursive: true, force: true });
	});
	mkdirSync(join(agentHome, "gentle-ai"), { recursive: true });
	return { root, lockPath: join(agentHome, "gentle-ai", "managed-assets.lock") };
}

const owner = (pid: number, createdAtMs: number) => JSON.stringify({ schemaVersion: 1, token: "left-behind", pid, createdAtMs });

test("a managed-assets lock left by a dead process is reclaimed without waiting for the timeout", (t) => {
	const { root, lockPath } = withAgentHome(t);
	// Beyond the pid range a platform can assign, so no live process owns it.
	writeFileSync(lockPath, owner(2 ** 31 - 2, Date.now()));
	const started = Date.now();
	installPackageAssets(root, false, ["delegation"]);
	assert.ok(Date.now() - started < 2_000, `install waited ${Date.now() - started}ms on a dead owner's lock`);
	assert.equal(existsSync(lockPath), false);
});

test("a managed-assets lock older than any critical section is reclaimed even when its pid is alive", (t) => {
	const { root, lockPath } = withAgentHome(t);
	writeFileSync(lockPath, owner(process.pid, Date.now() - 10 * 60_000));
	const started = Date.now();
	installPackageAssets(root, false, ["delegation"]);
	assert.ok(Date.now() - started < 2_000);
	assert.equal(existsSync(lockPath), false);
});

test("a fresh managed-assets lock held by a live process is never taken over", (t) => {
	const { root, lockPath } = withAgentHome(t);
	const held = owner(process.pid, Date.now());
	writeFileSync(lockPath, held);
	assert.throws(() => installPackageAssets(root, false, ["delegation"]), /Timed out acquiring managed-assets lock file/i);
	assert.equal(readFileSync(lockPath, "utf8"), held);
});
