import { Command } from "effect/unstable/cli"
import { RunService } from "../../RunService.ts"
import { runCommandFlags, runCommandSharedFlags } from "./options.ts"

export const commandRunIssues = Command.make("issues", runCommandFlags).pipe(
  Command.withSharedFlags(runCommandSharedFlags),
  Command.withDescription(
    "Run only top-level issue execution. Feature work is excluded from this target.",
  ),
  Command.withHandler((options) => RunService.runIssues(options)),
)
