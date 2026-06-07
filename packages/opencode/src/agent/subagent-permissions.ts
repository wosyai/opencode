import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import type { Permission } from "../permission"
import type { Agent } from "./agent"

/**
 * Build the `permission` ruleset for a subagent's session when it's spawned
 * via the task tool. Combines:
 *
 * 1. The parent **agent's** edit-class deny rules — Plan Mode's file-edit
 *    restriction lives on the agent ruleset, not on the session, so a
 *    subagent that only inherited the parent SESSION's permission would
 *    silently bypass it. (#26514)
 * 2. The parent **session's** deny rules and external_directory rules —
 *    same forwarding the original code already did.
 * 3. Default `todowrite`, `task`, `undo`, and `redo` denies if the
 *    subagent's own ruleset doesn't already permit them.
 */
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: PermissionV1.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
  allowSubagents?: boolean
}): PermissionV1.Ruleset {
  const delegated = input.allowSubagents === true
  const canTask = delegated && input.subagent.permission.some((rule) => rule.permission === "task")
  const canUndo = delegated && input.subagent.permission.some((rule) => rule.permission === "undo")
  const canRedo = delegated && input.subagent.permission.some((rule) => rule.permission === "redo")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const parentAgentDenies =
    input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? []
  return [
    ...parentAgentDenies,
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canUndo ? [] : [{ permission: "undo" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canRedo ? [] : [{ permission: "redo" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
