import { Argument, Command } from "effect/unstable/cli"
import { Editor } from "../../Editor.ts"
import { editFeature } from "../../FeatureEditing.ts"

export const commandFeaturesEdit = Command.make("edit", {
  name: Argument.string("name").pipe(
    Argument.withDescription("The feature name to edit."),
  ),
}).pipe(
  Command.withDescription(
    "Edit an existing feature's stored execution mode, spec path, branches, and lifecycle metadata.",
  ),
  Command.withHandler(({ name }) => editFeature(name)),
  Command.provide(Editor.layer),
)
