import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Permission } from "../../src/permission"
import { SessionReminders } from "../../src/session/reminders"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testEffect } from "../lib/effect"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Session } from "../../src/session/session"

const it = testEffect(Layer.mergeAll(RuntimeFlags.layer({ experimentalPlanMode: false }), FSUtil.defaultLayer))

function agent(input: { name: string; systemReminder?: Agent.Info["systemReminder"] }) {
  return {
    name: input.name,
    mode: "primary" as const,
    permission: Permission.fromConfig({ "*": "allow" }),
    options: {},
    ...(input.systemReminder ? { systemReminder: input.systemReminder } : {}),
  } satisfies Agent.Info
}

function sessionInfo(): Session.Info {
  return {
    id: "session_1" as Session.Info["id"],
    slug: "session-1",
    projectID: "project_1" as Session.Info["projectID"],
    directory: "/tmp",
    title: "Pinned",
    version: "1",
    time: { created: 1, updated: 1 },
  } as Session.Info
}

function userMessage(agentName: string): SessionV1.WithParts {
  return {
    info: {
      id: "user_1" as SessionV1.User["id"],
      sessionID: "session_1" as SessionV1.User["sessionID"],
      role: "user",
      agent: agentName,
      model: { providerID: "test", modelID: "test" },
      time: { created: 1 },
    },
    parts: [
      {
        id: "part_1" as SessionV1.TextPart["id"],
        messageID: "user_1" as SessionV1.TextPart["messageID"],
        sessionID: "session_1" as SessionV1.TextPart["sessionID"],
        type: "text",
        text: "hello",
      },
    ],
  } as SessionV1.WithParts
}

function assistantMessage(agentName: string): SessionV1.WithParts {
  return {
    info: {
      id: "assistant_1" as SessionV1.Assistant["id"],
      sessionID: "session_1" as SessionV1.Assistant["sessionID"],
      parentID: "user_0" as SessionV1.Assistant["parentID"],
      role: "assistant",
      mode: agentName,
      agent: agentName,
      cost: 0,
      path: { cwd: "/tmp", root: "/tmp" },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: "test",
      providerID: "test",
      time: { created: 1 },
    },
    parts: [
      {
        id: "part_2" as SessionV1.TextPart["id"],
        messageID: "assistant_1" as SessionV1.TextPart["messageID"],
        sessionID: "session_1" as SessionV1.TextPart["sessionID"],
        type: "text",
        text: "done",
      },
    ],
  } as SessionV1.WithParts
}

describe("session reminders", () => {
  it.effect("adds reminder on first turn and transition after text", () =>
    Effect.gen(function* () {
      const messages = [assistantMessage("plan"), userMessage("build")]
      const result = yield* SessionReminders.apply({
        messages,
        agent: agent({
          name: "build",
          systemReminder: {
            text: "build text",
            transitions: {
              plan: "build transition",
            },
          },
        }),
        session: sessionInfo(),
      })

      const user = result.findLast((message) => message.info.role === "user")
      const texts = user?.parts
        .filter((part): part is SessionV1.TextPart => part.type === "text")
        .map((part) => part.text)
      expect(texts).toEqual(["hello", "build text", "build transition"])
    }),
  )

  it.effect("reapplies reminder every turn when configured", () =>
    Effect.gen(function* () {
      const messages = [assistantMessage("plan"), userMessage("plan")]
      const result = yield* SessionReminders.apply({
        messages,
        agent: agent({
          name: "plan",
          systemReminder: {
            text: "plan text",
            reapplyOnEveryTurn: true,
          },
        }),
        session: sessionInfo(),
      })

      const user = result.findLast((message) => message.info.role === "user")
      const texts = user?.parts
        .filter((part): part is SessionV1.TextPart => part.type === "text")
        .map((part) => part.text)
      expect(texts).toEqual(["hello", "plan text"])
    }),
  )

  it.effect("uses configured build transition reminder from plan", () =>
    Effect.gen(function* () {
      const messages = [assistantMessage("plan"), userMessage("build")]
      const result = yield* SessionReminders.apply({
        messages,
        agent: agent({
          name: "build",
          systemReminder: {
            transitions: {
              plan: [
                "<system-reminder>",
                "Your operational mode has changed from plan to build.",
                "You are no longer in read-only mode.",
                "You are permitted to make file changes, run shell commands, and utilize your arsenal of tools as needed.",
                "</system-reminder>",
              ].join("\n"),
            },
          },
        }),
        session: sessionInfo(),
      })

      const user = result.findLast((message) => message.info.role === "user")
      const reminder = user?.parts.at(-1)
      expect(reminder?.type).toBe("text")
      if (reminder?.type === "text") {
        expect(reminder.text).toContain("Your operational mode has changed from plan to build.")
      }
    }),
  )
})
