export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string };
export type ImageBlock = {
	type: "image";
	data?: string;
	mimeType?: string;
	source?: unknown;
};
export type ToolCallBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments?: Record<string, unknown>;
};
export type ContentBlock =
	| TextBlock
	| ThinkingBlock
	| ImageBlock
	| ToolCallBlock
	| Record<string, unknown>;

export type MessageContent = string | ContentBlock[];

export type UserMessage = {
	role: "user";
	content: MessageContent;
	timestamp?: number;
};
export type AssistantMessage = {
	role: "assistant";
	content: MessageContent;
	timestamp?: number;
	stopReason?: string;
};
export type ToolResultMessage = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: MessageContent;
	isError: boolean;
	details?: unknown;
	timestamp?: number;
};
export type BashExecutionMessage = {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	excludeFromContext?: boolean;
	timestamp?: number;
};
export type CustomMessage = {
	role: "custom";
	customType: string;
	content: MessageContent;
	display: boolean;
	details?: unknown;
	timestamp?: number;
};
export type BranchSummaryMessage = {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp?: number;
};
export type CompactionSummaryMessage = {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp?: number;
};

export type AgentMessage =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| BashExecutionMessage
	| CustomMessage
	| BranchSummaryMessage
	| CompactionSummaryMessage;

export type MessageEntry = {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AgentMessage;
};

export type CompactionEntry = {
	type: "compaction";
	id: string;
	parentId: string | null;
	timestamp: string;
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: unknown;
	fromHook?: boolean;
};

export type BranchSummaryEntry = {
	type: "branch_summary";
	id: string;
	parentId: string | null;
	timestamp: string;
	summary: string;
	fromId: string;
	details?: unknown;
	fromHook?: boolean;
};

export type CustomEntry = {
	type: "custom";
	id: string;
	parentId: string | null;
	timestamp: string;
	customType: string;
	data?: unknown;
};

export type SessionEntry =
	| MessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| Record<string, unknown>;

export type ManifestError = {
	source: "tool" | "bash" | "system";
	message: string;
	entryId?: string;
	unresolved: boolean;
};
export type ManifestFact = { text: string; entryId?: string };
export type OpenLoop = {
	summary: string;
	entryId?: string;
	priority: "low" | "medium" | "high";
};
export type StaleSignal = {
	text: string;
	reason: string;
	entryId?: string;
};
export type LatestSignal = {
	kind:
		| "verification_success"
		| "verification_failure"
		| "final_delivered"
		| "delivered_output"
		| "risk";
	text: string;
	entryId?: string;
};
export type UserAssertionKind =
	| "current_directive"
	| "approval_scope"
	| "correction_supersession"
	| "historical_background"
	| "likely_stale_noisy";
export type UserAssertionAuthority =
	| "intent_scope"
	| "user_reported_state_requires_verification"
	| "historical_context";
export type UserAssertionStaleRisk = "low" | "medium" | "high";
export type UserAssertionTrailEntry = {
	entryId: string;
	kind: UserAssertionKind;
	authority: UserAssertionAuthority;
	userAsserted: string;
	evidenceExcerpt: string;
	staleRisk: UserAssertionStaleRisk;
	staleReason?: string;
	supersededByEntryId?: string;
};

export type SnapshotManifest = {
	filesRead: string[];
	filesModified: string[];
	filesDeleted: string[];
	errors: ManifestError[];
	userDecisions: ManifestFact[];
	constraints: ManifestFact[];
	openLoops: OpenLoop[];
	recentVerification: string[];
	latestUpdates: string[];
	retainedTailUpdates: string[];
	latestExchangeState: string[];
	terminalFinalAnswerEvidence: string[];
	latestSignals: LatestSignal[];
	staleSignals: StaleSignal[];
	userAssertionTrail: UserAssertionTrailEntry[];
	criticalLiterals: string[];
	previousSummary: string | null;
	artifactRefs: string[];
	knownFileRefs: Set<string>;
};

export type Snapshot = {
	sessionId: string;
	cwd: string;
	triggerEntryId: string | null;
	firstKeptEntryId: string | null;
	tokensBefore: number | null;
	summaryInputMessages: string[];
	keptBoundary: { keepFromIndex: number; firstKeptEntryId: string | null };
	manifest: SnapshotManifest;
};

export type ContextUsageSnapshot =
	| { tokens: number | null; percent?: number | null; contextWindow?: number }
	| undefined;

export type StateEvidenceBundle = {
	generatedAt: string;
	cwd: string;
	git: {
		available: boolean;
		statusShort: string;
		diffStat: string;
		diff: string;
		errors: string[];
		omittedDiffChars?: number;
		fullDiffSha256?: string;
		fullDiffBytes?: number;
		fullDiffComplete?: boolean;
		fullDiffArtifactPaths?: string[];
		fullDiffPreserved?: boolean;
	};
	session: {
		filesRead: string[];
		filesModified: string[];
		filesDeleted: string[];
		unresolvedErrors: string[];
		userDecisions: string[];
		constraints: string[];
		openLoops: string[];
		recentVerification: string[];
		latestUpdates: string[];
		retainedTailUpdates: string[];
		latestExchangeState: string[];
		terminalFinalAnswerEvidence: string[];
		latestSignals: string[];
		staleSignals: string[];
		userAssertionTrail?: string[];
		criticalLiterals: string[];
	};
};

export type ContinuationToolResult = {
	toolName: string;
	text: string;
	isError: boolean;
	toolCallId?: string;
};
export type ContinuationTurn = {
	turnIndex: number;
	assistantText: string;
	toolResults: ContinuationToolResult[];
};
export type ContinuationSnapshot = {
	triggerEntryId: string | null;
	turns: ContinuationTurn[];
};

export type JudgeDecision = "accept" | "reject";
export type JudgeResult = {
	score: number;
	decision: JudgeDecision;
	judgeStatus?: "parsed" | "parse_error";
	planAlignment?: number;
	statementSufficiency?: number;
	nonContradiction?: number;
	currentState?: number;
	nextActionReadiness?: number;
	constraintPreservation?: number;
	verificationAwareness?: number;
	staleStateSuppression?: number;
	artifactGrounding?: number;
	riskAwareness?: number;
	retrievability?: number;
	knowledgeContinuity?: number;
	lowNoiseLowContradiction?: number;
	missing: string[];
	contradictions: string[];
	diagnosis: string;
};

export type PendingValidatedCompaction = {
	sessionId: string;
	cwd: string;
	projectId: string;
	summary: string;
	firstKeptEntryId: string;
	validatedThroughEntryId: string | null;
	tokensBefore: number | null;
	details: Record<string, unknown>;
	artifactDir: string;
	expiresAt: number;
};

export type ProgressEvent = {
	phase:
		| "snapshot"
		| "artifacts"
		| "state-evidence"
		| "summary"
		| "finalizing-summary"
		| "judging"
		| "repairing"
		| "accepted"
		| "rejected";
	message: string;
	elapsedMs?: number;
	lastScore?: number;
};

export type ProgressSink = (event: ProgressEvent) => void;

export type AutoJob = {
	sessionId: string;
	cwd: string;
	projectId: string;
	snapshot: Snapshot;
	firstKeptEntryId: string | null;
	tokensBefore: number | null;
	artifactDir: string;
	artifactRoot: string;
	summaryArtifactRefs: string[];
	continuation: {
		appendTurn(event: {
			turnIndex: number;
			message: AgentMessage;
			toolResults: ToolResultMessage[];
		}): void;
		isReady(): boolean;
		snapshot(): ContinuationSnapshot;
	};
	summaryPromise: Promise<string>;
	stateEvidence?: StateEvidenceBundle;
	maxConversationChars?: number;
	stats: {
		startedAt: string;
		startedAtMs: number;
		timingsMs: {
			snapshot: number;
			artifacts: number;
			stateEvidence: number;
			summary: number;
			judging: number;
			repair: number;
			total: number;
		};
	};
	finalizing: boolean;
};

export type SlipstreamCompactionRequest = {
	id: number;
	expiresAt: number;
};

export type RuntimeState = {
	pending: PendingValidatedCompaction | null;
	autoJob: AutoJob | null;
	activePromise: Promise<unknown> | null;
	compactionWanted: boolean;
	nextSlipstreamCompactionRequestId: number;
	slipstreamCompactionRequest: SlipstreamCompactionRequest | null;
	lastArtifactDir: string | null;
	lastJudge: JudgeResult | null;
	progressOwner: {
		owner: symbol;
		source: "lifecycle" | "command";
		clear: () => void;
	} | null;
	status:
		| "idle"
		| "summarizing"
		| "awaiting_continuation"
		| "finalizing_summary"
		| "judging"
		| "ready_to_adopt"
		| "repairing"
		| "rejected"
		| "failed";
};

export type CompleteTextFn = (
	prompt: string,
	signal?: AbortSignal,
) => Promise<string>;
export type JudgeCompletion = {
	result: JudgeResult;
	rawText?: string;
};
export type CompleteJudgeFn = (
	prompt: string,
	signal?: AbortSignal,
) => Promise<JudgeResult | JudgeCompletion>;
