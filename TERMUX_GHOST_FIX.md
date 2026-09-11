# Termux Ghost Text Fix

## Problem
On Termux (Android), opencode TUI leaves "ghost" text artifacts when lines shrink. The artifacts disappear only after screen rotation (which triggers a full redraw via `WindowSizeMsg`).

## Root Cause
The TUI renderer starts in `split-footer` + `capture-stdout` mode for the splash screen, then switches to `main-screen` + `passthrough` for normal operation. 

`main-screen` mode renders directly on the main terminal buffer using line-diff algorithm. On Termux, when a new line is shorter than the previous line, the diff renderer doesn't emit ANSI `Erase to End of Line` (`\033[K`), leaving leftover characters.

## Solution
Change the screen mode from `main-screen` to `alternate-screen` in the shutdown transition (line 100 in `runtime.lifecycle.ts`).

`alternate-screen` mode (DECSET 1049 / `smcup`/`rmcup`) swaps to a separate terminal buffer. On entry: clean buffer. On exit: original buffer restored. No line-diff artifacts possible.

## Change
**File:** `packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts`
**Line:** 100

```diff
-    renderer.screenMode = "main-screen"
+    renderer.screenMode = "alternate-screen"
```

## Validation
- opentui's `CliRendererConfig` accepts `alternate-screen` with `passthrough` external output mode (no validation error)
- Tested: `bun install` + `bun run --cwd packages/opencode src/index.ts` (requires native deps)
- Workaround confirmed on Termux: `kill -WINCH $(pgrep opencode)` forces full redraw

## Upstream PR Strategy
1. Fork anomalyco/opencode
2. Apply this patch
3. (Optional) Add config option `tui.screen_mode: "alternate-screen" | "main-screen"` in `packages/opencode/src/config/tui.ts`
4. Open PR with description linking to issue #47255

## Files in this fork
- `termux-ghost-fix.patch` — git diff for the fix
- This document
