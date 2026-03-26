import { Effect, Option } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { RunService } from "../../RunService.ts"
import { FeatureNotFound, FeatureStore } from "../../FeatureStore.ts"
import { FeatureName } from "../../domain/Feature.ts"
import { runCommandFlags, runCommandSharedFlags } from "./options.ts"

export const commandRunFeature = Command.make("feature", {
  ...runCommandFlags,
  name: Argument.string("name").pipe(
    Argument.withDescription("The stored feature name to run."),
  ),
}).pipe(
  Command.withSharedFlags(runCommandSharedFlags),
  Command.withDescription(
    "Resolve one stored feature by name and target execution at that feature.",
  ),
  Command.withHandler(
    Effect.fnUntraced(function* ({ name, ...options }) {
      const featureName = FeatureName.makeUnsafe(name)
      const feature = yield* FeatureStore.load(featureName)

      if (Option.isNone(feature)) {
        return yield* new FeatureNotFound({ name: featureName })
      }

      yield* RunService.runFeature({
        ...options,
        feature: feature.value,
      })
    }),
  ),
)
