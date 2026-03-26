import assert from "node:assert/strict"
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { Effect, Layer, Option } from "effect"
import { FeatureFinalPrLookup, FeatureStatus } from "../src/FeatureStatus.ts"
import { FeatureStorageRoot } from "../src/FeatureStore.ts"
import { PrdIssue } from "../src/domain/PrdIssue.ts"
import { Feature, FeatureName } from "../src/domain/Feature.ts"
import { ProjectId } from "../src/domain/Project.ts"
import { IssueSource } from "../src/IssueSource.ts"
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
  const directory = await mkdtemp(path.join(tmpdir(), "lalph-feature-status-"))
  tempDirectories.push(directory)
  return directory
}

const makeFeature = (name: string, overrides: Partial<Feature> = {}) =>
  new Feature({
    name: FeatureName.makeUnsafe(name),
    projectId: ProjectId.makeUnsafe("project-alpha"),
    executionMode: "pr",
    specFilePath: `.specs/${name}.md`,
    baseBranch: "master",
    featureBranch: `feature/${name}`,
    lifecycleStatus: "active",
    parentIssueSourceId: "LIN-101",
    ...overrides,
  })

const makeIssue = (id: string, overrides: Partial<PrdIssue> = {}) =>
  new PrdIssue({
    id,
    title: id,
    description: "",
    priority: 3,
    estimate: null,
    state: "todo",
    blockedBy: [],
    autoMerge: false,
    ...overrides,
  })

const issueSourceLayer = (issues: ReadonlyArray<PrdIssue>) =>
  Layer.succeed(
    IssueSource,
    IssueSource.of({
      ref: () => Effect.die("unexpected ref"),
      issues: () => Effect.succeed(issues),
      findById: () => Effect.die("unexpected findById"),
      createIssue: () => Effect.die("unexpected createIssue"),
      updateIssue: () => Effect.die("unexpected updateIssue"),
      cancelIssue: () => Effect.die("unexpected cancelIssue"),
      reset: Effect.void,
      settings: () => Effect.void,
      info: () => Effect.void,
      issueCliAgentPreset: () => Effect.succeed(Option.none()),
      updateCliAgentPreset: () => Effect.die("unexpected updateCliAgentPreset"),
      cliAgentPresetInfo: () => Effect.die("unexpected cliAgentPresetInfo"),
      ensureInProgress: () => Effect.void,
    }),
  )

const finalPrLookupLayer = (
  states: Record<string, "open" | "merged" | "closed">,
) =>
  FeatureFinalPrLookup.layerTest({
    lookup: (finalIntegrationPrId) =>
      Effect.succeed(
        states[finalIntegrationPrId]
          ? Option.some(states[finalIntegrationPrId]!)
          : Option.none(),
      ),
  })

const runResolve = (
  directory: string,
  feature: Feature,
  options?: {
    readonly issues?: ReadonlyArray<PrdIssue>
    readonly finalPrStates?: Record<string, "open" | "merged" | "closed">
  },
) =>
  Effect.runPromise(
    FeatureStatus.resolve(feature).pipe(
      Effect.provide(PlatformServices),
      Effect.provide(FeatureStorageRoot.layerAt(directory)),
      Effect.provide(FeatureStatus.layer),
      Effect.provide(finalPrLookupLayer(options?.finalPrStates ?? {})),
      Effect.provide(issueSourceLayer(options?.issues ?? [])),
    ),
  )

describe("FeatureStatus", () => {
  it("reports blocked when a PR feature has incomplete child work but nothing runnable", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-blocked")

    const status = await runResolve(directory, feature, {
      issues: [
        makeIssue("LIN-201", {
          parentIssueSourceId: "LIN-101",
          blockedBy: ["LIN-999"],
        }),
        makeIssue("LIN-202", {
          parentIssueSourceId: "LIN-404",
          state: "done",
        }),
      ],
    })

    assert.equal(status, "blocked")
  })

  it("reports ready when all PR child work is done and no final PR exists", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-ready")

    const status = await runResolve(directory, feature, {
      issues: [
        makeIssue("LIN-201", {
          parentIssueSourceId: "LIN-101",
          state: "done",
        }),
        makeIssue("LIN-202", {
          parentIssueSourceId: "LIN-101",
          state: "done",
        }),
      ],
    })

    assert.equal(status, "ready")
  })

  it("reports integrating when the final integration PR is still open", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-integrating", {
      finalIntegrationPrId: "github:42",
    })

    const status = await runResolve(directory, feature, {
      issues: [
        makeIssue("LIN-201", {
          parentIssueSourceId: "LIN-101",
          state: "done",
        }),
      ],
      finalPrStates: {
        "github:42": "open",
      },
    })

    assert.equal(status, "integrating")
  })

  it("reports complete when the final integration PR has merged", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-complete", {
      finalIntegrationPrId: "github:77",
    })

    const status = await runResolve(directory, feature, {
      issues: [
        makeIssue("LIN-201", {
          parentIssueSourceId: "LIN-101",
          state: "todo",
        }),
      ],
      finalPrStates: {
        "github:77": "merged",
      },
    })

    assert.equal(status, "complete")
  })

  it("derives Ralph readiness from the feature spec implementation plan", async () => {
    const directory = await makeTempDirectory()
    const specDirectory = path.join(directory, ".specs")
    await mkdir(specDirectory, { recursive: true })
    await writeFile(
      path.join(specDirectory, "feature-ralph.md"),
      `# Feature Ralph

## Implementation Plan

1. [x] Finish the first task.
2. [x] Finish the second task.
`,
    )

    const status = await runResolve(
      directory,
      makeFeature("feature-ralph", {
        executionMode: "ralph",
        parentIssueSourceId: undefined,
        specFilePath: ".specs/feature-ralph.md",
      }),
    )

    assert.equal(status, "ready")
  })
})
