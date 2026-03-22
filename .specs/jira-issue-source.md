# Jira Issue Source

## Overview

Add Jira Cloud as a third issue source for lalph, alongside the existing Linear
and GitHub Issues integrations. This allows teams using Jira to pull work items,
synchronize task state, and perform full CRUD operations on Jira issues directly
from lalph.

## Requirements

### Jira Deployment

- **Jira Cloud only** (e.g. `mycompany.atlassian.net`)
- Uses Atlassian REST API v3 (`/rest/api/3/`)

### Authentication

- **OAuth 2.0 (3LO)** authorization code flow with PKCE
- Follows the same pattern as `Linear/TokenManager.ts`:
  - Local HTTP callback server on port 34339 (Linear uses 34338)
  - Token + refresh token stored in KVS under `"jira.accessToken"` prefix
  - Semaphore-protected getter to prevent concurrent token requests
  - Automatic token refresh when expired (with 30-minute early expiry buffer)
  - Use `disablePreemptiveShutdown: true` on the callback HTTP server
- Required Atlassian OAuth scopes:
  - `read:jira-work` — read issues, projects, boards
  - `write:jira-work` — create/update issues, transitions
  - `read:jira-user` — read user info for assignment
  - `offline_access` — refresh tokens
- Unlike Linear/GitHub (which have hardcoded client IDs), Jira requires
  user-provided Client ID and Client Secret

### Atlassian OAuth App Setup

Users must register an OAuth 2.0 (3LO) app in the
[Atlassian Developer Console](https://developer.atlassian.com/console/myapps/):

1. Create a new OAuth 2.0 integration
2. Add the callback URL: `http://localhost:34339/callback`
3. Add the required scopes listed above
4. Copy the **Client ID** and **Client Secret**
5. On first run, lalph will prompt for these credentials:
   - Prompt Client ID via `Prompt.text`
   - Prompt Client Secret via `Prompt.text` (consider `Prompt.password` if
     available)
   - Store both in KVS under `"jira.clientCredentials"` prefix
   - Validate credentials immediately with a test API call
   - Allow re-entry if credentials are invalid

### Cloud Instance Selection

After initial OAuth authentication:

1. Fetch accessible resources from
   `https://api.atlassian.com/oauth/token/accessible-resources`
2. If multiple sites exist, prompt user to select one
3. If only one site, auto-select it
4. Store the selected cloud ID in per-project settings

### Current User

After authentication, fetch the current user via `GET /rest/api/3/myself` and
cache the `accountId`. Use this when creating issues to set
`fields.assignee.id`.

### Issue State Mapping

Auto-detect from Jira's workflow status categories. Jira Cloud has three
`statusCategory.key` values: `new`, `indeterminate`, `done`.

| `statusCategory.key`                    | PrdIssue State | Notes                                |
| --------------------------------------- | -------------- | ------------------------------------ |
| `new`                                   | `todo`         | Default for "new" category           |
| `new` + name matches "backlog"          | `backlog`      | Case-insensitive name check          |
| `indeterminate`                         | `in-progress`  | Default for "indeterminate" category |
| `indeterminate` + name matches "review" | `in-review`    | Case-insensitive                     |
| `done`                                  | `done`         |                                      |

Special handling:

- The `ensureInProgress` method should:
  1. Check if issue is already in `indeterminate` category — if so, no-op
  2. Fetch available transitions via `GET /rest/api/3/issue/{key}/transitions`
  3. Find a transition targeting a status with `statusCategory.key === "indeterminate"`
  4. Execute the transition; if no such transition exists, log a warning and continue

### Issue Filtering

- **JQL (Jira Query Language)** as the primary filtering mechanism
- During project setup (`settings`), prompt the user to enter a JQL filter
  string (e.g. `project = "MYPROJ" AND type = Story AND sprint in openSprints()`)
- Store the JQL filter as a per-project setting in KVS
- Default JQL if none provided:
  `project = "{selectedProject}" AND statusCategory != Done ORDER BY priority ASC, created ASC`
- **Pagination**: The JQL search endpoint returns paginated results (max 100 per
  page). Paginate through all results using `startAt` and `maxResults` parameters
  via `Stream.paginate`, up to 250 issues max (consistent with Linear's limit).

### Recently Completed Issue Filtering

When fetching issues, include issues in "Done" status category only if their
`fields.resolutiondate` is within the last 3 days (consistent with Linear and
GitHub patterns). Exclude issues with resolution "Won't Do" or "Duplicate"
(analogous to GitHub's `not_planned`).

### Issue Dependencies

- Map Jira's **issue links** of type `"is blocked by"` / `"Blocks"` to
  `PrdIssue.blockedBy`
- When creating issues, create issue links for any `blockedBy` entries
- When updating `blockedBy`, diff existing links and add/remove as needed

### CLI Agent Preset Routing

- **Label-based**, consistent with GitHub and Linear sources
- Preset metadata schema: `{ label: Schema.NonEmptyString }`
- Match issues to presets by checking if the issue's Jira labels include the
  preset's configured label

### Full CRUD Operations

| Operation          | Jira API Endpoint                                   |
| ------------------ | --------------------------------------------------- |
| `issues`           | `GET /rest/api/3/search/jql` with configured JQL    |
| `findById`         | `GET /rest/api/3/issue/{issueIdOrKey}`              |
| `createIssue`      | `POST /rest/api/3/issue`                            |
| `updateIssue`      | `PUT /rest/api/3/issue/{issueIdOrKey}`              |
| `cancelIssue`      | `POST /rest/api/3/issue/{issueIdOrKey}/transitions` |
| `ensureInProgress` | `POST /rest/api/3/issue/{issueIdOrKey}/transitions` |

### PR Instructions

When the Jira source is active, the `githubPrInstructions` should be:

```
The PR title should include the Jira issue key (e.g. PROJ-123). Include the
issue key in the PR description as well.
```

### Configuration (Per-Project Settings)

| Setting Key                | Type     | Description                               |
| -------------------------- | -------- | ----------------------------------------- |
| `jira.selectedCloudId`     | `String` | Atlassian cloud instance ID               |
| `jira.selectedProjectKey`  | `String` | Jira project key (e.g. "PROJ")            |
| `jira.jqlFilter`           | `String` | JQL query for filtering issues            |
| `jira.autoMergeLabel`      | `String` | Label name for auto-merge flag            |
| `jira.selectedIssueTypeId` | `String` | Jira issue type ID for creating issues    |
| `jira.estimateFieldId`     | `String` | Custom field ID for story point estimates |

### PrdIssue Field Mapping

| PrdIssue Field | Jira Field                                              |
| -------------- | ------------------------------------------------------- |
| `id`           | Issue key (e.g. `"PROJ-123"`)                           |
| `title`        | `fields.summary`                                        |
| `description`  | `fields.description` (ADF → markdown conversion)        |
| `priority`     | `fields.priority` mapped to 0-4 scale (see table below) |
| `estimate`     | Configured estimate field (see Estimate Field section)  |
| `state`        | Derived from `fields.status.statusCategory` (see above) |
| `blockedBy`    | Derived from `fields.issuelinks` (blocked-by type)      |
| `autoMerge`    | Derived from labels (auto-merge label present)          |

### Priority Mapping

| Jira Priority | PrdIssue Priority |
| ------------- | ----------------- |
| None (null)   | 0 (no priority)   |
| Highest (1)   | 1 (urgent)        |
| High (2)      | 2 (high)          |
| Medium (3)    | 3 (normal)        |
| Low (4)       | 4 (low)           |
| Lowest (5)    | 4 (low)           |

Reverse mapping (creating issues): PrdIssue priority 0 omits the priority field
(uses Jira's default).

### Estimate Field

Jira has no standard "story points" field — it is typically a custom field
(e.g., `customfield_10016`). During the `settings` flow:

1. Fetch the project's fields via `GET /rest/api/3/field`
2. Auto-detect by looking for a field with `name` matching "Story Points" or
   "Story point estimate" (case-insensitive)
3. If found, store the field ID as `jira.estimateFieldId`
4. If not found, prompt the user to select an estimate field or skip
5. For time-based estimates (`timeoriginalestimate`), convert seconds to hours
   using `Math.round(seconds / 3600)`
6. Fall back to `null` if no estimate field is configured

### Issue Type Configuration

When creating issues, the `issuetype` field is **required** by Jira. During the
`settings` flow:

1. Fetch the project's issue types via `GET /rest/api/3/project/{projectKey}`
2. Prompt the user to select an issue type
3. Default to "Task" if it exists in the project
4. Store as `jira.selectedIssueTypeId`

### ADF (Atlassian Document Format) Handling

Jira Cloud uses ADF for rich text fields. The implementation uses a minimal
converter supporting a scoped subset:

**Supported ADF nodes (read & write):**

- `doc`, `paragraph`, `heading` (levels 1-6), `bulletList`, `orderedList`,
  `listItem`, `codeBlock` (with language), `blockquote`, `text`, `hardBreak`,
  `rule`

**Supported marks:**

- `strong`, `em`, `code`, `link` (with href), `strike`

**Known limitations:**

- No nested list support in markdown-to-ADF (single level only)
- No table support
- No media/image support
- Unsupported markdown constructs are sent as plain text paragraphs
- Unknown ADF nodes are gracefully handled by extracting text content

### Error Handling

Define a `JiraError` tagged error class (following `LinearError`/`GithubError`
pattern) that wraps Jira API errors before they become `IssueSourceError`.

### `cancelIssue` Behavior

When canceling an issue:

1. Fetch available transitions
2. Look for a transition to a status whose name matches "cancel" or "won't do"
   (case-insensitive) within the "Done" category
3. If no such status exists, fall back to the first "Done" category transition
4. This ensures canceled issues are distinguished from completed ones where the
   Jira workflow supports it

## Architecture

### New Files

```
src/Jira.ts                  # Main Jira service + JiraIssueSource layer
src/Jira/TokenManager.ts     # OAuth 2.0 (3LO) token management
src/Jira/Adf.ts              # ADF ↔ Markdown conversion utilities
```

### Modified Files

```
src/CurrentIssueSource.ts    # Register Jira in issueSources array
```

### Service Hierarchy

```
JiraIssueSource (Layer → IssueSource)
├── Jira (ServiceMap.Service — wraps HttpClient for Jira REST API v3)
│   ├── Jira/TokenManager (OAuth 2.0 3LO + PKCE)
│   │   ├── KeyValueStore (token + client credentials persistence)
│   │   ├── FetchHttpClient (HTTP for token exchange)
│   │   └── NodeHttpServer (local callback server, port 34339)
│   └── FetchHttpClient (HTTP for Jira API calls)
├── Settings (per-project configuration)
└── Reactivity (cache invalidation)
```

## Implementation Plan

### Task 1: Create Jira Token Manager (`src/Jira/TokenManager.ts`)

**Self-contained** — imports only from `effect`, `@effect/platform-node`, and
`../Kvs.ts`. No other file imports from it until Task 3.

**Details:**

- Define `AccessToken` schema class with `token`, `expiresAt`, `refreshToken`
  fields and `isExpired()` method (30-minute early buffer)
- Define `TokenResponse` schema for the Atlassian token endpoint response
- Define `ClientCredentials` schema class with `clientId`, `clientSecret` fields,
  stored in KVS under `"jira.clientCredentials"` prefix
- Implement client credentials prompt flow:
  - Check KVS for existing credentials
  - If not found, prompt via `Prompt.text` for Client ID and Client Secret
  - Store in KVS
- Implement PKCE OAuth flow:
  - Start local HTTP server on port 34339 with `/callback` route
  - Use `disablePreemptiveShutdown: true` on `NodeHttpServer.layer`
  - Generate PKCE code verifier + challenge (same pattern as Linear)
  - Build authorization URL: `https://auth.atlassian.com/authorize` with params:
    `audience=api.atlassian.com`, `client_id`, `scope`, `redirect_uri`,
    `response_type=code`, `code_challenge`, `code_challenge_method=S256`,
    `prompt=consent`
  - Exchange code at `https://auth.atlassian.com/oauth/token` (include
    `client_id` and `client_secret` in the body)
- Implement token refresh via `https://auth.atlassian.com/oauth/token` with
  `grant_type=refresh_token`
- Export `TokenManager` service with `get` method returning `AccessToken`
- Export `layer` provided with `layerKvs` and `FetchHttpClient.layer`

**Depends on:** Nothing

### Task 2: Create ADF conversion utilities (`src/Jira/Adf.ts`)

**Self-contained** — pure utility functions with no Effect dependencies and no
imports from other project files.

**Details:**

- `adfToMarkdown(adf: unknown): string` — convert ADF JSON to markdown string
  - Support nodes: `doc`, `paragraph`, `heading` (levels 1-6), `bulletList`,
    `orderedList`, `listItem`, `codeBlock` (with language), `blockquote`,
    `text`, `hardBreak`, `rule`
  - Support marks: `strong`, `em`, `code`, `link` (with href), `strike`
  - Gracefully handle unknown nodes by extracting text content
- `markdownToAdf(markdown: string): unknown` — convert markdown to ADF JSON
  - Simple line-by-line parser (no external markdown parser dependency)
  - Single-level lists only (no nesting)
  - Unsupported constructs become plain text paragraphs
  - Return valid ADF `doc` node with `version: 1`
- Export both functions as pure utilities (no Effect dependencies needed)

**Depends on:** Nothing (can be done in parallel with Task 1)

### Task 3: Create Jira service and JiraIssueSource layer (`src/Jira.ts`)

**Why it cannot be split:** `IssueSource.make()` requires ALL methods at once.
Both Linear and GitHub keep the service + layer in a single file. The internal
`Jira` service is module-private (not exported).

**Details:**

**JiraError:**

- Define `JiraError` as a `Schema.ErrorClass` or `Data.TaggedError` for wrapping
  Jira API errors

**Jira Service (module-private):**

- `ServiceMap.Service` wrapping `HttpClient` from `effect/unstable/http`
- Base URL: `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3`
- Add Authorization header via `HttpClient.mapRequest`
- Methods:
  - `request(method, path, body?)` — generic API request with auth header
  - `searchJql(jql, fields?, startAt?, maxResults?)` — search issues via JQL
  - `getIssue(issueIdOrKey)` — get single issue with all fields
  - `createIssue(fields)` — create issue, return key + id
  - `updateIssue(issueIdOrKey, fields)` — update issue fields
  - `transitionIssue(issueIdOrKey, transitionId)` — transition issue status
  - `getTransitions(issueIdOrKey)` — get available transitions
  - `getProjects()` — list accessible projects
  - `getStatuses(projectKey)` — get workflow statuses for a project
  - `getFields()` — list all fields (for estimate field discovery)
  - `getMyself()` — get current user's account ID
  - `addIssueLink(inwardIssueKey, outwardIssueKey, linkType)` — add link
  - `deleteIssueLink(linkId)` — remove link
- Layer provided with `TokenManager.layer` and `FetchHttpClient.layer`

**JiraIssueSource Layer:**

- `Layer.effect(IssueSource, ...)` following the pattern from `Linear.ts`
- Project settings cached per `ProjectId` via `Cache.make`
- Layer provided with `[Jira.layer, Reactivity.layer, Settings.layer]`
- **`settings(projectId)`**: Interactive setup flow:
  1. Fetch accessible cloud resources, prompt user to select instance (or
     auto-select if only one)
  2. Fetch projects, prompt user to select project
  3. Fetch issue types, prompt user to select (default "Task")
  4. Auto-detect estimate field from project fields
  5. Prompt for JQL filter (with sensible default)
  6. Prompt for auto-merge label (optional)
- **`info(projectId)`**: Display current Jira configuration
- **`issues(projectId)`**: Execute JQL search, convert results to `PrdIssue[]`
  - Paginate via `Stream.paginate` using `startAt`/`maxResults` (max 250 total)
  - Use `adfToMarkdown` for description conversion
  - Map status categories to PrdIssue states (with backlog/in-review detection)
  - Extract blocked-by links from `issuelinks`
  - Check labels for auto-merge flag
  - Filter "Done" issues: include only if `resolutiondate` within 3 days;
    exclude resolution "Won't Do" or "Duplicate"
- **`findById(projectId, issueId)`**: Fetch single issue by key, convert
- **`createIssue(projectId, issue)`**: Create Jira issue
  - Use `markdownToAdf` for description
  - Map PrdIssue priority to Jira priority (0 → omit)
  - Set `issuetype` from `jira.selectedIssueTypeId`
  - Set `assignee.id` from cached current user
  - Create issue links for `blockedBy` entries
  - Return `{ id: issueKey, url: browseUrl }`
- **`updateIssue(options)`**: Update issue fields + handle state transitions
  - If `state` is provided, find matching transition and execute it
  - If `blockedBy` changed, diff and update issue links
- **`cancelIssue(projectId, issueId)`**: Transition preferring "canceled"/
  "won't do" statuses; fall back to first "Done" category transition
- **`ensureInProgress(projectId, issueId)`**: Check if already in-progress
  (no-op); otherwise find transition to `indeterminate` category; log warning
  if no such transition exists
- **`issueCliAgentPreset(issue)`**: Match issue labels against preset metadata
- **`updateCliAgentPreset(preset)`**: Prompt user to select a Jira label
- **`cliAgentPresetInfo(preset)`**: Display label mapping info
- **`reset`**: Clear all per-project settings (`jira.selectedCloudId`,
  `jira.selectedProjectKey`, `jira.jqlFilter`, `jira.autoMergeLabel`,
  `jira.selectedIssueTypeId`, `jira.estimateFieldId`) and invalidate cache

**Depends on:** Tasks 1 and 2

### Task 4: Register Jira in CurrentIssueSource (`src/CurrentIssueSource.ts`)

Small, cohesive change to a single file.

**Details:**

- Import `JiraIssueSource` from `./Jira.ts`
- Add entry to `issueSources` array:
  ```typescript
  {
    id: "jira",
    name: "Jira",
    layer: JiraIssueSource,
    githubPrInstructions: `The PR title should include the Jira issue key (e.g. PROJ-123). Include the issue key in the PR description as well.`,
  }
  ```
- Update the `Layer.Error` and `Layer.Services` union types in
  `CurrentIssueSource` to include `typeof JiraIssueSource`
- The `Schema.Literals` call derives from `issueSources.map(s => s.id)`, so
  `"jira"` is automatically included

**Depends on:** Task 3

### Task 5: Add changeset

**Details:**

- Create a single changeset file in `.changeset/` describing the new Jira issue
  source feature (one changeset per PR as required by project instructions)

**Depends on:** Nothing (logically last)

### Dependency Graph

```
Task 1 (TokenManager) ──┐
                         ├──> Task 3 (Jira.ts) ──> Task 4 (Registration)
Task 2 (ADF utils) ─────┘

Task 5 (Changeset) -- independent
```

Tasks 1 and 2 can be done in parallel. Task 3 requires both. Task 4 requires
Task 3. Task 5 is independent.

## Testing Strategy

- Verify `pnpm check` passes after each task (typecheck + lint)
- Manual testing flow:
  1. Run `lalph` and select "Jira" as the issue source
  2. Complete OAuth flow (register app, enter credentials, authorize)
  3. Select cloud instance and configure project settings
  4. Verify issues are fetched and correctly mapped to PrdIssue
  5. Test create, update, cancel operations
  6. Test state transitions (ensureInProgress, cancelIssue)
  7. Test dependency handling (blockedBy via issue links)
  8. Test preset routing with labels
  9. Test token refresh after expiry
  10. Test estimate field auto-detection
