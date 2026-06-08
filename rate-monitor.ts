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
  /** Released from queue but not yet committed to history. Counts toward capacity. */
  pendingAdds: number
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
}

// ─── Config ───────────────────────────────────────────────────────────────────

function parseConfig(options?: PluginOptions): PluginConfig {
  const maxPerMinute = typeof options?.maxPerMinute === "number" ? options.maxPerMinute : 40
  const rateLimits: Record<string, number> =
    options?.rateLimits !== null &&
    typeof options?.rateLimits === "object" &&
    !Array.isArray(options.rateLimits)
      ? { ...(options.rateLimits as Record<string, number>) }
      : {}
  if (!("global" in rateLimits)) {
    rateLimits["global"] = maxPerMinute
  }
  return { maxPerMinute, rateLimits }
}

// ─── Bucket helpers ───────────────────────────────────────────────────────────

function getOrCreateBucket(key: string, maxPerMinute: number): Bucket {
  let b = state.buckets.get(key)
  if (!b) {
    b = { history: [], pendingQueue: [], queueDepth: 0, pendingAdds: 0, processingQueue: false, maxPerMinute }
    state.buckets.set(key, b)
  }
  return b
}

/** Prunes expired entries from bucket.history and returns the remaining count. */
function pruneAndCount(bucket: Bucket): number {
  const cutoff = Date.now() - ONE_MINUTE_MS
  let i = 0
  while (i < bucket.history.length && bucket.history[i].timestamp < cutoff) i++
  if (i > 0) bucket.history.splice(0, i)
  return bucket.history.length
}

function drainQueue(bucket: Bucket): void {
  // Invariant: processingQueue is true while this function is scheduled or
  // running. It prevents concurrent drain loops from starting on the same bucket.
  // It is set to false only when the queue empties and we exit without scheduling
  // a new setTimeout.

  // Release as many queued entries as capacity allows.
  // pendingAdds tracks entries that have been released but not yet committed
  // to bucket.history, so they still count against the cap.
  while (bucket.pendingQueue.length > 0) {
    const current = pruneAndCount(bucket)
    const effectiveCount = current + bucket.pendingAdds
    if (effectiveCount >= bucket.maxPerMinute) break

    const entry = bucket.pendingQueue.shift()!
    bucket.queueDepth = bucket.pendingQueue.length
    bucket.pendingAdds++
    entry.resolve()
  }

  if (bucket.pendingQueue.length === 0) {
    bucket.processingQueue = false
    bucket.queueDepth = 0
    return
  }

  // Still items in queue — schedule retry when oldest entry ages out.
  const oldest = bucket.history[0]?.timestamp ?? Date.now()
  const waitMs = Math.max(50, oldest + ONE_MINUTE_MS - Date.now())
  setTimeout(() => drainQueue(bucket), waitMs)
}

/** Returns true if the request was held in the queue before being released. */
async function throttle(bucket: Bucket): Promise<boolean> {
  if (bucket.maxPerMinute <= 0) return false
  if (pruneAndCount(bucket) + bucket.pendingAdds < bucket.maxPerMinute) return false

  bucket.queueDepth++
  return new Promise<boolean>((resolve) => {
    bucket.pendingQueue.push({ resolve: () => resolve(true) })
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
    } catch (err) {
      console.warn("[rate-monitor] Failed to show toast:", err)
    }
  }

  const lastQueueDepth = new Map<string, number>()
  let lastTotalForStats = 0

  return {
    "chat.params": async (input, _output) => {
      const bucketKey = resolveBucketKey(input.model.providerID, input.model.id, config)

      const bucketMax = bucketKey in config.rateLimits ? config.rateLimits[bucketKey] : config.maxPerMinute
      const bucket = getOrCreateBucket(bucketKey, bucketMax)
      const label = bucketLabel(bucketKey)

      // Check queue state BEFORE throttle — fire queue-start toast synchronously
      const prevDepth = lastQueueDepth.get(bucketKey) ?? 0
      const willQueue =
        bucket.maxPerMinute > 0 &&
        pruneAndCount(bucket) + bucket.pendingAdds >= bucket.maxPerMinute
      if (willQueue && prevDepth === 0) {
        notify(`⏳ ${label} rate limit hit — ${bucket.queueDepth + 1} request(s) queued (max ${bucketMax}/min)`, "warning")
      }

      const wasQueued = await throttle(bucket)

      bucket.history.push({
        timestamp: Date.now(),
        sessionID: input.sessionID,
        agent: input.agent,
        model: `${input.model.providerID}/${input.model.id}`,
      })
      if (wasQueued && bucket.pendingAdds > 0) bucket.pendingAdds--
      state.totalRequests++

      // Check queue-clear AFTER throttle
      if (wasQueued && bucket.queueDepth === 0 && prevDepth === 0) {
        // queue formed and cleared during this single wait — no persistent queue, no clear toast needed
      } else if (bucket.queueDepth === 0 && (prevDepth > 0 || willQueue)) {
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
