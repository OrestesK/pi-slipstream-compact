import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore, type ArtifactRun } from "../src/artifact-store.ts";
import {
	clearPendingArtifact,
	disposePendingArtifact,
	handleSlipstreamCommand,
	recoverPendingArtifact,
} from "../src/commands.ts";
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
	return mkdtemp(join(parent, "slipstream-recovery-"));
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function writePending(root: string, dirName: string, value: unknown) {
	const dir = join(root, dirName);
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, "pending.json"),
		`${JSON.stringify(value, null, 2)}\n`,
	);
	return dir;
}

async function createPendingRun(
	root: string,
	triggerEntryId: string,
	value: unknown = pending(),
): Promise<ArtifactRun> {
	const run = await new ArtifactStore({ root }).createRun({
		sessionId: "s-recover",
		triggerEntryId,
		cwd,
	});
	await writeFile(
		join(run.dir, "pending.json"),
		`${JSON.stringify(value, null, 2)}\n`,
	);
	return run;
}

function pending(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "s-recover",
		cwd,
		projectId: cwd,
		summary: "## Goal\nRecovered",
		firstKeptEntryId: "a1",
		validatedThroughEntryId: "a1",
		tokensBefore: 100,
		details: { judge: { score: 9 }, artifacts: [] },
		expiresAt: 1_500,
		...overrides,
	};
}

async function adopt(root: string) {
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
				getSessionId: () => "s-recover",
				getBranch: () => [
					message("u1", "user", "old"),
					message("a1", "assistant", "head"),
				],
			},
		},
		{ now: () => 1_000 },
	);
	return { result, state, compactCalls };
}

describe("pending artifact recovery", () => {
	it("recovers artifact directories that use sanitized session id prefixes", async () => {
		const root = await makeRoot();
		try {
			const sessionId = "session/with:bad";
			const run = await new ArtifactStore({ root }).createRun({
				sessionId,
				triggerEntryId: "a1",
				cwd,
			});
			await writeFile(
				join(run.dir, "pending.json"),
				JSON.stringify(pending({ sessionId })),
			);

			const recovered = await recoverPendingArtifact(
				root,
				sessionId,
				cwd,
				1_000,
				1_000,
				true,
			);

			assert.equal(recovered?.sessionId, sessionId);
			assert.equal(recovered?.summary, "## Goal\nRecovered");
			assert.equal(recovered?.artifactDir, run.dir);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("normalizes legacy pending artifacts with unknown token counts", async () => {
		const root = await makeRoot();
		try {
			const run = await createPendingRun(
				root,
				"null-tokens",
				pending({ tokensBefore: null }),
			);

			const recovered = await recoverPendingArtifact(
				root,
				"s-recover",
				cwd,
				1_000,
				1_000,
				true,
			);

			assert.equal(recovered?.tokensBefore, null);
			assert.equal(recovered?.firstKeptEntryId, "a1");
			assert.equal(recovered?.artifactDir, run.dir);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ignores recovered artifacts whose JSON sessionId does not match", async () => {
		const root = await makeRoot();
		try {
			const run = await createPendingRun(
				root,
				"wrong-json",
				pending({ sessionId: "other" }),
			);

			const { result, compactCalls } = await adopt(root);

			assert.equal(result.ok, false);
			assert.equal(compactCalls, 0);
			assert.match(result.message, /No unexpired validated Slipstream summary/);
			assert.equal(await pathExists(join(run.dir, "pending.json")), true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ignores recovered artifacts with malformed field shapes", async () => {
		const root = await makeRoot();
		try {
			await createPendingRun(
				root,
				"details-string",
				pending({ details: "bad" }),
			);
			await createPendingRun(
				root,
				"expires-string",
				pending({ expiresAt: "1500" }),
			);
			await createPendingRun(
				root,
				"head-number",
				pending({ validatedThroughEntryId: 12 }),
			);
			await createPendingRun(root, "summary-null", pending({ summary: null }));

			const { result, compactCalls } = await adopt(root);

			assert.equal(result.ok, false);
			assert.equal(compactCalls, 0);
			assert.match(result.message, /No unexpired validated Slipstream summary/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("ignores unverifiable runs without modifying them in either retention mode", async () => {
		for (const retainArtifacts of [false, true]) {
			const root = await makeRoot();
			try {
				const missingMetadataDir = await writePending(
					root,
					"s-recover-missing-metadata",
					pending({ summary: "## Goal\nMissing metadata" }),
				);
				const mismatchedRun = await createPendingRun(
					root,
					"mismatched-metadata",
					pending({ summary: "## Goal\nMismatched metadata" }),
				);
				await writeFile(
					join(mismatchedRun.dir, "run.json"),
					JSON.stringify({ sessionId: "other", cwd }),
				);
				const validRun = await createPendingRun(
					root,
					"valid",
					pending({ summary: "## Goal\nValid" }),
				);

				const recovered = await recoverPendingArtifact(
					root,
					"s-recover",
					cwd,
					1_000,
					1_000,
					retainArtifacts,
				);

				assert.equal(recovered?.artifactDir, validRun.dir);
				assert.equal(
					await pathExists(join(missingMetadataDir, "pending.json")),
					true,
				);
				assert.equal(
					await pathExists(join(mismatchedRun.dir, "pending.json")),
					true,
				);
			} finally {
				await rm(root, { recursive: true, force: true });
			}
		}
	});

	it("deletes expired and non-selected owned restart candidates in false mode", async () => {
		const root = await makeRoot();
		try {
			const oldRun = await createPendingRun(
				root,
				"old",
				pending({ summary: "## Goal\nOld", expiresAt: 1_100 }),
			);
			const expiredRun = await createPendingRun(
				root,
				"expired",
				pending({ summary: "## Goal\nExpired", expiresAt: 1_000 }),
			);
			const futureRun = await createPendingRun(
				root,
				"future",
				pending({ summary: "## Goal\nFuture", expiresAt: 2_001 }),
			);
			const newestRun = await createPendingRun(
				root,
				"newest",
				pending({ summary: "## Goal\nNewest", expiresAt: 1_900 }),
			);

			const { result, state, compactCalls } = await adopt(root);

			assert.equal(result.ok, true);
			assert.equal(compactCalls, 1);
			assert.equal(state.status, "summarizing");
			assert.equal(state.pending?.summary, "## Goal\nNewest");
			assert.equal(state.pending?.artifactDir, newestRun.dir);
			assert.equal(await pathExists(oldRun.dir), false);
			assert.equal(await pathExists(expiredRun.dir), false);
			assert.equal(await pathExists(futureRun.dir), false);
			assert.equal(await pathExists(newestRun.dir), true);
			assert.ok(state.pending);
			await disposePendingArtifact(state.pending, root, false);
			const resurrected = await recoverPendingArtifact(
				root,
				"s-recover",
				cwd,
				1_000,
				1_000,
				false,
			);
			assert.equal(resurrected, null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retained recovery clears stale markers while preserving run evidence", async () => {
		const root = await makeRoot();
		try {
			const expiredRun = await createPendingRun(
				root,
				"retained-expired",
				pending({ expiresAt: 1_000 }),
			);

			const recovered = await recoverPendingArtifact(
				root,
				"s-recover",
				cwd,
				1_000,
				1_000,
				true,
			);

			assert.equal(recovered, null);
			assert.equal(await pathExists(expiredRun.dir), true);
			assert.equal(
				await pathExists(join(expiredRun.dir, "pending.json")),
				false,
			);
			assert.equal(await pathExists(join(expiredRun.dir, "run.json")), true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retained recovery clears non-selected markers so they cannot resurrect", async () => {
		const root = await makeRoot();
		try {
			const oldRun = await createPendingRun(
				root,
				"retained-old",
				pending({ summary: "## Goal\nOld", expiresAt: 1_100 }),
			);
			const newestRun = await createPendingRun(
				root,
				"retained-newest",
				pending({ summary: "## Goal\nNewest", expiresAt: 1_900 }),
			);

			const recovered = await recoverPendingArtifact(
				root,
				"s-recover",
				cwd,
				1_000,
				1_000,
				true,
			);

			assert.equal(recovered?.artifactDir, newestRun.dir);
			assert.equal(await pathExists(oldRun.dir), true);
			assert.equal(await pathExists(join(oldRun.dir, "pending.json")), false);
			assert.equal(await pathExists(join(newestRun.dir, "pending.json")), true);
			assert.ok(recovered);
			await clearPendingArtifact(recovered, root);
			const resurrected = await recoverPendingArtifact(
				root,
				"s-recover",
				cwd,
				1_000,
				1_000,
				true,
			);
			assert.equal(resurrected, null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses a stable run-directory tie-breaker for equal expiries", async () => {
		const root = await makeRoot();
		try {
			const first = await createPendingRun(
				root,
				"tie-first",
				pending({ summary: "## Goal\nFirst", expiresAt: 1_500 }),
			);
			const second = await createPendingRun(
				root,
				"tie-second",
				pending({ summary: "## Goal\nSecond", expiresAt: 1_500 }),
			);
			const expected = [first.dir, second.dir].sort()[0];
			assert.ok(expected);

			const recovered = await recoverPendingArtifact(
				root,
				"s-recover",
				cwd,
				1_000,
				1_000,
				false,
			);

			assert.equal(recovered?.artifactDir, expected);
			assert.equal(await pathExists(expected), true);
			const retired = expected === first.dir ? second.dir : first.dir;
			assert.equal(await pathExists(retired), false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
