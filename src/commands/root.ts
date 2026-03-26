import {
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  FiberSet,
  FileSystem,
  Iterable,
  Layer,
  Option,
  Path,
  PlatformError,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { PromptGen } from "../PromptGen.ts"
import { Prd } from "../Prd.ts"
import { Worktree } from "../Worktree.ts"
import { Command, Prompt } from "effect/unstable/cli"
import { IssueSource, IssueSourceError } from "../IssueSource.ts"
import { CurrentIssueSource, resetInProgress } from "../CurrentIssueSource.ts"
import { GithubCli } from "../Github/Cli.ts"
import { agentWorker } from "../Agents/worker.ts"
import { agentChooser, ChosenTaskNotFound } from "../Agents/chooser.ts"
import { RunnerStalled, TaskStateChanged } from "../domain/Errors.ts"
import { agentReviewer } from "../Agents/reviewer.ts"
import { agentTimeout } from "../Agents/timeout.ts"
import { allProjects, CurrentProjectId, Settings } from "../Settings.ts"
import { Atom, AtomRegistry, Reactivity } from "effect/unstable/reactivity"
import {
  activeWorkerLoggingAtom,
  CurrentWorkerState,
  withWorkerState,
} from "../Workers.ts"
import { WorkerStatus } from "../domain/WorkerState.ts"
import {
  GitFlow,
  GitFlowCommit,
  GitFlowError,
  GitFlowPR,
  GitFlowRalph,
  type GitFlowLayer,
} from "../GitFlow.ts"
import {
  getAllProjects,
  projectById,
  ProjectNotFound,
  welcomeWizard,
} from "../Projects.ts"
import type { Project } from "../domain/Project.ts"
import { getDefaultCliAgentPreset } from "../Presets.ts"
import type { QuitError } from "effect/Terminal"
import type { TimeoutError } from "effect/Cause"
import type { ChildProcessSpawner } from "effect/unstable/process"
import type { AiError } from "effect/unstable/ai/AiError"
import type { PrdIssue } from "../domain/PrdIssue.ts"
import type { OutputFormatter } from "clanka"
import { ClankaMuxerLayer, SemanticSearchLayer } from "../Clanka.ts"
import { agentResearcher } from "../Agents/researcher.ts"
import { agentChooserRalph } from "../Agents/chooserRalph.ts"
import { CurrentTask } from "../domain/CurrentTask.ts"
import { RunService } from "../RunService.ts"
import type { RunFeatureOptions } from "../RunService.ts"
import { FeatureStorageRoot } from "../FeatureStore.ts"
import { scopeIssueSourceToParentIssueSourceId } from "../IssueSourceScope.ts"
import { RunTargetBranch } from "../RunTargetBranch.ts"
import {
  runCommandFlags,
  specsDirectory,
  verbose,
  type RunCommandOptions,
} from "./run/options.ts"
// Main iteration run logic

const run = Effect.fnUntraced(
  function* (options: {
    readonly startedDeferred: Deferred.Deferred<void>
    readonly targetBranch: Option.Option<string>
    readonly specsDirectory: string
    readonly stallTimeout: Duration.Duration
    readonly runTimeout: Duration.Duration
    readonly research: boolean
    readonly review: boolean
  }): Effect.fn.Return<
    void,
    | PlatformError.PlatformError
    | Schema.SchemaError
    | IssueSourceError
    | QuitError
    | GitFlowError
    | ChosenTaskNotFound
    | RunnerStalled
    | TimeoutError
    | AiError,
    | CurrentProjectId
    | ChildProcessSpawner.ChildProcessSpawner
    | Settings
    | Reactivity.Reactivity
    | GithubCli
    | IssueSource
    | Prompt.Environment
    | AtomRegistry.AtomRegistry
    | GitFlow
    | CurrentWorkerState
    | PromptGen
    | Prd
    | Worktree
    | OutputFormatter.Muxer
    | Scope.Scope
  > {
    const projectId = yield* CurrentProjectId
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const worktree = yield* Worktree
    const gh = yield* GithubCli
    const prd = yield* Prd
    const source = yield* IssueSource
    const gitFlow = yield* GitFlow
    const currentWorker = yield* CurrentWorkerState
    const registry = yield* AtomRegistry.AtomRegistry

    const preset = yield* getDefaultCliAgentPreset

    // ensure cleanup of branch after run
    yield* Effect.addFinalizer(
      Effect.fnUntraced(function* () {
        const currentBranchName = yield* worktree
          .currentBranch(worktree.directory)
          .pipe(Effect.option, Effect.map(Option.getOrUndefined))
        if (!currentBranchName) return

        // enter detached state
        yield* worktree.exec`git checkout --detach ${currentBranchName}`
        // delete the branch
        yield* worktree.exec`git branch -D ${currentBranchName}`
      }, Effect.ignore()),
    )

    let taskId: string | undefined = undefined

    // setup finalizer to revert issue if we fail
    yield* Effect.addFinalizer(
      Effect.fnUntraced(function* (exit) {
        if (exit._tag === "Success") return
        if (taskId) {
          yield* source.updateIssue({
            projectId,
            issueId: taskId,
            state: "todo",
          })
        } else {
          const prd = yield* Prd
          yield* prd.revertUpdatedIssues
        }
      }, Effect.ignore()),
    )

    // 1. Choose task
    // --------------

    registry.update(currentWorker.state, (s) =>
      s.transitionTo(WorkerStatus.ChoosingTask()),
    )

    const chosenTask = yield* agentChooser({
      stallTimeout: options.stallTimeout,
      preset,
    }).pipe(Effect.withSpan("Main.agentChooser"))

    taskId = chosenTask.id
    yield* source.updateIssue({
      projectId,
      issueId: taskId,
      state: "in-progress",
    })
    yield* prd.setChosenIssueId(taskId)
    yield* prd.setAutoMerge(chosenTask.prd.autoMerge)

    yield* source.ensureInProgress(projectId, taskId).pipe(
      Effect.timeoutOrElse({
        duration: "1 minute",
        orElse: () => Effect.fail(new RunnerStalled()),
      }),
    )

    yield* Deferred.completeWith(options.startedDeferred, Effect.void)

    if (gitFlow.requiresGithubPr && chosenTask.githubPrNumber) {
      yield* worktree.exec`gh pr checkout ${chosenTask.githubPrNumber}`
      const feedback = yield* gh.prFeedbackMd(chosenTask.githubPrNumber)
      yield* fs.writeFileString(
        pathService.join(worktree.directory, ".lalph", "feedback.md"),
        feedback,
      )
    } else if (gitFlow.requiresGithubPr) {
      const branchName = `lalph/${taskId.replace(/#/g, "").replace(/[^a-zA-Z0-9-_]/g, "-")}`
      yield* worktree.exec`git branch -D ${branchName}`
      yield* worktree.exec`git checkout -b ${branchName}`
    }

    const taskPreset = Option.getOrElse(
      yield* source.issueCliAgentPreset(chosenTask.prd),
      () => preset,
    )

    const catchStallInReview = <A, E, R>(
      effect: Effect.Effect<A, E | RunnerStalled, R>,
    ) =>
      Effect.catchIf(
        effect,
        (u): u is RunnerStalled => u instanceof RunnerStalled,
        Effect.fnUntraced(function* (e) {
          const task = yield* source.findById(projectId, taskId!)
          const inReview = task?.state === "in-review"
          if (inReview) return
          return yield* e
        }),
      )

    const cancelled = yield* Effect.gen(function* () {
      //
      // 2. Work on task
      // -----------------------

      registry.update(currentWorker.state, (s) =>
        s.transitionTo(WorkerStatus.Working({ issueId: taskId })),
      )

      let researchResult = Option.none<string>()
      if (options.research) {
        researchResult = yield* agentResearcher({
          task: chosenTask.prd,
          specsDirectory: options.specsDirectory,
          stallTimeout: options.stallTimeout,
          preset: taskPreset,
        })
      }

      const promptGen = yield* PromptGen
      const instructions = taskPreset.cliAgent.command
        ? promptGen.prompt({
            specsDirectory: options.specsDirectory,
            targetBranch: Option.getOrUndefined(options.targetBranch),
            task: chosenTask.prd,
            githubPrNumber: chosenTask.githubPrNumber ?? undefined,
            gitFlow,
          })
        : promptGen.promptClanka({
            specsDirectory: options.specsDirectory,
            targetBranch: Option.getOrUndefined(options.targetBranch),
            task: chosenTask.prd,
            githubPrNumber: chosenTask.githubPrNumber ?? undefined,
            gitFlow,
          })

      const issueSemaphore = Semaphore.makeUnsafe(1)
      const steer = yield* taskUpdateSteer({
        issueId: taskId,
        semaphore: issueSemaphore,
      })

      const exitCode = yield* agentWorker({
        stallTimeout: options.stallTimeout,
        system: promptGen.systemClanka(options),
        preset: taskPreset,
        prompt: instructions,
        research: researchResult,
        steer,
        currentTask: CurrentTask.task({ task: chosenTask.prd }),
      }).pipe(catchStallInReview, Effect.withSpan("Main.agentWorker"))
      yield* Effect.log(`Agent exited with code: ${exitCode}`)

      // 3. Review task
      // -----------------------

      if (options.review) {
        yield* source.updateIssue({
          projectId,
          issueId: taskId,
          state: "in-progress",
        })

        registry.update(currentWorker.state, (s) =>
          s.transitionTo(WorkerStatus.Reviewing({ issueId: taskId })),
        )

        yield* agentReviewer({
          specsDirectory: options.specsDirectory,
          stallTimeout: options.stallTimeout,
          preset: taskPreset,
          instructions,
          currentTask: CurrentTask.task({ task: chosenTask.prd }),
        }).pipe(catchStallInReview, Effect.withSpan("Main.agentReviewer"))

        yield* source.updateIssue({
          projectId,
          issueId: taskId,
          state: "in-review",
        })
      }
    }).pipe(
      Effect.timeout(options.runTimeout),
      Effect.tapErrorTag("TimeoutError", () =>
        agentTimeout({
          specsDirectory: options.specsDirectory,
          stallTimeout: options.stallTimeout,
          preset: taskPreset,
          currentTask: CurrentTask.task({ task: chosenTask.prd }),
        }),
      ),
      Effect.raceFirst(watchTaskState({ issueId: taskId })),
      Effect.as(false),
      Effect.catchTag("TaskStateChanged", (error) =>
        Effect.log(
          `Task ${error.issueId} moved to ${error.state}; cancelling run.`,
        ).pipe(Effect.as(true)),
      ),
    )

    if (cancelled) return

    yield* gitFlow.postWork({
      worktree,
      targetBranch: Option.getOrUndefined(options.targetBranch),
      issueId: taskId,
    })

    const task = yield* source.findById(projectId, taskId)
    if (task?.autoMerge) {
      yield* gitFlow.autoMerge({
        targetBranch: Option.getOrUndefined(options.targetBranch),
        issueId: taskId,
        worktree,
      })
    } else {
      yield* prd.maybeRevertIssue({ issueId: taskId })
    }
  },
  Effect.scoped,
  Effect.provide(SemanticSearchLayer.pipe(Layer.provideMerge(Prd.layer)), {
    local: true,
  }),
)

const runRalph = Effect.fnUntraced(
  function* (options: {
    readonly targetBranch: Option.Option<string>
    readonly stallTimeout: Duration.Duration
    readonly runTimeout: Duration.Duration
    readonly research: boolean
    readonly review: boolean
    readonly specFile: string
    readonly maxContext: number | undefined
    readonly disableProjectOnComplete: boolean
  }): Effect.fn.Return<
    void,
    | PlatformError.PlatformError
    | Schema.SchemaError
    | IssueSourceError
    | QuitError
    | GitFlowError
    | ChosenTaskNotFound
    | RunnerStalled
    | TimeoutError
    | AiError,
    | CurrentProjectId
    | ChildProcessSpawner.ChildProcessSpawner
    | Settings
    | Reactivity.Reactivity
    | GithubCli
    | IssueSource
    | Prompt.Environment
    | AtomRegistry.AtomRegistry
    | GitFlow
    | CurrentWorkerState
    | PromptGen
    | Prd
    | Worktree
    | OutputFormatter.Muxer
    | Scope.Scope
  > {
    const worktree = yield* Worktree
    const gitFlow = yield* GitFlow
    const currentWorker = yield* CurrentWorkerState
    const registry = yield* AtomRegistry.AtomRegistry
    const projectId = yield* CurrentProjectId

    const preset = yield* getDefaultCliAgentPreset

    // ensure cleanup of branch after run
    yield* Effect.addFinalizer(
      Effect.fnUntraced(function* () {
        const currentBranchName = yield* worktree
          .currentBranch(worktree.directory)
          .pipe(Effect.option, Effect.map(Option.getOrUndefined))
        if (!currentBranchName) return

        // enter detached state
        yield* worktree.exec`git checkout --detach ${currentBranchName}`
        // delete the branch
        yield* worktree.exec`git branch -D ${currentBranchName}`
      }, Effect.ignore()),
    )

    // 1. Choose task
    // --------------

    registry.update(currentWorker.state, (s) =>
      s.transitionTo(WorkerStatus.ChoosingTask()),
    )

    const chosenTask = yield* agentChooserRalph({
      stallTimeout: options.stallTimeout,
      preset,
      specFile: options.specFile,
    }).pipe(
      Effect.tapErrorTag(
        "ChosenTaskNotFound",
        options.disableProjectOnComplete
          ? Effect.fnUntraced(function* () {
              // Disable project when all tasks are done.
              yield* Settings.update(
                allProjects,
                Option.map((projects) =>
                  projects.map((p) =>
                    p.id === projectId ? p.update({ enabled: false }) : p,
                  ),
                ),
              )
            })
          : () => Effect.void,
      ),
      Effect.withSpan("Main.chooser"),
    )

    yield* Effect.gen(function* () {
      //
      // 2. Work on task
      // -----------------------

      registry.update(currentWorker.state, (s) =>
        s.transitionTo(WorkerStatus.Working({ issueId: "ralph" })),
      )

      let researchResult = Option.none<string>()
      // if (options.research) {
      //   researchResult = yield* agentResearcher({
      //     task: chosenTask.prd,
      //     specsDirectory: options.specsDirectory,
      //     stallTimeout: options.stallTimeout,
      //     preset: taskPreset,
      //   })
      // }

      const promptGen = yield* PromptGen
      const instructions = promptGen.promptRalph({
        task: chosenTask,
        specFile: options.specFile,
        targetBranch: Option.getOrUndefined(options.targetBranch),
        gitFlow,
      })

      const exitCode = yield* agentWorker({
        stallTimeout: options.stallTimeout,
        preset,
        prompt: instructions,
        research: researchResult,
        maxContext: options.maxContext,
        currentTask: CurrentTask.ralph({
          task: chosenTask,
          specFile: options.specFile,
        }),
      }).pipe(Effect.withSpan("Main.worker"))
      yield* Effect.log(`Agent exited with code: ${exitCode}`)

      // 3. Review task
      // -----------------------

      if (options.review) {
        registry.update(currentWorker.state, (s) =>
          s.transitionTo(WorkerStatus.Reviewing({ issueId: "ralph" })),
        )

        yield* agentReviewer({
          specsDirectory: "",
          stallTimeout: options.stallTimeout,
          preset,
          instructions,
          currentTask: CurrentTask.ralph({
            task: chosenTask,
            specFile: options.specFile,
          }),
        }).pipe(Effect.withSpan("Main.review"))
      }
    }).pipe(
      Effect.timeout(options.runTimeout),
      Effect.tapErrorTag("TimeoutError", () =>
        agentTimeout({
          specsDirectory: "",
          stallTimeout: options.stallTimeout,
          preset,
          currentTask: CurrentTask.ralph({
            task: chosenTask,
            specFile: options.specFile,
          }),
        }),
      ),
    )

    yield* gitFlow.postWork({
      worktree,
      targetBranch: Option.getOrUndefined(options.targetBranch),
      issueId: "",
    })
  },
  Effect.scoped,
  Effect.provide(
    SemanticSearchLayer.pipe(
      Layer.provideMerge([Prd.layerNoop, Worktree.layer]),
    ),
    { local: true },
  ),
)

const executeRalphIterations = Effect.fnUntraced(function* (options: {
  readonly iterations: number
  readonly project: Project
  readonly stallTimeout: Duration.Duration
  readonly runTimeout: Duration.Duration
  readonly maxContext: number | undefined
  readonly targetBranch: Option.Option<string>
  readonly specFile: string
  readonly disableProjectOnComplete: boolean
}) {
  const isFinite = Number.isFinite(options.iterations)
  const iterationsDisplay = isFinite ? options.iterations : "unlimited"
  const semaphore = Semaphore.makeUnsafe(options.project.concurrency)
  const fibers = yield* FiberSet.make()

  yield* Effect.log(
    `Executing ${iterationsDisplay} iteration(s) with concurrency ${options.project.concurrency}`,
  )

  let iteration = 0
  let quit = false

  yield* Atom.mount(activeWorkerLoggingAtom)

  while (true) {
    yield* semaphore.take(1)
    if (quit || (isFinite && iteration >= options.iterations)) {
      break
    }

    const currentIteration = iteration
    const startedDeferred = yield* Deferred.make<void>()
    let ralphDone = false

    const fiber = yield* runRalph({
      targetBranch: options.targetBranch,
      stallTimeout: options.stallTimeout,
      runTimeout: options.runTimeout,
      review: options.project.reviewAgent,
      research: options.project.researchAgent,
      specFile: options.specFile,
      maxContext: options.maxContext,
      disableProjectOnComplete: options.disableProjectOnComplete,
    }).pipe(
      Effect.provide(GitFlowRalph, { local: true }),
      withWorkerState(options.project.id),
      Effect.catchTags({
        ChosenTaskNotFound(_error: ChosenTaskNotFound) {
          ralphDone = true
          return Effect.log(
            `No more work to process for Ralph, ending after ${currentIteration + 1} iteration(s).`,
          )
        },
        QuitError(_error: QuitError) {
          quit = true
          return Effect.void
        },
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning(cause).pipe(
          Effect.andThen(Effect.sleep(Duration.seconds(10))),
        ),
      ),
      Effect.ensuring(semaphore.release(1)),
      Effect.ensuring(Deferred.completeWith(startedDeferred, Effect.void)),
      FiberSet.run(fibers),
    )

    yield* Fiber.await(fiber)
    if (ralphDone) break

    iteration++
  }

  yield* FiberSet.awaitEmpty(fibers)
})

class RalphSpecMissing extends Data.TaggedError("RalphSpecMissing")<{
  readonly projectId: Project["id"]
}> {
  readonly message = `Project "${this.projectId}" is configured with gitFlow="ralph" but is missing "ralphSpec". Run 'lalph projects edit' and set "Path to Ralph spec file".`
}

export class FeatureParentIssueSourceIdMissing extends Data.TaggedError(
  "FeatureParentIssueSourceIdMissing",
)<{
  readonly featureName: string
}> {
  readonly message = `Feature "${this.featureName}" is configured with executionMode="pr" but is missing "parentIssueSourceId". Update the feature metadata before running it.`
}

const executeIssueIterations = Effect.fnUntraced(
  function* (options: {
    readonly iterations: number
    readonly project: Project
    readonly specsDirectory: string
    readonly stallTimeout: Duration.Duration
    readonly runTimeout: Duration.Duration
    readonly targetBranch: Option.Option<string>
    readonly gitFlowLayer: GitFlowLayer
  }) {
    const isFinite = Number.isFinite(options.iterations)
    const iterationsDisplay = isFinite ? options.iterations : "unlimited"
    const semaphore = Semaphore.makeUnsafe(options.project.concurrency)
    const fibers = yield* FiberSet.make()
    const source = yield* IssueSource
    const issuesRef = yield* source.ref(options.project.id)

    const resolveRunEffect = (startedDeferred: Deferred.Deferred<void>) =>
      run({
        startedDeferred,
        targetBranch: options.targetBranch,
        specsDirectory: options.specsDirectory,
        stallTimeout: options.stallTimeout,
        runTimeout: options.runTimeout,
        review: options.project.reviewAgent,
        research: options.project.researchAgent,
      })

    yield* resetInProgress.pipe(Effect.withSpan("Main.resetInProgress"))

    yield* Effect.log(
      `Executing ${iterationsDisplay} iteration(s) with concurrency ${options.project.concurrency}`,
    )

    let iteration = 0
    let quit = false

    yield* Atom.mount(activeWorkerLoggingAtom)

    const waitForWork = SubscriptionRef.changes(issuesRef).pipe(
      Stream.takeUntilEffect(
        Effect.fnUntraced(function* ({ issues }) {
          const hasIncomplete = issues.some(
            (issue) => issue.state === "todo" && issue.blockedBy.length === 0,
          )
          if (hasIncomplete) return true
          if (isFinite) {
            quit = true
            yield* Effect.log(
              `No more work to process, ending after ${iteration} iteration(s).`,
            )
            return yield* Effect.interrupt
          }
          if (Iterable.size(fibers) <= 1) {
            yield* Effect.log("No more work to process")
          }
          return false
        }),
      ),
      Stream.runDrain,
    )

    while (true) {
      yield* semaphore.take(1)
      if (quit || (isFinite && iteration >= options.iterations)) {
        break
      }

      const startedDeferred = yield* Deferred.make<void>()

      yield* waitForWork.pipe(
        Effect.andThen(
          resolveRunEffect(startedDeferred).pipe(
            Effect.provide(options.gitFlowLayer, { local: true }),
            withWorkerState(options.project.id),
          ),
        ),
        Effect.catchTags({
          QuitError(_error: QuitError) {
            quit = true
            return Effect.void
          },
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning(cause).pipe(
            Effect.andThen(Effect.sleep(Duration.seconds(10))),
          ),
        ),
        Effect.ensuring(semaphore.release(1)),
        Effect.ensuring(Deferred.completeWith(startedDeferred, Effect.void)),
        FiberSet.run(fibers),
      )

      yield* Deferred.await(startedDeferred)

      iteration++
    }

    yield* FiberSet.awaitEmpty(fibers)
  },
  (effect, options) =>
    Effect.annotateLogs(effect, {
      project: options.project.id,
    }),
)

const runProject = Effect.fnUntraced(function* (options: {
  readonly iterations: number
  readonly project: Project
  readonly specsDirectory: string
  readonly stallTimeout: Duration.Duration
  readonly runTimeout: Duration.Duration
  readonly maxContext: number | undefined
}) {
  if (options.project.gitFlow === "ralph") {
    if (!options.project.ralphSpec) {
      return yield* new RalphSpecMissing({
        projectId: options.project.id,
      })
    }
    return yield* executeRalphIterations({
      iterations: options.iterations,
      project: options.project,
      stallTimeout: options.stallTimeout,
      runTimeout: options.runTimeout,
      maxContext: options.maxContext,
      targetBranch: options.project.targetBranch,
      specFile: options.project.ralphSpec,
      disableProjectOnComplete: true,
    })
  }

  const resolveGitFlowLayer = () => {
    if (options.project.gitFlow === "commit") {
      return GitFlowCommit
    }
    return GitFlowPR
  }
  yield* executeIssueIterations({
    iterations: options.iterations,
    project: options.project,
    specsDirectory: options.specsDirectory,
    stallTimeout: options.stallTimeout,
    runTimeout: options.runTimeout,
    targetBranch: options.project.targetBranch,
    gitFlowLayer: resolveGitFlowLayer(),
  })
})

// Command

export const executeRunAll = Effect.fnUntraced(
  function* ({
    iterations,
    maxIterationMinutes,
    maxContext,
    stallMinutes,
    specsDirectory,
  }: RunCommandOptions) {
    yield* getDefaultCliAgentPreset

    let allProjects = yield* getAllProjects
    if (allProjects.length === 0) {
      yield* welcomeWizard
      allProjects = yield* getAllProjects
    }

    const projects = allProjects.filter((p) => p.enabled)
    if (projects.length === 0) {
      return yield* Effect.log(
        "No enabled projects found. Run 'lalph projects toggle' to enable one.",
      )
    }
    yield* Effect.forEach(
      projects,
      (project) =>
        runProject({
          iterations,
          project,
          specsDirectory,
          stallTimeout: Duration.minutes(stallMinutes),
          runTimeout: Duration.minutes(maxIterationMinutes),
          maxContext,
        }).pipe(Effect.provideService(CurrentProjectId, project.id)),
      { concurrency: "unbounded", discard: true },
    )
  },
  Effect.scoped,
  Effect.provide([
    ClankaMuxerLayer,
    PromptGen.layer,
    GithubCli.layer,
    Settings.layer,
    CurrentIssueSource.layer,
    AtomRegistry.layer,
    Reactivity.layer,
    RunTargetBranch.layerDefault,
  ]),
)

export const executeRunIssues = (options: RunCommandOptions) =>
  executeRunAll(options)

const resolveFeatureSpecFilePath = Effect.fnUntraced(function* (
  options: RunFeatureOptions,
) {
  const pathService = yield* Path.Path
  const root = yield* FeatureStorageRoot

  if (pathService.isAbsolute(options.feature.specFilePath)) {
    return pathService.normalize(options.feature.specFilePath)
  }
  return pathService.join(root, options.feature.specFilePath)
})

export const executeRunFeatureRalph = Effect.fnUntraced(
  function* (
    options: RunFeatureOptions & {
      readonly specFile: string
      readonly targetBranch: Option.Option<string>
    },
  ) {
    const project = yield* projectById(options.feature.projectId)
    if (Option.isNone(project)) {
      return yield* new ProjectNotFound({
        projectId: options.feature.projectId,
      })
    }

    yield* executeRalphIterations({
      iterations: options.iterations,
      project: project.value,
      stallTimeout: Duration.minutes(options.stallMinutes),
      runTimeout: Duration.minutes(options.maxIterationMinutes),
      maxContext: options.maxContext,
      targetBranch: options.targetBranch,
      specFile: options.specFile,
      disableProjectOnComplete: false,
    }).pipe(
      Effect.provideService(CurrentProjectId, options.feature.projectId),
      Effect.provide(RunTargetBranch.layerFor(options.feature.featureBranch)),
    )
  },
  Effect.scoped,
  Effect.provide([
    ClankaMuxerLayer,
    PromptGen.layer,
    GithubCli.layer,
    Settings.layer,
    CurrentIssueSource.layer,
    AtomRegistry.layer,
    Reactivity.layer,
    RunTargetBranch.layerDefault,
  ]),
)

export const executeRunFeaturePr = Effect.fnUntraced(
  function* (
    options: RunFeatureOptions & {
      readonly targetBranch: Option.Option<string>
      readonly parentIssueSourceId: string
    },
  ) {
    const project = yield* projectById(options.feature.projectId)
    if (Option.isNone(project)) {
      return yield* new ProjectNotFound({
        projectId: options.feature.projectId,
      })
    }

    const scopedIssueSource = scopeIssueSourceToParentIssueSourceId(
      options.parentIssueSourceId,
    )

    yield* executeIssueIterations({
      iterations: options.iterations,
      project: project.value,
      specsDirectory: options.specsDirectory,
      stallTimeout: Duration.minutes(options.stallMinutes),
      runTimeout: Duration.minutes(options.maxIterationMinutes),
      targetBranch: options.targetBranch,
      gitFlowLayer: GitFlowPR,
    }).pipe(
      Effect.provideService(CurrentProjectId, options.feature.projectId),
      Effect.provide(scopedIssueSource),
      Effect.provide(RunTargetBranch.layerFor(options.feature.featureBranch)),
    )
  },
  Effect.scoped,
  Effect.provide([
    ClankaMuxerLayer,
    PromptGen.layer,
    GithubCli.layer,
    Settings.layer,
    CurrentIssueSource.layer,
    AtomRegistry.layer,
    Reactivity.layer,
    RunTargetBranch.layerDefault,
  ]),
)

export const executeRunFeatureWith = <E, R>(
  executePrFeature: (
    options: RunFeatureOptions & {
      readonly targetBranch: Option.Option<string>
      readonly parentIssueSourceId: string
    },
  ) => Effect.Effect<void, E, R>,
  executeRalphFeature: (
    options: RunFeatureOptions & {
      readonly specFile: string
      readonly targetBranch: Option.Option<string>
    },
  ) => Effect.Effect<void, E, R>,
) =>
  Effect.fnUntraced(function* (
    options: RunFeatureOptions,
  ): Effect.fn.Return<
    void,
    E | FeatureParentIssueSourceIdMissing,
    R | FeatureStorageRoot | Path.Path
  > {
    if (options.feature.executionMode === "ralph") {
      const specFile = yield* resolveFeatureSpecFilePath(options)
      return yield* executeRalphFeature({
        ...options,
        specFile,
        targetBranch: Option.some(options.feature.featureBranch),
      })
    }

    if (!options.feature.parentIssueSourceId) {
      return yield* new FeatureParentIssueSourceIdMissing({
        featureName: options.feature.name,
      })
    }

    return yield* executePrFeature({
      ...options,
      parentIssueSourceId: options.feature.parentIssueSourceId,
      targetBranch: Option.some(options.feature.featureBranch),
    })
  })

export const executeRunFeature = executeRunFeatureWith(
  executeRunFeaturePr,
  executeRunFeatureRalph,
)

export const commandRoot = Command.make("lalph", runCommandFlags).pipe(
  Command.withSharedFlags({
    specsDirectory,
    verbose,
  }),
  Command.withDescription(
    "Default entrypoint. Equivalent to `lalph run all` and keeps the current global execution loop available at the top level.",
  ),
  Command.withHandler((options) => RunService.runAll(options)),
)

const watchTaskState = Effect.fnUntraced(function* (options: {
  readonly issueId: string
}) {
  const projectId = yield* CurrentProjectId
  const source = yield* IssueSource
  const ref = yield* source.ref(projectId)

  return yield* SubscriptionRef.changes(ref).pipe(
    Stream.filterMap((issues) => {
      if (issues._tag === "Internal") return Result.failVoid
      return Result.succeed(
        issues.issues.find((entry) => entry.id === options.issueId),
      )
    }),
    Stream.runForEach((issue) => {
      if (issue?.state === "in-progress" || issue?.state === "in-review") {
        return Effect.void
      }
      return Effect.fail(
        new TaskStateChanged({
          issueId: options.issueId,
          state: issue?.state ?? "missing",
        }),
      )
    }),
    Effect.withSpan("Main.watchTaskState"),
  )
})

const taskUpdateSteer = Effect.fnUntraced(function* (options: {
  readonly issueId: string
  readonly semaphore: Semaphore.Semaphore
}) {
  const projectId = yield* CurrentProjectId
  const source = yield* IssueSource
  const ref = yield* source.ref(projectId)
  let current: PrdIssue | undefined = undefined

  return SubscriptionRef.changes(ref).pipe(
    Stream.filterMap((issues) => {
      const issue = issues.issues.find((entry) => entry.id === options.issueId)
      if (!issue) return Result.failVoid
      if (!current) {
        current = issue
        return Result.failVoid
      }
      if (!issue.isChangedComparedTo(current)) {
        return Result.failVoid
      }
      current = issue
      if (issues._tag === "Internal") {
        return Result.failVoid
      }
      return Result.succeed(`The task has been updated by the user. Here is the latest information:

# ${issue.title}

${issue.description}`)
    }),
  )
})
