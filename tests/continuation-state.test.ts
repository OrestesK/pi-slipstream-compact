import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	adoptPending,
	consumePendingForCompaction,
	createRuntimeState,
	storePendingValidated,
	trackPromise,
} from "../src/session-state.ts";
import {
	buildContinuationFromBranch,
	ContinuationBuffer,
} from "../src/continuation.ts";

describe("continuation buffer", () => {
	it("collects bounded assistant and tool-result evidence", () => {
		const buffer = new ContinuationBuffer({ minTurns: 1, maxTurns: 2 });
		buffer.start("entry-1");
		buffer.appendTurn({
			turnIndex: 1,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "I edited the file" }],
			},
			toolResults: [
				{
					role: "toolResult",
					toolCallId: "t1",
					toolName: "edit",
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			],
		});
		buffer.appendTurn({
			turnIndex: 2,
			message: { role: "assistant", content: "done" },
			toolResults: [],
		});
		buffer.appendTurn({
			turnIndex: 3,
			message: { role: "assistant", content: "ignored" },
			toolResults: [],
		});

		const snapshot = buffer.snapshot();
		assert.equal(buffer.isReady(), true);
		assert.equal(snapshot.turns.length, 2);
		assert.equal(snapshot.turns[0]?.assistantText, "I edited the file");
		assert.equal(snapshot.turns[0]?.toolResults[0]?.toolName, "edit");
	});

	it("returns a null trigger id for empty branches", () => {
		const continuation = buildContinuationFromBranch([], 2);

		assert.equal(continuation.triggerEntryId, null);
		assert.deepEqual(continuation.turns, []);
	});

	it("uses the last message entry as trigger id including trailing tool results", () => {
		const continuation = buildContinuationFromBranch(
			[
				{
					type: "message",
					id: "a1",
					parentId: null,
					timestamp: "t",
					message: { role: "assistant", content: "done" },
				},
				{
					type: "message",
					id: "tool-after-assistant",
					parentId: null,
					timestamp: "t",
					message: {
						role: "toolResult",
						toolCallId: "call",
						toolName: "read",
						content: "late tool result",
						isError: false,
					},
				},
			],
			2,
		);

		assert.equal(continuation.triggerEntryId, "tool-after-assistant");
		assert.equal(
			continuation.turns[0]?.toolResults[0]?.text,
			"late tool result",
		);
	});

	it("builds continuation evidence from newest assistant/tool-result turns", () => {
		const continuation = buildContinuationFromBranch(
			[
				{
					type: "message",
					id: "a1",
					parentId: null,
					timestamp: "t",
					message: { role: "assistant", content: "old" },
				},
				{
					type: "message",
					id: "a2",
					parentId: null,
					timestamp: "t",
					message: { role: "assistant", content: "new" },
				},
				{
					type: "message",
					id: "t2",
					parentId: null,
					timestamp: "t",
					message: {
						role: "toolResult",
						toolCallId: "call",
						toolName: "read",
						content: "ok",
						isError: false,
					},
				},
			],
			1,
		);

		assert.equal(continuation.turns.length, 1);
		assert.equal(continuation.turns[0]?.assistantText, "new");
		assert.equal(continuation.turns[0]?.toolResults[0]?.toolName, "read");
	});
	it("does not count assistant tool-call-only messages as continuation turns", () => {
		const continuation = buildContinuationFromBranch(
			[
				{
					type: "message",
					id: "a-tool",
					parentId: null,
					timestamp: "t",
					message: {
						role: "assistant",
						content: [
							{ type: "toolCall", id: "call", name: "read", input: {} },
						],
					},
				},
				{
					type: "message",
					id: "t1",
					parentId: null,
					timestamp: "t",
					message: {
						role: "toolResult",
						toolCallId: "call",
						toolName: "read",
						content: "file contents",
						isError: false,
					},
				},
				{
					type: "message",
					id: "a-final",
					parentId: null,
					timestamp: "t",
					message: { role: "assistant", content: "final useful update" },
				},
			],
			2,
		);

		assert.equal(continuation.turns.length, 1);
		assert.equal(continuation.turns[0]?.assistantText, "final useful update");
		assert.deepEqual(continuation.turns[0]?.toolResults, []);
	});
});

describe("pending adoption state", () => {
	it("consumes matching unexpired pending compactions even when Pi computes a different kept boundary", () => {
		const state = createRuntimeState({ now: 100 });
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

		const consumed = consumePendingForCompaction(state, {
			sessionId: "s1",
			cwd: "/repo",
			preparationFirstKeptEntryId: "native-boundary",
			validatedThroughEntryId: "a1",
			now: 150,
		});
		assert.equal(consumed?.summary, "validated");
		assert.equal(consumed?.firstKeptEntryId, "k1");
		assert.equal(state.pending, null);
	});

	it("refuses pending compactions from a different session id", () => {
		const state = createRuntimeState({ now: 100 });
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "wrong session",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 200,
		});

		assert.equal(
			consumePendingForCompaction(state, {
				sessionId: "s2",
				cwd: "/repo",
				preparationFirstKeptEntryId: "native-boundary",
				validatedThroughEntryId: "a1",
				now: 150,
			}),
			undefined,
		);
		assert.equal(state.pending, null);
		assert.equal(state.status, "idle");
	});

	it("refuses pending compactions from a different cwd", () => {
		const state = createRuntimeState({ now: 100 });
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo-a",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "wrong project",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 200,
		});

		assert.equal(
			consumePendingForCompaction(state, {
				sessionId: "s1",
				cwd: "/repo-b",
				preparationFirstKeptEntryId: "native-boundary",
				validatedThroughEntryId: "a1",
				now: 150,
			}),
			undefined,
		);
		assert.equal(state.pending, null);
		assert.equal(state.status, "idle");
	});

	it("refuses explicit adoption from a different session id", () => {
		const state = createRuntimeState({ now: 100 });
		let compactCalls = 0;
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "wrong session",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 200,
		});

		assert.equal(
			adoptPending(
				state,
				{
					compact: () => {
						compactCalls += 1;
					},
				},
				{ now: 150, sessionId: "s2", cwd: "/repo" },
			),
			null,
		);
		assert.equal(compactCalls, 0);
		assert.equal(state.pending, null);
		assert.equal(state.status, "idle");
	});

	it("refuses explicit adoption from a different cwd", () => {
		const state = createRuntimeState({ now: 100 });
		let compactCalls = 0;
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo-a",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "wrong project",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 200,
		});

		assert.equal(
			adoptPending(
				state,
				{
					compact: () => {
						compactCalls += 1;
					},
				},
				{ now: 150, sessionId: "s1", cwd: "/repo-b" },
			),
			null,
		);
		assert.equal(compactCalls, 0);
		assert.equal(state.pending, null);
		assert.equal(state.status, "idle");
	});

	it("refuses pending compactions validated before the current branch head", () => {
		const state = createRuntimeState({ now: 100 });
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "stale",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 200,
		});

		assert.equal(
			consumePendingForCompaction(state, {
				sessionId: "s1",
				preparationFirstKeptEntryId: "native-boundary",
				validatedThroughEntryId: "u2",
				now: 150,
			}),
			undefined,
		);
		assert.equal(state.pending, null);
		assert.equal(state.status, "idle");
	});

	it("expires stale pending compactions and refuses adoption", () => {
		const state = createRuntimeState({ now: 100 });
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "p1",
			artifactDir: "/tmp/slipstream-pending",
			summary: "old",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: { judge: { score: 9 }, artifacts: [] },
			expiresAt: 120,
		});
		assert.equal(
			consumePendingForCompaction(state, {
				sessionId: "s1",
				preparationFirstKeptEntryId: "k1",
				now: 120,
			}),
			undefined,
		);
		assert.equal(state.pending, null);
	});

	it("calls ctx.compact only for explicit validated adoption", () => {
		const state = createRuntimeState({ now: 100 });
		let compactCalls = 0;
		const ctx = {
			compact: () => {
				compactCalls += 1;
			},
		};
		assert.equal(adoptPending(state, ctx), null);
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
		assert.equal(
			adoptPending(state, ctx, { now: 150, sessionId: "s1" }),
			"slipstream",
		);
		assert.equal(compactCalls, 1);
		assert.equal(adoptPending(state, ctx, { now: 150, sessionId: "s1" }), null);
		assert.equal(compactCalls, 1);
	});

	it("keeps explicit validated adoption pending while Pi is busy", () => {
		const state = createRuntimeState({ now: 100 });
		let compactCalls = 0;
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
		const ctx = {
			compact: () => {
				compactCalls += 1;
			},
			isIdle: () => false,
			hasPendingMessages: () => false,
		};

		assert.equal(
			adoptPending(state, ctx, { now: 150, sessionId: "s1", cwd: "/repo" }),
			"busy",
		);
		assert.equal(compactCalls, 0);
		assert.equal(state.status, "ready_to_adopt");
		assert.equal(state.pending?.summary, "validated");
	});

	it("explicit adoption resets status from compact callbacks", () => {
		const completed = createRuntimeState({ now: 100 });
		storePendingValidated(completed, {
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
		let onComplete: ((result: unknown) => void) | undefined;
		assert.equal(
			adoptPending(
				completed,
				{
					compact: (options) => {
						onComplete = options?.onComplete;
					},
				},
				{ now: 150, sessionId: "s1", cwd: "/repo" },
			),
			"slipstream",
		);
		assert.equal(completed.status, "summarizing");
		assert.equal(completed.slipstreamCompactionRequest !== null, true);
		onComplete?.({ ok: true });
		assert.equal(completed.status, "idle");
		assert.equal(completed.slipstreamCompactionRequest, null);

		const failed = createRuntimeState({ now: 100 });
		storePendingValidated(failed, {
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
		let onError: ((error: Error) => void) | undefined;
		assert.equal(
			adoptPending(
				failed,
				{
					compact: (options) => {
						onError = options?.onError;
					},
				},
				{ now: 150, sessionId: "s1", cwd: "/repo" },
			),
			"slipstream",
		);
		assert.equal(failed.slipstreamCompactionRequest !== null, true);
		onError?.(new Error("failed"));
		assert.equal(failed.status, "ready_to_adopt");
		assert.equal(failed.slipstreamCompactionRequest, null);
	});

	it("tracks background promises and clears only the active one", async () => {
		const state = createRuntimeState({ now: 100 });
		let resolveSecond: (value: string) => void = () => undefined;
		const first = trackPromise(state, Promise.resolve("first"));
		const second = trackPromise(
			state,
			new Promise<string>((resolve) => {
				resolveSecond = resolve;
			}),
		);
		await first;
		assert.equal(state.activePromise, second);
		resolveSecond("second");
		await second;
		assert.equal(state.activePromise, null);
	});
});
