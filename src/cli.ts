#!/usr/bin/env node

import { Command } from "effect/unstable/cli"
import { Effect, Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { Settings } from "./Settings.ts"
import PackageJson from "../package.json" with { type: "json" }
import { TracingLayer } from "./Tracing.ts"
import { MinimumLogLevel } from "effect/References"
import { PlatformServices } from "./shared/platform.ts"
import { FeatureStorageRoot, FeatureStore } from "./FeatureStore.ts"
import { FeatureCreateWizard } from "./FeatureCreation.ts"
import { FeatureEditWizard } from "./FeatureEditing.ts"
import { RunServiceLive } from "./RunServiceLive.ts"
import { appCommand } from "./app.ts"

appCommand.pipe(
  Command.provide(Settings.layer),
  Command.provide(FeatureCreateWizard.layer),
  Command.provide(FeatureEditWizard.layer),
  Command.provide(FeatureStorageRoot.layer),
  Command.provide(FeatureStore.layer),
  Command.provide(RunServiceLive),
  Command.provide(TracingLayer),
  Command.provide(({ verbose }) => {
    if (!verbose) return Layer.empty
    return Layer.succeed(MinimumLogLevel, "All")
  }),
  Command.run({
    version: PackageJson.version,
  }),
  Effect.provide(PlatformServices),
  NodeRuntime.runMain,
)
