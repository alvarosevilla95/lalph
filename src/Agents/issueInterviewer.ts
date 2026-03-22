import { Data, Effect, FileSystem, Path, pipe } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { PromptGen } from "../PromptGen.ts"
import type { CliAgentPreset } from "../domain/CliAgentPreset.ts"

export class UnsupportedIssueInterviewAgent extends Data.TaggedError(
  "UnsupportedIssueInterviewAgent",
)<{
  readonly agentId: string
}> {
  readonly message = `Interactive issue interviews are not supported for the "${this.agentId}" CLI agent.`
}

export class IssueInterviewFailed extends Data.TaggedError(
  "IssueInterviewFailed",
)<{
  readonly exitCode: number
}> {
  readonly message = `The interactive issue interviewer exited with code ${this.exitCode}.`
}

export const agentIssueInterviewer = Effect.fn("agentIssueInterviewer")(
  function* (options: {
    readonly cwd: string
    readonly projectId: string
    readonly issueSourceName: string
    readonly request: string
    readonly draftPath: string
    readonly preset: CliAgentPreset
  }) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const promptGen = yield* PromptGen
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const cliCommand = options.preset.cliAgent.commandIssue?.({
      prompt: promptGen.promptIssueInterview({
        projectId: options.projectId,
        issueSourceName: options.issueSourceName,
        request: options.request,
        draftPath: pathService.relative(options.cwd, options.draftPath),
      }),
      prdFilePath: (yield* fs.exists(
        pathService.join(options.cwd, ".lalph", "prd.yml"),
      ))
        ? pathService.join(".lalph", "prd.yml")
        : undefined,
      extraArgs: options.preset.extraArgs,
    })

    if (!cliCommand) {
      return yield* new UnsupportedIssueInterviewAgent({
        agentId: options.preset.cliAgent.id,
      })
    }

    const exitCode = yield* pipe(
      cliCommand,
      ChildProcess.setCwd(options.cwd),
      options.preset.withCommandPrefix,
      spawner.exitCode,
    )

    if (exitCode !== 0) {
      return yield* new IssueInterviewFailed({ exitCode })
    }
  },
)
