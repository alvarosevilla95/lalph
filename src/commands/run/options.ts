import { Config } from "effect"
import { Flag } from "effect/unstable/cli"

export interface RunCommandOptions {
  readonly iterations: number
  readonly maxIterationMinutes: number
  readonly maxContext: number | undefined
  readonly stallMinutes: number
  readonly specsDirectory: string
}

export const iterations = Flag.integer("iterations").pipe(
  Flag.withDescription(
    "Limit how many task iterations run per enabled project (default: unlimited). Use -i 1 to run a single iteration and exit.",
  ),
  Flag.withAlias("i"),
  Flag.withDefault(Number.POSITIVE_INFINITY),
)

export const maxIterationMinutes = Flag.integer("max-minutes").pipe(
  Flag.withDescription(
    "Timeout an iteration if execution (and review, if enabled) exceeds this many minutes (default: LALPH_MAX_MINUTES or 90).",
  ),
  Flag.withFallbackConfig(Config.int("LALPH_MAX_MINUTES")),
  Flag.withDefault(90),
)

export const maxContext = Flag.integer("max-context").pipe(
  Flag.withDescription(
    "If the context window reaches this number of tokens, try again (default: LALPH_MAX_CONTEXT or 250,000).",
  ),
  Flag.withFallbackConfig(Config.int("LALPH_MAX_TOKENS")),
  Flag.withDefault(250000),
)

export const stallMinutes = Flag.integer("stall-minutes").pipe(
  Flag.withDescription(
    "Fail an iteration if the agent stops responding for this many minutes (default: LALPH_STALL_MINUTES or 5).",
  ),
  Flag.withFallbackConfig(Config.int("LALPH_STALL_MINUTES")),
  Flag.withDefault(5),
)

export const specsDirectory = Flag.directory("specs").pipe(
  Flag.withDescription(
    "Directory where plan specs are written and read (default: LALPH_SPECS or .specs).",
  ),
  Flag.withAlias("s"),
  Flag.withFallbackConfig(Config.string("LALPH_SPECS")),
  Flag.withDefault(".specs"),
)

export const verbose = Flag.boolean("verbose").pipe(
  Flag.withDescription(
    "Increase log output for debugging. Use -v when you need detailed logs.",
  ),
  Flag.withAlias("v"),
)

export const runCommandFlags = {
  iterations,
  maxIterationMinutes,
  maxContext,
  stallMinutes,
}

export const runCommandSharedFlags = {
  specsDirectory,
}
