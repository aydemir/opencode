import { describe, expect, test } from "bun:test"
import { adaptServerEvent, coalesceServerEvents, createStreamStallGuard, enqueueServerEvent, resumeStreamAfterPageShow, shouldForceReconnect, STREAM_STALL_MS } from "./server-sdk"
import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import type { Event } from "@opencode-ai/sdk/v2/client"

describe("resumeStreamAfterPageShow", () => {
  test("restarts the stream on pageshow regardless of bfcache persisted flag", () => {
    let starts = 0
    const start = () => starts++

    resumeStreamAfterPageShow({ persisted: false } as PageTransitionEvent, start)
    resumeStreamAfterPageShow({ persisted: true } as PageTransitionEvent, start)

    expect(starts).toBe(2)
  })
})

describe("shouldForceReconnect", () => {
  test("forces when visible and stream stalled beyond threshold", () => {
    expect(shouldForceReconnect({ lastChunkAt: 0, now: STREAM_STALL_MS + 1, visible: true })).toBe(true)
  })

  test("does not force for a healthy stream (server heartbeat every 10s)", () => {
    expect(shouldForceReconnect({ lastChunkAt: 0, now: 10_000, visible: true })).toBe(false)
  })

  test("does not force at the exact threshold boundary", () => {
    expect(shouldForceReconnect({ lastChunkAt: 0, now: STREAM_STALL_MS, visible: true })).toBe(false)
  })

  test("never forces while hidden", () => {
    expect(shouldForceReconnect({ lastChunkAt: 0, now: STREAM_STALL_MS + 60_000, visible: false })).toBe(false)
    expect(shouldForceReconnect({ lastChunkAt: undefined, now: 0, visible: false })).toBe(false)
  })

  test("forces when visible but no chunk ever arrived", () => {
    expect(shouldForceReconnect({ lastChunkAt: undefined, now: 0, visible: true })).toBe(true)
  })
})

describe("createStreamStallGuard", () => {
  test("aborts the dead attempt when returning visible after a stall (Android background case)", () => {
    let aborts = 0
    const guard = createStreamStallGuard({ onStall: () => aborts++ })

    guard.markChunk(0)
    // 6dk arka plan: heartbeat (10sn) çoktan kesilmiş
    expect(guard.onVisible("visible", 360_000)).toBe(true)
    expect(aborts).toBe(1)
  })

  test("leaves a healthy stream alone", () => {
    let aborts = 0
    const guard = createStreamStallGuard({ onStall: () => aborts++ })

    guard.markChunk(20_000)
    expect(guard.onVisible("visible", 30_000)).toBe(false)
    expect(aborts).toBe(0)
  })

  test("ignores hidden state", () => {
    let aborts = 0
    const guard = createStreamStallGuard({ onStall: () => aborts++ })

    guard.markChunk(0)
    expect(guard.onVisible("hidden", 360_000)).toBe(false)
    expect(aborts).toBe(0)
  })

  test("latest chunk wins (recovered stream is not punished)", () => {
    let aborts = 0
    const guard = createStreamStallGuard({ onStall: () => aborts++ })

    guard.markChunk(0)
    guard.markChunk(350_000)
    expect(guard.onVisible("visible", 360_000)).toBe(false)
    expect(aborts).toBe(0)
  })
})

describe("createStreamStallGuard onOnline", () => {
  test("aborts a stalled stream without a visibility gate (network-back case)", () => {
    let aborts = 0
    const guard = createStreamStallGuard({ onStall: () => aborts++ })

    guard.markChunk(0)
    // 6dk sessizlik: online sahte değil, gerçekten ölü stream
    expect(guard.onOnline(360_000)).toBe(true)
    expect(aborts).toBe(1)
  })

  test("leaves a healthy stream alone on spurious online", () => {
    let aborts = 0
    const guard = createStreamStallGuard({ onStall: () => aborts++ })

    guard.markChunk(20_000)
    expect(guard.onOnline(30_000)).toBe(false)
    expect(aborts).toBe(0)
  })

  test("forces when no chunk ever arrived", () => {
    let aborts = 0
    const guard = createStreamStallGuard({ onStall: () => aborts++ })

    expect(guard.onOnline(0)).toBe(true)
    expect(aborts).toBe(1)
  })
})

describe("adaptServerEvent", () => {
  test("preserves V2 events while adapting permission requests for existing consumers", () => {
    const current = {
      id: "evt_1",
      created: 1,
      type: "permission.v2.asked",
      data: { id: "perm_1", sessionID: "ses_1", action: "read", resources: ["src/**"] },
    } as OpenCodeEvent

    expect(adaptServerEvent(current)).toMatchObject({
      type: "permission.asked",
      properties: { id: "perm_1", sessionID: "ses_1", permission: "read", patterns: ["src/**"] },
      current,
    })
  })
})

describe("coalesceServerEvents", () => {
  const delta = (value: string, field = "text", partID = "part") => ({
    directory: "/repo",
    payload: {
      type: "message.part.delta",
      properties: { messageID: "msg", partID, field, delta: value },
    } as Event,
  })

  test("merges adjacent deltas for the same field", () => {
    const first = delta("hello ")
    const second = delta("world")
    first.payload.id = "first"
    second.payload.id = "second"
    const result = coalesceServerEvents([first, second])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload).toMatchObject({ id: "second", properties: { delta: "hello world" } })
  })

  test("merges adjacent current text deltas", () => {
    const current = (id: string, value: string) =>
      adaptServerEvent({
        id,
        created: 1,
        type: "session.text.delta",
        location: { directory: "/repo" },
        data: { sessionID: "ses", assistantMessageID: "msg", ordinal: 0, delta: value },
      } as OpenCodeEvent)
    const result = coalesceServerEvents([
      { directory: "/repo", payload: current("evt_1", "hello ") },
      { directory: "/repo", payload: current("evt_2", "world") },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]?.payload.current).toMatchObject({ id: "evt_2", data: { delta: "hello world" } })
  })

  test("preserves event boundaries and distinct fields", () => {
    const status = {
      directory: "/repo",
      payload: { type: "session.status", properties: { sessionID: "ses", status: { type: "idle" } } } as Event,
    }
    const result = coalesceServerEvents([delta("a"), delta("b", "metadata"), status, delta("c")])

    expect(result.map((event) => event.payload.type)).toEqual([
      "message.part.delta",
      "message.part.delta",
      "session.status",
      "message.part.delta",
    ])
  })

  test("preserves event ID order across interleaved deltas", () => {
    const first = delta("a")
    const other = delta("b", "text", "other")
    const last = delta("c")
    first.payload.id = "1"
    other.payload.id = "2"
    last.payload.id = "3"

    const result = coalesceServerEvents([first, other, last])

    expect(result.map((event) => event.payload.id)).toEqual(["1", "2", "3"])
  })
})

describe("enqueueServerEvent", () => {
  const partUpdated = (text: string) =>
    ({
      type: "message.part.updated",
      properties: {
        sessionID: "session",
        part: { id: "part", sessionID: "session", messageID: "message", type: "text", text },
      },
    }) as Event

  test("preserves part updates across message remove and re-add barriers", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({ type: "message.removed", properties: { sessionID: "session", messageID: "message" } } as Event)
    enqueue({
      type: "message.updated",
      properties: {
        sessionID: "session",
        info: {
          id: "message",
          sessionID: "session",
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID: "provider", modelID: "model" },
        },
      },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "message.removed",
      "message.updated",
      "message.part.updated",
    ])
  })

  test("preserves deltas after a replacement snapshot", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("a"))
    enqueue(partUpdated("ab"))
    enqueue({
      type: "message.part.delta",
      properties: { sessionID: "session", messageID: "message", partID: "part", field: "text", delta: "c" },
    } as Event)

    const result = coalesceServerEvents(events)
    expect(result.map((event) => event.payload.type)).toEqual(["message.part.updated", "message.part.delta"])
    expect(result[0]?.payload).toMatchObject({ properties: { part: { text: "ab" } } })
    expect(result[1]?.payload).toMatchObject({ properties: { delta: "c" } })
  })

  test("preserves updates after session deletion", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (payload: Event) => enqueueServerEvent(events, { directory: "/repo", payload })

    enqueue(partUpdated("old"))
    enqueue({
      type: "session.deleted",
      properties: { sessionID: "session", info: { id: "session" } },
    } as Event)
    enqueue(partUpdated("new"))

    expect(events.map((event) => event.payload.type)).toEqual([
      "message.part.updated",
      "session.deleted",
      "message.part.updated",
    ])
  })

  test("does not coalesce edge-triggered session statuses", () => {
    const events: Array<{ directory: string; payload: Event }> = []
    const enqueue = (status: "retry" | "busy") =>
      enqueueServerEvent(events, {
        directory: "/repo",
        payload: {
          type: "session.status",
          properties: {
            sessionID: "session",
            status: status === "retry" ? { type: "retry", attempt: 1, message: "retry", next: 1 } : { type: "busy" },
          },
        } as Event,
      })

    enqueue("retry")
    enqueue("busy")

    expect(events).toHaveLength(2)
  })
})
