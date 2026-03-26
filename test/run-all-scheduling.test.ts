import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Option } from "effect"
import { scheduleGlobalRunTargets } from "../src/commands/runAllScheduling.ts"
import { Feature, FeatureName } from "../src/domain/Feature.ts"
import { Project, ProjectId } from "../src/domain/Project.ts"

const makeFeature = (name: string) =>
  new Feature({
    name: FeatureName.makeUnsafe(name),
    projectId: ProjectId.makeUnsafe("project-alpha"),
    executionMode: "pr",
    specFilePath: `.specs/${name}.md`,
    baseBranch: "master",
    featureBranch: `feature/${name}`,
    lifecycleStatus: "active",
  })

const makeProject = (id: string) =>
  new Project({
    id: ProjectId.makeUnsafe(id),
    enabled: true,
    targetBranch: Option.some("master"),
    concurrency: 1,
    gitFlow: "pr",
    researchAgent: false,
    reviewAgent: false,
  })

const serializeTargets = (
  targets: ReturnType<typeof scheduleGlobalRunTargets>,
) =>
  targets.map((target) =>
    target._tag === "Project"
      ? `project:${target.project.id}`
      : `feature:${target.feature.name}`,
  )

describe("scheduleGlobalRunTargets", () => {
  it("alternates sorted projects and features where both are available", () => {
    const targets = scheduleGlobalRunTargets(
      [makeProject("project-beta"), makeProject("project-alpha")],
      [makeFeature("feature-zeta"), makeFeature("feature-alpha")],
    )

    assert.deepEqual(serializeTargets(targets), [
      "project:project-alpha",
      "feature:feature-alpha",
      "project:project-beta",
      "feature:feature-zeta",
    ])
  })

  it("drains the remaining sorted projects after features are exhausted", () => {
    const targets = scheduleGlobalRunTargets(
      [
        makeProject("project-charlie"),
        makeProject("project-alpha"),
        makeProject("project-bravo"),
      ],
      [makeFeature("feature-beta")],
    )

    assert.deepEqual(serializeTargets(targets), [
      "project:project-alpha",
      "feature:feature-beta",
      "project:project-bravo",
      "project:project-charlie",
    ])
  })

  it("returns sorted features when no projects are enabled", () => {
    const targets = scheduleGlobalRunTargets(
      [],
      [makeFeature("feature-zeta"), makeFeature("feature-alpha")],
    )

    assert.deepEqual(serializeTargets(targets), [
      "feature:feature-alpha",
      "feature:feature-zeta",
    ])
  })

  it("drains the remaining sorted features after projects are exhausted", () => {
    const targets = scheduleGlobalRunTargets(
      [makeProject("project-bravo")],
      [
        makeFeature("feature-zeta"),
        makeFeature("feature-alpha"),
        makeFeature("feature-gamma"),
      ],
    )

    assert.deepEqual(serializeTargets(targets), [
      "project:project-bravo",
      "feature:feature-alpha",
      "feature:feature-gamma",
      "feature:feature-zeta",
    ])
  })
})
