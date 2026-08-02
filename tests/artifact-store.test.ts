import assert from "node:assert/strict";
import {
	access,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore, createRunId } from "../src/artifact-store.ts";

const SAMPLE = {
	sessionId: "session/with:bad",
	triggerEntryId: "entry-1",
	cwd: "/repo",
};

class YieldCheckedJsonValue {
	private readonly value: string;
	private readonly hasYielded: () => boolean;

	constructor(value: string, hasYielded: () => boolean) {
		this.value = value;
		this.hasYielded = hasYielded;
	}

	toJSON(): string {
		assert.equal(this.hasYielded(), true);
		return this.value;
	}
}

describe("artifact store", () => {
	it("allocates distinct artifact directories for duplicate session/trigger runs", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-artifacts-"));
		try {
			const store = new ArtifactStore({
				root,
				maxChunkBytes: 20,
				maxTotalBytes: 1_000,
			});
			const firstRun = await store.createRun(SAMPLE);
			const secondRun = await store.createRun(SAMPLE);

			assert.equal(
				firstRun.id,
				createRunId(SAMPLE.sessionId, SAMPLE.triggerEntryId),
			);
			assert.equal(secondRun.id, firstRun.id);
			assert.notEqual(secondRun.dir, firstRun.dir);

			const [firstSnapshot, secondSnapshot] = await Promise.all([
				store.writeTriggerSnapshot(firstRun, {
					messages: ["first".repeat(10)],
					manifest: {},
				}),
				store.writeTriggerSnapshot(secondRun, {
					messages: ["second".repeat(10)],
					manifest: {},
				}),
			]);

			assert.notDeepEqual(firstSnapshot.chunkPaths, secondSnapshot.chunkPaths);
			for (const path of [
				...firstSnapshot.chunkPaths,
				...secondSnapshot.chunkPaths,
			]) {
				assert.equal((await readFile(path, "utf8")).length > 0, true);
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("writes sanitized, chunked artifacts and index records", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-artifacts-"));
		try {
			const store = new ArtifactStore({
				root,
				maxChunkBytes: 20,
				maxTotalBytes: 1_000,
			});
			const run = await store.createRun(SAMPLE);
			const snapshot = await store.writeTriggerSnapshot(run, {
				messages: ["x".repeat(55)],
				manifest: { filesModified: ["a.ts"] },
			});
			const candidate = await store.writeCandidate(run, "summary");
			const continuation = await store.writeContinuation(run, { turns: [1] });
			const gitSnapshot = await store.writeGitSnapshot(run, {
				statusShort: " M src/a.ts\n",
				diffStat: "src/a.ts | 2 +-\n",
				fullDiff: `diff --git a/src/a.ts b/src/a.ts\n${"+x\n".repeat(30)}`,
			});
			const promptMetrics = await store.writePromptMetrics(run, {
				kind: "summary-prompt",
				chars: 123,
			});
			await store.writePromptMetrics(run, {
				kind: "judge-prompt",
				chars: 456,
			});
			const judge = await store.writeJudgeResult(run, {
				score: 8,
				decision: "accept",
			});
			const adoption = await store.writeAdoptionRecord(run, {
				firstKeptEntryId: "entry-2",
			});

			assert.equal(
				run.id,
				createRunId(SAMPLE.sessionId, SAMPLE.triggerEntryId),
			);
			assert.match(run.dir, /session-with-bad/);
			assert.equal(snapshot.chunkPaths.length >= 3, true);
			const snapshotMetadata = await readFile(snapshot.path, "utf8");
			assert.equal(snapshotMetadata.includes("x".repeat(55)), false);
			assert.equal(candidate.path.endsWith("candidate-summary.md"), true);
			assert.equal(continuation.path.endsWith("continuation.json"), true);
			assert.equal(gitSnapshot.fullDiffPreserved, true);
			assert.equal(gitSnapshot.diffChunkPaths.length >= 4, true);
			assert.match(
				await readFile(gitSnapshot.statusPath, "utf8"),
				/src\/a\.ts/,
			);
			assert.match(
				await readFile(gitSnapshot.diffChunkPaths[0] ?? "", "utf8"),
				/diff --git/,
			);
			assert.equal(promptMetrics.path.endsWith("prompt-metrics.json"), true);
			const promptMetricsJson = JSON.parse(
				await readFile(promptMetrics.path, "utf8"),
			) as { records: Array<{ kind: string; chars: number }> };
			assert.deepEqual(
				promptMetricsJson.records.map((record) => record.kind),
				["summary-prompt", "judge-prompt"],
			);
			assert.equal(promptMetricsJson.records[1]?.chars, 456);
			assert.equal(judge.path.endsWith("judge.json"), true);
			assert.equal(adoption.path.endsWith("adoption.json"), true);

			const index = JSON.parse(
				await readFile(join(run.dir, "index.json"), "utf8"),
			) as { records: Array<{ kind: string }> };
			assert.deepEqual(
				index.records.map((r) => r.kind),
				[
					"trigger-snapshot",
					"candidate",
					"continuation",
					"git-snapshot",
					"prompt-metrics",
					"prompt-metrics",
					"judge",
					"adoption",
				],
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("marks incomplete git snapshots as not fully preserved", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-artifacts-"));
		try {
			const store = new ArtifactStore({ root });
			const run = await store.createRun(SAMPLE);
			const gitSnapshot = await store.writeGitSnapshot(run, {
				statusShort: " M src/a.ts\n",
				diffStat: "src/a.ts | 2 +-\n",
				fullDiff: "partial diff",
				fullDiffComplete: false,
			});

			assert.equal(gitSnapshot.fullDiffComplete, false);
			assert.equal(gitSnapshot.fullDiffPreserved, false);
			assert.match(
				await readFile(gitSnapshot.diffChunkPaths[0] ?? "", "utf8"),
				/incomplete/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("yields before serializing trigger message values", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-artifacts-"));
		try {
			const store = new ArtifactStore({
				root,
				maxChunkBytes: 20,
				maxTotalBytes: 1_000,
			});
			const run = await store.createRun(SAMPLE);
			let yielded = false;
			setImmediate(() => {
				yielded = true;
			});

			const snapshot = await store.writeTriggerSnapshot(run, {
				messages: [new YieldCheckedJsonValue("after-yield", () => yielded)],
				manifest: { filesModified: ["a.ts"] },
			});
			const raw = (
				await Promise.all(
					snapshot.chunkPaths.map((path) => readFile(path, "utf8")),
				)
			).join("");
			const parsed = JSON.parse(raw) as {
				messages: string[];
				manifest: { filesModified: string[] };
			};
			assert.deepEqual(parsed.messages, ["after-yield"]);
			assert.deepEqual(parsed.manifest.filesModified, ["a.ts"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps multibyte trigger chunks within the byte cap", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-artifacts-"));
		try {
			const store = new ArtifactStore({
				root,
				maxChunkBytes: 13,
				maxTotalBytes: 1_000,
			});
			const run = await store.createRun(SAMPLE);
			const snapshot = await store.writeTriggerSnapshot(run, {
				messages: ["🙂🙂🙂🙂🙂"],
				manifest: { emoji: "🙂" },
			});
			for (const path of snapshot.chunkPaths) {
				const chunk = await readFile(path);
				assert.equal(chunk.byteLength <= 13, true);
			}
			const raw = (
				await Promise.all(
					snapshot.chunkPaths.map((path) => readFile(path, "utf8")),
				)
			).join("");
			const parsed = JSON.parse(raw) as {
				messages: string[];
				manifest: { emoji: string };
			};
			assert.deepEqual(parsed.messages, ["🙂🙂🙂🙂🙂"]);
			assert.equal(parsed.manifest.emoji, "🙂");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("aborts trigger snapshot writing before final raw chunks", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-artifacts-"));
		try {
			const store = new ArtifactStore({
				root,
				maxChunkBytes: 20,
				maxTotalBytes: 1_000,
			});
			const run = await store.createRun(SAMPLE);
			const controller = new AbortController();
			controller.abort(new Error("cancelled trigger write"));
			await assert.rejects(
				() =>
					store.writeTriggerSnapshot(
						run,
						{ messages: ["x"], manifest: {} },
						{ signal: controller.signal },
					),
				/cancelled trigger write/,
			);
			const runFiles = await readdir(run.dir);
			assert.deepEqual(
				runFiles.filter((file) => file.startsWith("trigger-raw-")),
				[],
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("aborts trigger snapshot before publishing metadata and index", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-artifacts-"));
		try {
			const store = new ArtifactStore({
				root,
				maxChunkBytes: 20,
				maxTotalBytes: 1_000,
			});
			const run = await store.createRun(SAMPLE);
			const controller = new AbortController();
			await assert.rejects(
				() =>
					store.writeTriggerSnapshot(
						run,
						{
							messages: [
								{
									toJSON: () => {
										setImmediate(() =>
											controller.abort(new Error("cancelled after chunks")),
										);
										return "x".repeat(30);
									},
								},
							],
							manifest: {},
						},
						{ signal: controller.signal },
					),
				/cancelled after chunks/,
			);
			const runFiles = await readdir(run.dir);
			assert.equal(runFiles.includes("trigger-snapshot.json"), false);
			assert.equal(runFiles.includes("index.json"), false);
			assert.deepEqual(
				runFiles.filter((file) => file.startsWith("trigger-raw-")),
				[],
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("enforces byte caps before writing final raw chunks", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-artifacts-"));
		try {
			const store = new ArtifactStore({
				root,
				maxChunkBytes: 20,
				maxTotalBytes: 10,
			});
			const run = await store.createRun(SAMPLE);
			await assert.rejects(
				() =>
					store.writeTriggerSnapshot(run, {
						messages: ["é".repeat(20)],
						manifest: {},
					}),
				/maxTotalBytes/,
			);
			const runFiles = await readdir(run.dir);
			assert.deepEqual(
				runFiles.filter((file) => file.startsWith("trigger-raw-")),
				[],
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("removes only a verified direct-child run", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-remove-"));
		try {
			const store = new ArtifactStore({ root });
			const run = await store.createRun(SAMPLE);
			await Promise.all([
				store.removeRun(run.dir, SAMPLE),
				store.removeRun(run.dir, SAMPLE),
			]);
			await assert.rejects(() => access(run.dir));

			const tampered = await store.createRun(SAMPLE);
			await writeFile(join(tampered.dir, "run.json"), "{}\n");
			await assert.rejects(
				() => store.removeRun(tampered.dir, SAMPLE),
				/metadata does not match/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps full central stats paths only when explicitly configured", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-artifacts-"));
		const statsRoot = await mkdtemp(join(parent, "slipstream-stats-"));
		const previousStatsRoot = process.env.PI_SLIPSTREAM_STATS_ROOT;
		try {
			process.env.PI_SLIPSTREAM_STATS_ROOT = statsRoot;
			const store = new ArtifactStore({ root, statsFullPaths: true });
			const run = await store.createRun(SAMPLE);
			await store.writeStats(run, {
				schemaVersion: 1,
				mode: "compact",
				outcome: "accepted",
				accepted: true,
				repaired: false,
				startedAt: "2026-01-01T00:00:00.000Z",
				completedAt: "2026-01-01T00:00:01.000Z",
				sessionId: SAMPLE.sessionId,
				cwd: SAMPLE.cwd,
				artifactDir: run.dir,
				tokensBefore: null,
				judgeScore: 8,
				judgeDecision: "accept",
				timingsMs: { total: 1 },
			});

			const stats = JSON.parse(
				await readFile(
					join(statsRoot, "sessions", "session-with-bad.jsonl"),
					"utf8",
				),
			) as { cwd: string; artifactDir: string; tokensBefore: number | null };
			assert.equal(stats.cwd, SAMPLE.cwd);
			assert.equal(stats.artifactDir, run.dir);
			assert.equal(stats.tokensBefore, null);
		} finally {
			if (previousStatsRoot === undefined)
				delete process.env.PI_SLIPSTREAM_STATS_ROOT;
			else process.env.PI_SLIPSTREAM_STATS_ROOT = previousStatsRoot;
			await rm(root, { recursive: true, force: true });
			await rm(statsRoot, { recursive: true, force: true });
		}
	});
});
