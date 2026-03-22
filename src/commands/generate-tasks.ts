import { Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { CurrentIssueSource } from "../CurrentIssueSource.ts"
import { selectCliAgentPreset } from "../Presets.ts"
import { commandRoot } from "./root.ts"
import { generateTasks, generateTasksSpecificationPath } from "./plan/tasks.ts"

export const commandGenerateTasks = Command.make("generate-tasks", {
  specificationPath: generateTasksSpecificationPath,
}).pipe(
  Command.withDescription(
    "Convert an existing specification file into PRD tasks without re-running specification generation.",
  ),
  Command.withHandler(
    Effect.fnUntraced(function* ({ specificationPath }) {
      const { specsDirectory } = yield* commandRoot
      const preset = yield* selectCliAgentPreset

      yield* generateTasks({
        specsDirectory,
        specificationPath,
        preset,
      })
    }, Effect.provide(CurrentIssueSource.layer)),
  ),
)
