import { Command } from "effect/unstable/cli"
import { RunService } from "../../RunService.ts"
import { runCommandFlags, runCommandSharedFlags } from "./options.ts"

export const commandRunAll = Command.make("all", runCommandFlags).pipe(
  Command.withSharedFlags(runCommandSharedFlags),
  Command.withDescription(
    "Run the global execution loop across enabled projects. This is the main orchestration entrypoint and matches bare `lalph`.",
  ),
  Command.withHandler((options) => RunService.runAll(options)),
)
