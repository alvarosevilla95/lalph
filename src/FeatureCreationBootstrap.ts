import { Data, Effect, Layer, ServiceMap } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { parseBranch } from "./shared/git.ts"
import { IssueSource } from "./IssueSource.ts"
import { PrdIssue } from "./domain/PrdIssue.ts"
import type { ProjectId } from "./domain/Project.ts"
import type { FeatureExecutionMode } from "./domain/Feature.ts"

export class FeatureBranchBootstrapFailed extends Data.TaggedError(
  "FeatureBranchBootstrapFailed",
)<{
  readonly baseBranch: string
  readonly featureBranch: string
  readonly cause: unknown
}> {
  readonly message = `Failed to create or verify feature branch "${this.featureBranch}" from base branch "${this.baseBranch}".`
}

export class FeatureParentIssueBootstrapFailed extends Data.TaggedError(
  "FeatureParentIssueBootstrapFailed",
)<{
  readonly featureName: string
  readonly cause: unknown
}> {
  readonly message = `Failed to create the parent issue-source item for feature "${this.featureName}".`
}

export class FeatureBranchBootstrap extends ServiceMap.Service<
  FeatureBranchBootstrap,
  {
    readonly ensure: (options: {
      readonly baseBranch: string
      readonly featureBranch: string
    }) => Effect.Effect<
      {
        readonly created: boolean
      },
      FeatureBranchBootstrapFailed
    >
    readonly delete: (
      featureBranch: string,
    ) => Effect.Effect<void, FeatureBranchBootstrapFailed>
  }
>()("lalph/FeatureBranchBootstrap") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const provide = Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        spawner,
      )

      const exec = (
        template: TemplateStringsArray,
        ...args: Array<string | number | boolean>
      ) =>
        ChildProcess.make({ stderr: "inherit", stdout: "inherit" })(
          template,
          ...args,
        ).pipe(spawner.exitCode, provide)

      const ensure = Effect.fn("FeatureBranchBootstrap.ensure")(function* ({
        baseBranch,
        featureBranch,
      }: {
        readonly baseBranch: string
        readonly featureBranch: string
      }) {
        const base = parseBranch(baseBranch)
        const feature = parseBranch(featureBranch)

        const wrap = <A>(
          effect: Effect.Effect<A, unknown>,
        ): Effect.Effect<A, FeatureBranchBootstrapFailed> =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new FeatureBranchBootstrapFailed({
                  baseBranch,
                  featureBranch,
                  cause,
                }),
            ),
          )

        yield* wrap(exec`git fetch ${feature.remote}`)
        const featureExists =
          (yield* wrap(
            exec`git ls-remote --exit-code --heads ${feature.remote} ${feature.branch}`,
          )) === 0

        if (featureExists) {
          return { created: false } as const
        }

        yield* wrap(exec`git fetch ${base.remote} ${base.branch}`)

        const created = yield* wrap(
          exec`git push ${feature.remote} ${`refs/remotes/${base.branchWithRemote}:refs/heads/${feature.branch}`}`,
        )

        if (created !== 0) {
          return yield* new FeatureBranchBootstrapFailed({
            baseBranch,
            featureBranch,
            cause: new Error("git push returned a non-zero exit code"),
          })
        }

        return { created: true } as const
      })

      const remove = Effect.fn("FeatureBranchBootstrap.delete")(function* (
        featureBranch: string,
      ) {
        const parsed = parseBranch(featureBranch)
        const exitCode =
          yield* exec`git push ${parsed.remote} --delete ${parsed.branch}`.pipe(
            Effect.mapError(
              (cause) =>
                new FeatureBranchBootstrapFailed({
                  baseBranch: parsed.branch,
                  featureBranch,
                  cause,
                }),
            ),
          )

        if (exitCode !== 0) {
          return yield* new FeatureBranchBootstrapFailed({
            baseBranch: parsed.branch,
            featureBranch,
            cause: new Error("git push --delete returned a non-zero exit code"),
          })
        }
      })

      return { ensure, delete: remove } as const
    }),
  )

  static layerTest(implementation: FeatureBranchBootstrap["Service"]) {
    return Layer.succeed(this, implementation)
  }

  static ensure(options: {
    readonly baseBranch: string
    readonly featureBranch: string
  }) {
    return this.use((service) => service.ensure(options))
  }

  static delete(featureBranch: string) {
    return this.use((service) => service.delete(featureBranch))
  }
}

const renderParentIssueDescription = (options: {
  readonly featureName: string
  readonly executionMode: FeatureExecutionMode
  readonly baseBranch: string
  readonly featureBranch: string
  readonly specFilePath: string
}) =>
  [
    `Parent issue-source item for feature \`${options.featureName}\`.`,
    "",
    `- Execution mode: \`${options.executionMode}\``,
    `- Base branch: \`${options.baseBranch}\``,
    `- Feature branch: \`${options.featureBranch}\``,
    `- Spec file: \`${options.specFilePath}\``,
  ].join("\n")

export class FeatureParentIssueBootstrap extends ServiceMap.Service<
  FeatureParentIssueBootstrap,
  {
    readonly create: (options: {
      readonly projectId: ProjectId
      readonly featureName: string
      readonly executionMode: FeatureExecutionMode
      readonly baseBranch: string
      readonly featureBranch: string
      readonly specFilePath: string
    }) => Effect.Effect<
      {
        readonly id: string
      },
      FeatureParentIssueBootstrapFailed
    >
    readonly cancel: (options: {
      readonly projectId: ProjectId
      readonly issueId: string
    }) => Effect.Effect<void, FeatureParentIssueBootstrapFailed>
  }
>()("lalph/FeatureParentIssueBootstrap") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const source = yield* IssueSource

      const create = Effect.fn("FeatureParentIssueBootstrap.create")(
        function* (options: {
          readonly projectId: ProjectId
          readonly featureName: string
          readonly executionMode: FeatureExecutionMode
          readonly baseBranch: string
          readonly featureBranch: string
          readonly specFilePath: string
        }) {
          const created = yield* source
            .createIssue(
              options.projectId,
              new PrdIssue({
                id: null,
                title: `Feature: ${options.featureName}`,
                description: renderParentIssueDescription(options),
                priority: 0,
                estimate: null,
                state: "backlog",
                blockedBy: [],
                autoMerge: false,
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new FeatureParentIssueBootstrapFailed({
                    featureName: options.featureName,
                    cause,
                  }),
              ),
            )

          return { id: created.id } as const
        },
      )

      const cancel = Effect.fn("FeatureParentIssueBootstrap.cancel")(
        function* (options: {
          readonly projectId: ProjectId
          readonly issueId: string
        }) {
          yield* source.cancelIssue(options.projectId, options.issueId).pipe(
            Effect.mapError(
              (cause) =>
                new FeatureParentIssueBootstrapFailed({
                  featureName: options.issueId,
                  cause,
                }),
            ),
          )
        },
      )

      return { create, cancel } as const
    }),
  )

  static layerTest(implementation: FeatureParentIssueBootstrap["Service"]) {
    return Layer.succeed(this, implementation)
  }

  static create(options: {
    readonly projectId: ProjectId
    readonly featureName: string
    readonly executionMode: FeatureExecutionMode
    readonly baseBranch: string
    readonly featureBranch: string
    readonly specFilePath: string
  }) {
    return this.use((service) => service.create(options))
  }

  static cancel(options: {
    readonly projectId: ProjectId
    readonly issueId: string
  }) {
    return this.use((service) => service.cancel(options))
  }
}
