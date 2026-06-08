/** @jsxImportSource @opentui/solid */
// @ts-nocheck — opentui JSX types are not shipped as standard TS declarations.

/**
 * opencode-rate-monitor — TUI plugin
 *
 * Counts LLM requests by listening to message.updated events (TUI side).
 * The companion rate-monitor.ts (server plugin) handles rate limiting.
 *
 * Add to ~/.config/opencode/tui.json:
 *   { "plugin": [["./plugins/rate-monitor-tui.tsx", { "maxPerMinute": 40 }]] }
 */

import { createSignal, onCleanup, createMemo, For, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"

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
  // Each entry is the timestamp of an observed LLM call
  const callTimestamps: number[] = []
  const sessionCalls = new Map<string, number>()
  let totalCalls = 0

  // Track seen messageIDs so streaming updates don't double-count
  const seenMessages = new Set<string>()

  const [stats, setStats] = createSignal({
    recentCount: 0,
    rpm: 0,
    total: 0,
    sessions: [] as Array<{ id: string; count: number }>,
  })

  // Listen to message.updated — each new unique assistant messageID = 1 LLM call
  // Event shape: { type: "message.updated", properties: { sessionID, info: Message } }
  const offMsg = props.api.event.on("message.updated", (event: any) => {
    const info = event?.properties?.info
    const id = info?.id
    if (!id || seenMessages.has(id)) return
    if (info?.role !== "assistant") return

    seenMessages.add(id)
    const sessionID = event?.properties?.sessionID ?? "unknown"
    callTimestamps.push(Date.now())
    totalCalls++
    sessionCalls.set(sessionID, (sessionCalls.get(sessionID) ?? 0) + 1)
  })

  // Refresh display every second
  const handle = setInterval(() => {
    const now = Date.now()
    const cutoff = now - 60_000
    // Prune old entries
    while (callTimestamps.length > 0 && callTimestamps[0] < cutoff) callTimestamps.shift()

    const recent = callTimestamps.length
    const rpm =
      recent < 2
        ? recent
        : Math.round((recent / ((now - callTimestamps[0]) / 60_000)) * 10) / 10

    // Top sessions by call count
    const sessions = Array.from(sessionCalls.entries())
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    setStats({ recentCount: recent, rpm, total: totalCalls, sessions })
  }, 1000)

  onCleanup(() => {
    clearInterval(handle)
    offMsg()
  })

  const barColor = createMemo(() => {
    const { recentCount } = stats()
    const max = props.maxPerMinute
    if (max <= 0) return props.theme.success
    const pct = recentCount / max
    if (pct >= 0.9) return props.theme.error
    if (pct >= 0.7) return props.theme.warning
    return props.theme.success
  })

  const rpmLabel = createMemo(() => {
    const { rpm } = stats()
    const max = props.maxPerMinute
    return max > 0 ? `${Math.round(rpm)} / ${max} rpm` : `${Math.round(rpm)} rpm`
  })

  return (
    <box width="100%" flexDirection="column" paddingTop={1} paddingLeft={1} paddingRight={1}>
      <box width="100%" marginBottom={1}>
        <text fg={props.theme.accent}>
          <b>⚡ Rate Monitor</b>
        </text>
      </box>

      <FillBar
        theme={props.theme}
        value={stats().recentCount}
        max={props.maxPerMinute > 0 ? props.maxPerMinute : Math.max(stats().recentCount, 1)}
        color={barColor()}
      />

      <box width="100%" flexDirection="column" marginTop={1}>
        <StatRow theme={props.theme} label="Rate (last min)" value={rpmLabel()} color={barColor()} />
        <StatRow theme={props.theme} label="Total requests" value={String(stats().total)} />
      </box>

      <Show when={stats().sessions.length > 0}>
        <box width="100%" marginTop={1}>
          <text fg={props.theme.textMuted}>
            <b>Sessions (last min)</b>
          </text>
        </box>
        <For each={stats().sessions}>
          {(s) => (
            <box width="100%" flexDirection="row" justifyContent="space-between">
              <text fg={props.theme.textMuted}>…{s.id.slice(-8)}</text>
              <text fg={props.theme.text}>{s.count} req</text>
            </box>
          )}
        </For>
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

const plugin: TuiPluginModule & { id: string } = {
  id: "rate-monitor-tui",
  tui,
}

export default plugin
