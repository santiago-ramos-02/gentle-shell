import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("runtime-t3 covers every lib module the gentle-pi API imports", () => {
	const output = execFileSync(process.execPath, [join(root, "scripts", "t3-build-api.mjs"), "--check"], {
		cwd: root,
		encoding: "utf8",
	});
	assert.match(output, /runtime-t3 matches lib/);
});
