# pi-slipstream-compact

Keep the files, failures, decisions, constraints, and next steps from a long [Pi Coding Agent](https://github.com/badlogic/pi-mono) session available after compaction.

Slipstream replaces one-pass summarization with a checked flow: **generate → judge → repair when needed → compact**. It is designed for long coding sessions where losing exact current state is costly.

## Quick start

1. Install the package:

   ```bash
   pi install npm:pi-slipstream-compact
   ```

2. Make sure `.scratch/` is in your project's `.gitignore`. Slipstream writes temporary recovery artifacts under `.scratch/compactions`.

3. Keep using Pi normally. By default:

   - plain `/compact` uses Slipstream;
   - background preparation starts as the context window fills;
   - the compact widget appears only while Slipstream is active;
   - `/slipstream status` shows the current state.

No configuration is required for the default workflow.

## Documentation

- [Usage and configuration](docs/usage.md) — commands, inspection workflow, settings, artifacts, privacy, and limits.
- [Design and integration API](docs/design-and-api.md) — lifecycle, evidence model, artifact semantics, freshness, and extension API.
- [Historical benchmark report](docs/latest-full-benchmark-2026-05-29.md) — methodology, results, data boundaries, and limitations.

## Know before enabling

- **Local access:** Pi packages run with your local user permissions. Review package source before installation.
- **Model-provider data:** summary, judge, and repair calls can include conversation text, tool output, commands, file paths, git status or diff excerpts, artifact references, and secrets already present in that material.
- **Cost and latency:** a compaction normally adds summary and judge model calls. Repairs add more calls. Background preparation can make these calls before you manually request compaction.
- **Local data:** recovery artifacts can contain sensitive repository and session state. They are temporary by default, but compact performance records persist under `~/.config/pi/.scratch/slipstream-stats` with paths redacted or made relative by default.
- **Rejected summaries:** the default `rejectedSummaryMode: "ask"` shows a decision in interactive UI. An explicit **Reject** cancels compaction; a timeout, no response, or no UI accepts the rejected summary by policy. Set the mode to `"reject"` for fail-closed behavior.

See [Usage and configuration](docs/usage.md#privacy-and-security) for the complete boundary.

## Choose your control level

| Workflow | Configuration or command | Behavior |
| --- | --- | --- |
| Automatic (default) | No changes | Slipstream prepares near context pressure and owns plain `/compact`. |
| Manual preparation | `autoTrigger: false` | Disables background preparation; plain `/compact` still uses Slipstream. |
| Side-by-side | `replaceDefaultCompact: false` | Leaves plain `/compact` to Pi or another extension and disables auto-triggering. Use `/slipstream compact` explicitly. |
| Fail closed | `rejectedSummaryMode: "reject"` | Cancels compaction when judge rejection remains after repair attempts. |

Set `retainArtifacts: true` when you want completed run artifacts to remain available for inspection.

## When Slipstream helps

| | Native `/compact` | Slipstream |
| --- | --- | --- |
| Summary path | One summarization pass | Generate, judge, repair when needed, then adopt |
| Current-state evidence | Primarily conversation context | Session state plus bounded file, error, decision, verification, and git evidence |
| Stale-state handling | Depends on the generated summary | Checks continuation evidence and branch freshness before adoption |
| Recovery material | Compacted summary | Temporary local snapshots, evidence, prompts, judge results, and adoption metadata |
| Best fit | Short sessions or minimum model cost | Long sessions where exact current state matters |

Slipstream improves the handoff into the next part of a session. Its judge checks continuation readiness; it does not verify the underlying code or guarantee task completion.

## How it works

1. **Capture current state.** Slipstream freezes the relevant session boundary and collects bounded files, errors, decisions, constraints, verification results, recent exchanges, and git evidence.
2. **Generate a candidate.** The summary model creates a continuation-focused handoff.
3. **Judge the handoff.** A separate prompt scores current-state accuracy, next actions, constraints, contradictions, stale state, and recoverability.
4. **Repair when needed.** Rejected candidates can be rewritten and judged again, up to the configured repair limit.
5. **Check freshness and compact.** Slipstream revalidates a prepared summary when the branch advances, then asks Pi to compact only from current pending state.

This design is inspired by [Slipstream: Trajectory-Grounded Compaction Validation for Long-Horizon Agents](https://arxiv.org/html/2605.08580), adapted for Pi coding sessions.

## Common commands

| Command | Use |
| --- | --- |
| `/compact` | Run Slipstream compaction when it owns the default path. |
| `/slipstream status` | Show the current Slipstream state and available judge details. |
| `/slipstream compact` | Generate, judge, and queue Slipstream compaction explicitly. |
| `/slipstream compact --dry-run` | Inspect the candidate prompt and local evidence without judging or compacting. |

See the [complete command reference and inspect-first workflow](docs/usage.md#commands).

## Configuration

Configure Slipstream in global `~/.pi/agent/settings.json` or project `.pi/settings.json`.

The canonical settings key is `"pi-slipstream-compact"`. This minimal example disables background preparation while keeping Slipstream on plain `/compact`:

```json
{
  "pi-slipstream-compact": {
    "autoTrigger": false
  }
}
```

See the [complete settings reference and recipes](docs/usage.md#configuration).

## Benchmark

The May 2026 benchmark report recorded a score of `9.36/10` for Slipstream versus `5.36/10` for native `/compact` on 11 fresh-agent continuation cases. In a separate 66-decision blinded continuation review, Slipstream scored `9.00/10` and won 64 decisions, with one native win and one tie. These results describe the evaluated build and have not been rerun for the current release.

The corpus mixes private local Pi sessions with public SWE-bench-derived trajectories. Results use LLM judging and measure continuation readiness, not SWE-bench issue resolution or end-to-end coding success. See the [full benchmark report](docs/latest-full-benchmark-2026-05-29.md) for methods, data boundaries, and limitations.

## Privacy and limits

Slipstream trades more model calls, latency, provider-bound context, and local recovery state for a more continuation-focused handoff. Its judge does not verify code correctness, and failures cancel rather than automatically falling back to native compaction.

Read the complete [privacy, artifact, cost, and failure boundaries](docs/usage.md#privacy-and-security) before enabling it on a sensitive repository.

## Integration API

Extensions that already own candidate generation can import `slipstreamStyleValidateAndRepair` from `pi-slipstream-compact/integration-api` for artifact-free judging and optional repair.

See [Design and integration API](docs/design-and-api.md#integration-api) for the contract, example, and non-goals.

## Local development

From this repository:

```bash
pi -e .
```

Run the repository checks before submitting a change:

```bash
npm run check
```

## Support

- Report bugs and request features in [GitHub Issues](https://github.com/OrestesK/pi-slipstream-compact/issues).
- License: [MIT](LICENSE).
