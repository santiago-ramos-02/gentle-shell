import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cachedProviderLimits, pickProviderLimits, providerLimitsFile, readProviderLimits, recordProviderLimits } from "../lib/provider-limits.ts";

function scratch(t: { after(fn: () => void): void }): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-provider-limits-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return providerLimitsFile(dir);
}

test("pickProviderLimits keeps only a response's subscription rate-limit headers", () => {
	assert.deepEqual(pickProviderLimits({
		"Anthropic-Ratelimit-Unified-5h-Utilization": "0.42",
		"anthropic-ratelimit-unified-5h-reset": "1767225600",
		"anthropic-ratelimit-unified-7d-utilization": "0.9",
		"authorization": "Bearer secret",
		"request-id": "req_1",
	}, 1000), {
		provider: "anthropic",
		checkedAt: 1000,
		headers: {
			"anthropic-ratelimit-unified-5h-utilization": "0.42",
			"anthropic-ratelimit-unified-5h-reset": "1767225600",
			"anthropic-ratelimit-unified-7d-utilization": "0.9",
		},
	});
	assert.deepEqual(pickProviderLimits({
		"x-codex-primary-used-percent": "12",
		"x-codex-primary-window-minutes": "300",
		"x-codex-secondary-reset-at": "1767225600",
		"x-codex-turn-state": "opaque",
		"x-codex-bengalfox-primary-used-percent": "80",
	}, 2000), {
		provider: "codex",
		checkedAt: 2000,
		headers: {
			"x-codex-primary-used-percent": "12",
			"x-codex-primary-window-minutes": "300",
			"x-codex-secondary-reset-at": "1767225600",
		},
	});
	assert.equal(pickProviderLimits({ "content-type": "text/event-stream", "x-ratelimit-remaining-requests": "10" }, 3000), null, "API-key rate limits are not subscription limits");
});

test("recordProviderLimits keeps each provider's latest headers and never goes back in time", (t) => {
	const file = scratch(t);
	const anthropic = (checkedAt: number, used: string) => ({ provider: "anthropic" as const, checkedAt, headers: { "anthropic-ratelimit-unified-5h-utilization": used } });
	const codex = { provider: "codex" as const, checkedAt: 150, headers: { "x-codex-primary-used-percent": "5" } };

	recordProviderLimits(file, anthropic(100, "0.1"));
	recordProviderLimits(file, codex);
	recordProviderLimits(file, anthropic(200, "0.2"));
	// A subagent's slower response must not overwrite a newer one from the parent.
	recordProviderLimits(file, anthropic(120, "0.15"));

	assert.deepEqual(readProviderLimits(file), [codex, anthropic(200, "0.2")]);
});

test("readProviderLimits treats a missing or corrupt file as no limits", (t) => {
	const file = scratch(t);
	assert.deepEqual(readProviderLimits(file), []);
	writeFileSync(file, "{not json");
	assert.deepEqual(readProviderLimits(file), []);
	writeFileSync(file, JSON.stringify([{ provider: "openai", checkedAt: 1, headers: {} }, { provider: "codex", checkedAt: "1", headers: {} }]));
	assert.deepEqual(readProviderLimits(file), []);
});

test("cachedProviderLimits sees another process's write", (t) => {
	const file = scratch(t);
	const read = cachedProviderLimits(file);
	assert.deepEqual(read(), []);
	const limits = { provider: "codex" as const, checkedAt: 1, headers: { "x-codex-primary-used-percent": "40" } };
	recordProviderLimits(file, limits);
	assert.deepEqual(read(), [limits]);
});
