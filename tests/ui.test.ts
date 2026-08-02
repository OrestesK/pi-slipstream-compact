import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	createRuntimeState,
	storePendingValidated,
} from "../src/session-state.ts";
import {
	buildSlipstreamWidgetLines,
	clearSlipstreamWidget,
	updateSlipstreamWidget,
} from "../src/ui.ts";

describe("Slipstream widget", () => {
	it("renders concise user-facing phase labels", () => {
		const state = createRuntimeState();

		assert.deepEqual(
			buildSlipstreamWidgetLines(state, DEFAULT_CONFIG, {
				progress: {
					phase: "summary",
					message: "Generating candidate summary",
					elapsedMs: 3_200,
				},
			}),
			["Slipstream: summarizing · 3s"],
		);
		assert.deepEqual(
			buildSlipstreamWidgetLines(state, DEFAULT_CONFIG, {
				progress: {
					phase: "judging",
					message: "Judging candidate summary",
					elapsedMs: 65_000,
				},
			}),
			["Slipstream: checking summary · 1m 5s"],
		);
	});

	it("renders pending score without long diagnostics", () => {
		const state = createRuntimeState({ now: 100 });
		storePendingValidated(state, {
			sessionId: "s1",
			cwd: "/repo",
			projectId: "/repo",
			artifactDir: "/tmp/slipstream-pending",
			summary: "validated",
			firstKeptEntryId: "k1",
			validatedThroughEntryId: "a1",
			tokensBefore: 500,
			details: {
				judge: { score: 9, decision: "accept", diagnosis: "long text" },
				artifacts: ["artifact-dir"],
			},
			expiresAt: 200,
		});

		assert.deepEqual(buildSlipstreamWidgetLines(state, DEFAULT_CONFIG), [
			"Slipstream: ready · score 9/10",
		]);
	});

	it("renders every progress phase without stale score noise", () => {
		const state = createRuntimeState();
		state.lastJudge = {
			score: 4,
			decision: "reject",
			diagnosis: "old run",
			missing: [],
			contradictions: [],
		};

		assert.deepEqual(
			(
				[
					"snapshot",
					"artifacts",
					"state-evidence",
					"summary",
					"finalizing-summary",
				] as const
			).map(
				(phase) =>
					buildSlipstreamWidgetLines(state, DEFAULT_CONFIG, {
						progress: { phase, message: phase, elapsedMs: 1_000 },
					})[0],
			),
			[
				"Slipstream: snapshotting local state · 1s",
				"Slipstream: writing artifacts · 1s",
				"Slipstream: collecting evidence · 1s",
				"Slipstream: summarizing · 1s",
				"Slipstream: waiting for auto summary · 1s",
			],
		);
		assert.equal(
			buildSlipstreamWidgetLines(state, DEFAULT_CONFIG, {
				progress: { phase: "judging", message: "Judging" },
			})[0],
			"Slipstream: checking summary",
		);
		assert.equal(
			buildSlipstreamWidgetLines(state, DEFAULT_CONFIG, {
				progress: {
					phase: "repairing",
					message: "Repairing",
					elapsedMs: 2_000,
					lastScore: 3,
				},
			})[0],
			"Slipstream: repairing summary · 2s · last score 3/10",
		);
		assert.equal(
			buildSlipstreamWidgetLines(state, DEFAULT_CONFIG, {
				progress: { phase: "accepted", message: "Accepted" },
			})[0],
			"Slipstream: ready · score 4/10",
		);
		assert.equal(
			buildSlipstreamWidgetLines(state, DEFAULT_CONFIG, {
				progress: { phase: "rejected", message: "Rejected" },
			})[0],
			"Slipstream: summary rejected · score 4/10",
		);
	});

	it("renders compacting score for judged prepared summaries", () => {
		const state = createRuntimeState();
		state.status = "summarizing";
		state.lastJudge = {
			score: 9,
			decision: "accept",
			diagnosis: "ready",
			missing: [],
			contradictions: [],
		};

		assert.deepEqual(buildSlipstreamWidgetLines(state, DEFAULT_CONFIG), [
			"Slipstream: compacting · score 9/10",
		]);
	});

	it("renders repair progress as fixing summary gaps without config details", () => {
		const state = createRuntimeState();

		assert.deepEqual(
			buildSlipstreamWidgetLines(
				state,
				{
					...DEFAULT_CONFIG,
					autoTrigger: false,
					summaryModel: "openai/gpt-5.5",
				},
				{
					progress: {
						phase: "repairing",
						message: "Repairing candidate summary",
					},
				},
			),
			["Slipstream: repairing summary"],
		);
	});

	it("does not show stale previous judge score during repair progress", () => {
		const state = createRuntimeState();
		state.lastJudge = {
			score: 9,
			decision: "accept",
			diagnosis: "old accepted run",
			missing: [],
			contradictions: [],
		};

		assert.deepEqual(
			buildSlipstreamWidgetLines(state, DEFAULT_CONFIG, {
				progress: {
					phase: "repairing",
					message: "Repairing current rejected summary",
					lastScore: 4,
				},
			}),
			["Slipstream: repairing summary · last score 4/10"],
		);
	});

	it("hides the widget while idle", () => {
		const state = createRuntimeState();
		const widgetUpdates: Array<{
			lines: string[] | undefined;
			placement?: "aboveEditor" | "belowEditor";
		}> = [];

		updateSlipstreamWidget(
			{
				hasUI: true,
				ui: {
					setWidget: (_key, lines, options) => {
						widgetUpdates.push({ lines, placement: options?.placement });
					},
				},
			},
			state,
			DEFAULT_CONFIG,
		);

		assert.deepEqual(widgetUpdates, [
			{ lines: undefined, placement: undefined },
		]);
	});

	it("shows active work above the editor", () => {
		const state = createRuntimeState();
		const widgetUpdates: Array<{
			lines: string[] | undefined;
			placement?: "aboveEditor" | "belowEditor";
		}> = [];

		updateSlipstreamWidget(
			{
				hasUI: true,
				ui: {
					setWidget: (_key, lines, options) => {
						widgetUpdates.push({ lines, placement: options?.placement });
					},
				},
			},
			state,
			DEFAULT_CONFIG,
			{
				progress: {
					phase: "summary",
					message: "Generating candidate summary",
				},
			},
		);

		assert.deepEqual(widgetUpdates, [
			{
				lines: ["Slipstream: summarizing"],
				placement: "aboveEditor",
			},
		]);
	});

	it("uses theme colors when available", () => {
		const state = createRuntimeState();
		const widgetUpdates: string[][] = [];

		updateSlipstreamWidget(
			{
				hasUI: true,
				ui: {
					theme: {
						fg: (color, text) => `<${color}>${text}</${color}>`,
					},
					setWidget: (_key, lines) => {
						if (lines) widgetUpdates.push(lines);
					},
				},
			},
			state,
			DEFAULT_CONFIG,
			{
				progress: {
					phase: "judging",
					message: "Judging candidate summary",
				},
			},
		);

		assert.deepEqual(widgetUpdates, [
			["<accent>Slipstream:</accent> <accent>checking summary</accent>"],
		]);

		updateSlipstreamWidget(
			{
				hasUI: true,
				ui: {
					theme: {
						fg: (color, text) => `<${color}>${text}</${color}>`,
					},
					setWidget: (_key, lines) => {
						if (lines) widgetUpdates.push(lines);
					},
				},
			},
			state,
			DEFAULT_CONFIG,
			{
				progress: {
					phase: "repairing",
					message: "Repairing candidate summary",
				},
			},
		);

		assert.deepEqual(widgetUpdates.at(-1), [
			"<accent>Slipstream:</accent> <warning>repairing summary</warning>",
		]);
	});

	it("ignores stale context errors while updating and clearing the widget", () => {
		const state = createRuntimeState();
		const staleContext = {
			hasUI: true,
			ui: {
				setWidget: () => {
					throw new Error(
						"This extension ctx is stale after session replacement or reload",
					);
				},
			},
		};

		assert.doesNotThrow(() => {
			updateSlipstreamWidget(staleContext, state, DEFAULT_CONFIG);
		});
		assert.doesNotThrow(() => {
			clearSlipstreamWidget(staleContext);
		});
	});

	it("rethrows non-stale widget errors", () => {
		const state = createRuntimeState();
		const brokenContext = {
			hasUI: true,
			ui: {
				setWidget: () => {
					throw new Error("terminal renderer failed");
				},
			},
		};

		assert.throws(
			() =>
				updateSlipstreamWidget(brokenContext, state, DEFAULT_CONFIG, {
					progress: {
						phase: "summary",
						message: "Generating candidate summary",
					},
				}),
			/terminal renderer failed/,
		);
	});
});
