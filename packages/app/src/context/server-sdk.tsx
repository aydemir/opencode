import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { Event } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { makeEventListener } from "@solid-primitives/event-listener"
import { type Accessor, batch, createMemo, createResource, onCleanup, onMount } from "solid-js"
import { createApiForServer, createSdkForServer, type ServerApi } from "@/utils/server"
import { useLanguage } from "./language"
import { usePlatform } from "./platform"
import { ServerConnection, useServer } from "./server"
import { createRefCountMap } from "@/utils/refcount"
import { useGlobal } from "./global"
import { ServerScope } from "@/utils/server-scope"
import { detectServerProtocol, type ServerProtocol } from "@/utils/server-protocol"
import { createCompatibleApi, type CompatibleApi } from "@/utils/server-compat"

const isAbortError = (error: unknown) =>
  error !== null && typeof error === "object" && "name" in error && error.name === "AbortError"

const isStreamClosed = (error: unknown, signal?: AbortSignal) => isAbortError(error) || signal?.aborted === true
export type ServerEvent = Event & { current?: OpenCodeEvent }
type QueuedServerEvent = { directory: string; payload: ServerEvent }
type CurrentDelta = Extract<
  OpenCodeEvent,
  { type: "session.text.delta" | "session.reasoning.delta" | "session.tool.input.delta" | "session.compaction.delta" }
>

export function adaptServerEvent(event: OpenCodeEvent): ServerEvent {
  if (event.type === "permission.v2.asked") {
    return {
      id: event.id,
      type: "permission.asked",
      properties: {
        id: event.data.id,
        sessionID: event.data.sessionID,
        permission: event.data.action,
        patterns: event.data.resources,
        always: event.data.save ?? [],
        metadata: event.data.metadata ?? {},
        tool:
          event.data.source?.type === "tool"
            ? { messageID: event.data.source.messageID, callID: event.data.source.callID }
            : undefined,
      },
      current: event,
    } as ServerEvent
  }
  if (event.type === "permission.v2.replied")
    return { id: event.id, type: "permission.replied", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.asked")
    return { id: event.id, type: "question.asked", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.replied")
    return { id: event.id, type: "question.replied", properties: event.data, current: event } as ServerEvent
  if (event.type === "question.v2.rejected")
    return { id: event.id, type: "question.rejected", properties: event.data, current: event } as ServerEvent
  return { id: event.id, type: event.type, properties: event.data, current: event } as ServerEvent
}

const coalescedKey = (event: QueuedServerEvent) => {
  if (event.payload.type === "lsp.updated") return `lsp.updated:${event.directory}`
  if (event.payload.type === "message.part.updated") {
    const part = event.payload.properties.part
    return `message.part.updated:${event.directory}:${part.messageID}:${part.id}`
  }
  return undefined
}

export function enqueueServerEvent(queue: QueuedServerEvent[], event: QueuedServerEvent) {
  const key = coalescedKey(event)
  const previous = queue[queue.length - 1]
  if (key && previous && coalescedKey(previous) === key) {
    queue[queue.length - 1] = event
    return false
  }
  queue.push(event)
  return true
}

export function coalesceServerEvents(events: QueuedServerEvent[]) {
  const output: QueuedServerEvent[] = []
  events.forEach((event) => {
    const current = currentDelta(event.payload.current)
    if (current) {
      const previous = output[output.length - 1]
      const prior = currentDelta(previous?.payload.current)
      if (
        previous &&
        prior &&
        previous.directory === event.directory &&
        currentDeltaKey(prior) === currentDeltaKey(current)
      ) {
        const fragment = currentDeltaFragment(prior) + currentDeltaFragment(current)
        const data =
          current.type === "session.compaction.delta"
            ? { ...current.data, text: fragment }
            : { ...current.data, delta: fragment }
        output[output.length - 1] = {
          directory: event.directory,
          payload: {
            ...event.payload,
            properties: data,
            current: { ...current, data } as CurrentDelta,
          } as ServerEvent,
        }
        return
      }
      output.push(event)
      return
    }
    if (event.payload.type !== "message.part.delta") {
      output.push(event)
      return
    }
    const props = event.payload.properties
    const previous = output[output.length - 1]
    if (
      !previous ||
      previous.payload.type !== "message.part.delta" ||
      previous.directory !== event.directory ||
      previous.payload.properties.messageID !== props.messageID ||
      previous.payload.properties.partID !== props.partID ||
      previous.payload.properties.field !== props.field
    ) {
      output.push({
        directory: event.directory,
        payload: { ...event.payload, properties: { ...props } },
      })
      return
    }
    output[output.length - 1] = {
      directory: event.directory,
      payload: {
        ...event.payload,
        properties: { ...props, delta: previous.payload.properties.delta + props.delta },
      },
    }
  })
  return output
}

function currentDelta(event: OpenCodeEvent | undefined): CurrentDelta | undefined {
  if (
    event?.type === "session.text.delta" ||
    event?.type === "session.reasoning.delta" ||
    event?.type === "session.tool.input.delta" ||
    event?.type === "session.compaction.delta"
  )
    return event
}

function currentDeltaKey(event: CurrentDelta) {
  if (event.type === "session.tool.input.delta")
    return `${event.type}:${event.data.sessionID}:${event.data.assistantMessageID}:${event.data.callID}`
  if (event.type === "session.compaction.delta") return `${event.type}:${event.data.sessionID}`
  return `${event.type}:${event.data.sessionID}:${event.data.assistantMessageID}:${event.data.ordinal}`
}

function currentDeltaFragment(event: CurrentDelta) {
  return event.type === "session.compaction.delta" ? event.data.text : event.data.delta
}

export function resumeStreamAfterPageShow(_event: PageTransitionEvent, start: () => unknown) {
  // An open fetch() event stream blocks bfcache, so `persisted` is mostly
  // false on pageshow and the gated start() never ran (#47258).
  // Gate removed: start() is idempotent (returns the current run when started).
  start()
}

// The server sends `server.heartbeat` every 10s (global.ts/event.ts), so a
// healthy stream never goes ~10-15s without a chunk. A stream that dies in
// the background (half-open) neither errors nor yields data, and the
// idempotent `start()` guard degrades to a no-op, so no reconnect fires
// either (follow-up to #47258: on Android, pageshow often never fires).
export const STREAM_STALL_MS = 30_000

export function shouldForceReconnect(opts: {
  lastChunkAt: number | undefined
  now?: number
  visible?: boolean
}): boolean {
  if (opts.visible === false) return false
  const now = opts.now ?? Date.now()
  // No chunk ever arrived (e.g. backgrounded while connecting): force on
  // return to a visible tab — abort is harmless, the loop retries in 250ms.
  if (opts.lastChunkAt === undefined) return true
  return now - opts.lastChunkAt > STREAM_STALL_MS
}

// Stall guard: thin layer that stays testable in proot (no Android
// lifecycle). The real DOM wiring (visibilitychange → onVisible,
// online → onOnline) lives below.
export function createStreamStallGuard(opts: { onStall: () => void }) {
  let lastChunkAt: number | undefined
  return {
    markChunk(at: number = Date.now()) {
      lastChunkAt = at
    },
    onVisible(state: string, now: number = Date.now()): boolean {
      if (state !== "visible") return false
      if (!shouldForceReconnect({ lastChunkAt, now })) return false
      opts.onStall()
      return true
    },
    // On network return: stall check independent of visibility.
    // `online` can be spurious — a healthy stream is left alone.
    onOnline(now: number = Date.now()): boolean {
      if (!shouldForceReconnect({ lastChunkAt, now, visible: true })) return false
      opts.onStall()
      return true
    },
  }
}

type ServerEventEmitter = ReturnType<typeof createGlobalEmitter<{ [key: string]: ServerEvent }>>
type ServerSDKBase = {
  server: ServerConnection.Any
  scope: ServerScope
  protocol: Promise<ServerProtocol>
  protocolKind: Accessor<ServerProtocol | undefined>
  url: string
  client: ReturnType<typeof createSdkForServer>
  api: CompatibleApi
  currentApi: ServerApi
  event: {
    on: ServerEventEmitter["on"]
    listen: ServerEventEmitter["listen"]
    start: () => Promise<void> | undefined
  }
  createClient: (
    opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">,
  ) => ReturnType<typeof createSdkForServer>
}

function createServerSdkContextBase(server: ServerConnection.Any, scope: ServerScope): ServerSDKBase {
  const platform = usePlatform()
  const abort = new AbortController()

  const eventFetch = (() => {
    if (!platform.fetch || !server) return
    try {
      const url = new URL(server.http.url)
      const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
      if (url.protocol === "http:" && !loopback) return platform.fetch
    } catch {
      return
    }
  })()

  const eventApi = createApiForServer({ server: server.http, fetch: eventFetch })
  const eventSdk = createSdkForServer({
    signal: abort.signal,
    fetch: eventFetch,
    server: server.http,
  })
  const protocol = detectServerProtocol(server.http, platform.fetch ?? globalThis.fetch)
  const [protocolKind] = createResource(
    () => protocol,
    (value) => value,
  )
  const emitter = createGlobalEmitter<{
    [key: string]: ServerEvent
  }>()

  type Queued = QueuedServerEvent
  const FLUSH_FRAME_MS = 16
  const STREAM_YIELD_MS = 8
  const RECONNECT_DELAY_MS = 250

  let queue: Queued[] = []
  let buffer: Queued[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined

    if (queue.length === 0) return

    const events = queue
    queue = buffer
    buffer = events
    queue.length = 0

    last = Date.now()
    const output = coalesceServerEvents(events)
    batch(() => {
      output.forEach((event) => emitter.emit(event.directory, event.payload))
    })

    buffer.length = 0
  }

  const schedule = () => {
    if (timer) return
    const elapsed = Date.now() - last
    timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
  }

  let streamErrorLogged = false
  const stallGuard = createStreamStallGuard({ onStall: () => attempt?.abort() })
  // In-stream watchdog (openchamber event-pipeline parity): a half-open
  // stream cannot outlive STREAM_STALL_MS even when no lifecycle event
  // (visibility/pageshow/online) ever fires. Reset on every chunk; on
  // expiry it aborts the current attempt — the loop reconnects in 250ms.
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const clearStallTimer = () => {
    if (stallTimer === undefined) return
    clearTimeout(stallTimer)
    stallTimer = undefined
  }
  const armStallTimer = () => {
    clearStallTimer()
    stallTimer = setTimeout(() => {
      stallTimer = undefined
      attempt?.abort()
    }, STREAM_STALL_MS)
  }
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  let attempt: AbortController | undefined
  let run: Promise<void> | undefined
  let started = false
  let generation = 0
  // If stop()ped while offline, resume with start() on online; a separate
  // flag so online doesn't resurrect a stream stopped via pagehide.
  let offlineStopped = false

  const start = () => {
    if (started) return run
    started = true
    const active = ++generation
    const previous = run
    const current = (async () => {
      if (previous) await previous
      // oxlint-disable-next-line no-unmodified-loop-condition -- `started` is set to false by stop() which also aborts; both flags are checked to allow graceful exit
      while (!abort.signal.aborted && started && generation === active) {
        attempt = new AbortController()
        // Arm while connecting too, against a stuck subscribe (one hanging
        // before the first chunk aborts after STREAM_STALL_MS, the loop retries).
        armStallTimer()
        const onAbort = () => {
          attempt?.abort()
        }
        abort.signal.addEventListener("abort", onAbort)
        try {
          const kind = await protocol
          const events =
            kind === "v1"
              ? (await eventSdk.global.event({ signal: attempt.signal })).stream
              : eventApi.event.subscribe({ signal: attempt.signal })
          let yielded = Date.now()
          for await (const event of events) {
            stallGuard.markChunk()
            armStallTimer()
            streamErrorLogged = false
            const legacy = "payload" in event
            if (legacy && event.payload.type === "sync") continue
            const directory = legacy ? (event.directory ?? "global") : (event.location?.directory ?? "global")
            const payload = legacy ? (event.payload as Event) : adaptServerEvent(event)
            if (enqueueServerEvent(queue, { directory, payload })) schedule()

            if (Date.now() - yielded < STREAM_YIELD_MS) continue
            yielded = Date.now()
            await wait(0)
          }
        } catch (error) {
          if (!isStreamClosed(error, attempt?.signal) && !streamErrorLogged) {
            streamErrorLogged = true
            console.error("[global-sdk] event stream failed", {
              url: server.http.url,
              fetch: eventFetch ? "platform" : "webview",
              error,
            })
          }
        } finally {
          abort.signal.removeEventListener("abort", onAbort)
          clearStallTimer()
          attempt = undefined
        }

        if (abort.signal.aborted || !started || generation !== active) return
        await wait(RECONNECT_DELAY_MS)
      }
    })().finally(() => {
      if (run !== current) return
      run = undefined
      flush()
    })
    run = current
    return run
  }

  const stop = () => {
    started = false
    generation++
    clearStallTimer()
    attempt?.abort()
  }

  onMount(() => {
    makeEventListener(window, "pagehide", stop)
    makeEventListener(window, "pageshow", (event) => resumeStreamAfterPageShow(event, start))
    // On Android, background → foreground usually fires no pageshow; the
    // dead (half-open) stream stays silently stuck on the `started` guard.
    // On return to visibility, abort the current attempt when stalled —
    // the loop then takes its natural 250ms reconnect path.
    makeEventListener(document, "visibilitychange", () => {
      if (!started) return
      stallGuard.onVisible(document.visibilityState)
    })
    // On network loss don't spin the 250ms retry loop — stop the loop and
    // clear the timer. On return: if stopped while offline, continue with
    // `start()` (idempotent); if running, abort only when stalled.
    makeEventListener(window, "offline", () => {
      if (!started) return
      offlineStopped = true
      stop()
    })
    makeEventListener(window, "online", () => {
      if (!offlineStopped) {
        if (!started) return
        stallGuard.onOnline()
        return
      }
      offlineStopped = false
      start()
    })
  })

  onCleanup(() => {
    stop()
    abort.abort()
    flush()
  })

  const sdk = createSdkForServer({
    server: server.http,
    fetch: platform.fetch,
    throwOnError: true,
  })
  const currentApi: ServerApi = createApiForServer({ server: server.http, fetch: platform.fetch })
  const legacy = (directory?: string) =>
    createSdkForServer({
      server: server.http,
      fetch: platform.fetch,
      throwOnError: true,
      directory,
    })
  const api = createCompatibleApi({ protocol, current: currentApi, legacy })

  return {
    server,
    scope,
    protocol,
    protocolKind,
    url: server.http.url,
    client: sdk,
    api,
    currentApi,
    event: {
      on: emitter.on.bind(emitter),
      listen: emitter.listen.bind(emitter),
      start,
    },
    createClient(opts: Omit<Parameters<typeof createSdkForServer>[0], "server" | "fetch">) {
      return createSdkForServer({
        server: server.http,
        fetch: platform.fetch,
        ...opts,
      })
    },
  }
}

export type ServerSDK = ServerSDKBase & {
  ensureDirSdkContext: (directory: string) => ReturnType<typeof createDirSdkContext>
}

export function createServerSdkContext(server: ServerConnection.Any, scope: ServerScope): ServerSDK {
  const sdk = createServerSdkContextBase(server, scope)
  return Object.assign(sdk, {
    ensureDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
  })
}

export const { use: useServerSDK, provider: ServerSDKProvider } = createSimpleContext({
  name: "ServerSDK",
  // Returns an accessor so the resolved server can change reactively (e.g. a
  // /new-session draft retargeting its server) without re-instantiating the subtree.
  init: (props: { server?: Accessor<ServerConnection.Any | undefined> }) => {
    const global = useGlobal()
    const language = useLanguage()
    const server = useServer()

    return createMemo<ServerSDK>(() => {
      const conn = props.server?.() ?? server.current
      if (!conn) throw new Error(language.t("error.serverSDK.noServerAvailable"))
      return global.ensureServerCtx(conn).sdk
    })
  },
})

export function useServerProtocol() {
  const serverSDK = useServerSDK()
  return createMemo(() => serverSDK().protocolKind())
}

type SDKEventMap = {
  [key in Event["type"]]: Extract<ServerEvent, { type: key }>
}

function createDirSdkContext(directory: string, serverSDK: ServerSDKBase) {
  const client = serverSDK.createClient({
    directory,
    throwOnError: true,
  })

  const emitter = createGlobalEmitter<SDKEventMap>()

  const unsub = serverSDK.event.on(directory, (event) => {
    emitter.emit(event.type, event)
  })
  onCleanup(unsub)

  return {
    scope: serverSDK.scope,
    protocol: serverSDK.protocol,
    directory,
    client,
    api: createCompatibleApi({
      protocol: serverSDK.protocol,
      current: serverSDK.currentApi,
      legacy: (next) => serverSDK.createClient({ directory: next ?? directory, throwOnError: true }),
      directory,
    }),
    event: emitter,
    get url() {
      return serverSDK.url
    },
    createClient(opts: Parameters<typeof serverSDK.createClient>[0]) {
      return serverSDK.createClient(opts)
    },
  }
}
