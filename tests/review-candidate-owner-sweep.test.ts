import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setWindowsAclAuthorityForTesting, sweepCandidateOwners } from "../lib/review-candidate-view-owner.ts";

// Windows has no boot provenance, so no owner is ever provably dead.
test("owner sweep skips marker validation where no owner can be reclaimed", { skip: process.platform === "linux" || process.platform === "darwin" }, () => {
	const commonDir = mkdtempSync(join(tmpdir(), "gentle-owner-sweep-"));
	const probes: string[] = [];
	setWindowsAclAuthorityForTesting((path) => { probes.push(path); });
	try {
		const parent = join(commonDir, "gentle-ai", "candidate-views");
		mkdirSync(parent, { recursive: true });
		const uuid = "0b77b6cd-c15a-4ded-835f-8b81ad1019ec";
		const root = join(parent, uuid);
		mkdirSync(root);
		writeFileSync(`${root}.owner.json`, JSON.stringify({ version: 1, uuid, token: uuid, pid: 1, host: null, root, commonDir }));
		const git: string[][] = [];
		sweepCandidateOwners(commonDir, (args) => { git.push(args); return ""; }, () => {}, "win32");
		assert.deepEqual(probes, []);
		assert.deepEqual(git, []);
	} finally {
		setWindowsAclAuthorityForTesting();
		rmSync(commonDir, { recursive: true, force: true });
	}
});
