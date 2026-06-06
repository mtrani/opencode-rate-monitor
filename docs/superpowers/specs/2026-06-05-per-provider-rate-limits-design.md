# Per-Provider/Model Rate Limits — Design Spec

**Date:** 2026-06-05
**Status:** Approved

---

## 1. Motivation

The current plugin enforces a single global `maxPerMinute` cap. Providers (Anthropic, OpenAI, etc.) publish different rate tiers per model (Sonnet vs Opus, GPT-4o vs GPT-4o-mini). The plugin needs hierarchical per-bucket limits so users can match real API constraints.

## 2. Config Schema

Backward compatible — no `rateLimits` → identical behaviour to today.

```typescript
type PluginOptions = {
  maxPerMinute?: number                    // global fallback (unchanged)
  rateLimits?: Record<string, number>      // bucket key → cap
}
```

| Key convention | Example | Means |
|---|---|---|
| `"global"` | `40` | All requests not matching a more specific key |
| `"provider:<name>"` | `"provider:anthropic"` | Any request from that provider |
| `"model:<provider/id>"` | `"model:anthropic/claude-sonnet-4-20250514"` | A specific model |

Lookup cascade: `model:...` → `provider:...` → `"global"` → unlimited (0).

Same config object is passed to both `rate-monitor.ts` (enforcement) and `rate-monitor-tui.tsx` (display).

## 3. Server Plugin — `rate-monitor.ts`

### 3.1 Bucket abstraction

Replace the module-level singleton state with a `Map<string, Bucket>`:

```typescript
interface Bucket {
  history: RequestRecord[]
  pendingQueue: Array<{ resolve: () => void }>
  queueDepth: number
  processingQueue: boolean
  maxPerMinute: number
}
```

Each bucket has its own sliding window, its own FIFO queue, and its own cap.

### 3.2 Bucket resolution

```typescript
function resolveBucket(providerID: string, modelID: string): string {
  const modelKey = `model:${providerID}/${modelID}`
  if (rateLimits.has(modelKey)) return modelKey
  const providerKey = `provider:${providerID}`
  if (rateLimits.has(providerKey)) return providerKey
  return "global"
}
```

The bucket is lazy-created on first access.

### 3.3 Throttle & drain

`throttle(bucketKey)` and `drainQueue(bucketKey)` — the same sliding-window logic as today, scoped to one bucket.

### 3.4 Hook

```typescript
"chat.params": async (input) => {
  const modelStr = `${input.model.providerID}/${input.model.id}`
  const bucketKey = resolveBucket(input.model.providerID, input.model.id)
  await throttle(bucketKey)

  getBucket(bucketKey).history.push({
    timestamp: Date.now(),
    sessionID: input.sessionID,
    agent: input.agent,
    model: modelStr,
  })
  state.totalRequests++
  publishStats()
}
```

### 3.5 Stats publishing

Debounced (≤1 Hz) publication via `client.tui.publish`:

```typescript
interface StatsPayload {
  totalRequests: number
  activeBucket: string              // last bucket that was throttled
  buckets: Array<{
    key: string
    label: string                   // human-readable: "Anthropic", "Claude Sonnet 4", "Global"
    recent: number                  // calls in last 60 s
    maxPerMinute: number
    queueDepth: number
  }>
}
```

The `activeBucket` field tells the TUI which bucket to highlight as the "current" one.

### 3.6 Notifications

Queue start/clear and periodic stats toasts include the bucket label:
- `"⏳ Anthropic rate limit hit — 5 queued (max 30/min)"`
- `"✅ Anthropic request queue cleared"`
- `"📊 Rate monitor: Anthropic 15 req/last min, Global 22 req/last min"`

## 4. TUI Plugin — `rate-monitor-tui.tsx`

### 4.1 Data flow

The TUI receives stats from the server instead of tracking independently:

```typescript
const off = props.api.event.on("rate-monitor.stats", (payload: StatsPayload) => {
  setStats(payload)
})
```

It keeps its 1-second interval timer but only for orchestrating the re-render.

### 4.2 Widget layout

The sidebar shows **only the active bucket**:

```
⚡ Rate Monitor  [Anthropic — Claude Sonnet 4]
██████████████████░░░░░░   (28 / 30 rpm)

Rate (last min)    28 / 30 rpm
Total requests     312
Queued             0
```

- Header shows the active bucket label
- Fill-bar reflects the active bucket's recent/max
- "Queued" row only appears when `queueDepth > 0`
- If no requests yet, shows the global bucket

A subtle secondary row can show other active buckets in muted text, collapsed by default.

### 4.3 Fill-bar colour

Same logic as today, scoped to `activeBucket`:

| % of cap | Colour |
|---|---|
| < 70 % | `theme.success` (green) |
| 70–89 % | `theme.warning` (yellow) |
| ≥ 90 % | `theme.error` (red) |

## 5. Edge cases

| Scenario | Behaviour |
|---|---|
| No `rateLimits` set | Single `"global"` bucket, identical to today |
| `rateLimits = {}` | All requests go to `"global"` with no cap (0) |
| Provider removed from map mid-session | Next request creates a `"global"` bucket entry |
| Same provider, different models, no model-specific rule | Both fall through to the provider bucket |
| TUI starts before server publishes | Widget shows `0 / N` until first stats payload arrives |
