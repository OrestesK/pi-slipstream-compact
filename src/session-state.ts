import type { PendingValidatedCompaction, RuntimeState } from "./types.ts";

export type CreateRuntimeStateOptions = { now?: number };
export type PendingMatch = {
	sessionId?: string;
	cwd?: string;
	preparationFirstKeptEntryId?: string;
	validatedThroughEntryId?: string | null;
	now: number;
};
export type CompactCapableContext = {
	compact(options?: {
		customInstructions?: string;
		onComplete?: (result: unknown) => void;
		onError?: (error: Error) => void;
	}): void;
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
};

export function isCompactRuntimeReady(ctx: CompactCapableContext): boolean {
	try {
		if (ctx.isIdle && ctx.isIdle() !== true) return false;
		if (ctx.hasPendingMessages && ctx.hasPendingMessages() === true)
			return false;
		return true;
	} catch {
		return false;
	}
}

export function createRuntimeState(
	_options: CreateRuntimeStateOptions = {},
): RuntimeState {
	return {
		pending: null,
		autoJob: null,
		activePromise: null,
		compactionWanted: false,
		nextSlipstreamCompactionRequestId: 0,
		slipstreamCompactionRequest: null,
		lastArtifactDir: null,
		lastJudge: null,
		progressOwner: null,
		status: "idle",
	};
}

type ProgressOwnerSource = NonNullable<RuntimeState["progressOwner"]>["source"];

function setProgressOwner(
	state: RuntimeState,
	source: ProgressOwnerSource,
	clear: () => void,
): symbol {
	const owner = Symbol("slipstream-progress");
	state.progressOwner = { owner, source, clear };
	return owner;
}

export function clearActiveProgressOwner(state: RuntimeState): boolean {
	const active = state.progressOwner;
	if (!active) return false;
	state.progressOwner = null;
	active.clear();
	return true;
}

export function claimProgressOwner(
	state: RuntimeState,
	source: ProgressOwnerSource,
	clear: () => void,
): symbol {
	clearActiveProgressOwner(state);
	return setProgressOwner(state, source, clear);
}

export function tryClaimProgressOwner(
	state: RuntimeState,
	source: ProgressOwnerSource,
	clear: () => void,
): symbol | null {
	if (state.progressOwner) return null;
	return setProgressOwner(state, source, clear);
}

export function ownsProgress(state: RuntimeState, owner: symbol): boolean {
	return state.progressOwner?.owner === owner;
}

export function hasActiveProgressOwner(state: RuntimeState): boolean {
	return state.progressOwner !== null;
}

export function releaseProgressOwner(
	state: RuntimeState,
	owner: symbol,
): boolean {
	if (!ownsProgress(state, owner)) return false;
	state.progressOwner = null;
	return true;
}

export function storePendingValidated(
	state: RuntimeState,
	pending: PendingValidatedCompaction,
): void {
	state.pending = pending;
	state.status = "ready_to_adopt";
	const judge = pending.details.judge;
	state.lastJudge =
		typeof judge === "object" && judge !== null
			? (judge as RuntimeState["lastJudge"])
			: state.lastJudge;
	const artifacts = pending.details.artifacts;
	state.lastArtifactDir =
		Array.isArray(artifacts) && typeof artifacts[0] === "string"
			? artifacts[0]
			: null;
}

export function isPendingExpired(
	pending: Pick<PendingValidatedCompaction, "expiresAt">,
	now: number,
): boolean {
	return now >= pending.expiresAt;
}

export function consumePendingForCompaction(
	state: RuntimeState,
	match: PendingMatch,
):
	| {
			summary: string;
			firstKeptEntryId: string;
			tokensBefore: number | null;
			details: Record<string, unknown>;
	  }
	| undefined {
	const pending = state.pending;
	if (!pending) return undefined;
	if (isPendingExpired(pending, match.now)) {
		state.pending = null;
		state.status = "idle";
		return undefined;
	}
	if (match.sessionId && pending.sessionId !== match.sessionId) {
		state.pending = null;
		state.status = "idle";
		return undefined;
	}
	if (match.cwd && pending.cwd !== match.cwd) {
		state.pending = null;
		state.status = "idle";
		return undefined;
	}
	if (
		match.validatedThroughEntryId !== undefined &&
		match.validatedThroughEntryId !== null &&
		pending.validatedThroughEntryId !== match.validatedThroughEntryId
	) {
		state.pending = null;
		state.status = "idle";
		return undefined;
	}
	state.pending = null;
	state.status = "idle";
	return {
		summary: pending.summary,
		firstKeptEntryId: pending.firstKeptEntryId,
		tokensBefore: pending.tokensBefore,
		details: pending.details,
	};
}

export function requestSlipstreamCompaction(
	state: RuntimeState,
): NonNullable<RuntimeState["slipstreamCompactionRequest"]> {
	const request = {
		id: state.nextSlipstreamCompactionRequestId + 1,
		expiresAt: Math.min(
			state.pending?.expiresAt ?? Number.POSITIVE_INFINITY,
			Date.now() + 30_000,
		),
	};
	state.nextSlipstreamCompactionRequestId = request.id;
	state.slipstreamCompactionRequest = request;
	return request;
}

export function activeSlipstreamCompactionRequest(
	state: RuntimeState,
	now: number = Date.now(),
): NonNullable<RuntimeState["slipstreamCompactionRequest"]> | null {
	const request = state.slipstreamCompactionRequest;
	if (!request) return null;
	if (now >= request.expiresAt) {
		state.slipstreamCompactionRequest = null;
		return null;
	}
	return request;
}

export function clearSlipstreamCompactionRequest(
	state: RuntimeState,
	request?: NonNullable<RuntimeState["slipstreamCompactionRequest"]>,
): void {
	if (!request || state.slipstreamCompactionRequest?.id === request.id)
		state.slipstreamCompactionRequest = null;
}

export function adoptPending(
	state: RuntimeState,
	ctx: CompactCapableContext,
	match: PendingMatch = { now: Date.now() },
): "slipstream" | "busy" | null {
	const pending = state.pending;
	if (!pending || state.status !== "ready_to_adopt") return null;
	if (isPendingExpired(pending, match.now)) {
		state.pending = null;
		state.status = "idle";
		return null;
	}
	if (match.sessionId && pending.sessionId !== match.sessionId) {
		state.pending = null;
		state.status = "idle";
		return null;
	}
	if (match.cwd && pending.cwd !== match.cwd) {
		state.pending = null;
		state.status = "idle";
		return null;
	}
	if (!isCompactRuntimeReady(ctx)) return "busy";
	state.status = "summarizing";
	const request = requestSlipstreamCompaction(state);
	try {
		ctx.compact({
			customInstructions:
				"Use validated Slipstream summary from pi-slipstream-compact",
			onComplete: () => {
				clearSlipstreamCompactionRequest(state, request);
				state.status = "idle";
			},
			onError: () => {
				clearSlipstreamCompactionRequest(state, request);
				state.status = state.pending ? "ready_to_adopt" : "idle";
			},
		});
	} catch (error) {
		clearSlipstreamCompactionRequest(state, request);
		state.status = "ready_to_adopt";
		throw error;
	}
	return "slipstream";
}

export function trackPromise<T>(
	state: RuntimeState,
	promise: Promise<T>,
): Promise<T> {
	state.activePromise = promise;
	void promise.then(
		() => {
			if (state.activePromise === promise) state.activePromise = null;
		},
		() => {
			if (state.activePromise === promise) state.activePromise = null;
		},
	);
	return promise;
}
