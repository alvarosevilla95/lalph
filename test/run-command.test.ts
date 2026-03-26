import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { Effect, Option } from "effect"
import { Command } from "effect/unstable/cli"
import { appCommand } from "../src/app.ts"
import {
  FeatureFinalIntegration,
  FeatureFinalIntegrationPrClient,
} from "../src/FeatureFinalIntegration.ts"
import { FeatureStatus } from "../src/FeatureStatus.ts"
import { FeatureStorageRoot, FeatureStore } from "../src/FeatureStore.ts"
import { RunService } from "../src/RunService.ts"
import {
  executeRunAllWith,
  executeRunFeatureWith,
  FeatureParentIssueSourceIdMissing,
} from "../src/commands/root.ts"
import { Feature, FeatureName } from "../src/domain/Feature.ts"
import { Project, ProjectId } from "../src/domain/Project.ts"
import { PlatformServices } from "../src/shared/platform.ts"

const tempDirectories: Array<string> = []

after(async () => {
  await Promise.all(
    tempDirectories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  )
})

const makeTempDirectory = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lalph-run-command-"))
  tempDirectories.push(directory)
  return directory
}

const makeFeature = (name: string) =>
  new Feature({
    name: FeatureName.makeUnsafe(name),
    projectId: ProjectId.makeUnsafe("project-alpha"),
    executionMode: "pr",
    specFilePath: `.specs/${name}.md`,
    baseBranch: "master",
    featureBranch: `feature/${name}`,
    lifecycleStatus: "active",
  })

const makeProject = (id: string) =>
  new Project({
    id: ProjectId.makeUnsafe(id),
    enabled: true,
    targetBranch: Option.some("master"),
    concurrency: 1,
    gitFlow: "pr",
    researchAgent: false,
    reviewAgent: false,
  })

const seedFeatures = (directory: string, features: ReadonlyArray<Feature>) =>
  Effect.runPromise(
    Effect.forEach(features, (feature) => FeatureStore.create(feature)).pipe(
      Effect.provide(FeatureStore.layerAt(directory)),
    ),
  )

const loadFeature = (directory: string, name: string) =>
  Effect.runPromise(
    FeatureStore.load(FeatureName.makeUnsafe(name)).pipe(
      Effect.provide(FeatureStore.layerAt(directory)),
    ),
  )

const featureStatusLayer = (statuses: Record<string, string>) =>
  FeatureStatus.layerTest({
    resolve: (feature) =>
      Effect.succeed(
        (statuses[String(feature.name)] ?? "active") as
          | "draft"
          | "active"
          | "paused"
          | "blocked"
          | "ready"
          | "integrating"
          | "complete"
          | "cancelled",
      ),
  })

const noopFeatureFinalIntegrationLayer = FeatureFinalIntegration.layerTest({
  reconcile: (feature) => Effect.succeed(feature),
})

const runApp = (
  directory: string,
  args: ReadonlyArray<string>,
  runService: Parameters<typeof RunService.layerTest>[0],
) =>
  Command.runWith(appCommand, { version: "test" })(args).pipe(
    Effect.provide(PlatformServices),
    Effect.provide(FeatureStorageRoot.layerAt(directory)),
    Effect.provide(FeatureStore.layerAt(directory)),
    Effect.provide(RunService.layerTest(runService)),
  )

const runOptions = [
  "--iterations",
  "2",
  "--max-minutes",
  "45",
  "--max-context",
  "1200",
  "--stall-minutes",
  "7",
  "--specs",
  "custom-specs",
] as const

describe("run commands", () => {
  it("dispatches bare lalph to run all", async () => {
    const directory = await makeTempDirectory()
    const calls: Array<string> = []
    const expectedSpecsDirectory = path.join(process.cwd(), "custom-specs")

    await Effect.runPromise(
      runApp(directory, runOptions, {
        runAll: (options) =>
          Effect.sync(() => {
            calls.push(`all:${options.specsDirectory}:${options.iterations}`)
          }),
        runIssues: () => Effect.die("unexpected run issues"),
        runFeature: () => Effect.die("unexpected run feature"),
      }),
    )

    assert.deepEqual(calls, [`all:${expectedSpecsDirectory}:2`])
  })

  it("dispatches run issues to the top-level issue target", async () => {
    const directory = await makeTempDirectory()
    const calls: Array<string> = []

    await Effect.runPromise(
      runApp(directory, ["run", "issues", ...runOptions], {
        runAll: () => Effect.die("unexpected run all"),
        runIssues: (options) =>
          Effect.sync(() => {
            calls.push(`issues:${options.stallMinutes}:${options.maxContext}`)
          }),
        runFeature: () => Effect.die("unexpected run feature"),
      }),
    )

    assert.deepEqual(calls, ["issues:7:1200"])
  })

  it("dispatches run feature to the resolved named feature", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-alpha")
    const calls: Array<string> = []

    await seedFeatures(directory, [feature])

    await Effect.runPromise(
      runApp(directory, ["run", "feature", "feature-alpha"], {
        runAll: () => Effect.die("unexpected run all"),
        runIssues: () => Effect.die("unexpected run issues"),
        runFeature: ({ feature, specsDirectory }) =>
          Effect.sync(() => {
            calls.push(
              `feature:${feature.name}:${feature.executionMode}:${feature.baseBranch}:${specsDirectory}`,
            )
          }),
      }),
    )

    assert.deepEqual(calls, ["feature:feature-alpha:pr:master:.specs"])
  })

  it("dispatches Ralph-mode features into the Ralph execution path", async () => {
    const directory = await makeTempDirectory()
    const feature = new Feature({
      ...makeFeature("feature-ralph"),
      executionMode: "ralph",
      featureBranch: "feature/ralph-target",
    })
    const calls: Array<string> = []

    await Effect.runPromise(
      executeRunFeatureWith(
        () => Effect.die("unexpected run feature pr"),
        ({ feature, targetBranch }) =>
          Effect.sync(() => {
            calls.push(
              `feature:${feature.name}:${feature.executionMode}:${Option.getOrUndefined(targetBranch)}`,
            )
          }),
      )({
        feature,
        iterations: 2,
        maxIterationMinutes: 45,
        maxContext: 1200,
        stallMinutes: 7,
        specsDirectory: "ignored-specs-directory",
      }).pipe(
        Effect.provide(PlatformServices),
        Effect.provide(FeatureStorageRoot.layerAt(directory)),
        Effect.provide(noopFeatureFinalIntegrationLayer),
      ),
    )

    assert.deepEqual(calls, [
      "feature:feature-ralph:ralph:feature/ralph-target",
    ])
  })

  it("dispatches PR-mode features into the PR execution path with child scope metadata", async () => {
    const directory = await makeTempDirectory()
    const feature = new Feature({
      ...makeFeature("feature-pr"),
      parentIssueSourceId: "LIN-101",
      featureBranch: "feature/pr-target",
    })
    const calls: Array<string> = []

    await Effect.runPromise(
      executeRunFeatureWith(
        ({ feature, parentIssueSourceId, targetBranch }) =>
          Effect.sync(() => {
            calls.push(
              `feature:${feature.name}:${feature.executionMode}:${parentIssueSourceId}:${Option.getOrUndefined(targetBranch)}`,
            )
          }),
        () => Effect.die("unexpected run feature ralph"),
      )({
        feature,
        iterations: 2,
        maxIterationMinutes: 45,
        maxContext: 1200,
        stallMinutes: 7,
        specsDirectory: "ignored-specs-directory",
      }).pipe(
        Effect.provide(PlatformServices),
        Effect.provide(FeatureStorageRoot.layerAt(directory)),
        Effect.provide(noopFeatureFinalIntegrationLayer),
      ),
    )

    assert.deepEqual(calls, ["feature:feature-pr:pr:LIN-101:feature/pr-target"])
  })

  it("fails clearly when a PR-mode feature is missing its parent issue reference", async () => {
    const directory = await makeTempDirectory()
    const feature = new Feature({
      ...makeFeature("feature-pr-missing-parent"),
      parentIssueSourceId: undefined,
    })

    const exit = await Effect.runPromiseExit(
      executeRunFeatureWith(
        () => Effect.die("unexpected run feature pr"),
        () => Effect.die("unexpected run feature ralph"),
      )({
        feature,
        iterations: 2,
        maxIterationMinutes: 45,
        maxContext: 1200,
        stallMinutes: 7,
        specsDirectory: "ignored-specs-directory",
      }).pipe(
        Effect.provide(PlatformServices),
        Effect.provide(FeatureStorageRoot.layerAt(directory)),
        Effect.provide(noopFeatureFinalIntegrationLayer),
      ),
    )

    assert.equal(exit._tag, "Failure")
    assert.ok(
      exit.cause.reasons[0]?.error instanceof FeatureParentIssueSourceIdMissing,
    )
    assert.equal(
      exit.cause.reasons[0]?.error.message,
      'Feature "feature-pr-missing-parent" is configured with executionMode="pr" but is missing "parentIssueSourceId". Update the feature metadata before running it.',
    )
  })

  it("resolves Ralph feature spec paths from stored feature metadata", async () => {
    const directory = await makeTempDirectory()
    const feature = new Feature({
      ...makeFeature("feature-spec-path"),
      executionMode: "ralph",
      specFilePath: ".specs/nested/feature-spec-path.md",
      featureBranch: "feature/spec-path",
    })
    const calls: Array<string> = []

    await Effect.runPromise(
      executeRunFeatureWith(
        () => Effect.die("unexpected run feature pr"),
        ({ specFile, targetBranch }) =>
          Effect.sync(() => {
            calls.push(`${specFile}:${Option.getOrUndefined(targetBranch)}`)
          }),
      )({
        feature,
        iterations: 1,
        maxIterationMinutes: 30,
        maxContext: undefined,
        stallMinutes: 5,
        specsDirectory: "custom-specs-directory",
      }).pipe(
        Effect.provide(PlatformServices),
        Effect.provide(FeatureStorageRoot.layerAt(directory)),
        Effect.provide(noopFeatureFinalIntegrationLayer),
      ),
    )

    assert.deepEqual(calls, [
      `${path.join(directory, ".specs/nested/feature-spec-path.md")}:feature/spec-path`,
    ])
  })

  it("creates and persists the final integration PR when a PR-mode feature becomes ready", async () => {
    const directory = await makeTempDirectory()
    const feature = new Feature({
      ...makeFeature("feature-pr-ready"),
      parentIssueSourceId: "LIN-101",
    })
    const clientCalls: Array<string> = []

    await seedFeatures(directory, [feature])

    await Effect.runPromise(
      executeRunFeatureWith(
        () => Effect.void,
        () => Effect.die("unexpected run feature ralph"),
      )({
        feature,
        iterations: 1,
        maxIterationMinutes: 30,
        maxContext: 1200,
        stallMinutes: 5,
        specsDirectory: ".specs",
      }).pipe(
        Effect.provide(PlatformServices),
        Effect.provide(FeatureStorageRoot.layerAt(directory)),
        Effect.provide(FeatureStore.layerAt(directory)),
        Effect.provide(featureStatusLayer({ "feature-pr-ready": "ready" })),
        Effect.provide(
          FeatureFinalIntegrationPrClient.layerTest({
            listByBranches: () => Effect.succeed([]),
            reopen: () => Effect.die("unexpected reopen"),
            create: () =>
              Effect.sync(() => {
                clientCalls.push("create")
                return 42
              }),
          }),
        ),
        Effect.provide(FeatureFinalIntegration.layer),
      ),
    )

    const persisted = await loadFeature(directory, "feature-pr-ready")
    assert.ok(Option.isSome(persisted))
    assert.equal(persisted.value.finalIntegrationPrId, "github:42")
    assert.deepEqual(clientCalls, ["create"])
  })

  it("reopens and persists the final integration PR when a Ralph-mode feature becomes ready", async () => {
    const directory = await makeTempDirectory()
    const feature = new Feature({
      ...makeFeature("feature-ralph-ready"),
      executionMode: "ralph",
      parentIssueSourceId: undefined,
      featureBranch: "feature/ralph-ready",
    })
    const clientCalls: Array<string> = []

    await seedFeatures(directory, [feature])

    await Effect.runPromise(
      executeRunFeatureWith(
        () => Effect.die("unexpected run feature pr"),
        () => Effect.void,
      )({
        feature,
        iterations: 1,
        maxIterationMinutes: 30,
        maxContext: 1200,
        stallMinutes: 5,
        specsDirectory: ".specs",
      }).pipe(
        Effect.provide(PlatformServices),
        Effect.provide(FeatureStorageRoot.layerAt(directory)),
        Effect.provide(FeatureStore.layerAt(directory)),
        Effect.provide(featureStatusLayer({ "feature-ralph-ready": "ready" })),
        Effect.provide(
          FeatureFinalIntegrationPrClient.layerTest({
            listByBranches: () =>
              Effect.succeed([
                {
                  number: 77,
                  state: "CLOSED",
                },
              ]),
            reopen: (prNumber) =>
              Effect.sync(() => {
                clientCalls.push(`reopen:${prNumber}`)
              }),
            create: () => Effect.die("unexpected create"),
          }),
        ),
        Effect.provide(FeatureFinalIntegration.layer),
      ),
    )

    const persisted = await loadFeature(directory, "feature-ralph-ready")
    assert.ok(Option.isSome(persisted))
    assert.equal(persisted.value.finalIntegrationPrId, "github:77")
    assert.deepEqual(clientCalls, ["reopen:77"])
  })

  it("does not create a duplicate final integration PR when the feature is already integrating", async () => {
    const directory = await makeTempDirectory()
    const feature = new Feature({
      ...makeFeature("feature-integrating"),
      parentIssueSourceId: "LIN-101",
      finalIntegrationPrId: "github:55",
    })

    await seedFeatures(directory, [feature])

    await Effect.runPromise(
      executeRunFeatureWith(
        () => Effect.void,
        () => Effect.die("unexpected run feature ralph"),
      )({
        feature,
        iterations: 1,
        maxIterationMinutes: 30,
        maxContext: 1200,
        stallMinutes: 5,
        specsDirectory: ".specs",
      }).pipe(
        Effect.provide(PlatformServices),
        Effect.provide(FeatureStorageRoot.layerAt(directory)),
        Effect.provide(FeatureStore.layerAt(directory)),
        Effect.provide(
          featureStatusLayer({ "feature-integrating": "integrating" }),
        ),
        Effect.provide(
          FeatureFinalIntegrationPrClient.layerTest({
            listByBranches: () => Effect.die("unexpected list"),
            reopen: () => Effect.die("unexpected reopen"),
            create: () => Effect.die("unexpected create"),
          }),
        ),
        Effect.provide(FeatureFinalIntegration.layer),
      ),
    )

    const persisted = await loadFeature(directory, "feature-integrating")
    assert.ok(Option.isSome(persisted))
    assert.equal(persisted.value.finalIntegrationPrId, "github:55")
  })

  it("runs enabled projects together with active stored features in the global loop", async () => {
    const calls: Array<string> = []

    await Effect.runPromise(
      Effect.scoped(
        executeRunAllWith(
          () =>
            Effect.succeed([
              makeProject("project-beta"),
              makeProject("project-alpha"),
            ]),
          Effect.succeed([
            makeFeature("feature-zeta"),
            makeFeature("feature-draft").update({ lifecycleStatus: "draft" }),
            makeFeature("feature-alpha"),
            makeFeature("feature-paused").update({ lifecycleStatus: "paused" }),
          ]),
          ({ project }) =>
            Effect.sync(() => {
              calls.push(`project:${project.id}`)
            }),
          ({ feature }) =>
            Effect.sync(() => {
              calls.push(`feature:${feature.name}`)
            }),
        )({
          iterations: 1,
          maxIterationMinutes: 30,
          maxContext: 1200,
          stallMinutes: 5,
          specsDirectory: ".specs",
        }),
      ),
    )

    assert.deepEqual(calls, [
      "project:project-alpha",
      "feature:feature-alpha",
      "project:project-beta",
      "feature:feature-zeta",
    ])
  })

  it("reuses final integration reconciliation from run all for ready active features", async () => {
    const directory = await makeTempDirectory()
    const feature = new Feature({
      ...makeFeature("feature-global-ready"),
      parentIssueSourceId: "LIN-101",
    })

    await seedFeatures(directory, [feature])

    await Effect.runPromise(
      Effect.scoped(
        executeRunAllWith(
          () => Effect.succeed([]),
          FeatureStore.list(),
          () => Effect.die("unexpected project run"),
          executeRunFeatureWith(
            () => Effect.void,
            () => Effect.die("unexpected run feature ralph"),
          ),
        )({
          iterations: 1,
          maxIterationMinutes: 30,
          maxContext: 1200,
          stallMinutes: 5,
          specsDirectory: ".specs",
        }),
      ).pipe(
        Effect.provide(PlatformServices),
        Effect.provide(FeatureStorageRoot.layerAt(directory)),
        Effect.provide(FeatureStore.layerAt(directory)),
        Effect.provide(featureStatusLayer({ "feature-global-ready": "ready" })),
        Effect.provide(
          FeatureFinalIntegrationPrClient.layerTest({
            listByBranches: () => Effect.succeed([]),
            reopen: () => Effect.die("unexpected reopen"),
            create: () => Effect.succeed(88),
          }),
        ),
        Effect.provide(FeatureFinalIntegration.layer),
      ),
    )

    const persisted = await loadFeature(directory, "feature-global-ready")
    assert.ok(Option.isSome(persisted))
    assert.equal(persisted.value.finalIntegrationPrId, "github:88")
  })

  it("dispatches run all to the global entrypoint", async () => {
    const directory = await makeTempDirectory()
    const calls: Array<string> = []

    await Effect.runPromise(
      runApp(directory, ["run", "all", ...runOptions], {
        runAll: (options) =>
          Effect.sync(() => {
            calls.push(
              `all:${options.maxIterationMinutes}:${options.maxContext}`,
            )
          }),
        runIssues: () => Effect.die("unexpected run issues"),
        runFeature: () => Effect.die("unexpected run feature"),
      }),
    )

    assert.deepEqual(calls, ["all:45:1200"])
  })
})
