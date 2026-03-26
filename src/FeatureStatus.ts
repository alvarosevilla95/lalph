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

export type FeatureStatusResolution = {
  readonly status: FeatureDisplayStatus
  readonly reason: string
}

type FeatureStatusDependencies =
  | FeatureFinalPrLookup
  | IssueSource
  | FeatureStorageRoot
  | FileSystem.FileSystem
  | Path.Path

type FeatureStatusError = PlatformError.PlatformError | IssueSourceError

type FeatureStatusEffect<A> = Effect.Effect<
  A,
  FeatureStatusError,
  FeatureStatusDependencies
>

type FeatureStatusImplementation = {
  readonly resolve: (
    feature: Feature,
  ) => FeatureStatusEffect<FeatureDisplayStatus>
  readonly resolveWithReason: (
    feature: Feature,
  ) => FeatureStatusEffect<FeatureStatusResolution>
}

type FeatureStatusTestImplementation =
  | Pick<FeatureStatusImplementation, "resolve">
  | Pick<FeatureStatusImplementation, "resolveWithReason">
  | FeatureStatusImplementation

const makeResolution = (
  status: FeatureDisplayStatus,
  reason: string,
): FeatureStatusResolution => ({
  status,
  reason,
})

const withReasonPrefix = (
  resolution: FeatureStatusResolution,
  prefix: string,
): FeatureStatusResolution =>
  prefix.length === 0
    ? resolution
    : makeResolution(resolution.status, `${prefix} ${resolution.reason}`)

const deriveDisplayStatusFromLifecycle = (
  lifecycleStatus: FeatureLifecycleStatus,
): Option.Option<FeatureStatusResolution> => {
  switch (lifecycleStatus) {
    case "draft":
      return Option.some(
        makeResolution(
          "draft",
          "Persisted lifecycle status is draft, so the feature remains draft until it is activated.",
        ),
      )
    case "paused":
      return Option.some(
        makeResolution(
          "paused",
          "Persisted lifecycle status is paused, so the feature remains paused until it is resumed.",
        ),
      )
    case "cancelled":
      return Option.some(
        makeResolution(
          "cancelled",
          "Persisted lifecycle status is cancelled, so the feature remains cancelled.",
        ),
      )
    default:
      return Option.none()
  }
}

const deriveExecutionStatusFromIssueSource = (
  parentIssueSourceId: string,
  issues: ReadonlyArray<IssueSourceIssueLike>,
): FeatureStatusResolution => {
  const hasIncomplete = issues.some((issue) => issue.state !== "done")
  if (!hasIncomplete) {
    return makeResolution(
      "ready",
      `All child issues under ${parentIssueSourceId} are done, so the feature is ready for final integration.`,
    )
  }

  const hasActive = issues.some(
    (issue) => issue.state === "in-progress" || issue.state === "in-review",
  )
  const hasRunnable = issues.some(
    (issue) => issue.state === "todo" && issue.blockedBy.length === 0,
  )

  if (hasActive) {
    return makeResolution(
      "active",
      `Child issues under ${parentIssueSourceId} are already in progress or review, so the feature is active.`,
    )
  }

  if (hasRunnable) {
    return makeResolution(
      "active",
      `Child issues under ${parentIssueSourceId} still have runnable todo work, so the feature is active.`,
    )
  }

  return makeResolution(
    "blocked",
    `Child issues under ${parentIssueSourceId} are incomplete, but none are runnable, so the feature is blocked.`,
  )
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
): FeatureStatusResolution => {
  const implementationPlan = extractImplementationPlan(content)
  if (implementationPlan === null) {
    return makeResolution(
      "active",
      "Feature spec does not contain a `## Implementation Plan` section, so Ralph-mode status falls back to active.",
    )
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
    return makeResolution(
      "active",
      "Feature spec does not contain tracked implementation-plan tasks, so Ralph-mode status falls back to active.",
    )
  }
  if (hasPending) {
    return makeResolution(
      "active",
      "Feature spec still has unchecked implementation-plan tasks, so the feature is active.",
    )
  }
  if (hasBlocked) {
    return makeResolution(
      "blocked",
      "Feature spec only has blocked implementation-plan tasks remaining, so the feature is blocked.",
    )
  }
  return makeResolution(
    "ready",
    "All tracked implementation-plan tasks in the feature spec are complete, so the feature is ready for final integration.",
  )
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

const resolveWithReasonImpl = Effect.fn("FeatureStatus.resolveWithReason")(
  function* (
    feature: Feature,
  ): Effect.fn.Return<
    FeatureStatusResolution,
    FeatureStatusError,
    FeatureStatusDependencies
  > {
    const lifecycleOverride = deriveDisplayStatusFromLifecycle(
      feature.lifecycleStatus,
    )
    if (Option.isSome(lifecycleOverride)) {
      return lifecycleOverride.value
    }

    let executionReasonPrefix = ""
    if (feature.finalIntegrationPrId) {
      const finalPrState = yield* FeatureFinalPrLookup.lookup(
        feature.finalIntegrationPrId,
      )
      if (Option.isSome(finalPrState)) {
        switch (finalPrState.value) {
          case "merged":
            return makeResolution(
              "complete",
              `Final integration PR ${feature.finalIntegrationPrId} is merged, so the feature is complete.`,
            )
          case "open":
            return makeResolution(
              "integrating",
              `Final integration PR ${feature.finalIntegrationPrId} is open, so the feature is integrating.`,
            )
          case "closed":
            executionReasonPrefix = `Final integration PR ${feature.finalIntegrationPrId} is closed without merge, so reconciliation falls back to execution progress.`
            break
        }
      }
    }

    if (feature.executionMode === "pr") {
      if (!feature.parentIssueSourceId) {
        return withReasonPrefix(
          makeResolution(
            "active",
            "PR-mode feature has no parent issue source ID, so the feature stays active until child work can be reconciled.",
          ),
          executionReasonPrefix,
        )
      }

      const source = yield* IssueSource
      const issues = yield* source.issues(feature.projectId)
      return withReasonPrefix(
        deriveExecutionStatusFromIssueSource(
          feature.parentIssueSourceId,
          filterIssuesByParentIssueSourceId(
            issues,
            feature.parentIssueSourceId,
          ),
        ),
        executionReasonPrefix,
      )
    }

    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const root = yield* FeatureStorageRoot
    const specFile = pathService.isAbsolute(feature.specFilePath)
      ? pathService.normalize(feature.specFilePath)
      : pathService.join(root, feature.specFilePath)
    const content = yield* fs.readFileString(specFile)
    return withReasonPrefix(
      deriveExecutionStatusFromSpec(content),
      executionReasonPrefix,
    )
  },
)

const resolveImpl = Effect.fn("FeatureStatus.resolve")(function* (
  feature: Feature,
): Effect.fn.Return<
  FeatureDisplayStatus,
  FeatureStatusError,
  FeatureStatusDependencies
> {
  const resolution = yield* resolveWithReasonImpl(feature)
  return resolution.status
})

const normalizeTestImplementation = (
  implementation: FeatureStatusTestImplementation,
): FeatureStatusImplementation => {
  if ("resolve" in implementation && "resolveWithReason" in implementation) {
    return implementation
  }

  if ("resolveWithReason" in implementation) {
    return {
      resolveWithReason: implementation.resolveWithReason,
      resolve: (feature) =>
        implementation
          .resolveWithReason(feature)
          .pipe(Effect.map((resolution) => resolution.status)),
    }
  }

  return {
    resolve: implementation.resolve,
    resolveWithReason: (feature) =>
      implementation
        .resolve(feature)
        .pipe(
          Effect.map((status) =>
            makeResolution(status, `Feature resolved to ${status}.`),
          ),
        ),
  }
}

export class FeatureStatus extends ServiceMap.Service<
  FeatureStatus,
  FeatureStatusImplementation
>()("lalph/FeatureStatus") {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      resolve: resolveImpl,
      resolveWithReason: resolveWithReasonImpl,
    }),
  )

  static layerTest(
    implementation: FeatureStatusTestImplementation,
  ): Layer.Layer<FeatureStatus> {
    return Layer.succeed(
      this,
      this.of(normalizeTestImplementation(implementation)),
    )
  }

  static resolve(feature: Feature) {
    return this.use((service) => service.resolve(feature))
  }

  static resolveWithReason(feature: Feature) {
    return this.use((service) => service.resolveWithReason(feature))
  }
}
