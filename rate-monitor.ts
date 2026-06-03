/**
 * opencode-rate-monitor — server plugin
 *
 * Tracks every LLM request and enforces a configurable per-minute rate cap.
 * Requests that exceed the cap are queued and released as the window slides.
 *
 * Usage in opencode.json:
 *   { "plugin": [["./rate-monitor.ts", { "maxPerMinute": 40 }]] }
 *
 * Or as a local plugin (drop in .opencode/plugins/):
 *   No config needed — defaults to 40 req/min.
 *
 * The companion file rate-monitor-tui.tsx reads `sharedState` from this
 * module (same Bun process = same module cache) and renders a sidebar widget.
 */

import type { Plugin, PluginOptions } from "@opencode-ai/plugin"

// ─── Internal state ───────────────────────────────────────────────────────────
// Not exported — opencode calls every exported function as a plugin.

interface RequestRecord {
  timestamp: number
  sessionID: string
  agent: string
  model: string
}

const state = {
  maxPerMinute: 40,
  history: [] as RequestRecord[],
  totalRequests: 0,
  queueDepth: 0,
}

// ─── Internal rate-limiter ────────────────────────────────────────────────────

const ONE_MINUTE_MS = 60_000
const pendingQueue: Array<{ resolve: () => void }> = []
let processingQueue = false

/** Prune history older than 1 minute and return count in the last minute. */
function recentCount(): number {
  const cutoff = Date.now() - ONE_MINUTE_MS
  let i = 0
  while (i < state.history.length && state.history[i].timestamp < cutoff) i++
  if (i > 0) state.history.splice(0, i)
  return state.history.length
}

/** Drain the queue, releasing entries as the window has capacity. */
function drainQueue(): void {
  if (pendingQueue.length === 0) {
    processingQueue = false
    state.queueDepth = 0
    return
  }

  const current = recentCount()
  if (current < state.maxPerMinute) {
    const entry = pendingQueue.shift()!
    state.queueDepth = pendingQueue.length
    entry.resolve()
    drainQueue()
    return
  }

  const oldest = state.history[0]?.timestamp ?? Date.now()
  const waitMs = Math.max(50, oldest + ONE_MINUTE_MS - Date.now())
  setTimeout(drainQueue, waitMs)
}

/**
 * Block until there is capacity in the rate window.
 * Resolves immediately if under the cap or if the cap is disabled (0).
 */
async function throttle(): Promise<void> {
  if (state.maxPerMinute <= 0) return
  if (recentCount() < state.maxPerMinute) return

  state.queueDepth++
  return new Promise<void>((resolve) => {
    pendingQueue.push({ resolve })
    if (!processingQueue) {
      processingQueue = true
      drainQueue()
    }
  })
}

// ─── Plugin export (default — opencode calls default or iterates functions) ───

const RateMonitorPlugin: Plugin = async (ctx, options?: PluginOptions) => {
  if (typeof options?.maxPerMinute === "number") {
    state.maxPerMinute = options.maxPerMinute
  }

  const { client } = ctx

  /** Send a toast to the TUI — tries both SDK APIs, ignores errors. */
  function notify(message: string, variant: "info" | "warning" | "error" = "info") {
    try {
      const payload = { type: "tui.toast.show", data: { message, variant, duration: 4000 } }
      ;(client as any).tui?.publish?.(payload)
      ;(client as any).tui?.showToast?.({ message, variant, duration: 4000 })
    } catch {
      // ignore — TUI may not be attached
    }
  }

  let lastQueueDepth = 0

  return {
    /**
     * Fires before every LLM call.
     * Throttles if over the cap, then records the request.
     */
    "chat.params": async (input, _output) => {
      await throttle()

      state.history.push({
        timestamp: Date.now(),
        sessionID: input.sessionID,
        agent: input.agent,
        model: `${input.provider.info.id}/${input.model.id}`,
      })
      state.totalRequests++

      // Notify TUI when queue starts or clears
      if (state.queueDepth > 0 && lastQueueDepth === 0) {
        notify(`⏳ Rate limit hit — ${state.queueDepth} request(s) queued (max ${state.maxPerMinute}/min)`, "warning")
      } else if (state.queueDepth === 0 && lastQueueDepth > 0) {
        notify("✅ Request queue cleared", "info")
      }
      lastQueueDepth = state.queueDepth

      // Periodic stats toast every 10 requests
      if (state.totalRequests % 10 === 0) {
        const recent = recentCount()
        notify(`📊 Rate monitor: ${recent} req/last min · ${state.totalRequests} total`, "info")
      }
    },
  }
}

export default RateMonitorPlugin
