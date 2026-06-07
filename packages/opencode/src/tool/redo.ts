import { Effect, Schema } from "effect"
import { Agent } from "@/agent/agent"
import { SessionRevert } from "@/session/revert"
import { SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import DESCRIPTION from "./redo.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  task_id: Schema.String.annotate({ description: "The target session id to redo" }),
  subagent_type: Schema.String.annotate({
    description: "The agent type used for permission matching, same semantics as the task tool",
  }),
})

export const RedoTool = Tool.define(
  "redo",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const revert = yield* SessionRevert.Service
    const agent = yield* Agent.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!ctx.extra?.bypassAgentCheck) {
            yield* ctx.ask({
              permission: "redo",
              patterns: [params.subagent_type],
              always: ["*"],
              metadata: {
                task_id: params.task_id,
                subagent_type: params.subagent_type,
              },
            })
          }

          const next = yield* agent.get(params.subagent_type)
          if (!next) {
            return yield* Effect.fail(
              new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`),
            )
          }

          const sessionID = SessionID.make(params.task_id)
          const session = yield* sessions.get(sessionID)
          if (!session.revert) return yield* Effect.fail(new Error(`Session has nothing to redo: ${params.task_id}`))

          yield* revert.unrevert({ sessionID })

          return {
            title: `Redid session ${params.task_id}`,
            output: `Redo completed for session ${params.task_id}.`,
            metadata: {
              sessionId: params.task_id,
              subagentType: next.name,
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
