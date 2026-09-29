#!/usr/bin/env node
// Process glue for the gentle-pi API (lib/gentle-pi-api.ts, built to
// runtime-t3/gentle-pi-api.mjs): `gentle-pi-api <method>` reads the parameters as
// JSON on stdin and writes newline-delimited JSON ending in one result or error
// line, the same framing as `gentle-ai api`.
import { runGentlePiApi } from "../runtime-t3/gentle-pi-api.mjs";

const SCHEMA = "gentle-pi.api/v1";

async function readStdin() {
	if (process.stdin.isTTY) return "";
	let text = "";
	for await (const chunk of process.stdin) text += chunk;
	return text;
}

function write(line) {
	process.stdout.write(`${JSON.stringify({ schema: SCHEMA, ...line })}\n`);
}

const method = process.argv[2] ?? "";
let params = {};
const body = (await readStdin()).trim();
if (body !== "") {
	try {
		params = JSON.parse(body);
	} catch {
		write({ type: "error", error: { code: "invalid_params", message: "Parameters must be JSON." } });
		process.exit(1);
	}
}
const line = await runGentlePiApi(method, params);
write(line);
process.exitCode = line.type === "result" ? 0 : 1;
