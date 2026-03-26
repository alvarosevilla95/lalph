import { Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { pauseFeature } from "../../FeatureLifecycle.ts"

export const commandFeaturesPause = Command.make("pause", {
  name: Argument.string("name").pipe(
    Argument.withDescription("The feature name to pause."),
  ),
}).pipe(
  Command.withDescription(
    "Pause an active feature without allowing transitions from terminal lifecycle states.",
  ),
  Command.withHandler(({ name }) =>
    pauseFeature(name).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          console.log(`Paused feature: ${result.updatedFeature.name}`)
          console.log(
            `  Lifecycle status: ${result.previousStatus} -> ${result.updatedFeature.lifecycleStatus}`,
          )
        }),
      ),
      Effect.asVoid,
    ),
  ),
)
