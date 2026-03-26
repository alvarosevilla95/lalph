import { Effect, Layer, Option, Path, ServiceMap } from "effect"
import { Prompt } from "effect/unstable/cli"
import { Editor } from "./Editor.ts"
import {
  FeatureNotFound,
  FeatureStorageRoot,
  FeatureStore,
} from "./FeatureStore.ts"
import {
  Feature,
  FeatureExecutionMode,
  FeatureLifecycleStatus,
  FeatureName,
} from "./domain/Feature.ts"

export interface FeatureEditInput {
  readonly executionMode: FeatureExecutionMode
  readonly specFilePath: string
  readonly baseBranch: string
  readonly featureBranch: string
  readonly lifecycleStatus: FeatureLifecycleStatus
  readonly openSpecFile: boolean
}

const validateNonEmpty = (label: string) => (input: string) => {
  const trimmed = input.trim()
  if (trimmed.length === 0) {
    return Effect.fail(`${label} cannot be empty`)
  }
  return Effect.succeed(trimmed)
}

const normalizeInput = (input: FeatureEditInput): FeatureEditInput => ({
  ...input,
  specFilePath: input.specFilePath.trim(),
  baseBranch: input.baseBranch.trim(),
  featureBranch: input.featureBranch.trim(),
})

const resolveSpecFilePath = (
  pathService: Path.Path,
  root: string,
  specFilePath: string,
) =>
  pathService.isAbsolute(specFilePath)
    ? pathService.normalize(specFilePath)
    : pathService.join(root, specFilePath)

const promptForFeatureEdit = Effect.fnUntraced(function* (feature: Feature) {
  const executionMode = yield* Prompt.select({
    message: "Execution mode",
    choices: [
      {
        title: "Pull Request",
        description: "Track child work with PRs targeting the feature branch",
        value: "pr",
        selected: feature.executionMode === "pr",
      },
      {
        title: "Ralph",
        description: "Run the feature directly from its spec file",
        value: "ralph",
        selected: feature.executionMode === "ralph",
      },
    ] as const,
  })

  const specFilePath = yield* Prompt.text({
    message: "Spec file path",
    default: feature.specFilePath,
    validate: validateNonEmpty("Spec file path"),
  })

  const baseBranch = yield* Prompt.text({
    message: "Base branch",
    default: feature.baseBranch,
    validate: validateNonEmpty("Base branch"),
  })

  const featureBranch = yield* Prompt.text({
    message: "Feature branch",
    default: feature.featureBranch,
    validate: validateNonEmpty("Feature branch"),
  })

  const lifecycleStatus = yield* Prompt.select({
    message: "Lifecycle status",
    choices: [
      {
        title: "Draft",
        value: "draft",
        selected: feature.lifecycleStatus === "draft",
      },
      {
        title: "Active",
        value: "active",
        selected: feature.lifecycleStatus === "active",
      },
      {
        title: "Paused",
        value: "paused",
        selected: feature.lifecycleStatus === "paused",
      },
      {
        title: "Complete",
        value: "complete",
        selected: feature.lifecycleStatus === "complete",
      },
      {
        title: "Cancelled",
        value: "cancelled",
        selected: feature.lifecycleStatus === "cancelled",
      },
    ] as const,
  })

  const openSpecFile = yield* Prompt.toggle({
    message: "Open the spec file in your editor now?",
    initial: false,
  })

  return {
    executionMode,
    specFilePath,
    baseBranch,
    featureBranch,
    lifecycleStatus,
    openSpecFile,
  } satisfies FeatureEditInput
})

export class FeatureEditWizard extends ServiceMap.Service<FeatureEditWizard>()(
  "lalph/FeatureEditWizard",
  {
    make: Effect.succeed({
      prompt: promptForFeatureEdit,
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make)

  static layerTest(input: FeatureEditInput) {
    return Layer.succeed(this, {
      prompt: (_feature: Feature) => Effect.succeed(input),
    })
  }

  static prompt(feature: Feature) {
    return this.use((wizard) => wizard.prompt(feature))
  }
}

export const editFeature = Effect.fnUntraced(function* (name: string) {
  const featureName = FeatureName.makeUnsafe(name)
  const existingFeature = yield* FeatureStore.load(featureName)

  if (Option.isNone(existingFeature)) {
    return yield* new FeatureNotFound({ name: featureName })
  }

  const input = normalizeInput(
    yield* FeatureEditWizard.prompt(existingFeature.value),
  )
  const updatedFeature = existingFeature.value.update({
    executionMode: input.executionMode,
    specFilePath: input.specFilePath,
    baseBranch: input.baseBranch,
    featureBranch: input.featureBranch,
    lifecycleStatus: input.lifecycleStatus,
  })

  yield* FeatureStore.update(updatedFeature)

  if (input.openSpecFile) {
    const editor = yield* Editor
    const pathService = yield* Path.Path
    const root = yield* FeatureStorageRoot
    yield* editor.edit(
      resolveSpecFilePath(pathService, root, updatedFeature.specFilePath),
    )
  }

  console.log(`Updated feature: ${updatedFeature.name}`)
  console.log(`  Project: ${updatedFeature.projectId}`)
  console.log(`  Execution mode: ${updatedFeature.executionMode}`)
  console.log(`  Base branch: ${updatedFeature.baseBranch}`)
  console.log(`  Feature branch: ${updatedFeature.featureBranch}`)
  console.log(`  Spec file: ${updatedFeature.specFilePath}`)
  console.log(`  Lifecycle status: ${updatedFeature.lifecycleStatus}`)
})
