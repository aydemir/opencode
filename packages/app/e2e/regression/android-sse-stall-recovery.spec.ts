import { base64Encode } from "@opencode-ai/core/util/encode"
import { devices, expect, test, type Page } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"
import { expectSessionTitle } from "../utils/waits"

// Mobile emulation: Android Chrome fetch stack + touch viewport.
// Background lifecycle events (visibilitychange/pageshow/online)
// DELIBERATELY never fire — proving the in-stream watchdog recovers the
// dead (half-open) stream without depending on them.
test.use({ ...devices["Pixel 7"] })

const directory = "C:/OpenCode/AndroidStall"
const projectID = "proj_android_stall"
const sessionID = "ses_android_stall"
const title = "Android stall recovery"

test("recovers a silently dead (half-open) event stream without lifecycle events", async ({ page }) => {
  test.setTimeout(120_000)
  const transport = await installSseTransport(page, {
    server: `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`,
    retry: 20,
  })
  await mockServer(page)
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

  const first = await transport.waitForConnection()
  await expectSessionTitle(page, title)

  // Last seen chunk: after this the server sends not a single byte
  // (half-open socket). No lifecycle events — the watchdog alone must
  // abort after ~30s and reconnect within 250ms.
  await transport.heartbeat()
  const second = await transport.waitForConnection({ after: first.id, timeout: 90_000 })
  expect(second.id).toBeGreaterThan(first.id)

  // The dead attempt was aborted by the watchdog (not an error/close).
  const connections = await transport.connections()
  expect(connections.find((connection) => connection.id === first.id)?.endedBy).toBe("abort")

  // The new stream is live: the sent event reaches the UI.
  await transport.send({
    directory,
    payload: {
      type: "question.asked",
      properties: {
        id: "question-stall",
        sessionID,
        questions: [
          {
            header: "Continue",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue the session" }],
          },
        ],
        tool: { messageID: "message-stall", callID: "call-stall" },
      },
    },
  })
  const question = page.locator('[data-component="dock-prompt"][data-kind="question"]')
  await expect(question).toBeVisible()
  await expect(question.getByText("Continue?")).toBeVisible()
})

async function mockServer(page: Page) {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "android-stall",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": {
              id: "claude-opus-4-6",
              name: "Claude Opus 4.6",
              limit: { context: 200_000 },
            },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "android-stall",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    permissions: [],
    questions: [],
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })
}
