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
---

# Prepare proposal

Description, references, updates and delivery notes.
```

## States and ownership

Allowed states are `backlog`, `todo`, `doing`, `pause`, `done`, `rejected`. New tasks default to `backlog`; creation can explicitly select any state. Transitions are unrestricted. `done` and `rejected` are terminal states for the My Tasks sort order; either can be reopened with any other state.

The owner is a user's email when the user can be resolved unambiguously. Existing unknown or ambiguous labels remain intact. Assignment does not launch an agent or an automation run. The body remains ordinary Markdown; there is no separate comments or workflow engine.

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

`list_tasks` and `GET /api/projects/:projectId/tasks` support the same options. Task summaries include `createdBy`, `updatedBy` (from `lastEditor`), `createdAt`, filesystem `updatedAt`, tags, status, owner, deadline, stable ID and revision. Historical files without a recorded editor return an empty `updatedBy`; no editor is invented.

| Option | Meaning |
| --- | --- |
| `done` | Exact completion boolean; `false` includes every status except `done`, including `rejected`. |
| `status` | One of the six task states. |
| `owner`, `createdBy` | Exact identity/label; an empty owner selects unassigned tasks. |
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
- `POST /api/projects/:projectId/tasks`: create, with optional `status`, `owner`, `deadline`, `body`.
- `PATCH /api/projects/:projectId/tasks/content?path=...`: update one task, requiring `expectedRevision` from the last read. Fields or complete Markdown are accepted.
- `PATCH /api/projects/:projectId/tasks/order`: reorder with `items: [{path, expectedRevision}]` for the current complete task list.
- `DELETE /api/projects/:projectId/tasks?path=...`: permanently delete, requiring `expectedRevision` in the JSON body.
- `GET /api/my/tasks`: assigned tasks grouped by project.

The old `tasks/readme` write endpoint rejects updates: the index is read-only. Legacy `/plan` aliases remain for create/update/toggle/delete. `toggle_task` and the toggle endpoint remain compatibility operations: checked means `done`, unchecked means `todo`; a current revision is required. Prefer explicit status updates.

## Assistant, automations and MCP

The same storage operations back HTTP, MCP and internal agent tools: `list_tasks`, `read_task`, `create_task`, `update_task`, `toggle_task`, `reorder_tasks`, `delete_task`. All edits, reorders and deletes require current revisions. Original creators/IDs are protected. Internal tools enforce project read/write scope and record assistant/automation attribution. The default Assistant has task tools and is instructed to use them for task writes.

MCP and REST task mutations accept optional `agentName` for the author of that call. Empty/omitted values use the authenticated user. Creation records that author in `createdBy`; updates/reordering record the current author in `lastEditor` while preserving the original creator. All resulting mutation audit events, including assignment/status/mention events, retain the server-derived `authenticatedBy` alongside the operational `actor`. See [authorship and audit](documents.md#authorship-and-audit) for validation, REST query parameters and technical-identity fallbacks.

All these channels publish `task.added`, `task.updated`, `task.status_changed`, `task.assigned`, `task.reordered`, `task.deleted` as applicable, and record mutations in the system log. Automation definitions can subscribe to these events. Plain external filesystem edits are picked up on access but do not themselves emit task automation events. Automations that edit tasks should use the task tools to receive these guarantees.
