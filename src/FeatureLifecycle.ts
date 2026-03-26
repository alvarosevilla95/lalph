import { Data, Effect, Option } from "effect"
import { FeatureNotFound, FeatureStore } from "./FeatureStore.ts"
import {
  type Feature,
  type FeatureLifecycleStatus,
  FeatureName,
  type FeatureName as FeatureNameType,
} from "./domain/Feature.ts"

export class InvalidFeatureLifecycleTransition extends Data.TaggedError(
  "InvalidFeatureLifecycleTransition",
)<{
  readonly name: FeatureNameType
  readonly currentStatus: FeatureLifecycleStatus
  readonly nextStatus: FeatureLifecycleStatus
}> {
  readonly message = `Feature "${this.name}" cannot transition from "${this.currentStatus}" to "${this.nextStatus}".`
}

const canTransitionLifecycleStatus = (
  currentStatus: FeatureLifecycleStatus,
  nextStatus: FeatureLifecycleStatus,
) =>
  (currentStatus === "active" && nextStatus === "paused") ||
  (currentStatus === "paused" && nextStatus === "active")

const updateLifecycleStatus = (
  feature: Feature,
  nextStatus: FeatureLifecycleStatus,
) => {
  if (!canTransitionLifecycleStatus(feature.lifecycleStatus, nextStatus)) {
    return Effect.fail(
      new InvalidFeatureLifecycleTransition({
        name: feature.name,
        currentStatus: feature.lifecycleStatus,
        nextStatus,
      }),
    )
  }

  return FeatureStore.update(
    feature.update({ lifecycleStatus: nextStatus }),
  ).pipe(
    Effect.map((updatedFeature) => ({
      previousStatus: feature.lifecycleStatus,
      updatedFeature,
    })),
  )
}

export const pauseFeature = Effect.fnUntraced(function* (name: string) {
  const featureName = FeatureName.makeUnsafe(name)
  const feature = yield* FeatureStore.load(featureName)

  if (Option.isNone(feature)) {
    return yield* new FeatureNotFound({ name: featureName })
  }

  return yield* updateLifecycleStatus(feature.value, "paused")
})

export const resumeFeature = Effect.fnUntraced(function* (name: string) {
  const featureName = FeatureName.makeUnsafe(name)
  const feature = yield* FeatureStore.load(featureName)

  if (Option.isNone(feature)) {
    return yield* new FeatureNotFound({ name: featureName })
  }

  return yield* updateLifecycleStatus(feature.value, "active")
})
