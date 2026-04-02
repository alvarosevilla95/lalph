# Interactive Issue Mode

Add an interactive variant of `lalph issue` that interviews the user through a
supported CLI agent, writes a deterministic draft to `.lalph/issue-draft.md`,
requires editor review, and only then creates the issue in the active issue
source.

## Goals

- Keep the existing `lalph issue` editor-first flow unchanged by default.
- Share issue draft parsing, validation, recovery, and final submission logic
  between the non-interactive and interactive paths.
- Support terminal interviews only for CLI agents that can run with inherited
  stdio and ask clarifying questions directly.

## User Flow

1. `lalph issue --interactive` resolves the active project and issue source.
2. Lalph prompts for a high-level issue request and an agent preset.
3. The selected agent interviews the user in the terminal and writes the final
   draft to `.lalph/issue-draft.md`.
4. Lalph opens that draft in the editor for final review.
5. If the draft is malformed, the user can reopen the editor to repair it.
6. After successful validation, lalph submits the issue through
   `IssueSource.createIssue`.

## Draft Lifecycle

- Use `.lalph/issue-draft.md` as the only live draft path.
- Fail fast if a concurrent interview lock exists.
- If a stale draft exists without a lock, move it aside before starting a new
  session.
- Preserve the draft on interviewer failure, missing output, validation
  failure, or editor cancellation.
- Remove the live draft after a successful issue creation.

## Agent Support

- Add `CliAgent.commandIssue` for interactive interview launches.
- Supported built-in agents: the ones with an explicit `commandIssue`
  implementation.
- Unsupported built-in agents must fail with a clear error before the interview
  starts.
