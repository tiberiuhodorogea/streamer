# Lumina Streaming Work Instructions

When changing streaming, transport, adaptation, tuning, validation, or profiling code in this repo:

- Inspect existing evidence first in logs/baselines and recent logs/sessions before changing thresholds or control logic.
- Treat smoothness as the primary product goal: stable frame pacing and fast recovery matter more than holding peak resolution.
- Do not remove or bypass logging when changing adaptation behavior. Extend logs instead so every new control input, decision, and outcome is traceable.
- When touching lumina-app/src/ui/app.js, signaling-server/src/index.js, or web-client/app.js, review both the raw JSONL logs and session.summary.json fields affected by the change.
- Prefer logging state transitions and decisions over ad hoc spam: bottleneck-viewer changes, health-state transitions, encoder stalls, source stalls, bitrate-allocation decisions, and recovery outcomes are especially important.
- Validate streaming claims against fresh session logs whenever possible. Compare new runs to the baselines under logs/baselines.
- Preserve multi-viewer fairness. Do not optimize only for a single viewer if the change can collapse room quality for everyone else.
- If you change thresholds, aggregation, or reporting cadence, update the related documentation and summaries so future tuning work stays evidence-based.