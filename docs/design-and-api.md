# Design and integration API

Technical reference for [`pi-slipstream-compact`](../README.md).

- [Usage and configuration](usage.md)
- [Historical benchmark report](latest-full-benchmark-2026-05-29.md)

This document explains the extension lifecycle, validation path, evidence boundaries, local recovery artifacts, and reusable validation API. It describes the current implementation; it does not change Pi's compaction contract or guarantee that generated code is correct.

## Working model

Slipstream adds a checked handoff around Pi compaction:

1. Capture the session boundary and deterministic current-state evidence.
2. Generate a continuation-focused candidate summary.
3. Judge the candidate against the captured state and later continuation evidence.
4. Repair and judge again when the candidate does not meet the configured threshold.
5. Verify that the prepared result still matches the live branch, then let Pi compact with it.

A judge acceptance means the handoff met the continuation-readiness policy. It is not proof of source-code correctness or downstream task completion.

## Runtime entry points

| Entry point | Owner | Behavior |
| --- | --- | --- |
| Plain `/compact` | Pi invokes `session_before_compact` | With `replaceDefaultCompact: true`, Slipstream consumes a matching prepared summary or runs the validated pipeline synchronously. |
| `/slipstream compact` | Slipstream command handler | Runs the validated pipeline, stores a pending result, requests Pi compaction, and lets `session_before_compact` consume the matching pending state. |
| Automatic threshold path | `turn_end` lifecycle work | Starts background preparation after `triggerContextPercent`, collects continuation evidence, finalizes the candidate, and requests adoption only at a safe runtime boundary. |
| Side-by-side mode | Pi or another extension owns plain `/compact` | `replaceDefaultCompact: false` also disables automatic triggering. Explicit `/slipstream compact` remains available. |
| Model-limit/default compaction | `session_before_compact` | When Slipstream owns default compaction and no usable pending result exists, it generates and judges a current result instead of falling back to native compaction. |

The extension registers the `/slipstream` command namespace and the `session_start`, `session_shutdown`, `session_tree`, `turn_end`, `session_compact`, and `session_before_compact` lifecycle handlers.

## Manual and default compaction

### Prepared result

A prepared result contains:

- the summary and Pi `firstKeptEntryId` boundary;
- the session ID and project working directory;
- the branch entry through which it was validated;
- judge result, repair status, and rejected-summary policy metadata;
- the recovery-artifact directory and expiry time.

`session_before_compact` consumes it only when the session, working directory, preparation boundary, branch freshness, and TTL still match. Consumed or stale pending state cannot be replayed.

### No prepared result

When Slipstream owns plain `/compact`, the hook builds a fresh snapshot, state evidence, candidate, judge result, and repairs before returning a compaction object to Pi. Missing model access, insufficient continuation evidence, rejected fail-closed policy, generation failure, or a missing compaction boundary cancels that compaction.

Slipstream does not silently return to native compaction after a validated-path failure. With `replaceDefaultCompact: false`, it returns ownership to Pi or another extension before entering the Slipstream path.

## Automatic preparation and adoption

### Starting work

At a stable assistant turn boundary, context usage at or above `triggerContextPercent` latches compaction urgency. Slipstream starts one background job when:

- the extension and `autoTrigger` are enabled;
- no pending summary, auto job, or active pipeline already owns the state;
- the current session and working directory still match.

The job freezes the trigger snapshot, writes recovery evidence, begins summary generation, and starts a bounded continuation buffer. Later `turn_end` events append continuation turns while the summary runs.

### Finalizing work

Finalization:

1. waits for the candidate summary;
2. adds the deterministic current-state capsule;
3. writes continuation evidence;
4. judges the candidate and retries a judge parse failure with reduced continuation text;
5. runs bounded full-summary repairs when required;
6. stores the best accepted candidate, or applies the configured rejected-summary policy;
7. persists `pending.json` with a five-minute default TTL.

Idle finalization can proceed without waiting indefinitely for another turn. If the branch advances after preparation, Slipstream re-runs the validated pipeline against the current branch before adoption rather than applying stale pending state.

### Safe adoption boundary

Automatic adoption requires Pi to report an idle runtime with no queued messages. Slipstream uses Pi's public idle and pending-message signals; it does not patch private scheduler methods. If the runtime is busy, the pending summary remains ready and adoption is retried at a later safe boundary.

Tree navigation, session changes, completed compaction, and shutdown retire mismatched jobs or pending in-memory state. On session start, the extension can recover the newest matching, unexpired `pending.json`; it adopts that state only when its validated branch boundary still matches the current branch.

## Rejected-summary policy

A judge accepts only when all of these hold:

- decision is `accept`;
- score meets `judgeThreshold`;
- no critical contradiction remains;
- the candidate does not contain a detected secret-shaped value.

After repair attempts are exhausted:

| Mode | Direct or interactive path | Automatic preparation |
| --- | --- | --- |
| `"ask"` (default) | Shows score, diagnosis, missing facts, contradictions, artifacts, and summary preview when UI is available. Explicit **Reject** cancels; timeout, no response, or no UI accepts by policy. | Stores a policy-accepted pending result without an interactive prompt and records that the rejected summary was accepted. |
| `"reject"` | Cancels compaction. | Does not create an adoptable pending result. |
| `"accept"` | Accepts immediately. | Stores the rejected result as adoptable pending state. |

Compaction details record the judge result, repair status, selected mode, and whether a rejected result was accepted. See [Usage and configuration](usage.md) before changing this policy.

## Evidence boundaries

Slipstream keeps different evidence at different boundaries. Local recovery evidence is broader than the text sent to a model.

| Boundary | Contents | Limits and purpose |
| --- | --- | --- |
| Summary-model prompt | Bounded conversation, deterministic manifest, current-state signals, bounded git/session evidence, and optional retained artifact references | Produces the candidate handoff. Conversation text is reduced first when the total prompt would exceed its budget. |
| Judge-model prompt | Candidate summary, source snapshot, distilled state evidence, artifact references, and bounded continuation evidence | Tests current-state accuracy, constraints, contradictions, stale state, and next-action readiness. Continuation text is degraded before protected sections when the prompt is too large. |
| Local recovery run | Raw trigger-snapshot chunks, state evidence, git status/stat/diff evidence, prompts or prompt metrics, candidate, continuation, judge output, pending/adoption metadata | Supports recovery and inspection. It can contain more sensitive material than model-visible prompts and must not be published. |

Model prompts pass through the package's prompt-redaction step, but this is not a secrecy guarantee. Conversation text, tool output, paths, git excerpts, and secrets already present in the session can still reach the configured provider. See the complete boundary in [Usage and configuration](usage.md).

### Current-state extraction

The snapshot manifest mines and caps evidence such as:

- modified and read files;
- unresolved errors and open loops;
- decisions, constraints, and user corrections;
- recent verification results;
- latest updates and retained-tail state;
- the latest user/assistant exchange and terminal answer evidence;
- stale or superseded signals;
- critical literals and references to earlier artifacts.

Git evidence is collected with read-only `git status --short`, `git diff --stat`, and `git diff -U20`. The model-visible diff is bounded; the raw diff is separately hashed and considered complete only when git produced it without an error.

## Local artifact model

The default root is project-local `.scratch/compactions`. `artifactRoot` is resolved against the current project and rejected when it resolves outside that project, including through existing symlinks.

Each run has a unique session-prefixed directory. Files are created as their stages execute, so a failed or dry run may contain only a subset.

| Artifact | Purpose |
| --- | --- |
| `run.json` | Run identity, session, trigger boundary, and working directory. |
| `index.json` | Timestamped index of written artifacts and chunk paths. |
| `trigger-snapshot.json` and `trigger-raw-*.json` | Snapshot metadata plus chunked raw messages and manifest. |
| `state-evidence.json` | Bounded session and git evidence used by prompts. |
| `git-status.txt`, `git-diff-stat.txt`, `git-snapshot.json` | Git status, summary, hashes, byte counts, completeness, and chunk references. |
| `git-diff-full-*.patch` or `git-diff-full-omitted.txt` | Full diff chunks when complete and below the artifact cap, otherwise an explicit omission record. |
| `candidate-prompt.md` | Dry-run summary prompt. |
| `candidate-summary.md` | Current generated or repaired candidate. |
| `continuation.json` | Turns observed after the trigger boundary. |
| `prompt-metrics.json` | Prompt kinds, character counts, and applicable budgets. |
| `judge.json` and `judge-raw-*.json` | Parsed judge result and bounded raw responses retained for parse failures. |
| `pending.json` | Recoverable prepared summary and freshness metadata. |
| `adoption.json` | Boundary and judge metadata recorded when a result becomes pending for adoption. |

Trigger snapshots and preserved full diffs use 512 KiB chunks with a 96 MiB per-artifact total cap. An incomplete or oversized full diff is never labeled as fully preserved; the omission artifact records the reason and SHA-256 so exact evidence can be collected again from the repository.

### Retention and statistics

With `retainArtifacts: false`, completed terminal runs are removed. A pending run remains only while required for adoption or startup recovery, then is removed when consumed, expired, superseded, or rejected. With retention enabled, completed run contents remain, but consumed or expired `pending.json` is cleared so it cannot be replayed.

A hard crash or failure before terminal cleanup can leave an orphan run. Startup recovery scans only matching session directories, verifies run ownership, rejects expired or mismatched pending data, selects the newest valid candidate, and disposes superseded candidates according to the retention policy.

Performance records are separate from recovery runs. They append by session under `~/.config/pi/.scratch/slipstream-stats/sessions` by default. `cwd` and artifact paths are relative or redacted unless `statsFullPaths: true`; `PI_SLIPSTREAM_STATS_ROOT` can override the stats root.

## Implementation constraints

- Prompt budgets preserve deterministic manifest and state-evidence sections before reducing conversation or continuation text.
- Snapshot and large-artifact writes yield cooperatively so one large serialization does not monopolize the foreground runtime.
- Prepared summaries are scoped to one session, working directory, branch boundary, and TTL.
- Artifact paths are treated as local recovery pointers, not durable external identifiers.
- Stats writing is optional telemetry and does not block compaction when it fails.
- Hidden model thinking is not copied into the compaction summary.
- The judge measures handoff sufficiency; source validation and test execution remain the coding agent's responsibility.

## Integration API

Extensions that already generate their own candidate can reuse Slipstream's judge-and-repair loop:

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
    openLoops,
    recentVerification,
    latestUpdates,
    staleSignals,
    criticalLiterals
  },
  continuation,
  completeText,
  config: {
    judgeThreshold: 7,
    repairAttempts: 1
  },
  signal
});
```

### Inputs

| Field | Meaning |
| --- | --- |
| `candidate` | Caller-generated summary to evaluate. |
| `sourceEvidence` | Optional arrays of messages, files, errors, decisions, constraints, open loops, verification, current-state updates, exchange evidence, stale signals, and critical literals. |
| `continuation` | Optional string or string array describing what happened after the candidate boundary. |
| `completeText` | Caller-owned model completion function used for judge and repair prompts. |
| `config.judgeThreshold` | Acceptance threshold; defaults to `7`. |
| `config.repairAttempts` | Bounded repair count; defaults to `1` and is clamped to at most `3`. |
| `config.repairEnabled` | Set to `false` to judge without repair. |
| `signal` | Optional abort signal passed to model completion. |

### Result

The result includes:

- final `summary` and `accepted` state;
- `repaired` and `repairCount`;
- top-level `score`, `missing`, `contradictions`, and `diagnosis`;
- the complete parsed `judge` result.

If a repair produces an accepted candidate with a better score, the API returns the best accepted candidate found during the bounded loop.

### API non-goals

The integration API does not:

- generate the initial candidate;
- register Pi commands or lifecycle hooks;
- call `ctx.compact()`;
- manage pending state, freshness, TTL, or adoption;
- inspect the repository;
- write local artifacts or central statistics.

Use the full extension lifecycle when Slipstream should own snapshot generation, evidence collection, repair, freshness checks, artifacts, and adoption.
