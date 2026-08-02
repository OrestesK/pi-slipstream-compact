import { ArtifactStore } from "./artifact-store.ts";
import { resolveMaxConversationChars } from "./config.ts";
import { buildJudgePrompt, isAccepted } from "./judge.ts";
import { buildRepairPrompt } from "./repair.ts";
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
import type {
	CompleteJudgeFn,
	CompleteTextFn,
	ContextUsageSnapshot,
	ContinuationSnapshot,
	JudgeCompletion,
	JudgeResult,
	ProgressSink,
	SessionEntry,
} from "./types.ts";

export type DryRunInput = {
	branchEntries: SessionEntry[];
	sessionId: string;
	cwd: string;
	artifactRoot: string;
	firstKeptEntryId?: string | null;
	keepRecentTokens?: number;
	tokensBefore?: number | null;
	contextUsage?: ContextUsageSnapshot;
	executeGit?: ExecuteGitFn;
	statsFullPaths?: boolean;
	retainArtifacts: boolean;
	onProgress?: ProgressSink;
	signal?: AbortSignal;
};
export type DryRunResult = {
	mode: "dry-run";
	accepted: false;
	artifactDir: string;
	candidatePrompt: string;
};

export type ValidatedRunInput = DryRunInput & {
	continuation: ContinuationSnapshot;
	completeSummary: CompleteTextFn;
	completeJudge: CompleteJudgeFn;
	judgeThreshold?: number;
	repairAttempts?: number;
	signal?: AbortSignal;
};
export type ValidatedRunResult = {
	mode: "validated";
	accepted: boolean;
	repaired: boolean;
	artifactDir: string;
	summary: string;
	judge: JudgeResult;
	firstKeptEntryId: string | null;
	tokensBefore: number | null;
};

function yieldBeforeHeavyCompactionWork(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
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

export async function runSlipstreamDryRun(
	input: DryRunInput,
): Promise<DryRunResult> {
	input.onProgress?.({
		phase: "snapshot",
		message: "Building deterministic snapshot",
	});
	await yieldBeforeHeavyCompactionWork();
	const snapshot = await buildSnapshotAsync(
		{
			branchEntries: input.branchEntries,
			firstKeptEntryId: input.firstKeptEntryId,
			keepRecentTokens: input.keepRecentTokens,
			sessionId: input.sessionId,
			cwd: input.cwd,
			tokensBefore: input.tokensBefore ?? null,
		},
		{ signal: input.signal },
	);
	const store = new ArtifactStore({
		root: input.artifactRoot,
		statsFullPaths: input.statsFullPaths,
	});
	input.onProgress?.({
		phase: "artifacts",
		message: "Creating compaction artifact run",
	});
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
	input.onProgress?.({
		phase: "state-evidence",
		message: "Collecting read-only state evidence",
	});
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
			fullDiffArtifactPaths: input.retainArtifacts
				? gitSnapshot.diffChunkPaths
				: [],
			fullDiffPreserved: input.retainArtifacts
				? gitSnapshot.fullDiffPreserved
				: false,
		},
	};
	const stateArtifact = await store.writeStateEvidence(run, stateEvidence);
	input.onProgress?.({
		phase: "summary",
		message: "Building candidate summary prompt",
	});
	const candidatePrompt = buildSummaryPrompt(snapshot, {
		artifactRefs: input.retainArtifacts ? [run.dir, stateArtifact.path] : [],
		stateEvidence,
		maxConversationChars: resolveMaxConversationChars(input.contextUsage),
	});
	await store.writePromptMetrics(run, {
		kind: "summary-prompt",
		chars: candidatePrompt.length,
		maxConversationChars: resolveMaxConversationChars(input.contextUsage),
	});
	await store.writeTextArtifact(
		run,
		"candidate-prompt.md",
		candidatePrompt,
		"candidate-prompt",
	);
	return {
		mode: "dry-run",
		accepted: false,
		artifactDir: run.dir,
		candidatePrompt,
	};
}

export async function runValidatedSlipstream(
	input: ValidatedRunInput,
): Promise<ValidatedRunResult> {
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
	input.onProgress?.({
		phase: "snapshot",
		message: "Building deterministic snapshot",
	});
	await yieldBeforeHeavyCompactionWork();
	const snapshotStartedAt = Date.now();
	const snapshot = await buildSnapshotAsync(
		{
			branchEntries: input.branchEntries,
			firstKeptEntryId: input.firstKeptEntryId,
			keepRecentTokens: input.keepRecentTokens,
			sessionId: input.sessionId,
			cwd: input.cwd,
			tokensBefore: input.tokensBefore ?? null,
		},
		{ signal: input.signal },
	);
	timingsMs.snapshot = elapsedMs(snapshotStartedAt);
	const store = new ArtifactStore({
		root: input.artifactRoot,
		statsFullPaths: input.statsFullPaths,
	});
	input.onProgress?.({
		phase: "artifacts",
		message: "Creating compaction artifact run",
	});
	const artifactsStartedAt = Date.now();
	const run = await store.createRun({
		sessionId: input.sessionId,
		triggerEntryId: snapshot.triggerEntryId,
		cwd: input.cwd,
	});
	const writeStats = async (
		outcome: "accepted" | "rejected" | "failed",
		accepted: boolean,
		repaired: boolean,
		judge: JudgeResult | null,
	): Promise<void> => {
		timingsMs.total = elapsedMs(startedAtMs);
		try {
			await store.writeStats(run, {
				schemaVersion: 1,
				mode: "compact",
				outcome,
				accepted,
				repaired,
				startedAt,
				completedAt: new Date().toISOString(),
				sessionId: input.sessionId,
				cwd: input.cwd,
				artifactDir: run.dir,
				tokensBefore: snapshot.tokensBefore,
				judgeScore: judge?.score ?? null,
				judgeDecision: judge?.decision ?? null,
				timingsMs: { ...timingsMs },
			});
		} catch {
			// Performance telemetry is optional and must not block compaction.
		}
	};
	await store.writeTriggerSnapshot(
		run,
		{
			messages: snapshot.summaryInputMessages,
			manifest: snapshot.manifest,
		},
		{ signal: input.signal },
	);
	await store.writeContinuation(run, input.continuation);
	timingsMs.artifacts = elapsedMs(artifactsStartedAt);
	input.onProgress?.({
		phase: "state-evidence",
		message: "Collecting read-only state evidence",
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
			fullDiffArtifactPaths: input.retainArtifacts
				? gitSnapshot.diffChunkPaths
				: [],
			fullDiffPreserved: input.retainArtifacts
				? gitSnapshot.fullDiffPreserved
				: false,
		},
	};
	const stateArtifact = await store.writeStateEvidence(run, stateEvidence);
	timingsMs.stateEvidence = elapsedMs(stateEvidenceStartedAt);

	input.onProgress?.({
		phase: "summary",
		message: "Generating candidate summary",
	});
	await yieldBeforeHeavyCompactionWork();
	const summaryArtifactRefs = input.retainArtifacts
		? [run.dir, stateArtifact.path]
		: [];
	const summaryMaxConversationChars = resolveMaxConversationChars(
		input.contextUsage,
	);
	const summaryPrompt = buildSummaryPrompt(snapshot, {
		artifactRefs: summaryArtifactRefs,
		stateEvidence,
		maxConversationChars: summaryMaxConversationChars,
	});
	await store.writePromptMetrics(run, {
		kind: "summary-prompt",
		chars: summaryPrompt.length,
		maxConversationChars: summaryMaxConversationChars,
	});
	const summaryStartedAt = Date.now();
	let generatedSummary = await input.completeSummary(
		summaryPrompt,
		input.signal,
	);
	let summary = withCurrentStateCapsule(
		generatedSummary,
		snapshot,
		summaryArtifactRefs,
	);
	await store.writeCandidate(run, summary);
	if (isDegenerateCandidateSummary(generatedSummary)) {
		input.onProgress?.({
			phase: "summary",
			message: "Candidate summary was empty; regenerating once before judging",
		});
		await yieldBeforeHeavyCompactionWork();
		generatedSummary = await input.completeSummary(
			`${summaryPrompt}\n\nThe previous candidate summary was empty or heading-only. Regenerate a complete continuation checkpoint now. Include the required sections, preserve active/current facts needed for safe continuation, and mark stale or superseded context instead of restating it as current.`,
			input.signal,
		);
		summary = withCurrentStateCapsule(
			generatedSummary,
			snapshot,
			summaryArtifactRefs,
		);
		await store.writeCandidate(run, summary);
	}
	timingsMs.summary = elapsedMs(summaryStartedAt);
	if (isDegenerateCandidateSummary(generatedSummary)) {
		const judge: JudgeResult = {
			score: 0,
			decision: "reject",
			missing: [
				"Candidate summary was empty or heading-only after regeneration",
			],
			contradictions: [],
			diagnosis:
				"Slipstream candidate generation returned an empty or heading-only summary twice; refusing repair because there is no substantive summary to rewrite.",
		};
		await store.writeJudgeResult(run, judge);
		await writeStats("rejected", false, false, judge);
		input.onProgress?.({
			phase: "rejected",
			message: judge.diagnosis,
		});
		return {
			mode: "validated",
			accepted: false,
			repaired: false,
			artifactDir: run.dir,
			summary,
			judge,
			firstKeptEntryId: null,
			tokensBefore: snapshot.tokensBefore,
		};
	}
	const completeJudgeWithRetry = async (
		promptInput: Parameters<typeof buildJudgePrompt>[0],
		message: string,
	): Promise<JudgeResult> => {
		input.onProgress?.({
			phase: "judging",
			message,
		});
		await yieldBeforeHeavyCompactionWork();
		const judgePrompt = buildJudgePrompt(promptInput);
		await store.writePromptMetrics(run, {
			kind: "judge-prompt",
			chars: judgePrompt.length,
		});
		const completion = normalizeJudgeCompletion(
			await input.completeJudge(judgePrompt, input.signal),
		);
		if (completion.rawText && isJudgeParseError(completion.result)) {
			await store.writeJudgeRawResponse(run, {
				attempt: "initial",
				rawText: completion.rawText,
			});
		}
		if (!isJudgeParseError(completion.result)) return completion.result;

		input.onProgress?.({
			phase: "judging",
			message:
				"Retrying judge after parse_error with minimized continuation evidence",
			lastScore: completion.result.score,
		});
		await yieldBeforeHeavyCompactionWork();
		const retryPrompt = buildJudgePrompt(promptInput, {
			continuationMaxChars: 1_000,
		});
		await store.writePromptMetrics(run, {
			kind: "judge-retry-prompt",
			chars: retryPrompt.length,
		});
		const retry = normalizeJudgeCompletion(
			await input.completeJudge(retryPrompt, input.signal),
		);
		if (retry.rawText && isJudgeParseError(retry.result)) {
			await store.writeJudgeRawResponse(run, {
				attempt: "retry",
				rawText: retry.rawText,
			});
		}
		return retry.result;
	};

	const judgingStartedAt = Date.now();
	let judge = await completeJudgeWithRetry(
		{
			candidateSummary: summary,
			snapshot,
			continuation: input.continuation,
			artifactRefs: summaryArtifactRefs,
			stateEvidence,
		},
		"Judging candidate summary",
	);
	timingsMs.judging = elapsedMs(judgingStartedAt);
	let repaired = false;
	const threshold = input.judgeThreshold ?? 7;
	const repairAttempts = input.repairAttempts ?? 1;
	let bestAcceptedSummary = isAccepted(judge, threshold, summary)
		? summary
		: null;
	let bestAcceptedJudge = isAccepted(judge, threshold, summary) ? judge : null;
	const repairStartedAt = Date.now();

	for (
		let attempt = 0;
		attempt < repairAttempts &&
		!isJudgeParseError(judge) &&
		!isAccepted(judge, threshold, summary);
		attempt += 1
	) {
		input.onProgress?.({
			phase: "repairing",
			message: `Repair attempt ${attempt + 1}/${repairAttempts}`,
			lastScore: judge.score,
		});
		await yieldBeforeHeavyCompactionWork();
		const repairedSummary = await input.completeSummary(
			buildRepairPrompt(summary, judge, {
				artifactRefs: summaryArtifactRefs,
				stateEvidence,
				continuation: input.continuation,
			}),
			input.signal,
		);
		repaired = true;
		if (isDegenerateCandidateSummary(repairedSummary)) {
			input.onProgress?.({
				phase: "repairing",
				message:
					"Slipstream repair returned an empty or heading-only summary; retaining the previous substantive candidate and trying remaining repairs.",
				lastScore: judge.score,
			});
			continue;
		}
		generatedSummary = repairedSummary;
		summary = withCurrentStateCapsule(
			generatedSummary,
			snapshot,
			summaryArtifactRefs,
		);
		await store.writeCandidate(run, summary);
		judge = await completeJudgeWithRetry(
			{
				candidateSummary: summary,
				snapshot,
				continuation: input.continuation,
				artifactRefs: summaryArtifactRefs,
				stateEvidence,
			},
			"Judging repaired summary",
		);
		if (
			isAccepted(judge, threshold, summary) &&
			(bestAcceptedJudge === null || judge.score > bestAcceptedJudge.score)
		) {
			bestAcceptedSummary = summary;
			bestAcceptedJudge = judge;
		}
	}
	if (repaired) timingsMs.repair = elapsedMs(repairStartedAt);

	if (bestAcceptedSummary !== null && bestAcceptedJudge !== null) {
		summary = bestAcceptedSummary;
		judge = bestAcceptedJudge;
	}
	await store.writeJudgeResult(run, judge);
	const accepted = isAccepted(judge, threshold, summary);
	input.onProgress?.({
		phase: accepted ? "accepted" : "rejected",
		message: accepted
			? `Slipstream accepted summary with score ${judge.score}`
			: `Slipstream rejected summary after repair attempts: ${judge.diagnosis || "score " + judge.score}`,
	});
	if (accepted)
		await store.writeAdoptionRecord(run, {
			firstKeptEntryId: snapshot.firstKeptEntryId,
			tokensBefore: snapshot.tokensBefore,
			judge,
		});
	await writeStats(
		accepted ? "accepted" : "rejected",
		accepted,
		repaired,
		judge,
	);
	return {
		mode: "validated",
		accepted,
		repaired,
		artifactDir: run.dir,
		summary,
		judge,
		firstKeptEntryId: snapshot.firstKeptEntryId,
		tokensBefore: snapshot.tokensBefore,
	};
}
