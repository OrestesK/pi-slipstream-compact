import { ArtifactStore } from "./artifact-store.ts";
import {
	persistPendingArtifact,
	schedulePendingExpiryCleanup,
} from "./commands.ts";
import { resolveMaxConversationChars } from "./config.ts";
import { ContinuationBuffer } from "./continuation.ts";
import { buildJudgePrompt, isAccepted } from "./judge.ts";
import { buildRepairPrompt } from "./repair.ts";
import { isPendingExpired, storePendingValidated } from "./session-state.ts";
import { buildSnapshotAsync } from "./snapshot.ts";
import {
	collectStateEvidenceWithRaw,
	type ExecuteGitFn,
} from "./state-evidence.ts";
import {
	buildSummaryPrompt,
	isDegenerateCandidateSummary,
	withCurrentStateCapsule,
} from "./summary.ts";
import type { SlipstreamConfig } from "./config.ts";
import type {
	AgentMessage,
	AutoJob,
	CompleteJudgeFn,
	CompleteTextFn,
	ContextUsageSnapshot,
	JudgeCompletion,
	JudgeResult,
	ProgressSink,
	RuntimeState,
	SessionEntry,
} from "./types.ts";

export type ContextUsageLike = ContextUsageSnapshot;

export type StartAutoJobInput = {
	state: RuntimeState;
	config: SlipstreamConfig;
	branchEntries: SessionEntry[];
	sessionId: string;
	cwd: string;
	artifactRoot: string;
	completeSummary: CompleteTextFn;
	tokensBefore?: number | null;
	contextUsage?: ContextUsageSnapshot;
	executeGit?: ExecuteGitFn;
	onProgress?: ProgressSink;
	signal?: AbortSignal;
	isCurrent?: () => boolean;
};

export type FinalizeAutoJobInput = {
	state: RuntimeState;
	config: SlipstreamConfig;
	completeSummary: CompleteTextFn;
	completeJudge: CompleteJudgeFn;
	now: () => number;
	validatedThroughEntryId?: string | null;
	allowIncompleteContinuation?: boolean;
	onProgress?: ProgressSink;
	signal?: AbortSignal;
};

export function isAutoTriggerBoundary(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	if (
		Array.isArray(message.content) &&
		message.content.some((block) => block.type === "toolCall")
	)
		return false;
	return message.stopReason === "stop";
}

function elapsedMs(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}

function isJudgeCompletion(
	value: JudgeResult | JudgeCompletion,
): value is JudgeCompletion {
	return "result" in value;
}

function normalizeJudgeCompletion(
	completion: JudgeResult | JudgeCompletion,
): JudgeCompletion {
	return isJudgeCompletion(completion) ? completion : { result: completion };
}

function isJudgeParseError(judge: JudgeResult): boolean {
	return judge.judgeStatus === "parse_error";
}

function yieldBeforeHeavyAutoWork(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function contextPercent(
	usage: ContextUsageLike,
	config: SlipstreamConfig,
): number | null {
	if (
		typeof usage?.tokens === "number" &&
		typeof usage.contextWindow === "number"
	) {
		const effectiveLimit = usage.contextWindow - config.contextReserveTokens;
		if (effectiveLimit > 0) return usage.tokens / effectiveLimit;
	}
	if (typeof usage?.percent === "number") {
		return usage.percent >= 1 ? usage.percent / 100 : usage.percent;
	}
	return null;
}

type PendingFreshnessMatch = {
	sessionId?: string;
	cwd?: string;
	now?: number;
	validatedThroughEntryId?: string | null;
};

function clearMismatchedPending(
	state: RuntimeState,
	match?: PendingFreshnessMatch,
): void {
	if (!state.pending || state.status !== "ready_to_adopt") return;
	if (match?.now !== undefined && isPendingExpired(state.pending, match.now)) {
		state.pending = null;
		state.status = "idle";
		return;
	}
	if (match?.sessionId && state.pending.sessionId !== match.sessionId) {
		state.pending = null;
		state.status = "idle";
		return;
	}
	if (match?.cwd && state.pending.cwd !== match.cwd) {
		state.pending = null;
		state.status = "idle";
		return;
	}
}

export function shouldStartAutoJob(
	config: SlipstreamConfig,
	state: RuntimeState,
	usage: ContextUsageLike,
	match?: PendingFreshnessMatch,
): boolean {
	if (!config.enabled || !config.autoTrigger) return false;
	clearMismatchedPending(state, match);
	const percent = contextPercent(usage, config);
	if (typeof percent === "number" && percent >= config.triggerContextPercent)
		state.compactionWanted = true;
	if (state.pending || state.autoJob || state.activePromise) return false;
	return state.compactionWanted;
}

export function shouldActivatePreparedCompaction(
	config: SlipstreamConfig,
	state: RuntimeState,
	usage: ContextUsageLike,
	match?: PendingFreshnessMatch,
): boolean {
	void usage;
	if (!config.enabled || !config.autoTrigger || !state.pending) return false;
	if (state.status !== "ready_to_adopt") return false;
	clearMismatchedPending(state, match);
	if (!state.pending || state.status !== "ready_to_adopt") return false;
	if (
		match?.validatedThroughEntryId !== undefined &&
		match.validatedThroughEntryId !== null &&
		state.pending.validatedThroughEntryId !== match.validatedThroughEntryId
	)
		return false;
	return true;
}

export function shouldActivatePreparedCompactionOnTurn(
	config: SlipstreamConfig,
	state: RuntimeState,
	usage: ContextUsageLike,
	message: AgentMessage,
	match?: PendingFreshnessMatch,
): boolean {
	return (
		isAutoTriggerBoundary(message) &&
		shouldActivatePreparedCompaction(config, state, usage, match)
	);
}

type RuntimeReadiness = {
	isIdle?: (() => boolean) | boolean;
	hasPendingMessages?: (() => boolean) | boolean;
};

function readRuntimeFlag(
	value: (() => boolean) | boolean | undefined,
): boolean | undefined {
	return typeof value === "function" ? value() : value;
}

export function shouldTriggerPreparedCompactionNow(
	readiness: RuntimeReadiness,
): boolean {
	try {
		return (
			readRuntimeFlag(readiness.isIdle) === true &&
			readRuntimeFlag(readiness.hasPendingMessages) !== true
		);
	} catch {
		return false;
	}
}

export async function startAutoJob(
	input: StartAutoJobInput,
): Promise<AutoJob | null> {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const timingsMs = {
		snapshot: 0,
		artifacts: 0,
		stateEvidence: 0,
		summary: 0,
		judging: 0,
		repair: 0,
		total: 0,
	};
	input.onProgress?.({ phase: "snapshot", message: "Building auto snapshot" });
	await yieldBeforeHeavyAutoWork();
	const snapshotStartedAt = Date.now();
	const snapshot = await buildSnapshotAsync(
		{
			branchEntries: input.branchEntries,
			keepRecentTokens: input.config.slipstreamKeepRecentTokens,
			sessionId: input.sessionId,
			cwd: input.cwd,
			tokensBefore: input.tokensBefore ?? null,
		},
		{ signal: input.signal },
	);
	timingsMs.snapshot = elapsedMs(snapshotStartedAt);
	if (snapshot.summaryInputMessages.length === 0) {
		input.state.compactionWanted = false;
		return null;
	}
	const store = new ArtifactStore({ root: input.artifactRoot });
	input.onProgress?.({
		phase: "artifacts",
		message: "Creating auto artifact run",
	});
	const artifactsStartedAt = Date.now();
	const run = await store.createRun({
		sessionId: input.sessionId,
		triggerEntryId: snapshot.triggerEntryId,
		cwd: input.cwd,
	});
	await store.writeTriggerSnapshot(
		run,
		{
			messages: snapshot.summaryInputMessages,
			manifest: snapshot.manifest,
		},
		{ signal: input.signal },
	);
	timingsMs.artifacts = elapsedMs(artifactsStartedAt);
	input.onProgress?.({
		phase: "state-evidence",
		message: "Collecting auto state evidence",
	});
	const stateEvidenceStartedAt = Date.now();
	const collectedState = await collectStateEvidenceWithRaw({
		snapshot,
		cwd: input.cwd,
		executeGit: input.executeGit,
		signal: input.signal,
	});
	const gitSnapshot = await store.writeGitSnapshot(run, collectedState.rawGit);
	const stateEvidence = {
		...collectedState.evidence,
		git: {
			...collectedState.evidence.git,
			fullDiffArtifactPaths: input.config.retainArtifacts
				? gitSnapshot.diffChunkPaths
				: [],
			fullDiffPreserved: input.config.retainArtifacts
				? gitSnapshot.fullDiffPreserved
				: false,
		},
	};
	const stateArtifact = await store.writeStateEvidence(run, stateEvidence);
	timingsMs.stateEvidence = elapsedMs(stateEvidenceStartedAt);
	if (input.isCurrent?.() === false) {
		input.state.compactionWanted = false;
		if (!input.config.retainArtifacts) await store.removeRun(run.dir, input);
		return null;
	}
	const summaryArtifactRefs = input.config.retainArtifacts
		? [run.dir, stateArtifact.path]
		: [];
	const continuation = new ContinuationBuffer({
		minTurns: input.config.minContinuationTurns,
		maxTurns: input.config.maxContinuationTurns,
	});
	continuation.start(snapshot.triggerEntryId);
	const maxConversationChars = resolveMaxConversationChars(input.contextUsage);
	const summaryPromise = Promise.resolve().then(async () => {
		const summaryStartedAt = Date.now();
		input.onProgress?.({
			phase: "summary",
			message: "Starting auto candidate summary",
		});
		await yieldBeforeHeavyAutoWork();
		const summaryPrompt = buildSummaryPrompt(snapshot, {
			artifactRefs: summaryArtifactRefs,
			stateEvidence,
			maxConversationChars,
		});
		await store.writePromptMetrics(run, {
			kind: "summary-prompt",
			chars: summaryPrompt.length,
			maxConversationChars,
		});
		try {
			return await input.completeSummary(summaryPrompt, input.signal);
		} finally {
			timingsMs.summary = elapsedMs(summaryStartedAt);
		}
	});
	const job: AutoJob = {
		sessionId: input.sessionId,
		cwd: input.cwd,
		projectId: input.cwd,
		snapshot,
		firstKeptEntryId: snapshot.firstKeptEntryId,
		tokensBefore: snapshot.tokensBefore,
		artifactDir: run.dir,
		artifactRoot: input.artifactRoot,
		summaryArtifactRefs,
		continuation,
		summaryPromise,
		stateEvidence,
		maxConversationChars,
		stats: { startedAt, startedAtMs, timingsMs },
		finalizing: false,
	};
	input.state.autoJob = job;
	input.state.activePromise = summaryPromise;
	input.state.compactionWanted = false;
	input.state.lastArtifactDir = input.config.retainArtifacts ? run.dir : null;
	input.state.status = "awaiting_continuation";
	void summaryPromise.then(
		() => {
			if (input.state.activePromise === summaryPromise)
				input.state.activePromise = null;
		},
		() => {
			if (input.state.activePromise === summaryPromise)
				input.state.activePromise = null;
		},
	);
	return job;
}

export async function finalizeAutoJob(
	input: FinalizeAutoJobInput,
): Promise<boolean> {
	const job = input.state.autoJob;
	if (!job || job.finalizing) return false;
	if (!job.continuation.isReady() && !input.allowIncompleteContinuation)
		return false;
	job.finalizing = true;
	input.state.status = "finalizing_summary";
	input.onProgress?.({
		phase: "finalizing-summary",
		message: "Waiting for auto summary to finish",
	});
	const isInvalidated = (): boolean => input.state.autoJob !== job;
	const store = new ArtifactStore({
		root: job.artifactRoot,
		statsFullPaths: input.config.statsFullPaths,
	});
	const run = {
		id: "final",
		dir: job.artifactDir,
		sessionId: job.sessionId,
		triggerEntryId: null,
		cwd: job.cwd,
	};
	try {
		const writeStats = async (
			outcome: "accepted" | "rejected" | "failed",
			accepted: boolean,
			repaired: boolean,
			judge: { score: number; decision: string } | null,
		): Promise<void> => {
			job.stats.timingsMs.total = elapsedMs(job.stats.startedAtMs);
			try {
				await store.writeStats(run, {
					schemaVersion: 1,
					mode: "auto",
					outcome,
					accepted,
					repaired,
					startedAt: job.stats.startedAt,
					completedAt: new Date().toISOString(),
					sessionId: job.sessionId,
					cwd: job.cwd,
					artifactDir: job.artifactDir,
					tokensBefore: job.tokensBefore,
					judgeScore: judge?.score ?? null,
					judgeDecision: judge?.decision ?? null,
					timingsMs: { ...job.stats.timingsMs },
				});
			} catch {
				// Performance telemetry is optional and must not block compaction.
			}
		};
		let generatedSummary = await job.summaryPromise;
		if (isInvalidated()) return false;
		await yieldBeforeHeavyAutoWork();
		let summary = withCurrentStateCapsule(
			generatedSummary,
			job.snapshot,
			job.summaryArtifactRefs,
		);
		await store.writeCandidate(run, summary);
		if (isInvalidated()) return false;
		const continuation = job.continuation.snapshot();
		const continuationHasRequiredTurns =
			continuation.turns.length >= input.config.minContinuationTurns;
		if (isInvalidated()) return false;
		await store.writeContinuation(run, continuation);
		if (isInvalidated()) return false;
		if (isDegenerateCandidateSummary(generatedSummary)) {
			const judge = {
				score: 0,
				decision: "reject" as const,
				missing: ["Auto candidate summary was empty or heading-only"],
				contradictions: [],
				diagnosis:
					"Slipstream auto candidate generation returned an empty or heading-only summary; refusing repair because there is no substantive summary to repair or rewrite.",
			};
			await store.writeJudgeResult(run, judge);
			if (isInvalidated()) return false;
			await writeStats("rejected", false, false, judge);
			if (isInvalidated()) return false;
			input.state.lastJudge = judge;
			input.state.autoJob = null;
			input.state.status = "rejected";
			input.onProgress?.({
				phase: "rejected",
				message: judge.diagnosis,
			});
			return false;
		}
		const judgeSnapshot = {
			...job.snapshot,
			manifest: {
				...job.snapshot.manifest,
				artifactRefs: input.config.retainArtifacts
					? [...job.snapshot.manifest.artifactRefs, job.artifactDir]
					: job.snapshot.manifest.artifactRefs,
			},
		};
		const completeJudgeWithRetry = async (
			promptInput: Parameters<typeof buildJudgePrompt>[0],
			message: string,
		): Promise<JudgeResult | null> => {
			input.state.status = "judging";
			input.onProgress?.({ phase: "judging", message });
			await yieldBeforeHeavyAutoWork();
			const judgePrompt = buildJudgePrompt(promptInput);
			await store.writePromptMetrics(run, {
				kind: "judge-prompt",
				chars: judgePrompt.length,
			});
			if (isInvalidated()) return null;
			const completion = normalizeJudgeCompletion(
				await input.completeJudge(judgePrompt, input.signal),
			);
			if (completion.rawText && isJudgeParseError(completion.result)) {
				await store.writeJudgeRawResponse(run, {
					attempt: "auto-initial",
					rawText: completion.rawText,
				});
			}
			if (isInvalidated()) return null;
			if (!isJudgeParseError(completion.result)) return completion.result;

			input.onProgress?.({
				phase: "judging",
				message:
					"Retrying auto judge after parse_error with minimized continuation evidence",
				lastScore: completion.result.score,
			});
			await yieldBeforeHeavyAutoWork();
			const retryPrompt = buildJudgePrompt(promptInput, {
				continuationMaxChars: 1_000,
			});
			await store.writePromptMetrics(run, {
				kind: "judge-retry-prompt",
				chars: retryPrompt.length,
			});
			if (isInvalidated()) return null;
			const retry = normalizeJudgeCompletion(
				await input.completeJudge(retryPrompt, input.signal),
			);
			if (retry.rawText && isJudgeParseError(retry.result)) {
				await store.writeJudgeRawResponse(run, {
					attempt: "auto-retry",
					rawText: retry.rawText,
				});
			}
			if (isInvalidated()) return null;
			return retry.result;
		};

		const judgingStartedAt = Date.now();
		const initialJudge = await completeJudgeWithRetry(
			{
				candidateSummary: summary,
				snapshot: judgeSnapshot,
				continuation,
				artifactRefs: job.summaryArtifactRefs,
				stateEvidence: job.stateEvidence,
			},
			"Judging auto candidate summary",
		);
		if (!initialJudge) return false;
		let judge = initialJudge;
		job.stats.timingsMs.judging = elapsedMs(judgingStartedAt);
		const threshold = input.config.judgeThreshold;
		let bestAcceptedSummary = isAccepted(judge, threshold, summary)
			? summary
			: null;
		let bestAcceptedJudge = isAccepted(judge, threshold, summary)
			? judge
			: null;
		let repaired = false;
		const repairStartedAt = Date.now();
		for (
			let attempt = 0;
			attempt < input.config.repairAttempts &&
			!isJudgeParseError(judge) &&
			!isAccepted(judge, threshold, summary);
			attempt += 1
		) {
			input.state.status = "repairing";
			input.onProgress?.({
				phase: "repairing",
				message: `Auto repair attempt ${attempt + 1}/${input.config.repairAttempts}`,
				lastScore: judge.score,
			});
			await yieldBeforeHeavyAutoWork();
			const repairedGeneratedSummary = await input.completeSummary(
				buildRepairPrompt(summary, judge, {
					artifactRefs: job.summaryArtifactRefs,
					stateEvidence: job.stateEvidence,
					continuation,
				}),
				input.signal,
			);
			if (isInvalidated()) return false;
			repaired = true;
			if (isDegenerateCandidateSummary(repairedGeneratedSummary)) {
				input.onProgress?.({
					phase: "repairing",
					message:
						"Slipstream auto repair returned an empty or heading-only summary; retaining the previous substantive candidate and trying remaining repairs.",
					lastScore: judge.score,
				});
				continue;
			}
			generatedSummary = repairedGeneratedSummary;
			summary = withCurrentStateCapsule(
				generatedSummary,
				job.snapshot,
				job.summaryArtifactRefs,
			);
			await store.writeCandidate(run, summary);
			if (isInvalidated()) return false;
			const repairedJudge = await completeJudgeWithRetry(
				{
					candidateSummary: summary,
					snapshot: judgeSnapshot,
					continuation,
					artifactRefs: job.summaryArtifactRefs,
					stateEvidence: job.stateEvidence,
				},
				"Judging repaired auto summary",
			);
			if (!repairedJudge) return false;
			judge = repairedJudge;
			if (
				isAccepted(judge, threshold, summary) &&
				(bestAcceptedJudge === null || judge.score > bestAcceptedJudge.score)
			) {
				bestAcceptedSummary = summary;
				bestAcceptedJudge = judge;
			}
		}
		if (repaired) job.stats.timingsMs.repair = elapsedMs(repairStartedAt);
		if (bestAcceptedSummary !== null && bestAcceptedJudge !== null) {
			summary = bestAcceptedSummary;
			judge = bestAcceptedJudge;
		}
		if (isInvalidated()) return false;
		await store.writeJudgeResult(run, judge);
		if (isInvalidated()) return false;
		const accepted = isAccepted(judge, input.config.judgeThreshold, summary);
		if (!job.firstKeptEntryId) {
			await writeStats("rejected", accepted, repaired, judge);
			if (isInvalidated()) return false;
			input.state.lastJudge = judge;
			input.state.autoJob = null;
			input.state.status = "rejected";
			input.onProgress?.({
				phase: "rejected",
				message: `Auto Slipstream could not prepare compaction: ${judge.diagnosis || "score " + judge.score}`,
			});
			return false;
		}
		input.onProgress?.({
			phase: accepted ? "accepted" : "rejected",
			message: accepted
				? `Auto Slipstream accepted summary with score ${judge.score}`
				: `Auto Slipstream rejected summary with score ${judge.score}: ${judge.diagnosis || "below threshold"}`,
		});
		if (!accepted && input.config.rejectedSummaryMode === "reject") {
			await writeStats("rejected", false, repaired, judge);
			if (isInvalidated()) return false;
			input.state.lastJudge = judge;
			input.state.autoJob = null;
			input.state.status = "rejected";
			return false;
		}
		const pending = {
			sessionId: job.sessionId,
			cwd: job.cwd,
			projectId: job.projectId,
			summary,
			firstKeptEntryId: job.firstKeptEntryId,
			validatedThroughEntryId: continuationHasRequiredTurns
				? (input.validatedThroughEntryId ?? continuation.triggerEntryId)
				: continuation.triggerEntryId,
			tokensBefore: job.tokensBefore,
			details: {
				judge,
				...(input.config.retainArtifacts
					? { artifacts: [job.artifactDir] }
					: {}),
				auto: true,
				rejectedSummaryAccepted: !accepted,
				rejectedSummaryMode: input.config.rejectedSummaryMode,
			},
			artifactDir: job.artifactDir,
			expiresAt: input.now() + input.config.pendingTtlMs,
		};
		await persistPendingArtifact(job.artifactDir, pending);
		if (isInvalidated()) return false;
		storePendingValidated(input.state, pending);
		schedulePendingExpiryCleanup(
			input.state,
			pending,
			job.artifactRoot,
			input.config.retainArtifacts,
			input.now,
		);
		await store.writeAdoptionRecord(run, {
			firstKeptEntryId: job.firstKeptEntryId,
			tokensBefore: job.tokensBefore,
			judge,
		});
		await writeStats(
			accepted ? "accepted" : "rejected",
			accepted,
			repaired,
			judge,
		);
		if (isInvalidated()) return false;
		input.state.autoJob = null;
		return true;
	} catch (error) {
		if (isInvalidated()) return false;
		if (input.state.autoJob === job) input.state.autoJob = null;
		input.state.status = "failed";
		throw error;
	} finally {
		job.finalizing = false;
		if (
			!input.config.retainArtifacts &&
			input.state.pending?.artifactDir !== job.artifactDir
		)
			await store.removeRun(job.artifactDir, job);
	}
}
