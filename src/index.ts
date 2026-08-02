import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionTreeEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	finalizeAutoJob,
	isAutoTriggerBoundary,
	shouldActivatePreparedCompaction,
	shouldStartAutoJob,
	shouldTriggerPreparedCompactionNow,
	startAutoJob,
} from "./auto.ts";
import type { FinalizeAutoJobInput } from "./auto.ts";
import { buildContinuationFromBranch } from "./continuation.ts";
import { loadSettings } from "./config.ts";
import {
	acceptRejectedSummaryByPolicy,
	disposePendingArtifact,
	handleSlipstreamCommand,
	persistPendingArtifact,
	recoverPendingArtifact,
	removeArtifactRun,
	resolveArtifactRoot,
	schedulePendingExpiryCleanup,
} from "./commands.ts";
import {
	runValidatedSlipstream,
	type ValidatedRunInput,
	type ValidatedRunResult,
} from "./pipeline.ts";
import { createJudgeCompleter, createSummaryCompleter } from "./model.ts";
import {
	claimProgressOwner,
	clearActiveProgressOwner,
	consumePendingForCompaction,
	createRuntimeState,
	hasActiveProgressOwner,
	isPendingExpired,
	activeSlipstreamCompactionRequest,
	clearSlipstreamCompactionRequest,
	ownsProgress,
	releaseProgressOwner,
	requestSlipstreamCompaction,
	storePendingValidated,
} from "./session-state.ts";
import type { ProgressEvent, ProgressSink, RuntimeState } from "./types.ts";
import type { SlipstreamConfig } from "./config.ts";
import { clearSlipstreamWidget, updateSlipstreamWidget } from "./ui.ts";
import type { SessionEntry } from "./types.ts";

type SlipstreamContext = {
	cwd: string;
	model?: { provider: string; id: string };
	modelRegistry?: {
		find(
			provider: string,
			id: string,
		): { provider: string; id: string } | undefined;
		getApiKeyAndHeaders(model: { provider: string; id: string }): Promise<{
			ok?: boolean;
			error?: string;
			apiKey?: string;
			headers?: Record<string, string>;
		}>;
	};
	ui?: {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		setStatus?(key: string, text: string | undefined): void;
		setWidget?(
			key: string,
			lines: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
		confirm?(
			title: string,
			message: string,
			options?: { timeout?: number; signal?: AbortSignal },
		): boolean | Promise<boolean>;
	};
	sessionManager: { getSessionId?(): string; getBranch(): SessionEntry[] };
	getContextUsage?():
		| { tokens: number | null; percent?: number | null; contextWindow?: number }
		| undefined;
	signal?: AbortSignal;
	compact?(options?: {
		customInstructions?: string;
		onComplete?: (result: unknown) => void;
		onError?: (error: Error) => void;
	}): void;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
};

type PiContext = ExtensionContext | ExtensionCommandContext | SlipstreamContext;
type LocalSessionEntry = SessionEntry;
type RunValidatedSlipstream = (
	input: ValidatedRunInput,
) => Promise<ValidatedRunResult>;
type LocalCompactEvent = Partial<
	Omit<SessionBeforeCompactEvent, "preparation" | "branchEntries">
> & {
	preparation: { firstKeptEntryId: string; tokensBefore: number };
	branchEntries?: LocalSessionEntry[];
};
type HookCompactionResult = {
	compaction?: {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
		details: Record<string, unknown>;
	};
	cancel?: boolean;
};

type DefaultCompactionDeps = {
	createSummaryCompleter?: typeof createSummaryCompleter;
	createJudgeCompleter?: typeof createJudgeCompleter;
};

function ignoreStaleContextError(error: unknown): void {
	if (
		error instanceof Error &&
		error.message.includes("extension ctx is stale")
	)
		return;
	throw error;
}

function safeNotify(
	ctx: PiContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	try {
		ctx.ui?.notify(message, type);
	} catch (error) {
		ignoreStaleContextError(error);
	}
}

function yieldForUiPaint(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function progressStep(phase: ProgressEvent["phase"]): string {
	switch (phase) {
		case "snapshot":
			return "1/5 snapshot";
		case "artifacts":
			return "2/5 artifacts";
		case "state-evidence":
			return "3/5 state";
		case "summary":
			return "4/5 summary";
		case "finalizing-summary":
			return "4/5 waiting";
		case "judging":
			return "5/5 judge";
		case "repairing":
			return "repair";
		case "accepted":
			return "accepted";
		case "rejected":
			return "rejected";
	}
}

function persistentStatusText(state: RuntimeState): string {
	if (state.status === "ready_to_adopt") return "slipstream: pending";
	if (state.status === "awaiting_continuation")
		return "slipstream: auto awaiting continuation";
	if (state.status === "summarizing") return "slipstream: compacting";
	if (state.status === "finalizing_summary")
		return "slipstream: waiting for auto summary";
	if (state.status === "judging" || state.status === "repairing")
		return `slipstream: ${state.status}`;
	return "slipstream: manual";
}

function restorePersistentStatus(
	ctx: PiContext,
	state: RuntimeState,
	config: SlipstreamConfig,
): void {
	if (hasActiveProgressOwner(state)) return;
	try {
		ctx.ui?.setStatus?.("slipstream", persistentStatusText(state));
	} catch (error) {
		ignoreStaleContextError(error);
	}
	updateSlipstreamWidget(ctx, state, config);
}

type ManagedProgressSink = ProgressSink & { clear(): void };

function makeProgressSink(
	ctx: PiContext,
	mode: "auto" | "compact",
	state: RuntimeState,
	config: SlipstreamConfig,
): ManagedProgressSink {
	let owner: symbol;
	let current: ProgressEvent | null = null;
	let phaseStartedAt = Date.now();
	let lastStatusText: string | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	const stop = (): void => {
		if (timer) clearInterval(timer);
		timer = null;
		current = null;
		lastStatusText = null;
	};
	const clear = (): void => {
		const shouldClearWidget = releaseProgressOwner(state, owner);
		stop();
		if (shouldClearWidget) clearSlipstreamWidget(ctx);
	};
	owner = claimProgressOwner(state, "lifecycle", clear);
	const render = (): void => {
		if (!current) return;
		if (!ownsProgress(state, owner)) {
			stop();
			return;
		}
		const event = { ...current, elapsedMs: Date.now() - phaseStartedAt };
		const statusText = `slipstream: ${mode} ${progressStep(event.phase)} — ${event.message}`;
		try {
			if (statusText !== lastStatusText) {
				ctx.ui?.setStatus?.("slipstream", statusText);
				lastStatusText = statusText;
			}
			updateSlipstreamWidget(ctx, state, config, { progress: event });
		} catch (error) {
			ignoreStaleContextError(error);
		}
		if (mode === "auto" && current.phase === "summary" && !state.activePromise)
			clear();
	};
	const sink = ((event: ProgressEvent): void => {
		if (!current || current.phase !== event.phase) phaseStartedAt = Date.now();
		current = event;
		render();
		if (event.phase === "accepted" || event.phase === "rejected") {
			clear();
			return;
		}
		if (!timer) timer = setInterval(render, 1_000);
	}) as ManagedProgressSink;
	sink.clear = clear;
	return sink;
}

export async function buildDefaultSlipstreamCompaction(
	event: LocalCompactEvent,
	ctx: PiContext,
	config: SlipstreamConfig,
	state: RuntimeState,
	onProgress: (event: ProgressEvent) => void,
	deps: DefaultCompactionDeps = {},
): Promise<HookCompactionResult | undefined> {
	if (!config.enabled) return undefined;
	if (!ctx.modelRegistry) {
		safeNotify(
			ctx,
			"Slipstream default compaction cancelled: no model registry is available.",
			"error",
		);
		return { cancel: true };
	}
	const branchEntries = (event.branchEntries ??
		ctx.sessionManager.getBranch()) as unknown as LocalSessionEntry[];
	const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
	const cwd = ctx.cwd;
	const contextUsage = ctx.getContextUsage?.();
	const continuation = buildContinuationFromBranch(
		branchEntries,
		config.maxContinuationTurns,
	);
	if (continuation.turns.length < config.minContinuationTurns) {
		state.status = "rejected";
		safeNotify(
			ctx,
			`Slipstream default compaction cancelled: need at least ${config.minContinuationTurns} continuation turn(s), found ${continuation.turns.length}.`,
			"warning",
		);
		return { cancel: true };
	}
	const makeSummaryCompleter =
		deps.createSummaryCompleter ?? createSummaryCompleter;
	const makeJudgeCompleter = deps.createJudgeCompleter ?? createJudgeCompleter;
	const artifactRoot = await resolveArtifactRoot(cwd, config.artifactRoot);
	const result = await runValidatedSlipstream({
		branchEntries,
		sessionId,
		cwd,
		artifactRoot,
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		tokensBefore: event.preparation.tokensBefore,
		contextUsage,
		continuation,
		statsFullPaths: config.statsFullPaths,
		retainArtifacts: config.retainArtifacts,
		completeSummary: makeSummaryCompleter(
			{ model: ctx.model, modelRegistry: ctx.modelRegistry },
			config.summaryModel,
		),
		completeJudge: makeJudgeCompleter(
			{ model: ctx.model, modelRegistry: ctx.modelRegistry },
			config.judgeModel,
		),
		judgeThreshold: config.judgeThreshold,
		repairAttempts: config.repairAttempts,
		onProgress,
		signal: event.signal ?? ctx.signal,
	});
	state.lastArtifactDir = config.retainArtifacts ? result.artifactDir : null;
	state.lastJudge = result.judge;
	const rejectedAcceptance =
		!result.accepted && result.firstKeptEntryId
			? await acceptRejectedSummaryByPolicy(
					ctx,
					result,
					config.rejectedSummaryMode,
					config.retainArtifacts,
				)
			: null;
	if (
		(!result.accepted && !rejectedAcceptance?.accepted) ||
		!result.firstKeptEntryId
	) {
		state.status = "rejected";
		if (!config.retainArtifacts)
			await removeArtifactRun(artifactRoot, result.artifactDir, sessionId, cwd);
		safeNotify(
			ctx,
			`Slipstream default compaction could not produce a compaction summary. Score ${result.judge.score}. ${result.judge.diagnosis || "score " + result.judge.score}.${config.retainArtifacts ? ` Artifacts: ${result.artifactDir}` : ""}`,
			"warning",
		);
		return { cancel: true };
	}
	state.status = "idle";
	if (!config.retainArtifacts)
		await removeArtifactRun(artifactRoot, result.artifactDir, sessionId, cwd);
	return {
		compaction: {
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details: {
				judge: result.judge,
				...(config.retainArtifacts ? { artifacts: [result.artifactDir] } : {}),
				repaired: result.repaired,
				manualOverride: rejectedAcceptance?.confirmed ?? false,
				rejectedSummaryAccepted: !result.accepted,
				rejectedSummaryMode: rejectedAcceptance?.mode,
				strategy: "direct",
				defaultReplacement: true,
			},
		},
	};
}

export function runtimeReadiness(ctx: PiContext): {
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
} {
	const readiness: {
		isIdle?: () => boolean;
		hasPendingMessages?: () => boolean;
	} = {};
	try {
		const isIdle = ctx.isIdle;
		if (typeof isIdle === "function") readiness.isIdle = () => isIdle.call(ctx);
		const hasPendingMessages = ctx.hasPendingMessages;
		if (typeof hasPendingMessages === "function") {
			readiness.hasPendingMessages = () => hasPendingMessages.call(ctx);
		}
	} catch (error) {
		ignoreStaleContextError(error);
	}
	return readiness;
}

function isIncompleteAssistantTurn(event: TurnEndEvent): boolean {
	const message = event.message as { stopReason?: unknown };
	return message.stopReason === "error" || message.stopReason === "aborted";
}

type PreparedCompactionTriggerResult = "started" | "busy" | "unavailable";

function triggerPreparedCompaction(
	ctx: PiContext,
	state: RuntimeState,
	config: SlipstreamConfig,
): PreparedCompactionTriggerResult {
	try {
		if (!ctx.compact) return "unavailable";
		if (!shouldTriggerPreparedCompactionNow(runtimeReadiness(ctx))) {
			state.status = state.pending ? "ready_to_adopt" : "idle";
			restorePersistentStatus(ctx, state, config);
			return "busy";
		}
		state.status = "summarizing";
		const request = requestSlipstreamCompaction(state);
		ctx.ui?.setStatus?.("slipstream", "slipstream: adopting");
		updateSlipstreamWidget(ctx, state, config);
		ctx.compact({
			customInstructions:
				"Use validated Slipstream summary from pi-slipstream-compact",
			onComplete: () => {
				clearSlipstreamCompactionRequest(state, request);
				state.status = "idle";
				restorePersistentStatus(ctx, state, config);
			},
			onError: () => {
				clearSlipstreamCompactionRequest(state, request);
				state.status = state.pending ? "ready_to_adopt" : "idle";
				restorePersistentStatus(ctx, state, config);
			},
		});
		return "started";
	} catch (error) {
		clearSlipstreamCompactionRequest(state);
		state.status = state.pending ? "ready_to_adopt" : "idle";
		ignoreStaleContextError(error);
		return "unavailable";
	}
}

function branchEntries(ctx: PiContext): LocalSessionEntry[] {
	return ctx.sessionManager.getBranch() as unknown as LocalSessionEntry[];
}

function currentValidatedThroughEntryId(
	ctx: PiContext,
	config: SlipstreamConfig,
): string | null {
	return buildContinuationFromBranch(
		branchEntries(ctx),
		config.maxContinuationTurns,
	).triggerEntryId;
}

function safeBranchEntries(ctx: PiContext): LocalSessionEntry[] | null {
	try {
		return branchEntries(ctx);
	} catch (error) {
		ignoreStaleContextError(error);
		return null;
	}
}

function validatedThroughEntryIdFromBranch(
	entries: LocalSessionEntry[],
	config: SlipstreamConfig,
): string | null {
	return buildContinuationFromBranch(entries, config.maxContinuationTurns)
		.triggerEntryId;
}

async function revalidatePendingForCurrentHead(
	ctx: PiContext,
	config: SlipstreamConfig,
	state: RuntimeState,
	sessionId: string,
	cwd: string,
	onProgress: (event: ProgressEvent) => void,
	runValidated: RunValidatedSlipstream,
): Promise<boolean> {
	const stalePending = state.pending;
	if (!stalePending || state.status !== "ready_to_adopt") return false;
	if (stalePending.sessionId !== sessionId || stalePending.cwd !== cwd)
		return false;
	if (!ctx.modelRegistry) return false;
	const branch = safeBranchEntries(ctx);
	if (!branch) return false;
	const continuation = buildContinuationFromBranch(
		branch,
		config.maxContinuationTurns,
	);
	if (
		continuation.triggerEntryId === null ||
		stalePending.validatedThroughEntryId === continuation.triggerEntryId ||
		continuation.turns.length < config.minContinuationTurns
	)
		return false;
	try {
		ctx.ui?.setStatus?.("slipstream", "slipstream: reconciling");
	} catch (error) {
		ignoreStaleContextError(error);
	}
	const contextUsage = ctx.getContextUsage?.();
	const artifactRoot = await resolveArtifactRoot(cwd, config.artifactRoot);
	const result = await runValidated({
		branchEntries: branch,
		sessionId,
		cwd,
		artifactRoot,
		keepRecentTokens: config.slipstreamKeepRecentTokens,
		tokensBefore: contextUsage?.tokens ?? stalePending.tokensBefore,
		contextUsage,
		continuation,
		statsFullPaths: config.statsFullPaths,
		retainArtifacts: config.retainArtifacts,
		completeSummary: createSummaryCompleter(
			{ model: ctx.model, modelRegistry: ctx.modelRegistry },
			config.summaryModel,
		),
		completeJudge: createJudgeCompleter(
			{ model: ctx.model, modelRegistry: ctx.modelRegistry },
			config.judgeModel,
		),
		judgeThreshold: config.judgeThreshold,
		repairAttempts: config.repairAttempts,
		onProgress,
		signal: ctx.signal,
	});
	if (state.pending !== stalePending || state.status !== "ready_to_adopt") {
		if (!config.retainArtifacts)
			await removeArtifactRun(artifactRoot, result.artifactDir, sessionId, cwd);
		return false;
	}
	state.lastArtifactDir = config.retainArtifacts ? result.artifactDir : null;
	state.lastJudge = result.judge;
	if (
		!result.firstKeptEntryId ||
		(!result.accepted && config.rejectedSummaryMode === "reject")
	) {
		state.pending = null;
		state.status = "rejected";
		if (!config.retainArtifacts)
			await removeArtifactRun(artifactRoot, result.artifactDir, sessionId, cwd);
		await disposePendingArtifact(
			stalePending,
			artifactRoot,
			config.retainArtifacts,
		);
		return false;
	}
	const pending = {
		sessionId,
		cwd,
		projectId: cwd,
		summary: result.summary,
		firstKeptEntryId: result.firstKeptEntryId,
		validatedThroughEntryId: continuation.triggerEntryId,
		tokensBefore: result.tokensBefore ?? stalePending.tokensBefore,
		details: {
			judge: result.judge,
			...(config.retainArtifacts ? { artifacts: [result.artifactDir] } : {}),
			repaired: result.repaired,
			auto: true,
			rejectedSummaryAccepted: !result.accepted,
			rejectedSummaryMode: config.rejectedSummaryMode,
			revalidatedFromEntryId: stalePending.validatedThroughEntryId,
		},
		artifactDir: result.artifactDir,
		expiresAt: Date.now() + config.pendingTtlMs,
	};
	try {
		await persistPendingArtifact(result.artifactDir, pending);
	} catch (error) {
		if (!config.retainArtifacts)
			await removeArtifactRun(artifactRoot, result.artifactDir, sessionId, cwd);
		throw error;
	}
	if (state.pending !== stalePending || state.status !== "ready_to_adopt") {
		if (!config.retainArtifacts)
			await removeArtifactRun(artifactRoot, result.artifactDir, sessionId, cwd);
		return false;
	}
	storePendingValidated(state, pending);
	schedulePendingExpiryCleanup(
		state,
		pending,
		artifactRoot,
		config.retainArtifacts,
		Date.now,
	);
	await disposePendingArtifact(
		stalePending,
		artifactRoot,
		config.retainArtifacts,
	);
	return true;
}

export function registerLifecycle(
	pi: ExtensionAPI,
	config: SlipstreamConfig,
	state: RuntimeState,
	deps: {
		finalizeAutoJob?: (input: FinalizeAutoJobInput) => Promise<boolean>;
		startAutoJob?: typeof startAutoJob;
		buildDefaultSlipstreamCompaction?: typeof buildDefaultSlipstreamCompaction;
		runValidatedSlipstream?: RunValidatedSlipstream;
	} = {},
): void {
	const finalizeAuto = deps.finalizeAutoJob ?? finalizeAutoJob;
	const startAuto = deps.startAutoJob ?? startAutoJob;
	const buildDefaultCompaction =
		deps.buildDefaultSlipstreamCompaction ?? buildDefaultSlipstreamCompaction;
	const runValidated = deps.runValidatedSlipstream ?? runValidatedSlipstream;
	let deferredIdleRetry: ReturnType<typeof setTimeout> | null = null;
	let turnBoundaryWorkScheduled = false;
	let turnBoundaryWorkGeneration = 0;
	let queuedTurnBoundaryWork: {
		event: TurnEndEvent;
		ctx: PiContext;
		canAdoptAtTurnBoundary: boolean;
	} | null = null;
	const busyIdleRetryDelayMs = 50;
	const retireAutoJob = (job: RuntimeState["autoJob"]): void => {
		if (!job || config.retainArtifacts) return;
		void job.summaryPromise
			.catch(() => undefined)
			.then(async () => {
				if (job.finalizing) return;
				if (state.pending?.artifactDir === job.artifactDir) return;
				await removeArtifactRun(
					job.artifactRoot,
					job.artifactDir,
					job.sessionId,
					job.cwd,
				);
			})
			.catch(() => {
				state.status = "failed";
			});
	};
	const retirePending = (pending: RuntimeState["pending"]): void => {
		if (!pending) return;
		void resolveArtifactRoot(pending.cwd, config.artifactRoot)
			.then((artifactRoot) =>
				disposePendingArtifact(pending, artifactRoot, config.retainArtifacts),
			)
			.catch(() => {
				state.status = "failed";
			});
	};
	const clearDeferredIdleRetry = (): void => {
		if (deferredIdleRetry === null) return;
		clearTimeout(deferredIdleRetry);
		deferredIdleRetry = null;
	};
	const clearMismatchedAutoJob = (sessionId: string, cwd: string): boolean => {
		const job = state.autoJob;
		if (!job || (job.sessionId === sessionId && job.cwd === cwd)) return false;
		if (state.activePromise === job.summaryPromise) state.activePromise = null;
		state.autoJob = null;
		retireAutoJob(job);
		state.status = state.pending ? "ready_to_adopt" : "idle";
		return true;
	};
	const cancelTurnBoundaryWork = (): void => {
		turnBoundaryWorkGeneration += 1;
		turnBoundaryWorkScheduled = false;
		queuedTurnBoundaryWork = null;
	};
	const handleTreeNavigation = (ctx: PiContext): void => {
		clearDeferredIdleRetry();
		cancelTurnBoundaryWork();
		clearActiveProgressOwner(state);
		const retiredJob = state.autoJob;
		state.activePromise = null;
		state.autoJob = null;
		retireAutoJob(retiredJob);
		state.compactionWanted = false;
		clearSlipstreamCompactionRequest(state);

		let sessionId = "unknown";
		let cwd = ".";
		let validatedThroughEntryId: string | null = null;
		try {
			sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
			cwd = ctx.cwd;
			validatedThroughEntryId = currentValidatedThroughEntryId(ctx, config);
		} catch (error) {
			ignoreStaleContextError(error);
			const retiredPending = state.pending;
			state.pending = null;
			retirePending(retiredPending);
			state.status = "idle";
			clearSlipstreamWidget(ctx);
			restorePersistentStatus(ctx, state, config);
			return;
		}

		const pending = state.pending;
		if (
			pending &&
			(pending.sessionId !== sessionId ||
				pending.cwd !== cwd ||
				pending.validatedThroughEntryId !== validatedThroughEntryId ||
				isPendingExpired(pending, Date.now()))
		) {
			state.pending = null;
			retirePending(pending);
		}
		state.status = state.pending ? "ready_to_adopt" : "idle";
		restorePersistentStatus(ctx, state, config);
	};
	const scheduleDeferredIdleRetry = (ctx: PiContext, delayMs = 0): void => {
		if (deferredIdleRetry !== null) return;
		let sessionId = "unknown";
		let cwd = ".";
		try {
			sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
			cwd = ctx.cwd;
		} catch (error) {
			ignoreStaleContextError(error);
			return;
		}
		deferredIdleRetry = setTimeout(() => {
			try {
				deferredIdleRetry = null;
				if (ctx.sessionManager.getSessionId?.() !== sessionId) return;
				if (ctx.cwd !== cwd) return;
				if (clearMismatchedAutoJob(sessionId, cwd)) return;
				const readyForIdleWork = shouldTriggerPreparedCompactionNow(
					runtimeReadiness(ctx),
				);
				if (state.autoJob) {
					void finalizeAutoAtSafeBoundary(ctx, {
						allowIncompleteContinuation: true,
					}).catch(ignoreStaleContextError);
					return;
				}
				if (!readyForIdleWork) {
					if (state.pending && state.status === "ready_to_adopt")
						scheduleDeferredIdleRetry(ctx, busyIdleRetryDelayMs);
					return;
				}
				void tryAdoptAtSafeBoundary(ctx, { allowDeferredRetry: false }).catch(
					ignoreStaleContextError,
				);
			} catch (error) {
				ignoreStaleContextError(error);
			}
		}, delayMs);
		deferredIdleRetry.unref?.();
	};
	const startAutoAtStableBoundary = async (
		ctx: PiContext,
		isCancelled: () => boolean = () => false,
	): Promise<void> => {
		let sessionId = "unknown";
		let cwd = ".";
		try {
			sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
			cwd = ctx.cwd;
		} catch (error) {
			ignoreStaleContextError(error);
			return;
		}
		if (isCancelled()) return;
		const branch = safeBranchEntries(ctx);
		if (!branch || isCancelled()) return;
		if (
			!ctx.modelRegistry ||
			!shouldStartAutoJob(config, state, ctx.getContextUsage?.(), {
				sessionId,
				cwd,
				now: Date.now(),
				validatedThroughEntryId: validatedThroughEntryIdFromBranch(
					branch,
					config,
				),
			})
		)
			return;
		if (isCancelled()) return;
		const progress = makeProgressSink(ctx, "auto", state, config);
		try {
			await startAuto({
				state,
				config,
				branchEntries: branch,
				sessionId,
				cwd,
				artifactRoot: await resolveArtifactRoot(cwd, config.artifactRoot),
				completeSummary: createSummaryCompleter(
					{ model: ctx.model, modelRegistry: ctx.modelRegistry },
					config.summaryModel,
				),
				tokensBefore: ctx.getContextUsage?.()?.tokens ?? null,
				contextUsage: ctx.getContextUsage?.(),
				onProgress: progress,
				signal: ctx.signal,
				isCurrent: () => {
					try {
						if (isCancelled()) return false;
						const currentBranch = safeBranchEntries(ctx);
						return (
							currentBranch !== null &&
							validatedThroughEntryIdFromBranch(currentBranch, config) ===
								validatedThroughEntryIdFromBranch(branch, config) &&
							ctx.sessionManager.getSessionId?.() === sessionId &&
							ctx.cwd === cwd &&
							state.compactionWanted &&
							!state.pending &&
							!state.autoJob &&
							!state.activePromise
						);
					} catch (error) {
						ignoreStaleContextError(error);
						return false;
					}
				},
			});
		} finally {
			if (isCancelled()) return;
			const activeSummary = state.activePromise;
			if (activeSummary) {
				void activeSummary.then(
					() => {
						if (isCancelled()) return;
						progress.clear();
						restorePersistentStatus(ctx, state, config);
						scheduleDeferredIdleRetry(ctx);
					},
					() => {
						if (isCancelled()) return;
						progress.clear();
						restorePersistentStatus(ctx, state, config);
						scheduleDeferredIdleRetry(ctx);
					},
				);
			} else {
				progress.clear();
				restorePersistentStatus(ctx, state, config);
				scheduleDeferredIdleRetry(ctx);
			}
		}
	};
	const tryAdoptAtSafeBoundary = async (
		ctx: PiContext,
		options: { allowDeferredRetry?: boolean } = {},
	): Promise<boolean> => {
		let sessionId = "unknown";
		let cwd = ".";
		try {
			sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
			cwd = ctx.cwd;
		} catch (error) {
			ignoreStaleContextError(error);
			return false;
		}
		const triggerIfReady = (): boolean => {
			if (!shouldTriggerPreparedCompactionNow(runtimeReadiness(ctx))) {
				if (options.allowDeferredRetry !== false)
					scheduleDeferredIdleRetry(ctx, busyIdleRetryDelayMs);
				restorePersistentStatus(ctx, state, config);
				return false;
			}
			clearDeferredIdleRetry();
			const triggered = triggerPreparedCompaction(ctx, state, config);
			if (triggered === "busy" && options.allowDeferredRetry !== false)
				scheduleDeferredIdleRetry(ctx, busyIdleRetryDelayMs);
			return triggered === "started";
		};
		const branch = safeBranchEntries(ctx);
		if (!branch) return false;
		const validatedThroughEntryId = validatedThroughEntryIdFromBranch(
			branch,
			config,
		);
		if (
			shouldActivatePreparedCompaction(config, state, ctx.getContextUsage?.(), {
				sessionId,
				cwd,
				now: Date.now(),
				validatedThroughEntryId,
			})
		) {
			return triggerIfReady();
		}
		if (state.pending && state.status === "ready_to_adopt") {
			const progress = makeProgressSink(ctx, "auto", state, config);
			let reconciled: boolean;
			try {
				reconciled = await revalidatePendingForCurrentHead(
					ctx,
					config,
					state,
					sessionId,
					cwd,
					progress,
					runValidated,
				);
			} finally {
				progress.clear();
			}
			if (reconciled) {
				const revalidatedBranch = safeBranchEntries(ctx);
				if (!revalidatedBranch) return false;
				if (
					shouldActivatePreparedCompaction(
						config,
						state,
						ctx.getContextUsage?.(),
						{
							sessionId,
							cwd,
							now: Date.now(),
							validatedThroughEntryId: validatedThroughEntryIdFromBranch(
								revalidatedBranch,
								config,
							),
						},
					)
				) {
					return triggerIfReady();
				}
			}
		}
		restorePersistentStatus(ctx, state, config);
		return false;
	};
	const finalizeAutoAtSafeBoundary = async (
		ctx: PiContext,
		options: {
			allowIncompleteContinuation?: boolean;
			requireIdleBeforeFinalize?: boolean;
			canAdopt?: boolean;
		} = {},
	): Promise<boolean> => {
		if (!state.autoJob || !ctx.modelRegistry) return false;
		let sessionId = "unknown";
		let cwd = ".";
		try {
			sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
			cwd = ctx.cwd;
		} catch (error) {
			ignoreStaleContextError(error);
			return false;
		}
		if (clearMismatchedAutoJob(sessionId, cwd)) return false;
		if (
			options.requireIdleBeforeFinalize &&
			!shouldTriggerPreparedCompactionNow(runtimeReadiness(ctx))
		)
			return false;
		const branch = safeBranchEntries(ctx);
		if (!branch) return false;
		const progress = makeProgressSink(ctx, "auto", state, config);
		const finalizeInput = {
			state,
			config,
			completeSummary: createSummaryCompleter(
				{ model: ctx.model, modelRegistry: ctx.modelRegistry },
				config.summaryModel,
			),
			completeJudge: createJudgeCompleter(
				{ model: ctx.model, modelRegistry: ctx.modelRegistry },
				config.judgeModel,
			),
			now: () => Date.now(),
			validatedThroughEntryId: validatedThroughEntryIdFromBranch(
				branch,
				config,
			),
			allowIncompleteContinuation: options.allowIncompleteContinuation,
			onProgress: progress,
			signal: ctx.signal,
		};
		try {
			const accepted = await finalizeAuto(finalizeInput);
			progress.clear();
			restorePersistentStatus(ctx, state, config);
			if (accepted && options.canAdopt !== false)
				await tryAdoptAtSafeBoundary(ctx);
			return accepted;
		} catch (error) {
			progress.clear();
			state.status = "failed";
			restorePersistentStatus(ctx, state, config);
			const message = error instanceof Error ? error.message : String(error);
			safeNotify(
				ctx,
				`Slipstream auto finalize failed; compaction cancelled: ${message}`,
				"error",
			);
			return false;
		}
	};
	const scheduleTurnBoundaryWork = (
		event: TurnEndEvent,
		ctx: PiContext,
		canAdoptAtTurnBoundary: boolean,
	): void => {
		if (turnBoundaryWorkScheduled) {
			queuedTurnBoundaryWork = { event, ctx, canAdoptAtTurnBoundary };
			return;
		}
		turnBoundaryWorkScheduled = true;
		const generation = turnBoundaryWorkGeneration;
		void (async () => {
			try {
				if (generation !== turnBoundaryWorkGeneration) return;
				const adoptionRequested = canAdoptAtTurnBoundary
					? await tryAdoptAtSafeBoundary(ctx)
					: false;
				if (generation !== turnBoundaryWorkGeneration) return;
				if (adoptionRequested || state.status === "summarizing") return;
				if (!isAutoTriggerBoundary(event.message)) return;
				await startAutoAtStableBoundary(
					ctx,
					() => generation !== turnBoundaryWorkGeneration,
				);
			} catch (error) {
				if (generation !== turnBoundaryWorkGeneration) return;
				try {
					ignoreStaleContextError(error);
				} catch (nonStaleError) {
					state.status = "failed";
					restorePersistentStatus(ctx, state, config);
					const message =
						nonStaleError instanceof Error
							? nonStaleError.message
							: String(nonStaleError);
					safeNotify(
						ctx,
						`Slipstream auto boundary work failed; compaction cancelled: ${message}`,
						"error",
					);
				}
			} finally {
				if (generation !== turnBoundaryWorkGeneration) return;
				turnBoundaryWorkScheduled = false;
				const queued = queuedTurnBoundaryWork;
				queuedTurnBoundaryWork = null;
				if (queued)
					scheduleTurnBoundaryWork(
						queued.event,
						queued.ctx,
						queued.canAdoptAtTurnBoundary,
					);
			}
		})();
	};

	pi.on("session_start", async (_event, rawCtx) => {
		const ctx = rawCtx as PiContext;
		try {
			ctx.ui?.setStatus?.(
				"slipstream",
				config.enabled ? "slipstream: manual" : undefined,
			);
			if (config.enabled) {
				updateSlipstreamWidget(ctx, state, config);
				await yieldForUiPaint();
				const sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
				const artifactRoot = await resolveArtifactRoot(
					ctx.cwd,
					config.artifactRoot,
				);
				const recovered = await recoverPendingArtifact(
					artifactRoot,
					sessionId,
					ctx.cwd,
					Date.now(),
					config.pendingTtlMs,
					config.retainArtifacts,
				);
				if (recovered) {
					if (
						recovered.validatedThroughEntryId ===
						currentValidatedThroughEntryId(ctx, config)
					)
						storePendingValidated(state, recovered);
					schedulePendingExpiryCleanup(
						state,
						recovered,
						artifactRoot,
						config.retainArtifacts,
						Date.now,
					);
				}
				updateSlipstreamWidget(ctx, state, config);
			} else clearSlipstreamWidget(ctx);
		} catch (error) {
			ignoreStaleContextError(error);
		}
	});

	pi.on("session_shutdown", async (_event, rawCtx) => {
		const ctx = rawCtx as PiContext;
		clearDeferredIdleRetry();
		queuedTurnBoundaryWork = null;
		clearActiveProgressOwner(state);
		clearSlipstreamWidget(ctx);
		const retiredJob = state.autoJob;
		state.activePromise = null;
		state.autoJob = null;
		retireAutoJob(retiredJob);
		state.pending = null;
		state.compactionWanted = false;
		clearSlipstreamCompactionRequest(state);
		state.status = "idle";
	});

	pi.on("session_tree", async (_rawEvent: SessionTreeEvent, rawCtx) => {
		const ctx = rawCtx as PiContext;
		if (!config.enabled) return;
		try {
			handleTreeNavigation(ctx);
		} catch (error) {
			ignoreStaleContextError(error);
		}
	});

	pi.on("turn_end", async (rawEvent, rawCtx) => {
		const event = rawEvent as TurnEndEvent;
		const ctx = rawCtx as PiContext;
		if (!config.enabled) return;
		const canAdoptAtTurnBoundary = !isIncompleteAssistantTurn(event);
		if (state.autoJob) {
			let sessionId = "unknown";
			let cwd = ".";
			try {
				sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
				cwd = ctx.cwd;
			} catch (error) {
				ignoreStaleContextError(error);
				return;
			}
			if (clearMismatchedAutoJob(sessionId, cwd)) {
				scheduleTurnBoundaryWork(event, ctx, canAdoptAtTurnBoundary);
				return;
			}
			state.autoJob.continuation.appendTurn(event);
			if (state.autoJob.continuation.isReady() && ctx.modelRegistry)
				void finalizeAutoAtSafeBoundary(ctx, {
					canAdopt: canAdoptAtTurnBoundary,
				});
			return;
		}

		scheduleTurnBoundaryWork(event, ctx, canAdoptAtTurnBoundary);
	});

	pi.on("session_compact", async (_rawEvent, rawCtx) => {
		const ctx = rawCtx as PiContext;
		if (!config.enabled) return;
		clearDeferredIdleRetry();
		clearActiveProgressOwner(state);
		const retiredJob = state.autoJob;
		state.activePromise = null;
		state.autoJob = null;
		retireAutoJob(retiredJob);
		clearSlipstreamCompactionRequest(state);
		if (state.pending)
			await disposePendingArtifact(
				state.pending,
				await resolveArtifactRoot(ctx.cwd, config.artifactRoot),
				config.retainArtifacts,
			);
		state.pending = null;
		state.compactionWanted = false;
		state.status = "idle";
		restorePersistentStatus(ctx, state, config);
	});

	pi.on("session_before_compact", async (rawEvent, rawCtx) => {
		const event = rawEvent as LocalCompactEvent;
		const ctx = rawCtx as PiContext;
		if (!config.enabled) return undefined;
		let sessionId = "unknown";
		let cwd = ".";
		let branchEntries: LocalSessionEntry[] = [];
		try {
			sessionId = ctx.sessionManager.getSessionId?.() ?? "unknown";
			cwd = ctx.cwd;
			branchEntries = (event.branchEntries ??
				ctx.sessionManager.getBranch()) as unknown as LocalSessionEntry[];
		} catch (error) {
			ignoreStaleContextError(error);
			return undefined;
		}
		const pendingBeforeConsume = state.pending;
		const now = Date.now();
		const requestedCompaction = state.slipstreamCompactionRequest;
		const explicitRequest = activeSlipstreamCompactionRequest(state, now);
		if (requestedCompaction && !explicitRequest) {
			clearSlipstreamCompactionRequest(state, requestedCompaction);
			if (pendingBeforeConsume)
				await disposePendingArtifact(
					pendingBeforeConsume,
					await resolveArtifactRoot(cwd, config.artifactRoot),
					config.retainArtifacts,
				);
			state.pending = null;
			state.status = "idle";
			restorePersistentStatus(ctx, state, config);
			return { cancel: true };
		}
		const shouldHandlePending = config.replaceDefaultCompact || explicitRequest;
		const consumed = shouldHandlePending
			? consumePendingForCompaction(state, {
					sessionId,
					cwd,
					preparationFirstKeptEntryId: event.preparation.firstKeptEntryId,
					validatedThroughEntryId: buildContinuationFromBranch(
						branchEntries,
						config.maxContinuationTurns,
					).triggerEntryId,
					now,
				})
			: undefined;
		if (consumed) {
			clearSlipstreamCompactionRequest(state, explicitRequest ?? undefined);
			clearDeferredIdleRetry();
			if (pendingBeforeConsume)
				await disposePendingArtifact(
					pendingBeforeConsume,
					await resolveArtifactRoot(cwd, config.artifactRoot),
					config.retainArtifacts,
				);
			state.status = "summarizing";
			try {
				ctx.ui?.setStatus?.(
					"slipstream",
					"slipstream: compacting with prepared summary",
				);
			} catch (error) {
				ignoreStaleContextError(error);
			}
			restorePersistentStatus(ctx, state, config);
			return {
				compaction: {
					...consumed,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		}
		if (explicitRequest) {
			clearSlipstreamCompactionRequest(state, explicitRequest);
			if (pendingBeforeConsume)
				await disposePendingArtifact(
					pendingBeforeConsume,
					await resolveArtifactRoot(cwd, config.artifactRoot),
					config.retainArtifacts,
				);
			restorePersistentStatus(ctx, state, config);
			return { cancel: true };
		}
		if (!config.replaceDefaultCompact) {
			restorePersistentStatus(ctx, state, config);
			return undefined;
		}
		try {
			ctx.ui?.setStatus?.("slipstream", "slipstream: /compact starting");
			updateSlipstreamWidget(ctx, state, config);
		} catch (error) {
			ignoreStaleContextError(error);
		}
		await yieldForUiPaint();
		const progress = makeProgressSink(ctx, "compact", state, config);
		try {
			return await buildDefaultCompaction(
				{ ...event, branchEntries },
				ctx,
				config,
				state,
				progress,
			);
		} finally {
			progress.clear();
			restorePersistentStatus(ctx, state, config);
		}
	});
}

function registerCommands(
	pi: ExtensionAPI,
	config: SlipstreamConfig,
	state: RuntimeState,
): void {
	pi.registerCommand("slipstream", {
		description:
			"Default Slipstream compaction replacement. Usage: /slipstream status | artifacts | compact [--direct|--dry-run|--prepare|--adopt]",
		getArgumentCompletions(argumentText: string) {
			return getSlipstreamArgumentCompletions(argumentText);
		},
		handler: async (args: string, rawCtx) => {
			const ctx = rawCtx as PiContext;
			try {
				const result = await handleSlipstreamCommand(
					args,
					state,
					config,
					ctx as unknown as Parameters<typeof handleSlipstreamCommand>[3],
				);
				safeNotify(ctx, result.message, result.ok ? "info" : "warning");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				safeNotify(ctx, `Slipstream error: ${message}`, "error");
			}
		},
	});
}

export function getSlipstreamArgumentCompletions(
	argumentText: string,
): Array<{ value: string; label: string }> {
	const text = argumentText;
	const endsWithSpace = /\s$/.test(text);
	const tokens = text.trim().split(/\s+/).filter(Boolean);
	const current = endsWithSpace ? "" : (tokens.at(-1) ?? "");
	const action = tokens[0];
	if (!action || (!endsWithSpace && tokens.length === 1)) {
		return ["status", "artifacts", "compact"]
			.filter((item) => item.startsWith(current))
			.map((item) => ({ value: item, label: item }));
	}
	if (action !== "compact") return [];
	return ["--direct", "--dry-run", "--prepare", "--adopt"]
		.filter((item) => item.startsWith(current))
		.map((item) => ({ value: item, label: item }));
}

export default async function piSlipstreamCompact(
	pi: ExtensionAPI,
): Promise<void> {
	const config = loadSettings();
	const state = createRuntimeState();
	registerLifecycle(pi, config, state);
	registerCommands(pi, config, state);
}
