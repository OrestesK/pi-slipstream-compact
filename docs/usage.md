# Usage and configuration

[Back to README](../README.md) · [Design and integration API](design-and-api.md) · [Benchmark report](latest-full-benchmark-2026-05-29.md)

This guide covers normal operation, inspection workflows, configuration, artifacts, privacy, and failure behavior for `pi-slipstream-compact`.

## Default behavior

After installation, no configuration is required:

- Slipstream replaces plain `/compact`.
- Background preparation starts near 60% context usage.
- Automatic compaction adopts only pending work that is fresh for the current branch and waits for Pi to be idle.
- The compact widget appears while Slipstream is active.
- Completed recovery artifacts are deleted unless `retainArtifacts` is enabled.

Use `/slipstream status` to inspect the current in-memory state.

## Choose a control mode

| Workflow | Configuration | Behavior |
| --- | --- | --- |
| Automatic (default) | No changes | Slipstream prepares near context pressure and owns plain `/compact`. |
| Manual preparation | `autoTrigger: false` | Disables background preparation; plain `/compact` still uses Slipstream. |
| Side-by-side | `replaceDefaultCompact: false` | Leaves plain `/compact` to Pi or another extension, forces automatic triggering off, and keeps explicit `/slipstream compact`. |
| Fail closed | `rejectedSummaryMode: "reject"` | Cancels compaction when judge rejection remains after repair attempts. |

Native `/compact` is the simpler choice when sessions are short, minimum model cost or latency matters most, or provider-bound session evidence is unacceptable. Disable the package to restore native behavior, or use side-by-side mode to keep Slipstream available explicitly.

## Commands

| Command | Effect |
| --- | --- |
| `/compact` | Uses Slipstream when `replaceDefaultCompact` is enabled. |
| `/slipstream` or `/slipstream status` | Shows idle, running, pending, rejected, or failed state and available judge details. |
| `/slipstream artifacts` | Shows temporary pending artifacts or the latest retained directory known to the current Pi process. It does not scan old runs on disk. |
| `/slipstream compact` | Generates, judges, repairs when needed, and queues compaction immediately. |
| `/slipstream compact --direct` | Uses the same current one-shot compaction strategy explicitly. |
| `/slipstream compact --dry-run` | Builds the candidate prompt and local evidence without judging or changing compaction state. |
| `/slipstream compact --prepare` | Generates, judges, repairs when needed, and stores a pending summary without applying it. |
| `/slipstream compact --adopt` | Applies an unexpired pending summary; revalidates first when the branch advanced. |

Unknown flags and positional arguments are rejected.

## Inspect before compacting

Set `retainArtifacts: true` when you want completed runs to remain available after a command.

### 1. Inspect the candidate prompt and evidence

```text
/slipstream compact --dry-run
```

A retained dry run lets you inspect files such as:

- `candidate-prompt.md`;
- `state-evidence.json`;
- `git-status.txt` and `git-diff-stat.txt`;
- full-diff chunks or an omission record when the diff is incomplete or above the artifact cap;
- `trigger-snapshot.json` and its chunk files.

Look for stale state, missing blockers, incorrect next actions, and sensitive data before allowing model calls.

When `retainArtifacts` is `false`, the dry run completes but its files are removed.

### 2. Prepare and inspect a judged summary

```text
/slipstream compact --prepare
```

This requires at least `minContinuationTurns` continuation turns (one by default), then runs summary generation, judging, and configured repairs before creating a pending summary. A retained run includes `candidate-summary.md`, `judge.json`, prompt metrics, and related evidence.

Judge rejection follows `rejectedSummaryMode`:

- `"ask"` (default): show score, diagnostics, and a summary preview when interactive UI is available. An explicit **Reject** cancels. Timeout, no response, or no UI accepts the rejected summary by policy.
- `"reject"`: cancel without adopting the rejected summary.
- `"accept"`: accept immediately without an interactive decision.

The judge measures continuation readiness. It does not verify code correctness or guarantee task completion.

### 3. Adopt while the pending summary is fresh

```text
/slipstream compact --adopt
```

Prepared summaries expire after `pendingTtlMs` (five minutes by default). Adoption is scoped to the same session and working directory. If the branch advanced, Slipstream rebuilds continuation evidence and revalidates before adoption; when revalidation cannot run or fails, prepare again.

`--adopt` can recover a matching unexpired `pending.json` after in-memory state resets. `/slipstream artifacts` is narrower: it reports only pending or retained paths currently known by the running extension.

Retained summary and judge files remain useful for inspection after expiry, but they are not sufficient for adoption. Run `--prepare` again.

## Configuration

Configure globally in `~/.pi/agent/settings.json` or per project in `.pi/settings.json`. Project settings override global settings.

The canonical key is `"pi-slipstream-compact"`. The older `"slipstreamCompact"` key remains accepted for compatibility.

Minimal explicit configuration:

```json
{
  "pi-slipstream-compact": {
    "autoTrigger": true,
    "replaceDefaultCompact": true,
    "artifactRoot": ".scratch/compactions",
    "retainArtifacts": false
  }
}
```

### Settings reference

| Setting | Default | Meaning |
| --- | ---: | --- |
| `enabled` | `true` | Enables lifecycle hooks and `/compact` replacement. Support commands remain registered when disabled. |
| `autoTrigger` | `true` | Starts background preparation near context pressure. Forced to `false` in side-by-side mode. |
| `replaceDefaultCompact` | `true` | Makes plain `/compact` and automatic threshold compaction use Slipstream. |
| `triggerContextPercent` | `0.6` | Starts background preparation and latches compaction urgency around 60% context usage. |
| `contextReserveTokens` | `24000` | Reserves context capacity when calculating bounded prompt input. |
| `slipstreamKeepRecentTokens` | `50000` | Recent conversation budget retained for compaction evidence. |
| `minContinuationTurns` | `1` | Preferred minimum continuation turns before turn-boundary validation. Idle finalization can proceed sooner. |
| `maxContinuationTurns` | `4` | Maximum continuation turns collected for validation. |
| `judgeThreshold` | `7` | Minimum score for normal acceptance. |
| `repairAttempts` | `3` | Maximum full-summary repair attempts after rejection. |
| `rejectedSummaryMode` | `"ask"` | Rejected-summary policy: `"ask"`, `"reject"`, or `"accept"`. |
| `pendingTtlMs` | `300000` | Lifetime of a prepared pending summary in milliseconds. |
| `artifactRoot` | `".scratch/compactions"` | Project-local recovery directory. Paths resolving outside the project are rejected. |
| `retainArtifacts` | `false` | Keeps completed recovery runs when `true`. |
| `statsFullPaths` | `false` | Stores full local paths in central performance stats only when explicitly enabled. |
| `summaryModel` | active model | Optional `provider/model-id` override for summary generation. |
| `judgeModel` | active model | Optional `provider/model-id` override for judging. |

`softContextPercent` and `hardContextPercent` remain accepted as legacy inputs. Use `triggerContextPercent` for new configuration.

### Common configurations

Disable background preparation while keeping Slipstream on plain `/compact`:

```json
{
  "pi-slipstream-compact": {
    "autoTrigger": false
  }
}
```

Use Slipstream only when requested and fail closed on judge rejection:

```json
{
  "pi-slipstream-compact": {
    "replaceDefaultCompact": false,
    "rejectedSummaryMode": "reject"
  }
}
```

Keep completed recovery artifacts:

```json
{
  "pi-slipstream-compact": {
    "retainArtifacts": true
  }
}
```

Override the active Pi model:

```json
{
  "pi-slipstream-compact": {
    "summaryModel": "openai/gpt-4.1",
    "judgeModel": "openai/gpt-4.1"
  }
}
```

## Artifacts and local state

Recovery runs are written under `.scratch/compactions` by default. Keep `.scratch/` in `.gitignore` and do not publish artifact directories.

Depending on the path and outcome, a run can contain:

- conversation and trigger snapshots;
- state and continuation evidence;
- git status, diff statistics, bounded full-diff chunks, or an omission record;
- model prompts and prompt metrics;
- candidate summaries;
- parsed and bounded raw judge responses;
- pending and adoption metadata;
- an artifact index.

The store writes chunks up to 512 KiB. Trigger-snapshot payloads and full-diff preservation each use a 96 MiB cap. A full diff above the cap, or an incomplete diff read, is represented by an omission record instead of being presented as complete evidence.

Completed runs are deleted by default. Pending artifacts remain only while needed for adoption and are cleaned on adoption or expiry when retention is disabled. A hard crash or failure before cleanup can leave an orphan run; startup recovery avoids deleting directories that may belong to another live writer.

Performance records persist separately by session under `~/.config/pi/.scratch/slipstream-stats/sessions`. They include timing, outcome, token, and judge-score data. Working-directory and artifact paths are relative or redacted by default; `statsFullPaths: true` opts into full local paths.

## Privacy and security

Pi packages run with your local user permissions. Review package source before installation.

Summary, judge, repair, and revalidation prompts can include:

- conversation text and recent exchanges;
- tool output and commands;
- file paths, errors, and verification results;
- git status and bounded diff excerpts;
- artifact references;
- secrets already present in the session, output, or diff.

Local recovery artifacts can contain raw conversation snippets, tool output, absolute paths, git evidence, prompts, summaries, judge responses, and accidentally present secrets. Hidden thinking content is not copied into compaction text.

Do not use the package when local artifact storage or provider-bound session evidence is unacceptable. The configured artifact root must resolve inside the current project; absolute paths or `..` segments are allowed only when their resolved target stays inside that project.

## Cost, latency, and limits

- A normal validated compaction adds summary and judge model calls. Rejected candidates can add repair calls.
- Background preparation can spend model calls before you manually request compaction, but it can hide some foreground latency.
- Manual compaction is usually slower than native summarization because it collects evidence, writes artifacts, judges, and may repair.
- Summary quality depends on the configured models and the evidence available within prompt and artifact caps.
- Automatic adoption depends on Pi's idle signal; Slipstream does not patch Pi's private scheduler.
- Prepared summaries and local artifact references can expire or become stale.
- Model failures, tool failures, missing compaction boundaries, or failed policy checks can cancel compaction.
- Slipstream does not automatically fall back to native compaction.

## Related documentation

- [Design and integration API](design-and-api.md)
- [Historical benchmark report](latest-full-benchmark-2026-05-29.md)
- [Project README](../README.md)
