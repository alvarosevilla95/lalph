import { Command } from "effect/unstable/cli"
import { commandFeaturesCreate } from "./features/create.ts"
import { commandFeaturesEdit } from "./features/edit.ts"
import { commandFeaturesLs } from "./features/ls.ts"
import { commandFeaturesShow } from "./features/show.ts"

const subcommands = Command.withSubcommands([
  commandFeaturesCreate,
  commandFeaturesEdit,
  commandFeaturesLs,
  commandFeaturesShow,
])

export const commandFeatures = Command.make("features").pipe(
  Command.withDescription(
    "Manage stored feature metadata. Use 'create' to add a feature, 'edit <name>' to update one, 'ls' for a summary, and 'show <name>' to inspect one in full.",
  ),
  Command.withAlias("f"),
  subcommands,
)
