import { Effect, Layer, ServiceMap } from "effect"
import type { Feature } from "./domain/Feature.ts"
import type { RunCommandOptions } from "./commands/run/options.ts"
import type { executeRunAll, executeRunIssues } from "./commands/root.ts"

export interface RunFeatureOptions extends RunCommandOptions {
  readonly feature: Feature
}

export interface RunServiceImplementation {
  readonly runAll: (
    options: RunCommandOptions,
  ) => ReturnType<typeof executeRunAll>
  readonly runIssues: (
    options: RunCommandOptions,
  ) => ReturnType<typeof executeRunIssues>
  readonly runFeature: (options: RunFeatureOptions) => Effect.Effect<void>
}

export class RunService extends ServiceMap.Service<
  RunService,
  RunServiceImplementation
>()("lalph/RunService") {
  static layerTest(implementation: RunServiceImplementation) {
    return Layer.succeed(this, implementation)
  }

  static runAll(options: RunCommandOptions) {
    return this.use((service) => service.runAll(options))
  }

  static runIssues(options: RunCommandOptions) {
    return this.use((service) => service.runIssues(options))
  }

  static runFeature(options: RunFeatureOptions) {
    return this.use((service) => service.runFeature(options))
  }
}
