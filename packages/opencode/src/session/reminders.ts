import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Agent } from "@/agent/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { PartID } from "./schema"
import { Session } from "./session"

const INCLUDE_HISTORY_REMINDER = [
  "<system-reminder>",
  "This conversation originated from another agent calling the task tool with include_history=true.",
  "",
  "Treat the conversation history above as contextual reference, not as the definition of what you should do now. Only the latest user message contains the prompt you should follow.",
  "</system-reminder>",
].join("\n")

const INCLUDE_HISTORY_PREVIOUS_AGENT = "includeHistoryPreviousAgent"

function reminderPart(input: { message: SessionV1.User; text: string }) {
  return {
    id: PartID.ascending(),
    messageID: input.message.id,
    sessionID: input.message.sessionID,
    type: "text" as const,
    text: input.text,
    synthetic: true,
  }
}

const resolveText = Effect.fn("SessionReminders.resolveText")(function* (input: {
  session: Session.Info
  text: string
}) {
  if (!input.text.includes("${planInfo}")) return input.text
  const fsys = yield* FSUtil.Service
  const ctx = yield* InstanceState.context
  const plan = Session.plan(input.session, ctx)
  const exists = yield* fsys.existsSafe(plan)
  if (!exists) yield* fsys.ensureDir(path.dirname(plan)).pipe(Effect.catch(Effect.die))
  return input.text.replace("${planInfo}", () =>
    exists
      ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.`
      : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`,
  )
})

const reminderText = Effect.fn("SessionReminders.reminderText")(function* (input: {
  agent: Agent.Info
  session: Session.Info
}) {
  if (input.agent.native !== true) return input.agent.systemReminder?.text
  if (input.agent.systemReminder?.text !== undefined) {
    return yield* resolveText({ session: input.session, text: input.agent.systemReminder.text })
  }
  return undefined
})

const transitionText = Effect.fn("SessionReminders.transitionText")(function* (input: {
  agent: Agent.Info
  previousAgent: string
  session: Session.Info
}) {
  const configured = input.agent.systemReminder?.transitions?.[input.previousAgent]
  return configured
})

const contextPreviousAgent = Effect.fn("SessionReminders.contextPreviousAgent")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const includeHistoryPreviousAgent =
    typeof input.session.metadata?.[INCLUDE_HISTORY_PREVIOUS_AGENT] === "string"
      ? input.session.metadata[INCLUDE_HISTORY_PREVIOUS_AGENT]
      : undefined
  if (includeHistoryPreviousAgent) return includeHistoryPreviousAgent

  let seenCurrent = false
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const message = input.messages[index]
    if (message?.info.role !== "user") continue
    if (message.info.agent === input.agent.name) {
      seenCurrent = true
      continue
    }
    if (seenCurrent) return message.info.agent
  }

  return undefined
})

export const active = Effect.fn("SessionReminders.active")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const reminders = [] as string[]
  const text = yield* reminderText({ agent: input.agent, session: input.session })
  if (text !== undefined) reminders.push(text)

  const previousAgent = yield* contextPreviousAgent(input)
  if (!previousAgent) return reminders

  const transition = yield* transitionText({
    agent: input.agent,
    previousAgent,
    session: input.session,
  })
  if (transition !== undefined) reminders.push(transition)
  return reminders
})

export const includeHistoryReminder = INCLUDE_HISTORY_REMINDER

export const apply = Effect.fn("SessionReminders.apply")(function* (input: {
  messages: SessionV1.WithParts[]
  agent: Agent.Info
  session: Session.Info
}) {
  const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
  if (!userMessage || userMessage.info.role !== "user") return input.messages
  const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")
  const enteringAgent = assistantMessage?.info.agent !== input.agent.name
  const text = yield* reminderText({ agent: input.agent, session: input.session })
  if ((enteringAgent || input.agent.systemReminder?.reapplyOnEveryTurn === true) && text !== undefined) {
    userMessage.parts.push(reminderPart({ message: userMessage.info, text }))
  }

  const previousAgent =
    (yield* contextPreviousAgent({ messages: input.messages, agent: input.agent, session: input.session })) ??
    assistantMessage?.info.agent
  if (previousAgent) {
    const transition = yield* transitionText({
      agent: input.agent,
      previousAgent,
      session: input.session,
    })
    if (enteringAgent && transition !== undefined) {
      userMessage.parts.push(reminderPart({ message: userMessage.info, text: transition }))
    }
  }

  return input.messages
})

export * as SessionReminders from "./reminders"
