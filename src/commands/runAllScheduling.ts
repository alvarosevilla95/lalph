import type { Feature } from "../domain/Feature.ts"
import type { Project } from "../domain/Project.ts"

export type GlobalRunTarget =
  | { readonly _tag: "Project"; readonly project: Project }
  | { readonly _tag: "Feature"; readonly feature: Feature }

export const sortProjectsForGlobalRun = (projects: ReadonlyArray<Project>) =>
  projects.toSorted((a, b) => String(a.id).localeCompare(String(b.id)))

export const sortFeaturesForGlobalRun = (features: ReadonlyArray<Feature>) =>
  features.toSorted((a, b) => String(a.name).localeCompare(String(b.name)))

export const scheduleGlobalRunTargets = (
  projects: ReadonlyArray<Project>,
  features: ReadonlyArray<Feature>,
): ReadonlyArray<GlobalRunTarget> => {
  const sortedProjects = sortProjectsForGlobalRun(projects)
  const sortedFeatures = sortFeaturesForGlobalRun(features)
  const targets: Array<GlobalRunTarget> = []

  const totalSlots = Math.max(sortedProjects.length, sortedFeatures.length)
  for (let index = 0; index < totalSlots; index++) {
    const project = sortedProjects[index]
    if (project) {
      targets.push({ _tag: "Project", project })
    }

    const feature = sortedFeatures[index]
    if (feature) {
      targets.push({ _tag: "Feature", feature })
    }
  }

  return targets
}
