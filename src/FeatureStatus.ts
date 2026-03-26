import {
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  ServiceMap,
} from "effect"
import {
  Feature,
  type FeatureDisplayStatus,
  type FeatureLifecycleStatus,
} from "./domain/Feature.ts"
import { FeatureStorageRoot } from "./FeatureStore.ts"
import { IssueSource, type IssueSourceError } from "./IssueSource.ts"
import { filterIssuesByParentIssueSourceId } from "./IssueSourceScope.ts"
import { Worktree } from "./Worktree.ts"
import type * as PlatformError from "effect/PlatformError"

const FeatureExecutionStatus = Schema.Literals(["active", "blocked", "ready"])
type FeatureExecutionStatus = typeof FeatureExecutionStatus.Type

const FeatureFinalPrState = Schema.Literals(["open", "merged", "closed"])
type FeatureFinalPrState = typeof FeatureFinalPrState.Type

const taskListPrefix = String.raw`(?:[-*]|\d+\.)`
const completedTaskPattern = new RegExp(
  String.raw`^\s*${taskListPrefix}\s+\[x\]\s+`,
  "i",
)
const pendingTaskPattern = new RegExp(
  String.raw`^\s*${taskListPrefix}\s+\[\s\]\s+`,
)
const blockedTaskPattern = new RegExp(
  String.raw`^\s*${taskListPrefix}\s+(?:\[(?:-|~|!)\]|\[blocked\])\s+`,
  "i",
)

const finalPrIdPattern = /^github:(\d+)$/

const deriveDisplayStatusFromLifecycle = (
  lifecycleStatus: FeatureLifecycleStatus,
): Option.Option<FeatureDisplayStatus> => {
  switch (lifecycleStatus) {
    case "draft":
      return Option.some("draft")
    case "paused":
      return Option.some("paused")
    case "cancelled":
      return Option.some("cancelled")
    default:
      return Option.none()
  }
}

const deriveExecutionStatusFromIssueSource = (
  issues: ReadonlyArray<IssueSourceIssueLike>,
): FeatureExecutionStatus => {
  const hasIncomplete = issues.some((issue) => issue.state !== "done")
  if (!hasIncomplete) {
    return "ready"
  }

  const hasActive = issues.some(
    (issue) => issue.state === "in-progress" || issue.state === "in-review",
  )
  const hasRunnable = issues.some(
    (issue) => issue.state === "todo" && issue.blockedBy.length === 0,
  )

  if (hasActive || hasRunnable) {
    return "active"
  }

  return "blocked"
}

const extractImplementationPlan = (content: string): string | null => {
  const sectionStart = content.match(/^## Implementation Plan\s*$/m)
  if (!sectionStart || sectionStart.index === undefined) {
    return null
  }

  const section = content.slice(sectionStart.index + sectionStart[0].length)
  const nextSection = section.match(/^##\s+/m)
  return nextSection && nextSection.index !== undefined
    ? section.slice(0, nextSection.index)
    : section
}

const deriveExecutionStatusFromSpec = (
  content: string,
): FeatureExecutionStatus => {
  const implementationPlan = extractImplementationPlan(content)
  if (implementationPlan === null) {
    return "active"
  }

  let sawTrackedTask = false
  let hasPending = false
  let hasBlocked = false

  for (const line of implementationPlan.split(/\r?\n/)) {
    if (completedTaskPattern.test(line)) {
      sawTrackedTask = true
      continue
    }
    if (pendingTaskPattern.test(line)) {
      sawTrackedTask = true
      hasPending = true
      continue
    }
    if (blockedTaskPattern.test(line)) {
      sawTrackedTask = true
      hasBlocked = true
    }
  }

  if (!sawTrackedTask) {
    return "active"
  }
  if (hasPending) {
    return "active"
  }
  if (hasBlocked) {
    return "blocked"
  }
  return "ready"
}

const parseFinalPrNumber = (finalIntegrationPrId: string) => {
  const value = finalIntegrationPrId.match(finalPrIdPattern)?.[1]
  if (!value) {
    return Option.none<number>()
  }

  const prNumber = Number(value)
  return Number.isFinite(prNumber)
    ? Option.some(prNumber)
    : Option.none<number>()
}

type IssueSourceIssueLike = {
  readonly state: "backlog" | "todo" | "in-progress" | "in-review" | "done"
  readonly blockedBy: ReadonlyArray<string>
}

export class FeatureFinalPrLookup extends ServiceMap.Service<
  FeatureFinalPrLookup,
  {
    readonly lookup: (
      finalIntegrationPrId: string,
    ) => Effect.Effect<
      Option.Option<FeatureFinalPrState>,
      PlatformError.PlatformError
    >
  }
>()("lalph/FeatureFinalPrLookup") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const worktree = yield* Worktree

      const lookup = Effect.fn("FeatureFinalPrLookup.lookup")(function* (
        finalIntegrationPrId: string,
      ): Effect.fn.Return<
        Option.Option<FeatureFinalPrState>,
        PlatformError.PlatformError
      > {
        const prNumber = parseFinalPrNumber(finalIntegrationPrId)
        if (Option.isNone(prNumber)) {
          return Option.none()
        }

        const prState = yield* worktree.viewPrState(prNumber.value)
        if (Option.isNone(prState)) {
          return Option.none()
        }

        switch (prState.value.state) {
          case "OPEN":
            return Option.some("open")
          case "MERGED":
            return Option.some("merged")
          default:
            return Option.some("closed")
        }
      })

      return { lookup } as const
    }),
  ).pipe(Layer.provide(Worktree.layerLocal))

  static layerTest(
    implementation: FeatureFinalPrLookup["Service"],
  ): Layer.Layer<FeatureFinalPrLookup> {
    return Layer.succeed(this, implementation)
  }

  static lookup(finalIntegrationPrId: string) {
    return this.use((service) => service.lookup(finalIntegrationPrId))
  }
}

export class FeatureStatus extends ServiceMap.Service<
  FeatureStatus,
  {
    readonly resolve: (
      feature: Feature,
    ) => Effect.Effect<
      FeatureDisplayStatus,
      PlatformError.PlatformError | IssueSourceError,
      | FeatureFinalPrLookup
      | IssueSource
      | FeatureStorageRoot
      | FileSystem.FileSystem
      | Path.Path
    >
  }
>()("lalph/FeatureStatus") {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      resolve: Effect.fn("FeatureStatus.resolve")(function* (
        feature: Feature,
      ): Effect.fn.Return<
        FeatureDisplayStatus,
        PlatformError.PlatformError | IssueSourceError,
        | FeatureFinalPrLookup
        | IssueSource
        | FeatureStorageRoot
        | FileSystem.FileSystem
        | Path.Path
      > {
        const lifecycleOverride = deriveDisplayStatusFromLifecycle(
          feature.lifecycleStatus,
        )
        if (Option.isSome(lifecycleOverride)) {
          return lifecycleOverride.value
        }

        if (feature.finalIntegrationPrId) {
          const finalPrState = yield* FeatureFinalPrLookup.lookup(
            feature.finalIntegrationPrId,
          )
          if (Option.isSome(finalPrState)) {
            switch (finalPrState.value) {
              case "merged":
                return "complete"
              case "open":
                return "integrating"
              case "closed":
                break
            }
          }
        }

        if (feature.executionMode === "pr") {
          if (!feature.parentIssueSourceId) {
            return "active"
          }

          const source = yield* IssueSource
          const issues = yield* source.issues(feature.projectId)
          return deriveExecutionStatusFromIssueSource(
            filterIssuesByParentIssueSourceId(
              issues,
              feature.parentIssueSourceId,
            ),
          )
        }

        const fs = yield* FileSystem.FileSystem
        const pathService = yield* Path.Path
        const root = yield* FeatureStorageRoot
        const specFile = pathService.isAbsolute(feature.specFilePath)
          ? pathService.normalize(feature.specFilePath)
          : pathService.join(root, feature.specFilePath)
        const content = yield* fs.readFileString(specFile)
        return deriveExecutionStatusFromSpec(content)
      }),
    }),
  )
  static layerTest(
    implementation: FeatureStatus["Service"],
  ): Layer.Layer<FeatureStatus> {
    return Layer.succeed(this, implementation)
  }

  static resolve(feature: Feature) {
    return this.use((service) => service.resolve(feature))
  }
}
