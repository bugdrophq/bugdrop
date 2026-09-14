# Screenshot Threshold Benchmark

Measures how long `html-to-image` takes to capture a full-page screenshot at
various DOM node counts. Used to determine the threshold at which the widget
should hide the Full Page and Select Area buttons (issue #101).

## Prerequisites

- Node.js 20+
- `npm install`
- `npm run build:widget` (the benchmark loads the real widget bundle)

## Running

```bash
npm run benchmark:screenshot
```

This starts `wrangler dev` automatically if it isn't already running, then runs
8 test cases (1k to 15k DOM nodes) sequentially in headless Chromium.

Takes ~2-5 minutes depending on your machine.

## Output

### Terminal (stdout)

A markdown table with machine info and per-node-count results:

```
## Screenshot Threshold Benchmark Results

**Machine:** Apple M2 Pro | 12 cores | 32 GB RAM | darwin 25.3.0 (arm64)

| Nodes (target) | Nodes (actual) | Duration (ms) | Outcome |
|---------------:|---------------:|--------------:|---------|
*Nodes (target) = requested via ?nodes=N; Nodes (actual) = total DOM nodes counted after generation*

|            1000 |           1107 |          1541 | success |
|            3000 |           3307 |          3328 | success |
|            7000 |           7707 |          5793 | success |
|           10000 |          11007 |          8031 | success |
|           15000 |          16507 |         11693 | success |
```

### JSON file

Saved to `benchmarks/results/screenshot-threshold-<timestamp>.json` (gitignored).
Includes machine specs so results from different contributors are comparable:

```json
{
  "timestamp": "2026-04-09T13:30:15.960Z",
  "machine": {
    "os": "darwin 25.3.0 (arm64)",
    "cpu": "Apple M2 Pro",
    "cores": 12,
    "ramGb": 32
  },
  "results": [
    { "nodes": 1000, "actualNodes": 1107, "durationMs": 1541, "outcome": "success" },
    { "nodes": 10000, "actualNodes": 11007, "durationMs": 8031, "outcome": "success" },
    { "nodes": 15000, "actualNodes": 16507, "durationMs": 60000, "outcome": "timeout" }
  ]
}
```

## Reading the results

**Columns:**

- **Nodes (target)** — the `?nodes=N` value passed to the test fixture
- **Nodes (actual)** — total DOM nodes counted after generation (slightly higher due to container divs, page chrome, and the widget itself)
- **Duration (ms)** — wall-clock time from clicking "Full Page" to either success or failure
- **Outcome** — `success` (annotation canvas appeared), `error` (widget showed error modal), or `timeout` (neither appeared within 60s — main thread froze)

**What to look for:**

The goal is to find where captures start failing or becoming unacceptably slow.
Look for the transition point in your results:

- **All `success`** — your machine handles these node counts fine. The threshold
  should be set _below_ the lowest node count that times out on _any_ contributor's
  machine.
- **`timeout` at high counts** — this is the signal. The node count just before the
  first `timeout` is the upper bound for that machine.
- **`error` outcomes** — the widget's 15s timeout fired (capture was slow but the
  event loop wasn't fully frozen). These are borderline cases.
- **Duration climbing steeply** — even if all outcomes are `success`, durations
  above ~5-8 seconds mean the user's browser is frozen for that long. That's a bad
  experience even if it technically succeeds.

## Sharing results

To help us pick the right threshold across different machines, share your JSON
file contents in [issue #101](https://github.com/bugdrophq/bugdrop/issues/101)
or a linked discussion. The machine info is included automatically.

## What it measures

Each test case:

1. Generates N DOM nodes on a test page (nested divs with styled leaf nodes)
2. Opens the BugDrop widget and triggers a full-page screenshot capture
3. Measures wall-clock time from the "Full Page" click to either:
   - **success** — annotation canvas appears (capture completed)
   - **error** — error modal appears (capture failed gracefully)
   - **timeout** — neither appeared within 60s (main thread frozen)

The widget's existing `pixelRatio` reduction kicks in automatically above 3,000
nodes, so results above that threshold reflect `pixelRatio: 1` behavior.
