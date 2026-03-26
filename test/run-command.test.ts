import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { Effect, Option } from "effect"
import { Command } from "effect/unstable/cli"
import { appCommand } from "../src/app.ts"
import { FeatureStorageRoot, FeatureStore } from "../src/FeatureStore.ts"
import { RunService } from "../src/RunService.ts"
import { executeRunFeatureWith } from "../src/commands/root.ts"
import { Feature, FeatureName } from "../src/domain/Feature.ts"
import { ProjectId } from "../src/domain/Project.ts"
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

const seedFeatures = (directory: string, features: ReadonlyArray<Feature>) =>
  Effect.runPromise(
    Effect.forEach(features, (feature) => FeatureStore.create(feature)).pipe(
      Effect.provide(FeatureStore.layerAt(directory)),
    ),
  )

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
      executeRunFeatureWith(({ feature, targetBranch }) =>
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
      ),
    )

    assert.deepEqual(calls, [
      "feature:feature-ralph:ralph:feature/ralph-target",
    ])
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
      executeRunFeatureWith(({ specFile, targetBranch }) =>
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
      ),
    )

    assert.deepEqual(calls, [
      `${path.join(directory, ".specs/nested/feature-spec-path.md")}:feature/spec-path`,
    ])
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
