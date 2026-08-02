import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	runSlipstreamDryRun,
	runValidatedSlipstream,
} from "../src/pipeline.ts";
import type { SessionEntry } from "../src/types.ts";

const CODEX_SUMMARY_PREFIX =
	"Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

function centralStatsPath(root: string, sessionId: string): string {
	return join(root, "sessions", `${sessionId}.jsonl`);
}

function user(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-05-26T00:00:00.000Z",
		message: { role: "user", content },
	};
}

function assistant(id: string, content: string): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-05-26T00:00:00.000Z",
		message: { role: "assistant", content },
	};
}

async function makeRoot(): Promise<string> {
	const parent = join(process.cwd(), ".scratch", "test-tmp");
	await mkdir(parent, { recursive: true });
	return mkdtemp(join(parent, "slipstream-pipeline-"));
}

describe("pipeline", () => {
	it("dry-run writes artifacts without mutating compaction state", async () => {
		const root = await makeRoot();
		try {
			const result = await runSlipstreamDryRun({
				retainArtifacts: true,
				branchEntries: [user("u1", "Goal: build package")],
				sessionId: "s1",
				cwd: "/repo",
				artifactRoot: root,
			});
			assert.equal(result.accepted, false);
			assert.equal(result.mode, "dry-run");
			assert.ok(result.artifactDir.startsWith(root));
			assert.match(result.candidatePrompt, /Goal/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("omits temporary artifact paths from a non-retained prompt", async () => {
		const root = await makeRoot();
		try {
			const result = await runSlipstreamDryRun({
				retainArtifacts: false,
				branchEntries: [user("u1", "Goal: build package")],
				sessionId: "s-no-retained-prompt-paths",
				cwd: "/repo",
				artifactRoot: root,
				executeGit: async (args) => {
					if (args.includes("status"))
						return { stdout: " M src/b.ts\n", stderr: "" };
					if (args.includes("--stat"))
						return { stdout: " src/b.ts | 1 +\n", stderr: "" };
					return {
						stdout: "diff --git a/src/b.ts b/src/b.ts\n+change\n",
						stderr: "",
					};
				},
			});

			assert.equal(result.candidatePrompt.includes(root), false);
			assert.equal(
				result.candidatePrompt.includes("state-evidence.json"),
				false,
			);
			assert.match(
				result.candidatePrompt,
				/Full git diff artifact paths:\n- None/,
			);
			assert.match(result.candidatePrompt, /Full git diff preserved: false/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("yields after snapshot progress before reading branch content", async () => {
		const root = await makeRoot();
		let yielded = false;
		try {
			const result = await runSlipstreamDryRun({
				retainArtifacts: true,
				branchEntries: [
					{
						type: "message",
						id: "u-yield",
						parentId: null,
						timestamp: "2026-05-26T00:00:00.000Z",
						message: {
							role: "user",
							get content() {
								assert.equal(yielded, true);
								return "Goal: visible progress before snapshot work";
							},
						},
					},
				],
				sessionId: "s-yield",
				cwd: "/repo",
				artifactRoot: root,
				executeGit: async () => ({ stdout: "", stderr: "" }),
				onProgress: (event) => {
					if (event.phase === "snapshot")
						queueMicrotask(() => {
							yielded = true;
						});
				},
			});
			assert.match(result.candidatePrompt, /visible progress/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("yields after prompt progress before validated model calls", async () => {
		const root = await makeRoot();
		const yielded = {
			summary: false,
			regeneration: false,
			judging: 0,
			repairing: false,
		};
		let summaryCalls = 0;
		let judgeCalls = 0;
		try {
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "Goal: validate prompt yields"),
					assistant("a1", "Ready"),
				],
				sessionId: "s-prompt-yield",
				cwd: "/repo",
				artifactRoot: root,
				executeGit: async () => ({ stdout: "", stderr: "" }),
				continuation: {
					triggerEntryId: "a1",
					turns: [{ turnIndex: 1, assistantText: "Ready", toolResults: [] }],
				},
				repairAttempts: 1,
				onProgress: (event) => {
					if (event.phase === "summary") {
						if (event.message.includes("regenerating")) {
							queueMicrotask(() => {
								yielded.regeneration = true;
							});
						} else {
							queueMicrotask(() => {
								yielded.summary = true;
							});
						}
					}
					if (event.phase === "judging")
						queueMicrotask(() => {
							yielded.judging += 1;
						});
					if (event.phase === "repairing")
						queueMicrotask(() => {
							yielded.repairing = true;
						});
				},
				completeSummary: async () => {
					summaryCalls += 1;
					if (summaryCalls === 1) {
						assert.equal(yielded.summary, true);
						return "";
					}
					if (summaryCalls === 2) {
						assert.equal(yielded.regeneration, true);
						return "## Goal\nCandidate after regeneration";
					}
					assert.equal(yielded.repairing, true);
					return "## Goal\nRepaired candidate";
				},
				completeJudge: async () => {
					judgeCalls += 1;
					assert.equal(yielded.judging, judgeCalls);
					if (judgeCalls === 1)
						return {
							score: 4,
							decision: "reject",
							missing: ["repair needed"],
							contradictions: [],
							diagnosis: "needs repair",
						};
					return {
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "ok",
					};
				},
			});

			assert.equal(result.accepted, true);
			assert.equal(summaryCalls, 3);
			assert.equal(judgeCalls, 2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("dry-run stores full git diff artifacts outside the model prompt", async () => {
		const root = await makeRoot();
		try {
			const fullDiff = `diff --git a/src/b.ts b/src/b.ts\n+FULL_DIFF_ARTIFACT_SENTINEL\n`;
			const result = await runSlipstreamDryRun({
				retainArtifacts: true,
				branchEntries: [user("u1", "Goal: build package")],
				sessionId: "s-git-artifact",
				cwd: "/repo",
				artifactRoot: root,
				executeGit: async (args) => {
					if (args.includes("status"))
						return { stdout: " M src/b.ts\n", stderr: "" };
					if (args.includes("--stat"))
						return { stdout: " src/b.ts | 1 +\n", stderr: "" };
					return { stdout: fullDiff, stderr: "" };
				},
			});

			const index = JSON.parse(
				await readFile(`${result.artifactDir}/index.json`, "utf8"),
			) as { records: Array<{ kind: string; path?: string }> };
			const gitSnapshot = index.records.find(
				(record) => record.kind === "git-snapshot",
			);
			assert.ok(gitSnapshot?.path);
			const metadata = JSON.parse(await readFile(gitSnapshot.path, "utf8")) as {
				diffChunkPaths: string[];
				diffSha256: string;
				fullDiffPreserved: boolean;
			};
			assert.equal(metadata.fullDiffPreserved, true);
			assert.equal(metadata.diffSha256.length, 64);
			assert.match(
				await readFile(metadata.diffChunkPaths[0] ?? "", "utf8"),
				/FULL_DIFF_ARTIFACT_SENTINEL/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("passes latest compacted updates and artifact references through validation prompts", async () => {
		const root = await makeRoot();
		const previousStatsRoot = process.env.PI_SLIPSTREAM_STATS_ROOT;
		try {
			const statsRoot = join(root, "central-stats");
			process.env.PI_SLIPSTREAM_STATS_ROOT = statsRoot;
			const entries: SessionEntry[] = [
				user("u1", "start"),
				assistant("a1", "setup complete"),
				user("u2", "continue"),
				assistant(
					"a2",
					"Final compacted recommendation: reserve gpt-5.5 for manual checkpoints.",
				),
				user("u3", "kept 1"),
				assistant("a3", "kept 2"),
				user("u4", "kept 3"),
				assistant("a4", "kept 4"),
				user("u5", "kept 5"),
				assistant("a5", "kept 6"),
				user("u6", "kept 7"),
				assistant("a6", "kept 8"),
			];
			let summaryPrompt = "";
			let judgePrompt = "";
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: entries,
				sessionId: "s-latest",
				cwd: "/repo",
				artifactRoot: root,
				continuation: { triggerEntryId: "a6", turns: [] },
				completeSummary: async (prompt) => {
					summaryPrompt = prompt;
					return "Continuation card:\n- Current task: Continue\n\n## Goal\nContinue\n\n## Latest compacted updates\n- reserve gpt-5.5 for manual checkpoints";
				},
				completeJudge: async (prompt) => {
					judgePrompt = prompt;
					return {
						score: 8,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "ok",
					};
				},
			});

			assert.equal(result.accepted, true);
			assert.match(result.summary, /^Continuation card:/);
			assert.match(result.summary, /## Goal\nContinue/);
			assert.match(result.summary, /## Deterministic Evidence Capsule/);
			assert.match(result.summary, /Latest user request/);
			assert.match(result.summary, /reserve gpt-5\.5 for manual checkpoints/);
			assert.match(summaryPrompt, /Latest compacted updates/);
			assert.match(summaryPrompt, /reserve gpt-5\.5 for manual checkpoints/);
			assert.match(judgePrompt, /Protected latest compacted updates/);
			assert.match(judgePrompt, /reserve gpt-5\.5 for manual checkpoints/);
			assert.match(judgePrompt, /Protected artifact references/);
			assert.match(
				judgePrompt,
				new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
			await assert.rejects(() =>
				access(join(result.artifactDir, "stats.json")),
			);
			const statsLines = (
				await readFile(centralStatsPath(statsRoot, "s-latest"), "utf8")
			)
				.trim()
				.split("\n");
			assert.equal(statsLines.length, 1);
			const stats = JSON.parse(statsLines[0] ?? "") as {
				mode: string;
				outcome: string;
				accepted: boolean;
				judgeScore: number;
				artifactDir: string;
				timingsMs: { total: number; snapshot: number };
			};
			assert.equal(stats.mode, "compact");
			assert.equal(stats.outcome, "accepted");
			assert.equal(stats.accepted, true);
			assert.equal(stats.judgeScore, 8);
			assert.equal(stats.artifactDir.startsWith("/"), false);
			assert.notEqual(stats.artifactDir, result.artifactDir);
			assert.equal(stats.timingsMs.total >= 0, true);
			assert.equal(stats.timingsMs.snapshot >= 0, true);
		} finally {
			if (previousStatsRoot === undefined) {
				delete process.env.PI_SLIPSTREAM_STATS_ROOT;
			} else {
				process.env.PI_SLIPSTREAM_STATS_ROOT = previousStatsRoot;
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves unknown token counts as null instead of fabricating zero", async () => {
		const root = await makeRoot();
		try {
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "old"),
					assistant("a1", "old answer"),
					user("u2", "new"),
					assistant("a2", "new answer"),
				],
				sessionId: "s-null-tokens",
				cwd: process.cwd(),
				artifactRoot: root,
				firstKeptEntryId: "a1",
				tokensBefore: null,
				keepRecentTokens: 1,
				judgeThreshold: 7,
				repairAttempts: 0,
				continuation: {
					triggerEntryId: "a2",
					turns: [
						{
							turnIndex: 1,
							assistantText: "new answer",
							toolResults: [],
						},
					],
				},
				completeSummary: async () => "## Goal\nKeep null token counts",
				completeJudge: async () => ({
					score: 8,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
			});

			assert.equal(result.accepted, true);
			assert.equal(result.tokensBefore, null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("validated compaction forwards keepRecentTokens into snapshot boundary selection", async () => {
		const root = await makeRoot();
		try {
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "old work 1"),
					assistant("a1", "old answer 1"),
					user("u2", "old work 2"),
					assistant("a2", "old answer 2"),
					user("u3", "old work 3"),
					assistant("a3", "old answer 3"),
					user("u4", "old work 4"),
					assistant("a4", "old answer 4"),
					user("u5", "latest request"),
					assistant("a5", "latest answer"),
				],
				sessionId: "s-keep-recent-tokens",
				cwd: "/repo",
				artifactRoot: root,
				keepRecentTokens: 1,
				continuation: { triggerEntryId: "a5", turns: [] },
				executeGit: async () => ({ stdout: "", stderr: "" }),
				completeSummary: async () =>
					"## Goal\nContinue from the latest answer.",
				completeJudge: async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
			});

			assert.equal(result.accepted, true);
			assert.equal(result.firstKeptEntryId, "a5");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not fail validated compaction when central stats cannot be written", async () => {
		const root = await makeRoot();
		const previousStatsRoot = process.env.PI_SLIPSTREAM_STATS_ROOT;
		try {
			process.env.PI_SLIPSTREAM_STATS_ROOT = "/dev/null";
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "Use Slipstream and keep telemetry optional."),
					assistant("a1", "implementation done"),
				],
				sessionId: "s-stats-failure",
				cwd: "/repo",
				artifactRoot: root,
				continuation: { triggerEntryId: "a1", turns: [] },
				completeSummary: async () => "## Goal\nContinue safely.",
				completeJudge: async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
			});

			assert.equal(result.accepted, true);
			await assert.rejects(() =>
				access(join(result.artifactDir, "stats.json")),
			);
		} finally {
			if (previousStatsRoot === undefined) {
				delete process.env.PI_SLIPSTREAM_STATS_ROOT;
			} else {
				process.env.PI_SLIPSTREAM_STATS_ROOT = previousStatsRoot;
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	it("regenerates an empty candidate before judging or repairing", async () => {
		const root = await makeRoot();
		try {
			let summaryCalls = 0;
			let judgeCalls = 0;
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "Use Slipstream and keep CONFIG_PATH_SENTINEL."),
					assistant("a1", "implementation done"),
				],
				sessionId: "s-empty-regenerate",
				cwd: "/repo",
				artifactRoot: root,
				continuation: { triggerEntryId: "a1", turns: [] },
				completeSummary: async () => {
					summaryCalls += 1;
					return summaryCalls === 1
						? ""
						: "Continuation card:\n- Current task: Continue Slipstream work\n\n## Goal\nContinue Slipstream work.\n\n## Critical Context\nCONFIG_PATH_SENTINEL is preserved.";
				},
				completeJudge: async (prompt) => {
					judgeCalls += 1;
					assert.match(prompt, /CONFIG_PATH_SENTINEL/);
					assert.doesNotMatch(prompt, /<summary>\s*<\/summary>/);
					return {
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "regenerated candidate is substantive",
					};
				},
			});

			assert.equal(result.accepted, true);
			assert.equal(result.repaired, false);
			assert.equal(summaryCalls, 2);
			assert.equal(judgeCalls, 1);
			assert.match(result.summary, /CONFIG_PATH_SENTINEL/);
			assert.equal(result.summary.split(CODEX_SUMMARY_PREFIX).length - 1, 1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects when candidate generation is empty twice", async () => {
		const root = await makeRoot();
		try {
			let summaryCalls = 0;
			let judgeCalls = 0;
			const progress: string[] = [];
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "Use Slipstream and keep EMPTY_TWICE_SENTINEL."),
					assistant("a1", "implementation done"),
				],
				sessionId: "s-empty-twice",
				cwd: "/repo",
				artifactRoot: root,
				continuation: { triggerEntryId: "a1", turns: [] },
				completeSummary: async () => {
					summaryCalls += 1;
					return summaryCalls === 1 ? "" : "## Goal";
				},
				completeJudge: async () => {
					judgeCalls += 1;
					throw new Error("empty candidates should not be judged");
				},
				onProgress: (event) => progress.push(event.message),
			});

			assert.equal(result.accepted, false);
			assert.equal(result.firstKeptEntryId, null);
			assert.equal(result.judge.score, 0);
			assert.equal(result.repaired, false);
			assert.equal(summaryCalls, 2);
			assert.equal(judgeCalls, 0);
			assert.match(
				result.judge.diagnosis,
				/empty or heading-only summary twice/,
			);
			assert.match(progress.join("\n"), /regenerating once/i);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retries parse-error judge once and does not repair the summary first", async () => {
		const root = await makeRoot();
		try {
			let summaryCalls = 0;
			let judgeCalls = 0;
			const judgePromptLengths: number[] = [];
			const progress: string[] = [];
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "Use Slipstream and keep PARSE_ERROR_SENTINEL."),
					assistant("a1", "implementation done"),
				],
				sessionId: "s-parse-error-retry",
				cwd: "/repo",
				artifactRoot: root,
				continuation: {
					triggerEntryId: "a1",
					turns: [
						{
							turnIndex: 1,
							assistantText: "implementation done",
							toolResults: [
								{
									toolName: "retool",
									isError: false,
									text: "X".repeat(120_000),
								},
							],
						},
					],
				},
				repairAttempts: 3,
				onProgress: (event) =>
					progress.push(`${event.phase}: ${event.message}`),
				completeSummary: async (prompt) => {
					summaryCalls += 1;
					assert.doesNotMatch(prompt, /Rewrite the full summary/);
					return "## Goal\nContinue safely with PARSE_ERROR_SENTINEL.";
				},
				completeJudge: async (prompt) => {
					judgeCalls += 1;
					judgePromptLengths.push(prompt.length);
					assert.equal(prompt.length < 650_000, true);
					assert.match(prompt, /PARSE_ERROR_SENTINEL/);
					return {
						rawText: `not json attempt ${judgeCalls}`,
						result: {
							score: 0,
							decision: "reject",
							judgeStatus: "parse_error",
							missing: [],
							contradictions: [],
							diagnosis: "Could not parse judge response",
						},
					};
				},
			});

			assert.equal(result.accepted, false);
			assert.equal(result.repaired, false);
			assert.equal(summaryCalls, 1);
			assert.equal(judgeCalls, 2);
			assert.equal(judgePromptLengths.length, 2);
			const initialJudgePromptLength = judgePromptLengths[0];
			const retryJudgePromptLength = judgePromptLengths[1];
			if (
				initialJudgePromptLength === undefined ||
				retryJudgePromptLength === undefined
			) {
				throw new Error("expected initial and retry judge prompt lengths");
			}
			assert.equal(retryJudgePromptLength < initialJudgePromptLength, true);
			assert.match(progress.join("\n"), /Retrying judge after parse_error/);
			assert.doesNotMatch(progress.join("\n"), /Repair attempt/);
			const index = JSON.parse(
				await readFile(`${result.artifactDir}/index.json`, "utf8"),
			) as { records: Array<{ kind: string; path?: string }> };
			const rawJudgeRecords = index.records.filter(
				(record) => record.kind === "judge-raw-response",
			);
			assert.equal(rawJudgeRecords.length, 2);
			const rawJudge = JSON.parse(
				await readFile(rawJudgeRecords[0]?.path ?? "", "utf8"),
			) as { rawText: string; rawChars: number; sha256: string };
			assert.match(rawJudge.rawText, /not json attempt 1/);
			assert.equal(rawJudge.rawChars, "not json attempt 1".length);
			assert.match(rawJudge.sha256, /^[a-f0-9]{64}$/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("repairs before adoption when candidate omits a protected latest update", async () => {
		const root = await makeRoot();
		try {
			let judgeCalls = 0;
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "start"),
					assistant(
						"a1",
						"Final compacted recommendation: reserve gpt-5.5 for manual checkpoints.",
					),
					user("u2", "kept 1"),
					assistant("a2", "kept 2"),
					user("u3", "kept 3"),
					assistant("a3", "kept 4"),
					user("u4", "kept 5"),
					assistant("a4", "kept 6"),
					user("u5", "kept 7"),
					assistant("a5", "kept 8"),
				],
				sessionId: "s-repair-latest",
				cwd: "/repo",
				artifactRoot: root,
				continuation: { triggerEntryId: "a5", turns: [] },
				completeSummary: async (prompt) =>
					prompt.includes("Rewrite the full summary")
						? "Continuation card:\n- Current task: Continue\n\n## Goal\nContinue\n\n## Verification / Evidence\n- reserve gpt-5.5 for manual checkpoints"
						: "Continuation card:\n- Current task: Continue\n\n## Goal\nContinue",
				completeJudge: async (prompt) => {
					judgeCalls += 1;
					const summary =
						prompt.match(/<summary>\n([\s\S]*?)\n<\/summary>/)?.[1] ?? "";
					return summary.includes("reserve gpt-5.5 for manual checkpoints")
						? {
								score: 8,
								decision: "accept",
								missing: [],
								contradictions: [],
								diagnosis: "latest update preserved after repair",
							}
						: {
								score: 4,
								decision: "reject",
								missing: [
									"Missing latest compacted update: reserve gpt-5.5 for manual checkpoints",
								],
								contradictions: [],
								diagnosis:
									"artifact references are pointers only and do not mitigate the missing protected update",
							};
				},
			});

			assert.equal(result.accepted, true);
			assert.equal(result.repaired, true);
			assert.equal(judgeCalls, 2);
			assert.doesNotMatch(result.summary, /## Slipstream Repair Addendum/);
			assert.match(result.summary, /reserve gpt-5\.5 for manual checkpoints/);
			assert.equal(result.summary.split(CODEX_SUMMARY_PREFIX).length - 1, 1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("strict judge repairs safe but low-quality candidates", async () => {
		const root = await makeRoot();
		try {
			let judgeCalls = 0;
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "Continue the benchmark analysis."),
					assistant("a1", "Current answer: compare quality repair outcomes."),
				],
				sessionId: "s-quality-repair",
				cwd: "/repo",
				artifactRoot: root,
				continuation: { triggerEntryId: "a1", turns: [] },
				judgeThreshold: 7,
				repairAttempts: 2,
				completeSummary: async (prompt) =>
					prompt.includes("Rewrite the full summary")
						? "## Goal\nCompare quality repair outcomes.\n\n## Verification / Evidence\n- QUALITY_REPAIR_DETAIL preserved."
						: "## Goal\nCompare quality repair outcomes.",
				completeJudge: async (prompt) => {
					judgeCalls += 1;
					assert.match(prompt, /continuation-quality reviewer/);
					const summary =
						prompt.match(/<summary>\n([\s\S]*?)\n<\/summary>/)?.[1] ?? "";
					return summary.includes("QUALITY_REPAIR_DETAIL")
						? {
								score: 9,
								decision: "accept",
								missing: [],
								contradictions: [],
								diagnosis: "quality target met",
							}
						: {
								score: 8,
								decision: "reject",
								missing: ["verification evidence is too sparse"],
								contradictions: [],
								diagnosis: "safe but below handoff quality target",
							};
				},
			});

			assert.equal(result.accepted, true);
			assert.equal(result.repaired, true);
			assert.equal(judgeCalls, 2);
			assert.equal(result.judge.score, 9);
			assert.match(result.summary, /QUALITY_REPAIR_DETAIL/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("continues repair attempts after an empty repair without clobbering the prior candidate", async () => {
		const root = await makeRoot();
		try {
			let summaryCalls = 0;
			let judgeCalls = 0;
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "Continue the benchmark analysis."),
					assistant("a1", "Current answer: preserve repair recovery details."),
				],
				sessionId: "s-empty-repair-recovery",
				cwd: "/repo",
				artifactRoot: root,
				continuation: { triggerEntryId: "a1", turns: [] },
				judgeThreshold: 7,
				repairAttempts: 3,
				completeSummary: async (prompt) => {
					summaryCalls += 1;
					if (summaryCalls === 1) return "## Goal\nBenchmark analysis.";
					assert.match(prompt, /EMPTY_REPAIR_RECOVERY/);
					assert.match(prompt, /missing recovery detail/);
					if (summaryCalls === 2) return "# Summary";
					return "## Goal\nBenchmark analysis.\n\n## Verification / Evidence\n- EMPTY_REPAIR_RECOVERY preserved.";
				},
				completeJudge: async (prompt) => {
					judgeCalls += 1;
					return prompt.includes("EMPTY_REPAIR_RECOVERY")
						? {
								score: 9,
								decision: "accept",
								missing: [],
								contradictions: [],
								diagnosis: "quality target met",
							}
						: {
								score: 6,
								decision: "reject",
								missing: ["EMPTY_REPAIR_RECOVERY"],
								contradictions: [],
								diagnosis: "missing recovery detail",
							};
				},
			});

			assert.equal(result.accepted, true);
			assert.equal(result.repaired, true);
			assert.equal(summaryCalls, 3);
			assert.equal(judgeCalls, 2);
			assert.equal(result.judge.score, 9);
			assert.match(result.summary, /EMPTY_REPAIR_RECOVERY/);
			assert.doesNotMatch(result.summary, /# Summary\s*$/);
			const candidate = await readFile(
				`${result.artifactDir}/candidate-summary.md`,
				"utf8",
			);
			assert.match(candidate, /EMPTY_REPAIR_RECOVERY/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("validated run repairs once and accepts only after judge approval", async () => {
		const root = await makeRoot();
		try {
			let judgeCalls = 0;
			const result = await runValidatedSlipstream({
				retainArtifacts: true,
				branchEntries: [
					user("u1", "Use Slipstream. Next step implementation."),
				],
				sessionId: "s1",
				cwd: "/repo",
				artifactRoot: root,
				continuation: {
					triggerEntryId: "u1",
					turns: [
						{
							turnIndex: 0,
							assistantText: "implementation continued",
							toolResults: [],
						},
					],
				},
				completeSummary: async (prompt) =>
					prompt.includes("Rewrite the full summary")
						? "## Goal\nBuild\n\n## Active Decisions\n- Use Slipstream"
						: "## Goal\nBuild",
				completeJudge: async () => {
					judgeCalls += 1;
					return judgeCalls === 1
						? {
								score: 3,
								decision: "reject",
								missing: ["Missing decision: Use Slipstream"],
								contradictions: [],
								diagnosis: "missing decision",
							}
						: {
								score: 8,
								decision: "accept",
								missing: [],
								contradictions: [],
								diagnosis: "ok",
							};
				},
			});

			assert.equal(result.accepted, true);
			assert.equal(result.repaired, true);
			assert.match(result.summary, /Use Slipstream/);
			assert.equal(judgeCalls, 2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
