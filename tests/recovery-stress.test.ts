import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore } from "../src/artifact-store.ts";
import { handleSlipstreamCommand } from "../src/commands.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { createRuntimeState } from "../src/session-state.ts";

const cwd = process.cwd();

function message(id: string, role: "user" | "assistant", content: string) {
	return {
		type: "message" as const,
		id,
		parentId: null,
		timestamp: "t",
		message: { role, content },
	};
}

async function makeRoot(): Promise<string> {
	const parent = join(cwd, ".scratch", "test-tmp");
	await mkdir(parent, { recursive: true });
	return mkdtemp(join(parent, "slipstream-recovery-stress-"));
}

async function writePendingText(root: string, dirName: string, value: string) {
	const dir = join(root, dirName);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "pending.json"), value);
}

function pending(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "s-stress",
		cwd,
		projectId: cwd,
		summary: "## Goal\nRecovered under fanout",
		firstKeptEntryId: "a1",
		validatedThroughEntryId: "a1",
		tokensBefore: 100,
		details: { judge: { score: 9 }, artifacts: [] },
		expiresAt: 1_900,
		...overrides,
	};
}

describe("pending recovery stress", () => {
	it("recovers one valid pending artifact through high malformed artifact fanout", async () => {
		const root = await makeRoot();
		try {
			const malformedWrites = Array.from(
				{ length: 1_000 },
				async (_, index) => {
					const value =
						index % 3 === 0
							? "{not json"
							: JSON.stringify(
									pending({
										summary: `## Goal\nMalformed ${index}`,
										details: index % 3 === 1 ? "bad" : { judge: { score: 1 } },
										expiresAt: index % 3 === 1 ? 1_500 : 900,
									}),
								);
					await writePendingText(root, `s-stress-noise-${index}`, value);
				},
			);
			await Promise.all(malformedWrites);
			const validRun = await new ArtifactStore({ root }).createRun({
				sessionId: "s-stress",
				triggerEntryId: "a1",
				cwd,
			});
			await writeFile(
				join(validRun.dir, "pending.json"),
				JSON.stringify(pending()),
			);
			await writePendingText(
				root,
				"unrelated-session-valid",
				JSON.stringify(pending({ sessionId: "unrelated" })),
			);

			const state = createRuntimeState({ now: 1_000 });
			let compactCalls = 0;
			const result = await handleSlipstreamCommand(
				"compact --adopt",
				state,
				{
					...DEFAULT_CONFIG,
					artifactRoot: root,
					pendingTtlMs: 1_000,
				},
				{
					cwd,
					compact: () => {
						compactCalls += 1;
					},
					sessionManager: {
						getSessionId: () => "s-stress",
						getBranch: () => [
							message("u1", "user", "old"),
							message("a1", "assistant", "head"),
						],
					},
				},
				{ now: () => 1_000 },
			);

			assert.equal(result.ok, true);
			assert.equal(compactCalls, 1);
			assert.equal(state.status, "summarizing");
			assert.equal(state.pending?.summary, "## Goal\nRecovered under fanout");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
