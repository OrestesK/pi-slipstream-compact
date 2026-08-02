import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	DEFAULT_CONFIG,
	loadSettings,
	normalizeConfig,
	parseCommandArgs,
	resolveMaxConversationChars,
} from "../src/config.ts";

describe("config", () => {
	it("keeps auto-enabled direct defaults", () => {
		assert.equal(DEFAULT_CONFIG.enabled, true);
		assert.equal(DEFAULT_CONFIG.autoTrigger, true);
		assert.equal(DEFAULT_CONFIG.replaceDefaultCompact, true);
		assert.equal(DEFAULT_CONFIG.triggerContextPercent, 0.6);
		assert.equal(DEFAULT_CONFIG.softContextPercent, 0.6);
		assert.equal(DEFAULT_CONFIG.hardContextPercent, 0.6);
		assert.equal(DEFAULT_CONFIG.contextReserveTokens, 24_000);
		assert.equal(DEFAULT_CONFIG.slipstreamKeepRecentTokens, 50_000);
		assert.equal(DEFAULT_CONFIG.artifactRoot, ".scratch/compactions");
		assert.equal(DEFAULT_CONFIG.retainArtifacts, false);
		assert.equal(DEFAULT_CONFIG.repairAttempts, 3);
		assert.equal(DEFAULT_CONFIG.rejectedSummaryMode, "ask");
		assert.equal(DEFAULT_CONFIG.statsFullPaths, false);
	});

	it("normalizes valid user overrides without mutating defaults", () => {
		const cfg = normalizeConfig({
			enabled: false,
			autoTrigger: false,
			replaceDefaultCompact: false,
			triggerContextPercent: 0.7,
			softContextPercent: 0.74,
			hardContextPercent: 0.91,
			contextReserveTokens: 12_000,
			slipstreamKeepRecentTokens: 60_000,
			minContinuationTurns: 2,
			maxContinuationTurns: 5,
			judgeThreshold: 8,
			repairAttempts: 2,
			rejectedSummaryMode: "accept",
			pendingTtlMs: 10_000,
			summaryModel: "openai/gpt-4o-mini",
			judgeModel: "anthropic/claude-sonnet-4-5",
			artifactRoot: "tmp/slipstream",
			retainArtifacts: true,
			statsFullPaths: true,
		});

		assert.equal(cfg.enabled, false);
		assert.equal(cfg.autoTrigger, false);
		assert.equal(cfg.replaceDefaultCompact, false);
		assert.equal(
			normalizeConfig({ replaceDefaultCompact: false }).autoTrigger,
			false,
		);
		assert.equal(
			normalizeConfig({ replaceDefaultCompact: false, autoTrigger: true })
				.autoTrigger,
			false,
		);
		assert.equal(cfg.triggerContextPercent, 0.7);
		assert.equal(cfg.softContextPercent, 0.74);
		assert.equal(cfg.hardContextPercent, 0.91);
		assert.equal(cfg.contextReserveTokens, 12_000);
		assert.equal(cfg.slipstreamKeepRecentTokens, 60_000);
		assert.equal(cfg.minContinuationTurns, 2);
		assert.equal(cfg.maxContinuationTurns, 5);
		assert.equal(cfg.judgeThreshold, 8);
		assert.equal(cfg.repairAttempts, 2);
		assert.equal(cfg.rejectedSummaryMode, "accept");
		assert.equal(cfg.pendingTtlMs, 10_000);
		assert.equal(cfg.summaryModel, "openai/gpt-4o-mini");
		assert.equal(cfg.judgeModel, "anthropic/claude-sonnet-4-5");
		assert.equal(cfg.artifactRoot, "tmp/slipstream");
		assert.equal(cfg.retainArtifacts, true);
		assert.equal(cfg.statsFullPaths, true);
		assert.equal(DEFAULT_CONFIG.autoTrigger, true);
	});

	it("rejects invalid thresholds and model ids", () => {
		assert.throws(
			() => normalizeConfig({ triggerContextPercent: 1.2 }),
			/triggerContextPercent/,
		);
		assert.throws(
			() => normalizeConfig({ softContextPercent: 1.2 }),
			/triggerContextPercent/,
		);
		assert.equal(
			normalizeConfig({ hardContextPercent: 0.2 }).hardContextPercent,
			0.2,
		);
		assert.throws(
			() => normalizeConfig({ minContinuationTurns: 0 }),
			/minContinuationTurns/,
		);
		assert.throws(
			() => normalizeConfig({ maxContinuationTurns: 0 }),
			/maxContinuationTurns/,
		);
		assert.throws(
			() => normalizeConfig({ judgeThreshold: 11 }),
			/judgeThreshold/,
		);
		assert.throws(
			() => normalizeConfig({ summaryModel: "not-a-model" }),
			/summaryModel/,
		);
		assert.throws(
			() => normalizeConfig({ contextReserveTokens: -1 }),
			/contextReserveTokens/,
		);
		assert.throws(
			() => normalizeConfig({ slipstreamKeepRecentTokens: 999 }),
			/slipstreamKeepRecentTokens/,
		);
		assert.throws(
			() => normalizeConfig({ rejectedSummaryMode: "cancel" }),
			/rejectedSummaryMode/,
		);
		assert.throws(
			() => normalizeConfig({ fallbackMode: "native-after-repair-failure" }),
			/fallbackMode was removed/,
		);
	});

	it("parses command flags conservatively", () => {
		assert.deepEqual(parseCommandArgs("status"), {
			action: "status",
			flags: new Set<string>(),
			rest: [],
		});
		const parsed = parseCommandArgs("compact --dry-run --adopt --direct extra");
		assert.equal(parsed.action, "compact");
		assert.equal(parsed.flags.has("dry-run"), true);
		assert.equal(parsed.flags.has("adopt"), true);
		assert.equal(parsed.flags.has("direct"), true);
		assert.deepEqual(parsed.rest, ["extra"]);
	});

	it("loads global and project settings with project precedence", async () => {
		const root = await mkdtemp(join(tmpdir(), "slipstream-config-"));
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			await mkdir(join(projectDir, ".pi"), { recursive: true });
			await mkdir(agentDir, { recursive: true });
			await writeFile(
				join(agentDir, "settings.json"),
				JSON.stringify({
					slipstreamCompact: { autoTrigger: false, judgeThreshold: 6 },
				}),
				"utf8",
			);
			await writeFile(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({ "pi-slipstream-compact": { autoTrigger: true } }),
				"utf8",
			);
			process.env.PI_CODING_AGENT_DIR = agentDir;

			const cfg = loadSettings(projectDir);

			assert.equal(cfg.autoTrigger, true);
			assert.equal(cfg.judgeThreshold, 6);
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("falls back to defaults for unreadable or invalid settings JSON", async () => {
		const root = await mkdtemp(join(tmpdir(), "slipstream-config-"));
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			await mkdir(join(projectDir, ".pi"), { recursive: true });
			await mkdir(agentDir, { recursive: true });
			await writeFile(join(agentDir, "settings.json"), "not json", "utf8");
			await writeFile(join(projectDir, ".pi", "settings.json"), "[]", "utf8");
			process.env.PI_CODING_AGENT_DIR = agentDir;

			const cfg = loadSettings(projectDir);
			assert.equal(cfg.autoTrigger, DEFAULT_CONFIG.autoTrigger);
			assert.equal(cfg.summaryModel, undefined);
			assert.equal(cfg.judgeModel, undefined);
		} finally {
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			await rm(root, { recursive: true, force: true });
		}
	});

	it("resolves model-aware conversation budgets with safe fallback", () => {
		assert.equal(resolveMaxConversationChars(undefined), 450_000);
		assert.equal(
			resolveMaxConversationChars({ tokens: 10_000, contextWindow: 64_000 }),
			120_000,
		);
		assert.equal(
			resolveMaxConversationChars({
				tokens: 100_000,
				contextWindow: 1_000_000,
			}),
			700_000,
		);
	});
});
