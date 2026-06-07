import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionRunState } from "@/session/run-state"
import { Truncate } from "@/tool/truncate"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { SessionRevert } from "../../src/session/revert"
import { MessageID, PartID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { RedoTool } from "../../src/tool/redo"
import { UndoTool } from "../../src/tool/undo"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"

afterEach(async () => {
  await disposeAllInstances()
})

const ref = {
  providerID: ProviderV2.ID.make("test"),
  modelID: ProviderV2.ModelID.make("test-model"),
}

const layer = Layer.mergeAll(
  Agent.defaultLayer,
  EventV2Bridge.defaultLayer,
  Session.defaultLayer,
  SessionRevert.defaultLayer,
  SessionRunState.defaultLayer,
  Truncate.defaultLayer,
  Database.defaultLayer,
)

const it = testEffect(layer)

const seed = Effect.fn("UndoRedoToolTest.seed")(function* () {
  const session = yield* Session.Service
  const chat = yield* session.create({ title: "Pinned" })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: chat.id,
    type: "text",
    text: "hello",
  })
  const assistant: SessionV1.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now() },
    modelID: ref.modelID,
    providerID: ref.providerID,
    variant: "xhigh",
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

describe("UndoTool/RedoTool", () => {
  it.instance("undo marks the target session as reverted from its first user message", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const tool = yield* UndoTool
      const def = yield* tool.init()

      const result = yield* def.execute(
        {
          task_id: chat.id,
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect(result.metadata).toMatchObject({
        sessionId: chat.id,
        subagentType: "general",
      })
      expect((yield* sessions.get(chat.id)).revert?.messageID).toBeDefined()
    }),
  )

  it.instance("redo restores a reverted target session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const { chat, assistant } = yield* seed()
      const undo = yield* UndoTool
      const redo = yield* RedoTool
      const undoDef = yield* undo.init()
      const redoDef = yield* redo.init()

      yield* undoDef.execute(
        {
          task_id: chat.id,
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      yield* redoDef.execute(
        {
          task_id: chat.id,
          subagent_type: "general",
        },
        {
          sessionID: chat.id,
          messageID: assistant.id,
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
        },
      )

      expect((yield* sessions.get(chat.id)).revert).toBeUndefined()
    }),
  )

  it.instance("redo fails when there is nothing to redo", () =>
    Effect.gen(function* () {
      const { chat, assistant } = yield* seed()
      const tool = yield* RedoTool
      const def = yield* tool.init()

      const exit = yield* def
        .execute(
          {
            task_id: chat.id,
            subagent_type: "general",
          },
          {
            sessionID: chat.id,
            messageID: assistant.id,
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
