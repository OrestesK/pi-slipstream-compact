import assert from "node:assert/strict";
import {
	access,
	mkdtemp,
	mkdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore } from "../src/artifact-store.ts";
import {
	finalizeAutoJob,
	isAutoTriggerBoundary,
	shouldActivatePreparedCompaction,
	shouldActivatePreparedCompactionOnTurn,
	shouldStartAutoJob,
	shouldTriggerPreparedCompactionNow,
	startAutoJob,
} from "../src/auto.ts";
import type { FinalizeAutoJobInput } from "../src/auto.ts";
import { handleSlipstreamCommand } from "../src/commands.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { registerLifecycle, runtimeReadiness } from "../src/index.ts";
import type { ValidatedRunResult } from "../src/pipeline.ts";
import {
	createRuntimeState,
	storePendingValidated,
} from "../src/session-state.ts";
import type { AgentMessage, AutoJob, SessionEntry } from "../src/types.ts";

function config() {
	return {
		...DEFAULT_CONFIG,
		retainArtifacts: true,
		autoTrigger: true,
		triggerContextPercent: 0.55,
		softContextPercent: 0.55,
		hardContextPercent: 0.55,
		contextReserveTokens: 0,
		slipstreamKeepRecentTokens: 1,
		maxContinuationTurns: 2,
		repairAttempts: 0,
		pendingTtlMs: 10_000,
	};
}

async function waitUntil(
	predicate: () => boolean,
	description: string,
): Promise<void> {
	const deadline = Date.now() + 500;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
	assert.fail(`Timed out waiting for ${description}`);
}

function msg(id: string, message: AgentMessage): SessionEntry {
	return { type: "message", id, parentId: null, timestamp: "t", message };
}

function centralStatsPath(root: string, sessionId: string): string {
	return join(root, "sessions", `${sessionId}.jsonl`);
}

function autoJobStats() {
	return {
		startedAt: "2026-06-01T00:00:00.000Z",
		startedAtMs: 0,
		timingsMs: {
			snapshot: 0,
			artifacts: 0,
			stateEvidence: 0,
			summary: 0,
			judging: 0,
			repair: 0,
			total: 0,
		},
	};
}

describe("auto Slipstream lifecycle", () => {
	it("starts only when enabled auto trigger crosses trigger threshold", () => {
		assert.equal(
			shouldStartAutoJob(config(), createRuntimeState(), {
				tokens: 55,
				contextWindow: 100,
			}),
			true,
		);
		assert.equal(
			shouldStartAutoJob(
				{ ...config(), autoTrigger: false },
				createRuntimeState(),
				{
					tokens: 90,
					contextWindow: 100,
				},
			),
			false,
		);
		assert.equal(
			shouldStartAutoJob(config(), createRuntimeState(), {
				tokens: 54,
				contextWindow: 100,
			}),
			false,
		);
		assert.equal(
			shouldStartAutoJob(config(), createRuntimeState(), {
				tokens: 34_000,
				contextWindow: 100_000,
				percent: 34,
			}),
			false,
		);
		assert.equal(
			shouldStartAutoJob(config(), createRuntimeState(), {
				tokens: 1_000,
				contextWindow: 100_000,
				percent: 1,
			}),
			false,
		);
		assert.equal(
			shouldStartAutoJob(config(), createRuntimeState(), {
				tokens: 60_000,
				contextWindow: 100_000,
				percent: 60,
			}),
			true,
		);
	});

	it("normalizes context usage boundaries for auto trigger start", () => {
		const cases: Array<{
			name: string;
			usage: Parameters<typeof shouldStartAutoJob>[2];
			expected: boolean;
		}> = [
			{ name: "missing usage", usage: undefined, expected: false },
			{
				name: "zero context window",
				usage: { tokens: 100, contextWindow: 0 },
				expected: false,
			},
			{
				name: "just below token ratio",
				usage: { tokens: 54, contextWindow: 100 },
				expected: false,
			},
			{
				name: "exact soft token ratio",
				usage: { tokens: 55, contextWindow: 100 },
				expected: true,
			},
			{
				name: "percent as whole number below",
				usage: { tokens: null, percent: 54 },
				expected: false,
			},
			{
				name: "percent as whole number exact",
				usage: { tokens: null, percent: 55 },
				expected: true,
			},
			{
				name: "percent as fraction below",
				usage: { tokens: null, percent: 0.54 },
				expected: false,
			},
			{
				name: "percent as fraction exact",
				usage: { tokens: null, percent: 0.55 },
				expected: true,
			},
			{
				name: "exact one percent stays low",
				usage: { tokens: null, percent: 1 },
				expected: false,
			},
		];

		for (const testCase of cases) {
			assert.equal(
				shouldStartAutoJob(config(), createRuntimeState(), testCase.usage),
				testCase.expected,
				testCase.name,
			);
		}
	});

	it("clears mismatched pending state before trigger gating", () => {
		const cases: Array<{
			name: string;
			match: NonNullable<Parameters<typeof shouldStartAutoJob>[3]>;
		}> = [
			{
				name: "expired",
				match: {
					sessionId: "s1",
					cwd: "/repo",
					now: 10_000,
					validatedThroughEntryId: "a1",
				},
			},
			{
				name: "wrong session",
				match: {
					sessionId: "s2",
					cwd: "/repo",
					now: 1_000,
					validatedThroughEntryId: "a1",
				},
			},
			{
				name: "wrong cwd",
				match: {
					sessionId: "s1",
					cwd: "/other",
					now: 1_000,
					validatedThroughEntryId: "a1",
				},
			},
		];

		for (const testCase of cases) {
			const state = createRuntimeState();
			state.pending = {
				sessionId: "s1",
				cwd: "/repo",
				projectId: "/repo",
				artifactDir: "/tmp/slipstream-pending",
				summary: "## Goal\nStale",
				firstKeptEntryId: "k1",
				validatedThroughEntryId: "a1",
				tokensBefore: 1000,
				details: { judge: { score: 8 }, artifacts: [] },
				expiresAt: 10_000,
			};
			state.status = "ready_to_adopt";

			assert.equal(
				shouldStartAutoJob(
					config(),
					state,
					{ tokens: 56, contextWindow: 100 },
					testCase.match,
				),
				true,
				testCase.name,
			);
			assert.equal(state.pending, null, testCase.name);
			assert.equal(state.status, "idle", testCase.name);
		}
	});

	it("keeps matching pending state from starting replacement auto work", () => {
		const state = createRuntimeState();
		state.pending = {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nStill valid",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 1000,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 10_000,
		};
		state.status = "ready_to_adopt";

		assert.equal(
			shouldStartAutoJob(
				config(),
				state,
				{ tokens: 56, contextWindow: 100 },
				{
					sessionId: "s1",
					cwd: "/repo",
					now: 1_000,
					validatedThroughEntryId: "a1",
				},
			),
			false,
		);
		assert.equal(state.pending?.summary, "## Goal\nStill valid");
	});

	it("does not start replacement auto work while another job or active promise exists", () => {
		const activePromiseState = createRuntimeState();
		activePromiseState.activePromise = Promise.resolve("busy");
		assert.equal(
			shouldStartAutoJob(
				config(),
				activePromiseState,
				{ tokens: 56, contextWindow: 100 },
				{
					sessionId: "s1",
					cwd: "/repo",
					now: 1_000,
					validatedThroughEntryId: "a1",
				},
			),
			false,
		);

		const autoJobState = createRuntimeState();
		autoJobState.autoJob = {
			artifactRoot: "/tmp",
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			snapshot: {
				sessionId: "s1",
				cwd: "/repo",
				triggerEntryId: "a1",
				firstKeptEntryId: "a1",
				tokensBefore: 100,
				summaryInputMessages: [],
				keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "a1" },
				manifest: {
					filesRead: [],
					filesModified: [],
					filesDeleted: [],
					errors: [],
					userDecisions: [],
					constraints: [],
					openLoops: [],
					recentVerification: [],
					latestUpdates: [],
					retainedTailUpdates: [],
					latestExchangeState: [],
					terminalFinalAnswerEvidence: [],
					latestSignals: [],
					staleSignals: [],
					userAssertionTrail: [],
					criticalLiterals: [],
					previousSummary: null,
					artifactRefs: [],
					knownFileRefs: new Set<string>(),
				},
			},
			firstKeptEntryId: "a1",
			tokensBefore: 100,
			artifactDir: "/tmp/slipstream-auto-job",
			summaryArtifactRefs: [],
			continuation: {
				appendTurn: () => undefined,
				isReady: () => false,
				snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
			},
			summaryPromise: Promise.resolve("summary"),
			stats: autoJobStats(),
			finalizing: false,
		};
		assert.equal(
			shouldStartAutoJob(
				config(),
				autoJobState,
				{ tokens: 56, contextWindow: 100 },
				{
					sessionId: "s1",
					cwd: "/repo",
					now: 1_000,
					validatedThroughEntryId: "a1",
				},
			),
			false,
		);
	});

	it("activates prepared compaction as soon as a current validated summary is ready", () => {
		const state = createRuntimeState();
		state.pending = {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 1000,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 10_000,
		};
		state.status = "ready_to_adopt";

		assert.equal(
			shouldActivatePreparedCompaction(config(), state, {
				tokens: 1,
				contextWindow: 100,
			}),
			true,
		);
		assert.equal(
			shouldActivatePreparedCompaction(
				config(),
				state,
				{
					tokens: 1,
					contextWindow: 100,
				},
				{ validatedThroughEntryId: "a1" },
			),
			true,
		);
	});

	it("does not activate stale prepared compactions directly after the branch advances", () => {
		const state = createRuntimeState();
		state.pending = {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 1000,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 10_000,
		};
		state.status = "ready_to_adopt";

		assert.equal(
			shouldActivatePreparedCompaction(
				config(),
				state,
				{
					tokens: 60,
					contextWindow: 100,
				},
				{
					sessionId: "s1",
					cwd: "/repo",
					now: 1_000,
					validatedThroughEntryId: "u2",
				},
			),
			false,
		);
		assert.equal(state.pending?.validatedThroughEntryId, "a1");
		assert.equal(state.status, "ready_to_adopt");
	});

	it("keeps stale pending state instead of starting replacement auto work", () => {
		const state = createRuntimeState();
		state.pending = {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nStale",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 1000,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 10_000,
		};
		state.status = "ready_to_adopt";

		assert.equal(
			shouldStartAutoJob(
				config(),
				state,
				{ tokens: 56, contextWindow: 100 },
				{
					sessionId: "s1",
					cwd: "/repo",
					now: 1_000,
					validatedThroughEntryId: "u2",
				},
			),
			false,
		);
		assert.equal(state.pending?.validatedThroughEntryId, "a1");
		assert.equal(state.status, "ready_to_adopt");
	});

	it("activates prepared compaction only at final assistant boundaries", () => {
		const state = createRuntimeState();
		state.pending = {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 1000,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 10_000,
		};
		state.status = "ready_to_adopt";
		const usage = { tokens: 60_000, contextWindow: 100_000, percent: 60 };
		const match = {
			sessionId: "s1",
			now: 1_000,
			validatedThroughEntryId: "a1",
		};

		assert.equal(
			shouldActivatePreparedCompactionOnTurn(
				config(),
				state,
				usage,
				{ role: "user", content: "go on" },
				match,
			),
			false,
		);
		assert.equal(
			shouldActivatePreparedCompactionOnTurn(
				config(),
				state,
				usage,
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "bash",
							arguments: { command: "npm test" },
						},
					],
					stopReason: "toolUse",
				},
				match,
			),
			false,
		);
		assert.equal(
			shouldActivatePreparedCompactionOnTurn(
				config(),
				state,
				usage,
				{ role: "assistant", content: "final report", stopReason: "stop" },
				match,
			),
			true,
		);
	});

	it("does not trigger asynchronous prepared compaction while the agent is busy", () => {
		assert.equal(
			shouldTriggerPreparedCompactionNow({
				isIdle: () => true,
				hasPendingMessages: () => false,
			}),
			true,
		);
		assert.equal(
			shouldTriggerPreparedCompactionNow({
				hasPendingMessages: () => false,
			}),
			false,
		);
		assert.equal(
			shouldTriggerPreparedCompactionNow({
				isIdle: () => false,
				hasPendingMessages: () => false,
			}),
			false,
		);
		assert.equal(
			shouldTriggerPreparedCompactionNow({
				isIdle: () => true,
				hasPendingMessages: () => true,
			}),
			false,
		);
		assert.equal(
			shouldTriggerPreparedCompactionNow({
				isIdle: () => {
					throw new Error("stale context");
				},
				hasPendingMessages: () => false,
			}),
			false,
		);
		const staleContext = {
			get isIdle() {
				throw new Error(
					"This extension ctx is stale after session replacement or reload.",
				);
			},
		};
		assert.equal(
			shouldTriggerPreparedCompactionNow(
				runtimeReadiness(staleContext as never),
			),
			false,
		);
	});

	it("starts only at final assistant boundaries, not tool-call steps", () => {
		assert.equal(
			isAutoTriggerBoundary({
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-1",
						name: "bash",
						arguments: { command: "npm test" },
					},
				],
				stopReason: "toolUse",
			}),
			false,
		);
		assert.equal(
			isAutoTriggerBoundary({
				role: "assistant",
				content: "ambiguous report",
			}),
			false,
		);
		assert.equal(
			isAutoTriggerBoundary({
				role: "assistant",
				content: "final report",
				stopReason: "stop",
			}),
			true,
		);
	});

	it("registers no tool-result message_end auto-start path", () => {
		const state = createRuntimeState();
		const registeredEvents: string[] = [];
		const pi = {
			on: (event: string) => {
				registeredEvents.push(event);
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state);

		assert.equal(registeredEvents.includes("message_end"), false);
	});

	it("auto start does not install a job after its trigger is invalidated", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-invalid-start-"));
		try {
			const state = createRuntimeState();
			let current = true;
			let summaryCalls = 0;
			const job = await startAutoJob({
				state,
				config: config(),
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-invalid-start",
				cwd: "/repo",
				artifactRoot: root,
				executeGit: async () => {
					current = false;
					return { stdout: "", stderr: "" };
				},
				isCurrent: () => current,
				completeSummary: async () => {
					summaryCalls += 1;
					return "## Goal\nShould not start";
				},
			});

			assert.equal(job, null);
			assert.equal(state.autoJob, null);
			assert.equal(state.activePromise, null);
			assert.equal(state.compactionWanted, false);
			assert.equal(summaryCalls, 0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("auto start yields after snapshot progress before reading branch content", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-yield-"));
		let yielded = false;
		try {
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: config(),
				branchEntries: [
					msg("u1", {
						role: "user",
						get content() {
							assert.equal(yielded, true);
							return "Use Slipstream";
						},
					}),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-auto-yield",
				cwd: "/repo",
				artifactRoot: root,
				executeGit: async () => ({ stdout: "", stderr: "" }),
				onProgress: (event) => {
					if (event.phase === "snapshot")
						queueMicrotask(() => {
							yielded = true;
						});
				},
				completeSummary: async () => "## Goal\nAuto summary",
			});

			assert.ok(job);
			await job.summaryPromise;
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("auto yields after prompt progress before summary, judge, and repair model calls", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-prompt-yield-"));
		try {
			const state = createRuntimeState();
			const yielded = {
				summary: false,
				judging: 0,
				repairing: false,
			};
			let summaryCalls = 0;
			let judgeCalls = 0;
			const onProgress = (event: { phase: string }) => {
				if (event.phase === "summary")
					queueMicrotask(() => {
						yielded.summary = true;
					});
				if (event.phase === "judging")
					queueMicrotask(() => {
						yielded.judging += 1;
					});
				if (event.phase === "repairing")
					queueMicrotask(() => {
						yielded.repairing = true;
					});
			};
			const completeSummary = async () => {
				summaryCalls += 1;
				if (summaryCalls === 1) {
					assert.equal(yielded.summary, true);
					return "## Goal\nAuto candidate";
				}
				assert.equal(yielded.repairing, true);
				return "## Goal\nAuto repaired candidate";
			};
			const completeJudge = async () => {
				judgeCalls += 1;
				assert.equal(yielded.judging, judgeCalls);
				if (judgeCalls === 1)
					return {
						score: 4,
						decision: "reject" as const,
						missing: ["repair needed"],
						contradictions: [],
						diagnosis: "needs repair",
					};
				return {
					score: 9,
					decision: "accept" as const,
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				};
			};

			const job = await startAutoJob({
				state,
				config: { ...config(), repairAttempts: 1 },
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-auto-prompt-yield",
				cwd: "/repo",
				artifactRoot: root,
				executeGit: async () => ({ stdout: "", stderr: "" }),
				onProgress,
				completeSummary,
			});
			assert.ok(job);
			await job.summaryPromise;
			job.continuation.appendTurn({
				turnIndex: 2,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});

			const accepted = await finalizeAutoJob({
				state,
				config: { ...config(), repairAttempts: 1 },
				completeSummary,
				completeJudge,
				now: () => 100,
				onProgress,
			});

			assert.equal(accepted, true);
			assert.equal(summaryCalls, 2);
			assert.equal(judgeCalls, 2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("auto finalization waits for the summary before showing judge progress", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-wait-summary-"));
		try {
			const state = createRuntimeState();
			let resolveSummary!: (summary: string) => void;
			state.autoJob = {
				artifactRoot: "/tmp",
				sessionId: "s1",
				cwd: "/repo",
				projectId: "/repo",
				snapshot: {
					sessionId: "s1",
					cwd: "/repo",
					triggerEntryId: "a1",
					firstKeptEntryId: "a1",
					tokensBefore: 100,
					summaryInputMessages: [],
					keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "a1" },
					manifest: {
						filesRead: [],
						filesModified: [],
						filesDeleted: [],
						errors: [],
						userDecisions: [],
						constraints: [],
						openLoops: [],
						recentVerification: [],
						latestUpdates: [],
						retainedTailUpdates: [],
						latestExchangeState: [],
						terminalFinalAnswerEvidence: [],
						latestSignals: [],
						staleSignals: [],
						userAssertionTrail: [],
						criticalLiterals: [],
						previousSummary: null,
						artifactRefs: [],
						knownFileRefs: new Set<string>(),
					},
				},
				firstKeptEntryId: "a1",
				tokensBefore: 100,
				artifactDir: root,
				summaryArtifactRefs: [],
				continuation: {
					appendTurn: () => undefined,
					isReady: () => true,
					snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
				},
				summaryPromise: new Promise((resolve) => {
					resolveSummary = resolve;
				}),
				stats: autoJobStats(),
				finalizing: false,
			};
			const phases: string[] = [];
			const acceptedPromise = finalizeAutoJob({
				state,
				config: config(),
				completeSummary: async () => "## Goal\nRepair",
				completeJudge: async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
				now: () => 100,
				onProgress: (event) => phases.push(event.phase),
			});

			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(phases, ["finalizing-summary"]);
			assert.equal(state.status, "finalizing_summary");

			resolveSummary("## Goal\nAuto summary");
			assert.equal(await acceptedPromise, true);
			assert.deepEqual(phases.slice(0, 2), ["finalizing-summary", "judging"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects empty auto candidates without judge repair", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-"));
		try {
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: { ...config(), repairAttempts: 1 },
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-empty-auto",
				cwd: "/repo",
				artifactRoot: root,
				completeSummary: async () => "## Goal",
			});
			assert.ok(job);
			job.continuation.appendTurn({
				turnIndex: 2,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});

			const accepted = await finalizeAutoJob({
				state,
				config: { ...config(), repairAttempts: 1 },
				completeSummary: async () => {
					throw new Error("empty auto candidate should not be repaired");
				},
				completeJudge: async () => {
					throw new Error("empty auto candidate should not be judged");
				},
				now: () => 100,
			});

			assert.equal(accepted, false);
			assert.equal(state.status, "rejected");
			assert.equal(state.pending, null);
			assert.match(
				state.lastJudge?.diagnosis ?? "",
				/no substantive summary to repair/,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("accepts percent-only auto finalization when tokensBefore is null", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-"));
		try {
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: config(),
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-percent-only-auto",
				cwd: "/repo",
				artifactRoot: root,
				contextUsage: { tokens: null, percent: 60 },
				completeSummary: async () => "## Goal\nAuto summary",
			});
			assert.ok(job);
			assert.equal(job.tokensBefore, null);
			job.continuation.appendTurn({
				turnIndex: 1,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});

			const accepted = await finalizeAutoJob({
				state,
				config: config(),
				completeSummary: async () => "## Goal\nRepair",
				completeJudge: async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
				now: () => 100,
			});

			assert.equal(accepted, true);
			assert.equal(state.pending?.tokensBefore, null);
			assert.equal(state.pending?.firstKeptEntryId, job.firstKeptEntryId);
			assert.equal(state.status, "ready_to_adopt");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("omits temporary paths and removes a rejected non-retained auto run", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-non-retained-"));
		try {
			const state = createRuntimeState();
			const defaultConfig = {
				...config(),
				retainArtifacts: false,
				rejectedSummaryMode: "reject" as const,
			};
			let summaryPrompt = "";
			const job = await startAutoJob({
				state,
				config: defaultConfig,
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-auto-non-retained",
				cwd: "/repo",
				artifactRoot: root,
				completeSummary: async (prompt) => {
					summaryPrompt = prompt;
					return "## Goal\nRejected summary";
				},
			});
			assert.ok(job);
			job.continuation.appendTurn({
				turnIndex: 1,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});

			const accepted = await finalizeAutoJob({
				state,
				config: defaultConfig,
				completeSummary: async () => "## Goal\nRepair",
				completeJudge: async () => ({
					score: 4,
					decision: "reject",
					missing: ["important context"],
					contradictions: [],
					diagnosis: "incomplete",
				}),
				now: () => Date.now(),
			});

			assert.equal(accepted, false);
			assert.equal(summaryPrompt.includes(root), false);
			assert.equal(summaryPrompt.includes(job.artifactDir), false);
			await assert.rejects(() => access(job.artifactDir));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("short-circuits auto finalization when not ready or already finalizing", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-"));
		try {
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: config(),
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-short-circuit-auto",
				cwd: "/repo",
				artifactRoot: root,
				tokensBefore: 100,
				completeSummary: async () => "## Goal\nAuto summary",
			});
			assert.ok(job);
			await job.summaryPromise;
			assert.equal(
				await finalizeAutoJob({
					state,
					config: config(),
					completeSummary: async () => "## Goal\nRepair",
					completeJudge: async () => {
						throw new Error("not ready should not judge");
					},
					now: () => 100,
				}),
				false,
			);
			job.continuation.appendTurn({
				turnIndex: 1,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});
			job.finalizing = true;
			assert.equal(
				await finalizeAutoJob({
					state,
					config: config(),
					completeSummary: async () => "## Goal\nRepair",
					completeJudge: async () => {
						throw new Error("already finalizing should not judge");
					},
					now: () => 100,
				}),
				false,
			);
			assert.equal(state.pending, null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("allows idle auto finalization to judge and repair without a later continuation turn", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-idle-finalize-"));
		try {
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: { ...config(), repairAttempts: 1 },
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-idle-finalize-auto",
				cwd: "/repo",
				artifactRoot: root,
				tokensBefore: 100,
				completeSummary: async () => "## Goal\nInitial idle summary",
			});
			assert.ok(job);
			await job.summaryPromise;

			let judgeCalls = 0;
			let repairCalls = 0;
			const accepted = await finalizeAutoJob({
				state,
				config: { ...config(), repairAttempts: 1 },
				completeSummary: async () => {
					repairCalls += 1;
					return "## Goal\nRepaired idle summary";
				},
				completeJudge: async () => {
					judgeCalls += 1;
					return judgeCalls === 1
						? {
								score: 4,
								decision: "reject",
								missing: ["needs repair"],
								contradictions: [],
								diagnosis: "below threshold",
							}
						: {
								score: 9,
								decision: "accept",
								missing: [],
								contradictions: [],
								diagnosis: "fixed",
							};
				},
				now: () => 100,
				validatedThroughEntryId: "a5",
				allowIncompleteContinuation: true,
			});

			assert.equal(accepted, true);
			assert.equal(judgeCalls, 2);
			assert.equal(repairCalls, 1);
			assert.equal(state.status, "ready_to_adopt");
			assert.equal(state.pending?.validatedThroughEntryId, "a5");
			assert.match(state.pending?.summary ?? "", /Repaired idle summary/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not stamp incomplete idle auto finalization as validated through a later branch head", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(
			join(parent, "slipstream-auto-incomplete-head-"),
		);
		try {
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: config(),
				branchEntries: [
					msg("u1", { role: "user", content: "old request" }),
					msg("a1", { role: "assistant", content: "old answer" }),
				],
				sessionId: "s-incomplete-head-auto",
				cwd: "/repo",
				artifactRoot: root,
				tokensBefore: 100,
				completeSummary: async () =>
					"## Goal\nIdle summary before later branch head",
			});
			assert.ok(job);
			await job.summaryPromise;
			const triggerEntryId = job.continuation.snapshot().triggerEntryId;

			const accepted = await finalizeAutoJob({
				state,
				config: config(),
				completeSummary: async () => {
					throw new Error("repair should not run for accepted candidate");
				},
				completeJudge: async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
				now: () => 100,
				validatedThroughEntryId: "later-branch-head",
				allowIncompleteContinuation: true,
			});

			assert.equal(accepted, true);
			assert.equal(state.pending?.validatedThroughEntryId, triggerEntryId);
			assert.notEqual(
				state.pending?.validatedThroughEntryId,
				"later-branch-head",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("repairs auto summaries with a full rewrite before storing pending state", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-"));
		try {
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: { ...config(), repairAttempts: 1 },
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-auto-repair",
				cwd: "/repo",
				artifactRoot: root,
				tokensBefore: 1_000,
				completeSummary: async () => "## Goal\nToo sparse",
			});
			assert.ok(job);
			job.continuation.appendTurn({
				turnIndex: 2,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});
			let judgeCalls = 0;
			let repairPrompt = "";
			const accepted = await finalizeAutoJob({
				state,
				config: { ...config(), repairAttempts: 1 },
				completeSummary: async (prompt) => {
					repairPrompt = prompt;
					return "## Goal\nBuild\n\n## Active Decisions\n- Use Slipstream";
				},
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
				now: () => 100,
			});

			assert.equal(accepted, true);
			assert.match(repairPrompt, /Rewrite the full summary/);
			assert.equal(state.pending?.summary.includes("Use Slipstream"), true);
			assert.doesNotMatch(state.pending?.summary ?? "", /Repair Addendum/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("retries auto parse-error judge once and does not repair first", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-parse-error-"));
		try {
			const state = createRuntimeState();
			let summaryCalls = 0;
			let judgeCalls = 0;
			const judgePromptLengths: number[] = [];
			const progress: string[] = [];
			const job = await startAutoJob({
				state,
				config: { ...config(), repairAttempts: 3 },
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream." }),
					msg("a1", { role: "assistant", content: "implementation done" }),
				],
				sessionId: "s-auto-parse-error",
				cwd: "/repo",
				artifactRoot: root,
				executeGit: async () => ({ stdout: "", stderr: "" }),
				onProgress: (event) =>
					progress.push(`${event.phase}: ${event.message}`),
				completeSummary: async (prompt) => {
					summaryCalls += 1;
					assert.doesNotMatch(prompt, /Rewrite the full summary/);
					return "## Goal\nContinue safely with AUTO_PARSE_ERROR_SENTINEL.";
				},
			});
			assert.ok(job);
			await job.summaryPromise;
			job.continuation.appendTurn({
				turnIndex: 1,
				message: { role: "assistant", content: "auto continuation" },
				toolResults: [
					{
						role: "toolResult",
						toolName: "retool",
						toolCallId: "tool-huge",
						isError: false,
						content: "X".repeat(120_000),
					},
				],
			});

			const accepted = await finalizeAutoJob({
				state,
				config: {
					...config(),
					repairAttempts: 3,
					rejectedSummaryMode: "reject",
				},
				completeSummary: async (prompt) => {
					summaryCalls += 1;
					assert.doesNotMatch(prompt, /Rewrite the full summary/);
					return "unexpected repair";
				},
				completeJudge: async (prompt) => {
					judgeCalls += 1;
					judgePromptLengths.push(prompt.length);
					assert.equal(prompt.length < 650_000, true);
					assert.match(prompt, /AUTO_PARSE_ERROR_SENTINEL/);
					return {
						rawText: `not json auto attempt ${judgeCalls}`,
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
				now: () => 100,
				onProgress: (event) =>
					progress.push(`${event.phase}: ${event.message}`),
			});

			assert.equal(accepted, false);
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
			assert.match(
				progress.join("\n"),
				/Retrying auto judge after parse_error/,
			);
			assert.doesNotMatch(progress.join("\n"), /Auto repair attempt/);
			assert.equal(state.pending, null);
			assert.equal(state.status, "rejected");
			const index = JSON.parse(
				await readFile(`${job.artifactDir}/index.json`, "utf8"),
			) as { records: Array<{ kind: string; path?: string }> };
			const rawJudgeRecords = index.records.filter(
				(record) => record.kind === "judge-raw-response",
			);
			assert.equal(rawJudgeRecords.length, 2);
			const rawJudge = JSON.parse(
				await readFile(rawJudgeRecords[0]?.path ?? "", "utf8"),
			) as {
				attempt: string;
				rawText: string;
				rawChars: number;
				sha256: string;
			};
			assert.equal(rawJudge.attempt, "auto-initial");
			assert.match(rawJudge.rawText, /not json auto attempt 1/);
			assert.equal(rawJudge.rawChars, "not json auto attempt 1".length);
			assert.match(rawJudge.sha256, /^[a-f0-9]{64}$/);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("strict judge repairs low-quality auto summaries before storing pending state", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-"));
		try {
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: { ...config(), repairAttempts: 1 },
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-auto-quality-repair",
				cwd: "/repo",
				artifactRoot: root,
				tokensBefore: 1_000,
				completeSummary: async () => "## Goal\nSafe but sparse",
			});
			assert.ok(job);
			job.continuation.appendTurn({
				turnIndex: 2,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});
			let judgeCalls = 0;
			const accepted = await finalizeAutoJob({
				state,
				config: { ...config(), repairAttempts: 1 },
				completeSummary: async () =>
					"## Goal\nSafe and detailed\n\n## Verification / Evidence\n- QUALITY_AUTO_DETAIL preserved.",
				completeJudge: async (prompt) => {
					judgeCalls += 1;
					assert.match(prompt, /continuation-quality reviewer/);
					return prompt.includes("QUALITY_AUTO_DETAIL")
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
				now: () => 100,
			});

			assert.equal(accepted, true);
			assert.equal(judgeCalls, 2);
			assert.match(state.pending?.summary ?? "", /QUALITY_AUTO_DETAIL/);
			assert.equal(state.lastJudge?.score, 9);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("continues auto repair after an empty repair output", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-"));
		try {
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: { ...config(), repairAttempts: 2 },
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-auto-empty-repair",
				cwd: "/repo",
				artifactRoot: root,
				tokensBefore: 1_000,
				completeSummary: async () => "## Goal\nToo sparse",
			});
			assert.ok(job);
			job.continuation.appendTurn({
				turnIndex: 2,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});
			let repairCalls = 0;
			let judgeCalls = 0;
			const accepted = await finalizeAutoJob({
				state,
				config: { ...config(), repairAttempts: 2 },
				completeSummary: async () => {
					repairCalls += 1;
					return repairCalls === 1
						? "## Goal"
						: "## Goal\nRecovered auto repair\n\n## Verification / Evidence\n- AUTO_EMPTY_RECOVERED";
				},
				completeJudge: async (prompt) => {
					judgeCalls += 1;
					return prompt.includes("AUTO_EMPTY_RECOVERED")
						? {
								score: 9,
								decision: "accept",
								missing: [],
								contradictions: [],
								diagnosis: "recovered",
							}
						: {
								score: 3,
								decision: "reject",
								missing: ["AUTO_EMPTY_RECOVERED"],
								contradictions: [],
								diagnosis: "missing recovery",
							};
				},
				now: () => 100,
			});

			assert.equal(accepted, true);
			assert.equal(repairCalls, 2);
			assert.equal(judgeCalls, 2);
			assert.match(state.pending?.summary ?? "", /AUTO_EMPTY_RECOVERED/);
			assert.equal(state.pending?.details.rejectedSummaryAccepted, false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("policy-accepts rejected auto summaries after repair attempts fail", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-"));
		try {
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: {
					...config(),
					rejectedSummaryMode: "accept" as const,
					repairAttempts: 1,
				},
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-auto-policy-accept",
				cwd: "/repo",
				artifactRoot: root,
				tokensBefore: 1_000,
				completeSummary: async () => "## Goal\nToo sparse",
			});
			assert.ok(job);
			job.continuation.appendTurn({
				turnIndex: 2,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});
			const accepted = await finalizeAutoJob({
				state,
				config: {
					...config(),
					rejectedSummaryMode: "accept" as const,
					repairAttempts: 1,
				},
				completeSummary: async () =>
					"Continuation card:\n- Current task: Still below threshold\n\n## Goal\nStill below threshold",
				completeJudge: async () => ({
					score: 4,
					decision: "reject",
					missing: ["critical auto fact"],
					contradictions: [],
					diagnosis: "below threshold",
				}),
				now: () => 100,
			});

			assert.equal(accepted, true);
			assert.equal(state.status, "ready_to_adopt");
			assert.match(state.pending?.summary ?? "", /^Continuation card:/);
			assert.match(
				state.pending?.summary ?? "",
				/## Deterministic Evidence Capsule/,
			);
			assert.equal(state.pending?.details.rejectedSummaryAccepted, true);
			assert.equal(state.pending?.details.rejectedSummaryMode, "accept");
			assert.equal(state.lastJudge?.score, 4);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("clears auto job after finalize failure so future auto work can start", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-"));
		try {
			const state = createRuntimeState();
			const entries = [
				msg("u1", { role: "user", content: "Use Slipstream" }),
				msg("a1", { role: "assistant", content: "working" }),
				msg("u2", { role: "user", content: "more" }),
				msg("a2", { role: "assistant", content: "more" }),
				msg("u3", { role: "user", content: "more" }),
				msg("a3", { role: "assistant", content: "more" }),
				msg("u4", { role: "user", content: "more" }),
				msg("a4", { role: "assistant", content: "more" }),
				msg("u5", { role: "user", content: "new work" }),
				msg("a5", { role: "assistant", content: "recent kept" }),
			];
			const job = await startAutoJob({
				state,
				config: config(),
				branchEntries: entries,
				sessionId: "s-auto-failure",
				cwd: "/repo",
				artifactRoot: root,
				tokensBefore: 1_000,
				completeSummary: async () => "## Goal\nBuild",
			});
			assert.ok(job);
			await job.summaryPromise;
			job.continuation.appendTurn({
				turnIndex: 2,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});

			await assert.rejects(
				() =>
					finalizeAutoJob({
						state,
						config: config(),
						completeSummary: async () => "## Goal\nRepaired",
						completeJudge: async () => {
							throw new Error("judge unavailable");
						},
						now: () => 100,
					}),
				/judge unavailable/,
			);
			assert.equal(state.autoJob, null);
			assert.equal(state.status, "failed");
			assert.equal(
				shouldStartAutoJob(config(), state, {
					tokens: 60,
					contextWindow: 100,
				}),
				true,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("freezes snapshot, waits for future continuation, then stores pending validated summary", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-"));
		const previousStatsRoot = process.env.PI_SLIPSTREAM_STATS_ROOT;
		try {
			const statsRoot = join(root, "central-stats");
			process.env.PI_SLIPSTREAM_STATS_ROOT = statsRoot;
			const state = createRuntimeState();
			let summaryPrompt = "";
			let judgePrompt = "";
			const job = await startAutoJob({
				state,
				config: config(),
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "I will work" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s1",
				cwd: "/repo",
				artifactRoot: root,
				tokensBefore: 1_000,
				contextUsage: { tokens: 90_000, contextWindow: 1_000_000 },
				executeGit: async (args) => ({
					stdout: args.includes("status") ? " M src/auto.ts\n" : "",
					stderr: "",
				}),
				completeSummary: async (prompt) => {
					summaryPrompt = prompt;
					return "Continuation card:\n- Current task: Build\n\n## Goal\nBuild";
				},
			});
			assert.ok(job);
			assert.equal(state.status, "awaiting_continuation");
			await job.summaryPromise;
			assert.match(summaryPrompt, /State evidence bundle/);
			assert.match(summaryPrompt, /M src\/auto\.ts/);
			job.continuation.appendTurn({
				turnIndex: 2,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});
			const accepted = await finalizeAutoJob({
				state,
				config: config(),
				completeSummary: async () =>
					"Continuation card:\n- Current task: Build\n\n## Goal\nBuild",
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
				now: () => 100,
				validatedThroughEntryId: "a6",
			});

			assert.equal(accepted, true);
			assert.match(judgePrompt, /Use Slipstream/);
			assert.match(judgePrompt, /Protected distilled state evidence/);
			assert.doesNotMatch(judgePrompt, /Bounded git diff -U20/);
			assert.match(state.pending?.summary ?? "", /^Continuation card:/);
			assert.match(state.pending?.summary ?? "", /## Goal\nBuild/);
			assert.match(
				state.pending?.summary ?? "",
				/## Deterministic Evidence Capsule/,
			);
			assert.equal(state.pending?.validatedThroughEntryId, "a6");
			assert.equal(
				shouldActivatePreparedCompactionOnTurn(
					config(),
					state,
					{ tokens: 60_000, contextWindow: 100_000, percent: 60 },
					{ role: "assistant", content: "future turn", stopReason: "stop" },
					{ sessionId: "s1", now: 100, validatedThroughEntryId: "a6" },
				),
				true,
			);
			assert.equal(state.pending?.expiresAt, 10_100);
			const pendingArtifact = JSON.parse(
				await readFile(join(job.artifactDir, "pending.json"), "utf8"),
			) as { validatedThroughEntryId?: unknown; details?: { auto?: unknown } };
			assert.equal(pendingArtifact.validatedThroughEntryId, "a6");
			assert.equal(pendingArtifact.details?.auto, true);
			await assert.rejects(() => access(join(job.artifactDir, "stats.json")));
			const statsLines = (
				await readFile(centralStatsPath(statsRoot, "s1"), "utf8")
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
				timingsMs: { total: number; snapshot: number; summary: number };
			};
			assert.equal(stats.mode, "auto");
			assert.equal(stats.outcome, "accepted");
			assert.equal(stats.accepted, true);
			assert.equal(stats.judgeScore, 8);
			assert.equal(stats.artifactDir.startsWith("/"), false);
			assert.notEqual(stats.artifactDir, job.artifactDir);
			assert.equal(stats.timingsMs.total >= 0, true);
			assert.equal(stats.timingsMs.snapshot >= 0, true);
			assert.equal(stats.timingsMs.summary >= 0, true);
		} finally {
			if (previousStatsRoot === undefined) {
				delete process.env.PI_SLIPSTREAM_STATS_ROOT;
			} else {
				process.env.PI_SLIPSTREAM_STATS_ROOT = previousStatsRoot;
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not fail auto finalization when central stats cannot be written", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-"));
		const previousStatsRoot = process.env.PI_SLIPSTREAM_STATS_ROOT;
		try {
			process.env.PI_SLIPSTREAM_STATS_ROOT = "/dev/null";
			const state = createRuntimeState();
			const job = await startAutoJob({
				state,
				config: config(),
				branchEntries: [
					msg("u1", { role: "user", content: "Use Slipstream" }),
					msg("a1", { role: "assistant", content: "older" }),
					msg("u2", { role: "user", content: "more" }),
					msg("a2", { role: "assistant", content: "more" }),
					msg("u3", { role: "user", content: "more" }),
					msg("a3", { role: "assistant", content: "more" }),
					msg("u4", { role: "user", content: "more" }),
					msg("a4", { role: "assistant", content: "more" }),
					msg("u5", { role: "user", content: "new work" }),
					msg("a5", { role: "assistant", content: "recent kept" }),
				],
				sessionId: "s-auto-stats-failure",
				cwd: "/repo",
				artifactRoot: root,
				tokensBefore: 1_000,
				completeSummary: async () => "## Goal\nBuild",
			});
			assert.ok(job);
			await job.summaryPromise;
			job.continuation.appendTurn({
				turnIndex: 2,
				message: { role: "assistant", content: "future turn" },
				toolResults: [],
			});

			const accepted = await finalizeAutoJob({
				state,
				config: config(),
				completeSummary: async () => "## Goal\nRepaired",
				completeJudge: async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
				now: () => 100,
				validatedThroughEntryId: "a6",
			});

			assert.equal(accepted, true);
			assert.equal(state.pending?.validatedThroughEntryId, "a6");
			await assert.rejects(() => access(join(job.artifactDir, "stats.json")));
		} finally {
			if (previousStatsRoot === undefined) {
				delete process.env.PI_SLIPSTREAM_STATS_ROOT;
			} else {
				process.env.PI_SLIPSTREAM_STATS_ROOT = previousStatsRoot;
			}
			await rm(root, { recursive: true, force: true });
		}
	});

	it("session_start yields before pending artifact recovery", async () => {
		const state = createRuntimeState();
		const root = await mkdtemp(
			join(process.cwd(), ".scratch", "test-tmp", "startup-recovery-yield-"),
		);
		try {
			const run = await new ArtifactStore({ root }).createRun({
				sessionId: "s-start",
				triggerEntryId: "a1",
				cwd: process.cwd(),
			});
			const artifactDir = run.dir;
			const expiresAt = Date.now() + 10_000;
			await writeFile(
				join(artifactDir, "pending.json"),
				`${JSON.stringify(
					{
						sessionId: "s-start",
						cwd: process.cwd(),
						projectId: process.cwd(),
						summary: "## Goal\nRecovered after yield",
						firstKeptEntryId: "a1",
						validatedThroughEntryId: "a1",
						tokensBefore: 100,
						details: { judge: { score: 9 }, artifacts: [artifactDir] },
						expiresAt,
					},
					null,
					2,
				)}\n`,
			);
			const statusUpdates: Array<string | undefined> = [];
			let painted = false;
			const handlers: Partial<
				Record<
					"session_start",
					(event: unknown, ctx: unknown) => Promise<void> | void
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<void> | void,
				) => {
					if (event === "session_start") handlers.session_start = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			registerLifecycle(pi, { ...config(), artifactRoot: root }, state);

			const startPromise = handlers.session_start?.(
				{ reason: "startup" },
				{
					get cwd() {
						assert.equal(painted, true);
						return process.cwd();
					},
					ui: {
						setStatus: (_key: string, text: string | undefined) => {
							statusUpdates.push(text);
							queueMicrotask(() => {
								painted = true;
							});
						},
						setWidget: () => undefined,
					},
					sessionManager: {
						getSessionId: () => "s-start",
						getBranch: () => [
							msg("u1", { role: "user", content: "continue" }),
							msg("a1", { role: "assistant", content: "head" }),
						],
					},
				},
			) as Promise<void>;

			assert.equal(statusUpdates[0], "slipstream: manual");
			assert.equal(state.pending, null);
			await startPromise;
			const recovered = state.pending as { summary: string } | null;
			assert.ok(recovered);
			assert.equal(recovered.summary, "## Goal\nRecovered after yield");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("session_start leaves the compact widget hidden and session_shutdown clears it", async () => {
		const state = createRuntimeState();
		const widgetUpdates: Array<{
			key: string;
			lines: string[] | undefined;
			placement?: string;
		}> = [];
		const handlers: Partial<
			Record<
				"session_start" | "session_shutdown",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_start" || event === "session_shutdown") {
					handlers[event] = handler;
				}
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.session_start?.(
			{ reason: "startup" },
			{
				hasUI: true,
				model: { provider: "openai", id: "gpt-5.5" },
				ui: {
					setStatus: () => undefined,
					setWidget: (
						key: string,
						lines: string[] | undefined,
						options?: { placement?: string },
					) => {
						widgetUpdates.push({ key, lines, placement: options?.placement });
					},
				},
				sessionManager: {
					getSessionId: () => "s-hidden",
					getBranch: () => [],
				},
				cwd: "/repo",
			},
		);
		await handlers.session_shutdown?.(
			{ reason: "quit" },
			{
				hasUI: true,
				ui: {
					setWidget: (
						key: string,
						lines: string[] | undefined,
						options?: { placement?: string },
					) => {
						widgetUpdates.push({ key, lines, placement: options?.placement });
					},
				},
			},
		);

		assert.deepEqual(widgetUpdates, [
			{ key: "slipstream", lines: undefined, placement: undefined },
			{ key: "slipstream", lines: undefined, placement: undefined },
			{ key: "slipstream", lines: undefined, placement: undefined },
		]);
	});

	it("session_shutdown cancels active progress owner and timer", async () => {
		const state = createRuntimeState();
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready", stopReason: "stop" }),
		];
		const widgetUpdates: Array<string[] | undefined> = [];
		let releaseAutoSummary!: (summary: string) => void;
		const autoSummaryPromise = new Promise<string>((resolve) => {
			releaseAutoSummary = resolve;
		});
		const handlers: Partial<
			Record<
				"turn_end" | "session_shutdown",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end" || event === "session_shutdown")
					handlers[event] = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			startAutoJob: async (input) => {
				input.onProgress?.({
					phase: "summary",
					message: "Starting auto candidate summary",
				});
				const job: AutoJob = {
					artifactRoot: input.artifactRoot,
					sessionId: input.sessionId,
					cwd: input.cwd,
					projectId: input.cwd,
					snapshot: {
						sessionId: input.sessionId,
						cwd: input.cwd,
						triggerEntryId: "a1",
						firstKeptEntryId: "u1",
						tokensBefore: 100,
						summaryInputMessages: [],
						keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "u1" },
						manifest: {
							filesRead: [],
							filesModified: [],
							filesDeleted: [],
							errors: [],
							userDecisions: [],
							constraints: [],
							openLoops: [],
							recentVerification: [],
							latestUpdates: [],
							retainedTailUpdates: [],
							latestExchangeState: [],
							terminalFinalAnswerEvidence: [],
							latestSignals: [],
							staleSignals: [],
							userAssertionTrail: [],
							criticalLiterals: [],
							previousSummary: null,
							artifactRefs: [],
							knownFileRefs: new Set<string>(),
						},
					},
					firstKeptEntryId: "u1",
					tokensBefore: 100,
					artifactDir: "/tmp/slipstream-auto-progress-shutdown",
					summaryArtifactRefs: [],
					continuation: {
						appendTurn: () => undefined,
						isReady: () => false,
						snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
					},
					summaryPromise: autoSummaryPromise,
					stats: autoJobStats(),
					finalizing: false,
				};
				input.state.autoJob = job;
				input.state.activePromise = autoSummaryPromise;
				input.state.compactionWanted = false;
				input.state.status = "awaiting_continuation";
				return job;
			},
		});
		const ctx = {
			cwd: "/repo",
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
			},
			ui: {
				setStatus: () => undefined,
				setWidget: (_key: string, lines: string[] | undefined) => {
					widgetUpdates.push(lines);
				},
				notify: () => undefined,
			},
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 600, contextWindow: 1000 }),
			isIdle: () => true,
			hasPendingMessages: () => false,
		};

		try {
			await handlers.turn_end?.(
				{
					turnIndex: 1,
					message: { role: "assistant", content: "ready", stopReason: "stop" },
					toolResults: [],
				},
				ctx,
			);
			await waitUntil(
				() => state.progressOwner !== null,
				"active progress owner",
			);
			await handlers.session_shutdown?.({ reason: "quit" }, ctx);
			assert.equal(state.progressOwner, null);
			const updatesAfterShutdown = widgetUpdates.length;
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.equal(widgetUpdates.length, updatesAfterShutdown);
			assert.equal(widgetUpdates.at(-1), undefined);
		} finally {
			releaseAutoSummary("## Goal\nAuto summary complete");
		}
	});

	it("session_compact cancels active progress owner and timer", async () => {
		const state = createRuntimeState();
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready", stopReason: "stop" }),
		];
		const widgetUpdates: Array<string[] | undefined> = [];
		let releaseAutoSummary!: (summary: string) => void;
		const autoSummaryPromise = new Promise<string>((resolve) => {
			releaseAutoSummary = resolve;
		});
		const handlers: Partial<
			Record<
				"turn_end" | "session_compact",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end" || event === "session_compact")
					handlers[event] = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			startAutoJob: async (input) => {
				input.onProgress?.({
					phase: "summary",
					message: "Starting auto candidate summary",
				});
				const job: AutoJob = {
					artifactRoot: input.artifactRoot,
					sessionId: input.sessionId,
					cwd: input.cwd,
					projectId: input.cwd,
					snapshot: {
						sessionId: input.sessionId,
						cwd: input.cwd,
						triggerEntryId: "a1",
						firstKeptEntryId: "u1",
						tokensBefore: 100,
						summaryInputMessages: [],
						keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "u1" },
						manifest: {
							filesRead: [],
							filesModified: [],
							filesDeleted: [],
							errors: [],
							userDecisions: [],
							constraints: [],
							openLoops: [],
							recentVerification: [],
							latestUpdates: [],
							retainedTailUpdates: [],
							latestExchangeState: [],
							terminalFinalAnswerEvidence: [],
							latestSignals: [],
							staleSignals: [],
							userAssertionTrail: [],
							criticalLiterals: [],
							previousSummary: null,
							artifactRefs: [],
							knownFileRefs: new Set<string>(),
						},
					},
					firstKeptEntryId: "u1",
					tokensBefore: 100,
					artifactDir: "/tmp/slipstream-auto-progress-compact",
					summaryArtifactRefs: [],
					continuation: {
						appendTurn: () => undefined,
						isReady: () => false,
						snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
					},
					summaryPromise: autoSummaryPromise,
					stats: autoJobStats(),
					finalizing: false,
				};
				input.state.autoJob = job;
				input.state.activePromise = autoSummaryPromise;
				input.state.compactionWanted = false;
				input.state.status = "awaiting_continuation";
				return job;
			},
		});
		const ctx = {
			cwd: "/repo",
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
			},
			ui: {
				setStatus: () => undefined,
				setWidget: (_key: string, lines: string[] | undefined) => {
					widgetUpdates.push(lines);
				},
				notify: () => undefined,
			},
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 600, contextWindow: 1000 }),
			isIdle: () => true,
			hasPendingMessages: () => false,
		};

		try {
			await handlers.turn_end?.(
				{
					turnIndex: 1,
					message: { role: "assistant", content: "ready", stopReason: "stop" },
					toolResults: [],
				},
				ctx,
			);
			await waitUntil(
				() => state.progressOwner !== null,
				"active progress owner",
			);
			await handlers.session_compact?.({ firstKeptEntryId: "u1" }, ctx);
			assert.equal(state.progressOwner, null);
			const updatesAfterCompact = widgetUpdates.length;
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			assert.equal(widgetUpdates.length, updatesAfterCompact);
			assert.equal(widgetUpdates.at(-1), undefined);
		} finally {
			releaseAutoSummary("## Goal\nAuto summary complete");
		}
	});

	it("session_compact clears ready widget even when status restore is stale", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "validated",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: Date.now() + 10_000,
		});
		const widgetUpdates: Array<string[] | undefined> = [];
		const handlers: Partial<
			Record<
				"session_compact",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_compact") handlers.session_compact = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.session_compact?.(
			{},
			{
				cwd: "/repo",
				ui: {
					setStatus: () => {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					},
					setWidget: (_key: string, lines: string[] | undefined) => {
						widgetUpdates.push(lines);
					},
				},
				sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
			},
		);

		assert.equal(state.status, "idle");
		assert.equal(state.pending, null);
		assert.deepEqual(widgetUpdates.at(-1), undefined);
	});

	it("session_start ignores stale context while initializing status", async () => {
		const state = createRuntimeState();
		const handlers: Partial<
			Record<
				"session_start",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_start") handlers.session_start = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.session_start?.(
			{},
			{
				cwd: "/repo",
				ui: {
					setStatus: () => {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					},
					setWidget: () => undefined,
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => [],
				},
			},
		);

		assert.equal(state.status, "idle");
		assert.equal(state.pending, null);
	});

	it("session_start recovers a current pending artifact and shows ready", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "startup-pending-"));
		try {
			const state = createRuntimeState();
			const sessionId = "s-startup-pending";
			const cwd = process.cwd();
			const run = await new ArtifactStore({ root }).createRun({
				sessionId,
				triggerEntryId: "a1",
				cwd,
			});
			const runDir = run.dir;
			await writeFile(
				join(runDir, "pending.json"),
				`${JSON.stringify({
					sessionId,
					cwd,
					projectId: cwd,
					summary: "validated",
					firstKeptEntryId: "a1",
					validatedThroughEntryId: "a1",
					tokensBefore: 100,
					details: {
						judge: {
							score: 8,
							decision: "accept",
							diagnosis: "ok",
							missing: [],
							contradictions: [],
						},
						artifacts: [runDir],
					},
					expiresAt: Date.now() + 10_000,
				})}\n`,
			);
			const widgetUpdates: Array<string[] | undefined> = [];
			const handlers: Partial<
				Record<
					"session_start",
					(event: unknown, ctx: unknown) => Promise<void> | void
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<void> | void,
				) => {
					if (event === "session_start") handlers.session_start = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			registerLifecycle(pi, { ...config(), artifactRoot: root }, state);

			await handlers.session_start?.(
				{ reason: "startup" },
				{
					hasUI: true,
					cwd,
					ui: {
						setStatus: () => undefined,
						setWidget: (_key: string, lines: string[] | undefined) => {
							widgetUpdates.push(lines);
						},
					},
					sessionManager: {
						getSessionId: () => sessionId,
						getBranch: () => [
							msg("u1", { role: "user", content: "continue" }),
							msg("a1", { role: "assistant", content: "ready" }),
						],
					},
				},
			);

			assert.equal(state.pending?.summary, "validated");
			assert.deepEqual(widgetUpdates.at(-1), [
				"Slipstream: ready · score 8/10",
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("session_start does not show stale recovered pending artifacts", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "startup-stale-pending-"));
		try {
			const state = createRuntimeState();
			const sessionId = "s-startup-stale-pending";
			const cwd = process.cwd();
			const runDir = join(root, `${sessionId}-run`);
			await mkdir(runDir, { recursive: true });
			await writeFile(
				join(runDir, "run.json"),
				`${JSON.stringify({ id: "run", sessionId, triggerEntryId: "a0", cwd })}\n`,
			);
			await writeFile(
				join(runDir, "pending.json"),
				`${JSON.stringify({
					sessionId,
					cwd,
					projectId: cwd,
					summary: "stale",
					firstKeptEntryId: "a0",
					validatedThroughEntryId: "a0",
					tokensBefore: 100,
					details: {
						judge: {
							score: 8,
							decision: "accept",
							diagnosis: "ok",
							missing: [],
							contradictions: [],
						},
						artifacts: [runDir],
					},
					expiresAt: Date.now() + 10_000,
				})}\n`,
			);
			const widgetUpdates: Array<string[] | undefined> = [];
			const handlers: Partial<
				Record<
					"session_start",
					(event: unknown, ctx: unknown) => Promise<void> | void
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<void> | void,
				) => {
					if (event === "session_start") handlers.session_start = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			registerLifecycle(
				pi,
				{ ...config(), artifactRoot: root, retainArtifacts: false },
				state,
			);

			await handlers.session_start?.(
				{ reason: "startup" },
				{
					hasUI: true,
					cwd,
					ui: {
						setStatus: () => undefined,
						setWidget: (_key: string, lines: string[] | undefined) => {
							widgetUpdates.push(lines);
						},
					},
					sessionManager: {
						getSessionId: () => sessionId,
						getBranch: () => [
							msg("u1", { role: "user", content: "continue" }),
							msg("a1", { role: "assistant", content: "ready" }),
						],
					},
				},
			);

			assert.equal(state.pending, null);
			assert.equal(widgetUpdates.at(-1), undefined);
			await access(join(runDir, "pending.json"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("session_before_compact shows multi-phase compact progress and restores status", async () => {
		const state = createRuntimeState();
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		const statusUpdates: Array<string | undefined> = [];
		const notifications: string[] = [];
		const handlers: Partial<
			Record<
				"session_before_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "session_before_compact") {
					handlers.session_before_compact = handler;
				}
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			buildDefaultSlipstreamCompaction: async (
				_event,
				_ctx,
				_config,
				_state,
				onProgress,
			) => {
				onProgress({
					phase: "snapshot",
					message: "Building deterministic snapshot",
				});
				onProgress({
					phase: "summary",
					message: "Generating candidate summary",
				});
				onProgress({ phase: "judging", message: "Judging candidate summary" });
				onProgress({
					phase: "accepted",
					message: "Accepted summary with score 9",
				});
				return {
					compaction: {
						summary: "## Goal\nReady summary",
						firstKeptEntryId: "a1",
						tokensBefore: 100,
						details: { judge: { score: 9 }, artifacts: [] },
					},
				};
			},
		});

		const result = await handlers.session_before_compact?.(
			{
				preparation: { firstKeptEntryId: "native-boundary", tokensBefore: 100 },
				branchEntries: branch,
			},
			{
				cwd: "/repo",
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						statusUpdates.push(text);
					},
					notify: (message: string) => notifications.push(message),
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
			},
		);

		assert.deepEqual(result, {
			compaction: {
				summary: "## Goal\nReady summary",
				firstKeptEntryId: "a1",
				tokensBefore: 100,
				details: { judge: { score: 9 }, artifacts: [] },
			},
		});
		assert.match(statusUpdates.join("\n"), /compact 1\/5 snapshot/);
		assert.match(statusUpdates.join("\n"), /compact 4\/5 summary/);
		assert.match(statusUpdates.join("\n"), /compact 5\/5 judge/);
		assert.equal(notifications.join("\n"), "");
		assert.equal(statusUpdates.at(-1), "slipstream: manual");
	});

	it("session_before_compact does not tick footer status during a long progress phase", async () => {
		const state = createRuntimeState();
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		const statusUpdates: Array<string | undefined> = [];
		const widgetUpdates: Array<string[] | undefined> = [];
		const handlers: Partial<
			Record<
				"session_before_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "session_before_compact") {
					handlers.session_before_compact = handler;
				}
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			buildDefaultSlipstreamCompaction: async (
				_event,
				_ctx,
				_config,
				_state,
				onProgress,
			) => {
				onProgress({
					phase: "summary",
					message: "Generating candidate summary",
				});
				await new Promise((resolve) => setTimeout(resolve, 1_100));
				onProgress({
					phase: "accepted",
					message: "Accepted summary with score 9",
				});
				return {
					compaction: {
						summary: "## Goal\nReady summary",
						firstKeptEntryId: "a1",
						tokensBefore: 100,
						details: { judge: { score: 9 }, artifacts: [] },
					},
				};
			},
		});

		await handlers.session_before_compact?.(
			{
				preparation: { firstKeptEntryId: "native-boundary", tokensBefore: 100 },
				branchEntries: branch,
			},
			{
				cwd: "/repo",
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						statusUpdates.push(text);
					},
					setWidget: (_key: string, lines: string[] | undefined) => {
						widgetUpdates.push(lines);
					},
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
			},
		);

		assert.equal(
			statusUpdates.filter((text) => text?.includes("compact 4/5 summary"))
				.length,
			1,
		);
		assert.ok(
			widgetUpdates.filter((lines) => lines?.join("\n").includes("summarizing"))
				.length >= 2,
		);
		assert.equal(statusUpdates.at(-1), "slipstream: manual");
	});

	it("stale auto progress does not overwrite newer compact progress", async () => {
		const state = createRuntimeState();
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready", stopReason: "stop" }),
		];
		const widgetUpdates: Array<string[] | undefined> = [];
		let releaseAutoSummary!: (summary: string) => void;
		const autoSummaryPromise = new Promise<string>((resolve) => {
			releaseAutoSummary = resolve;
		});
		const handlers: Partial<
			Record<
				"turn_end" | "session_before_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "turn_end" || event === "session_before_compact") {
					handlers[event] = handler;
				}
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			startAutoJob: async (input) => {
				input.onProgress?.({
					phase: "summary",
					message: "Starting auto candidate summary",
				});
				const job: AutoJob = {
					artifactRoot: input.artifactRoot,
					sessionId: input.sessionId,
					cwd: input.cwd,
					projectId: input.cwd,
					snapshot: {
						sessionId: input.sessionId,
						cwd: input.cwd,
						triggerEntryId: "a1",
						firstKeptEntryId: "u1",
						tokensBefore: 100,
						summaryInputMessages: [],
						keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "u1" },
						manifest: {
							filesRead: [],
							filesModified: [],
							filesDeleted: [],
							errors: [],
							userDecisions: [],
							constraints: [],
							openLoops: [],
							recentVerification: [],
							latestUpdates: [],
							retainedTailUpdates: [],
							latestExchangeState: [],
							terminalFinalAnswerEvidence: [],
							latestSignals: [],
							staleSignals: [],
							userAssertionTrail: [],
							criticalLiterals: [],
							previousSummary: null,
							artifactRefs: [],
							knownFileRefs: new Set<string>(),
						},
					},
					firstKeptEntryId: "u1",
					tokensBefore: 100,
					artifactDir: "/tmp/slipstream-auto-progress-race",
					summaryArtifactRefs: [],
					continuation: {
						appendTurn: () => undefined,
						isReady: () => false,
						snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
					},
					summaryPromise: autoSummaryPromise,
					stats: autoJobStats(),
					finalizing: false,
				};
				input.state.autoJob = job;
				input.state.activePromise = autoSummaryPromise;
				input.state.compactionWanted = false;
				input.state.status = "awaiting_continuation";
				return job;
			},
			buildDefaultSlipstreamCompaction: async (
				_event,
				_ctx,
				_config,
				_state,
				onProgress,
			) => {
				onProgress({ phase: "repairing", message: "Repair attempt 1/1" });
				await new Promise((resolve) => setTimeout(resolve, 1_600));
				return {
					compaction: {
						summary: "## Goal\nReady summary",
						firstKeptEntryId: "a1",
						tokensBefore: 100,
						details: { judge: { score: 9 }, artifacts: [] },
					},
				};
			},
		});
		const ctx = {
			cwd: "/repo",
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
			},
			ui: {
				setStatus: () => undefined,
				setWidget: (_key: string, lines: string[] | undefined) => {
					widgetUpdates.push(lines);
				},
				notify: () => undefined,
			},
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 600, contextWindow: 1000 }),
			isIdle: () => true,
			hasPendingMessages: () => false,
		};

		try {
			await handlers.turn_end?.(
				{
					turnIndex: 1,
					message: { role: "assistant", content: "ready", stopReason: "stop" },
					toolResults: [],
				},
				ctx,
			);
			await waitUntil(
				() =>
					widgetUpdates.some((lines) =>
						lines?.join("\n").includes("summarizing"),
					),
				"initial auto summary progress",
			);
			const beforeCompact = widgetUpdates.length;
			await handlers.session_before_compact?.(
				{
					preparation: {
						firstKeptEntryId: "native-boundary",
						tokensBefore: 100,
					},
					branchEntries: branch,
				},
				ctx,
			);
			const compactUpdates = widgetUpdates.slice(beforeCompact);
			const firstRepairIndex = compactUpdates.findIndex((lines) =>
				lines?.join("\n").includes("repairing summary"),
			);
			assert.notEqual(firstRepairIndex, -1);
			assert.equal(
				compactUpdates
					.slice(firstRepairIndex)
					.some((lines) => lines?.join("\n").includes("summarizing")),
				false,
			);
		} finally {
			releaseAutoSummary("## Goal\nAuto summary complete");
		}
	});

	it("session_before_compact yields after initial status before default work", async () => {
		const state = createRuntimeState();
		const branch = [msg("a1", { role: "assistant", content: "ready" })];
		let defaultStarted = false;
		const statusUpdates: Array<string | undefined> = [];
		const handlers: Partial<
			Record<
				"session_before_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "session_before_compact") {
					handlers.session_before_compact = handler;
				}
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			buildDefaultSlipstreamCompaction: async () => {
				defaultStarted = true;
				return { cancel: true };
			},
		});

		const resultPromise = handlers.session_before_compact?.(
			{
				preparation: { firstKeptEntryId: "native-boundary", tokensBefore: 100 },
				branchEntries: branch,
			},
			{
				cwd: "/repo",
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						statusUpdates.push(text);
					},
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
			},
		) as Promise<unknown>;

		assert.equal(statusUpdates[0], "slipstream: /compact starting");
		assert.equal(defaultStarted, false);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(defaultStarted, true);
		assert.deepEqual(await resultPromise, { cancel: true });
	});

	it("auto start restores status when the branch is too short to summarize", async () => {
		const state = createRuntimeState();
		const statusUpdates: Array<string | undefined> = [];
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, { ...config(), triggerContextPercent: 0.001 }, state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "short", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						statusUpdates.push(text);
					},
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => [msg("a1", { role: "assistant", content: "short" })],
				},
				getContextUsage: () => ({ tokens: 600, contextWindow: 1000 }),
			},
		);

		await waitUntil(
			() => statusUpdates.join("\n").includes("auto 1/5 snapshot"),
			"auto start snapshot status",
		);
		await waitUntil(
			() => statusUpdates.at(-1) === "slipstream: manual",
			"auto start status restore",
		);
		assert.equal(state.compactionWanted, false);
	});

	it("auto start completion finalizes and adopts while idle without another turn", async () => {
		const state = createRuntimeState();
		let finalizeCalls = 0;
		let compactCalls = 0;
		let capturedAllowIncomplete: boolean | undefined;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		const branch = [
			msg("u1", { role: "user", content: "continue" }),
			msg("a1", { role: "assistant", content: "done", stopReason: "stop" }),
		];

		registerLifecycle(
			pi,
			{ ...config(), triggerContextPercent: 0.001 },
			state,
			{
				startAutoJob: async (input) => {
					const summaryPromise = Promise.resolve("## Goal\nIdle auto summary");
					const job: AutoJob = {
						artifactRoot: input.artifactRoot,
						sessionId: input.sessionId,
						cwd: input.cwd,
						projectId: input.cwd,
						snapshot: {
							sessionId: input.sessionId,
							cwd: input.cwd,
							triggerEntryId: "a1",
							firstKeptEntryId: "u1",
							tokensBefore: 100,
							summaryInputMessages: [],
							keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "u1" },
							manifest: {
								filesRead: [],
								filesModified: [],
								filesDeleted: [],
								errors: [],
								userDecisions: [],
								constraints: [],
								openLoops: [],
								recentVerification: [],
								latestUpdates: [],
								retainedTailUpdates: [],
								latestExchangeState: [],
								terminalFinalAnswerEvidence: [],
								latestSignals: [],
								staleSignals: [],
								userAssertionTrail: [],
								criticalLiterals: [],
								previousSummary: null,
								artifactRefs: [],
								knownFileRefs: new Set<string>(),
							},
						},
						firstKeptEntryId: "u1",
						tokensBefore: 100,
						artifactDir: "/tmp/slipstream-idle-auto",
						summaryArtifactRefs: [],
						continuation: {
							appendTurn: () => undefined,
							isReady: () => false,
							snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
						},
						summaryPromise,
						stats: autoJobStats(),
						finalizing: false,
					};
					input.state.autoJob = job;
					input.state.activePromise = summaryPromise;
					input.state.compactionWanted = false;
					input.state.status = "awaiting_continuation";
					return job;
				},
				finalizeAutoJob: async (input) => {
					finalizeCalls += 1;
					capturedAllowIncomplete = input.allowIncompleteContinuation;
					storePendingValidated(input.state, {
						sessionId: "s1",
						cwd: "/repo",
						projectId: "/repo",
						artifactDir: "/tmp/slipstream-pending",
						summary: "## Goal\nIdle auto accepted",
						firstKeptEntryId: "u1",
						validatedThroughEntryId: "a1",
						tokensBefore: 100,
						details: { judge: { score: 9 }, artifacts: [] },
						expiresAt: Date.now() + 10_000,
					});
					input.state.autoJob = null;
					return true;
				},
			},
		);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "done", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				ui: { setStatus: () => undefined, notify: () => undefined },
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 600, contextWindow: 1000 }),
				isIdle: () => true,
				hasPendingMessages: () => false,
				compact: () => {
					compactCalls += 1;
				},
			},
		);

		await waitUntil(() => finalizeCalls === 1, "idle auto finalization");
		await waitUntil(() => compactCalls === 1, "idle auto adoption");
		assert.equal(capturedAllowIncomplete, true);
	});

	it("auto start completion keeps retrying idle finalization after the first retry sees Pi busy", async () => {
		const state = createRuntimeState();
		let finalizeCalls = 0;
		let compactCalls = 0;
		let idle = false;
		let autoJobIdleChecks = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		const branch = [
			msg("u1", { role: "user", content: "continue" }),
			msg("a1", { role: "assistant", content: "done", stopReason: "stop" }),
		];

		registerLifecycle(
			pi,
			{ ...config(), triggerContextPercent: 0.001 },
			state,
			{
				startAutoJob: async (input) => {
					const summaryPromise = Promise.resolve("## Goal\nIdle auto summary");
					const job: AutoJob = {
						artifactRoot: input.artifactRoot,
						sessionId: input.sessionId,
						cwd: input.cwd,
						projectId: input.cwd,
						snapshot: {
							sessionId: input.sessionId,
							cwd: input.cwd,
							triggerEntryId: "a1",
							firstKeptEntryId: "u1",
							tokensBefore: 100,
							summaryInputMessages: [],
							keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "u1" },
							manifest: {
								filesRead: [],
								filesModified: [],
								filesDeleted: [],
								errors: [],
								userDecisions: [],
								constraints: [],
								openLoops: [],
								recentVerification: [],
								latestUpdates: [],
								retainedTailUpdates: [],
								latestExchangeState: [],
								terminalFinalAnswerEvidence: [],
								latestSignals: [],
								staleSignals: [],
								userAssertionTrail: [],
								criticalLiterals: [],
								previousSummary: null,
								artifactRefs: [],
								knownFileRefs: new Set<string>(),
							},
						},
						firstKeptEntryId: "u1",
						tokensBefore: 100,
						artifactDir: "/tmp/slipstream-idle-auto",
						summaryArtifactRefs: [],
						continuation: {
							appendTurn: () => undefined,
							isReady: () => false,
							snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
						},
						summaryPromise,
						stats: autoJobStats(),
						finalizing: false,
					};
					input.state.autoJob = job;
					input.state.activePromise = summaryPromise;
					input.state.compactionWanted = false;
					input.state.status = "awaiting_continuation";
					return job;
				},
				finalizeAutoJob: async (input) => {
					finalizeCalls += 1;
					storePendingValidated(input.state, {
						sessionId: "s1",
						cwd: "/repo",
						projectId: "/repo",
						artifactDir: "/tmp/slipstream-pending",
						summary: "## Goal\nIdle auto accepted",
						firstKeptEntryId: "u1",
						validatedThroughEntryId: "a1",
						tokensBefore: 100,
						details: { judge: { score: 9 }, artifacts: [] },
						expiresAt: Date.now() + 10_000,
					});
					input.state.autoJob = null;
					return true;
				},
			},
		);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "done", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				ui: { setStatus: () => undefined, notify: () => undefined },
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 600, contextWindow: 1000 }),
				isIdle: () => {
					if (state.autoJob) autoJobIdleChecks += 1;
					return idle;
				},
				hasPendingMessages: () => false,
				compact: () => {
					compactCalls += 1;
				},
			},
		);

		await waitUntil(
			() => autoJobIdleChecks === 1,
			"first busy auto idle check",
		);
		await waitUntil(() => finalizeCalls === 1, "busy auto finalization");
		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");
		idle = true;
		await waitUntil(() => compactCalls === 1, "busy-to-idle auto adoption");
	});

	it("idle auto finalization defers while pending messages exist", async () => {
		const state = createRuntimeState();
		let finalizeCalls = 0;
		let compactCalls = 0;
		let hasPendingMessages = true;
		let autoJobIdleChecks = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		const branch = [
			msg("u1", { role: "user", content: "continue" }),
			msg("a1", { role: "assistant", content: "done", stopReason: "stop" }),
		];

		registerLifecycle(
			pi,
			{ ...config(), triggerContextPercent: 0.001 },
			state,
			{
				startAutoJob: async (input) => {
					const summaryPromise = Promise.resolve("## Goal\nIdle auto summary");
					const job: AutoJob = {
						artifactRoot: input.artifactRoot,
						sessionId: input.sessionId,
						cwd: input.cwd,
						projectId: input.cwd,
						snapshot: {
							sessionId: input.sessionId,
							cwd: input.cwd,
							triggerEntryId: "a1",
							firstKeptEntryId: "u1",
							tokensBefore: 100,
							summaryInputMessages: [],
							keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "u1" },
							manifest: {
								filesRead: [],
								filesModified: [],
								filesDeleted: [],
								errors: [],
								userDecisions: [],
								constraints: [],
								openLoops: [],
								recentVerification: [],
								latestUpdates: [],
								retainedTailUpdates: [],
								latestExchangeState: [],
								terminalFinalAnswerEvidence: [],
								latestSignals: [],
								staleSignals: [],
								userAssertionTrail: [],
								criticalLiterals: [],
								previousSummary: null,
								artifactRefs: [],
								knownFileRefs: new Set<string>(),
							},
						},
						firstKeptEntryId: "u1",
						tokensBefore: 100,
						artifactDir: "/tmp/slipstream-idle-auto",
						summaryArtifactRefs: [],
						continuation: {
							appendTurn: () => undefined,
							isReady: () => false,
							snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
						},
						summaryPromise,
						stats: autoJobStats(),
						finalizing: false,
					};
					input.state.autoJob = job;
					input.state.activePromise = summaryPromise;
					input.state.compactionWanted = false;
					input.state.status = "awaiting_continuation";
					return job;
				},
				finalizeAutoJob: async (input) => {
					finalizeCalls += 1;
					storePendingValidated(input.state, {
						sessionId: "s1",
						cwd: "/repo",
						projectId: "/repo",
						artifactDir: "/tmp/slipstream-pending",
						summary: "## Goal\nIdle auto accepted",
						firstKeptEntryId: "u1",
						validatedThroughEntryId: "a1",
						tokensBefore: 100,
						details: { judge: { score: 9 }, artifacts: [] },
						expiresAt: Date.now() + 10_000,
					});
					input.state.autoJob = null;
					return true;
				},
			},
		);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "done", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				ui: { setStatus: () => undefined, notify: () => undefined },
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 600, contextWindow: 1000 }),
				isIdle: () => {
					if (state.autoJob) autoJobIdleChecks += 1;
					return true;
				},
				hasPendingMessages: () => hasPendingMessages,
				compact: () => {
					compactCalls += 1;
				},
			},
		);

		await waitUntil(
			() => autoJobIdleChecks === 1,
			"first pending-message auto readiness check",
		);
		await waitUntil(
			() => finalizeCalls === 1,
			"pending-message auto finalization",
		);
		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");
		hasPendingMessages = false;
		await waitUntil(
			() => compactCalls === 1,
			"pending-message-cleared auto adoption",
		);
	});

	for (const drift of ["session", "cwd"] as const) {
		it(`idle auto finalization aborts after ${drift} drift`, async () => {
			const state = createRuntimeState();
			let releaseSummary!: (summary: string) => void;
			const summaryPromise = new Promise<string>((resolve) => {
				releaseSummary = resolve;
			});
			let finalizeCalls = 0;
			let sessionId = "s1";
			let cwd = "/repo";
			const handlers: Partial<
				Record<
					"turn_end",
					(event: unknown, ctx: unknown) => Promise<void> | void
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<void> | void,
				) => {
					if (event === "turn_end") handlers.turn_end = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			const branch = [
				msg("u1", { role: "user", content: "continue" }),
				msg("a1", { role: "assistant", content: "done", stopReason: "stop" }),
			];

			registerLifecycle(
				pi,
				{ ...config(), triggerContextPercent: 0.001 },
				state,
				{
					startAutoJob: async (input) => {
						const job: AutoJob = {
							artifactRoot: input.artifactRoot,
							sessionId: input.sessionId,
							cwd: input.cwd,
							projectId: input.cwd,
							snapshot: {
								sessionId: input.sessionId,
								cwd: input.cwd,
								triggerEntryId: "a1",
								firstKeptEntryId: "u1",
								tokensBefore: 100,
								summaryInputMessages: [],
								keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "u1" },
								manifest: {
									filesRead: [],
									filesModified: [],
									filesDeleted: [],
									errors: [],
									userDecisions: [],
									constraints: [],
									openLoops: [],
									recentVerification: [],
									latestUpdates: [],
									retainedTailUpdates: [],
									latestExchangeState: [],
									terminalFinalAnswerEvidence: [],
									latestSignals: [],
									staleSignals: [],
									userAssertionTrail: [],
									criticalLiterals: [],
									previousSummary: null,
									artifactRefs: [],
									knownFileRefs: new Set<string>(),
								},
							},
							firstKeptEntryId: "u1",
							tokensBefore: 100,
							artifactDir: "/tmp/slipstream-idle-auto",
							summaryArtifactRefs: [],
							continuation: {
								appendTurn: () => undefined,
								isReady: () => false,
								snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
							},
							summaryPromise,
							stats: autoJobStats(),
							finalizing: false,
						};
						input.state.autoJob = job;
						input.state.activePromise = summaryPromise;
						input.state.compactionWanted = false;
						input.state.status = "awaiting_continuation";
						return job;
					},
					finalizeAutoJob: async () => {
						finalizeCalls += 1;
						return true;
					},
				},
			);

			await handlers.turn_end?.(
				{
					turnIndex: 1,
					message: { role: "assistant", content: "done", stopReason: "stop" },
					toolResults: [],
				},
				{
					get cwd() {
						return cwd;
					},
					model: { provider: "test", id: "model" },
					modelRegistry: {
						find: () => ({ provider: "test", id: "model" }),
						getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
					},
					ui: { setStatus: () => undefined, notify: () => undefined },
					sessionManager: {
						getSessionId: () => sessionId,
						getBranch: () => branch,
					},
					getContextUsage: () => ({ tokens: 600, contextWindow: 1000 }),
					isIdle: () => true,
					hasPendingMessages: () => false,
				},
			);

			if (drift === "session") sessionId = "s2";
			else cwd = "/other";
			releaseSummary("## Goal\nSummary resolved after drift");
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(finalizeCalls, 0);
			assert.equal(state.autoJob, null);
			assert.equal(state.status, "idle");
		});
	}

	it("idle auto finalization revalidates a stale incomplete pending summary before adopting", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const artifactDir = await mkdtemp(
			join(parent, "slipstream-idle-revalidate-"),
		);
		try {
			const cwd = process.cwd();
			const state = createRuntimeState();
			let branch = [
				msg("u1", { role: "user", content: "old request" }),
				msg("a1", {
					role: "assistant",
					content: "old answer",
					stopReason: "stop",
				}),
			];
			const advancedBranch = [
				...branch,
				msg("u2", { role: "user", content: "new work" }),
				msg("a2", {
					role: "assistant",
					content: "new answer",
					stopReason: "stop",
				}),
			];
			let releaseSummary!: (summary: string) => void;
			const summaryPromise = new Promise<string>((resolve) => {
				releaseSummary = resolve;
			});
			let startCalls = 0;
			let finalizeCalls = 0;
			let revalidationCalls = 0;
			let compactCalls = 0;
			const handlers: Partial<
				Record<
					"turn_end",
					(event: unknown, ctx: unknown) => Promise<void> | void
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<void> | void,
				) => {
					if (event === "turn_end") handlers.turn_end = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			registerLifecycle(
				pi,
				{
					...config(),
					triggerContextPercent: 0.001,
					artifactRoot: artifactDir,
				},
				state,
				{
					startAutoJob: async (input) => {
						startCalls += 1;
						const job: AutoJob = {
							artifactRoot: input.artifactRoot,
							sessionId: input.sessionId,
							cwd: input.cwd,
							projectId: input.cwd,
							snapshot: {
								sessionId: input.sessionId,
								cwd: input.cwd,
								triggerEntryId: "a1",
								firstKeptEntryId: "u1",
								tokensBefore: 100,
								summaryInputMessages: [],
								keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "u1" },
								manifest: {
									filesRead: [],
									filesModified: [],
									filesDeleted: [],
									errors: [],
									userDecisions: [],
									constraints: [],
									openLoops: [],
									recentVerification: [],
									latestUpdates: [],
									retainedTailUpdates: [],
									latestExchangeState: [],
									terminalFinalAnswerEvidence: [],
									latestSignals: [],
									staleSignals: [],
									userAssertionTrail: [],
									criticalLiterals: [],
									previousSummary: null,
									artifactRefs: [],
									knownFileRefs: new Set<string>(),
								},
							},
							firstKeptEntryId: "u1",
							tokensBefore: 100,
							artifactDir,
							summaryArtifactRefs: [],
							continuation: {
								appendTurn: () => undefined,
								isReady: () => false,
								snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
							},
							summaryPromise,
							stats: autoJobStats(),
							finalizing: false,
						};
						input.state.autoJob = job;
						input.state.activePromise = summaryPromise;
						input.state.compactionWanted = false;
						input.state.status = "awaiting_continuation";
						return job;
					},
					finalizeAutoJob: async (input) => {
						finalizeCalls += 1;
						assert.equal(input.allowIncompleteContinuation, true);
						storePendingValidated(input.state, {
							sessionId: "s1",
							cwd,
							projectId: cwd,
							artifactDir: "/tmp/slipstream-pending",
							summary: "## Goal\nNeeds idle revalidation",
							firstKeptEntryId: "u1",
							validatedThroughEntryId: "a1",
							tokensBefore: 100,
							details: {
								judge: { score: 9 },
								artifacts: [artifactDir],
								auto: true,
							},
							expiresAt: Date.now() + 10_000,
						});
						input.state.autoJob = null;
						return true;
					},
					runValidatedSlipstream: async (): Promise<ValidatedRunResult> => {
						revalidationCalls += 1;
						return {
							mode: "validated",
							accepted: true,
							repaired: false,
							artifactDir,
							summary: "## Goal\nIdle revalidated summary",
							judge: {
								score: 9,
								decision: "accept",
								missing: [],
								contradictions: [],
								diagnosis: "ok",
							},
							firstKeptEntryId: "u2",
							tokensBefore: 200,
						};
					},
				},
			);

			const ctx = {
				cwd,
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				ui: { setStatus: () => undefined, notify: () => undefined },
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 600, contextWindow: 1000 }),
				isIdle: () => true,
				hasPendingMessages: () => false,
				compact: () => {
					compactCalls += 1;
				},
			};

			await handlers.turn_end?.(
				{
					turnIndex: 1,
					message: {
						role: "assistant",
						content: "old answer",
						stopReason: "stop",
					},
					toolResults: [],
				},
				ctx,
			);
			await waitUntil(
				() => startCalls === 1,
				"auto start before idle revalidation",
			);
			branch = advancedBranch;
			releaseSummary("## Goal\nSummary resolved while idle");

			await waitUntil(() => finalizeCalls === 1, "idle stale finalization");
			await waitUntil(() => revalidationCalls === 1, "idle stale revalidation");
			await waitUntil(() => compactCalls === 1, "idle revalidated adoption");
			assert.equal(state.pending?.validatedThroughEntryId, "a2");
		} finally {
			await rm(artifactDir, { recursive: true, force: true });
		}
	});

	it("auto finalization shows progress and restores pending status", async () => {
		const state = createRuntimeState();
		state.autoJob = {
			artifactRoot: "/tmp",
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			snapshot: {
				sessionId: "s1",
				cwd: "/repo",
				triggerEntryId: "a1",
				firstKeptEntryId: "a1",
				tokensBefore: 100,
				summaryInputMessages: [],
				keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "a1" },
				manifest: {
					filesRead: [],
					filesModified: [],
					filesDeleted: [],
					errors: [],
					userDecisions: [],
					constraints: [],
					openLoops: [],
					recentVerification: [],
					latestUpdates: [],
					retainedTailUpdates: [],
					latestExchangeState: [],
					terminalFinalAnswerEvidence: [],
					latestSignals: [],
					staleSignals: [],
					userAssertionTrail: [],
					criticalLiterals: [],
					previousSummary: null,
					artifactRefs: [],
					knownFileRefs: new Set<string>(),
				},
			},
			firstKeptEntryId: "a1",
			tokensBefore: 100,
			artifactDir: "/tmp/slipstream-auto-progress",
			summaryArtifactRefs: [],
			continuation: {
				appendTurn: () => undefined,
				isReady: () => true,
				snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
			},
			summaryPromise: Promise.resolve("summary"),
			stats: autoJobStats(),
			finalizing: false,
		};
		const statusUpdates: Array<string | undefined> = [];
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			finalizeAutoJob: async (input: FinalizeAutoJobInput) => {
				input.onProgress?.({
					phase: "judging",
					message: "Judging auto candidate",
				});
				storePendingValidated(state, {
					sessionId: "s1",
					cwd: "/repo",
					projectId: "/repo",
					artifactDir: "/tmp/slipstream-pending",
					summary: "## Goal\nAuto",
					firstKeptEntryId: "a1",
					validatedThroughEntryId: "a2",
					tokensBefore: 100,
					details: { judge: { score: 9 }, artifacts: [] },
					expiresAt: Date.now() + 10_000,
				});
				input.state.autoJob = null;
				return true;
			},
		});

		await handlers.turn_end?.(
			{
				turnIndex: 2,
				message: { role: "assistant", content: "done", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						statusUpdates.push(text);
					},
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => [
						msg("u1", { role: "user", content: "continue" }),
						msg("a2", { role: "assistant", content: "done" }),
					],
				},
				getContextUsage: () => ({ tokens: 56, contextWindow: 100 }),
				isIdle: () => false,
				hasPendingMessages: () => false,
			},
		);
		await new Promise((resolve) => setImmediate(resolve));

		assert.match(statusUpdates.join("\n"), /auto 5\/5 judge/);
		assert.equal(statusUpdates.at(-1), "slipstream: pending");
	});

	it("auto finalization stops before storing pending state after compaction invalidates the job", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-auto-invalidated-"));
		try {
			const state = createRuntimeState();
			state.autoJob = {
				artifactRoot: "/tmp",
				sessionId: "s1",
				cwd: "/repo",
				projectId: "/repo",
				snapshot: {
					sessionId: "s1",
					cwd: "/repo",
					triggerEntryId: "a1",
					firstKeptEntryId: "a1",
					tokensBefore: 100,
					summaryInputMessages: [],
					keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "a1" },
					manifest: {
						filesRead: [],
						filesModified: [],
						filesDeleted: [],
						errors: [],
						userDecisions: [],
						constraints: [],
						openLoops: [],
						recentVerification: [],
						latestUpdates: [],
						retainedTailUpdates: [],
						latestExchangeState: [],
						terminalFinalAnswerEvidence: [],
						latestSignals: [],
						staleSignals: [],
						userAssertionTrail: [],
						criticalLiterals: [],
						previousSummary: null,
						artifactRefs: [],
						knownFileRefs: new Set<string>(),
					},
				},
				firstKeptEntryId: "a1",
				tokensBefore: 100,
				artifactDir: root,
				summaryArtifactRefs: [],
				continuation: {
					appendTurn: () => undefined,
					isReady: () => true,
					snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
				},
				summaryPromise: Promise.resolve("## Goal\nInitial auto summary"),
				stats: autoJobStats(),
				finalizing: false,
			};
			const progress: string[] = [];
			let judgeCalls = 0;

			const accepted = await finalizeAutoJob({
				state,
				config: { ...config(), repairAttempts: 1, judgeThreshold: 9 },
				completeSummary: async () => {
					state.autoJob = null;
					state.activePromise = null;
					state.status = "idle";
					return "## Goal\nRepaired after compaction";
				},
				completeJudge: async () => {
					judgeCalls += 1;
					return judgeCalls === 1
						? {
								score: 4,
								decision: "reject",
								missing: ["needs repair"],
								contradictions: [],
								diagnosis: "below threshold",
							}
						: {
								score: 9,
								decision: "accept",
								missing: [],
								contradictions: [],
								diagnosis: "fixed",
							};
				},
				now: () => 100,
				validatedThroughEntryId: "a1",
				onProgress: (event) => progress.push(event.phase),
			});

			assert.equal(accepted, false);
			assert.equal(state.status, "idle");
			assert.equal(state.pending, null);
			assert.deepEqual(progress, [
				"finalizing-summary",
				"judging",
				"repairing",
			]);
			assert.equal(judgeCalls, 1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("auto finalization ignores failures after compaction invalidates the job", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(
			join(parent, "slipstream-auto-invalidated-error-"),
		);
		try {
			const state = createRuntimeState();
			state.autoJob = {
				artifactRoot: "/tmp",
				sessionId: "s1",
				cwd: "/repo",
				projectId: "/repo",
				snapshot: {
					sessionId: "s1",
					cwd: "/repo",
					triggerEntryId: "a1",
					firstKeptEntryId: "a1",
					tokensBefore: 100,
					summaryInputMessages: [],
					keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "a1" },
					manifest: {
						filesRead: [],
						filesModified: [],
						filesDeleted: [],
						errors: [],
						userDecisions: [],
						constraints: [],
						openLoops: [],
						recentVerification: [],
						latestUpdates: [],
						retainedTailUpdates: [],
						latestExchangeState: [],
						terminalFinalAnswerEvidence: [],
						latestSignals: [],
						staleSignals: [],
						userAssertionTrail: [],
						criticalLiterals: [],
						previousSummary: null,
						artifactRefs: [],
						knownFileRefs: new Set<string>(),
					},
				},
				firstKeptEntryId: "a1",
				tokensBefore: 100,
				artifactDir: root,
				summaryArtifactRefs: [],
				continuation: {
					appendTurn: () => undefined,
					isReady: () => true,
					snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
				},
				summaryPromise: Promise.resolve("## Goal\nInitial auto summary"),
				stats: autoJobStats(),
				finalizing: false,
			};

			const accepted = await finalizeAutoJob({
				state,
				config: { ...config(), repairAttempts: 1, judgeThreshold: 9 },
				completeSummary: async () => {
					state.autoJob = null;
					state.activePromise = null;
					state.status = "idle";
					throw new Error("model call aborted after compaction");
				},
				completeJudge: async () => ({
					score: 4,
					decision: "reject",
					missing: ["needs repair"],
					contradictions: [],
					diagnosis: "below threshold",
				}),
				now: () => 100,
				validatedThroughEntryId: "a1",
			});

			assert.equal(accepted, false);
			assert.equal(state.status, "idle");
			assert.equal(state.pending, null);
			assert.equal(state.autoJob, null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("auto finalization stops if compaction invalidates during artifact writes", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(
			join(parent, "slipstream-auto-invalidated-write-"),
		);
		try {
			const state = createRuntimeState();
			state.autoJob = {
				artifactRoot: "/tmp",
				sessionId: "s1",
				cwd: "/repo",
				projectId: "/repo",
				snapshot: {
					sessionId: "s1",
					cwd: "/repo",
					triggerEntryId: "a1",
					firstKeptEntryId: "a1",
					tokensBefore: 100,
					summaryInputMessages: [],
					keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "a1" },
					manifest: {
						filesRead: [],
						filesModified: [],
						filesDeleted: [],
						errors: [],
						userDecisions: [],
						constraints: [],
						openLoops: [],
						recentVerification: [],
						latestUpdates: [],
						retainedTailUpdates: [],
						latestExchangeState: [],
						terminalFinalAnswerEvidence: [],
						latestSignals: [],
						staleSignals: [],
						userAssertionTrail: [],
						criticalLiterals: [],
						previousSummary: null,
						artifactRefs: [],
						knownFileRefs: new Set<string>(),
					},
				},
				firstKeptEntryId: "a1",
				tokensBefore: 100,
				artifactDir: root,
				summaryArtifactRefs: [],
				continuation: {
					appendTurn: () => undefined,
					isReady: () => true,
					snapshot: () => {
						state.autoJob = null;
						state.activePromise = null;
						state.status = "idle";
						return { triggerEntryId: "a1", turns: [] };
					},
				},
				summaryPromise: Promise.resolve("## Goal"),
				stats: autoJobStats(),
				finalizing: false,
			};

			const accepted = await finalizeAutoJob({
				state,
				config: { ...config(), repairAttempts: 1, judgeThreshold: 9 },
				completeSummary: async () => {
					throw new Error("invalidated empty candidate should not repair");
				},
				completeJudge: async () => {
					throw new Error("invalidated empty candidate should not judge");
				},
				now: () => 100,
				validatedThroughEntryId: "a1",
			});

			assert.equal(accepted, false);
			assert.equal(state.status, "idle");
			assert.equal(state.pending, null);
			assert.equal(state.autoJob, null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("session_before_compact regenerates default compaction instead of consuming stale pending state", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nStale summary",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 10_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "old answer" }),
			msg("u2", { role: "user", content: "newer correction" }),
		];
		let defaultCalls = 0;
		const handlers: Partial<
			Record<
				"session_before_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "session_before_compact") {
					handlers.session_before_compact = handler;
				}
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state, {
			buildDefaultSlipstreamCompaction: async () => {
				defaultCalls += 1;
				return {
					compaction: {
						summary: "## Goal\nRegenerated",
						firstKeptEntryId: "a1",
						tokensBefore: 200,
						details: { defaultReplacement: true },
					},
				};
			},
		});

		const result = await handlers.session_before_compact?.(
			{
				preparation: { firstKeptEntryId: "native-boundary", tokensBefore: 200 },
				branchEntries: branch,
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
			},
		);

		assert.equal(defaultCalls, 1);
		assert.equal(state.pending, null);
		assert.deepEqual(result, {
			compaction: {
				summary: "## Goal\nRegenerated",
				firstKeptEntryId: "a1",
				tokensBefore: 200,
				details: { defaultReplacement: true },
			},
		});
	});

	it("turn_end returns before stale pending revalidation completes", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nOld pending",
			firstKeptEntryId: "old-boundary",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "old answer" }),
			msg("u2", { role: "user", content: "new work" }),
			msg("a2", { role: "assistant", content: "new answer" }),
		];
		let compactCalls = 0;
		let revalidationStarted = false;
		const revalidatedArtifactDir = await mkdtemp(
			join(process.cwd(), ".scratch", "test-tmp", "revalidated-detached-"),
		);
		let releaseRevalidation!: (result: {
			mode: "validated";
			accepted: true;
			repaired: false;
			artifactDir: string;
			summary: string;
			judge: {
				score: number;
				decision: "accept";
				missing: string[];
				contradictions: string[];
				diagnosis: string;
			};
			firstKeptEntryId: string;
			tokensBefore: number;
		}) => void;
		const revalidation = new Promise<{
			mode: "validated";
			accepted: true;
			repaired: false;
			artifactDir: string;
			summary: string;
			judge: {
				score: number;
				decision: "accept";
				missing: string[];
				contradictions: string[];
				diagnosis: string;
			};
			firstKeptEntryId: string;
			tokensBefore: number;
		}>((resolve) => {
			releaseRevalidation = resolve;
		});
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			runValidatedSlipstream: async () => {
				revalidationStarted = true;
				return revalidation;
			},
		});

		let turnEndSettled = false;
		const turnEndPromise = Promise.resolve(
			handlers.turn_end?.(
				{
					turnIndex: 2,
					message: {
						role: "assistant",
						content: "new answer",
						stopReason: "stop",
					},
					toolResults: [],
				},
				{
					cwd: "/repo",
					model: { provider: "test", id: "model" },
					modelRegistry: {
						find: () => ({ provider: "test", id: "model" }),
						getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
					},
					sessionManager: {
						getSessionId: () => "s1",
						getBranch: () => branch,
					},
					getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
					compact: () => {
						compactCalls += 1;
					},
					isIdle: () => true,
					hasPendingMessages: () => false,
				},
			),
		).then(() => {
			turnEndSettled = true;
		});

		await waitUntil(
			() => revalidationStarted,
			"stale pending revalidation start",
		);
		assert.equal(turnEndSettled, true);
		releaseRevalidation({
			mode: "validated",
			accepted: true,
			repaired: false,
			artifactDir: revalidatedArtifactDir,
			summary: "## Goal\nRevalidated",
			judge: {
				score: 9,
				decision: "accept",
				missing: [],
				contradictions: [],
				diagnosis: "ok",
			},
			firstKeptEntryId: "new-boundary",
			tokensBefore: 200,
		});
		await turnEndPromise;
		await waitUntil(
			() => state.pending?.firstKeptEntryId === "new-boundary",
			"detached revalidation completion",
		);
		assert.equal(state.pending?.firstKeptEntryId, "new-boundary");
		assert.equal(compactCalls, 1);
	});

	it("revalidates stale pending while busy but defers actual compaction until idle", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nOld pending",
			firstKeptEntryId: "old-boundary",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "old answer" }),
			msg("u2", { role: "user", content: "new work" }),
			msg("a2", { role: "assistant", content: "new answer" }),
		];
		let compactCalls = 0;
		let revalidationCalls = 0;
		let idle = false;
		const revalidatedArtifactDir = await mkdtemp(
			join(process.cwd(), ".scratch", "test-tmp", "revalidated-busy-"),
		);
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			runValidatedSlipstream: async (): Promise<ValidatedRunResult> => {
				revalidationCalls += 1;
				return {
					mode: "validated",
					accepted: true,
					repaired: false,
					artifactDir: revalidatedArtifactDir,
					summary: "## Goal\nRevalidated while busy",
					judge: {
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "ok",
					},
					firstKeptEntryId: "new-boundary",
					tokensBefore: 200,
				};
			},
		});

		await handlers.turn_end?.(
			{
				turnIndex: 2,
				message: {
					role: "assistant",
					content: "new answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => idle,
				hasPendingMessages: () => false,
			},
		);
		await waitUntil(() => revalidationCalls === 1, "busy stale revalidation");
		await waitUntil(
			() => state.pending?.firstKeptEntryId === "new-boundary",
			"busy stale revalidation completion",
		);
		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");

		idle = true;
		await waitUntil(
			() => compactCalls === 1,
			"idle adoption after revalidation",
		);
		assert.equal(state.status, "summarizing");
	});

	it("queues a later turn_end while stale pending revalidation is running", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nOld pending",
			firstKeptEntryId: "old-boundary",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "old answer" }),
			msg("u2", { role: "user", content: "new work" }),
			msg("a2", { role: "assistant", content: "new answer" }),
		];
		const firstArtifactDir = await mkdtemp(
			join(process.cwd(), ".scratch", "test-tmp", "revalidated-queued-first-"),
		);
		const secondArtifactDir = await mkdtemp(
			join(process.cwd(), ".scratch", "test-tmp", "revalidated-queued-second-"),
		);
		const resultFor = (
			artifactDir: string,
			firstKeptEntryId: string,
		): ValidatedRunResult => ({
			mode: "validated",
			accepted: true,
			repaired: false,
			artifactDir,
			summary: `## Goal\nRevalidated ${firstKeptEntryId}`,
			judge: {
				score: 9,
				decision: "accept",
				missing: [],
				contradictions: [],
				diagnosis: "ok",
			},
			firstKeptEntryId,
			tokensBefore: 200,
		});
		let releaseFirst!: (result: ValidatedRunResult) => void;
		const firstRevalidation = new Promise<ValidatedRunResult>((resolve) => {
			releaseFirst = resolve;
		});
		let revalidationCalls = 0;
		let compactCalls = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			runValidatedSlipstream: async () => {
				revalidationCalls += 1;
				if (revalidationCalls === 1) return firstRevalidation;
				return resultFor(secondArtifactDir, "boundary-a3");
			},
		});
		const ctx = {
			cwd: "/repo",
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
			},
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
			compact: () => {
				compactCalls += 1;
			},
			isIdle: () => true,
			hasPendingMessages: () => false,
		};

		await handlers.turn_end?.(
			{
				turnIndex: 2,
				message: {
					role: "assistant",
					content: "new answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			ctx,
		);
		await waitUntil(() => revalidationCalls === 1, "first revalidation start");
		branch.push(
			msg("u3", { role: "user", content: "newer work" }),
			msg("a3", { role: "assistant", content: "newer answer" }),
		);
		await handlers.turn_end?.(
			{
				turnIndex: 3,
				message: {
					role: "assistant",
					content: "newer answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			ctx,
		);
		assert.equal(revalidationCalls, 1);

		releaseFirst(resultFor(firstArtifactDir, "boundary-a2"));
		await waitUntil(() => revalidationCalls === 2, "queued revalidation start");
		await waitUntil(
			() => state.pending?.validatedThroughEntryId === "a3",
			"queued revalidation completion",
		);
		assert.equal(state.pending?.firstKeptEntryId, "boundary-a3");
		await waitUntil(() => compactCalls === 1, "queued revalidation adoption");
	});

	it("stale pending revalidation recomputes the retained-tail boundary", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nOld pending",
			firstKeptEntryId: "old-boundary",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "old answer" }),
			msg("u2", { role: "user", content: "new work" }),
			msg("a2", { role: "assistant", content: "new answer" }),
		];
		let compactCalls = 0;
		const revalidatedArtifactDir = await mkdtemp(
			join(process.cwd(), ".scratch", "test-tmp", "revalidated-boundary-"),
		);
		let capturedFirstKeptEntryId: string | null | undefined = "unset";
		let capturedKeepRecentTokens: number | undefined;
		let capturedStatsFullPaths: boolean | undefined;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, { ...config(), statsFullPaths: true }, state, {
			runValidatedSlipstream: async (input) => {
				capturedFirstKeptEntryId = input.firstKeptEntryId;
				capturedKeepRecentTokens = input.keepRecentTokens;
				capturedStatsFullPaths = input.statsFullPaths;
				return {
					mode: "validated",
					accepted: true,
					repaired: false,
					artifactDir: revalidatedArtifactDir,
					summary: "## Goal\nRevalidated",
					judge: {
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "ok",
					},
					firstKeptEntryId: "new-boundary",
					tokensBefore: 200,
				};
			},
		});

		await handlers.turn_end?.(
			{
				turnIndex: 2,
				message: {
					role: "assistant",
					content: "new answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
		);

		await waitUntil(
			() => capturedKeepRecentTokens !== undefined,
			"stale pending revalidation start",
		);
		await waitUntil(
			() => state.pending?.firstKeptEntryId === "new-boundary",
			"stale pending revalidation completion",
		);
		assert.equal(capturedFirstKeptEntryId, undefined);
		assert.equal(capturedKeepRecentTokens, config().slipstreamKeepRecentTokens);
		assert.equal(capturedStatsFullPaths, true);
		assert.equal(state.pending?.firstKeptEntryId, "new-boundary");
		assert.equal(state.pending?.validatedThroughEntryId, "a2");
		assert.equal(compactCalls, 1);
	});

	it("stale pending revalidation stops if compaction invalidates pending state", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nOld pending",
			firstKeptEntryId: "old-boundary",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "old answer" }),
			msg("u2", { role: "user", content: "new work" }),
			msg("a2", { role: "assistant", content: "new answer" }),
		];
		let compactCalls = 0;
		const revalidatedArtifactDir = await mkdtemp(
			join(process.cwd(), ".scratch", "test-tmp", "revalidated-invalidated-"),
		);
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			runValidatedSlipstream: async () => {
				state.pending = null;
				state.status = "idle";
				return {
					mode: "validated",
					accepted: true,
					repaired: false,
					artifactDir: revalidatedArtifactDir,
					summary: "## Goal\nRevalidated after invalidation",
					judge: {
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "ok",
					},
					firstKeptEntryId: "new-boundary",
					tokensBefore: 200,
				};
			},
		});

		await handlers.turn_end?.(
			{
				turnIndex: 2,
				message: {
					role: "assistant",
					content: "new answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 0, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
		);

		await waitUntil(
			() => state.status === "idle" && state.pending === null,
			"stale pending invalidation completion",
		);
		assert.equal(state.status, "idle");
		assert.equal(state.pending, null);
		assert.equal(compactCalls, 0);
	});

	it("stale pending revalidation policy-accepts rejected summaries when configured", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nOld pending",
			firstKeptEntryId: "old-boundary",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "old answer" }),
			msg("u2", { role: "user", content: "new work" }),
			msg("a2", { role: "assistant", content: "new answer" }),
		];
		let compactCalls = 0;
		const revalidatedArtifactDir = await mkdtemp(
			join(process.cwd(), ".scratch", "test-tmp", "revalidated-rejected-"),
		);
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(
			pi,
			{ ...config(), rejectedSummaryMode: "accept" },
			state,
			{
				runValidatedSlipstream: async () => ({
					mode: "validated",
					accepted: false,
					repaired: true,
					artifactDir: revalidatedArtifactDir,
					summary: "## Goal\nRevalidated but weak",
					judge: {
						score: 4,
						decision: "reject",
						missing: ["new work detail"],
						contradictions: [],
						diagnosis: "below threshold",
					},
					firstKeptEntryId: "new-boundary",
					tokensBefore: 200,
				}),
			},
		);

		await handlers.turn_end?.(
			{
				turnIndex: 2,
				message: {
					role: "assistant",
					content: "new answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 0, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
		);

		await waitUntil(
			() => state.pending?.firstKeptEntryId === "new-boundary",
			"policy-accepted stale pending revalidation completion",
		);
		assert.equal(state.pending?.firstKeptEntryId, "new-boundary");
		assert.equal(state.pending?.validatedThroughEntryId, "a2");
		assert.equal(state.pending?.details.rejectedSummaryAccepted, true);
		assert.equal(state.pending?.details.rejectedSummaryMode, "accept");
		assert.equal(compactCalls, 1);
	});

	it("keeps ready widget visible when stale pending revalidation cannot run", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nOld pending",
			firstKeptEntryId: "old-boundary",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "old answer" }),
			msg("u2", { role: "user", content: "new work" }),
			msg("a2", { role: "assistant", content: "new answer" }),
		];
		const widgetUpdates: Array<string[] | undefined> = [];
		let compactCalls = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 2,
				message: {
					role: "assistant",
					content: "new answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			{
				cwd: "/repo",
				ui: {
					setStatus: () => undefined,
					setWidget: (_key: string, lines: string[] | undefined) => {
						widgetUpdates.push(lines);
					},
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 0, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
		);

		await waitUntil(
			() => widgetUpdates.length > 0,
			"non-adopting stale pending restore",
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");
		assert.deepEqual(widgetUpdates.at(-1), ["Slipstream: ready · score 8/10"]);
	});

	it("turn_end ignores stale context before immediate prepared adoption", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		let compactCalls = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					},
					getBranch: () => [],
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
		);

		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");
	});

	it("turn_end ignores stale getBranch before immediate prepared adoption", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		let compactCalls = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					},
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
		);

		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");
		assert.notEqual(state.pending, null);
	});

	it("turn_end ignores stale getBranch before auto start", async () => {
		const state = createRuntimeState();
		let startCalls = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(
			pi,
			{ ...config(), triggerContextPercent: 0.001 },
			state,
			{
				runValidatedSlipstream: async () => {
					startCalls += 1;
					throw new Error("auto start should not run with stale branch");
				},
			},
		);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					},
				},
				getContextUsage: () => ({ tokens: 600, contextWindow: 1000 }),
			},
		);

		assert.equal(startCalls, 0);
		assert.equal(state.status, "idle");
	});

	it("turn_end ignores stale getBranch before auto finalization", async () => {
		const state = createRuntimeState();
		state.autoJob = {
			sessionId: "s1",
			cwd: "/repo",
			summaryPromise: Promise.resolve("## Goal\nAuto summary"),
			continuation: {
				appendTurn: () => undefined,
				isReady: () => true,
			},
		} as never;
		let finalizeCalls = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			finalizeAutoJob: async () => {
				finalizeCalls += 1;
				return true;
			},
		});

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "done", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					},
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
			},
		);
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(finalizeCalls, 0);
		assert.notEqual(state.autoJob, null);
	});

	it("turn_end triggers compact for a fresh ready pending summary at the trigger threshold", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		let compactCalls = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
		);

		assert.equal(compactCalls, 1);
		assert.equal(state.status, "summarizing");
	});

	it("turn_end prepared adoption clears request state from compact callbacks", async () => {
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		for (const callback of ["onComplete", "onError"] as const) {
			const state = createRuntimeState();
			storePendingValidated(state, {
				sessionId: "s1",
				cwd: "/repo",
				projectId: "/repo",
				artifactDir: "/tmp/slipstream-pending",
				summary: "## Goal\nReady",
				firstKeptEntryId: "a1",
				validatedThroughEntryId: "a1",
				tokensBefore: 100,
				details: { judge: { score: 8 }, artifacts: [] },
				expiresAt: 4_000_000_000_000,
			});
			let onComplete: ((result: unknown) => void) | undefined;
			let onError: ((error: Error) => void) | undefined;
			const handlers: Partial<
				Record<
					"turn_end",
					(event: unknown, ctx: unknown) => Promise<void> | void
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<void> | void,
				) => {
					if (event === "turn_end") handlers.turn_end = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			registerLifecycle(pi, config(), state);

			await handlers.turn_end?.(
				{
					turnIndex: 1,
					message: { role: "assistant", content: "ready", stopReason: "stop" },
					toolResults: [],
				},
				{
					cwd: "/repo",
					sessionManager: {
						getSessionId: () => "s1",
						getBranch: () => branch,
					},
					getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
					compact: (options?: {
						onComplete?: (result: unknown) => void;
						onError?: (error: Error) => void;
					}) => {
						onComplete = options?.onComplete;
						onError = options?.onError;
					},
					ui: {
						setStatus: () => undefined,
						setWidget: () => undefined,
						notify: () => undefined,
					},
					isIdle: () => true,
					hasPendingMessages: () => false,
				},
			);

			assert.notEqual(state.slipstreamCompactionRequest, null);
			if (callback === "onComplete") onComplete?.({ ok: true });
			else onError?.(new Error("failed"));
			assert.equal(state.slipstreamCompactionRequest, null);
		}
	});

	for (const stopReason of ["error", "aborted"] as const) {
		it(`turn_end does not auto-adopt after ${stopReason} assistant turns`, async () => {
			const state = createRuntimeState();
			storePendingValidated(state, {
				sessionId: "s1",
				cwd: "/repo",
				projectId: "/repo",
				artifactDir: "/tmp/slipstream-pending",
				summary: "## Goal\nReady",
				firstKeptEntryId: "a1",
				validatedThroughEntryId: "a1",
				tokensBefore: 100,
				details: { judge: { score: 8 }, artifacts: [] },
				expiresAt: 4_000_000_000_000,
			});
			const branch = [
				msg("u1", { role: "user", content: "old" }),
				msg("a1", {
					role: "assistant",
					content: "failed turn",
					stopReason,
				}),
			];
			let compactCalls = 0;
			const handlers: Partial<
				Record<
					"turn_end",
					(event: unknown, ctx: unknown) => Promise<void> | void
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<void> | void,
				) => {
					if (event === "turn_end") handlers.turn_end = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			registerLifecycle(pi, config(), state);

			await handlers.turn_end?.(
				{
					turnIndex: 1,
					message: {
						role: "assistant",
						content: "failed turn",
						stopReason,
					},
					toolResults: [],
				},
				{
					cwd: "/repo",
					sessionManager: {
						getSessionId: () => "s1",
						getBranch: () => branch,
					},
					getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
					compact: () => {
						compactCalls += 1;
					},
					isIdle: () => true,
					hasPendingMessages: () => false,
				},
			);

			assert.equal(compactCalls, 0);
			assert.equal(state.status, "ready_to_adopt");
		});
	}

	it("idle boundary retries once after the turn event chain settles", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		let compactCalls = 0;
		let idle = false;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => idle,
				hasPendingMessages: () => false,
			},
		);

		assert.equal(compactCalls, 0);
		idle = true;
		await waitUntil(() => compactCalls === 1, "idle prepared adoption");
		assert.equal(state.status, "summarizing");
	});

	it("rechecks readiness immediately before prepared compaction", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		let compactCalls = 0;
		let idle = false;
		let readinessChecks = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => {
					readinessChecks += 1;
					return readinessChecks === 1 || idle;
				},
				hasPendingMessages: () => false,
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");

		idle = true;
		await waitUntil(() => compactCalls === 1, "idle adoption after final gate");
		assert.equal(state.status, "summarizing");
	});

	it("idle boundary keeps retrying pending adoption after the first retry sees Pi busy", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		let compactCalls = 0;
		let idle = false;
		let pendingIdleChecks = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => {
					if (state.pending) pendingIdleChecks += 1;
					return idle;
				},
				hasPendingMessages: () => false,
			},
		);

		await waitUntil(
			() => pendingIdleChecks >= 2,
			"first busy pending idle retry",
		);
		assert.equal(compactCalls, 0);
		idle = true;
		await waitUntil(() => compactCalls === 1, "busy-to-idle pending adoption");
		assert.equal(state.status, "summarizing");
	});

	it("idle prepared adoption does not fire while pending messages exist", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		let compactCalls = 0;
		let hasPendingMessages = true;
		let pendingReadinessChecks = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => {
					if (state.pending) pendingReadinessChecks += 1;
					return hasPendingMessages;
				},
			},
		);

		await waitUntil(
			() => pendingReadinessChecks >= 2,
			"pending-message adoption readiness check",
		);
		assert.equal(compactCalls, 0);
		hasPendingMessages = false;
		await waitUntil(
			() => compactCalls === 1,
			"pending-message-cleared adoption",
		);
		assert.equal(state.status, "summarizing");
	});

	for (const drift of ["session", "cwd"] as const) {
		it(`idle boundary retry does not compact after ${drift} drift`, async () => {
			const state = createRuntimeState();
			storePendingValidated(state, {
				sessionId: "s1",
				cwd: "/repo",
				projectId: "/repo",
				artifactDir: "/tmp/slipstream-pending",
				summary: "## Goal\nReady",
				firstKeptEntryId: "a1",
				validatedThroughEntryId: "a1",
				tokensBefore: 100,
				details: { judge: { score: 8 }, artifacts: [] },
				expiresAt: 4_000_000_000_000,
			});
			const branch = [
				msg("u1", { role: "user", content: "old" }),
				msg("a1", { role: "assistant", content: "ready" }),
			];
			let compactCalls = 0;
			let idle = false;
			let sessionId = "s1";
			let cwd = "/repo";
			const handlers: Partial<
				Record<
					"turn_end",
					(event: unknown, ctx: unknown) => Promise<void> | void
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<void> | void,
				) => {
					if (event === "turn_end") handlers.turn_end = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			registerLifecycle(pi, config(), state);

			await handlers.turn_end?.(
				{
					turnIndex: 1,
					message: {
						role: "assistant",
						content: "ready",
						stopReason: "stop",
					},
					toolResults: [],
				},
				{
					get cwd() {
						return cwd;
					},
					sessionManager: {
						getSessionId: () => sessionId,
						getBranch: () => branch,
					},
					getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
					compact: () => {
						compactCalls += 1;
					},
					isIdle: () => idle,
					hasPendingMessages: () => false,
				},
			);

			if (drift === "session") sessionId = "s2";
			else cwd = "/other-repo";
			idle = true;
			await new Promise((resolve) => setTimeout(resolve, 0));

			assert.equal(compactCalls, 0);
			assert.equal(state.status, "ready_to_adopt");
		});
	}

	it("idle boundary retry suppresses duplicate scheduling", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		let compactCalls = 0;
		let idle = false;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);
		const event = {
			turnIndex: 1,
			message: { role: "assistant", content: "ready", stopReason: "stop" },
			toolResults: [],
		};
		const ctx = {
			cwd: "/repo",
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
			compact: () => {
				compactCalls += 1;
			},
			isIdle: () => idle,
			hasPendingMessages: () => false,
		};

		await handlers.turn_end?.(event, ctx);
		await handlers.turn_end?.(event, ctx);

		assert.equal(compactCalls, 0);
		idle = true;
		await waitUntil(() => compactCalls === 1, "deduplicated idle adoption");
		assert.equal(state.status, "summarizing");
	});

	it("idle boundary retry ignores stale context before rechecking readiness", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		let compactCalls = 0;
		let idle = false;
		let sessionReads = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => {
						sessionReads += 1;
						if (sessionReads > 1)
							throw new Error(
								"This extension ctx is stale after session replacement or reload.",
							);
						return "s1";
					},
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => idle,
				hasPendingMessages: () => false,
			},
		);

		idle = true;
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");
	});

	it("idle boundary retry ignores stale cwd before rechecking readiness", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		let compactCalls = 0;
		let cwdReads = 0;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				get cwd() {
					cwdReads += 1;
					if (cwdReads > 1)
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					return "/repo";
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => false,
				hasPendingMessages: () => false,
			},
		);

		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");
	});

	it("idle boundary retry skips compaction when pending is cleared before the timer fires", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		let compactCalls = 0;
		let idle = false;
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => idle,
				hasPendingMessages: () => false,
			},
		);

		state.pending = null;
		state.status = "idle";
		idle = true;
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(compactCalls, 0);
		assert.equal(state.status, "idle");
	});

	it("session_shutdown clears deferred retry and in-flight state", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		state.autoJob = { sessionId: "s1" } as never;
		state.activePromise = Promise.resolve() as never;
		state.compactionWanted = true;
		let compactCalls = 0;
		let idle = false;
		const handlers: Partial<
			Record<
				"turn_end" | "session_shutdown",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end" || event === "session_shutdown")
					handlers[event] = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		state.autoJob = null;
		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "ready", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => [
						msg("u1", { role: "user", content: "old" }),
						msg("a1", { role: "assistant", content: "ready" }),
					],
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => idle,
				hasPendingMessages: () => false,
			},
		);

		state.autoJob = { sessionId: "s1" } as never;
		state.activePromise = Promise.resolve() as never;
		state.compactionWanted = true;
		await handlers.session_shutdown?.(
			{},
			{
				cwd: "/repo",
				ui: { setWidget: () => undefined, notify: () => undefined },
				sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
			},
		);
		idle = true;
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(compactCalls, 0);
		assert.equal(state.pending, null);
		assert.equal(state.autoJob, null);
		assert.equal(state.activePromise, null);
		assert.equal(state.compactionWanted, false);
		assert.equal(state.status, "idle");
	});

	it("session_before_compact ignores stale context before reading pending state", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady summary",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const handlers: Partial<
			Record<
				"session_before_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "session_before_compact") {
					handlers.session_before_compact = handler;
				}
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		const result = await handlers.session_before_compact?.(
			{
				preparation: { firstKeptEntryId: "native-boundary", tokensBefore: 200 },
				branchEntries: [],
			},
			{
				cwd: "/repo",
				sessionManager: {
					getSessionId: () => {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					},
					getBranch: () => [],
				},
			},
		);

		assert.equal(result, undefined);
		assert.equal(state.status, "ready_to_adopt");
		assert.notEqual(state.pending, null);
	});

	it("session_before_compact returns a prepared summary when status UI is stale", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady summary",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		const handlers: Partial<
			Record<
				"session_before_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "session_before_compact")
					handlers.session_before_compact = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			buildDefaultSlipstreamCompaction: async () => {
				throw new Error("matching pending should be consumed, not regenerated");
			},
		});

		const result = await handlers.session_before_compact?.(
			{
				preparation: { firstKeptEntryId: "native-boundary", tokensBefore: 200 },
				branchEntries: branch,
			},
			{
				cwd: "/repo",
				ui: {
					setStatus: () => {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					},
					setWidget: () => undefined,
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
			},
		);

		assert.deepEqual(result, {
			compaction: {
				summary: "## Goal\nReady summary",
				firstKeptEntryId: "a1",
				tokensBefore: 200,
				details: { judge: { score: 8 }, artifacts: [] },
			},
		});
		assert.equal(state.status, "summarizing");
	});

	it("session_before_compact bypasses plain compact when default replacement is disabled", async () => {
		const state = createRuntimeState();
		const branch = [msg("a1", { role: "assistant", content: "ready" })];
		let defaultCalls = 0;
		const handlers: Partial<
			Record<
				"session_before_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "session_before_compact")
					handlers.session_before_compact = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(
			pi,
			{ ...config(), replaceDefaultCompact: false, autoTrigger: false },
			state,
			{
				buildDefaultSlipstreamCompaction: async () => {
					defaultCalls += 1;
					return { cancel: true };
				},
			},
		);

		const result = await handlers.session_before_compact?.(
			{
				preparation: { firstKeptEntryId: "native-boundary", tokensBefore: 200 },
				branchEntries: branch,
			},
			{
				cwd: "/repo",
				ui: {
					setStatus: () => undefined,
					setWidget: () => undefined,
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
			},
		);

		assert.equal(result, undefined);
		assert.equal(defaultCalls, 0);
		assert.equal(state.status, "idle");
	});

	it("explicit slipstream compact still injects a summary when default replacement is disabled", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-explicit-"));
		try {
			const state = createRuntimeState();
			const branch = [msg("a1", { role: "assistant", content: "ready" })];
			const handlers: Partial<
				Record<
					"session_before_compact",
					(event: unknown, ctx: unknown) => Promise<unknown> | unknown
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
				) => {
					if (event === "session_before_compact")
						handlers.session_before_compact = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			const cfg = {
				...config(),
				replaceDefaultCompact: false,
				autoTrigger: false,
				artifactRoot: root,
			};
			registerLifecycle(pi, cfg, state, {
				buildDefaultSlipstreamCompaction: async () => {
					throw new Error("explicit compact should consume pending summary");
				},
			});
			let compactCalls = 0;
			const ctx = {
				cwd: process.cwd(),
				modelRegistry: {
					find: () => undefined,
					getApiKeyAndHeaders: async () => ({}),
				},
				ui: {
					setStatus: () => undefined,
					setWidget: () => undefined,
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s-explicit",
					getBranch: () => branch,
				},
				compact: () => {
					compactCalls += 1;
				},
			};

			const commandResult = await handleSlipstreamCommand(
				"compact",
				state,
				cfg,
				ctx,
				{
					createSummaryCompleter: () => async () => "## Goal\nReady summary",
					createJudgeCompleter: () => async () => ({
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "ok",
					}),
				},
			);

			assert.equal(commandResult.ok, true);
			assert.equal(compactCalls, 1);

			const result = await handlers.session_before_compact?.(
				{
					preparation: {
						firstKeptEntryId: "native-boundary",
						tokensBefore: 200,
					},
					branchEntries: branch,
				},
				ctx,
			);

			assert.ok(result && typeof result === "object" && "compaction" in result);
			const compaction = result.compaction as {
				summary: string;
				firstKeptEntryId: string;
				tokensBefore: number;
				details: { judge: { score: number } };
			};
			assert.match(compaction.summary, /Ready summary/);
			assert.equal(compaction.firstKeptEntryId, "a1");
			assert.equal(compaction.tokensBefore, 200);
			assert.equal(compaction.details.judge.score, 9);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("explicit slipstream compact --adopt still injects a summary when default replacement is disabled", async () => {
		const state = createRuntimeState();
		const branch = [msg("a1", { role: "assistant", content: "ready" })];
		const handlers: Partial<
			Record<
				"session_before_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "session_before_compact")
					handlers.session_before_compact = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		const cfg = {
			...config(),
			replaceDefaultCompact: false,
			autoTrigger: false,
		};
		registerLifecycle(pi, cfg, state, {
			buildDefaultSlipstreamCompaction: async () => {
				throw new Error("explicit adopt should consume pending summary");
			},
		});
		storePendingValidated(state, {
			sessionId: "s-adopt",
			cwd: "/repo",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "validated adopt summary",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: Date.now() + 10_000,
		});
		let compactCalls = 0;
		const ctx = {
			cwd: "/repo",
			ui: {
				setStatus: () => undefined,
				setWidget: () => undefined,
				notify: () => undefined,
			},
			sessionManager: {
				getSessionId: () => "s-adopt",
				getBranch: () => branch,
			},
			compact: () => {
				compactCalls += 1;
			},
		};

		const commandResult = await handleSlipstreamCommand(
			"compact --adopt",
			state,
			cfg,
			ctx,
			{ now: () => Date.now() },
		);

		assert.equal(commandResult.ok, true);
		assert.equal(compactCalls, 1);

		const result = await handlers.session_before_compact?.(
			{
				preparation: { firstKeptEntryId: "native-boundary", tokensBefore: 200 },
				branchEntries: branch,
			},
			ctx,
		);

		assert.ok(result && typeof result === "object" && "compaction" in result);
		const compaction = result.compaction as {
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number;
			details: { judge: { score: number } };
		};
		assert.equal(compaction.summary, "validated adopt summary");
		assert.equal(compaction.firstKeptEntryId, "a1");
		assert.equal(compaction.tokensBefore, 200);
		assert.equal(compaction.details.judge.score, 9);
	});

	it("explicit slipstream compact cancels instead of falling through when pending is stale", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-stale-explicit-"));
		try {
			const state = createRuntimeState();
			const branchAtPrepare = [
				msg("a1", { role: "assistant", content: "ready" }),
			];
			const branchAtCompact = [
				...branchAtPrepare,
				msg("a2", { role: "assistant", content: "newer state" }),
			];
			const handlers: Partial<
				Record<
					"session_before_compact",
					(event: unknown, ctx: unknown) => Promise<unknown> | unknown
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
				) => {
					if (event === "session_before_compact")
						handlers.session_before_compact = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			const cfg = {
				...config(),
				replaceDefaultCompact: false,
				autoTrigger: false,
				artifactRoot: root,
			};
			registerLifecycle(pi, cfg, state);
			let compactCalls = 0;
			const ctx = {
				cwd: process.cwd(),
				modelRegistry: {
					find: () => undefined,
					getApiKeyAndHeaders: async () => ({}),
				},
				ui: {
					setStatus: () => undefined,
					setWidget: () => undefined,
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s-stale-explicit",
					getBranch: () => branchAtPrepare,
				},
				compact: () => {
					compactCalls += 1;
				},
			};

			const commandResult = await handleSlipstreamCommand(
				"compact",
				state,
				cfg,
				ctx,
				{
					createSummaryCompleter: () => async () => "## Goal\nReady summary",
					createJudgeCompleter: () => async () => ({
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "ok",
					}),
				},
			);

			assert.equal(commandResult.ok, true);
			assert.equal(compactCalls, 1);

			const result = await handlers.session_before_compact?.(
				{
					preparation: {
						firstKeptEntryId: "native-boundary",
						tokensBefore: 200,
					},
					branchEntries: branchAtCompact,
				},
				{
					...ctx,
					sessionManager: {
						...ctx.sessionManager,
						getBranch: () => branchAtCompact,
					},
				},
			);

			assert.deepEqual(result, { cancel: true });
			assert.equal(state.pending, null);
			assert.equal(state.slipstreamCompactionRequest, null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("expired explicit slipstream compact cancels instead of falling through", async () => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const root = await mkdtemp(join(parent, "slipstream-expired-explicit-"));
		try {
			const state = createRuntimeState();
			const branch = [msg("a1", { role: "assistant", content: "ready" })];
			const handlers: Partial<
				Record<
					"session_before_compact",
					(event: unknown, ctx: unknown) => Promise<unknown> | unknown
				>
			> = {};
			const pi = {
				on: (
					event: string,
					handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
				) => {
					if (event === "session_before_compact")
						handlers.session_before_compact = handler;
				},
			} as unknown as Parameters<typeof registerLifecycle>[0];
			const cfg = {
				...config(),
				replaceDefaultCompact: false,
				autoTrigger: false,
				artifactRoot: root,
			};
			registerLifecycle(pi, cfg, state);
			const ctx = {
				cwd: process.cwd(),
				modelRegistry: {
					find: () => undefined,
					getApiKeyAndHeaders: async () => ({}),
				},
				ui: {
					setStatus: () => undefined,
					setWidget: () => undefined,
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s-expired-explicit",
					getBranch: () => branch,
				},
				compact: () => undefined,
			};

			const commandResult = await handleSlipstreamCommand(
				"compact",
				state,
				cfg,
				ctx,
				{
					createSummaryCompleter: () => async () => "## Goal\nReady summary",
					createJudgeCompleter: () => async () => ({
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "ok",
					}),
				},
			);
			assert.equal(commandResult.ok, true);
			assert.notEqual(state.slipstreamCompactionRequest, null);
			state.slipstreamCompactionRequest!.expiresAt = 0;

			const result = await handlers.session_before_compact?.(
				{
					preparation: {
						firstKeptEntryId: "native-boundary",
						tokensBefore: 200,
					},
					branchEntries: branch,
				},
				ctx,
			);

			assert.deepEqual(result, { cancel: true });
			assert.equal(state.pending, null);
			assert.equal(state.slipstreamCompactionRequest, null);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("session_before_compact runs default compaction when initial status UI is stale", async () => {
		const state = createRuntimeState();
		const branch = [msg("a1", { role: "assistant", content: "ready" })];
		let defaultCalls = 0;
		const handlers: Partial<
			Record<
				"session_before_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "session_before_compact")
					handlers.session_before_compact = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			buildDefaultSlipstreamCompaction: async () => {
				defaultCalls += 1;
				return { cancel: true };
			},
		});

		const result = await handlers.session_before_compact?.(
			{
				preparation: { firstKeptEntryId: "native-boundary", tokensBefore: 200 },
				branchEntries: branch,
			},
			{
				cwd: "/repo",
				ui: {
					setStatus: () => {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					},
					setWidget: () => undefined,
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
			},
		);

		assert.deepEqual(result, { cancel: true });
		assert.equal(defaultCalls, 1);
	});

	it("session_before_compact consumes a matching pending summary", async (t) => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const artifactRoot = await mkdtemp(join(parent, "slipstream-consume-"));
		t.after(() => rm(artifactRoot, { recursive: true, force: true }));
		const run = await new ArtifactStore({ root: artifactRoot }).createRun({
			sessionId: "s1",
			triggerEntryId: "a1",
			cwd: process.cwd(),
		});
		const artifactDir = run.dir;
		await writeFile(join(artifactDir, "pending.json"), "{}", "utf8");
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: process.cwd(),
			projectId: process.cwd(),
			artifactDir,
			summary: "## Goal\nReady summary",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [artifactDir] },
			expiresAt: 4_000_000_000_000,
		});
		const branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "ready" }),
		];
		const handlers: Partial<
			Record<
				"session_before_compact" | "session_compact",
				(event: unknown, ctx: unknown) => Promise<unknown> | unknown
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<unknown> | unknown,
			) => {
				if (event === "session_before_compact") {
					handlers.session_before_compact = handler;
				}
				if (event === "session_compact") {
					handlers.session_compact = handler;
				}
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, { ...config(), artifactRoot }, state, {
			buildDefaultSlipstreamCompaction: async () => {
				throw new Error("matching pending should be consumed, not regenerated");
			},
		});
		const statusUpdates: Array<string | undefined> = [];
		const widgetUpdates: Array<string[] | undefined> = [];

		const result = await handlers.session_before_compact?.(
			{
				preparation: { firstKeptEntryId: "native-boundary", tokensBefore: 200 },
				branchEntries: branch,
			},
			{
				cwd: process.cwd(),
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						statusUpdates.push(text);
					},
					setWidget: (_key: string, lines: string[] | undefined) => {
						widgetUpdates.push(lines);
					},
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
			},
		);

		assert.equal(state.pending, null);
		assert.equal(state.status, "summarizing");
		assert.match(statusUpdates.join("\n"), /compacting with prepared summary/);
		assert.equal(statusUpdates.at(-1), "slipstream: compacting");
		assert.deepEqual(widgetUpdates.at(-1), [
			"Slipstream: compacting · score 8/10",
		]);
		assert.deepEqual(result, {
			compaction: {
				summary: "## Goal\nReady summary",
				firstKeptEntryId: "a1",
				tokensBefore: 200,
				details: { judge: { score: 8 }, artifacts: [artifactDir] },
			},
		});
		await assert.rejects(() => access(join(artifactDir, "pending.json")));

		await handlers.session_compact?.(
			{
				type: "session_compact",
				fromExtension: true,
				compactionEntry: { summary: "## Goal\nReady summary" },
			},
			{
				cwd: process.cwd(),
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						statusUpdates.push(text);
					},
					setWidget: (_key: string, lines: string[] | undefined) => {
						widgetUpdates.push(lines);
					},
					notify: () => undefined,
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
			},
		);
		assert.equal(state.status, "idle");
		assert.equal(statusUpdates.at(-1), "slipstream: manual");
		assert.equal(widgetUpdates.at(-1), undefined);
	});

	it("session_compact clears stale active repair state after compaction finishes", async () => {
		const state = createRuntimeState();
		state.status = "repairing";
		state.pending = {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nStale pending",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		};
		state.autoJob = { finalizing: true } as never;
		state.activePromise = Promise.resolve();
		state.compactionWanted = true;
		const statusUpdates: Array<string | undefined> = [];
		const widgetUpdates: Array<string[] | undefined> = [];
		const handlers: Partial<
			Record<
				"session_compact",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_compact") handlers.session_compact = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state);

		await handlers.session_compact?.(
			{ type: "session_compact", fromExtension: false, compactionEntry: {} },
			{
				cwd: "/repo",
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						statusUpdates.push(text);
					},
					setWidget: (_key: string, lines: string[] | undefined) => {
						widgetUpdates.push(lines);
					},
					notify: () => undefined,
				},
				sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
			},
		);

		assert.equal(state.status, "idle");
		assert.equal(state.pending, null);
		assert.equal(state.autoJob, null);
		assert.equal(state.activePromise, null);
		assert.equal(state.compactionWanted, false);
		assert.equal(statusUpdates.at(-1), "slipstream: manual");
		assert.equal(widgetUpdates.at(-1), undefined);
	});

	it("session_compact invalidates ready pending state but remains a no-op when disabled", async (t) => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		await mkdir(parent, { recursive: true });
		const artifactRoot = await mkdtemp(
			join(parent, "slipstream-session-compact-"),
		);
		t.after(() => rm(artifactRoot, { recursive: true, force: true }));
		const run = await new ArtifactStore({ root: artifactRoot }).createRun({
			sessionId: "s1",
			triggerEntryId: "a1",
			cwd: process.cwd(),
		});
		const artifactDir = run.dir;
		await writeFile(join(artifactDir, "pending.json"), "{}", "utf8");
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: process.cwd(),
			projectId: process.cwd(),
			artifactDir,
			summary: "## Goal\nReady summary",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [artifactDir] },
			expiresAt: 4_000_000_000_000,
		});
		const statusUpdates: Array<string | undefined> = [];
		const handlers: Partial<
			Record<
				"session_compact",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_compact") handlers.session_compact = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, { ...config(), artifactRoot }, state);

		await handlers.session_compact?.(
			{ type: "session_compact", fromExtension: false, compactionEntry: {} },
			{
				cwd: process.cwd(),
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						statusUpdates.push(text);
					},
					setWidget: () => undefined,
					notify: () => undefined,
				},
				sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
			},
		);
		assert.equal(state.status, "idle");
		assert.equal(state.pending, null);
		await assert.rejects(() => access(join(artifactDir, "pending.json")));
		assert.equal(statusUpdates.at(-1), "slipstream: manual");

		const disabled = createRuntimeState();
		disabled.status = "summarizing";
		const disabledHandlers: Partial<
			Record<
				"session_compact",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const disabledPi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_compact")
					disabledHandlers.session_compact = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(disabledPi, { ...config(), enabled: false }, disabled);
		await disabledHandlers.session_compact?.(
			{ type: "session_compact", fromExtension: true, compactionEntry: {} },
			{
				cwd: "/repo",
				ui: {
					setStatus: () => undefined,
					setWidget: () => undefined,
					notify: () => undefined,
				},
				sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
			},
		);
		assert.equal(disabled.status, "summarizing");
	});

	it("turn_end auto finalize failure marks failed and notifies", async () => {
		const state = createRuntimeState();
		state.autoJob = {
			sessionId: "s1",
			cwd: "/repo",
			summaryPromise: Promise.resolve("## Goal\nAuto summary"),
			continuation: {
				appendTurn: () => undefined,
				isReady: () => true,
			},
		} as never;
		const notifications: string[] = [];
		const statuses: Array<string | undefined> = [];
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];
		registerLifecycle(pi, config(), state, {
			finalizeAutoJob: async (input) => {
				input.state.autoJob = null;
				throw new Error("finalize exploded");
			},
		});

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: { role: "assistant", content: "done", stopReason: "stop" },
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				ui: {
					notify: (message: string) => {
						notifications.push(message);
					},
					setStatus: (_key: string, text: string | undefined) => {
						statuses.push(text);
					},
					setWidget: () => undefined,
				},
				sessionManager: { getSessionId: () => "s1", getBranch: () => [] },
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		assert.equal(state.status, "failed");
		assert.equal(state.autoJob, null);
		assert.match(notifications.join("\n"), /auto finalize failed/i);
		assert.match(notifications.join("\n"), /finalize exploded/);
		assert.equal(statuses.at(-1), "slipstream: manual");
	});

	it("passes the live branch head from turn_end into auto finalization", async () => {
		const state = createRuntimeState();
		let appended = false;
		state.autoJob = {
			artifactRoot: "/tmp",
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			snapshot: {
				sessionId: "s1",
				cwd: "/repo",
				triggerEntryId: "a5",
				firstKeptEntryId: "a5",
				tokensBefore: 100,
				summaryInputMessages: [],
				keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "a5" },
				manifest: {
					filesRead: [],
					filesModified: [],
					filesDeleted: [],
					errors: [],
					userDecisions: [],
					constraints: [],
					openLoops: [],
					recentVerification: [],
					latestUpdates: [],
					retainedTailUpdates: [],
					latestExchangeState: [],
					terminalFinalAnswerEvidence: [],
					latestSignals: [],
					staleSignals: [],
					userAssertionTrail: [],
					criticalLiterals: [],
					previousSummary: null,
					artifactRefs: [],
					knownFileRefs: new Set<string>(),
				},
			},
			firstKeptEntryId: "a5",
			tokensBefore: 100,
			artifactDir: "/tmp/slipstream-test",
			summaryArtifactRefs: [],
			continuation: {
				appendTurn: () => {
					appended = true;
				},
				isReady: () => true,
				snapshot: () => ({ triggerEntryId: "a5", turns: [] }),
			},
			summaryPromise: Promise.resolve("## Goal\nAuto summary"),
			stats: autoJobStats(),
			finalizing: false,
		};

		let branch = [
			msg("u5", { role: "user", content: "continue" }),
			msg("a5", { role: "assistant", content: "old head" }),
			msg("u6", { role: "user", content: "new request" }),
			msg("a6", { role: "assistant", content: "validated head" }),
		];
		let capturedValidatedThroughEntryId: string | null | undefined;
		let releaseFinalize: (() => void) | undefined;
		let compactCalls = 0;
		const finalizeReleased = new Promise<void>((resolve) => {
			releaseFinalize = resolve;
		});
		const handlers: Partial<
			Record<"turn_end", (event: unknown, ctx: unknown) => Promise<void> | void>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state, {
			finalizeAutoJob: async (input: FinalizeAutoJobInput) => {
				capturedValidatedThroughEntryId = input.validatedThroughEntryId;
				await finalizeReleased;
				storePendingValidated(state, {
					sessionId: "s1",
					cwd: "/repo",
					projectId: "/repo",
					artifactDir: "/tmp/slipstream-pending",
					summary: "## Goal\nAuto summary",
					firstKeptEntryId: "a5",
					validatedThroughEntryId: input.validatedThroughEntryId ?? null,
					tokensBefore: 100,
					details: { judge: { score: 8 }, artifacts: [] },
					expiresAt: 1_000,
				});
				return true;
			},
		});

		await handlers.turn_end?.(
			{
				turnIndex: 6,
				message: {
					role: "assistant",
					content: "validated head",
					stopReason: "stop",
				},
				toolResults: [],
			},
			{
				cwd: "/repo",
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => false,
			},
		);

		assert.equal(appended, true);
		assert.equal(capturedValidatedThroughEntryId, "a6");

		branch = [
			...branch,
			msg("u7", { role: "user", content: "advanced" }),
			msg("a7", { role: "assistant", content: "newer head" }),
		];
		releaseFinalize?.();
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(compactCalls, 0);
		assert.equal(state.pending, null);
	});

	it("session_tree clears stale pending state and widget", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nFuture branch pending",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "future-head",
			tokensBefore: 100,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: Date.now() + 10_000,
		});
		const statuses: Array<string | undefined> = [];
		const widgets: Array<string | undefined> = [];
		const handlers: Partial<
			Record<
				"session_tree",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_tree") handlers.session_tree = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state);

		assert.equal(typeof handlers.session_tree, "function");
		await handlers.session_tree?.(
			{ oldLeafId: "future-head", newLeafId: "rewound-head" },
			{
				cwd: "/repo",
				ui: {
					setStatus: (_key: string, text: string | undefined) => {
						statuses.push(text);
					},
					setWidget: (_key: string, text: string | undefined) => {
						widgets.push(text);
					},
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => [
						msg("u0", { role: "user", content: "rewound" }),
						msg("rewound-head", {
							role: "assistant",
							content: "rewound branch head",
						}),
					],
				},
			},
		);

		assert.equal(state.pending, null);
		assert.equal(state.status, "idle");
		assert.equal(statuses.at(-1), "slipstream: manual");
		assert.equal(widgets.at(-1), undefined);
	});

	it("session_tree keeps pending state that matches the rewound branch", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nCurrent pending",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "rewound-head",
			tokensBefore: 100,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: Date.now() + 10_000,
		});
		const widgets: Array<string[] | undefined> = [];
		const handlers: Partial<
			Record<
				"session_tree",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_tree") handlers.session_tree = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state);

		assert.equal(typeof handlers.session_tree, "function");
		await handlers.session_tree?.(
			{ oldLeafId: "future-head", newLeafId: "rewound-head" },
			{
				cwd: "/repo",
				ui: {
					setStatus: () => undefined,
					setWidget: (_key: string, lines: string[] | undefined) => {
						widgets.push(lines);
					},
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => [
						msg("u0", { role: "user", content: "rewound" }),
						msg("rewound-head", {
							role: "assistant",
							content: "rewound branch head",
						}),
					],
				},
			},
		);

		assert.equal(state.pending?.validatedThroughEntryId, "rewound-head");
		assert.equal(state.status, "ready_to_adopt");
		assert.match(widgets.at(-1)?.join("\n") ?? "", /ready/);
	});

	it("session_tree invalidates in-flight auto work before later turn_end", async () => {
		const state = createRuntimeState();
		let appended = false;
		state.activePromise = Promise.resolve("## Goal\nOld auto summary");
		state.autoJob = {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			snapshot: {
				sessionId: "s1",
				cwd: "/repo",
				triggerEntryId: "future-head",
				firstKeptEntryId: "future-head",
				tokensBefore: 100,
				summaryInputMessages: [],
				keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "future-head" },
				manifest: {
					filesRead: [],
					filesModified: [],
					filesDeleted: [],
					errors: [],
					userDecisions: [],
					constraints: [],
					openLoops: [],
					recentVerification: [],
					latestUpdates: [],
					retainedTailUpdates: [],
					latestExchangeState: [],
					terminalFinalAnswerEvidence: [],
					latestSignals: [],
					staleSignals: [],
					userAssertionTrail: [],
					criticalLiterals: [],
					previousSummary: null,
					artifactRefs: [],
					knownFileRefs: new Set<string>(),
				},
			},
			firstKeptEntryId: "future-head",
			tokensBefore: 100,
			artifactDir: "/tmp/slipstream-test",
			artifactRoot: "/tmp",
			summaryArtifactRefs: [],
			continuation: {
				appendTurn: () => {
					appended = true;
				},
				isReady: () => true,
				snapshot: () => ({ triggerEntryId: "future-head", turns: [] }),
			},
			summaryPromise: state.activePromise as Promise<string>,
			stateEvidence: undefined,
			maxConversationChars: 1000,
			stats: autoJobStats(),
			finalizing: false,
		} as AutoJob;
		state.status = "awaiting_continuation";

		let finalizeCalls = 0;
		const handlers: Partial<
			Record<
				"session_tree" | "turn_end",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_tree") handlers.session_tree = handler;
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state, {
			finalizeAutoJob: async () => {
				finalizeCalls += 1;
				return true;
			},
		});
		const ctx = {
			cwd: "/repo",
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
			},
			ui: { setStatus: () => undefined, setWidget: () => undefined },
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => [
					msg("u0", { role: "user", content: "rewound" }),
					msg("rewound-head", {
						role: "assistant",
						content: "rewound branch head",
					}),
				],
			},
			getContextUsage: () => ({ tokens: 1_000, contextWindow: 100_000 }),
			compact: () => undefined,
			isIdle: () => true,
			hasPendingMessages: () => false,
		};

		assert.equal(typeof handlers.session_tree, "function");
		await handlers.session_tree?.(
			{ oldLeafId: "future-head", newLeafId: "rewound-head" },
			ctx,
		);
		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: {
					role: "assistant",
					content: "new branch turn",
					stopReason: "stop",
				},
				toolResults: [],
			},
			ctx,
		);
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(state.autoJob, null);
		assert.equal(state.activePromise, null);
		assert.equal(appended, false);
		assert.equal(finalizeCalls, 0);
	});

	it("session_tree cancels queued turn-boundary work from the abandoned branch", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nOld pending",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: Date.now() + 10_000,
		});
		let branch = [
			msg("u1", { role: "user", content: "old" }),
			msg("a1", { role: "assistant", content: "old answer" }),
			msg("u2", { role: "user", content: "future" }),
			msg("a2", { role: "assistant", content: "future answer" }),
		];
		let revalidationStarted = false;
		let revalidationFinished = false;
		let releaseRevalidation: (() => void) | undefined;
		const revalidationGate = new Promise<void>((resolve) => {
			releaseRevalidation = resolve;
		});
		let startAutoCalls = 0;
		const handlers: Partial<
			Record<
				"session_tree" | "turn_end",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_tree") handlers.session_tree = handler;
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state, {
			runValidatedSlipstream: async () => {
				revalidationStarted = true;
				await revalidationGate;
				revalidationFinished = true;
				return {
					mode: "validated",
					accepted: true,
					repaired: false,
					artifactDir: "/tmp/slipstream-revalidation-after-tree",
					summary: "## Goal\nRevalidated",
					judge: {
						score: 9,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "ok",
					},
					firstKeptEntryId: "a2",
					tokensBefore: 200,
				};
			},
			startAutoJob: async () => {
				startAutoCalls += 1;
				return null;
			},
		});
		const ctx = {
			cwd: "/repo",
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
			},
			ui: { setStatus: () => undefined, setWidget: () => undefined },
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
			compact: () => undefined,
			isIdle: () => true,
			hasPendingMessages: () => false,
		};
		const turn = {
			turnIndex: 2,
			message: {
				role: "assistant",
				content: "future answer",
				stopReason: "stop",
			},
			toolResults: [],
		};

		await handlers.turn_end?.(turn, ctx);
		await waitUntil(() => revalidationStarted, "stale revalidation start");
		await handlers.turn_end?.({ ...turn, turnIndex: 3 }, ctx);
		branch = [
			msg("u0", { role: "user", content: "rewound" }),
			msg("rewound-head", {
				role: "assistant",
				content: "rewound branch head",
			}),
		];
		await handlers.session_tree?.(
			{ oldLeafId: "a2", newLeafId: "rewound-head" },
			ctx,
		);
		releaseRevalidation?.();
		await waitUntil(() => revalidationFinished, "stale revalidation finish");
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(startAutoCalls, 0);
		assert.equal(state.compactionWanted, false);
		assert.equal(state.autoJob, null);
	});

	it("session_tree suppresses stale turn-boundary errors after rewind", async () => {
		const state = createRuntimeState();
		let branch = [
			msg("u1", { role: "user", content: "future" }),
			msg("a1", { role: "assistant", content: "future answer" }),
		];
		let startAutoStarted = false;
		let releaseStartAuto: (() => void) | undefined;
		const startAutoGate = new Promise<void>((resolve) => {
			releaseStartAuto = resolve;
		});
		const notifications: string[] = [];
		const handlers: Partial<
			Record<
				"session_tree" | "turn_end",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_tree") handlers.session_tree = handler;
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state, {
			startAutoJob: async () => {
				startAutoStarted = true;
				await startAutoGate;
				throw new Error("stale abandoned-branch start");
			},
		});
		const ctx = {
			cwd: "/repo",
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
			},
			ui: {
				notify: (message: string) => {
					notifications.push(message);
				},
				setStatus: () => undefined,
				setWidget: () => undefined,
			},
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
			compact: () => undefined,
			isIdle: () => true,
			hasPendingMessages: () => false,
		};

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: {
					role: "assistant",
					content: "future answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			ctx,
		);
		await waitUntil(() => startAutoStarted, "stale start auto begins");
		branch = [
			msg("u0", { role: "user", content: "rewound" }),
			msg("rewound-head", {
				role: "assistant",
				content: "rewound branch head",
			}),
		];
		await handlers.session_tree?.(
			{ oldLeafId: "a1", newLeafId: "rewound-head" },
			ctx,
		);
		releaseStartAuto?.();
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(state.status, "idle");
		assert.deepEqual(notifications, []);
	});

	it("session_tree suppresses stale auto-start status restore after rewind", async () => {
		const state = createRuntimeState();
		let branch = [
			msg("u1", { role: "user", content: "future" }),
			msg("a1", { role: "assistant", content: "future answer" }),
		];
		let startAutoStarted = false;
		let releaseStartAuto: (() => void) | undefined;
		const startAutoGate = new Promise<void>((resolve) => {
			releaseStartAuto = resolve;
		});
		const statuses: Array<string | undefined> = [];
		const handlers: Partial<
			Record<
				"session_tree" | "turn_end",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_tree") handlers.session_tree = handler;
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state, {
			startAutoJob: async () => {
				startAutoStarted = true;
				await startAutoGate;
				return null;
			},
		});
		const ctx = {
			cwd: "/repo",
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
			},
			ui: {
				setStatus: (_key: string, text: string | undefined) => {
					statuses.push(text);
				},
				setWidget: () => undefined,
			},
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
			compact: () => undefined,
			isIdle: () => true,
			hasPendingMessages: () => false,
		};

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: {
					role: "assistant",
					content: "future answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			ctx,
		);
		await waitUntil(() => startAutoStarted, "stale start auto begins");
		branch = [
			msg("u0", { role: "user", content: "rewound" }),
			msg("rewound-head", {
				role: "assistant",
				content: "rewound branch head",
			}),
		];
		await handlers.session_tree?.(
			{ oldLeafId: "a1", newLeafId: "rewound-head" },
			ctx,
		);
		const statusCountAfterTree = statuses.length;
		releaseStartAuto?.();
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(statuses.length, statusCountAfterTree);
		assert.equal(state.status, "idle");
	});

	it("session_tree suppresses stale active summary callbacks after rewind", async () => {
		const state = createRuntimeState();
		let branch = [
			msg("u1", { role: "user", content: "future" }),
			msg("a1", { role: "assistant", content: "future answer" }),
		];
		let releaseSummary: ((summary: string) => void) | undefined;
		const summaryPromise = new Promise<string>((resolve) => {
			releaseSummary = resolve;
		});
		const statuses: Array<string | undefined> = [];
		const handlers: Partial<
			Record<
				"session_tree" | "turn_end",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_tree") handlers.session_tree = handler;
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state, {
			startAutoJob: async (input) => {
				const job: AutoJob = {
					artifactRoot: input.artifactRoot,
					sessionId: input.sessionId,
					cwd: input.cwd,
					projectId: input.cwd,
					snapshot: {
						sessionId: input.sessionId,
						cwd: input.cwd,
						triggerEntryId: "a1",
						firstKeptEntryId: "u1",
						tokensBefore: 100,
						summaryInputMessages: [],
						keptBoundary: { keepFromIndex: 0, firstKeptEntryId: "u1" },
						manifest: {
							filesRead: [],
							filesModified: [],
							filesDeleted: [],
							errors: [],
							userDecisions: [],
							constraints: [],
							openLoops: [],
							recentVerification: [],
							latestUpdates: [],
							retainedTailUpdates: [],
							latestExchangeState: [],
							terminalFinalAnswerEvidence: [],
							latestSignals: [],
							staleSignals: [],
							userAssertionTrail: [],
							criticalLiterals: [],
							previousSummary: null,
							artifactRefs: [],
							knownFileRefs: new Set<string>(),
						},
					},
					firstKeptEntryId: "u1",
					tokensBefore: 100,
					artifactDir: "/tmp/slipstream-tree-active-summary",
					summaryArtifactRefs: [],
					continuation: {
						appendTurn: () => undefined,
						isReady: () => false,
						snapshot: () => ({ triggerEntryId: "a1", turns: [] }),
					},
					summaryPromise,
					stats: autoJobStats(),
					finalizing: false,
				};
				input.state.autoJob = job;
				input.state.activePromise = summaryPromise;
				input.state.compactionWanted = false;
				input.state.status = "awaiting_continuation";
				return job;
			},
		});
		const ctx = {
			cwd: "/repo",
			model: { provider: "test", id: "model" },
			modelRegistry: {
				find: () => ({ provider: "test", id: "model" }),
				getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
			},
			ui: {
				setStatus: (_key: string, text: string | undefined) => {
					statuses.push(text);
				},
				setWidget: () => undefined,
			},
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
			compact: () => undefined,
			isIdle: () => true,
			hasPendingMessages: () => false,
		};

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: {
					role: "assistant",
					content: "future answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			ctx,
		);
		await waitUntil(
			() => state.status === "awaiting_continuation",
			"auto start registered active summary",
		);
		await new Promise((resolve) => setImmediate(resolve));
		branch = [
			msg("u0", { role: "user", content: "rewound" }),
			msg("rewound-head", {
				role: "assistant",
				content: "rewound branch head",
			}),
		];
		await handlers.session_tree?.(
			{ oldLeafId: "a1", newLeafId: "rewound-head" },
			ctx,
		);
		const statusCountAfterTree = statuses.length;
		releaseSummary?.("## Goal\nStale future summary");
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(statuses.length, statusCountAfterTree);
		assert.equal(state.status, "idle");
		assert.equal(state.autoJob, null);
		assert.equal(state.activePromise, null);
	});

	it("session_tree cancels deferred idle retry for prepared adoption", async () => {
		const state = createRuntimeState();
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady pending",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 8 }, artifacts: [] },
			expiresAt: Date.now() + 10_000,
		});
		let branch = [
			msg("u1", { role: "user", content: "current" }),
			msg("a1", { role: "assistant", content: "current answer" }),
		];
		let compactCalls = 0;
		const handlers: Partial<
			Record<
				"session_tree" | "turn_end",
				(event: unknown, ctx: unknown) => Promise<void> | void
			>
		> = {};
		const pi = {
			on: (
				event: string,
				handler: (event: unknown, ctx: unknown) => Promise<void> | void,
			) => {
				if (event === "session_tree") handlers.session_tree = handler;
				if (event === "turn_end") handlers.turn_end = handler;
			},
		} as unknown as Parameters<typeof registerLifecycle>[0];

		registerLifecycle(pi, config(), state);
		const ctx = {
			cwd: "/repo",
			ui: { setStatus: () => undefined, setWidget: () => undefined },
			sessionManager: {
				getSessionId: () => "s1",
				getBranch: () => branch,
			},
			getContextUsage: () => ({ tokens: 60_000, contextWindow: 100_000 }),
			compact: () => {
				compactCalls += 1;
			},
			isIdle: () => false,
			hasPendingMessages: () => false,
		};

		await handlers.turn_end?.(
			{
				turnIndex: 1,
				message: {
					role: "assistant",
					content: "current answer",
					stopReason: "stop",
				},
				toolResults: [],
			},
			ctx,
		);
		await new Promise((resolve) => setImmediate(resolve));
		branch = [
			msg("u0", { role: "user", content: "rewound" }),
			msg("rewound-head", {
				role: "assistant",
				content: "rewound branch head",
			}),
		];
		await handlers.session_tree?.(
			{ oldLeafId: "a1", newLeafId: "rewound-head" },
			ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 80));

		assert.equal(compactCalls, 0);
		assert.equal(state.pending, null);
		assert.equal(state.status, "idle");
	});
});
