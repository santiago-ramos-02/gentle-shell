import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { T3_GENTLE_AI_ENV, findForkGentleAiBinary, type ForkGentleAiProbe } from "../lib/t3-fork-gentle-ai.ts";

const binaries = (versions: Record<string, string | undefined>): ForkGentleAiProbe => ({
	isFile: (path) => path in versions,
	version: (path) => versions[path],
});
const bin = resolve("/opt/bin/gentle-ai");

test("the fork build T3 Code names wins", () => {
	assert.equal(findForkGentleAiBinary({ [T3_GENTLE_AI_ENV]: bin }, binaries({ [bin]: "4.0.0-t3.3707223" })), bin);
});

test("an upstream build T3 Code names leaves the pinned binary in charge", () => {
	assert.equal(findForkGentleAiBinary({ [T3_GENTLE_AI_ENV]: bin }, binaries({ [bin]: "4.0.0" })), undefined);
});

test("a binary whose version cannot be read is not a fork build", () => {
	assert.equal(findForkGentleAiBinary({ [T3_GENTLE_AI_ENV]: bin }, binaries({ [bin]: undefined })), undefined);
});

test("nothing named, a missing file, or a relative path leaves the pinned binary in charge", () => {
	const fork = binaries({ [bin]: "4.0.0-t3.3707223", "gentle-ai": "4.0.0-t3.3707223" });
	assert.equal(findForkGentleAiBinary({}, fork), undefined);
	assert.equal(findForkGentleAiBinary({ [T3_GENTLE_AI_ENV]: resolve("/missing/gentle-ai") }, fork), undefined);
	assert.equal(findForkGentleAiBinary({ [T3_GENTLE_AI_ENV]: "gentle-ai" }, fork), undefined);
});
