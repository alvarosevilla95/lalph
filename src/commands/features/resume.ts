import { Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { resumeFeature } from "../../FeatureLifecycle.ts"

export const commandFeaturesResume = Command.make("resume", {
  name: Argument.string("name").pipe(
    Argument.withDescription("The feature name to resume."),
  ),
}).pipe(
  Command.withDescription(
    "Resume a paused feature without reopening terminal lifecycle states.",
  ),
  Command.withHandler(({ name }) =>
    resumeFeature(name).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          console.log(`Resumed feature: ${result.updatedFeature.name}`)
          console.log(
            `  Lifecycle status: ${result.previousStatus} -> ${result.updatedFeature.lifecycleStatus}`,
          )
        }),
      ),
      Effect.asVoid,
    ),
  ),
)
