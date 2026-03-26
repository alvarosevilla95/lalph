import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { Effect, Layer, Option } from "effect"
import {
  FeatureFinalPrLookup,
  FeatureStatus,
  type FeatureStatusResolution,
} from "../src/FeatureStatus.ts"
import { FeatureStorageRoot } from "../src/FeatureStore.ts"
import { IssueSource } from "../src/IssueSource.ts"
import { Feature, FeatureName } from "../src/domain/Feature.ts"
import { PrdIssue } from "../src/domain/PrdIssue.ts"
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

const provideFeatureStatusLayers =
  <A, E, R>(
    directory: string,
    options?: {
      readonly issues?: ReadonlyArray<PrdIssue>
      readonly finalPrStates?: Record<string, "open" | "merged" | "closed">
    },
  ) =>
  (effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(PlatformServices),
      Effect.provide(FeatureStorageRoot.layerAt(directory)),
      Effect.provide(FeatureStatus.layer),
      Effect.provide(finalPrLookupLayer(options?.finalPrStates ?? {})),
      Effect.provide(issueSourceLayer(options?.issues ?? [])),
    )

const runResolve = (
  directory: string,
  feature: Feature,
  options?: {
    readonly issues?: ReadonlyArray<PrdIssue>
    readonly finalPrStates?: Record<string, "open" | "merged" | "closed">
  },
) =>
  Effect.runPromise(
    provideFeatureStatusLayers(
      directory,
      options,
    )(FeatureStatus.resolve(feature)),
  )

const runResolveWithReason = (
  directory: string,
  feature: Feature,
  options?: {
    readonly issues?: ReadonlyArray<PrdIssue>
    readonly finalPrStates?: Record<string, "open" | "merged" | "closed">
  },
) =>
  Effect.runPromise(
    provideFeatureStatusLayers(
      directory,
      options,
    )(FeatureStatus.resolveWithReason(feature)),
  )

describe("FeatureStatus", () => {
  it("prefers the persisted lifecycle override and explains why", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-draft", {
      lifecycleStatus: "draft",
      finalIntegrationPrId: "github:42",
    })

    const resolution = await runResolveWithReason(directory, feature, {
      finalPrStates: {
        "github:42": "merged",
      },
    })

    assert.deepEqual(resolution, {
      status: "draft",
      reason:
        "Persisted lifecycle status is draft, so the feature remains draft until it is activated.",
    } satisfies FeatureStatusResolution)
  })

  it("explains final integration PR state when the PR is open", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-integrating", {
      finalIntegrationPrId: "github:42",
    })

    const resolution = await runResolveWithReason(directory, feature, {
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

    assert.deepEqual(resolution, {
      status: "integrating",
      reason:
        "Final integration PR github:42 is open, so the feature is integrating.",
    } satisfies FeatureStatusResolution)
  })

  it("explains PR-mode child issue reconciliation when child work is blocked", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-blocked")

    const resolution = await runResolveWithReason(directory, feature, {
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

    assert.deepEqual(resolution, {
      status: "blocked",
      reason:
        "Child issues under LIN-101 are incomplete, but none are runnable, so the feature is blocked.",
    } satisfies FeatureStatusResolution)
  })

  it("explains Ralph-mode spec reconciliation from the implementation plan", async () => {
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

    const resolution = await runResolveWithReason(
      directory,
      makeFeature("feature-ralph", {
        executionMode: "ralph",
        parentIssueSourceId: undefined,
        specFilePath: ".specs/feature-ralph.md",
      }),
    )

    assert.deepEqual(resolution, {
      status: "ready",
      reason:
        "All tracked implementation-plan tasks in the feature spec are complete, so the feature is ready for final integration.",
    } satisfies FeatureStatusResolution)
  })

  it("still resolves complete when the final integration PR has merged", async () => {
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
})
