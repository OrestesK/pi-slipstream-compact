import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { buildDefaultSlipstreamCompaction } from "../src/index.ts";
import { createRuntimeState } from "../src/session-state.ts";
import type { AgentMessage, SessionEntry } from "../src/types.ts";

function msg(id: string, message: AgentMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-05-27T00:00:00.000Z",
		message,
	};
}

async function makeRoot(): Promise<string> {
	const parent = join(process.cwd(), ".scratch", "test-tmp");
	await mkdir(parent, { recursive: true });
	return mkdtemp(join(parent, "slipstream-default-"));
}

describe("default compaction replacement", () => {
	it("returns a Slipstream hook compaction for plain Pi /compact", async () => {
		const root = await makeRoot();
		try {
			const state = createRuntimeState();
			const entries = [
				msg("u1", { role: "user", content: "Make Slipstream default." }),
				msg("a1", {
					role: "assistant",
					content: "Slipstream default replacement implemented.",
				}),
			];
			let summaryPrompt = "";
			const result = await buildDefaultSlipstreamCompaction(
				{
					preparation: { firstKeptEntryId: "a1", tokensBefore: 1234 },
					branchEntries: entries,
				},
				{
					cwd: process.cwd(),
					model: { provider: "test", id: "model" },
					modelRegistry: {
						find: () => ({ provider: "test", id: "model" }),
						getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
					},
					sessionManager: {
						getSessionId: () => "session-default",
						getBranch: () => entries,
					},
					getContextUsage: () => ({ tokens: 1234, contextWindow: 200_000 }),
				},
				{
					...DEFAULT_CONFIG,
					artifactRoot: root,
				},
				state,
				() => undefined,
				{
					createSummaryCompleter: () => async (prompt) => {
						summaryPrompt = prompt;
						return "## Goal\nMake Slipstream the default compaction path.";
					},
					createJudgeCompleter: () => async () => ({
						score: 8,
						decision: "accept",
						missing: [],
						contradictions: [],
						diagnosis: "safe default compaction",
					}),
				},
			);

			assert.equal(result?.cancel, undefined);
			assert.equal(result?.compaction?.firstKeptEntryId, "a1");
			assert.equal(result?.compaction?.tokensBefore, 1234);
			assert.equal(result?.compaction?.details.defaultReplacement, true);
			assert.equal(result?.compaction?.details.strategy, "direct");
			assert.match(summaryPrompt, /Slipstream-style compaction writer/);
			assert.match(
				summaryPrompt,
				/<conversation>\n\[user u1\]: Make Slipstream default\.\n<\/conversation>/,
			);
			assert.equal(
				summaryPrompt.startsWith("You are a compaction fact extractor"),
				false,
			);
			assert.equal(state.status, "idle");
			assert.deepEqual(await readdir(root), []);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("policy-accepts rejected default compaction when no confirm UI is available", async () => {
		const root = await makeRoot();
		try {
			const state = createRuntimeState();
			const entries = [
				msg("u1", { role: "user", content: "Reject unsafe summaries." }),
				msg("a1", { role: "assistant", content: "Candidate is incomplete." }),
			];
			const result = await buildDefaultSlipstreamCompaction(
				{
					preparation: { firstKeptEntryId: "a1", tokensBefore: 1234 },
					branchEntries: entries,
				},
				{
					cwd: process.cwd(),
					model: { provider: "test", id: "model" },
					modelRegistry: {
						find: () => ({ provider: "test", id: "model" }),
						getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
					},
					sessionManager: {
						getSessionId: () => "session-reject",
						getBranch: () => entries,
					},
				},
				{
					...DEFAULT_CONFIG,
					rejectedSummaryMode: "accept" as const,
					artifactRoot: root,
				},
				state,
				() => undefined,
				{
					createSummaryCompleter: () => async () => "## Goal\nToo vague.",
					createJudgeCompleter: () => async () => ({
						score: 3,
						decision: "reject",
						missing: ["active state"],
						contradictions: [],
						diagnosis: "unsafe default compaction",
					}),
				},
			);

			assert.equal(result?.cancel, undefined);
			assert.equal(result?.compaction?.details.rejectedSummaryAccepted, true);
			assert.equal(result?.compaction?.details.rejectedSummaryMode, "accept");
			assert.equal(result?.compaction?.details.manualOverride, false);
			assert.equal(state.status, "idle");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("cancels rejected default compaction when the user selects Reject", async () => {
		const root = await makeRoot();
		try {
			const state = createRuntimeState();
			const entries = [
				msg("u1", { role: "user", content: "Reject unsafe summaries." }),
				msg("a1", { role: "assistant", content: "Candidate is incomplete." }),
			];
			const result = await buildDefaultSlipstreamCompaction(
				{
					preparation: { firstKeptEntryId: "a1", tokensBefore: 1234 },
					branchEntries: entries,
				},
				{
					cwd: process.cwd(),
					model: { provider: "test", id: "model" },
					modelRegistry: {
						find: () => ({ provider: "test", id: "model" }),
						getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
					},
					ui: {
						notify: () => undefined,
						select: async () => "Reject",
					},
					sessionManager: {
						getSessionId: () => "session-confirm-false-default",
						getBranch: () => entries,
					},
				},
				{
					...DEFAULT_CONFIG,
					artifactRoot: root,
				},
				state,
				() => undefined,
				{
					createSummaryCompleter: () => async () => "## Goal\nToo vague.",
					createJudgeCompleter: () => async () => ({
						score: 3,
						decision: "reject",
						missing: ["active state"],
						contradictions: [],
						diagnosis: "unsafe default compaction",
					}),
				},
			);

			assert.equal(result?.cancel, true);
			assert.equal(result?.compaction, undefined);
			assert.equal(state.status, "rejected");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("cancels default compaction when continuation evidence is below the minimum", async () => {
		const state = createRuntimeState();
		let summaryCalls = 0;
		const entries = [
			msg("u1", { role: "user", content: "Need compaction before reply" }),
		];
		const result = await buildDefaultSlipstreamCompaction(
			{
				preparation: { firstKeptEntryId: "u1", tokensBefore: 1234 },
				branchEntries: entries,
			},
			{
				cwd: process.cwd(),
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				ui: { notify: () => undefined },
				sessionManager: {
					getSessionId: () => "session-too-little-continuation",
					getBranch: () => entries,
				},
			},
			{
				...DEFAULT_CONFIG,
				artifactRoot: ".scratch/test-tmp/default-too-little-continuation",
			},
			state,
			() => undefined,
			{
				createSummaryCompleter: () => async () => {
					summaryCalls += 1;
					return "## Goal\nShould not run";
				},
			},
		);

		assert.equal(result?.cancel, true);
		assert.equal(summaryCalls, 0);
		assert.equal(state.status, "rejected");
	});

	it("cancels default compaction when no model registry is available", async () => {
		const state = createRuntimeState();
		const result = await buildDefaultSlipstreamCompaction(
			{
				preparation: { firstKeptEntryId: "a1", tokensBefore: 1234 },
				branchEntries: [
					msg("u1", { role: "user", content: "Need compaction" }),
					msg("a1", { role: "assistant", content: "No registry" }),
				],
			},
			{
				cwd: process.cwd(),
				sessionManager: {
					getSessionId: () => "session-no-registry-default",
					getBranch: () => [],
				},
			},
			{
				...DEFAULT_CONFIG,
				artifactRoot: ".scratch/test-tmp/default-no-registry",
			},
			state,
			() => undefined,
		);

		assert.equal(result?.cancel, true);
		assert.equal(state.status, "idle");
	});

	it("offers manual acceptance when default validation rejects", async () => {
		const root = await makeRoot();
		try {
			const state = createRuntimeState();
			let confirmMessage = "";
			let confirmTimeout: number | undefined;
			const entries = [
				msg("u1", { role: "user", content: "Reject unsafe summaries." }),
				msg("a1", { role: "assistant", content: "Candidate is incomplete." }),
			];
			const result = await buildDefaultSlipstreamCompaction(
				{
					preparation: { firstKeptEntryId: "a1", tokensBefore: 1234 },
					branchEntries: entries,
				},
				{
					cwd: process.cwd(),
					model: { provider: "test", id: "model" },
					modelRegistry: {
						find: () => ({ provider: "test", id: "model" }),
						getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
					},
					ui: {
						notify: () => undefined,
						confirm: (_title, message, options) => {
							confirmMessage = message;
							confirmTimeout = options?.timeout;
							return true;
						},
					},
					sessionManager: {
						getSessionId: () => "session-manual-default",
						getBranch: () => entries,
					},
				},
				{
					...DEFAULT_CONFIG,
					rejectedSummaryMode: "ask" as const,
					artifactRoot: root,
				},
				state,
				() => undefined,
				{
					createSummaryCompleter: () => async () => "## Goal\nToo vague.",
					createJudgeCompleter: () => async () => ({
						score: 3,
						decision: "reject",
						missing: ["active state"],
						contradictions: [],
						diagnosis: "unsafe default compaction",
					}),
				},
			);

			assert.equal(result?.cancel, undefined);
			assert.equal(result?.compaction?.details.manualOverride, true);
			assert.equal(result?.compaction?.details.rejectedSummaryAccepted, true);
			assert.equal(result?.compaction?.details.defaultReplacement, true);
			assert.equal(confirmTimeout, 120_000);
			assert.match(confirmMessage, /Score: 3\/10/);
			assert.match(confirmMessage, /active state/);
			assert.match(confirmMessage, /Compaction summary preview:/);
			assert.equal(state.status, "idle");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
