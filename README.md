# opencode-rate-monitor

An [opencode](https://opencode.ai) plugin that tracks LLM requests in real time, enforces a configurable rate cap, and shows a live sidebar widget in the TUI.

---

## Features

- **Live request counter** — total requests since startup + rolling 60-second window
- **Requests per minute** — live rolling average shown in the TUI sidebar
- **Rate limiter** — configurable cap (e.g. 40 req/min); requests that exceed it are queued automatically and released as the window slides, no requests are dropped
- **Queue notifications** — TUI toast when throttling starts / clears
- **Periodic stats toasts** — summary every 10 requests
- **Sidebar widget** — colour-coded fill-bar + stats rendered in the opencode right sidebar
- **Per-session breakdown** — which sessions sent the most requests in the last minute (multi-agent friendly)

---

## Architecture

The plugin is split into two files that each target a different opencode runtime:

```
rate-monitor.ts       →  server plugin  (rate limiting, counting, toast notifications)
rate-monitor-tui.tsx  →  TUI plugin     (sidebar widget, live event-driven display)
```

| File | How it runs | What it does |
|---|---|---|
| `rate-monitor.ts` | opencode server process | Intercepts every `chat.params` call (fired before each LLM request). Blocks when the rate cap is hit, releases requests FIFO as the 60-second window slides. Sends toast events to the TUI via `client.tui.publish`. |
| `rate-monitor-tui.tsx` | opencode TUI process | Listens to `message.updated` events via `api.event.on()` to independently count LLM calls. Renders a reactive Solid.js sidebar slot using `@opentui/solid`. Polls state every second. |

> **Why two processes?**  
> opencode's server (AI engine) and TUI (terminal display) run as separate processes that communicate over a local socket. Module-level state cannot be shared between them — so each plugin tracks what it can see from its own side.

---

## Installation

### 1 — Copy plugin files

**Global** (works in every project):

```bash
cp rate-monitor.ts     ~/.config/opencode/plugins/
cp rate-monitor-tui.tsx ~/.config/opencode/plugins/
```

**Project-level** (current project only):

```bash
cp rate-monitor.ts     .opencode/plugins/
cp rate-monitor-tui.tsx .opencode/plugins/
```

### 2 — Install TUI dependencies

The TUI plugin uses `@opentui/solid` for JSX rendering.  
Add the required packages to `package.json` in your opencode config directory:

**Global** (`~/.config/opencode/package.json`):

```json
{
  "dependencies": {
    "@opentui/core":   ">=0.3.1",
    "@opentui/keymap": ">=0.3.1",
    "@opentui/solid":  ">=0.3.1"
  }
}
```

> If you already have a `package.json` there, just add the three `@opentui/*` entries — don't overwrite the file.

opencode runs `bun install` automatically on startup and caches packages in `~/.cache/opencode/`.

### 3 — Register the server plugin

Add to `~/.config/opencode/opencode.json` (or your project's `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./plugins/rate-monitor.ts", { "maxPerMinute": 40 }]
  ]
}
```

Set `"maxPerMinute": 0` to disable the cap entirely (counting + notifications only, no throttling).

### 4 — Register the TUI sidebar plugin

Create (or update) `~/.config/opencode/tui.json`:

```json
{
  "plugin": [
    ["./plugins/rate-monitor-tui.tsx", { "maxPerMinute": 40 }]
  ]
}
```

> Keep `maxPerMinute` in sync between the two config files — the server enforces it, the TUI uses it to colour the fill-bar.

### 5 — Restart opencode

All changes take effect on the next startup.

> **Windows users** — use PowerShell equivalents throughout:
> - `~/.config/opencode` → `%USERPROFILE%\.config\opencode`
> - Use `New-Item -ItemType Directory -Path "$env:USERPROFILE\.config\opencode\plugins" -Force` instead of `mkdir -p`
> - Use `Copy-Item` instead of `cp`
>   ```powershell
>   Copy-Item -Path rate-monitor.ts -Destination "$env:USERPROFILE\.config\opencode\plugins\"
>   Copy-Item -Path rate-monitor-tui.tsx -Destination "$env:USERPROFILE\.config\opencode\plugins\"
>   ```
> - Run `npm install` (or `bun install` if available) to fetch dependencies
> - JSON config paths like `./plugins/rate-monitor.ts` work as-is on Windows (Node.js normalises forward slashes)

---

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `maxPerMinute` | `number` | `40` | Maximum LLM requests per minute. `0` = unlimited. |

---

## What you see

### Sidebar widget (`rate-monitor-tui.tsx`)

```
⚡ Rate Monitor
████████████░░░░░░░░   ← fill-bar (last 60 s vs. cap)

Rate (last min)     12 / 40 rpm
Total requests      87

Sessions (last min)
…a3f9c2b1           8 req
…d7e4a0f2           4 req
```

**Fill-bar colours:**

| Colour | Meaning |
|---|---|
| 🟢 Green | < 70 % of cap |
| 🟡 Yellow | 70–89 % of cap |
| 🔴 Red | ≥ 90 % of cap (queuing imminent) |

### Toast notifications (`rate-monitor.ts`)

| Trigger | Toast |
|---|---|
| Queue starts | ⏳ *Rate limit hit — N request(s) queued (max 40/min)* |
| Queue clears | ✅ *Request queue cleared* |
| Every 10th request | 📊 *Rate monitor: N req/last min · M total* |

---

## How the rate limiter works

The limiter uses a **sliding 60-second window**:

1. Each LLM call goes through the `chat.params` hook.
2. If the number of calls in the last 60 seconds is below `maxPerMinute`, the call proceeds immediately.
3. If the cap is hit, the hook returns a Promise that resolves only when an old call ages out of the window.
4. Requests are released **FIFO** — no calls are dropped, they just wait their turn.
5. The oldest request's age determines the wait time, so throughput stays as close to the cap as possible.

```
time →   0s      10s     20s     30s     40s     50s     60s
calls    ████████████████████████████████████   <- cap hit
queue                                    ░░░░   <- new calls wait
release                                      ↑  <- oldest ages out, queue drains
```

---

## Requirements

- [opencode](https://opencode.ai) with Bun runtime
- `@opentui/core`, `@opentui/keymap`, `@opentui/solid` ≥ 0.3.1 (auto-installed via `package.json`)
