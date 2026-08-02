# pi-slipstream-compact

Safer compaction for long [Pi Coding Agent](https://github.com/badlogic/pi-mono) sessions.

Long Pi sessions can lose important details when the context gets compacted: files you changed, commands that failed, decisions you made, blockers, and what should happen next. This package makes Pi check the summary before using it.

Inspired by the [Slipstream research paper](https://arxiv.org/html/2605.08580), adapted for real Pi coding sessions.

> Status: experimental. Background preparation is enabled by default. Safe evaluation commands are available before relying on it for important sessions.

## Why use this package

Install it, then keep using Pi normally.

- As the session grows, Slipstream can prepare a summary in the background.
- When you run `/compact`, Pi uses Slipstream's reviewed summary instead of native compaction.
- Automatic compaction uses the same review step.
- If the summary misses important state, Slipstream tries to repair it before compaction.
- Recovery artifacts are temporary by default. Set `retainArtifacts: true` to keep completed runs for inspection.

## Install

```bash
pi install npm:pi-slipstream-compact
```

Or install from GitHub:

```bash
pi install git:github.com/OrestesK/pi-slipstream-compact@v0.1.0
```

Pi packages run with full local permissions. Review source before installing packages from npm, git, or another machine.

This package can start background model calls near context limits and can send session evidence, tool output, file paths, and git excerpts to your configured model provider. If you want to inspect first, use [Evaluate safely](#evaluate-safely) or set `autoTrigger: false` before relying on it.

## How to use it

After installing, keep using Pi normally.

| You want                                              | Do this                                                                                                        |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Let compaction happen automatically                   | Nothing. Background preparation is enabled by default and starts when the session gets large.                  |
| Compact manually                                      | Run `/compact`.                                                                                                |
| See Slipstream state                                  | Watch the compact widget above the prompt while Slipstream is active, or run `/slipstream status` for details. |
| Inspect pending or retained artifacts                 | Run `/slipstream artifacts`. Set `retainArtifacts: true` to keep completed runs.                               |
| Turn off background preparation while testing         | Set `autoTrigger: false`; `/compact` still uses Slipstream while the package is enabled.                       |
| Keep another extension or native Pi owning `/compact` | Set `replaceDefaultCompact: false`; use `/slipstream compact` only when you explicitly want Slipstream.        |

Before using it on a real repository, make sure `.scratch/` is gitignored. Slipstream writes temporary recovery state under `.scratch/compactions`.

## Default behavior and settings

Default config is intentionally small:

```json
{
	"pi-slipstream-compact": {
		"enabled": true,
		"autoTrigger": true,
		"artifactRoot": ".scratch/compactions",
		"retainArtifacts": false
	}
}
```

Important defaults:

| Setting                 |                Default | Meaning                                                                                           |
| ----------------------- | ---------------------: | ------------------------------------------------------------------------------------------------- |
| `enabled`               |                 `true` | Enables background preparation and `/compact` replacement. Support commands remain available.     |
| `autoTrigger`           |                 `true` | Starts preparing a checked summary in the background when the session gets large.                 |
| `replaceDefaultCompact` |                 `true` | Makes plain `/compact` use Slipstream by default; set `false` for side-by-side mode.              |
| `triggerContextPercent` |                  `0.6` | Starts/latches auto compaction around 60% context usage.                                          |
| `judgeThreshold`        |                    `7` | Minimum continuation-quality score before normal acceptance.                                      |
| `repairAttempts`        |                    `3` | Tries full-summary repair after judge rejection.                                                  |
| `rejectedSummaryMode`   |                `"ask"` | Shows an interactive decision when possible; accepts on timeout/no UI unless explicitly rejected. |
| `artifactRoot`          | `.scratch/compactions` | Local temporary recovery directory inside the current project.                                    |
| `retainArtifacts`       |                `false` | Keeps completed recovery artifacts only when explicitly set to `true`.                            |
| `statsFullPaths`        |                `false` | Central stats redact paths by default; set `true` only for explicit local debugging.              |
| `summaryModel`          |           active model | Uses your active Pi model unless overridden.                                                      |
| `judgeModel`            |           active model | Uses your active Pi model unless overridden.                                                      |

See [Full configuration](#full-configuration) for all settings and model overrides.

## Evaluate safely

You do not need these commands for normal use. They are for checking a new install before relying on it.

A safe evaluation ladder:

Set `retainArtifacts: true` while evaluating if you want to inspect generated files after a run finishes.

1. Inspect the prompt and local evidence without judging or compacting:

   ```text
   /slipstream compact --dry-run
   ```

   Inspect `candidate-prompt.md`, `state-evidence.json`, and git artifacts for stale state, missing blockers, or sensitive data.

2. Inspect a judged summary before applying it:

   ```text
   /slipstream compact --prepare
   ```

   This writes `candidate-summary.md` and `judge.json`.

3. Apply the prepared summary if it is still fresh:

   ```text
   /slipstream compact --adopt
   ```

Prepared summaries expire after `pendingTtlMs` (default: 5 minutes) and are rejected if the session branch advances too far. With `retainArtifacts: true`, old `candidate-summary.md` and `judge.json` files remain useful for inspection, but they are not enough for `/slipstream compact --adopt`; rerun `--prepare` if the pending summary expired. A hard crash or generation failure before terminal cleanup can leave an orphan run because startup recovery does not delete directories that may belong to another live writer.

## Native compact vs Slipstream

| Area                   | Native `/compact`                                            | `pi-slipstream-compact`                                                                              |
| ---------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Main path              | One summarization pass.                                      | Generate, validate, repair if needed, then adopt.                                                    |
| Current-state fidelity | Can lose exact latest files, errors, or decisions.           | Prepends deterministic current-state facts and validates them before adoption.                       |
| Stale-state protection | Can preserve obsolete next actions or miss the latest turn.  | Checks latest exchange, continuation evidence, and branch freshness.                                 |
| Recovery               | Summary text is usually the main surviving artifact.         | Writes local snapshots, state evidence, git evidence, prompts, judge results, and adoption metadata. |
| Best use case          | Shorter or low-stakes sessions where speed/cost matter most. | Long coding sessions where losing exact state is expensive.                                          |

Local validation so far shows the difference this package is trying to optimize for: the latest fresh-agent continuation validation scored the Slipstream path at `9.36/10` versus native `/compact` at `5.36/10` on 11 clean overlapping cases. See [Benchmark results](#benchmark-results) for data and caveats.

## Tradeoffs

| Tradeoff                    | What it means                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| More model calls            | A validated compaction normally uses at least a summary call and a judge call; rejected candidates can add repair calls. Background preparation can spend these calls before you manually ask to compact. |
| More latency                | Manual compaction is slower than native summarization because it gathers evidence, writes artifacts, judges, and may repair. Background preparation can hide some latency by starting earlier.            |
| More provider-bound context | Summary, judge, and repair prompts can include conversation text, tool output, paths, git excerpts, and artifact references. Do not use it on repositories where that provider exposure is unacceptable.  |
| Local artifact footprint    | Recovery artifacts are written under `.scratch/compactions`; they may contain sensitive paths, diffs, commands, or outputs and must stay gitignored.                                                      |
| Experimental behavior       | The judge improves continuation readiness but does not prove code correctness or external task success. Start with [Evaluate safely](#evaluate-safely) on new repositories.                               |

If you mostly run short sessions, care more about minimizing cost than preserving exact state, or cannot send session evidence to the configured model provider, native compaction is probably the better default; disable the package to use native compaction.

## What this is based on

The core idea comes from Slipstream-style validation: write a shorter summary while the session continues, then check whether that summary still supports the next continuation. This package adapts that idea for Pi coding sessions by adding file/error/decision tracking, git/session artifacts, stale-state checks, and explicit rejected-summary policy.

It also borrows narrower ideas from active context compression, subgoal-style task state, and external evidence stores: compact before the window is exhausted, preserve completed-work/current-state structure, and keep raw recovery evidence outside the prose summary. The detailed source mapping is in [Research and related ideas](#research-and-related-ideas).

## Failure modes this targets

Long coding-agent sessions fail in boring, expensive ways after compaction:

- exact file paths collapse into ambiguous basenames,
- recent test failures or tool errors disappear,
- user decisions and constraints get paraphrased into something weaker,
- the agent forgets what was modified, verified, or still blocked,
- a summary sounds plausible but cannot support the next few turns of work.

## Research and related ideas

The direct inspiration is Slipstream: generate a compacted handoff, then validate it against continuation evidence before adopting it.

The other references are related ideas, not full implementations in this package.

| Source                                                                                                                                                                  | Relationship to this package                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [Slipstream: Trajectory-Grounded Compaction Validation for Long-Horizon Agents](https://arxiv.org/html/2605.08580) and [repo](https://github.com/chenzhuofu/slipstream) | Core basis: checked compaction before adoption. This package adapts it for Pi's files, tool output, git state, errors, and user decisions. |
| [Active Context Compression](https://arxiv.org/html/2601.07190v1)                                                                                                       | Related idea: manage context before the window is exhausted instead of waiting until compaction is urgent.                                 |
| [HiAgent](https://aclanthology.org/2025.acl-long.1575/)                                                                                                                 | Related idea: long tasks need durable task/subgoal state, not just a flat transcript summary.                                              |
| [Memex(RL): Scaling Long-Horizon LLM Agents via Indexed Experience Memory](https://arxiv.org/html/2603.04257v1)                                                         | Related idea: keep recoverable evidence outside the prose summary. This package does not implement indexed memory or retrieval learning.   |
| [DeepAgents](https://github.com/langchain-ai/deepagents)                                                                                                                | Related implementation pattern: agents can keep external files/context outside the main prompt. This package uses local artifacts instead. |
| [ACON](https://arxiv.org/html/2510.00615)                                                                                                                               | Future direction: learn better compression policies from failed compacted-vs-full continuations.                                           |

## How it works

```text
Pi session grows
      │
      ▼
/compact, automatic threshold compaction, or /slipstream compact
      │
      ├─ freeze the old state
      │    files, errors, decisions, constraints, latest exchange,
      │    changed paths, verification evidence, user assertions, and critical literals
      │
      ├─ collect recovery evidence
      │    local artifacts, git status, and git diff evidence
      │
      ├─ generate a compacted summary
      │    focused on current state and next steps
      │
      ├─ validate the summary
      │    compare it with the task state, recent continuation, and artifacts
      │
      ├─ repair if needed
      │    ask the model to rewrite missing or weak parts
      │
      ├─ check freshness
      │    reject or revalidate if newer messages appeared after validation
      │
      └─ compact with the accepted summary
           accepted summaries are scored; rejected summaries are explicit
```

The important difference from a normal summarizer: adoption is validated and scored. Accepted summaries are marked by the judge; rejected summaries are handled by an explicit rejected-summary policy instead of silently falling back to native compaction. In `reject` mode, rejected summaries cancel compaction. In `ask` mode, interactive direct/default compaction shows a dialog with score, diagnosis, missing facts, contradictions, artifact directory, and summary preview; any no-UI/false/timeout result falls back to policy acceptance instead of cancellation. In `accept` mode, rejected summaries are accepted directly with `rejectedSummaryAccepted: true`, score, judge diagnostics, and artifact links in compaction details.

## Features

- Plain `/compact` and automatic threshold compaction use validated Slipstream compaction by default.
- `/slipstream` support commands for status, artifact inspection, dry-run, and prepare/adopt evaluation.
- Automatic trigger, enabled by default and configurable with `autoTrigger`.
- Slipstream-style continuation validation before adoption.
- Deterministic manifest extraction for files, errors, decisions, constraints, open loops, verification evidence, latest compacted updates, retained-tail current-state anchors, latest user/assistant exchange state, conservative stale/superseded signals, bounded compacted-away user assertion trails, and critical literals.
- Local artifact store under `.scratch/compactions`, with cooperative chunked trigger snapshot writes so large raw recovery artifacts do not require one giant foreground JSON serialization.
- Central per-session performance stats under `~/.config/pi/.scratch/slipstream-stats/sessions/<session-id>.jsonl`: mode, outcome, timing buckets, judge score, tokens before compaction, and redacted/relative artifact path by default.
- Full compaction-time git diff preservation as chunked artifacts when below artifact byte caps, while keeping model-visible diff text bounded.
- Explicit rejection path: rejected summaries are accepted by policy with score, judge diagnostics, artifacts, and `rejectedSummaryAccepted: true`; `ask` mode shows a scored confirmation dialog first when UI is available, and expert `--prepare` summaries are recoverable from `pending.json` if runtime state resets before `--adopt`.
- Adoption-time freshness guard: pending summaries store `validatedThroughEntryId`; expert `--adopt` and auto activation revalidate against the current branch if newer messages appeared after preparation, while default `/compact` ignores stale pending state and generates a fresh summary instead of adopting it. Consumed pending artifacts are cleared so an old `pending.json` cannot be replayed after compaction.
- Bounded compacted-away user assertion trail that preserves high-value user intent, approvals, scope boundaries, and corrections without replaying raw prompts; user-reported filesystem, git, runtime, or test claims are marked as requiring fresh verification.
- Bounded `Session Findings` summary section for durable source-grounded facts that are useful later but are not the immediate next action.
- TypeScript package manifest for Pi extension loading.

## Local development install

From this repository:

```bash
cd packages/pi-slipstream-compact
pi -e .
```

Or add the local package path to Pi settings:

```json
{
	"packages": ["/absolute/path/to/pi-slipstream-compact"]
}
```

You can also persist the local package with Pi's installer:

```bash
pi install /absolute/path/to/pi-slipstream-compact
```

## Support commands

```text
/slipstream status
/slipstream artifacts
/slipstream compact
/slipstream compact --dry-run
/slipstream compact --prepare
/slipstream compact --adopt
```

| Command                         | Effect                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/slipstream status`            | Shows idle/running/pending/failed state and pending judge details.                                                                       |
| `/slipstream artifacts`         | Shows temporary pending artifacts or the latest retained artifact directory.                                                             |
| `/slipstream compact`           | Generates, reviews, and immediately queues Slipstream compaction.                                                                        |
| `/slipstream compact --dry-run` | Builds a candidate prompt without changing compaction state; keeps its files only with `retainArtifacts: true`.                          |
| `/slipstream compact --prepare` | Expert mode: generates, judges, possibly repairs, and stores a validated pending summary without applying it.                            |
| `/slipstream compact --adopt`   | Expert mode: calls Pi compaction only if a validated pending summary exists; revalidates first if the branch advanced since preparation. |

Unknown flags or positional arguments on `compact` are rejected instead of being ignored.

Local rollout:

1. Plain Pi `/compact` and threshold compaction now use Slipstream by default through `session_before_compact`.
2. `/slipstream compact` remains the explicit one-command support path.
3. `--dry-run` builds the prompt without changing session state; set `retainArtifacts: true` to keep its files.
4. `--prepare` and `--adopt` remain expert inspect-before-apply workflows; rerun `--prepare` if the pending summary expires or becomes stale.
5. Rejected Slipstream summaries are policy-accepted with their score instead of falling back to native compaction; retained artifacts are available only with `retainArtifacts: true`. `ask` mode shows a scored confirmation dialog when UI is available, accepts on timeout/no response, and rejects only when the user explicitly selects Reject.

## Full configuration

Configure in `~/.pi/agent/settings.json` or project `.pi/settings.json`. The canonical settings key is `"pi-slipstream-compact"`; the older `"slipstreamCompact"` key is also accepted for compatibility.

Default-style configuration:

```json
{
	"pi-slipstream-compact": {
		"enabled": true,
		"autoTrigger": true,
		"artifactRoot": ".scratch/compactions",
		"retainArtifacts": false
	}
}
```

Disable background preparation:

```json
{
	"pi-slipstream-compact": {
		"autoTrigger": false
	}
}
```

This disables background preparation only. Plain `/compact` still uses Slipstream while the package is enabled.

Run side-by-side with native Pi or another extension owning plain `/compact`:

```json
{
	"pi-slipstream-compact": {
		"replaceDefaultCompact": false
	}
}
```

This also disables Slipstream auto-triggering. Explicit `/slipstream compact`, `/slipstream compact --prepare`, and `/slipstream compact --adopt` remain available. If you set `replaceDefaultCompact: false`, `autoTrigger` is normalized to `false` even when configured as `true`.

Disable Slipstream compaction replacement entirely:

```json
{
	"pi-slipstream-compact": {
		"enabled": false
	}
}
```

Support commands remain registered, but lifecycle hooks and `/compact` replacement are disabled.

Tuned local configuration example:

```json
{
	"pi-slipstream-compact": {
		"enabled": true,
		"autoTrigger": true,
		"triggerContextPercent": 0.6,
		"minContinuationTurns": 1,
		"maxContinuationTurns": 4,
		"judgeThreshold": 7,
		"repairAttempts": 3,
		"rejectedSummaryMode": "ask",
		"pendingTtlMs": 300000,
		"artifactRoot": ".scratch/compactions",
		"retainArtifacts": false,
		"statsFullPaths": false
	}
}
```

| Setting                 |                Default | Meaning                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ---------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`               |                 `true` | Enables lifecycle hooks and `/compact` replacement. `/slipstream` support commands remain registered even when disabled.                                                                                                                                                                                                                       |
| `autoTrigger`           |                 `true` | Starts background summary preparation near context pressure. Set `false` to disable background preparation. Forced off when `replaceDefaultCompact` is `false`, including when explicitly configured as `true`.                                                                                                                                |
| `replaceDefaultCompact` |                 `true` | When `true`, plain Pi `/compact` and threshold compaction use Slipstream. When `false`, plain/default compaction is left to Pi or another extension, while explicit `/slipstream compact` and `--adopt` still use Slipstream.                                                                                                                  |
| `triggerContextPercent` |                  `0.6` | Single context-pressure threshold for starting background preparation and latching compaction urgency. Fresh validated summaries compact when Pi reports the session is idle; stale summaries are revalidated before adoption. Legacy `softContextPercent`/`hardContextPercent` are accepted as aliases but should not be used for new config. |
| `minContinuationTurns`  |                    `1` | Preferred continuation turns before turn-boundary auto validation. If Pi is already idle after the background summary resolves, auto finalization may proceed with fewer turns instead of waiting forever.                                                                                                                                     |
| `maxContinuationTurns`  |                    `4` | Maximum continuation turns collected for auto validation when later turns arrive.                                                                                                                                                                                                                                                              |
| `judgeThreshold`        |                    `7` | Minimum accepted strict continuation-quality judge score. The judge prompt itself rejects safe-but-weak summaries for repair unless they are production-ready durable handoffs.                                                                                                                                                                |
| `repairAttempts`        |                    `3` | Summary-model full-rewrite repair attempts after strict judge rejection. Empty/heading-only repair outputs are skipped without replacing the prior substantive candidate, and remaining attempts continue.                                                                                                                                     |
| `rejectedSummaryMode`   |                `"ask"` | Rejected-summary handling after repairs fail: `"ask"` shows score/diagnostics/summary preview when UI selection is available and accepts on timeout/no response unless the user explicitly rejects, `"reject"` cancels compaction, and `"accept"` accepts immediately.                                                                         |
| `pendingTtlMs`          |               `300000` | Expiry for a prepared pending summary.                                                                                                                                                                                                                                                                                                         |
| `artifactRoot`          | `.scratch/compactions` | Local artifact directory, resolved against Pi's current project cwd; paths outside the project are rejected, including existing symlinks that resolve outside the project.                                                                                                                                                                     |
| `retainArtifacts`       |                `false` | Deletes terminal run artifacts; set `true` to preserve completed runs for debugging.                                                                                                                                                                                                                                                           |
| `statsFullPaths`        |                `false` | Central performance stats store `cwd: "."` and relative/redacted artifact paths by default. Set `true` only when you explicitly want full local paths in `~/.config/pi/.scratch/slipstream-stats`.                                                                                                                                             |
| `summaryModel`          |           active model | Optional `provider/model-id` override for summary generation.                                                                                                                                                                                                                                                                                  |
| `judgeModel`            |           active model | Optional `provider/model-id` override for judging.                                                                                                                                                                                                                                                                                             |

The judge uses a strict continuation-probe rubric for current state, next actions, constraints, risk and verification awareness, artifact grounding, retrievability, knowledge continuity, stale-state suppression, and low-noise/non-contradiction. Safe-but-weak summaries are rejected for repair instead of passing through a second critic.

Optional model override example:

```json
{
	"pi-slipstream-compact": {
		"summaryModel": "openai/gpt-4.1",
		"judgeModel": "openai/gpt-4.1"
	}
}
```

## Pi lifecycle integration

The extension registers one command namespace and a small set of lifecycle handlers:

| Pi surface                           | Package behavior                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registerCommand("slipstream", ...)` | Provides `/slipstream status`, `artifacts`, one-command `compact`, `compact --dry-run`, `compact --prepare`, and `compact --adopt`.                                                                                                                                                                                                       |
| `turn_end`                           | At `triggerContextPercent`, starts candidate generation after final assistant responses, latches compaction urgency, collects continuation evidence when later turns arrive, revalidates stale pending summaries against the live branch head, and activates only fresh pending summaries with `ctx.compact()`.                           |
| `session_before_compact`             | Uses a current Slipstream-requested pending summary if available; otherwise generates, judges, and returns a fresh Slipstream summary as the default compaction replacement. With `replaceDefaultCompact: false`, plain/default compaction returns to Pi or another extension unless `/slipstream compact` explicitly requested adoption. |
| `session_start` / `session_shutdown` | Keeps the compact widget hidden while idle, clears it on shutdown, updates lightweight status, and clears in-memory background state.                                                                                                                                                                                                     |

The normal manual path is plain Pi `/compact` or `/slipstream compact` when `replaceDefaultCompact` is enabled, and explicit `/slipstream compact` only when side-by-side mode is enabled. The automatic path uses one threshold: begin preparing at `triggerContextPercent`, keep collecting continuation evidence when it arrives, and compact only when the pending summary is validated through the current branch head and Pi reports an idle runtime with no queued messages. If no later turn arrives after the background summary resolves, Slipstream can still proceed through finalizing, judging, repair, pending-summary creation, and idle adoption instead of waiting forever. If the auto pending summary is stale, Slipstream revalidates it with a fresh retained-tail boundary instead of blocking on old work, adopting stale state, or keeping an old oversized tail. If timing still reaches Pi's own model-limit compaction, Slipstream generates/judges directly in `session_before_compact` unless `replaceDefaultCompact` is disabled. The expert prepare/adopt split still exists when you want to inspect a validated pending summary before applying it.

## Integration API

Other extensions can reuse Slipstream-style validation without installing Slipstream as the default `/compact` owner:

```ts
import { slipstreamStyleValidateAndRepair } from "pi-slipstream-compact/integration-api";

const result = await slipstreamStyleValidateAndRepair({
	candidate,
	sourceEvidence: {
		sourceMessageExcerpts,
		filesModified,
		unresolvedErrors,
		userDecisions,
		constraints,
	},
	continuation,
	completeText,
	config: { judgeThreshold: 7, repairAttempts: 1 },
});
```

The integration API is deliberately narrower than the full extension lifecycle. It judges and optionally repairs a caller-provided candidate summary using caller-provided evidence and a caller-provided `completeText` function. It does not call `ctx.compact()`, register commands, manage pending state, update widgets, write local artifacts, or write central stats. The result includes the final `summary`, `accepted`, `repaired`, `repairCount`, top-level score/diagnostics, and the underlying `JudgeResult`.

Use this when another extension already owns candidate generation and wants a Slipstream-style quality gate. Use the full package lifecycle when you want Slipstream to own candidate generation, evidence collection, repair, freshness checks, artifacts, and adoption.

## Progress visibility

The package shows a compact Slipstream widget above the prompt only while Slipstream is actively preparing, compacting, or holding a prepared pending summary. It is hidden while idle. The widget stays short: exact current stage plus elapsed time for active work, and judge score when available. In the interactive TUI, it uses Pi theme colors; in plain/RPC contexts, it falls back to text.

Widget contents are intentionally limited to actionable stage labels:

| Internal state           | Widget text example                                     | Why this is enough                                                                                     |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| snapshot                 | `Slipstream: snapshotting local state · 3s`             | Shows local synchronous work separately from model calls.                                              |
| artifacts                | `Slipstream: writing artifacts · 1s`                    | Shows local artifact writes.                                                                           |
| state evidence           | `Slipstream: collecting evidence · 2s`                  | Shows bounded read-only git/session evidence collection.                                               |
| summary                  | `Slipstream: summarizing · 38s`                         | Shows the summary model call is running.                                                               |
| waiting for auto summary | `Slipstream: waiting for auto summary · 12s`            | Auto finalization is waiting for the background summary before judging.                                |
| judging                  | `Slipstream: checking summary · 21s`                    | Shows the judge model call is running.                                                                 |
| repairing                | `Slipstream: repairing summary · 74s · last score 4/10` | The score explains why repair is running without implying the repair output has been judged.           |
| accepted/current pending | `Slipstream: ready · score 9/10`                        | The score is current and actionable.                                                                   |
| rejected                 | `Slipstream: summary rejected · score 4/10`             | The low score is the concise reason this is rejected; detailed diagnosis stays in warning/status text. |
| applying compaction      | `Slipstream: compacting · score 9/10`                   | Pi is applying an already judged prepared summary.                                                     |
| idle                     | hidden                                                  | No active action.                                                                                      |

If Pi is closed while a prepared pending summary exists, startup recovery checks the persisted `pending.json`. The widget is restored as `Slipstream: ready · score N/10` only when the recovered summary still matches the same session, cwd, TTL, and current branch head; stale or expired pending summaries stay hidden.

Routine progress stays visible without chat-style progress spam: the widget shows active stage and elapsed time, while the footer/status line changes only when the progress phase or message changes so timer ticks do not repaint both UI regions every second. Active lifecycle progress owns a disposable widget controller, so shutdown and compaction teardown can cancel timers instead of leaving stale owners behind. Lifecycle progress can preempt older lifecycle progress; support-command progress does not preempt an active lifecycle owner. Interactive rejected-summary decisions use the confirmation/select UI when `rejectedSummaryMode` is `"ask"`; non-interactive accepted/rejected outcomes are recorded in compaction details or a concise warning.

## Current compaction mode

The package now supports one runtime strategy across manual, hook, and auto paths: continuation-first Slipstream replacement. The former fact-ledger route was removed because it did not earn its extra model calls, lifecycle state, prompts, tests, and user-facing complexity.

The former `--high-accuracy` mode was removed because it added broad chunk evidence without a global prompt budget and could overload the summary model.

A future slower path should be targeted refinement: start from the normal candidate, use the judge to identify missing/risky facts, then retrieve only the evidence needed for those gaps.

## Artifact model

Artifacts are local recovery evidence, not decorative logs. A typical validated run directory contains:

```text
.scratch/compactions/<session-id>-<run-id>/
  run.json
  index.json
  trigger-snapshot.json
  trigger-raw-001.json
  state-evidence.json
  git-status.txt
  git-diff-stat.txt
  git-diff-full-001.patch
  git-snapshot.json
  candidate-summary.md
  judge.json
  continuation.json
  adoption.json
```

Dry-run directories write `candidate-prompt.md` instead of `candidate-summary.md` and do not write `judge.json`, `continuation.json`, or `adoption.json`.

`git-snapshot.json` records:

- status path,
- diff-stat path,
- full diff chunk paths,
- full diff SHA-256,
- full diff byte count,
- whether git diff collection completed,
- whether full preservation succeeded.

By default, artifact chunks are 512 KiB and a single artifact payload is capped at 96 MiB. Trigger snapshot chunks are written cooperatively from JSON fragments instead of first building one full raw JSON string and buffer, so large local recovery snapshots should yield back to Pi's event loop during artifact preparation. They can still consume disk and CPU proportional to transcript size; the goal is responsiveness, not zero local cost.

If the full git diff is larger than the cap, or if git diff collection reports truncation or another error, the package writes an omission/incomplete note instead of pretending the stored bytes are a complete diff. Summary prompts are capped by reducing model-visible conversation text; if protected fixed sections alone exceed the prompt cap, Slipstream fails fast with artifacts instead of sending an oversized prompt.

## Evidence semantics

The package separates evidence into three levels:

| Level                          | Examples                                                                                                                                 | Used for                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Model-visible writer grounding | bounded git diff, manifest facts, artifact paths                                                                                         | helps the summary writer produce a better candidate |
| Judge-protected facts          | files, errors, constraints, decisions, latest updates, critical literals, verification evidence, continuation facts                      | blocks adoption if missing or contradicted          |
| Raw local artifacts            | full trigger snapshot chunks, full git diff chunks, state evidence JSON                                                                  | recovery and debugging outside the model prompt     |
| Central performance index      | `~/.config/pi/.scratch/slipstream-stats/sessions/<session-id>.jsonl` rows with timings, judge score, and redacted/relative artifact path | cross-session local performance audits              |

Raw git diff text alone is not acceptance-blocking. If a patch detail matters for safe continuation, it should appear as a distilled fact, latest update, critical literal, or continuation-used fact.

## Implementation choices

| Choice                                                    | Reason                                                                                                                                                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Greenfield package instead of patching `pi-smart-compact` | The target behavior is not just better scoring; it is a different lifecycle: prepare, validate, repair, then explicitly adopt.                                                                  |
| Local default compaction replacement                      | Plain `/compact` and threshold compaction now use Slipstream directly, so there is one active compaction path.                                                                                  |
| Prepared-summary fast path                                | If `/slipstream compact --prepare` has already validated a pending summary, `session_before_compact` consumes it immediately.                                                                   |
| Direct hook generation fallback                           | If no pending summary exists, `session_before_compact` generates, judges, repairs, and returns a Slipstream summary; final rejection is policy-accepted with score/artifacts.                   |
| Final-assistant-boundary auto trigger                     | Background preparation starts only after final assistant responses, avoiding orphaned tool-result boundaries.                                                                                   |
| Full raw artifacts + bounded prompt evidence              | Large transcripts and diffs must remain recoverable without sending megabytes to the model.                                                                                                     |
| Deterministic current-state capsule before model summary  | Critical latest-state scaffolding is prepended by code instead of being optional model prose.                                                                                                   |
| Deterministic manifest before model summary               | Trust extracted file/error/decision/literal facts more than prose guesses.                                                                                                                      |
| Policy-accept instead of native fallback                  | A rejected Slipstream summary should not silently degrade to the compactor it is intended to replace; rejected acceptance is explicit, scored, and marked in compaction details.                |
| Central session stats instead of artifact-local stats     | Future weekly/all-session reviews can scan one central directory; paths are redacted/relative unless `statsFullPaths` is explicitly enabled. No per-turn writes or extra model calls are added. |

## Testing and evaluation

Current local verification:

```bash
(cd packages/pi-slipstream-compact && npm run check)
```

Latest result:

- 231 Node test-runner tests passed.
- `tsc --noEmit` passed.
- Post-fix 2026-05-29 fresh-agent continuation validation on 11 clean overlapping cases: Slipstream scored `9.36/10`, success rate `1.0`, stale-state score `10.0`, and failure modes `none:11`; native scored `5.36/10`, success `0.45`; benchmark Codex prompt scored `3.00/10`, success `0.18`.
- Full 2026-05-29 blinded continuation-probe benchmark: Slipstream scored `9.00/10` and won `64/66` decisions against native Pi compaction and a benchmark-only Codex prompt baseline; the remaining decisions were 1 native win and 1 tie.
- Focused rerun of the only weak full-run case: Slipstream scored `9.00/10` and won `3/3` decisions.

Evaluation performed so far:

| Evaluation                                     | Result                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests                                     | Config normalization, snapshot extraction, artifact writing, summary/judge/repair, pending state, commands, model setup, auto lifecycle, state evidence.                                                                                                                                                                                                        |
| Manual live Pi flow                            | Prepared/adopted hook compaction; post-compaction no-tools answer preserved files, sentinels, passing command, and intentional failing command.                                                                                                                                                                                                                 |
| Auto live Pi flow                              | Auto prepared at final assistant boundary; second-turn continuation finalizes/adopts only after freshness and idle checks.                                                                                                                                                                                                                                      |
| Idle auto lifecycle regression tests           | Idle-without-next-turn finalization can proceed while idle; if the branch advanced beyond incomplete continuation evidence, idle revalidation runs before adoption.                                                                                                                                                                                             |
| Progress repaint/regression tests              | Long-running progress phases keep elapsed timer updates in the widget without ticking the footer/status line every second; stale progress owners cannot overwrite newer widget phases, shutdown and compaction teardown cancel active progress timers, command progress cannot preempt lifecycle progress, and repair score labels use the current judge score. |
| Repeated compaction                            | Second hook compaction preserved prior and new sentinels.                                                                                                                                                                                                                                                                                                       |
| Natural scratch repo                           | Preserved basename-colliding skill paths, exact test strings, retryable error behavior, and passing `npm test`.                                                                                                                                                                                                                                                 |
| Forced rejection                               | High threshold rejected candidate; `/slipstream compact --adopt` refused with no compaction entry saved.                                                                                                                                                                                                                                                        |
| Large output                                   | Preserved first/last/error sentinels and Pi output-log pointers after output truncation.                                                                                                                                                                                                                                                                        |
| Past-session replay                            | Real long sessions stayed within prompt bounds during replay checks.                                                                                                                                                                                                                                                                                            |
| 2026-05-29 full LLM benchmark                  | 22 clean overlapping cases, 3 blinded judge replicates each. Slipstream scored `9.00/10` and won `64/66` decisions.                                                                                                                                                                                                                                             |
| 2026-05-29 focused rerun                       | Reran the only weak full-run Slipstream case. Slipstream scored `9.00/10` and won `3/3` decisions.                                                                                                                                                                                                                                                              |
| 2026-05-29 fresh-agent continuation validation | Ran no-tool fresh-agent responses from compacted handoffs and judged downstream continuation behavior on 11 clean overlapping cases. Slipstream scored `9.36/10`, success `1.0`, stale-state `10.0`, failure modes `none:11`.                                                                                                                                   |

Caveat: the benchmark corpus is a local mix of private Pi sessions and some public SWE-bench-derived cases. The benchmarks measure continuation readiness with blinded LLM judging; they are not end-to-end SWE-bench scores or external task-completion scores.

## Benchmark results

Latest primary result: [`docs/latest-full-benchmark-2026-05-29.md`](docs/latest-full-benchmark-2026-05-29.md).

The reported benchmark data comes from a local mix of private Pi sessions and some public SWE-bench-derived cases. Raw sessions, prompts, artifacts, and benchmark outputs are not included in this package because they can contain private repository state, paths, tool output, and provider-bound prompts. Benchmark code is also not bundled in the npm package; it can be shared for review on request.

Current post-fix fresh-agent continuation validation on 11 clean overlapping cases:

| Method                 | Overall avg | Success rate | Stale-state score | Failure modes                     |
| ---------------------- | ----------: | -----------: | ----------------: | --------------------------------- |
| Slipstream             |     9.36/10 |          1.0 |           10.0/10 | `none:11`                         |
| native `/compact`      |     5.36/10 |         0.45 |           5.18/10 | stale/latest-state issues         |
| benchmark Codex prompt |     3.00/10 |         0.18 |           3.45/10 | latest-state/next-action failures |

Full 2026-05-29 blinded review benchmark:

| Method                 | Overall avg |  Wins |
| ---------------------- | ----------: | ----: |
| Slipstream             |     9.00/10 | 64/66 |
| native `/compact`      |     5.36/10 |  1/66 |
| benchmark Codex prompt |     4.24/10 |  0/66 |

Focused rerun of the only weak full-run Slipstream case:

| Method                 | Overall avg | Wins |
| ---------------------- | ----------: | ---: |
| Slipstream             |     9.00/10 |  3/3 |
| native `/compact`      |     3.67/10 |  0/3 |
| benchmark Codex prompt |     0.00/10 |  0/3 |

Caveat: these benchmarks measure continuation readiness with blinded LLM judging. They are not end-to-end SWE-bench scores or external task-completion scores.

## Privacy and security

Artifacts may contain:

- raw conversation snippets,
- tool outputs,
- absolute paths,
- git diffs,
- error messages,
- secrets accidentally present in the session or diff.

The default artifact root is `.scratch/compactions`, which should be gitignored. The configured artifact root must resolve inside the current project directory; absolute paths and `..` escapes outside the project are rejected. Hidden `thinking` content is not copied into compaction text. Do not publish artifact directories.

Slipstream also sends compacted session evidence to the configured model provider for summary generation, judging, and repair. That evidence can include conversation text, tool output, commands, file paths, git status/diff excerpts, artifact references, and secrets that were already present in the session or diff. Do not enable this package on sensitive repositories unless you are comfortable with both local artifact storage and provider-bound model prompts containing that state.

## Limitations

- Experimental package; use [Evaluate safely](#evaluate-safely) before relying on it for important sessions.
- Background preparation is enabled by default; set `autoTrigger: false` to turn it off while keeping manual `/compact` on Slipstream.
- Automatic prepared-summary adoption uses Pi's idle signal; the package does not patch Pi private scheduler methods.
- Full diff preservation is capped by artifact byte limits.
- Quality depends on the configured summary and judge models.
- The judge validates continuation sufficiency; it does not prove the underlying code is correct.
- Historical replay checks prompt size and manifest extraction, not end-to-end human task success.
- Artifact paths are local and may become stale if scratch directories are cleaned.
- Judge-rejected summaries are policy-accepted with score and artifacts; model/tool failures or missing compaction boundaries can still fail, but the package never falls back to native compaction automatically.

## Development

```bash
cd packages/pi-slipstream-compact
npm test
npm run typecheck
npm run check
```

CI runs `npm ci`, `npm run check`, and `npm pack --dry-run --json` on pushes to `main`, pull requests, and manual dispatches.

### Release

Publishing is tag-driven. The `Publish` workflow runs only for tags matching `v*.*.*`, verifies that the tag exactly matches `package.json` (`v${version}`), runs the full check suite, verifies the npm tarball contents, then publishes with npm provenance:

```bash
npm version patch --no-git-tag-version
# review package.json/package-lock.json, commit, then tag the commit as vX.Y.Z
```

One-time npm setup: configure npm trusted publishing for `OrestesK/pi-slipstream-compact` with provider `GitHub Actions` and workflow filename `publish.yml`. The workflow uses OIDC (`id-token: write`) and does not require an `NPM_TOKEN` secret.

Package layout:

```text
src/
  index.ts           # Pi extension entrypoint
  commands.ts        # /slipstream command handling
  auto.ts            # automatic trigger/finalization lifecycle
  pipeline.ts        # dry-run and validated compaction pipeline
  snapshot.ts        # deterministic session manifest extraction
  state-evidence.ts  # read-only git/session evidence collection
  artifact-store.ts  # local artifact writing and indexing
  summary.ts         # summary prompt
  judge.ts           # judge prompt and acceptance rules
  repair.ts          # full-summary rewrite repair prompt
  session-state.ts   # pending adoption state
  model.ts           # Pi model completer integration
```

## Roadmap

- More long natural coding-session evaluations.
- Publishable npm metadata, screenshots, and package-gallery image/video.
- Optional `checkpoint_context` command/tool for Focus-style semantic boundaries.
- ACON-style learning loop over failed compacted-vs-full continuations.
- Better ranking of critical literals when sessions contain more than the current cap.
- Optional retrieval command for opening exact artifact chunks from a compacted summary.

## Bottom line

`pi-slipstream-compact` is built around one principle: **do not trust a compaction summary until it proves it can support what the agent needs next**.
