# Benchmark report — 2026-05-29

This report summarizes the latest validation results for `pi-slipstream-compact` before the `0.1.0` release.

The benchmark asks one practical question: after a long coding session is compacted, does the resulting handoff preserve enough current state for a fresh agent to continue without stale next actions, missing files, or lost decisions?

## Summary

Slipstream scored substantially higher than native Pi `/compact` on continuation-readiness benchmarks.

| Evaluation                             | Slipstream | Native `/compact` |
| -------------------------------------- | ---------: | ----------------: |
| Fresh-agent continuation validation    |    9.36/10 |           5.36/10 |
| Blinded continuation-review benchmark  |    9.00/10 |           5.36/10 |
| Focused rerun of weakest full-run case |    9.00/10 |           3.67/10 |

These tables retain the Slipstream and native Pi results from that historical evaluation; no benchmark was rerun for this editorial change.

The strongest signal is the fresh-agent continuation validation: a no-tool fresh agent received only the compacted handoff, produced a continuation response, and that response was judged against source evidence. Slipstream had a `1.0` continuation success rate and `none:11` recorded failure modes on the clean overlap set.

## Data

The benchmark corpus was a local mix of:

- private Pi coding sessions from real local development work;
- some public SWE-bench-derived coding trajectories adapted for the compaction benchmark.

Raw sessions, prompts, judge outputs, copied session snapshots, and benchmark artifacts are not published with this package because they can include private repository state, paths, tool output, and provider-bound prompts. The benchmark code is not bundled in the npm package; it can be shared for review on request.

These results are not SWE-bench task scores. SWE-bench-derived trajectories were used as some source material for compaction/continuation evaluation, not as an external issue-resolution benchmark.

## Reported methods

| Method            | Meaning                                           |
| ----------------- | ------------------------------------------------- |
| Slipstream        | `pi-slipstream-compact` reviewed compaction path. |
| Native `/compact` | Pi's native compaction behavior.                  |

Method names were hidden from LLM judges by randomized candidate labels.

## Evaluation design

Two complementary evaluations were run.

### 1. Blinded continuation-review benchmark

LLM judges reviewed compacted handoffs against source evidence and estimated whether a fresh coding agent could continue correctly.

- Clean overlapping cases: 22.
- Judge replicates: 3 per case.
- Total decisions: 66.
- Candidate labels were randomized and method names hidden from judges.

### 2. Fresh-agent continuation validation

A no-tool fresh agent received a compacted handoff and produced a continuation response. A separate judge then scored that response against source evidence.

- Clean overlapping cases: 11.
- Scored dimensions included current-state preservation, next-action readiness, stale-state suppression, and continuation success.
- One candidate case was excluded because the evaluation runner did not produce a valid compaction output; this was treated as an execution issue, not a Slipstream rejection.

## Results

### Fresh-agent continuation validation

| Method            | Overall avg | Success rate | Stale-state score | Failure modes             |
| ----------------- | ----------: | -----------: | ----------------: | ------------------------- |
| Slipstream        |     9.36/10 |         1.00 |          10.00/10 | `none:11`                 |
| Native `/compact` |     5.36/10 |         0.45 |           5.18/10 | stale/latest-state issues |

### Blinded continuation-review benchmark

| Method            | Overall avg |  Wins |
| ----------------- | ----------: | ----: |
| Slipstream        |     9.00/10 | 64/66 |
| Native `/compact` |     5.36/10 |  1/66 |

The remaining judge decision was a tie.

### Focused rerun of weakest full-run case

A focused rerun was performed for the only full-run case with weak Slipstream judgments after tightening source preparation.

| Method            | Overall avg | Wins |
| ----------------- | ----------: | ---: |
| Slipstream        |     9.00/10 |  3/3 |
| Native `/compact` |     3.67/10 |  0/3 |

## Interpretation

The results support using Slipstream for long coding sessions where preserving exact current state matters more than minimizing compaction cost or latency. The largest observed advantage was stale-state suppression: Slipstream preserved current decisions, active files, failures, and next actions more reliably than native `/compact` in these continuation-readiness evaluations.

These benchmarks do not prove that Slipstream solves downstream coding tasks better end-to-end. They measure whether the compacted handoff remains usable for continuation.

## Limitations

- The corpus is partly private and cannot be fully published.
- LLM judging can be noisy even with blinded labels and multiple replicates.
- Fresh-agent validation used a no-tool agent, so it tested handoff comprehension rather than full tool-enabled task completion.
- The reported numbers are local validation results, not a public leaderboard score.
- Benchmark code and raw evaluation materials are available for review on request, but are not bundled in the npm package.
