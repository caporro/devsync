# Tasks

Task data is stored in project Markdown files under `tasks/`. Each task is complete on its own; SQLite is only the existing, rebuildable document-search cache.

```markdown
---
id: "abc12"
title: "Prepare proposal"
status: "todo"
owner: "ada@example.com"
deadline: "2026-11-20"
order: 0
createdAt: "2026-11-09T10:00:00.000Z"
createdBy: "ada@example.com"
lastEditor: "ada@example.com"
lastEdited: "2026-11-09T10:00:00.000Z"
tags: ["handoff", "review"]
---

# Prepare proposal

Description, references, updates and delivery notes.
```

## States and ownership

Allowed states are `backlog`, `todo`, `doing`, `pause`, `done`, `rejected`. New tasks default to `backlog`; creation can explicitly select any state. Transitions are unrestricted. `done` and `rejected` are terminal states for the My Tasks sort order; either can be reopened with any other state.

The owner is a user's email when the user can be resolved unambiguously. Existing unknown or ambiguous labels remain intact. Assignment does not launch an agent or an automation run. The description remains ordinary Markdown; task discussions use the comment section below it.

## Comments

Comments are appended in chronological order inside the task's existing `.md` file. `read_task` and the REST task-content endpoint return `content` (the complete file), `descriptionContent` (the description and frontmatter, without the managed discussion) and `comments: [{id, author, createdAt, content}]`. Existing tasks without comments need no migration. Compact task lists do not include discussion bodies.

MCP `append_task_comment` accepts:

```json
{ "projectId": "my-project", "path": "tasks/task.md", "content": "Review completed. See [analysis](../work/analysis.md).", "agentName": "Custode" }
```

REST: `POST /api/projects/:projectId/tasks/comments?path=tasks/file.md`, with a JSON body containing `content` and optional `agentName`. It returns 201 with `{comment, path, revision, task}`; `task` is the complete updated snapshot so the UI does not need a second read after a successful write. MCP and Assistant append tools return only `{comment, path, revision}` to avoid repeating the discussion. Author uses the existing agent-name/authenticated-user attribution rule. IDs and UTC dates are assigned by the server; client-supplied author/date/ID fields do not override them. Audit action `task.comment_added` retains the operational actor, authenticated identity and comment ID. New mentions generate the usual mention events, and the operation publishes `task.updated` for existing automations.

Appending does not require `expectedRevision`: within the process, task operations are serialized per project, then the append writes against the latest file revision atomically. Parallel appends retain all comments. An external filesystem write during the operation can still return 409; read again before retrying. Normal description/metadata edits continue to require their full current revision, so an edit based on a pre-comment revision is rejected.

Task updates preserve the existing comment section when supplied only a description. A full-Markdown round trip may include the unchanged section. Editing, deleting or manufacturing comment blocks through `update_task` or `update_document` returns 400. The UI source editor edits only `descriptionContent`; comments have an add form and a Refresh button, without edit/delete controls. Save a dirty description before adding or refreshing comments; refreshes update the editor snapshot and its write revision together. Failed comment submissions retain their draft.

The reserved section is readable Markdown:

```markdown
<!-- devsync:task-comments -->
## Comments

<!-- devsync:task-comment {"id":"7f96bd95-5808-47ba-9530-888a67fb6641","author":"Custode","createdAt":"2026-11-13T14:00:00.000Z"} -->
### 2026-11-13T14:00:00.000Z — Custode

Review completed.
```

The `<!-- devsync:task-comment` namespace is reserved and cannot be submitted as comment/description content to manufacture the managed section. Author text is escaped in rendered headings while its original value remains in metadata. An ordinary legacy `## Comments` heading is still description text. Direct filesystem edits remain authoritative; malformed reserved sections raise an explicit error rather than being silently discarded. Comment bodies remain part of the task's full-text search content.

## Generated index and order

`tasks/README.md` is generated from task files in ascending `order`, with a path tie-breaker. It includes the six-state status, owner and deadline. Deleting the index is safe: the next task/project read rebuilds it without losing task state or manual order. Edit task files rather than the generated index. Metadata edits, including status changes, change the task's content revision.

The UI edits one task per operation. Reordering supplies the full ordered list of paths and current revisions, validates the complete set before writing, and changes only order/editor metadata. In-process task operations are serialized per project; file replacement is atomic. External filesystem edits are authoritative and stale writes return HTTP 409.

The sidebar's **Kanban** view shows tasks from all projects at `/kanban`, with a project filter (`/kanban?project=<id>`) and the project name on every card. Dragging a card to another column updates the task in its own project through the same revision-checked operation. Task creation includes an explicit project selector; opening a card lets you edit its details. Cards retain each project's manual order. Each status column can collapse to a narrow bar showing its name and count. Collapsed columns are remembered in browser local storage across refreshes and navigation away from the board. The project filter is also remembered and restored when reopening Kanban from the sidebar, including after viewing a task. Expanded columns share the available width down to a 160 px minimum, after which the board scrolls horizontally. The older `/projects/<projectId>/kanban` URL opens the global view filtered to that project.

## Migration

Migration runs automatically when a project's tasks are first accessed. To migrate/verify all projects explicitly, using the same environment/vault configuration as the server:

```bash
npm run migrate:tasks
```

Migration maps old unchecked tasks to `todo` and checked tasks to `done`, preserving the old index order. The legacy `open` status follows the same checkbox mapping. Existing states from the six-state model and orders are retained. Missing owner/deadline metadata is recovered from the old index. Unambiguous user names are resolved to email; other assignments are preserved. IDs, creation metadata, custom frontmatter and Markdown bodies are retained. Old `plan/` folders are supported.

Before migration writes, originals are saved once under `tasks/.migration-v2/`, including the original README and task files. The hidden directory is excluded from task listings and document search. Migration is idempotent and can resume after a partial run. Invalid explicit states/orders stop migration with an error instead of silently discarding them. Non-Markdown files are left on disk and are not task records.

### Repairing old truncated filenames

Older versions could truncate the `.md` extension of a long task filename. New writes reserve space for the extension and numeric collision suffix within the 140-character filename limit. The full title stays in Markdown metadata; brackets and long titles are supported.

Back up the full vault and stop HTTP/stdio writers before maintenance. Use the same vault environment as the server. Preview repairs without changing files or running the metadata migration:

```bash
npm run migrate:tasks -- --repair-filenames --dry-run
```

Apply the repairs, then migrate/verify tasks:

```bash
npm run migrate:tasks -- --repair-filenames
```

In the production Docker image, use `node scripts/migrate-tasks.mjs --repair-filenames --dry-run` and `node scripts/migrate-tasks.mjs --repair-filenames` with the configured data mount/environment; npm is not installed in that image.

Repair recognizes timestamp-prefixed truncated filenames with UTF-8 task frontmatter and a Markdown heading, including a partial `.m` extension. It reserves distinct destinations, never overwrites existing files, updates README links, and keeps original file bytes, the original README and a rename map in `tasks/.filename-repair/`. Unrecognized candidates are reported for manual inspection; the command exits unsuccessfully when any are skipped. Ordinary reads do not rename these files.

When repair precedes metadata migration, checkbox state, assignment, deadline and index order survive. If the index was already regenerated, repair recovers missing status/assignment/deadline from `tasks/.migration-v2/README.md`; restored tasks join the existing manual order. Explicit task metadata takes precedence. A checkbox already discarded by older software cannot be reconstructed without a surviving original index or another backup. Creators, IDs and Markdown bodies are preserved.

## Listing, filters and pagination

Tasks accept optional `tags: string[]` in `create_task`/`update_task`, their REST create/update equivalents, and the internal Assistant tools. Tags are stored directly in Markdown frontmatter, trimmed, deduplicated and stripped of empty entries. Omitted tags preserve the existing set during edits; an explicit empty array clears it. Changing tags requires the same `expectedRevision` as other task edits and preserves the original creator, ID and body. Labels are case-sensitive; a label may contain spaces or commas. Historical Markdown metadata remains readable.

The UI supports tags during task creation, in the task list and detail view. Enter a label and press Enter or leave the tag field to add it; use the remove button to remove a label. Both the project list and Kanban can filter by one exact tag; the Kanban combines this with its project filter. Reordering from a filtered project list still submits the full project task order, retaining the relative order of other tasks.

`list_tasks` and `GET /api/projects/:projectId/tasks` support the same options. Task summaries include `createdBy`, `updatedBy` (from `lastEditor`), `createdAt`, filesystem `updatedAt`, tags, status, owner, deadline, stable ID and revision. Historical files without a recorded editor return an empty `updatedBy`; no editor is invented.

| Option | Meaning |
| --- | --- |
| `done` | Exact completion boolean; `false` includes every status except `done`, including `rejected`. |
| `status` | One of the six task states. |
| `owner`, `createdBy` | Exact identity/label; an empty owner selects unassigned tasks. |
| `tag` | Exact tag, combined with the other filters. |
| `overdue` | Deadline before today's UTC date, excluding `done` and `rejected`; today's deadline is not overdue. |
| `updatedSince` | ISO timestamp with a timezone; filesystem modification time must be strictly later. |
| `compact` | Defaults to `true` (no Markdown content); `false` includes `content`. |
| `limit` | Page size from 1 to 100. |
| `cursor` | Opaque next-page token; repeat the original filters and compact option. |

Filters combine with AND. Without `limit`/`cursor`, MCP retains the existing array response and HTTP retains `{ "items": [...] }`. Supplying either returns `{ "items": [...], "nextCursor": "..." }`; `nextCursor` is `null` on the last page. A cursor without a limit uses page size 50. Invalid options return 400. A cursor is bound to the project, filters and matching task revisions/order/timestamps: changed results return 409 and require starting again without a cursor.

Example MCP input:

```json
{ "projectId": "my-project", "overdue": true, "createdBy": "ada@example.com", "limit": 25 }
```

HTTP equivalent: `GET /api/projects/my-project/tasks?overdue=true&createdBy=ada%40example.com&limit=25`. HTTP booleans must be `true` or `false`. These options apply to the project task list; the global Kanban API retains its existing response.

## HTTP API

- `GET /api/tasks`: all project tasks with project ID/name, status and revision; no Markdown bodies.
- `GET /api/projects/:projectId/tasks`: ordered summaries with creator/editor metadata, filters and optional pagination (above).
- `GET /api/projects/:projectId/tasks/content?path=tasks/file.md`: full task and revision.
- `POST /api/projects/:projectId/tasks/comments?path=tasks/file.md`: append a comment, without `expectedRevision`.
- `POST /api/projects/:projectId/tasks`: create, with optional `status`, `owner`, `deadline`, `tags`, `body`.
- `PATCH /api/projects/:projectId/tasks/content?path=...`: update one task, requiring `expectedRevision` from the last read. Fields or complete Markdown are accepted.
- `PATCH /api/projects/:projectId/tasks/order`: reorder with `items: [{path, expectedRevision}]` for the current complete task list.
- `DELETE /api/projects/:projectId/tasks?path=...`: permanently delete, requiring `expectedRevision` in the JSON body.
- `GET /api/my/tasks`: assigned tasks grouped by project.

The old `tasks/readme` write endpoint rejects updates: the index is read-only. Legacy `/plan` aliases remain for create/update/toggle/delete. `toggle_task` and the toggle endpoint remain compatibility operations: checked means `done`, unchecked means `todo`; a current revision is required. Prefer explicit status updates.

## Assistant, automations and MCP

The same storage operations back HTTP, MCP and internal agent tools: `list_tasks`, `read_task`, `create_task`, `update_task`, `append_task_comment`, `toggle_task`, `reorder_tasks`, `delete_task`. Description/metadata edits, reorders and deletes require current revisions; comment appends use the latest revision internally. Original creators/IDs are protected. Internal tools enforce project read/write scope and record assistant/automation attribution. The default Assistant has task tools and is instructed to use them for task writes; custom tool lists must include `append_task_comment` to enable discussions.

MCP and REST task mutations accept optional `agentName` for the author of that call. Empty/omitted values use the authenticated user. Creation records that author in `createdBy`; updates/reordering record the current author in `lastEditor` while preserving the original creator. All resulting mutation audit events, including assignment/status/mention events, retain the server-derived `authenticatedBy` alongside the operational `actor`. See [authorship and audit](documents.md#authorship-and-audit) for validation, REST query parameters and technical-identity fallbacks.

All these channels publish `task.added`, `task.updated`, `task.status_changed`, `task.assigned`, `task.reordered`, `task.deleted` as applicable, and record mutations in the system log. Automation definitions can subscribe to these events. Plain external filesystem edits are picked up on access but do not themselves emit task automation events. Automations that edit tasks should use the task tools to receive these guarantees.
