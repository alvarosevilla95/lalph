import { Effect, Layer, Option, ServiceMap } from "effect"
import { projectById } from "./Projects.ts"
import { CurrentProjectId } from "./Settings.ts"

export class RunTargetBranch extends ServiceMap.Service<
  RunTargetBranch,
  {
    readonly branch: Option.Option<string>
  }
>()("lalph/RunTargetBranch", {
  make: Effect.succeed({
    branch: Option.none<string>(),
  }),
}) {
  static readonly layerDefault = Layer.effect(this, this.make)

  static layerFor(branch: string) {
    return Layer.succeed(
      this,
      this.of({
        branch: Option.some(branch),
      }),
    )
  }
}

export const resolveRunTargetBranch = Effect.fnUntraced(function* () {
  const override = yield* RunTargetBranch
  if (Option.isSome(override.branch)) {
    return override.branch
  }

  const projectId = yield* CurrentProjectId
  const project = yield* projectById(projectId)
  if (Option.isNone(project)) {
    return Option.none<string>()
  }

  return project.value.targetBranch
})
