# Live Request Tracker — Design Spec

**Date:** 2026-06-08  
**Branch:** `feature/live-request-tracker`  
**Status:** Approved

---

## Problem

When multiple agents and sub-agents are running concurrently, it is not clear from the TUI whether a given agent is:
- blocked waiting in the rate-limiter queue
- actively waiting for a response from the LLM server
- done

The current sidebar widget shows aggregate RPM and queue depth, but gives no per-request visibility. Users cannot tell which agent sent which request or what state it is in.

---

## Goal

Extend the existing rate monitor sidebar widget with a **Live Requests** panel that shows every in-flight LLM request in real time, attributed to its agent/sub-agent, with a clear lifecycle state: **queued → active → done**.

---

## Data Model

Each LLM request is represented by a `RequestEntry`:

```typescript
interface RequestEntry {
  requestID: string        // UUID generated at chat.params entry
  sessionID: string        // from chat.params input
  agent: string            // from chat.params input (e.g. "main", "subagent-1")
  model: string            // modelID (e.g. "claude-sonnet-4-20250514")
  providerID: string       // providerID (e.g. "anthropic")
  state: "queued" | "active" | "done"
  queuedAt: number         // Date.now() when queued event fired
  activeAt?: number        // Date.now() when active event fired
  doneAt?: number          // Date.now() when done event fired
}
```

---

## Lifecycle State Machine

```
chat.params fires
      │
      ▼
  [queued]  ──── throttle() holds promise ────►  rate limiter queue
      │
      │  throttle() resolves
      ▼
  [active]  ──── LLM call in flight ──────────►  waiting for response
      │
      │  chat.message hook fires for sessionID
      ▼
  [done]    ──── linger 2.5 seconds ──────────►  removed from display
```

**Note on "done" detection:** The `chat.message` hook fires when an assistant message is *created* (start of streaming), not when streaming completes. This is the best available signal in the current SDK. Correlation is FIFO per session: the oldest pending `requestID` for a given `sessionID` is marked done first.

---

## Server Plugin Changes (`rate-monitor.ts`)

### New custom event types published via `client.tui.publish`

> **Implementation note:** The existing code uses `(client as any).tui?.publish?.()` as a defensive cast (the typed API shape varies by opencode version). The same pattern must be used for these new events.

| Event type | Payload |
|---|---|
| `"rate-monitor.request.queued"` | `{ requestID, sessionID, agent, model, providerID, queuedAt }` |
| `"rate-monitor.request.active"` | `{ requestID, activeAt }` |
| `"rate-monitor.request.done"` | `{ requestID, doneAt }` |

### `chat.params` hook changes

1. Generate `requestID = crypto.randomUUID()` at hook entry
2. Publish `rate-monitor.request.queued` immediately with full metadata
3. After `await throttle(bucket)` resolves, publish `rate-monitor.request.active`
4. Push `requestID` onto a per-session FIFO queue in a new module-level `Map<string, string[]>` (`pendingBySession`)

### New `chat.message` hook

1. On each invocation, look up `pendingBySession.get(sessionID)`
2. Shift the oldest `requestID` from the array
3. Publish `rate-monitor.request.done` with `{ requestID, doneAt: Date.now() }`
4. Clean up empty arrays from the map

### New module-level state

```typescript
const pendingBySession = new Map<string, string[]>()  // sessionID → requestID[]
```

No changes to rate limiting logic, bucket structures, toast logic, or config.

---

## TUI Plugin Changes (`rate-monitor-tui.tsx`)

### New reactive state

```typescript
const [liveRequests, setLiveRequests] = createSignal<Map<string, RequestEntry>>(new Map())
const [tick, setTick] = createSignal(0)  // 1-second pulse for elapsed time display
```

### Event subscriptions (added in `tui()` init)

```typescript
api.event.on("rate-monitor.request.queued", (e) => {
  // add new RequestEntry with state "queued"
})
api.event.on("rate-monitor.request.active", (e) => {
  // update existing entry state to "active", set activeAt
})
api.event.on("rate-monitor.request.done", (e) => {
  // update existing entry state to "done", set doneAt
  // schedule removal via setTimeout(2500)
})
```

### Elapsed-time ticker

A `setInterval(1000)` increments `tick` signal to force re-render of active row durations. Cleaned up via `onCleanup`.

### New `LiveRequestsPanel` component

Added inside `RateMonitorWidget`, below the existing fill-bar and stats section. Hidden when no live requests exist.

**Row format:**

```
● queued    main           anthropic/claude-sonnet
◉ active    subagent-1     anthropic/claude-sonnet   12s
✓ done      subagent-2     anthropic/claude-sonnet
```

**State indicators and colours:**

| State | Symbol | Colour |
|---|---|---|
| `queued` | `●` | `theme.warning` (yellow) |
| `active` | `◉` | `theme.accent` (green/blue) |
| `done` | `✓` | `theme.textMuted` (dimmed) |

- Active rows show elapsed seconds since `activeAt` (driven by `tick`)
- Done rows show no elapsed time; disappear after 2.5 seconds
- Section hidden entirely when `liveRequests().size === 0`

---

## Out of Scope

- No changes to rate limiting logic
- No new config options
- No changes to fill-bar, RPM stats, or toast notifications
- No persistence — state is in-memory only, resets on restart
- No stream-completion detection (not available in current SDK)

---

## Files Changed

| File | Nature of change |
|---|---|
| `rate-monitor.ts` | Add `requestID` generation, three event publishes, `chat.message` hook, `pendingBySession` map |
| `rate-monitor-tui.tsx` | Add three event subscriptions, `liveRequests` signal, `tick` signal, `LiveRequestsPanel` component |
