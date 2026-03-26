import { Effect } from "effect"
import { RunService } from "./RunService.ts"
import { executeRunAll, executeRunIssues } from "./commands/root.ts"

export const RunServiceLive = RunService.layerTest({
  runAll: executeRunAll,
  runIssues: executeRunIssues,
  runFeature: ({ feature }) =>
    Effect.log(
      `Feature "${feature.name}" resolved for ${feature.executionMode}-mode execution. Feature-aware run orchestration is implemented in a later step of the spec.`,
    ),
})
