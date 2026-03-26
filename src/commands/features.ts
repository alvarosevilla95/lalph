import { Command } from "effect/unstable/cli"
import { commandFeaturesCreate } from "./features/create.ts"
import { commandFeaturesEdit } from "./features/edit.ts"
import { commandFeaturesLs } from "./features/ls.ts"
import { commandFeaturesPause } from "./features/pause.ts"
import { commandFeaturesResume } from "./features/resume.ts"
import { commandFeaturesShow } from "./features/show.ts"

const subcommands = Command.withSubcommands([
  commandFeaturesCreate,
  commandFeaturesEdit,
  commandFeaturesLs,
  commandFeaturesPause,
  commandFeaturesResume,
  commandFeaturesShow,
])

export const commandFeatures = Command.make("features").pipe(
  Command.withDescription(
    "Manage stored feature metadata. Use 'create' to add a feature, 'edit <name>' to update one, 'pause|resume <name>' for lifecycle controls, 'ls' for a summary, and 'show <name>' to inspect one in full.",
  ),
  Command.withAlias("f"),
  subcommands,
)
