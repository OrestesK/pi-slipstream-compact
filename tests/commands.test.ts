import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ArtifactStore } from "../src/artifact-store.ts";
import {
	acceptRejectedSummaryByPolicy,
	buildStatusText,
	clearPendingArtifact,
	handleAdoptCommand,
	handleSlipstreamCommand,
	persistPendingArtifact,
	recoverPendingArtifact,
	resolveArtifactRoot,
	schedulePendingExpiryCleanup,
} from "../src/commands.ts";
import { getSlipstreamArgumentCompletions } from "../src/index.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	claimProgressOwner,
	createRuntimeState,
	storePendingValidated,
} from "../src/session-state.ts";

async function waitUntil(
	condition: () => boolean,
	label: string,
	timeoutMs = 3_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("commands", () => {
	it("ask mode accepts rejected summaries when the selection times out", async () => {
		const result = await acceptRejectedSummaryByPolicy(
			{
				ui: {
					select: () => undefined,
				},
			},
			{
				mode: "validated",
				accepted: false,
				repaired: false,
				artifactDir: "/tmp/slipstream",
				summary: "## Goal\nTimeout accept",
				judge: {
					score: 4,
					decision: "reject",
					missing: ["critical fact"],
					contradictions: [],
					diagnosis: "below threshold",
				},
				firstKeptEntryId: "a1",
				tokensBefore: 100,
			},
			"ask",
			true,
		);

		assert.deepEqual(result, {
			accepted: true,
			confirmed: false,
			mode: "ask",
		});
	});

	it("ask mode rejects rejected summaries when fallback confirm returns false", async () => {
		const result = await acceptRejectedSummaryByPolicy(
			{
				ui: {
					confirm: () => false,
				},
			},
			{
				mode: "validated",
				accepted: false,
				repaired: false,
				artifactDir: "/tmp/slipstream-artifacts",
				summary: "## Goal\nWeak summary",
				judge: {
					score: 4,
					decision: "reject",
					missing: ["Missing protected fact"],
					contradictions: [],
					diagnosis: "Too weak",
				},
				firstKeptEntryId: "a1",
				tokensBefore: 100,
			},
			"ask",
			true,
		);

		assert.deepEqual(result, {
			accepted: false,
			confirmed: false,
			mode: "ask",
		});
	});

	it("keeps rejected summary select prompt concise with score visible", async () => {
		let selectPrompt = "";
		const result = await acceptRejectedSummaryByPolicy(
			{
				ui: {
					select: (prompt) => {
						selectPrompt = prompt;
						return "Accept";
					},
				},
			},
			{
				mode: "validated",
				accepted: false,
				repaired: true,
				artifactDir: "/tmp/slipstream-artifacts",
				summary: `## Goal\n${"long summary ".repeat(200)}`,
				judge: {
					score: 9,
					decision: "reject",
					missing: ["Missing latest verification result"],
					contradictions: [],
					diagnosis: "High score but missing protected evidence",
				},
				firstKeptEntryId: "a1",
				tokensBefore: 100,
			},
			"ask",
			true,
		);

		assert.deepEqual(result, {
			accepted: true,
			confirmed: true,
			mode: "ask",
		});
		assert.match(selectPrompt, /Score: 9\/10/);
		assert.match(selectPrompt, /High score but missing protected evidence/);
		assert.match(selectPrompt, /Missing latest verification result/);
		assert.match(selectPrompt, /\/tmp\/slipstream-artifacts/);
		assert.match(selectPrompt, /full summary is stored in artifacts/i);
		assert.doesNotMatch(selectPrompt, /Compaction summary preview:/);
		assert.doesNotMatch(selectPrompt, /long summary long summary/);
	});

	it("resolves relative artifact roots against the Pi project cwd", async () => {
		assert.equal(
			await resolveArtifactRoot("/repo/project", ".scratch/compactions"),
			"/repo/project/.scratch/compactions",
		);
		assert.equal(
			await resolveArtifactRoot(
				"/repo/project",
				"/repo/project/.scratch/slipstream",
			),
			"/repo/project/.scratch/slipstream",
		);
		await assert.rejects(
			() => resolveArtifactRoot("/repo/project", "/tmp/slipstream"),
			/artifactRoot must resolve inside/,
		);
		await assert.rejects(
			() => resolveArtifactRoot("/repo/project", "../slipstream"),
			/artifactRoot must resolve inside/,
		);
	});

	it("rejects artifact roots that escape the project through symlinks", async () => {
		const parent = mkdtempSync(
			join(process.cwd(), ".scratch", "test-tmp", "artifact-root-"),
		);
		try {
			const project = join(parent, "project");
			const outside = join(parent, "outside");
			mkdirSync(project, { recursive: true });
			mkdirSync(outside, { recursive: true });
			symlinkSync(outside, join(project, "linked-out"), "dir");

			await assert.rejects(
				() => resolveArtifactRoot(project, "linked-out"),
				/artifactRoot must resolve inside/,
			);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("surfaces pending artifact root and write filesystem errors", async () => {
		const parent = mkdtempSync(
			join(process.cwd(), ".scratch", "test-tmp", "pending-fs-"),
		);
		try {
			const notDirectory = join(parent, "not-a-directory");
			writeFileSync(notDirectory, "file", "utf8");

			await assert.rejects(
				() =>
					recoverPendingArtifact(
						notDirectory,
						"s1",
						"/repo",
						100,
						1_000,
						false,
					),
				/Failed to scan pending Slipstream artifacts/,
			);
			await assert.rejects(
				() =>
					persistPendingArtifact(notDirectory, {
						sessionId: "s1",
						cwd: "/repo",
						projectId: "/repo",
						artifactDir: "/tmp/slipstream-pending",
						summary: "## Goal\nPending",
						firstKeptEntryId: "a1",
						validatedThroughEntryId: "a1",
						tokensBefore: null,
						details: { judge: { score: 8 }, artifacts: [] },
						expiresAt: 200,
					}),
				/Failed to persist pending Slipstream artifact/,
			);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});

	it("completes top-level actions and compact-only flags", () => {
		assert.deepEqual(
			getSlipstreamArgumentCompletions("").map((item) => item.value),
			["status", "artifacts", "compact"],
		);
		assert.deepEqual(
			getSlipstreamArgumentCompletions("--").map((item) => item.value),
			[],
		);
		assert.deepEqual(
			getSlipstreamArgumentCompletions("compact ").map((item) => item.value),
			["--direct", "--dry-run", "--prepare", "--adopt"],
		);
		assert.deepEqual(
			getSlipstreamArgumentCompletions("compact --f").map((item) => item.value),
			[],
		);
	});

	it("ignores stale context while restoring command status", async () => {
		const state = createRuntimeState({ now: 100 });
		const result = await handleSlipstreamCommand(
			"status",
			state,
			DEFAULT_CONFIG,
			{
				ui: {
					notify: () => undefined,
					setStatus: () => {
						throw new Error(
							"This extension ctx is stale after session replacement or reload.",
						);
					},
					setWidget: () => undefined,
				},
			},
		);

		assert.equal(result.ok, true);
		assert.match(result.message, /idle/i);
	});

	it("renders status with pending judge and artifact details", () => {
		const state = createRuntimeState({ now: 100 });
		assert.match(buildStatusText(state), /idle/i);
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "validated",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9, diagnosis: "ok" }, artifacts: ["a.json"] },
			expiresAt: 200,
		});
		const text = buildStatusText(state);
		assert.match(text, /pending validated summary/i);
		assert.match(text, /score 9/);
		assert.match(text, /a.json/);
	});

	it("shows dry-run progress without retaining terminal artifacts", async (t) => {
		const state = createRuntimeState({ now: 100 });
		const artifactRoot = join(
			process.cwd(),
			`.scratch/test-tmp/command-dry-run-status-${Date.now()}`,
		);
		t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
		const statusUpdates: Array<string | undefined> = [];
		const widgetUpdates: Array<string[] | undefined> = [];
		const notifications: string[] = [];
		const result = await handleSlipstreamCommand(
			"compact --dry-run",
			state,
			{ ...DEFAULT_CONFIG, artifactRoot },
			{
				cwd: process.cwd(),
				ui: {
					notify: (message) => notifications.push(message),
					setStatus: (_key, text) => statusUpdates.push(text),
					setWidget: (_key, lines) => widgetUpdates.push(lines),
				},
				sessionManager: {
					getSessionId: () => "session-dry-run-status",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "Use Slipstream" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "done" },
						},
					],
				},
			},
			{ now: () => 100 },
		);

		assert.equal(result.ok, true);
		assert.match(statusUpdates.join("\n"), /Building candidate summary prompt/);
		assert.match(
			widgetUpdates.flat().join("\n"),
			/Slipstream: summarizing · 0s/,
		);
		assert.equal(statusUpdates.at(-1), "slipstream: manual");
		assert.equal(widgetUpdates.at(-1), undefined);
		assert.deepEqual(notifications, []);
		assert.match(result.message, /no artifacts were retained/);
		assert.deepEqual(readdirSync(artifactRoot), []);
	});

	it("command progress does not preempt active lifecycle progress", async () => {
		const state = createRuntimeState({ now: 100 });
		let lifecycleCleared = false;
		const lifecycleOwner = claimProgressOwner(state, "lifecycle", () => {
			lifecycleCleared = true;
		});
		const statusUpdates: Array<string | undefined> = [];
		const widgetUpdates: Array<string[] | undefined> = [];
		const result = await handleSlipstreamCommand(
			"compact --dry-run",
			state,
			{
				...DEFAULT_CONFIG,
				artifactRoot: ".scratch/test-tmp/command-dry-run-active-owner",
			},
			{
				cwd: process.cwd(),
				ui: {
					notify: () => undefined,
					setStatus: (_key, text) => statusUpdates.push(text),
					setWidget: (_key, lines) => widgetUpdates.push(lines),
				},
				sessionManager: {
					getSessionId: () => "session-dry-run-active-owner",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "Use Slipstream" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "done" },
						},
					],
				},
			},
			{ now: () => 100 },
		);

		assert.equal(result.ok, true);
		assert.equal(lifecycleCleared, false);
		assert.equal(state.progressOwner?.owner, lifecycleOwner);
		assert.deepEqual(statusUpdates, []);
		assert.deepEqual(widgetUpdates, []);
	});

	it("prepare command does not tick footer status during a long progress phase", async () => {
		const state = createRuntimeState({ now: 100 });
		const statusUpdates: Array<string | undefined> = [];
		const widgetUpdates: Array<string[] | undefined> = [];
		const notifications: string[] = [];
		const result = await handleSlipstreamCommand(
			"compact --prepare",
			state,
			{
				...DEFAULT_CONFIG,
				artifactRoot: ".scratch/test-tmp/command-progress-status-churn",
			},
			{
				cwd: process.cwd(),
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				ui: {
					notify: (message) => notifications.push(message),
					setStatus: (_key, text) => statusUpdates.push(text),
					setWidget: (_key, lines) => widgetUpdates.push(lines),
				},
				sessionManager: {
					getSessionId: () => "session-progress-status-churn",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "Use Slipstream" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "done" },
						},
					],
				},
				getContextUsage: () => ({ tokens: 1000 }),
			},
			{
				now: () => 100,
				createSummaryCompleter: () => async () => {
					await new Promise((resolve) => setTimeout(resolve, 1_100));
					return "## Goal\nUse Slipstream";
				},
				createJudgeCompleter: () => async () => ({
					score: 8,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "good",
				}),
			},
		);

		assert.equal(result.ok, true);
		assert.equal(
			statusUpdates.filter((text) =>
				text?.includes("Generating candidate summary"),
			).length,
			1,
		);
		assert.ok(
			widgetUpdates.filter((lines) => lines?.join("\n").includes("summarizing"))
				.length >= 2,
		);
		assert.equal(statusUpdates.at(-1), "slipstream: pending");
		assert.deepEqual(notifications, []);
	});

	it("expires prepared artifacts through an injected clock in both retention modes", async (t) => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		mkdirSync(parent, { recursive: true });
		const artifactRoot = mkdtempSync(join(parent, "command-expiry-"));
		t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
		const store = new ArtifactStore({ root: artifactRoot });

		for (const retainArtifacts of [false, true]) {
			const run = await store.createRun({
				sessionId: `session-${retainArtifacts}`,
				triggerEntryId: `trigger-${retainArtifacts}`,
				cwd: process.cwd(),
			});
			const pending = {
				sessionId: run.sessionId,
				cwd: run.cwd,
				projectId: run.cwd,
				artifactDir: run.dir,
				summary: "## Goal\nUse Slipstream",
				firstKeptEntryId: "a1",
				validatedThroughEntryId: "a1",
				tokensBefore: 1_000,
				details: { judge: { score: 8 } },
				expiresAt: 2_000,
			};
			await persistPendingArtifact(run.dir, pending);
			const state = createRuntimeState();
			storePendingValidated(state, pending);
			let expire: (() => void) | undefined;
			let scheduledDelay = -1;
			let now = 1_000;

			schedulePendingExpiryCleanup(
				state,
				pending,
				artifactRoot,
				retainArtifacts,
				() => now,
				(callback, delayMs) => {
					expire = callback;
					scheduledDelay = delayMs;
					return {};
				},
			);

			assert.equal(scheduledDelay, 1_000);
			assert.equal(state.pending, pending);
			assert.ok(expire);
			now = pending.expiresAt;
			expire();
			assert.equal(state.pending, null);
			assert.equal(state.status, "idle");
			if (retainArtifacts) {
				await waitUntil(
					() => !existsSync(join(run.dir, "pending.json")),
					"retained pending marker expiry",
				);
				assert.equal(existsSync(run.dir), true);
			} else {
				await waitUntil(() => !existsSync(run.dir), "prepared artifact expiry");
			}
		}
	});

	it("rearms expiry cleanup when the deadline exceeds Node's timer limit", async (t) => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		mkdirSync(parent, { recursive: true });
		const artifactRoot = mkdtempSync(join(parent, "command-long-expiry-"));
		t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
		const run = await new ArtifactStore({ root: artifactRoot }).createRun({
			sessionId: "session-long-expiry",
			triggerEntryId: "a1",
			cwd: process.cwd(),
		});
		const pending = {
			sessionId: run.sessionId,
			cwd: run.cwd,
			projectId: run.cwd,
			artifactDir: run.dir,
			summary: "## Goal\nUse Slipstream",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 1_000,
			details: { judge: { score: 8 } },
			expiresAt: 3_000_000_000,
		};
		await persistPendingArtifact(run.dir, pending);
		const state = createRuntimeState();
		storePendingValidated(state, pending);
		const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
		let now = 0;

		schedulePendingExpiryCleanup(
			state,
			pending,
			artifactRoot,
			false,
			() => now,
			(callback, delayMs) => {
				scheduled.push({ callback, delayMs });
				return {};
			},
		);

		assert.equal(scheduled[0]?.delayMs, 2_147_483_647);
		now = 2_147_483_647;
		scheduled[0]?.callback();
		assert.equal(scheduled[1]?.delayMs, 852_516_353);
		assert.equal(state.pending, pending);
		now = pending.expiresAt;
		scheduled[1]?.callback();
		assert.equal(state.pending, null);
		await waitUntil(() => !existsSync(run.dir), "long-delay artifact expiry");
	});

	it("revalidates a pending summary before adoption when the branch advanced", async () => {
		const state = createRuntimeState({ now: 100 });
		const config = {
			...DEFAULT_CONFIG,
			retainArtifacts: true,
			maxContinuationTurns: 2,
			minContinuationTurns: 1,
			repairAttempts: 0,
			pendingTtlMs: 10_000,
			artifactRoot: ".scratch/test-tmp/command-stale-adopt",
		};
		const branch = [
			{
				type: "message" as const,
				id: "u1",
				parentId: null,
				timestamp: "t",
				message: { role: "user" as const, content: "Use old state" },
			},
			{
				type: "message" as const,
				id: "a1",
				parentId: null,
				timestamp: "t",
				message: { role: "assistant" as const, content: "Old answer" },
			},
		];
		let summaryCalls = 0;
		const result = await handleSlipstreamCommand(
			"compact --prepare",
			state,
			config,
			{
				cwd: process.cwd(),
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "session-stale-adopt",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 1000 }),
			},
			{
				createSummaryCompleter: () => async () => {
					summaryCalls += 1;
					return `## Goal\nSummary ${summaryCalls}`;
				},
				createJudgeCompleter: () => async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
				now: () => 100,
			},
		);
		assert.equal(result.ok, true);
		assert.equal(state.pending?.validatedThroughEntryId, "a1");

		branch.push({
			type: "message",
			id: "u2",
			parentId: null,
			timestamp: "t",
			message: { role: "user", content: "Newest correction before adopt" },
		});
		let compactCalls = 0;
		const adoptResult = await handleSlipstreamCommand(
			"compact --adopt",
			state,
			config,
			{
				cwd: process.cwd(),
				compact: () => {
					compactCalls += 1;
				},
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "session-stale-adopt",
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 1100 }),
			},
			{
				createSummaryCompleter: () => async () => {
					summaryCalls += 1;
					return `## Goal\nSummary ${summaryCalls}`;
				},
				createJudgeCompleter: () => async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok after branch advanced",
				}),
				now: () => 101,
			},
		);

		assert.equal(adoptResult.ok, true);
		assert.equal(compactCalls, 1);
		assert.equal(summaryCalls, 2);
		assert.equal(state.pending?.validatedThroughEntryId, "u2");
		assert.match(state.pending?.summary ?? "", /Summary 2/);
	});

	it("compact --adopt keeps a validated summary pending while Pi is busy", async () => {
		const state = createRuntimeState({ now: 100 });
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "## Goal\nReady",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 100,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 4_000_000_000_000,
		});
		let compactCalls = 0;

		const result = await handleSlipstreamCommand(
			"compact --adopt",
			state,
			DEFAULT_CONFIG,
			{
				cwd: "/repo",
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => true,
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => [
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "ready" },
						},
					],
				},
			},
			{ now: () => 150 },
		);

		assert.equal(result.ok, false);
		assert.match(result.message, /Pi is busy/);
		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");
		assert.equal(state.pending?.summary, "## Goal\nReady");
	});

	it("one-shot compact prepares but does not apply while Pi has pending messages", async () => {
		const state = createRuntimeState({ now: 100 });
		let compactCalls = 0;
		const result = await handleSlipstreamCommand(
			"compact",
			state,
			{
				...DEFAULT_CONFIG,
				maxContinuationTurns: 2,
				repairAttempts: 0,
				pendingTtlMs: 10_000,
				artifactRoot: ".scratch/test-tmp/command-one-shot-busy",
			},
			{
				cwd: process.cwd(),
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				compact: () => {
					compactCalls += 1;
				},
				isIdle: () => true,
				hasPendingMessages: () => true,
				sessionManager: {
					getSessionId: () => "session-one-shot-busy",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "Use one-shot compact" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "I continued" },
						},
					],
				},
				getContextUsage: () => ({ tokens: null, contextWindow: 1_000_000 }),
			},
			{
				createSummaryCompleter: () => async () =>
					"## Goal\nUse one-shot compact while busy",
				createJudgeCompleter: () => async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
				now: () => 100,
			},
		);

		assert.equal(result.ok, false);
		assert.match(result.message, /Pi is busy/);
		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");
		assert.match(state.pending?.summary ?? "", /one-shot compact while busy/);
	});

	it("prepare refuses when continuation evidence is below the configured minimum", async () => {
		const state = createRuntimeState({ now: 100 });
		const result = await handleSlipstreamCommand(
			"compact --prepare",
			state,
			{
				...DEFAULT_CONFIG,
				minContinuationTurns: 2,
				maxContinuationTurns: 2,
				artifactRoot: ".scratch/test-tmp/command-too-few-prepare",
			},
			{
				cwd: process.cwd(),
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "session-too-few-prepare",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "only user" },
						},
					],
				},
			},
			{ now: () => 100 },
		);

		assert.equal(result.ok, false);
		assert.match(result.message, /Need at least 2 continuation turn/i);
		assert.equal(state.pending, null);
	});

	it("stale adopt refuses revalidation when continuation evidence is below the configured minimum", async () => {
		const state = createRuntimeState({ now: 100 });
		storePendingValidated(state, {
			sessionId: "session-too-few-adopt",
			cwd: process.cwd(),
			projectId: process.cwd(),
			artifactDir: "/tmp/slipstream-pending",
			summary: "stale",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 1000,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 10_000,
		});
		let compactCalls = 0;
		const result = await handleSlipstreamCommand(
			"compact --adopt",
			state,
			{
				...DEFAULT_CONFIG,
				minContinuationTurns: 2,
				maxContinuationTurns: 2,
				pendingTtlMs: 10_000,
			},
			{
				cwd: process.cwd(),
				compact: () => {
					compactCalls += 1;
				},
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "session-too-few-adopt",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "old" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "old answer" },
						},
						{
							type: "message",
							id: "u2",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "new correction" },
						},
					],
				},
			},
			{ now: () => 101 },
		);

		assert.equal(result.ok, false);
		assert.match(result.message, /needs at least 2 continuation turn/i);
		assert.equal(compactCalls, 0);
		assert.equal(state.pending?.summary, "stale");
	});

	it("stale adopt fails without model registry before applying a stale pending summary", async () => {
		const state = createRuntimeState({ now: 100 });
		storePendingValidated(state, {
			sessionId: "session-no-registry",
			cwd: process.cwd(),
			projectId: process.cwd(),
			artifactDir: "/tmp/slipstream-pending",
			summary: "stale",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 1000,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 10_000,
		});
		let compactCalls = 0;
		const result = await handleSlipstreamCommand(
			"compact --adopt",
			state,
			{ ...DEFAULT_CONFIG, maxContinuationTurns: 2, pendingTtlMs: 10_000 },
			{
				cwd: process.cwd(),
				compact: () => {
					compactCalls += 1;
				},
				sessionManager: {
					getSessionId: () => "session-no-registry",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "old" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "old answer" },
						},
						{
							type: "message",
							id: "u2",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "new correction" },
						},
					],
				},
			},
			{ now: () => 101 },
		);

		assert.equal(result.ok, false);
		assert.match(result.message, /no model registry/i);
		assert.equal(compactCalls, 0);
		assert.equal(state.pending?.summary, "stale");
	});

	it("stale adopt policy-accepts rejected revalidation without prompt", async (t) => {
		const parent = join(process.cwd(), ".scratch", "test-tmp");
		mkdirSync(parent, { recursive: true });
		const artifactRoot = mkdtempSync(join(parent, "rejected-revalidation-"));
		t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
		const oldRun = await new ArtifactStore({ root: artifactRoot }).createRun({
			sessionId: "session-reject-revalidation",
			triggerEntryId: "a1",
			cwd: process.cwd(),
		});
		const state = createRuntimeState({ now: 100 });
		storePendingValidated(state, {
			sessionId: "session-reject-revalidation",
			cwd: process.cwd(),
			projectId: process.cwd(),
			artifactDir: oldRun.dir,
			summary: "stale",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 1000,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 10_000,
		});
		let compactCalls = 0;
		const result = await handleSlipstreamCommand(
			"compact --adopt",
			state,
			{
				...DEFAULT_CONFIG,
				artifactRoot,
				rejectedSummaryMode: "accept" as const,
				maxContinuationTurns: 2,
				pendingTtlMs: 10_000,
				repairAttempts: 0,
			},
			{
				cwd: process.cwd(),
				compact: () => {
					compactCalls += 1;
				},
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "session-reject-revalidation",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "old" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "old answer" },
						},
						{
							type: "message",
							id: "u2",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "new correction" },
						},
					],
				},
				getContextUsage: () => ({ tokens: 1100 }),
			},
			{
				createSummaryCompleter: () => async () => "## Goal\nRejected",
				createJudgeCompleter: () => async () => ({
					score: 1,
					decision: "reject",
					missing: ["new correction"],
					contradictions: [],
					diagnosis: "still stale",
				}),
				now: () => 101,
			},
		);

		assert.equal(result.ok, true);
		assert.match(result.message, /Queued compaction/);
		assert.equal(compactCalls, 1);
		assert.equal(state.pending?.validatedThroughEntryId, "u2");
		assert.equal(state.pending?.details.revalidatedFromEntryId, "a1");
		assert.equal(state.pending?.details.rejectedSummaryAccepted, true);
		assert.equal(state.pending?.details.manualOverride, false);
	});

	it("recovers the valid pending artifact while ignoring malformed and wrong-cwd candidates", async () => {
		const sessionId = `session-recover-matrix-${Date.now()}`;
		const root = join(
			process.cwd(),
			".scratch",
			"test-tmp",
			`recover-matrix-${Date.now()}`,
		);
		const malformedDir = join(root, `${sessionId}-malformed`);
		const wrongCwdDir = join(root, `${sessionId}-wrong-cwd`);
		mkdirSync(malformedDir, { recursive: true });
		mkdirSync(wrongCwdDir, { recursive: true });
		const validRun = await new ArtifactStore({ root }).createRun({
			sessionId,
			triggerEntryId: "a1",
			cwd: process.cwd(),
		});
		const validDir = validRun.dir;
		writeFileSync(join(malformedDir, "pending.json"), "{not json");
		writeFileSync(
			join(wrongCwdDir, "pending.json"),
			`${JSON.stringify({
				sessionId,
				cwd: "/wrong",
				projectId: "/wrong",
				summary: "wrong cwd",
				firstKeptEntryId: "a1",
				validatedThroughEntryId: "a1",
				tokensBefore: 100,
				details: { judge: { score: 9 }, artifacts: [] },
				expiresAt: 200,
			})}\n`,
		);
		writeFileSync(
			join(validDir, "pending.json"),
			`${JSON.stringify({
				sessionId,
				cwd: process.cwd(),
				projectId: process.cwd(),
				summary: "valid recovered",
				firstKeptEntryId: "a1",
				validatedThroughEntryId: "a1",
				tokensBefore: 100,
				details: { judge: { score: 9 }, artifacts: [validDir] },
				expiresAt: 200,
			})}\n`,
		);
		let compactCalls = 0;
		const state = createRuntimeState({ now: 100 });
		const result = await handleSlipstreamCommand(
			"compact --adopt",
			state,
			{ ...DEFAULT_CONFIG, artifactRoot: root, pendingTtlMs: 10_000 },
			{
				cwd: process.cwd(),
				compact: () => {
					compactCalls += 1;
				},
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () => [],
				},
			},
			{ now: () => 100 },
		);

		assert.equal(result.ok, true);
		assert.equal(compactCalls, 1);
		assert.equal(state.pending?.summary, "valid recovered");
	});

	it("accepts explicit direct compact as the single runtime strategy", async () => {
		const state = createRuntimeState({ now: 100 });
		const result = await handleSlipstreamCommand(
			"compact --prepare --direct",
			state,
			{
				...DEFAULT_CONFIG,
				maxContinuationTurns: 2,
				repairAttempts: 0,
				pendingTtlMs: 10_000,
				artifactRoot: ".scratch/test-tmp/command-direct",
			},
			{
				cwd: process.cwd(),
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => "session-direct",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "Use direct compact" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "I continued" },
						},
					],
				},
				getContextUsage: () => ({ tokens: 1000 }),
			},
			{
				createSummaryCompleter: () => async () => "## Goal\nUse direct compact",
				createJudgeCompleter: () => async () => ({
					score: 8,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
				now: () => 100,
			},
		);

		assert.equal(result.ok, true);
	});

	it("rejects removed fact-ledger strategy flag", async () => {
		const state = createRuntimeState({ now: 100 });
		const result = await handleSlipstreamCommand(
			"compact --prepare --fact-ledger",
			state,
			DEFAULT_CONFIG,
			{},
			{ now: () => 100 },
		);

		assert.equal(result.ok, false);
		assert.match(result.message, /--fact-ledger/);
	});

	it("rejects removed legacy strategy flags", async () => {
		const state = createRuntimeState({ now: 100 });
		const legacyFlag = `--${"v"}2`;
		const result = await handleSlipstreamCommand(
			`compact ${legacyFlag}`,
			state,
			DEFAULT_CONFIG,
			{},
		);

		assert.equal(result.ok, false);
		assert.match(result.message, new RegExp(legacyFlag));
	});

	it("rejects removed high-accuracy flag", async () => {
		const state = createRuntimeState({ now: 100 });
		const result = await handleSlipstreamCommand(
			"compact --high-accuracy",
			state,
			{
				...DEFAULT_CONFIG,
				maxContinuationTurns: 2,
				repairAttempts: 0,
				pendingTtlMs: 10_000,
				artifactRoot: ".scratch/test-tmp/command-high-removed",
			},
			{},
			{ now: () => 100 },
		);

		assert.equal(result.ok, false);
		assert.match(result.message, /High-accuracy mode was removed/);
	});

	it("rejects unknown compact flags and positional arguments", async () => {
		const state = createRuntimeState({ now: 100 });
		const flagResult = await handleSlipstreamCommand(
			"compact --prepare --bogus",
			state,
			DEFAULT_CONFIG,
			{},
			{ now: () => 100 },
		);
		const positionalResult = await handleSlipstreamCommand(
			"compact unexpected",
			state,
			DEFAULT_CONFIG,
			{},
			{ now: () => 100 },
		);

		assert.equal(flagResult.ok, false);
		assert.match(flagResult.message, /--bogus/);
		assert.equal(positionalResult.ok, false);
		assert.match(positionalResult.message, /unexpected/);
	});

	it("compact command prepares and applies in one step", async () => {
		const state = createRuntimeState({ now: 100 });
		let compactCalls = 0;
		const result = await handleSlipstreamCommand(
			"compact",
			state,
			{
				...DEFAULT_CONFIG,
				maxContinuationTurns: 2,
				repairAttempts: 0,
				pendingTtlMs: 10_000,
				artifactRoot: ".scratch/test-tmp/command-one-shot",
			},
			{
				cwd: process.cwd(),
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				compact: () => {
					compactCalls += 1;
				},
				sessionManager: {
					getSessionId: () => "session-one-shot",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "Use one-shot compact" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "I continued" },
						},
					],
				},
				getContextUsage: () => ({ tokens: null, contextWindow: 1_000_000 }),
			},
			{
				createSummaryCompleter: () => async () =>
					"## Goal\nUse one-shot compact",
				createJudgeCompleter: () => async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
				now: () => 100,
			},
		);

		assert.equal(result.ok, true);
		assert.equal(compactCalls, 1);
		assert.match(result.message, /Queued compaction/);
	});

	it("adopt command is explicit and refuses missing pending state", () => {
		const state = createRuntimeState({ now: 100 });
		let calls = 0;
		const missing = handleAdoptCommand(state, {
			compact: () => {
				calls += 1;
			},
		});
		assert.equal(missing.ok, false);
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "validated",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 200,
		});
		const adopted = handleAdoptCommand(
			state,
			{
				compact: () => {
					calls += 1;
				},
			},
			150,
			"s1",
		);
		assert.equal(adopted.ok, true);
		assert.equal(calls, 1);
		const repeated = handleAdoptCommand(
			state,
			{
				compact: () => {
					calls += 1;
				},
			},
			150,
			"s1",
		);
		assert.equal(repeated.ok, false);
		assert.equal(calls, 1);
	});

	it("adopt command restores user-facing status after compact callbacks", async () => {
		const state = createRuntimeState({ now: 100 });
		const statuses: Array<string | undefined> = [];
		let onComplete: ((result: unknown) => void) | undefined;
		let onError: ((error: Error) => void) | undefined;
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "validated",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 200,
		});

		const result = await handleSlipstreamCommand(
			"compact --adopt",
			state,
			DEFAULT_CONFIG,
			{
				cwd: "/repo",
				compact: (options) => {
					onComplete = options?.onComplete;
					onError = options?.onError;
				},
				ui: {
					notify: () => undefined,
					setStatus: (_key, text) => {
						statuses.push(text);
					},
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => [],
				},
			},
			{ now: () => 150 },
		);

		assert.equal(result.ok, true);
		assert.equal(statuses.at(-1), "slipstream: compacting");
		onComplete?.({ ok: true });
		assert.equal(state.status, "idle");
		assert.equal(statuses.at(-1), "slipstream: manual");

		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "validated",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 200,
		});
		await handleSlipstreamCommand(
			"compact --adopt",
			state,
			DEFAULT_CONFIG,
			{
				cwd: "/repo",
				compact: (options) => {
					onError = options?.onError;
				},
				ui: {
					notify: () => undefined,
					setStatus: (_key, text) => {
						statuses.push(text);
					},
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => [],
				},
			},
			{ now: () => 150 },
		);
		onError?.(new Error("failed"));
		assert.equal(state.status, "ready_to_adopt");
		assert.equal(statuses.at(-1), "slipstream: pending");
	});

	it("adopt command refuses in-memory pending summaries from a different cwd", async (t) => {
		const currentCwd = process.cwd();
		const pendingCwd = join(
			currentCwd,
			".scratch",
			"test-tmp",
			"wrong-cwd-project",
		);
		mkdirSync(pendingCwd, { recursive: true });
		const artifactRoot = mkdtempSync(join(pendingCwd, "artifacts-"));
		t.after(() => rmSync(pendingCwd, { recursive: true, force: true }));
		const run = await new ArtifactStore({ root: artifactRoot }).createRun({
			sessionId: "s1",
			triggerEntryId: "a1",
			cwd: pendingCwd,
		});
		const state = createRuntimeState({ now: 100 });
		let calls = 0;
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: pendingCwd,
			projectId: pendingCwd,
			artifactDir: run.dir,
			summary: "validated",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 200,
		});

		const result = await handleSlipstreamCommand(
			"compact --adopt",
			state,
			{ ...DEFAULT_CONFIG, artifactRoot },
			{
				cwd: currentCwd,
				compact: () => {
					calls += 1;
				},
				sessionManager: {
					getSessionId: () => "s1",
					getBranch: () => [],
				},
			},
			{ now: () => 150 },
		);

		assert.equal(result.ok, false);
		assert.equal(calls, 0);
		assert.equal(state.pending, null);
		assert.equal(state.status, "idle");
	});

	it("adopt command refuses expired pending summaries", () => {
		const state = createRuntimeState({ now: 100 });
		let calls = 0;
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "validated",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 120,
		});

		const result = handleAdoptCommand(
			state,
			{
				compact: () => {
					calls += 1;
				},
			},
			120,
			"s1",
		);

		assert.equal(result.ok, false);
		assert.equal(calls, 0);
		assert.equal(state.pending, null);
	});

	it("policy-accepts rejected prepared summaries when no confirm UI is available", async () => {
		const state = createRuntimeState({ now: 100 });
		const progress: string[] = [];
		const result = await handleSlipstreamCommand(
			"compact --prepare",
			state,
			{
				...DEFAULT_CONFIG,
				rejectedSummaryMode: "accept" as const,
				maxContinuationTurns: 2,
				judgeThreshold: 9,
				repairAttempts: 1,
				pendingTtlMs: 10_000,
				artifactRoot: ".scratch/test-tmp/command-reject",
			},
			{
				cwd: process.cwd(),
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				ui: {
					notify: (message) => progress.push(message),
					setStatus: (_key: string, text: string | undefined) => {
						if (text) progress.push(text);
					},
				},
				sessionManager: {
					getSessionId: () => "session-reject",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "Preserve REJECT_SENTINEL" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "Old rejected work" },
						},
						...Array.from({ length: 8 }, (_, index) => ({
							type: "message" as const,
							id: `k${index}`,
							parentId: null,
							timestamp: "t",
							message: {
								role:
									index % 2 === 0 ? ("user" as const) : ("assistant" as const),
								content: `kept ${index}`,
							},
						})),
					],
				},
				getContextUsage: () => ({ tokens: 1000, contextWindow: 1_000_000 }),
			},
			{
				createSummaryCompleter: () => async () => "## Goal\nToo weak",
				createJudgeCompleter: () => async () => ({
					score: 4,
					decision: "reject",
					missing: ["Missing exact literal: REJECT_SENTINEL"],
					contradictions: [],
					diagnosis: "still missing protected literal",
				}),
				now: () => 100,
			},
		);

		assert.equal(result.ok, true);
		assert.match(result.message, /policy-accepted rejected/i);
		assert.equal(state.status, "ready_to_adopt");
		assert.equal(state.pending?.details.rejectedSummaryAccepted, true);
		assert.equal(state.pending?.details.rejectedSummaryMode, "accept");
		assert.equal(state.pending?.details.manualOverride, false);
		assert.match(progress.join("\n"), /repair attempt 1\/1/i);
		let compactCalls = 0;
		const adopted = handleAdoptCommand(
			state,
			{
				compact: () => {
					compactCalls += 1;
				},
			},
			100,
		);
		assert.equal(adopted.ok, true);
		assert.equal(compactCalls, 1);
	});

	it("rejects rejected prepared summaries when the user selects Reject", async () => {
		const state = createRuntimeState({ now: 100 });
		let selectCalls = 0;
		const result = await handleSlipstreamCommand(
			"compact --prepare",
			state,
			{
				...DEFAULT_CONFIG,
				rejectedSummaryMode: "ask" as const,
				maxContinuationTurns: 2,
				judgeThreshold: 9,
				repairAttempts: 0,
				pendingTtlMs: 10_000,
				artifactRoot: ".scratch/test-tmp/command-select-reject",
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
					select: () => {
						selectCalls += 1;
						return "Reject";
					},
				},
				sessionManager: {
					getSessionId: () => "session-select-reject",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "Preserve FALSE_CONFIRM" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "Weak candidate" },
						},
					],
				},
			},
			{
				createSummaryCompleter: () => async () => "## Goal\nToo weak",
				createJudgeCompleter: () => async () => ({
					score: 4,
					decision: "reject",
					missing: ["FALSE_CONFIRM"],
					contradictions: [],
					diagnosis: "still missing protected literal",
				}),
				now: () => 100,
			},
		);

		assert.equal(result.ok, false);
		assert.match(result.message, /could not prepare/i);
		assert.equal(selectCalls, 1);
		assert.equal(state.pending, null);
	});

	it("offers manual acceptance for a rejected prepared summary", async (t) => {
		const state = createRuntimeState({ now: 100 });
		const artifactRoot = mkdtempSync(
			join(process.cwd(), ".scratch", "test-tmp", "command-manual-accept-"),
		);
		t.after(() => rmSync(artifactRoot, { recursive: true, force: true }));
		const config = {
			...DEFAULT_CONFIG,
			retainArtifacts: true,
			rejectedSummaryMode: "ask" as const,
			maxContinuationTurns: 2,
			judgeThreshold: 9,
			repairAttempts: 1,
			pendingTtlMs: 10_000,
			artifactRoot,
		};
		let confirmMessage = "";
		let confirmTimeout: number | undefined;
		const result = await handleSlipstreamCommand(
			"compact --prepare",
			state,
			config,
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
					getSessionId: () => "session-manual-accept",
					getBranch: () => [
						{
							type: "message",
							id: "u1",
							parentId: null,
							timestamp: "t",
							message: { role: "user", content: "Preserve MANUAL_ACCEPT" },
						},
						{
							type: "message",
							id: "a1",
							parentId: null,
							timestamp: "t",
							message: { role: "assistant", content: "Needs more detail" },
						},
					],
				},
				getContextUsage: () => ({ tokens: 1000, contextWindow: 1_000_000 }),
			},
			{
				createSummaryCompleter: () => async () => "## Goal\nToo weak",
				createJudgeCompleter: () => async () => ({
					score: 4,
					decision: "reject",
					missing: ["Missing exact literal: MANUAL_ACCEPT"],
					contradictions: [],
					diagnosis: "still missing protected literal",
				}),
				now: () => 100,
			},
		);

		assert.equal(result.ok, true);
		assert.match(result.message, /manually accepted rejected/i);
		assert.equal(confirmTimeout, 120_000);
		assert.match(confirmMessage, /Score: 4\/10/);
		assert.match(confirmMessage, /Missing exact literal: MANUAL_ACCEPT/);
		assert.match(confirmMessage, /Compaction summary preview:/);
		assert.match(confirmMessage, /Too weak/);
		assert.equal(state.status, "ready_to_adopt");
		assert.equal(state.pending?.details.manualOverride, true);
		assert.equal(state.pending?.details.rejectedSummaryAccepted, true);

		const artifactDir = state.pending?.details.artifacts;
		assert.ok(Array.isArray(artifactDir));
		assert.equal(typeof artifactDir[0], "string");
		const pendingPath = join(artifactDir[0], "pending.json");
		const originalPending = readFileSync(pendingPath, "utf8");
		const tamperedPending = JSON.parse(originalPending) as {
			expiresAt: number;
		};
		tamperedPending.expiresAt = 1_000_000;
		writeFileSync(pendingPath, `${JSON.stringify(tamperedPending, null, 2)}\n`);

		let compactCalls = 0;
		const rejectedFutureState = createRuntimeState({ now: 101 });
		const rejectedFutureAdopt = await handleSlipstreamCommand(
			"compact --adopt",
			rejectedFutureState,
			config,
			{
				cwd: process.cwd(),
				compact: () => {
					compactCalls += 1;
				},
				sessionManager: {
					getSessionId: () => "session-manual-accept",
					getBranch: () => [],
				},
			},
			{ now: () => 101 },
		);
		assert.equal(rejectedFutureAdopt.ok, false);
		assert.equal(compactCalls, 0);

		writeFileSync(pendingPath, originalPending);
		const recoveredState = createRuntimeState({ now: 101 });
		const adoptResult = await handleSlipstreamCommand(
			"compact --adopt",
			recoveredState,
			config,
			{
				cwd: process.cwd(),
				compact: () => {
					compactCalls += 1;
				},
				sessionManager: {
					getSessionId: () => "session-manual-accept",
					getBranch: () => [],
				},
			},
			{ now: () => 101 },
		);
		assert.equal(adoptResult.ok, true);
		assert.equal(compactCalls, 1);
	});

	it("normalizes legacy pending artifacts before clearing the recovered path", async () => {
		const root = mkdtempSync(
			join(process.cwd(), ".scratch", "test-tmp", "pending-clear-contained-"),
		);
		const externalDir = mkdtempSync(
			join(process.cwd(), ".scratch", "test-tmp", "pending-clear-external-"),
		);
		try {
			const sessionId = "session-contained-clear";
			const run = await new ArtifactStore({ root }).createRun({
				sessionId,
				triggerEntryId: "a1",
				cwd: process.cwd(),
			});
			const candidateDir = run.dir;
			writeFileSync(join(externalDir, "pending.json"), "external\n");
			writeFileSync(
				join(candidateDir, "pending.json"),
				`${JSON.stringify(
					{
						sessionId,
						cwd: process.cwd(),
						projectId: process.cwd(),
						summary: "## Goal\nRecovered contained clear",
						firstKeptEntryId: "a1",
						validatedThroughEntryId: "a1",
						tokensBefore: 100,
						details: {
							judge: { score: 9 },
							artifacts: [externalDir],
						},
						expiresAt: 10_000,
					},
					null,
					2,
				)}\n`,
			);

			const recovered = await recoverPendingArtifact(
				root,
				sessionId,
				process.cwd(),
				100,
				10_000,
				true,
			);
			assert.ok(recovered);
			assert.equal(recovered.artifactDir, candidateDir);
			await clearPendingArtifact(recovered, root);

			assert.equal(
				readFileSync(join(externalDir, "pending.json"), "utf8"),
				"external\n",
			);
			assert.throws(() =>
				readFileSync(join(candidateDir, "pending.json"), "utf8"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(externalDir, { recursive: true, force: true });
		}
	});

	it("recovers pending.json and revalidates it when the branch advanced", async () => {
		const state = createRuntimeState({ now: 100 });
		const sessionId = `session-recovered-stale-adopt-${Date.now()}`;
		const config = {
			...DEFAULT_CONFIG,
			retainArtifacts: true,
			maxContinuationTurns: 2,
			minContinuationTurns: 1,
			repairAttempts: 0,
			pendingTtlMs: 10_000,
			statsFullPaths: true,
			artifactRoot: `.scratch/test-tmp/command-recovered-stale-adopt-${Date.now()}`,
		};
		const previousStatsRoot = process.env.PI_SLIPSTREAM_STATS_ROOT;
		const statsRoot = join(
			process.cwd(),
			".scratch",
			"test-tmp",
			`${sessionId}-stats`,
		);
		process.env.PI_SLIPSTREAM_STATS_ROOT = statsRoot;
		const branch = [
			{
				type: "message" as const,
				id: "u1",
				parentId: null,
				timestamp: "t",
				message: { role: "user" as const, content: "Use old state" },
			},
			{
				type: "message" as const,
				id: "a1",
				parentId: null,
				timestamp: "t",
				message: { role: "assistant" as const, content: "Old answer" },
			},
		];
		let summaryCalls = 0;
		const prepareResult = await handleSlipstreamCommand(
			"compact --prepare",
			state,
			config,
			{
				cwd: process.cwd(),
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 1000 }),
			},
			{
				createSummaryCompleter: () => async () => {
					summaryCalls += 1;
					return `## Goal\nRecovered summary ${summaryCalls}`;
				},
				createJudgeCompleter: () => async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok",
				}),
				now: () => 100,
			},
		);
		assert.equal(prepareResult.ok, true);
		assert.equal(state.pending?.validatedThroughEntryId, "a1");

		branch.push({
			type: "message",
			id: "u2",
			parentId: null,
			timestamp: "t",
			message: { role: "user", content: "Newest correction before adopt" },
		});
		let compactCalls = 0;
		const recoveredState = createRuntimeState({ now: 101 });
		storePendingValidated(recoveredState, {
			sessionId,
			cwd: "/other-cwd",
			projectId: "/other-cwd",
			artifactDir: "/tmp/slipstream-pending",
			summary: "wrong cwd",
			firstKeptEntryId: "a1",
			validatedThroughEntryId: "a1",
			tokensBefore: 1000,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 10_100,
		});
		const adoptResult = await handleSlipstreamCommand(
			"compact --adopt",
			recoveredState,
			config,
			{
				cwd: process.cwd(),
				compact: () => {
					compactCalls += 1;
				},
				model: { provider: "test", id: "model" },
				modelRegistry: {
					find: () => ({ provider: "test", id: "model" }),
					getApiKeyAndHeaders: async () => ({ apiKey: "test" }),
				},
				sessionManager: {
					getSessionId: () => sessionId,
					getBranch: () => branch,
				},
				getContextUsage: () => ({ tokens: 1100 }),
			},
			{
				createSummaryCompleter: () => async () => {
					summaryCalls += 1;
					return `## Goal\nRecovered summary ${summaryCalls}`;
				},
				createJudgeCompleter: () => async () => ({
					score: 9,
					decision: "accept",
					missing: [],
					contradictions: [],
					diagnosis: "ok after branch advanced",
				}),
				now: () => 101,
			},
		);

		assert.equal(adoptResult.ok, true);
		assert.equal(compactCalls, 1);
		assert.equal(summaryCalls, 2);
		assert.equal(recoveredState.pending?.validatedThroughEntryId, "u2");
		assert.equal(recoveredState.pending?.details.revalidatedFromEntryId, "a1");
		const artifactDir = recoveredState.pending?.details.artifacts;
		assert.ok(Array.isArray(artifactDir));
		assert.equal(typeof artifactDir[0], "string");
		const persisted = JSON.parse(
			readFileSync(join(artifactDir[0], "pending.json"), "utf8"),
		) as {
			validatedThroughEntryId?: unknown;
			details?: { revalidatedFromEntryId?: unknown };
		};
		assert.equal(persisted.validatedThroughEntryId, "u2");
		assert.equal(persisted.details?.revalidatedFromEntryId, "a1");
		const statsLines = readFileSync(
			join(statsRoot, "sessions", `${sessionId}.jsonl`),
			"utf8",
		)
			.trim()
			.split("\n");
		const revalidationStats = JSON.parse(statsLines.at(-1) ?? "") as {
			cwd?: unknown;
			artifactDir?: unknown;
		};
		assert.equal(revalidationStats.cwd, process.cwd());
		assert.equal(revalidationStats.artifactDir, artifactDir[0]);
		if (previousStatsRoot === undefined) {
			delete process.env.PI_SLIPSTREAM_STATS_ROOT;
		} else {
			process.env.PI_SLIPSTREAM_STATS_ROOT = previousStatsRoot;
		}
	});
});
