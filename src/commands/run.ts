import { Command } from "effect/unstable/cli"
import { commandRunAll } from "./run/all.ts"
import { commandRunFeature } from "./run/feature.ts"
import { commandRunIssues } from "./run/issues.ts"

const subcommands = Command.withSubcommands([
  commandRunIssues,
  commandRunFeature,
  commandRunAll,
])

export const commandRun = Command.make("run").pipe(
  Command.withDescription(
    "Run orchestration targets. Use 'issues' for top-level issues, 'feature <name>' to focus one feature, or 'all' for the global loop.",
  ),
  subcommands,
)
