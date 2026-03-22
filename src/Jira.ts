import {
  Array,
  Cache,
  DateTime,
  Effect,
  flow,
  Layer,
  Option,
  pipe,
  Schedule,
  Schema,
  ServiceMap,
  Stream,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http"
import { TokenManager } from "./Jira/TokenManager.ts"
import { adfToMarkdown, markdownToAdf } from "./Jira/Adf.ts"
import { Prompt } from "effect/unstable/cli"
import { CurrentProjectId, ProjectSetting, Settings } from "./Settings.ts"
import { IssueSource, IssueSourceError } from "./IssueSource.ts"
import { PrdIssue } from "./domain/PrdIssue.ts"
import { Reactivity } from "effect/unstable/reactivity"
import type { ProjectId } from "./domain/Project.ts"
import { getPresetsWithMetadata } from "./Presets.ts"
import type { CliAgentPreset } from "./domain/CliAgentPreset.ts"

// Error class

export class JiraError extends Schema.ErrorClass("lalph/JiraError")({
  _tag: Schema.tag("JiraError"),
  cause: Schema.Defect,
}) {}

// Jira REST API service (module-private)

class Jira extends ServiceMap.Service<Jira>()("lalph/Jira", {
  make: Effect.gen(function* () {
    const tokens = yield* TokenManager
    const httpClient = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.retryTransient({
        schedule: Schedule.exponential(100),
        times: 3,
      }),
    )

    let cloudId: string | undefined

    const authedClient = () => {
      if (!cloudId) throw new Error("Jira cloudId not set")
      return tokens.get.pipe(
        Effect.map(({ token }) =>
          httpClient.pipe(
            HttpClient.mapRequest(
              flow(
                HttpClientRequest.prependUrl(
                  `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`,
                ),
                HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
                HttpClientRequest.acceptJson,
              ),
            ),
          ),
        ),
        Effect.mapError((cause) => new JiraError({ cause })),
      )
    }

    const request = <A>(
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Effect.Effect<A, JiraError> =>
      authedClient().pipe(
        Effect.flatMap((client) => {
          const req =
            method === "GET"
              ? client.get(path)
              : method === "DELETE"
                ? client.del(path)
                : method === "POST"
                  ? HttpClientRequest.post(path).pipe(
                      body !== undefined
                        ? HttpClientRequest.bodyJsonUnsafe(body)
                        : (_) => _,
                      client.execute,
                    )
                  : HttpClientRequest.put(path).pipe(
                      body !== undefined
                        ? HttpClientRequest.bodyJsonUnsafe(body)
                        : (_) => _,
                      client.execute,
                    )
          return req.pipe(
            Effect.flatMap((res) => res.json),
            Effect.mapError((cause) => new JiraError({ cause })),
          )
        }),
        Effect.scoped,
      ) as Effect.Effect<A, JiraError>

    const requestVoid = (
      method: "POST" | "PUT" | "DELETE",
      path: string,
      body?: unknown,
    ): Effect.Effect<void, JiraError> =>
      authedClient().pipe(
        Effect.flatMap((client) => {
          const req =
            method === "DELETE"
              ? client.del(path)
              : method === "POST"
                ? HttpClientRequest.post(path).pipe(
                    body !== undefined
                      ? HttpClientRequest.bodyJsonUnsafe(body)
                      : (_) => _,
                    client.execute,
                  )
                : HttpClientRequest.put(path).pipe(
                    body !== undefined
                      ? HttpClientRequest.bodyJsonUnsafe(body)
                      : (_) => _,
                    client.execute,
                  )
          return req.pipe(
            Effect.asVoid,
            Effect.mapError((cause) => new JiraError({ cause })),
          )
        }),
        Effect.scoped,
      )

    const searchJql = (
      jql: string,
      fields?: ReadonlyArray<string>,
      startAt = 0,
      maxResults = 100,
    ) =>
      request<JqlSearchResult>("POST", "/search/jql", {
        jql,
        fields: fields ?? [
          "summary",
          "description",
          "status",
          "priority",
          "issuelinks",
          "labels",
          "issuetype",
          "assignee",
          "resolutiondate",
          "resolution",
        ],
        startAt,
        maxResults,
      })

    const getIssue = (issueIdOrKey: string) =>
      request<JiraIssue>("GET", `/issue/${issueIdOrKey}`)

    const createIssue = (fields: Record<string, unknown>) =>
      request<{ id: string; key: string; self: string }>("POST", "/issue", {
        fields,
      })

    const updateIssue = (
      issueIdOrKey: string,
      fields: Record<string, unknown>,
    ) => requestVoid("PUT", `/issue/${issueIdOrKey}`, { fields })

    const transitionIssue = (issueIdOrKey: string, transitionId: string) =>
      requestVoid("POST", `/issue/${issueIdOrKey}/transitions`, {
        transition: { id: transitionId },
      })

    const getTransitions = (issueIdOrKey: string) =>
      request<{ transitions: ReadonlyArray<JiraTransition> }>(
        "GET",
        `/issue/${issueIdOrKey}/transitions`,
      )

    const getProjects = () =>
      request<ReadonlyArray<JiraProject>>("GET", "/project")

    const getStatuses = (projectKey: string) =>
      request<ReadonlyArray<JiraStatus>>(
        "GET",
        `/project/${projectKey}/statuses`,
      )

    const getFields = () => request<ReadonlyArray<JiraField>>("GET", "/field")

    const getMyself = () =>
      request<{ accountId: string; displayName: string }>("GET", "/myself")

    const addIssueLink = (
      inwardIssueKey: string,
      outwardIssueKey: string,
      linkTypeName: string,
    ) =>
      requestVoid("POST", "/issueLink", {
        type: { name: linkTypeName },
        inwardIssue: { key: inwardIssueKey },
        outwardIssue: { key: outwardIssueKey },
      })

    const deleteIssueLink = (linkId: string) =>
      requestVoid("DELETE", `/issueLink/${linkId}`)

    const setCloudId = (id: string) => {
      cloudId = id
    }

    const getAccessibleResources = () =>
      tokens.get.pipe(
        Effect.flatMap(({ token }) =>
          httpClient
            .pipe(
              HttpClient.mapRequest(
                HttpClientRequest.setHeader("Authorization", `Bearer ${token}`),
              ),
            )
            .get("https://api.atlassian.com/oauth/token/accessible-resources")
            .pipe(
              Effect.flatMap((res) => res.json),
              Effect.scoped,
            ),
        ),
        Effect.mapError((cause) => new JiraError({ cause })),
      ) as Effect.Effect<
        ReadonlyArray<{ id: string; name: string; url: string }>,
        JiraError
      >

    return {
      request,
      searchJql,
      getIssue,
      createIssue,
      updateIssue,
      transitionIssue,
      getTransitions,
      getProjects,
      getStatuses,
      getFields,
      getMyself,
      addIssueLink,
      deleteIssueLink,
      setCloudId,
      getAccessibleResources,
    } as const
  }),
}) {
  static layer = Layer.effect(this, this.make).pipe(
    Layer.provide([TokenManager.layer, FetchHttpClient.layer]),
  )
}

// Jira API types

interface JiraIssue {
  readonly id: string
  readonly key: string
  readonly self: string
  readonly fields: {
    readonly summary: string
    readonly description: unknown
    readonly status: {
      readonly name: string
      readonly statusCategory: {
        readonly key: string
        readonly name: string
      }
    }
    readonly priority: {
      readonly id: string
      readonly name: string
    } | null
    readonly issuelinks: ReadonlyArray<{
      readonly id: string
      readonly type: {
        readonly name: string
        readonly inward: string
        readonly outward: string
      }
      readonly inwardIssue?: {
        readonly key: string
        readonly fields?: {
          readonly status?: {
            readonly statusCategory?: {
              readonly key: string
            }
          }
        }
      }
      readonly outwardIssue?: {
        readonly key: string
      }
    }>
    readonly labels: ReadonlyArray<string>
    readonly issuetype: {
      readonly id: string
      readonly name: string
    }
    readonly assignee: {
      readonly accountId: string
    } | null
    readonly resolutiondate: string | null
    readonly resolution: {
      readonly name: string
    } | null
    readonly [key: string]: unknown
  }
}

interface JqlSearchResult {
  readonly issues: ReadonlyArray<JiraIssue>
  readonly startAt: number
  readonly maxResults: number
  readonly total: number
}

interface JiraTransition {
  readonly id: string
  readonly name: string
  readonly to: {
    readonly id: string
    readonly name: string
    readonly statusCategory: {
      readonly key: string
      readonly name: string
    }
  }
}

interface JiraProject {
  readonly id: string
  readonly key: string
  readonly name: string
  readonly issueTypes: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly subtask: boolean
  }>
}

interface JiraStatus {
  readonly id: string
  readonly name: string
  readonly statuses: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly statusCategory: {
      readonly key: string
      readonly name: string
    }
  }>
}

interface JiraField {
  readonly id: string
  readonly name: string
  readonly schema?: {
    readonly type: string
    readonly custom?: string
  }
}

// Status category mapping

const jiraStatusToPrdState = (
  statusCategory: string,
  statusName: string,
): PrdIssue["state"] => {
  const lowerName = statusName.toLowerCase()
  switch (statusCategory) {
    case "new":
      return lowerName.includes("backlog") ? "backlog" : "todo"
    case "indeterminate":
      return lowerName.includes("review") ? "in-review" : "in-progress"
    case "done":
      return "done"
    default:
      return "todo"
  }
}

// Priority mapping: Jira priority id → PrdIssue priority
const jiraPriorityToPrd = (
  priority: JiraIssue["fields"]["priority"],
): number => {
  if (!priority) return 0
  const id = Number(priority.id)
  if (id === 1) return 1 // Highest → urgent
  if (id === 2) return 2 // High
  if (id === 3) return 3 // Medium → normal
  if (id >= 4) return 4 // Low, Lowest
  return 0
}

// Reverse: PrdIssue priority → Jira priority id (or undefined to skip)
const prdPriorityToJira = (priority: number): { id: string } | undefined => {
  if (priority === 0) return undefined
  if (priority === 1) return { id: "1" }
  if (priority === 2) return { id: "2" }
  if (priority === 3) return { id: "3" }
  if (priority === 4) return { id: "4" }
  return undefined
}

// Extract blocked-by issue keys from issuelinks
const extractBlockedBy = (
  issuelinks: JiraIssue["fields"]["issuelinks"],
): ReadonlyArray<string> =>
  issuelinks.flatMap((link) => {
    // When outwardIssue is present, the current issue is the inward issue
    // ("is blocked by" the outward issue)
    const inward = link.type.inward.toLowerCase()
    if (inward.includes("is blocked by") && link.outwardIssue) {
      return [link.outwardIssue.key]
    }
    return []
  })

// JiraIssueSource

export const JiraIssueSource = Layer.effect(
  IssueSource,
  Effect.gen(function* () {
    const jira = yield* Jira

    const projectSettings = yield* Cache.make({
      lookup: Effect.fnUntraced(
        function* (_projectId: ProjectId) {
          const { cloudId, siteUrl } = yield* getOrSelectCloudId
          jira.setCloudId(cloudId)
          const projectKey = yield* getOrSelectProjectKey
          const issueTypeId = yield* getOrSelectIssueType(projectKey)
          const estimateFieldId = yield* detectOrSelectEstimateField
          const jqlFilter = yield* getOrSelectJqlFilter(projectKey)
          const autoMergeLabel = yield* getOrSelectAutoMergeLabel
          const myself = yield* jira
            .getMyself()
            .pipe(Effect.mapError((cause) => new IssueSourceError({ cause })))
          return {
            cloudId,
            siteUrl,
            projectKey,
            issueTypeId,
            estimateFieldId,
            jqlFilter,
            autoMergeLabel,
            accountId: myself.accountId,
          } as const
        },
        Effect.orDie,
        (effect, projectId) =>
          Effect.provideService(effect, CurrentProjectId, projectId),
      ),
      capacity: Number.POSITIVE_INFINITY,
    })

    const presets = yield* getPresetsWithMetadata("jira", PresetMetadata)
    const presetMap = new Map<string, CliAgentPreset>()

    const fetchIssues = (settings: {
      readonly jqlFilter: string
      readonly estimateFieldId: Option.Option<string>
      readonly autoMergeLabel: Option.Option<string>
    }) => {
      const threeDaysAgo = DateTime.nowUnsafe().pipe(
        DateTime.subtract({ days: 3 }),
      )

      return pipe(
        Stream.paginate(
          0 as number,
          Effect.fnUntraced(function* (startAt: number) {
            const result = yield* jira.searchJql(
              settings.jqlFilter,
              undefined,
              startAt,
              100,
            )
            const nextStartAt = startAt + result.issues.length
            const hasMore = nextStartAt < result.total && nextStartAt < 250
            return [
              result.issues,
              hasMore ? Option.some(nextStartAt) : Option.none<number>(),
            ] as const
          }),
        ),
        Stream.filter((issue) => {
          // Filter done issues: only include if resolved within 3 days
          // and exclude "Won't Do" / "Duplicate" resolutions
          if (issue.fields.status.statusCategory.key === "done") {
            const resolutionDate = issue.fields.resolutiondate
            if (!resolutionDate) return true
            const resolved = DateTime.makeUnsafe(resolutionDate)
            if (!DateTime.isGreaterThanOrEqualTo(resolved, threeDaysAgo)) {
              return false
            }
            const resolution = issue.fields.resolution?.name?.toLowerCase()
            if (
              resolution &&
              (resolution.includes("won't do") ||
                resolution.includes("duplicate"))
            ) {
              return false
            }
          }
          return true
        }),
        Stream.map((issue) => {
          const preset = presets.find(({ metadata }) =>
            issue.fields.labels.includes(metadata.label),
          )
          if (preset) {
            presetMap.set(issue.key, preset.preset)
          }

          const estimate = settings.estimateFieldId.pipe(
            Option.flatMap((fieldId) => {
              const val = issue.fields[fieldId]
              if (typeof val === "number") {
                // Convert seconds to hours for time-based estimate fields
                if (fieldId === "timeoriginalestimate") {
                  return Option.some(Math.round(val / 3600))
                }
                return Option.some(val)
              }
              return Option.none()
            }),
            Option.getOrElse(() => null),
          )

          return new PrdIssue({
            id: issue.key,
            title: issue.fields.summary,
            description: adfToMarkdown(issue.fields.description),
            priority: jiraPriorityToPrd(issue.fields.priority),
            estimate,
            state: jiraStatusToPrdState(
              issue.fields.status.statusCategory.key,
              issue.fields.status.name,
            ),
            blockedBy: extractBlockedBy(issue.fields.issuelinks),
            autoMerge: settings.autoMergeLabel.pipe(
              Option.map((label) => issue.fields.labels.includes(label)),
              Option.getOrElse(() => false),
            ),
          })
        }),
        Stream.runCollect,
        Effect.mapError((cause) => new IssueSourceError({ cause })),
      )
    }

    const issues = Effect.fnUntraced(function* (projectId: ProjectId) {
      const settings = yield* Cache.get(projectSettings, projectId)
      return yield* fetchIssues(settings)
    })

    return yield* IssueSource.make({
      issues,
      findById: Effect.fnUntraced(function* (projectId, issueId) {
        const settings = yield* Cache.get(projectSettings, projectId)
        const allIssues = yield* fetchIssues(settings)
        return allIssues.find((issue) => issue.id === issueId) ?? null
      }),
      createIssue: Effect.fnUntraced(
        function* (projectId, issue) {
          const settings = yield* Cache.get(projectSettings, projectId)
          jira.setCloudId(settings.cloudId)

          const fields: Record<string, unknown> = {
            project: { key: settings.projectKey },
            summary: issue.title,
            description: markdownToAdf(issue.description),
            issuetype: { id: settings.issueTypeId },
            assignee: { id: settings.accountId },
            labels: Option.toArray(settings.autoMergeLabel).filter(
              () => issue.autoMerge,
            ),
          }

          const jiraPriority = prdPriorityToJira(issue.priority)
          if (jiraPriority) {
            fields.priority = jiraPriority
          }

          if (
            Option.isSome(settings.estimateFieldId) &&
            issue.estimate !== null
          ) {
            const estimateFieldId = settings.estimateFieldId.value
            // Convert hours back to seconds for time-based estimate fields
            fields[estimateFieldId] =
              estimateFieldId === "timeoriginalestimate"
                ? issue.estimate * 3600
                : issue.estimate
          }

          const created = yield* jira.createIssue(fields)

          // Create blocked-by links
          if (issue.blockedBy.length > 0) {
            yield* Effect.forEach(
              issue.blockedBy,
              (blockerKey) =>
                jira
                  .addIssueLink(created.key, blockerKey, "Blocks")
                  .pipe(Effect.ignore),
              { concurrency: 5, discard: true },
            )
          }

          return {
            id: created.key,
            url: `${settings.siteUrl}/browse/${created.key}`,
          }
        },
        Effect.mapError((cause) => new IssueSourceError({ cause })),
      ),
      updateIssue: Effect.fnUntraced(
        function* (options) {
          const settings = yield* Cache.get(projectSettings, options.projectId)
          jira.setCloudId(settings.cloudId)

          // Fetch current issue once if needed for labels or blockedBy diff
          const needsCurrentIssue =
            (options.autoMerge !== undefined &&
              Option.isSome(settings.autoMergeLabel)) ||
            options.blockedBy !== undefined
          const currentIssue = needsCurrentIssue
            ? yield* jira.getIssue(options.issueId)
            : undefined

          const fields: Record<string, unknown> = {}
          if (options.title) {
            fields.summary = options.title
          }
          if (options.description) {
            fields.description = markdownToAdf(options.description)
          }

          // Handle auto-merge label
          if (
            options.autoMerge !== undefined &&
            Option.isSome(settings.autoMergeLabel) &&
            currentIssue
          ) {
            const autoMergeLabelName = settings.autoMergeLabel.value
            const currentLabels = currentIssue.fields.labels.slice()
            const hasLabel = currentLabels.includes(autoMergeLabelName)
            if (options.autoMerge && !hasLabel) {
              fields.labels = [...currentLabels, autoMergeLabelName]
            } else if (!options.autoMerge && hasLabel) {
              fields.labels = currentLabels.filter(
                (l: string) => l !== autoMergeLabelName,
              )
            }
          }

          if (Object.keys(fields).length > 0) {
            yield* jira.updateIssue(options.issueId, fields)
          }

          // Handle state transitions
          if (options.state) {
            const { transitions } = yield* jira.getTransitions(options.issueId)
            const targetCategory =
              options.state === "done"
                ? "done"
                : options.state === "in-progress" ||
                    options.state === "in-review"
                  ? "indeterminate"
                  : "new"
            const transition = transitions.find(
              (t) => t.to.statusCategory.key === targetCategory,
            )
            if (transition) {
              yield* jira.transitionIssue(options.issueId, transition.id)
            }
          }

          // Handle blockedBy diff
          if (options.blockedBy && currentIssue) {
            const currentBlockedBy = extractBlockedBy(
              currentIssue.fields.issuelinks,
            )

            const desiredSet = new Set(options.blockedBy)
            const currentSet = new Set(currentBlockedBy)

            const toAdd = options.blockedBy.filter(
              (key) => !currentSet.has(key),
            )
            const toRemove = currentIssue.fields.issuelinks.filter((link) => {
              const inward = link.type.inward.toLowerCase()
              return (
                inward.includes("is blocked by") &&
                link.outwardIssue &&
                !desiredSet.has(link.outwardIssue.key)
              )
            })

            if (toAdd.length > 0) {
              yield* Effect.forEach(
                toAdd,
                (blockerKey) =>
                  jira
                    .addIssueLink(options.issueId, blockerKey, "Blocks")
                    .pipe(Effect.ignore),
                { concurrency: 5, discard: true },
              )
            }

            if (toRemove.length > 0) {
              yield* Effect.forEach(
                toRemove,
                (link) => jira.deleteIssueLink(link.id).pipe(Effect.ignore),
                { concurrency: 5, discard: true },
              )
            }
          }
        },
        Effect.mapError((cause) => new IssueSourceError({ cause })),
      ),
      cancelIssue: Effect.fnUntraced(
        function* (_projectId, issueId) {
          const { transitions } = yield* jira.getTransitions(issueId)

          // Prefer "canceled"/"won't do" transitions in Done category
          const cancelTransition = transitions.find((t) => {
            if (t.to.statusCategory.key !== "done") return false
            const name = t.to.name.toLowerCase()
            return name.includes("cancel") || name.includes("won't do")
          })

          // Fall back to first Done category transition
          const transition =
            cancelTransition ??
            transitions.find((t) => t.to.statusCategory.key === "done")

          if (transition) {
            yield* jira.transitionIssue(issueId, transition.id)
          }
        },
        Effect.mapError((cause) => new IssueSourceError({ cause })),
      ),
      ensureInProgress: Effect.fnUntraced(
        function* (_projectId, issueId) {
          const currentIssue = yield* jira.getIssue(issueId)
          if (
            currentIssue.fields.status.statusCategory.key === "indeterminate"
          ) {
            return
          }

          const { transitions } = yield* jira.getTransitions(issueId)
          const transition = transitions.find(
            (t) => t.to.statusCategory.key === "indeterminate",
          )
          if (transition) {
            yield* jira.transitionIssue(issueId, transition.id)
          } else {
            yield* Effect.logWarning(
              `No transition to in-progress found for ${issueId}`,
            )
          }
        },
        Effect.mapError((cause) => new IssueSourceError({ cause })),
      ),
      reset: Effect.gen(function* () {
        const projectId = yield* CurrentProjectId
        yield* Settings.setProject(selectedCloudId, Option.none())
        yield* Settings.setProject(selectedProjectKey, Option.none())
        yield* Settings.setProject(selectedIssueTypeId, Option.none())
        yield* Settings.setProject(selectedEstimateFieldId, Option.none())
        yield* Settings.setProject(selectedJqlFilter, Option.none())
        yield* Settings.setProject(selectedAutoMergeLabel, Option.none())
        yield* Cache.invalidate(projectSettings, projectId)
      }),
      settings: (projectId) =>
        Effect.asVoid(Cache.get(projectSettings, projectId)),
      info: Effect.fnUntraced(
        function* (projectId) {
          const settings = yield* Cache.get(projectSettings, projectId)
          console.log(`  Jira site: ${settings.siteUrl}`)
          console.log(`  Project: ${settings.projectKey}`)
          console.log(`  Issue type ID: ${settings.issueTypeId}`)
          console.log(
            `  Estimate field: ${Option.match(settings.estimateFieldId, {
              onNone: () => "None",
              onSome: (id) => id,
            })}`,
          )
          console.log(`  JQL filter: ${settings.jqlFilter}`)
          console.log(
            `  Auto-merge label: ${Option.match(settings.autoMergeLabel, {
              onNone: () => "Disabled",
              onSome: (label) => label,
            })}`,
          )
        },
        Effect.mapError((cause) => new IssueSourceError({ cause })),
      ),
      issueCliAgentPreset: (issue) =>
        Effect.sync(() => Option.fromUndefinedOr(presetMap.get(issue.id!))),
      updateCliAgentPreset: Effect.fnUntraced(function* (preset) {
        const label = yield* Prompt.text({
          message: "Enter a Jira label for this preset",
          validate(value) {
            value = value.trim()
            if (value.length === 0) {
              return Effect.fail("Label cannot be empty")
            }
            return Effect.succeed(value)
          },
        })
        return yield* preset.addMetadata("jira", PresetMetadata, { label })
      }),
      cliAgentPresetInfo: Effect.fnUntraced(
        function* (preset) {
          const metadata = yield* preset.decodeMetadata("jira", PresetMetadata)
          if (Option.isNone(metadata)) return
          console.log(`  Label: ${metadata.value.label}`)
        },
        Effect.mapError((cause) => new IssueSourceError({ cause })),
      ),
    })
  }),
).pipe(Layer.provide([Jira.layer, Reactivity.layer, Settings.layer]))

// Preset metadata schema

const PresetMetadata = Schema.Struct({
  label: Schema.NonEmptyString,
})

// Per-project settings

const selectedCloudId = new ProjectSetting(
  "jira.selectedCloudId",
  Schema.Struct({ cloudId: Schema.String, siteUrl: Schema.String }),
)
const selectedProjectKey = new ProjectSetting(
  "jira.selectedProjectKey",
  Schema.String,
)
const selectedIssueTypeId = new ProjectSetting(
  "jira.selectedIssueTypeId",
  Schema.String,
)
const selectedEstimateFieldId = new ProjectSetting(
  "jira.estimateFieldId",
  Schema.Option(Schema.String),
)
const selectedJqlFilter = new ProjectSetting("jira.jqlFilter", Schema.String)
const selectedAutoMergeLabel = new ProjectSetting(
  "jira.autoMergeLabel",
  Schema.Option(Schema.String),
)

// Cloud ID selection

const selectCloudId = Effect.gen(function* () {
  const jira = yield* Jira
  const resources = yield* jira.getAccessibleResources()
  if (resources.length === 1) {
    const resource = resources[0]!
    const value = { cloudId: resource.id, siteUrl: resource.url }
    yield* Settings.setProject(selectedCloudId, Option.some(value))
    console.log(`  Auto-selected Jira site: ${resource.name}`)
    return value
  }
  const selected = yield* Prompt.autoComplete({
    message: "Select a Jira Cloud site",
    choices: resources.map((r) => ({
      title: `${r.name} (${r.url})`,
      value: { cloudId: r.id, siteUrl: r.url },
    })),
  })
  yield* Settings.setProject(selectedCloudId, Option.some(selected))
  return selected
})

const getOrSelectCloudId = Effect.gen(function* () {
  const existing = yield* Settings.getProject(selectedCloudId)
  if (Option.isSome(existing)) return existing.value
  return yield* selectCloudId
})

// Project key selection

const selectProjectKey = Effect.gen(function* () {
  const jira = yield* Jira
  const projects = yield* jira.getProjects()
  const selected = yield* Prompt.autoComplete({
    message: "Select a Jira project",
    choices: Array.map(projects, (p) => ({
      title: `${p.key} - ${p.name}`,
      value: p.key,
    })),
  })
  yield* Settings.setProject(selectedProjectKey, Option.some(selected))
  return selected
})

const getOrSelectProjectKey = Effect.gen(function* () {
  const existing = yield* Settings.getProject(selectedProjectKey)
  if (Option.isSome(existing)) return existing.value
  return yield* selectProjectKey
})

// Issue type selection

const selectIssueType = Effect.fnUntraced(function* (projectKey: string) {
  const jira = yield* Jira
  const projects = yield* jira.getProjects()
  const project = projects.find((p) => p.key === projectKey)
  const issueTypes = project?.issueTypes.filter((t) => !t.subtask) ?? []

  const defaultType = issueTypes.find((t) => t.name.toLowerCase() === "task")

  if (issueTypes.length === 1) {
    const id = issueTypes[0]!.id
    yield* Settings.setProject(selectedIssueTypeId, Option.some(id))
    return id
  }

  const selected = yield* Prompt.autoComplete({
    message: "Select an issue type for new issues",
    choices: issueTypes.map((t) => ({
      title: t.name,
      value: t.id,
      selected: t.id === defaultType?.id,
    })),
  })
  yield* Settings.setProject(selectedIssueTypeId, Option.some(selected))
  return selected
})

const getOrSelectIssueType = Effect.fnUntraced(function* (projectKey: string) {
  const existing = yield* Settings.getProject(selectedIssueTypeId)
  if (Option.isSome(existing)) return existing.value
  return yield* selectIssueType(projectKey)
})

// Estimate field detection

const detectOrSelectEstimateField = Effect.gen(function* () {
  const existing = yield* Settings.getProject(selectedEstimateFieldId)
  if (Option.isSome(existing)) return existing.value

  const jira = yield* Jira
  const fields = yield* jira.getFields()

  // Auto-detect story points field
  const storyPointsField = fields.find((f) => {
    const name = f.name.toLowerCase()
    return name.includes("story point")
  })

  if (storyPointsField) {
    const fieldId = Option.some(storyPointsField.id)
    yield* Settings.setProject(selectedEstimateFieldId, Option.some(fieldId))
    console.log(
      `  Auto-detected estimate field: ${storyPointsField.name} (${storyPointsField.id})`,
    )
    return fieldId
  }

  // Prompt user to select or skip
  const numericFields = fields.filter(
    (f) => f.schema?.type === "number" || f.id === "timeoriginalestimate",
  )

  const selected = yield* Prompt.autoComplete({
    message: "Select an estimate field (or skip)",
    choices: [
      { title: "Skip (no estimate field)", value: Option.none<string>() },
      ...numericFields.map((f) => ({
        title: `${f.name} (${f.id})`,
        value: Option.some(f.id),
      })),
    ],
  })

  yield* Settings.setProject(selectedEstimateFieldId, Option.some(selected))
  return selected
})

// JQL filter selection

const selectJqlFilter = Effect.fnUntraced(function* (projectKey: string) {
  const defaultJql = `project = "${projectKey}" AND statusCategory != Done ORDER BY priority ASC, created ASC`

  const jql = yield* Prompt.text({
    message: "Enter JQL filter for issues",
    default: defaultJql,
    validate(input) {
      if (input.trim().length === 0) {
        return Effect.fail("JQL filter cannot be empty")
      }
      return Effect.succeed(input.trim())
    },
  })

  yield* Settings.setProject(selectedJqlFilter, Option.some(jql))
  return jql
})

const getOrSelectJqlFilter = Effect.fnUntraced(function* (projectKey: string) {
  const existing = yield* Settings.getProject(selectedJqlFilter)
  if (Option.isSome(existing)) return existing.value
  return yield* selectJqlFilter(projectKey)
})

// Auto-merge label selection

const selectAutoMergeLabel = Effect.gen(function* () {
  const label = yield* Prompt.text({
    message: "Enter a label for auto-merge issues (leave empty to disable)",
  })
  const labelOption = Option.some(label.trim()).pipe(
    Option.filter((s) => s.length > 0),
  )
  yield* Settings.setProject(selectedAutoMergeLabel, Option.some(labelOption))
  return labelOption
})

const getOrSelectAutoMergeLabel = Effect.gen(function* () {
  const existing = yield* Settings.getProject(selectedAutoMergeLabel)
  if (Option.isSome(existing)) return existing.value
  return yield* selectAutoMergeLabel
})
