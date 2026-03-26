import { Command } from "effect/unstable/cli"
import { commandAgents } from "./commands/agents.ts"
import { commandEdit } from "./commands/edit.ts"
import { commandFeatures } from "./commands/features.ts"
import { commandIssue } from "./commands/issue.ts"
import { commandPlan } from "./commands/plan.ts"
import { commandProjects } from "./commands/projects.ts"
import { commandRoot } from "./commands/root.ts"
import { commandRun } from "./commands/run.ts"
import { commandSh } from "./commands/sh.ts"
import { commandSource } from "./commands/source.ts"

export const appCommand = commandRoot.pipe(
  Command.withSubcommands([
    commandRun,
    commandPlan,
    commandIssue,
    commandEdit,
    commandSh,
    commandSource,
    commandAgents,
    commandProjects,
    commandFeatures,
  ]),
)
