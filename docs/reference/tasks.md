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

## HTTP API

- `GET /api/tasks`: all project tasks with project ID/name, status and revision; no Markdown bodies.
- `GET /api/projects/:projectId/tasks`: ordered tasks with status and revision.
- `GET /api/projects/:projectId/tasks/content?path=tasks/file.md`: full task and revision.
- `POST /api/projects/:projectId/tasks`: create, with optional `status`, `owner`, `deadline`, `body`.
- `PATCH /api/projects/:projectId/tasks/content?path=...`: update one task, requiring `expectedRevision` from the last read. Fields or complete Markdown are accepted.
- `PATCH /api/projects/:projectId/tasks/order`: reorder with `items: [{path, expectedRevision}]` for the current complete task list.
- `DELETE /api/projects/:projectId/tasks?path=...`: permanently delete, requiring `expectedRevision` in the JSON body.
- `GET /api/my/tasks`: assigned tasks grouped by project.

The old `tasks/readme` write endpoint rejects updates: the index is read-only. Legacy `/plan` aliases remain for create/update/toggle/delete. `toggle_task` and the toggle endpoint remain compatibility operations: checked means `done`, unchecked means `todo`; a current revision is required. Prefer explicit status updates.

## Assistant, automations and MCP

The same storage operations back HTTP, MCP and internal agent tools: `list_tasks`, `read_task`, `create_task`, `update_task`, `toggle_task`, `reorder_tasks`, `delete_task`. All edits, reorders and deletes require current revisions. Original creators/IDs are protected. Internal tools enforce project read/write scope and record assistant/automation attribution. The default Assistant has task tools and is instructed to use them for task writes.

All these channels publish `task.added`, `task.updated`, `task.status_changed`, `task.assigned`, `task.reordered`, `task.deleted` as applicable, and record mutations in the system log. Automation definitions can subscribe to these events. Plain external filesystem edits are picked up on access but do not themselves emit task automation events. Automations that edit tasks should use the task tools to receive these guarantees.
