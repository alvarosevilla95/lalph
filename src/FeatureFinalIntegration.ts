import {
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  ServiceMap,
} from "effect"
import { GithubCli } from "./Github/Cli.ts"
import { Worktree } from "./Worktree.ts"
import { FeatureFinalPrLookup, FeatureStatus } from "./FeatureStatus.ts"
import {
  FeatureNotFound,
  FeatureStorageRoot,
  FeatureStore,
  InvalidFeatureFile,
} from "./FeatureStore.ts"
import type { Feature } from "./domain/Feature.ts"
import { IssueSource, type IssueSourceError } from "./IssueSource.ts"
import type * as PlatformError from "effect/PlatformError"

const FinalIntegrationPr = Schema.Struct({
  number: Schema.Finite,
  state: Schema.String,
})
type FinalIntegrationPr = typeof FinalIntegrationPr.Type

const FinalIntegrationPrList = Schema.fromJsonString(
  Schema.Array(FinalIntegrationPr),
)

export class FeatureFinalIntegrationClientError extends Data.TaggedError(
  "FeatureFinalIntegrationClientError",
)<{
  readonly cause: unknown
}> {}

const normalizePrState = (
  state: string,
): "open" | "closed" | "merged" | undefined => {
  switch (state.toUpperCase()) {
    case "OPEN":
      return "open"
    case "CLOSED":
      return "closed"
    case "MERGED":
      return "merged"
    default:
      return undefined
  }
}

const formatPrId = (prNumber: number) => `github:${prNumber}` as const

const parseCreatedPrNumber = (output: string) =>
  Effect.try({
    try: () => {
      const match = output.trim().match(/\/pull\/(\d+)\s*$/)
      if (!match) {
        throw new Error(`Unable to parse PR number from: ${output}`)
      }
      return Number.parseInt(match[1]!, 10)
    },
    catch: (cause) => new FeatureFinalIntegrationClientError({ cause }),
  })

const selectExistingPr = (
  prs: ReadonlyArray<FinalIntegrationPr>,
): Option.Option<{
  readonly pr: FinalIntegrationPr
  readonly action: "use" | "reopen"
}> => {
  const sorted = prs.toSorted((left, right) => right.number - left.number)

  const open = sorted.find((pr) => normalizePrState(pr.state) === "open")
  if (open) {
    return Option.some({ pr: open, action: "use" })
  }

  const merged = sorted.find((pr) => normalizePrState(pr.state) === "merged")
  if (merged) {
    return Option.some({ pr: merged, action: "use" })
  }

  const closed = sorted.find((pr) => normalizePrState(pr.state) === "closed")
  return closed ? Option.some({ pr: closed, action: "reopen" }) : Option.none()
}

const persistFinalPrId = Effect.fn("FeatureFinalIntegration.persistFinalPrId")(
  function* (feature: Feature, finalIntegrationPrId: string) {
    if (feature.finalIntegrationPrId === finalIntegrationPrId) {
      return feature
    }

    const updated = feature.update({ finalIntegrationPrId })
    yield* FeatureStore.update(updated)
    return updated
  },
)

export class FeatureFinalIntegrationPrClient extends ServiceMap.Service<
  FeatureFinalIntegrationPrClient,
  {
    readonly listByBranches: (
      feature: Feature,
    ) => Effect.Effect<
      ReadonlyArray<FinalIntegrationPr>,
      PlatformError.PlatformError | FeatureFinalIntegrationClientError
    >
    readonly reopen: (
      prNumber: number,
    ) => Effect.Effect<void, PlatformError.PlatformError>
    readonly create: (
      feature: Feature,
    ) => Effect.Effect<
      number,
      PlatformError.PlatformError | FeatureFinalIntegrationClientError
    >
  }
>()("lalph/FeatureFinalIntegrationPrClient") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const github = yield* GithubCli
      const worktree = yield* Worktree

      const listByBranches = Effect.fn(
        "FeatureFinalIntegrationPrClient.listByBranches",
      )(function* (feature: Feature) {
        const headRef = `${github.owner}:${feature.featureBranch}`
        const output =
          yield* worktree.execString`gh pr list --head ${headRef} --base ${feature.baseBranch} --state all --json number,state`

        return yield* Effect.try({
          try: () => Schema.decodeUnknownSync(FinalIntegrationPrList)(output),
          catch: (cause) => new FeatureFinalIntegrationClientError({ cause }),
        })
      })

      const reopen = Effect.fn("FeatureFinalIntegrationPrClient.reopen")(
        function* (prNumber: number) {
          yield* worktree.exec`gh pr reopen ${prNumber}`
        },
      )

      const create = Effect.fn("FeatureFinalIntegrationPrClient.create")(
        function* (feature: Feature) {
          const headRef = `${github.owner}:${feature.featureBranch}`
          const title = `Integrate feature: ${feature.name}`
          const body = [
            `Automated final integration PR for feature \`${feature.name}\`.`,
            ``,
            `- Feature branch: \`${feature.featureBranch}\``,
            `- Base branch: \`${feature.baseBranch}\``,
            `- Execution mode: \`${feature.executionMode}\``,
          ].join("\n")

          const output =
            yield* worktree.execString`gh pr create --base ${feature.baseBranch} --head ${headRef} --title ${title} --body ${body}`

          return yield* parseCreatedPrNumber(output)
        },
      )

      return { listByBranches, reopen, create } as const
    }),
  ).pipe(Layer.provide([GithubCli.layer, Worktree.layerLocal]))

  static layerTest(
    implementation: FeatureFinalIntegrationPrClient["Service"],
  ): Layer.Layer<FeatureFinalIntegrationPrClient> {
    return Layer.succeed(this, implementation)
  }

  static listByBranches(feature: Feature) {
    return this.use((service) => service.listByBranches(feature))
  }

  static reopen(prNumber: number) {
    return this.use((service) => service.reopen(prNumber))
  }

  static create(feature: Feature) {
    return this.use((service) => service.create(feature))
  }
}

export class FeatureFinalIntegration extends ServiceMap.Service<
  FeatureFinalIntegration,
  {
    readonly reconcile: (
      feature: Feature,
    ) => Effect.Effect<
      Feature,
      | PlatformError.PlatformError
      | FeatureFinalIntegrationClientError
      | FeatureNotFound
      | InvalidFeatureFile
      | IssueSourceError,
      | FeatureFinalIntegrationPrClient
      | FeatureFinalPrLookup
      | FeatureStatus
      | FeatureStore
      | FeatureStorageRoot
      | FileSystem.FileSystem
      | IssueSource
      | Path.Path
    >
  }
>()("lalph/FeatureFinalIntegration") {
  static readonly layer = Layer.succeed(
    this,
    this.of({
      reconcile: Effect.fn("FeatureFinalIntegration.reconcile")(function* (
        feature: Feature,
      ) {
        const status = yield* FeatureStatus.resolve(feature)
        if (status !== "ready") {
          return feature
        }

        const existingPr = selectExistingPr(
          yield* FeatureFinalIntegrationPrClient.listByBranches(feature),
        )

        if (Option.isSome(existingPr)) {
          if (existingPr.value.action === "reopen") {
            yield* FeatureFinalIntegrationPrClient.reopen(
              existingPr.value.pr.number,
            )
          }

          return yield* persistFinalPrId(
            feature,
            formatPrId(existingPr.value.pr.number),
          )
        }

        const prNumber = yield* FeatureFinalIntegrationPrClient.create(feature)
        return yield* persistFinalPrId(feature, formatPrId(prNumber))
      }),
    }),
  )

  static layerTest(
    implementation: FeatureFinalIntegration["Service"],
  ): Layer.Layer<FeatureFinalIntegration> {
    return Layer.succeed(this, implementation)
  }

  static reconcile(feature: Feature) {
    return this.use((service) => service.reconcile(feature))
  }
}
