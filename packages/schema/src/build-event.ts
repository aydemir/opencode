export * as BuildEvent from "./build-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"

export const Settled = Event.define({
  type: "build.settled",
  schema: {
    name: Schema.String,
    status: Schema.Union([
      Schema.Literal("PASSED"),
      Schema.Literal("FAILED"),
      Schema.Literal("ERROR"),
      Schema.Literal("TIMED_OUT"),
      Schema.Literal("STALLED"),
      Schema.Literal("INTERRUPTED"),
    ]),
    exit: Schema.Number,
    durationMs: Schema.Number,
    log: optional(Schema.String),
  },
})

export const Definitions = Event.inventory(Settled)
