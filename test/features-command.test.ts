import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, it } from "node:test"
import { Effect, Option } from "effect"
import { Command } from "effect/unstable/cli"
import { FeatureCreateWizard } from "../src/FeatureCreation.ts"
import {
  FeatureBranchBootstrap,
  FeatureBranchBootstrapFailed,
  FeatureParentIssueBootstrap,
  FeatureParentIssueBootstrapFailed,
} from "../src/FeatureCreationBootstrap.ts"
import { FeatureEditWizard } from "../src/FeatureEditing.ts"
import { InvalidFeatureLifecycleTransition } from "../src/FeatureLifecycle.ts"
import { FeatureStatus } from "../src/FeatureStatus.ts"
import {
  FeatureAlreadyExists,
  FeatureNotFound,
  FeatureStorageRoot,
  FeatureStore,
} from "../src/FeatureStore.ts"
import { commandFeatures } from "../src/commands/features.ts"
import {
  Feature,
  type FeatureDisplayStatus,
  FeatureName,
} from "../src/domain/Feature.ts"
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
  const directory = await mkdtemp(
    path.join(tmpdir(), "lalph-features-command-"),
  )
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
    ...overrides,
  })

const makeProject = (id = "project-alpha") =>
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

const runFeaturesCommand = (
  directory: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly wizardInput?: Parameters<typeof FeatureCreateWizard.layerTest>[0]
    readonly editWizardInput?: Parameters<typeof FeatureEditWizard.layerTest>[0]
    readonly featureStatuses?: Record<string, FeatureDisplayStatus>
    readonly featureBranchBootstrap?: FeatureBranchBootstrap["Service"]
    readonly featureParentIssueBootstrap?: FeatureParentIssueBootstrap["Service"]
  },
) => {
  let effect = Command.runWith(commandFeatures, { version: "test" })(args).pipe(
    Effect.provide(PlatformServices),
    Effect.provide(FeatureStorageRoot.layerAt(directory)),
    Effect.provide(FeatureStore.layerAt(directory)),
    Effect.provide(
      FeatureStatus.layerTest({
        resolve: (feature) =>
          Effect.succeed(
            (options?.featureStatuses?.[String(feature.name)] ??
              feature.lifecycleStatus) as FeatureDisplayStatus,
          ),
      }),
    ),
  )

  effect = effect.pipe(
    Effect.provide(
      options?.wizardInput
        ? FeatureCreateWizard.layerTest(options.wizardInput)
        : FeatureCreateWizard.layer,
    ),
    Effect.provide(
      options?.editWizardInput
        ? FeatureEditWizard.layerTest(options.editWizardInput)
        : FeatureEditWizard.layer,
    ),
    Effect.provide(
      FeatureBranchBootstrap.layerTest(
        options?.featureBranchBootstrap ?? {
          ensure: () => Effect.succeed({ created: false }),
          delete: () => Effect.void,
        },
      ),
    ),
    Effect.provide(
      FeatureParentIssueBootstrap.layerTest(
        options?.featureParentIssueBootstrap ?? {
          create: () => Effect.succeed({ id: "LIN-100" }),
          cancel: () => Effect.void,
        },
      ),
    ),
  )

  return effect
}

const captureConsoleLogs = async <A>(f: () => Promise<A>) => {
  const logs: Array<string> = []
  const originalLog = console.log

  console.log = (...args) => {
    logs.push(args.map(String).join(" "))
  }

  try {
    const result = await f()
    return {
      output: logs.join("\n"),
      result,
    }
  } finally {
    console.log = originalLog
  }
}

describe("features commands", () => {
  it("shows a helpful empty state for features ls", async () => {
    const directory = await makeTempDirectory()

    const { output } = await captureConsoleLogs(() =>
      Effect.runPromise(runFeaturesCommand(directory, ["ls"])),
    )

    assert.equal(
      output,
      "No features configured yet. Run 'lalph features create' to get started.",
    )
  })

  it("lists persisted feature metadata with features ls", async () => {
    const directory = await makeTempDirectory()
    const alpha = makeFeature("alpha", {
      executionMode: "pr",
      lifecycleStatus: "active",
    })
    const beta = makeFeature("beta", {
      projectId: ProjectId.makeUnsafe("project-beta"),
      executionMode: "ralph",
      baseBranch: "develop",
      featureBranch: "feature/beta",
      specFilePath: ".specs/beta.md",
      lifecycleStatus: "paused",
    })

    await seedFeatures(directory, [beta, alpha])

    const { output } = await captureConsoleLogs(() =>
      Effect.runPromise(
        runFeaturesCommand(directory, ["ls"], {
          featureStatuses: {
            alpha: "ready",
            beta: "paused",
          },
        }),
      ),
    )

    assert.match(output, /Feature: alpha/)
    assert.match(output, /  Project: project-alpha/)
    assert.match(output, /  Execution mode: pr/)
    assert.match(output, /  Base branch: master/)
    assert.match(output, /  Feature branch: feature\/alpha/)
    assert.match(output, /  Spec file: \.specs\/alpha\.md/)
    assert.match(output, /  Status: ready/)
    assert.match(output, /Feature: beta/)
    assert.match(output, /  Project: project-beta/)
    assert.match(output, /  Execution mode: ralph/)
    assert.match(output, /  Base branch: develop/)
    assert.match(output, /  Status: paused/)
    assert.ok(
      output.indexOf("Feature: alpha") < output.indexOf("Feature: beta"),
    )
  })

  it("shows full stored metadata for one feature", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-inspect", {
      lifecycleStatus: "draft",
      parentIssueSourceId: "LIN-101",
      finalIntegrationPrId: "github:42",
    })

    await seedFeatures(directory, [feature])

    const { output } = await captureConsoleLogs(() =>
      Effect.runPromise(
        runFeaturesCommand(directory, ["show", "feature-inspect"], {
          featureStatuses: {
            "feature-inspect": "integrating",
          },
        }),
      ),
    )

    assert.match(output, /Feature: feature-inspect/)
    assert.match(output, /  Project: project-alpha/)
    assert.match(output, /  Execution mode: pr/)
    assert.match(output, /  Spec file: \.specs\/feature-inspect\.md/)
    assert.match(output, /  Base branch: master/)
    assert.match(output, /  Feature branch: feature\/feature-inspect/)
    assert.match(output, /  Display status: integrating/)
    assert.match(output, /  Persisted lifecycle status: draft/)
    assert.match(output, /  Parent issue source ID: LIN-101/)
    assert.match(output, /  Final integration PR ID: github:42/)
  })

  it("fails clearly for unknown feature names", async () => {
    const directory = await makeTempDirectory()

    const exit = await Effect.runPromiseExit(
      runFeaturesCommand(directory, ["show", "missing-feature"]),
    )

    assert.equal(exit._tag, "Failure")
    assert.ok(exit.cause.reasons[0]?.error instanceof FeatureNotFound)
    assert.equal(
      exit.cause.reasons[0]?.error.message,
      'Feature "missing-feature" was not found.',
    )
  })

  it("updates feature metadata successfully through features edit", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-edit", {
      executionMode: "pr",
      specFilePath: ".specs/feature-edit.md",
      baseBranch: "master",
      featureBranch: "feature/feature-edit",
      lifecycleStatus: "active",
      parentIssueSourceId: "LIN-202",
    })

    await seedFeatures(directory, [feature])

    const { output } = await captureConsoleLogs(() =>
      Effect.runPromise(
        runFeaturesCommand(directory, ["edit", "feature-edit"], {
          editWizardInput: {
            executionMode: "ralph",
            specFilePath: ".specs/feature-edit-updated.md",
            baseBranch: "develop",
            featureBranch: "feature/feature-edit-v2",
            lifecycleStatus: "paused",
            openSpecFile: false,
          },
        }),
      ),
    )

    assert.match(output, /Updated feature: feature-edit/)
    assert.match(output, /  Execution mode: ralph/)
    assert.match(output, /  Base branch: develop/)
    assert.match(output, /  Feature branch: feature\/feature-edit-v2/)
    assert.match(output, /  Spec file: \.specs\/feature-edit-updated\.md/)
    assert.match(output, /  Lifecycle status: paused/)

    const storedFeature = Feature.decodeSync(
      await readFile(
        path.join(directory, ".lalph", "features", "feature-edit.json"),
        "utf8",
      ),
    )
    assert.deepEqual(
      storedFeature,
      new Feature({
        name: FeatureName.makeUnsafe("feature-edit"),
        projectId: ProjectId.makeUnsafe("project-alpha"),
        executionMode: "ralph",
        specFilePath: ".specs/feature-edit-updated.md",
        baseBranch: "develop",
        featureBranch: "feature/feature-edit-v2",
        lifecycleStatus: "paused",
        parentIssueSourceId: "LIN-202",
      }),
    )
  })

  it("fails clearly for unknown feature names in features edit", async () => {
    const directory = await makeTempDirectory()

    const exit = await Effect.runPromiseExit(
      runFeaturesCommand(directory, ["edit", "missing-feature"]),
    )

    assert.equal(exit._tag, "Failure")
    assert.ok(exit.cause.reasons[0]?.error instanceof FeatureNotFound)
    assert.equal(
      exit.cause.reasons[0]?.error.message,
      'Feature "missing-feature" was not found.',
    )
  })

  it("pauses an active feature", async () => {
    const directory = await makeTempDirectory()
    await seedFeatures(directory, [makeFeature("feature-pause")])

    const { output } = await captureConsoleLogs(() =>
      Effect.runPromise(
        runFeaturesCommand(directory, ["pause", "feature-pause"]),
      ),
    )

    assert.match(output, /Paused feature: feature-pause/)
    assert.match(output, /  Lifecycle status: active -> paused/)

    const persistedFeature = Feature.decodeSync(
      await readFile(
        path.join(directory, ".lalph", "features", "feature-pause.json"),
        "utf8",
      ),
    )

    assert.equal(persistedFeature.lifecycleStatus, "paused")
  })

  it("resumes a paused feature", async () => {
    const directory = await makeTempDirectory()
    await seedFeatures(directory, [
      makeFeature("feature-resume", { lifecycleStatus: "paused" }),
    ])

    const { output } = await captureConsoleLogs(() =>
      Effect.runPromise(
        runFeaturesCommand(directory, ["resume", "feature-resume"]),
      ),
    )

    assert.match(output, /Resumed feature: feature-resume/)
    assert.match(output, /  Lifecycle status: paused -> active/)

    const persistedFeature = Feature.decodeSync(
      await readFile(
        path.join(directory, ".lalph", "features", "feature-resume.json"),
        "utf8",
      ),
    )

    assert.equal(persistedFeature.lifecycleStatus, "active")
  })

  it("fails clearly for unknown feature names in features pause and resume", async () => {
    const directory = await makeTempDirectory()

    const pauseExit = await Effect.runPromiseExit(
      runFeaturesCommand(directory, ["pause", "missing-feature"]),
    )
    const resumeExit = await Effect.runPromiseExit(
      runFeaturesCommand(directory, ["resume", "missing-feature"]),
    )

    assert.equal(pauseExit._tag, "Failure")
    assert.equal(resumeExit._tag, "Failure")
    assert.ok(pauseExit.cause.reasons[0]?.error instanceof FeatureNotFound)
    assert.ok(resumeExit.cause.reasons[0]?.error instanceof FeatureNotFound)
    assert.equal(
      pauseExit.cause.reasons[0]?.error.message,
      'Feature "missing-feature" was not found.',
    )
    assert.equal(
      resumeExit.cause.reasons[0]?.error.message,
      'Feature "missing-feature" was not found.',
    )
  })

  it("refuses invalid pause and resume lifecycle transitions", async () => {
    const directory = await makeTempDirectory()
    await seedFeatures(directory, [
      makeFeature("feature-draft", { lifecycleStatus: "draft" }),
      makeFeature("feature-complete", { lifecycleStatus: "complete" }),
    ])

    const pauseExit = await Effect.runPromiseExit(
      runFeaturesCommand(directory, ["pause", "feature-draft"]),
    )
    const resumeExit = await Effect.runPromiseExit(
      runFeaturesCommand(directory, ["resume", "feature-complete"]),
    )

    assert.equal(pauseExit._tag, "Failure")
    assert.equal(resumeExit._tag, "Failure")
    assert.ok(
      pauseExit.cause.reasons[0]?.error instanceof
        InvalidFeatureLifecycleTransition,
    )
    assert.ok(
      resumeExit.cause.reasons[0]?.error instanceof
        InvalidFeatureLifecycleTransition,
    )
    assert.equal(
      pauseExit.cause.reasons[0]?.error.message,
      'Feature "feature-draft" cannot transition from "draft" to "paused".',
    )
    assert.equal(
      resumeExit.cause.reasons[0]?.error.message,
      'Feature "feature-complete" cannot transition from "complete" to "active".',
    )
  })

  it("persists only the changed metadata when editing a feature", async () => {
    const directory = await makeTempDirectory()
    const feature = makeFeature("feature-persist", {
      finalIntegrationPrId: "github:77",
      lifecycleStatus: "draft",
    })

    await seedFeatures(directory, [feature])

    await captureConsoleLogs(() =>
      Effect.runPromise(
        runFeaturesCommand(directory, ["edit", "feature-persist"], {
          editWizardInput: {
            executionMode: "pr",
            specFilePath: ".specs/feature-persist.md",
            baseBranch: "release",
            featureBranch: "feature/feature-persist",
            lifecycleStatus: "complete",
            openSpecFile: false,
          },
        }),
      ),
    )

    const persistedFeature = Feature.decodeSync(
      await readFile(
        path.join(directory, ".lalph", "features", "feature-persist.json"),
        "utf8",
      ),
    )

    assert.equal(persistedFeature.baseBranch, "release")
    assert.equal(persistedFeature.lifecycleStatus, "complete")
    assert.equal(persistedFeature.executionMode, "pr")
    assert.equal(persistedFeature.finalIntegrationPrId, "github:77")
  })

  it("creates a PR-mode feature and bootstraps its branch, parent issue, and spec file", async () => {
    const directory = await makeTempDirectory()
    const branchCalls: Array<{ baseBranch: string; featureBranch: string }> = []
    const parentCalls: Array<{
      featureName: string
      baseBranch: string
      featureBranch: string
      specFilePath: string
    }> = []
    const wizardInput = {
      project: makeProject(),
      executionMode: "pr" as const,
      name: "feature-create",
      baseBranch: "master",
      featureBranch: "feature/feature-create",
      specFilePath: ".specs/feature-create.md",
      specFileSource: "new" as const,
    }

    const { output } = await captureConsoleLogs(() =>
      Effect.runPromise(
        runFeaturesCommand(directory, ["create"], {
          wizardInput,
          featureBranchBootstrap: {
            ensure: (options) => {
              branchCalls.push(options)
              return Effect.succeed({ created: true })
            },
            delete: () => Effect.void,
          },
          featureParentIssueBootstrap: {
            create: (options) => {
              parentCalls.push(options)
              return Effect.succeed({ id: "LIN-101" })
            },
            cancel: () => Effect.void,
          },
        }),
      ),
    )

    assert.match(output, /Created feature: feature-create/)
    assert.match(output, /  Lifecycle status: active/)
    assert.match(output, /  Parent issue source ID: LIN-101/)
    assert.deepEqual(branchCalls, [
      {
        baseBranch: "master",
        featureBranch: "feature/feature-create",
      },
    ])
    assert.deepEqual(parentCalls, [
      {
        featureName: "feature-create",
        baseBranch: "master",
        featureBranch: "feature/feature-create",
        specFilePath: ".specs/feature-create.md",
        executionMode: "pr",
        projectId: ProjectId.makeUnsafe("project-alpha"),
      },
    ])

    const featureFiles = await readdir(
      path.join(directory, ".lalph", "features"),
    )
    assert.deepEqual(featureFiles, ["feature-create.json"])

    const storedFeature = Feature.decodeSync(
      await readFile(
        path.join(directory, ".lalph", "features", "feature-create.json"),
        "utf8",
      ),
    )
    assert.deepEqual(
      storedFeature,
      new Feature({
        name: FeatureName.makeUnsafe("feature-create"),
        projectId: ProjectId.makeUnsafe("project-alpha"),
        executionMode: "pr",
        specFilePath: ".specs/feature-create.md",
        baseBranch: "master",
        featureBranch: "feature/feature-create",
        lifecycleStatus: "active",
        parentIssueSourceId: "LIN-101",
      }),
    )

    const specFile = await readFile(
      path.join(directory, ".specs", "feature-create.md"),
      "utf8",
    )
    assert.match(specFile, /^# feature-create/m)
    assert.match(
      specFile,
      /Planned pr-mode feature created with `lalph features create`\./,
    )
  })

  it("keeps Ralph-mode feature creation spec-only apart from branch bootstrap", async () => {
    const directory = await makeTempDirectory()
    const branchCalls: Array<{ baseBranch: string; featureBranch: string }> = []
    const wizardInput = {
      project: makeProject(),
      executionMode: "ralph" as const,
      name: "feature-ralph-create",
      baseBranch: "master",
      featureBranch: "feature/feature-ralph-create",
      specFilePath: ".specs/feature-ralph-create.md",
      specFileSource: "new" as const,
    }

    await captureConsoleLogs(() =>
      Effect.runPromise(
        runFeaturesCommand(directory, ["create"], {
          wizardInput,
          featureBranchBootstrap: {
            ensure: (options) => {
              branchCalls.push(options)
              return Effect.succeed({ created: false })
            },
            delete: () => Effect.void,
          },
          featureParentIssueBootstrap: {
            create: () => Effect.die("unexpected parent issue bootstrap"),
            cancel: () => Effect.void,
          },
        }),
      ),
    )

    assert.deepEqual(branchCalls, [
      {
        baseBranch: "master",
        featureBranch: "feature/feature-ralph-create",
      },
    ])

    const storedFeature = Feature.decodeSync(
      await readFile(
        path.join(directory, ".lalph", "features", "feature-ralph-create.json"),
        "utf8",
      ),
    )

    assert.equal(storedFeature.executionMode, "ralph")
    assert.equal(storedFeature.parentIssueSourceId, undefined)
  })

  it("rolls back local feature state when branch bootstrap fails", async () => {
    const directory = await makeTempDirectory()
    const exit = await Effect.runPromiseExit(
      runFeaturesCommand(directory, ["create"], {
        wizardInput: {
          project: makeProject(),
          executionMode: "pr",
          name: "feature-branch-failure",
          baseBranch: "master",
          featureBranch: "feature/feature-branch-failure",
          specFilePath: ".specs/feature-branch-failure.md",
          specFileSource: "new",
        },
        featureBranchBootstrap: {
          ensure: () =>
            Effect.fail(
              new FeatureBranchBootstrapFailed({
                baseBranch: "master",
                featureBranch: "feature/feature-branch-failure",
                cause: new Error("boom"),
              }),
            ),
          delete: () => Effect.void,
        },
      }),
    )

    assert.equal(exit._tag, "Failure")
    assert.ok(
      exit.cause.reasons[0]?.error instanceof FeatureBranchBootstrapFailed,
    )
    assert.equal(
      exit.cause.reasons[0]?.error.message,
      'Failed to create or verify feature branch "feature/feature-branch-failure" from base branch "master".',
    )

    await assert.rejects(() =>
      readFile(
        path.join(directory, ".specs", "feature-branch-failure.md"),
        "utf8",
      ),
    )
    await assert.rejects(() =>
      readFile(
        path.join(
          directory,
          ".lalph",
          "features",
          "feature-branch-failure.json",
        ),
        "utf8",
      ),
    )
  })

  it("rolls back the spec and created branch when parent issue bootstrap fails", async () => {
    const directory = await makeTempDirectory()
    const deletedBranches: Array<string> = []

    const exit = await Effect.runPromiseExit(
      runFeaturesCommand(directory, ["create"], {
        wizardInput: {
          project: makeProject(),
          executionMode: "pr",
          name: "feature-parent-failure",
          baseBranch: "master",
          featureBranch: "feature/feature-parent-failure",
          specFilePath: ".specs/feature-parent-failure.md",
          specFileSource: "new",
        },
        featureBranchBootstrap: {
          ensure: () => Effect.succeed({ created: true }),
          delete: (featureBranch) => {
            deletedBranches.push(featureBranch)
            return Effect.void
          },
        },
        featureParentIssueBootstrap: {
          create: () =>
            Effect.fail(
              new FeatureParentIssueBootstrapFailed({
                featureName: "feature-parent-failure",
                cause: new Error("boom"),
              }),
            ),
          cancel: () => Effect.void,
        },
      }),
    )

    assert.equal(exit._tag, "Failure")
    assert.ok(
      exit.cause.reasons[0]?.error instanceof FeatureParentIssueBootstrapFailed,
    )
    assert.equal(
      exit.cause.reasons[0]?.error.message,
      'Failed to create the parent issue-source item for feature "feature-parent-failure".',
    )
    assert.deepEqual(deletedBranches, ["feature/feature-parent-failure"])

    await assert.rejects(() =>
      readFile(
        path.join(directory, ".specs", "feature-parent-failure.md"),
        "utf8",
      ),
    )
    await assert.rejects(() =>
      readFile(
        path.join(
          directory,
          ".lalph",
          "features",
          "feature-parent-failure.json",
        ),
        "utf8",
      ),
    )
  })

  it("fails clearly when the feature already exists", async () => {
    const directory = await makeTempDirectory()
    const existingFeature = makeFeature("feature-create")
    await seedFeatures(directory, [existingFeature])

    const exit = await Effect.runPromiseExit(
      runFeaturesCommand(directory, ["create"], {
        wizardInput: {
          project: makeProject(),
          executionMode: "ralph",
          name: "feature-create",
          baseBranch: "master",
          featureBranch: "feature/feature-create",
          specFilePath: ".specs/duplicate.md",
          specFileSource: "new",
        },
      }),
    )

    assert.equal(exit._tag, "Failure")
    assert.ok(exit.cause.reasons[0]?.error instanceof FeatureAlreadyExists)
    assert.equal(
      exit.cause.reasons[0]?.error.message,
      'Feature "feature-create" already exists.',
    )

    const featureFiles = await readdir(
      path.join(directory, ".lalph", "features"),
    )
    assert.deepEqual(featureFiles, ["feature-create.json"])

    await assert.rejects(() =>
      readFile(path.join(directory, ".specs", "duplicate.md"), "utf8"),
    )
  })
})
