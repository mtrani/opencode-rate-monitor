# Per-Provider/Model Rate Limits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hierarchical per-provider and per-model rate limits while keeping full backward compatibility.

**Architecture:** Replace the single global `state.history`/`pendingQueue` with a `Map<string, Bucket>`. Each bucket manages its own sliding window and queue. Server publishes per-bucket stats to the TUI, which renders only the active bucket.

**Tech Stack:** TypeScript, opencode plugin API, Solid.js (TUI), @opentui/solid (JSX)

---

### Task 1: Refactor server plugin to bucket architecture

**Files:**
- Modify: `rate-monitor.ts` (entire file)

- [ ] **Step 1: Rewrite rate-monitor.ts with bucket architecture**

```typescript
import type { Plugin, PluginOptions } from "@opencode-ai/plugin"

interface RequestRecord {
  timestamp: number
  sessionID: string
  agent: string
  model: string
}

interface Bucket {
  history: RequestRecord[]
  pendingQueue: Array<{ resolve: () => void }>
  queueDepth: number
  processingQueue: boolean
  maxPerMinute: number
}

interface PluginConfig {
  maxPerMinute: number
  rateLimits: Record<string, number>
}

// ─── State ────────────────────────────────────────────────────────────────────

const ONE_MINUTE_MS = 60_000

const state = {
  totalRequests: 0,
  buckets: new Map<string, Bucket>(),
  activeBucketKey: "global" as string,
}

function parseConfig(options?: PluginOptions): PluginConfig {
  const maxPerMinute = typeof options?.maxPerMinute === "number" ? options.maxPerMinute : 40
  const rateLimits: Record<string, number> = { ...options?.rateLimits }
  if (!("global" in rateLimits)) {
    rateLimits["global"] = maxPerMinute
  }
  return { maxPerMinute, rateLimits }
}

// ─── Bucket helpers ────────────────────────────────────────────────────────────

function getOrCreateBucket(key: string, maxPerMinute: number): Bucket {
  let b = state.buckets.get(key)
  if (!b) {
    b = { history: [], pendingQueue: [], queueDepth: 0, processingQueue: false, maxPerMinute }
    state.buckets.set(key, b)
  }
  return b
}

function recentCount(bucket: Bucket): number {
  const cutoff = Date.now() - ONE_MINUTE_MS
  let i = 0
  while (i < bucket.history.length && bucket.history[i].timestamp < cutoff) i++
  if (i > 0) bucket.history.splice(0, i)
  return bucket.history.length
}

function drainQueue(bucket: Bucket): void {
  if (bucket.pendingQueue.length === 0) {
    bucket.processingQueue = false
    bucket.queueDepth = 0
    return
  }

  const current = recentCount(bucket)
  if (current < bucket.maxPerMinute) {
    const entry = bucket.pendingQueue.shift()!
    bucket.queueDepth = bucket.pendingQueue.length
    entry.resolve()
    drainQueue(bucket)
    return
  }

  const oldest = bucket.history[0]?.timestamp ?? Date.now()
  const waitMs = Math.max(50, oldest + ONE_MINUTE_MS - Date.now())
  setTimeout(() => drainQueue(bucket), waitMs)
}

async function throttle(bucket: Bucket): Promise<void> {
  if (bucket.maxPerMinute <= 0) return
  if (recentCount(bucket) < bucket.maxPerMinute) return

  bucket.queueDepth++
  return new Promise<void>((resolve) => {
    bucket.pendingQueue.push({ resolve })
    if (!bucket.processingQueue) {
      bucket.processingQueue = true
      drainQueue(bucket)
    }
  })
}

function resolveBucketKey(providerID: string, modelID: string, config: PluginConfig): string {
  const modelKey = `model:${providerID}/${modelID}`
  if (modelKey in config.rateLimits) return modelKey
  const providerKey = `provider:${providerID}`
  if (providerKey in config.rateLimits) return providerKey
  return "global"
}

function bucketLabel(key: string): string {
  if (key === "global") return "Global"
  if (key.startsWith("provider:")) {
    const name = key.slice("provider:".length)
    return name.charAt(0).toUpperCase() + name.slice(1)
  }
  if (key.startsWith("model:")) {
    const parts = key.slice("model:".length).split("/")
    return parts.length > 1 ? parts[1] : parts[0]
  }
  return key
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit rate-monitor.ts --skipLibCheck --moduleResolution bundler --target esnext --module esnext`
Expected: No errors (or minimal TS errors we can —skipLibCheck through)

**Note:** If `tsc` isn't available or the plugin uses opencode's internal types, just verify logical correctness — these plugins are loaded by opencode's Bun runtime, not compiled standalone.

---

### Task 2: Add stats publishing to server plugin

**Files:**
- Modify: `rate-monitor.ts`

- [ ] **Step 1: Add stats payload type and publishStats function**

Insert after the bucket helpers, before the plugin export:

```typescript
interface BucketStats {
  key: string
  label: string
  recent: number
  maxPerMinute: number
  queueDepth: number
}

interface StatsPayload {
  totalRequests: number
  activeBucket: string
  activeLabel: string
  buckets: BucketStats[]
}

let publishTimer: ReturnType<typeof setTimeout> | null = null

function publishStats(client: any, config: PluginConfig): void {
  if (publishTimer) return
  publishTimer = setTimeout(() => {
    publishTimer = null
    const now = Date.now()
    const cutoff = now - ONE_MINUTE_MS
    // Pass config to access rateLimits for maxPerMinute lookups
    const bucketStats: BucketStats[] = []
    for (const [key, bucket] of state.buckets) {
      const max = key in config.rateLimits ? config.rateLimits[key] : config.maxPerMinute
      // Count recent from history without side-effect (don't prune here — throttle handles that)
      const recent = bucket.history.filter(r => r.timestamp >= cutoff).length
      bucketStats.push({
        key,
        label: bucketLabel(key),
        recent,
        maxPerMinute: max,
        queueDepth: bucket.queueDepth,
      })
    }

    const active = state.activeBucketKey
    const payload: StatsPayload = {
      totalRequests: state.totalRequests,
      activeBucket: active,
      activeLabel: bucketLabel(active),
      buckets: bucketStats,
    }

    try {
      ;(client as any).tui?.publish?.({ type: "rate-monitor.stats", data: payload })
    } catch {
      // TUI may not be attached
    }
  }, 200) // debounce 200ms
}
```

- [ ] **Step 2: Add per-bucket label to notifications**

Replace the notification logic in the chat.params handler to use labeled messages:

```typescript
// In the per-bucket queue tracking, replace literal strings with label-aware:
const label = bucketLabel(bucketKey)
// ⏳ {label} rate limit hit — N queued (max M/min)
// ✅ {label} request queue cleared
// 📊 Rate monitor: {label} N req/last min ... total
```

---

### Task 3: Wire everything together in the chat.params hook

**Files:**
- Modify: `rate-monitor.ts`

- [ ] **Step 1: Rewrite the plugin export to use buckets**

```typescript
const RateMonitorPlugin: Plugin = async (ctx, options?: PluginOptions) => {
  const config = parseConfig(options)
  const { client } = ctx

  function notify(message: string, variant: "info" | "warning" | "error" = "info") {
    try {
      const payload = { type: "tui.toast.show", data: { message, variant, duration: 4000 } }
      ;(client as any).tui?.publish?.(payload)
      ;(client as any).tui?.showToast?.({ message, variant, duration: 4000 })
    } catch {
      // ignore
    }
  }

  // Track last-known queue depth per bucket for notification gating
  const lastQueueDepth = new Map<string, number>()
  let lastTotalForStats = 0

  return {
    "chat.params": async (input, _output) => {
      const bucketKey = resolveBucketKey(input.model.providerID, input.model.id, config)
      state.activeBucketKey = bucketKey

      const bucketMax = bucketKey in config.rateLimits ? config.rateLimits[bucketKey] : config.maxPerMinute
      const bucket = getOrCreateBucket(bucketKey, bucketMax)
      await throttle(bucket)

      bucket.history.push({
        timestamp: Date.now(),
        sessionID: input.sessionID,
        agent: input.agent,
        model: `${input.model.providerID}/${input.model.id}`,
      })
      state.totalRequests++

      const label = bucketLabel(bucketKey)

      // Queue start / clear notifications per bucket
      const prevDepth = lastQueueDepth.get(bucketKey) ?? 0
      if (bucket.queueDepth > 0 && prevDepth === 0) {
        notify(`⏳ ${label} rate limit hit — ${bucket.queueDepth} request(s) queued (max ${bucketMax}/min)`, "warning")
      } else if (bucket.queueDepth === 0 && prevDepth > 0) {
        notify(`✅ ${label} request queue cleared`, "info")
      }
      lastQueueDepth.set(bucketKey, bucket.queueDepth)

      // Periodic stats toast every 10 requests
      if (state.totalRequests % 10 === 0 && state.totalRequests !== lastTotalForStats) {
        lastTotalForStats = state.totalRequests
        const summary = Array.from(state.buckets.entries())
          .filter(([_, b]) => b.history.length > 0)
          .map(([k, b]) => {
            const cutoff = Date.now() - ONE_MINUTE_MS
            const recent = b.history.filter(r => r.timestamp >= cutoff).length
            return `${bucketLabel(k)}: ${recent} req/last min`
          })
          .join(", ")
        notify(`📊 Rate monitor: ${summary} · ${state.totalRequests} total`, "info")
      }

      publishStats(client, config)
    },
  }
}

export const server = RateMonitorPlugin
```

---

### Task 4: Rewrite TUI plugin to receive stats from server

**Files:**
- Modify: `rate-monitor-tui.tsx` (entire file)

- [ ] **Step 1: Replace rate-monitor-tui.tsx**

```typescript
/** @jsxImportSource @opentui/solid */
// @ts-nocheck — opentui JSX types are not shipped as standard TS declarations.

import { createSignal, onCleanup, createMemo, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiThemeCurrent } from "@opencode-ai/plugin/tui"

// ─── Stats types (mirrors server payload) ──────────────────────────────────────

interface BucketStats {
  key: string
  label: string
  recent: number
  maxPerMinute: number
  queueDepth: number
}

interface StatsPayload {
  totalRequests: number
  activeBucket: string
  activeLabel: string
  buckets: BucketStats[]
}

// ─── Sub-components ───────────────────────────────────────────────────────────

const StatRow = (props: { theme: TuiThemeCurrent; label: string; value: string; color?: string }) => (
  <box width="100%" flexDirection="row" justifyContent="space-between">
    <text fg={props.theme.textMuted}>{props.label}</text>
    <text fg={props.color ?? props.theme.text}>
      <b>{props.value}</b>
    </text>
  </box>
)

const FillBar = (props: { theme: TuiThemeCurrent; value: number; max: number; color: string }) => {
  const safeMax = () => Math.max(1, props.max)
  const filled = () => Math.min(props.value, safeMax())
  const empty = () => safeMax() - filled()
  return (
    <box width="100%" flexDirection="row" height={1}>
      <Show when={filled() > 0}>
        <box flexGrow={filled()} flexBasis={0} height={1} backgroundColor={props.color} />
      </Show>
      <Show when={empty() > 0}>
        <box flexGrow={empty()} flexBasis={0} height={1} backgroundColor={props.theme.backgroundElement} />
      </Show>
    </box>
  )
}

// ─── Main widget ──────────────────────────────────────────────────────────────

const RateMonitorWidget = (props: { api: TuiPluginApi; theme: TuiThemeCurrent; maxPerMinute: number }) => {
  const [stats, setStats] = createSignal<StatsPayload>({
    totalRequests: 0,
    activeBucket: "global",
    activeLabel: "Global",
    buckets: [],
  })

  // Receive stats from the server plugin
  const off = props.api.event.on("rate-monitor.stats", (event: any) => {
    const payload = event?.data ?? event
    if (payload?.buckets) {
      setStats(payload as StatsPayload)
    }
  })

  // Fallback: if no server stats arrive, render empty state
  // The 1s interval only re-renders reactively — data comes from server

  onCleanup(() => {
    off()
  })

  const activeBucket = createMemo(() => {
    const s = stats()
    const active = s.buckets.find(b => b.key === s.activeBucket)
    return active ?? { key: "global", label: "Global", recent: 0, maxPerMinute: s.buckets[0]?.maxPerMinute ?? props.maxPerMinute, queueDepth: 0 }
  })

  const barColor = createMemo(() => {
    const { recent, maxPerMinute } = activeBucket()
    if (maxPerMinute <= 0) return "green"
    const pct = recent / maxPerMinute
    if (pct >= 0.9) return "red"
    if (pct >= 0.7) return "yellow"
    return "green"
  })

  const rpmLabel = createMemo(() => {
    const { recent, maxPerMinute } = activeBucket()
    return maxPerMinute > 0 ? `${recent} / ${maxPerMinute} rpm` : `${recent} rpm`
  })

  const hasQueue = createMemo(() => activeBucket().queueDepth > 0)

  return (
    <box width="100%" flexDirection="column" paddingTop={1} paddingLeft={1} paddingRight={1}>
      <box width="100%" marginBottom={1}>
        <text fg={props.theme.accent}>
          <b>⚡ Rate Monitor</b>
        </text>
      </box>

      <Show when={stats().totalRequests > 0}>
        <box width="100%" marginBottom={1}>
          <text fg={props.theme.textMuted}>
            {activeBucket().label}
          </text>
        </box>
      </Show>

      <FillBar
        theme={props.theme}
        value={activeBucket().recent}
        max={activeBucket().maxPerMinute > 0 ? activeBucket().maxPerMinute : Math.max(activeBucket().recent, 1)}
        color={barColor()}
      />

      <box width="100%" flexDirection="column" marginTop={1}>
        <StatRow theme={props.theme} label="Rate (last min)" value={rpmLabel()} color={barColor()} />
        <StatRow theme={props.theme} label="Total requests" value={String(stats().totalRequests)} />
      </box>

      <Show when={hasQueue()}>
        <box width="100%" marginTop={1}>
          <text fg={props.theme.warning}>
            <b>Queued: {activeBucket().queueDepth}</b>
          </text>
        </box>
      </Show>
    </box>
  )
}

// ─── TUI plugin entry point ───────────────────────────────────────────────────

const tui: TuiPlugin = async (api, options) => {
  const maxPerMinute = typeof options?.maxPerMinute === "number" ? options.maxPerMinute : 40

  api.slots.register({
    order: 600,
    slots: {
      sidebar_content(ctx) {
        return (
          <RateMonitorWidget
            api={api}
            theme={ctx.theme.current}
            maxPerMinute={maxPerMinute}
          />
        )
      },
    },
  })
}

export default { id: "rate-monitor-tui", tui }
```

---

### Task 5: Self-review and final verification

- [ ] **Step 1: Review plan against spec**

Check each spec section against the plan:
- Config schema (§2) → Task 1 (parseConfig), Task 2 (rateLimits in publishStats)
- Bucket abstraction (§3.1) → Task 1
- Bucket resolution (§3.2) → Task 1 (resolveBucketKey)
- Throttle & drain (§3.3) → Task 1
- Hook (§3.4) → Task 3
- Stats publishing (§3.5) → Task 2
- Notifications (§3.6) → Task 3 (per-bucket labels)
- TUI data flow (§4.1) → Task 4
- TUI widget layout (§4.2) → Task 4
- TUI fill-bar colour (§4.3) → Task 4
- Edge cases (§5) → implicit: empty rateLimits means global bucket with maxPerMinute; lazy bucket creation handles new keys

- [ ] **Step 2: Verify final files**

Files modified:
```
rate-monitor.ts       — bucket architecture, stats publishing, per-bucket notifications
rate-monitor-tui.tsx  — receives server stats, shows active bucket widget
```

- [ ] **Step 3: Commit**

```bash
git add rate-monitor.ts rate-monitor-tui.tsx docs/superpowers/specs/2026-06-05-per-provider-rate-limits-design.md docs/superpowers/plans/2026-06-05-per-provider-rate-limits.md
git commit -m "feat: per-provider and per-model rate limits"
```
