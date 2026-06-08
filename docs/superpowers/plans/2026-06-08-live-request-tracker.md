# Live Request Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every in-flight LLM request in the sidebar — attributed to its agent/sub-agent — with a live queued → active → done lifecycle state.

**Architecture:** The server plugin (`rate-monitor.ts`) generates a UUID per request and publishes three custom events (`rate-monitor.request.queued`, `rate-monitor.request.active`, `rate-monitor.request.done`) via `client.tui.publish` as the request moves through its lifecycle. The TUI plugin (`rate-monitor-tui.tsx`) subscribes to these events, drives a reactive `Map<requestID, RequestEntry>` signal, and renders a `LiveRequestsPanel` component below the existing fill-bar/stats section.

**Tech Stack:** TypeScript, Solid.js / `@opentui/solid`, opencode plugin SDK (`@opencode-ai/plugin`)

---

## File Map

| File | Change |
|---|---|
| `rate-monitor.ts` | Add `requestID` generation, `pendingBySession` map, three `client.tui.publish` calls, new `chat.message` hook |
| `rate-monitor-tui.tsx` | Add `RequestEntry` type, `liveRequests` signal, `tick` signal, three event subscriptions, `LiveRequestsPanel` component |

---

### Task 1: Create feature branch

**Files:**
- No file changes — git only

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b feature/live-request-tracker
```

Expected: `Switched to a new branch 'feature/live-request-tracker'`

- [ ] **Step 2: Verify branch**

```bash
git branch
```

Expected: `* feature/live-request-tracker` shown with asterisk.

---

### Task 2: Add `RequestEntry` type and module-level state to server plugin

**Files:**
- Modify: `rate-monitor.ts` (Types section, lines 12–32; State section, lines 34–42)

The server needs two additions before any logic changes:
1. A new interface `RequestEntry` to describe the payload sent in events
2. A new `pendingBySession` map (module-level) that correlates `sessionID → requestID[]` so the `chat.message` hook can find which request to mark done

- [ ] **Step 1: Add `RequestEntry` interface to the Types section**

In `rate-monitor.ts`, after line 32 (end of `interface PluginConfig`), add:

```typescript
interface RequestEntry {
  requestID: string
  sessionID: string
  agent: string
  model: string
  providerID: string
  queuedAt: number
}
```

- [ ] **Step 2: Add `pendingBySession` to the State section**

In `rate-monitor.ts`, after line 42 (end of `const state = { ... }`), add:

```typescript
// Maps sessionID → FIFO queue of requestIDs awaiting a chat.message completion
const pendingBySession = new Map<string, string[]>()
```

- [ ] **Step 3: Verify TypeScript parses cleanly (no errors introduced)**

```bash
cd /home/mtrani/dev/opencode-rate-monitor && bunx tsc --noEmit rate-monitor.ts 2>&1 | head -20
```

Expected: No output (no errors). If tsc is not available, skip — Bun will catch errors at runtime.

- [ ] **Step 4: Commit**

```bash
git add rate-monitor.ts
git commit -m "feat(server): add RequestEntry type and pendingBySession map"
```

---

### Task 3: Instrument `chat.params` hook to publish lifecycle events

**Files:**
- Modify: `rate-monitor.ts` (`chat.params` hook, lines 148–186)

Replace the existing `chat.params` hook body with a version that:
1. Generates a `requestID` before throttling
2. Publishes `rate-monitor.request.queued` immediately
3. Awaits `throttle(bucket)` (unchanged)
4. Publishes `rate-monitor.request.active` after throttle resolves
5. Pushes `requestID` onto `pendingBySession` for later correlation
6. Then proceeds with the existing history/stats/toast logic (unchanged)

- [ ] **Step 1: Replace the `chat.params` hook body**

In `rate-monitor.ts`, replace the entire `"chat.params": async (input, _output) => { ... }` block (lines 148–186) with:

```typescript
    "chat.params": async (input, _output) => {
      const bucketKey = resolveBucketKey(input.model.providerID, input.model.id, config)
      state.activeBucketKey = bucketKey

      const bucketMax = bucketKey in config.rateLimits ? config.rateLimits[bucketKey] : config.maxPerMinute
      const bucket = getOrCreateBucket(bucketKey, bucketMax)

      // ── Live request tracking ────────────────────────────────────────────
      const requestID = crypto.randomUUID()
      const entry: RequestEntry = {
        requestID,
        sessionID: input.sessionID,
        agent: input.agent ?? "unknown",
        model: input.model.id,
        providerID: input.model.providerID,
        queuedAt: Date.now(),
      }

      try {
        ;(client as any).tui?.publish?.({
          type: "rate-monitor.request.queued",
          properties: entry,
        })
      } catch { /* ignore */ }

      await throttle(bucket)

      try {
        ;(client as any).tui?.publish?.({
          type: "rate-monitor.request.active",
          properties: { requestID, activeAt: Date.now() },
        })
      } catch { /* ignore */ }

      // Register for done correlation (FIFO per session)
      const queue = pendingBySession.get(input.sessionID) ?? []
      queue.push(requestID)
      pendingBySession.set(input.sessionID, queue)
      // ── End live request tracking ────────────────────────────────────────

      bucket.history.push({
        timestamp: Date.now(),
        sessionID: input.sessionID,
        agent: input.agent,
        model: `${input.model.providerID}/${input.model.id}`,
      })
      state.totalRequests++

      const label = bucketLabel(bucketKey)

      const prevDepth = lastQueueDepth.get(bucketKey) ?? 0
      if (bucket.queueDepth > 0 && prevDepth === 0) {
        notify(`⏳ ${label} rate limit hit — ${bucket.queueDepth} request(s) queued (max ${bucketMax}/min)`, "warning")
      } else if (bucket.queueDepth === 0 && prevDepth > 0) {
        notify(`✅ ${label} request queue cleared`, "info")
      }
      lastQueueDepth.set(bucketKey, bucket.queueDepth)

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
    },
```

- [ ] **Step 2: Commit**

```bash
git add rate-monitor.ts
git commit -m "feat(server): publish queued/active events from chat.params hook"
```

---

### Task 4: Add `chat.message` hook to publish `done` events

**Files:**
- Modify: `rate-monitor.ts` (the returned hooks object, after `chat.params`)

The `chat.message` hook fires when opencode creates an assistant message for a session. We use this to mark the oldest pending request for that session as done.

- [ ] **Step 1: Add `chat.message` hook to the returned hooks object**

In `rate-monitor.ts`, in the `return { ... }` block after the `"chat.params"` entry (around line 187), add:

```typescript
    "chat.message": async (input) => {
      const queue = pendingBySession.get(input.sessionID)
      if (!queue || queue.length === 0) return

      const requestID = queue.shift()!
      if (queue.length === 0) pendingBySession.delete(input.sessionID)

      try {
        ;(client as any).tui?.publish?.({
          type: "rate-monitor.request.done",
          properties: { requestID, doneAt: Date.now() },
        })
      } catch { /* ignore */ }
    },
```

- [ ] **Step 2: Commit**

```bash
git add rate-monitor.ts
git commit -m "feat(server): publish done event from chat.message hook"
```

---

### Task 5: Add `RequestEntry` type and reactive state to TUI plugin

**Files:**
- Modify: `rate-monitor-tui.tsx` (Types section, imports, `RateMonitorWidget` body)

- [ ] **Step 1: Add `RequestEntry` interface after the imports (after line 15)**

In `rate-monitor-tui.tsx`, after the import lines, add:

```typescript
// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestEntry {
  requestID: string
  sessionID: string
  agent: string
  model: string
  providerID: string
  state: "queued" | "active" | "done"
  queuedAt: number
  activeAt?: number
  doneAt?: number
}
```

- [ ] **Step 2: Commit**

```bash
git add rate-monitor-tui.tsx
git commit -m "feat(tui): add RequestEntry type"
```

---

### Task 6: Add `LiveRequestsPanel` component to TUI plugin

**Files:**
- Modify: `rate-monitor-tui.tsx` (Sub-components section, before `RateMonitorWidget`)

- [ ] **Step 1: Add `LiveRequestsPanel` component after the `FillBar` component (after line 42)**

In `rate-monitor-tui.tsx`, after the `FillBar` component definition (after the closing `}` on line ~42), add:

```typescript
const LiveRequestsPanel = (props: {
  theme: TuiThemeCurrent
  requests: Map<string, RequestEntry>
  tick: number  // read in elapsed() to force re-render every second — do not remove
}) => {
  const entries = () => Array.from(props.requests.values())

  const stateIcon = (s: RequestEntry["state"]) => {
    if (s === "queued") return "●"
    if (s === "active") return "◉"
    return "✓"
  }

  const stateColor = (s: RequestEntry["state"], theme: TuiThemeCurrent) => {
    if (s === "queued") return theme.warning
    if (s === "active") return theme.accent
    return theme.textMuted
  }

  const elapsed = (entry: RequestEntry) => {
    if (entry.state !== "active" || !entry.activeAt) return ""
    const secs = Math.floor((Date.now() - entry.activeAt) / 1000)
    return ` ${secs}s`
  }

  return (
    <Show when={entries().length > 0}>
      <box width="100%" marginTop={1}>
        <text fg={props.theme.textMuted}>
          <b>Live Requests</b>
        </text>
      </box>
      <For each={entries()}>
        {(entry) => (
          <box width="100%" flexDirection="row" gap={1}>
            <text fg={stateColor(entry.state, props.theme)}>
              {stateIcon(entry.state)}
            </text>
            <text fg={stateColor(entry.state, props.theme)}>
              {entry.agent ?? "unknown"}
            </text>
            <text fg={props.theme.textMuted}>
              {entry.providerID}/{entry.model}{elapsed(entry)}
            </text>
          </box>
        )}
      </For>
    </Show>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add rate-monitor-tui.tsx
git commit -m "feat(tui): add LiveRequestsPanel component"
```

---

### Task 7: Wire event subscriptions and signals into `RateMonitorWidget`

**Files:**
- Modify: `rate-monitor-tui.tsx` (`RateMonitorWidget` body and JSX return)

- [ ] **Step 1: Add `liveRequests` and `tick` signals at the top of `RateMonitorWidget`**

In `rate-monitor-tui.tsx`, inside `RateMonitorWidget`, after the existing signal declarations (after line ~60, where `createSignal` for `stats` is declared), add:

```typescript
  const [liveRequests, setLiveRequests] = createSignal<Map<string, RequestEntry>>(new Map())
  const [tick, setTick] = createSignal(0)
```

- [ ] **Step 2: Add the three event subscriptions inside `RateMonitorWidget`**

After the existing `const offMsg = props.api.event.on("message.updated", ...)` block (after line ~75), add:

```typescript
  // Live request lifecycle events from the server plugin
  const offQueued = props.api.event.on("rate-monitor.request.queued", (event: any) => {
    const p = event?.properties
    if (!p?.requestID) return
    setLiveRequests((prev) => {
      const next = new Map(prev)
      next.set(p.requestID, {
        requestID: p.requestID,
        sessionID: p.sessionID,
        agent: p.agent ?? "unknown",
        model: p.model,
        providerID: p.providerID,
        state: "queued",
        queuedAt: p.queuedAt ?? Date.now(),
      })
      return next
    })
  })

  const offActive = props.api.event.on("rate-monitor.request.active", (event: any) => {
    const p = event?.properties
    if (!p?.requestID) return
    setLiveRequests((prev) => {
      const next = new Map(prev)
      const existing = next.get(p.requestID)
      if (existing) {
        next.set(p.requestID, { ...existing, state: "active", activeAt: p.activeAt ?? Date.now() })
      }
      return next
    })
  })

  const offDone = props.api.event.on("rate-monitor.request.done", (event: any) => {
    const p = event?.properties
    if (!p?.requestID) return
    setLiveRequests((prev) => {
      const next = new Map(prev)
      const existing = next.get(p.requestID)
      if (existing) {
        next.set(p.requestID, { ...existing, state: "done", doneAt: p.doneAt ?? Date.now() })
      }
      return next
    })
    // Remove done entry after 2.5 seconds
    setTimeout(() => {
      setLiveRequests((prev) => {
        const next = new Map(prev)
        next.delete(p.requestID)
        return next
      })
    }, 2500)
  })
```

- [ ] **Step 3: Add tick interval and cleanup**

In the existing `setInterval` that drives the stats refresh (around line 78), extend the handler to also increment `tick`. Replace:

```typescript
  const handle = setInterval(() => {
    const now = Date.now()
```

with:

```typescript
  const handle = setInterval(() => {
    setTick((t) => t + 1)
    const now = Date.now()
```

In `onCleanup`, add the three new unsubscribe calls. Replace:

```typescript
  onCleanup(() => {
    clearInterval(handle)
    offMsg()
  })
```

with:

```typescript
  onCleanup(() => {
    clearInterval(handle)
    offMsg()
    offQueued()
    offActive()
    offDone()
  })
```

- [ ] **Step 4: Add `LiveRequestsPanel` to the JSX return**

In `RateMonitorWidget`'s JSX return, after the `</Show>` that closes the sessions section (around line 154), add:

```tsx
      <LiveRequestsPanel
        theme={props.theme}
        requests={liveRequests()}
        tick={tick()}
      />
```

- [ ] **Step 5: Commit**

```bash
git add rate-monitor-tui.tsx
git commit -m "feat(tui): wire live request event subscriptions and render panel"
```

---

### Task 8: Manual smoke test

**Files:**
- No changes — verification only

This plugin requires a running opencode instance with the plugins installed. Do the following manual verification steps:

- [ ] **Step 1: Verify the files look syntactically correct**

```bash
cd /home/mtrani/dev/opencode-rate-monitor && bunx tsc --noEmit --jsx react-jsx --jsxImportSource @opentui/solid rate-monitor-tui.tsx 2>&1 | head -30
```

Due to `@ts-nocheck` at the top of the TUI file, tsc will skip it. That is expected.

For the server plugin:

```bash
cd /home/mtrani/dev/opencode-rate-monitor && bunx tsc --noEmit rate-monitor.ts 2>&1 | head -30
```

Expected: no errors (or only missing-type-declaration warnings from Bun's module resolver, which are benign).

- [ ] **Step 2: Copy updated plugins to the global config directory**

```bash
cp /home/mtrani/dev/opencode-rate-monitor/rate-monitor.ts ~/.config/opencode/plugins/rate-monitor.ts
cp /home/mtrani/dev/opencode-rate-monitor/rate-monitor-tui.tsx ~/.config/opencode/plugins/rate-monitor-tui.tsx
```

- [ ] **Step 3: Restart opencode and observe**

Restart opencode. Trigger at least one LLM request (send a message to any session). You should see in the sidebar:

```
Live Requests
◉ main    anthropic/claude-sonnet-4-20250514  3s
```

The entry should linger briefly as "done" (✓, dimmed) after the response arrives, then disappear.

- [ ] **Step 4: Commit final state**

```bash
cd /home/mtrani/dev/opencode-rate-monitor
git add -A
git commit -m "chore: verify live request tracker works end-to-end"
```

---

### Task 9: Push feature branch

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/live-request-tracker
```
