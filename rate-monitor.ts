/**
 * opencode-rate-monitor — server plugin
 *
 * Tracks every LLM request and enforces configurable per-minute rate caps.
 *
 * Usage in opencode.json:
 *   { "plugin": [["./rate-monitor.ts", { "maxPerMinute": 40 }]] }
 */

import type { Plugin, PluginOptions } from "@opencode-ai/plugin"

// ─── Types ───────────────────────────────────────────────────────────────────

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

interface RequestEntry {
  requestID: string
  sessionID: string
  agent: string
  model: string
  providerID: string
  queuedAt: number
}

// ─── State ────────────────────────────────────────────────────────────────────

const ONE_MINUTE_MS = 60_000

const state = {
  totalRequests: 0,
  buckets: new Map<string, Bucket>(),
  activeBucketKey: "global" as string,
}

// Maps sessionID → FIFO queue of requestIDs awaiting a chat.message completion
const pendingBySession = new Map<string, string[]>()

// ─── Config ───────────────────────────────────────────────────────────────────

function parseConfig(options?: PluginOptions): PluginConfig {
  const maxPerMinute = typeof options?.maxPerMinute === "number" ? options.maxPerMinute : 40
  const rateLimits: Record<string, number> = { ...options?.rateLimits }
  if (!("global" in rateLimits)) {
    rateLimits["global"] = maxPerMinute
  }
  return { maxPerMinute, rateLimits }
}

// ─── Bucket helpers ───────────────────────────────────────────────────────────

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

// ─── Plugin export ────────────────────────────────────────────────────────────

const RateMonitorPlugin: Plugin = async (ctx, options?: PluginOptions) => {
  const config = parseConfig(options)
  const { client } = ctx

  function notify(message: string, variant: "info" | "warning" | "error" = "info") {
    try {
      ;(client as any).tui?.showToast?.({ body: { message, variant, duration: 4000 } })
    } catch {
      // ignore
    }
  }

  const lastQueueDepth = new Map<string, number>()
  let lastTotalForStats = 0

  return {
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
  }
}

export const server = RateMonitorPlugin
