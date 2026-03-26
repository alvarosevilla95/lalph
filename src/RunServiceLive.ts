import { RunService } from "./RunService.ts"
import {
  executeRunAll,
  executeRunFeature,
  executeRunIssues,
} from "./commands/root.ts"

export const RunServiceLive = RunService.layerTest({
  runAll: executeRunAll,
  runIssues: executeRunIssues,
  runFeature: executeRunFeature,
})
