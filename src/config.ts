import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContextUsageSnapshot } from "./types.ts";

export type RejectedSummaryMode = "accept" | "ask" | "reject";

export type SlipstreamConfig = {
	enabled: boolean;
	autoTrigger: boolean;
	replaceDefaultCompact: boolean;
	triggerContextPercent: number;
	softContextPercent: number;
	hardContextPercent: number;
	contextReserveTokens: number;
	slipstreamKeepRecentTokens: number;
	minContinuationTurns: number;
	maxContinuationTurns: number;
	judgeThreshold: number;
	repairAttempts: number;
	rejectedSummaryMode: RejectedSummaryMode;
	pendingTtlMs: number;
	artifactRoot: string;
	retainArtifacts: boolean;
	statsFullPaths: boolean;
	summaryModel?: string;
	judgeModel?: string;
};

export const CONFIG_KEYS = [
	"pi-slipstream-compact",
	"slipstreamCompact",
] as const;

export const DEFAULT_CONFIG: SlipstreamConfig = Object.freeze({
	enabled: true,
	autoTrigger: true,
	replaceDefaultCompact: true,
	triggerContextPercent: 0.6,
	softContextPercent: 0.6,
	hardContextPercent: 0.6,
	contextReserveTokens: 24_000,
	slipstreamKeepRecentTokens: 50_000,
	minContinuationTurns: 1,
	maxContinuationTurns: 4,
	judgeThreshold: 7,
	repairAttempts: 3,
	rejectedSummaryMode: "ask",
	pendingTtlMs: 5 * 60 * 1000,
	artifactRoot: ".scratch/compactions",
	retainArtifacts: false,
	statsFullPaths: false,
});

export const DEFAULT_MAX_CONVERSATION_CHARS = 450_000;
const MIN_CONVERSATION_CHARS = 120_000;
const MAX_CONVERSATION_CHARS = 700_000;
const RESERVED_OUTPUT_TOKENS = 16_384;
const FIXED_PROMPT_RESERVE_TOKENS = 32_000;
const CHARS_PER_TOKEN = 3.8;
const INPUT_FRACTION = 0.6;

type UnknownRecord = Record<string, unknown>;

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function availableInputTokens(usage: ContextUsageSnapshot): number | null {
	const contextWindow = usage?.contextWindow;
	if (typeof contextWindow !== "number" || !Number.isFinite(contextWindow))
		return null;
	const available =
		contextWindow - RESERVED_OUTPUT_TOKENS - FIXED_PROMPT_RESERVE_TOKENS;
	return available > 0 ? available : 0;
}

export function resolveMaxConversationChars(
	usage: ContextUsageSnapshot,
): number {
	const available = availableInputTokens(usage);
	if (available === null) return DEFAULT_MAX_CONVERSATION_CHARS;
	return clamp(
		available * CHARS_PER_TOKEN * INPUT_FRACTION,
		MIN_CONVERSATION_CHARS,
		MAX_CONVERSATION_CHARS,
	);
}

export type ParsedCommandArgs = {
	action: string;
	flags: Set<string>;
	rest: string[];
};

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): UnknownRecord {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function getNestedConfig(settings: UnknownRecord): UnknownRecord {
	for (const key of CONFIG_KEYS) {
		const value = settings[key];
		if (isRecord(value)) return value;
	}
	return {};
}

function mergeConfig(
	globalConfig: UnknownRecord,
	projectConfig: UnknownRecord,
): UnknownRecord {
	return { ...globalConfig, ...projectConfig };
}

function compactionReserveTokens(settings: UnknownRecord): number | undefined {
	const value = settings.compaction;
	if (!isRecord(value)) return undefined;
	return typeof value.reserveTokens === "number" &&
		Number.isFinite(value.reserveTokens)
		? value.reserveTokens
		: undefined;
}

function optionalBoolean(
	raw: UnknownRecord,
	key: keyof SlipstreamConfig,
	fallback: boolean,
): boolean {
	const value = raw[key];
	if (value === undefined) return fallback;
	if (typeof value !== "boolean")
		throw new Error(`${String(key)} must be boolean`);
	return value;
}

function optionalNumber(
	raw: UnknownRecord,
	key: keyof SlipstreamConfig,
	fallback: number,
): number {
	const value = raw[key];
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new Error(`${String(key)} must be a finite number`);
	return value;
}

function optionalInteger(
	raw: UnknownRecord,
	key: keyof SlipstreamConfig,
	fallback: number,
): number {
	const value = optionalNumber(raw, key, fallback);
	if (!Number.isInteger(value))
		throw new Error(`${String(key)} must be an integer`);
	return value;
}

function optionalString(
	raw: UnknownRecord,
	key: keyof SlipstreamConfig,
	fallback: string | undefined,
): string | undefined {
	const value = raw[key];
	if (value === undefined) return fallback;
	if (typeof value !== "string")
		throw new Error(`${String(key)} must be a string`);
	return value;
}

function optionalRejectedSummaryMode(
	raw: UnknownRecord,
	fallback: RejectedSummaryMode,
): RejectedSummaryMode {
	const value = raw.rejectedSummaryMode;
	if (value === undefined) return fallback;
	if (value !== "accept" && value !== "ask" && value !== "reject")
		throw new Error("rejectedSummaryMode must be 'accept', 'ask', or 'reject'");
	return value;
}

function validateModelId(
	name: "summaryModel" | "judgeModel",
	value: string | undefined,
): string | undefined {
	if (value === undefined || value.trim() === "") return undefined;
	if (!/^[a-z0-9_.-]+\/[a-z0-9_.:@+/-]+$/i.test(value)) {
		throw new Error(`${name} must look like provider/model-id`);
	}
	return value;
}

export function normalizeConfig(raw: unknown = {}): SlipstreamConfig {
	if (!isRecord(raw))
		throw new Error("pi-slipstream-compact config must be an object");

	const replaceDefaultCompact = optionalBoolean(
		raw,
		"replaceDefaultCompact",
		DEFAULT_CONFIG.replaceDefaultCompact,
	);
	const rawAutoTrigger = optionalBoolean(
		raw,
		"autoTrigger",
		DEFAULT_CONFIG.autoTrigger,
	);
	const cfg: SlipstreamConfig = {
		enabled: optionalBoolean(raw, "enabled", DEFAULT_CONFIG.enabled),
		autoTrigger: replaceDefaultCompact ? rawAutoTrigger : false,
		replaceDefaultCompact,
		triggerContextPercent: optionalNumber(
			raw,
			"triggerContextPercent",
			optionalNumber(
				raw,
				"softContextPercent",
				DEFAULT_CONFIG.triggerContextPercent,
			),
		),
		softContextPercent: optionalNumber(
			raw,
			"softContextPercent",
			DEFAULT_CONFIG.softContextPercent,
		),
		hardContextPercent: optionalNumber(
			raw,
			"hardContextPercent",
			DEFAULT_CONFIG.hardContextPercent,
		),
		contextReserveTokens: optionalInteger(
			raw,
			"contextReserveTokens",
			DEFAULT_CONFIG.contextReserveTokens,
		),
		slipstreamKeepRecentTokens: optionalInteger(
			raw,
			"slipstreamKeepRecentTokens",
			DEFAULT_CONFIG.slipstreamKeepRecentTokens,
		),
		minContinuationTurns: optionalInteger(
			raw,
			"minContinuationTurns",
			DEFAULT_CONFIG.minContinuationTurns,
		),
		maxContinuationTurns: optionalInteger(
			raw,
			"maxContinuationTurns",
			DEFAULT_CONFIG.maxContinuationTurns,
		),
		judgeThreshold: optionalNumber(
			raw,
			"judgeThreshold",
			DEFAULT_CONFIG.judgeThreshold,
		),
		repairAttempts: optionalInteger(
			raw,
			"repairAttempts",
			DEFAULT_CONFIG.repairAttempts,
		),
		rejectedSummaryMode: optionalRejectedSummaryMode(
			raw,
			DEFAULT_CONFIG.rejectedSummaryMode,
		),
		pendingTtlMs: optionalInteger(
			raw,
			"pendingTtlMs",
			DEFAULT_CONFIG.pendingTtlMs,
		),
		artifactRoot:
			optionalString(raw, "artifactRoot", DEFAULT_CONFIG.artifactRoot) ??
			DEFAULT_CONFIG.artifactRoot,
		retainArtifacts: optionalBoolean(
			raw,
			"retainArtifacts",
			DEFAULT_CONFIG.retainArtifacts,
		),
		statsFullPaths: optionalBoolean(
			raw,
			"statsFullPaths",
			DEFAULT_CONFIG.statsFullPaths,
		),
		summaryModel: validateModelId(
			"summaryModel",
			optionalString(raw, "summaryModel", DEFAULT_CONFIG.summaryModel),
		),
		judgeModel: validateModelId(
			"judgeModel",
			optionalString(raw, "judgeModel", DEFAULT_CONFIG.judgeModel),
		),
	};

	if (raw.fallbackMode !== undefined)
		throw new Error(
			"fallbackMode was removed; Slipstream now cancels instead of falling back to native compaction",
		);

	if (cfg.triggerContextPercent <= 0 || cfg.triggerContextPercent >= 1)
		throw new Error("triggerContextPercent must be between 0 and 1");
	if (cfg.softContextPercent <= 0 || cfg.softContextPercent >= 1)
		throw new Error("softContextPercent must be between 0 and 1");
	if (cfg.hardContextPercent <= 0 || cfg.hardContextPercent >= 1)
		throw new Error("hardContextPercent must be between 0 and 1");
	if (cfg.contextReserveTokens < 0)
		throw new Error("contextReserveTokens must be >= 0");
	if (cfg.slipstreamKeepRecentTokens < 1000)
		throw new Error("slipstreamKeepRecentTokens must be at least 1000");
	if (cfg.minContinuationTurns < 1)
		throw new Error("minContinuationTurns must be >= 1");
	if (cfg.maxContinuationTurns < cfg.minContinuationTurns)
		throw new Error("maxContinuationTurns must be >= minContinuationTurns");
	if (cfg.judgeThreshold < 0 || cfg.judgeThreshold > 10)
		throw new Error("judgeThreshold must be between 0 and 10");
	if (cfg.repairAttempts < 0 || cfg.repairAttempts > 3)
		throw new Error("repairAttempts must be between 0 and 3");
	if (cfg.pendingTtlMs < 1000)
		throw new Error("pendingTtlMs must be at least 1000");
	if (cfg.artifactRoot.trim() === "")
		throw new Error("artifactRoot must not be empty");

	return cfg;
}

export function loadSettings(cwd = process.cwd()): SlipstreamConfig {
	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const globalSettings = readJsonObject(join(agentDir, "settings.json"));
	const projectSettings = readJsonObject(join(cwd, ".pi", "settings.json"));
	const merged = mergeConfig(
		getNestedConfig(globalSettings),
		getNestedConfig(projectSettings),
	);
	const reserveTokens =
		compactionReserveTokens(projectSettings) ??
		compactionReserveTokens(globalSettings);
	if (reserveTokens !== undefined && merged.contextReserveTokens === undefined)
		merged.contextReserveTokens = reserveTokens;
	return normalizeConfig(merged);
}

export function parseCommandArgs(args: string): ParsedCommandArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const action =
		tokens[0] && !tokens[0].startsWith("--") ? tokens[0] : "status";
	const restTokens = action === tokens[0] ? tokens.slice(1) : tokens;
	const flags = new Set<string>();
	const rest: string[] = [];

	for (const token of restTokens) {
		if (token.startsWith("--") && token.length > 2) flags.add(token.slice(2));
		else rest.push(token);
	}

	return { action, flags, rest };
}
