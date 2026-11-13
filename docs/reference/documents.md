# Documents and Search

Devsync stores original documents in Markdown. SQLite provides a derived search index and the map from permanent document IDs to their current paths. The runtime uses built-in `node:sqlite`; no database service or additional package is required.

## Identity and existing files

Documents receive an `id` containing exactly five characters from `0-9 a-z`, for example:

```yaml
---
id: "a1b2c"
creator: "ada@example.com"
created: "2026-11-05T21:00:00.000Z"
tags: ["bug", "authentication"]
---
```

New IDs are generated on the server and checked for uniqueness in the vault. Application updates preserve ID, original creator and creation timestamp. Moving a document or renaming its project preserves the ID. The database can be discarded and rebuilt without changing IDs stored in files.

At HTTP/stdio startup, existing Markdown documents without IDs are backfilled. The original body, other YAML metadata and modification time are preserved. Unrecognized or duplicate IDs produce an explicit error with the affected ID/path. When copying an existing document to create a new one, remove its `id` before import, or use `create_document`, which always assigns a fresh ID. Removing only an existing document's ID while keeping the same indexed path restores its known ID on reconciliation.

Indexed paths:

- `projects/<project>/README.md`;
- Markdown under project `resources/`, `work/`, `tasks/` and `logs/`, including nested folders and legacy aliases;
- Markdown under `docs/<folder>/`, including nested folders.

Binary files, PDF/image text extraction, configuration, skills and automation definitions are outside full-text indexing. Existing path-based `read_file` calls can still read known text formats, including project instructions. Symbolic links are not indexed or followed.

## References and UI

The same document can be read using:

- `a1b2c`;
- `/d/a1b2c` or `https://devsync.example.com/d/a1b2c`;
- `devsync://document/a1b2c`.

References resolve in the configured vault; HTTP URLs are parsed locally and are never fetched as external sources. Share links open a document reading view after the normal authentication flow. The header's **Copy document link** action works from a project Markdown file, a shared docs file, or the document reading view.

Set `DEVSYNC_PUBLIC_URL=https://devsync.example.com` behind a reverse proxy, or to obtain absolute share links from stdio. HTTP MCP otherwise uses the request origin; stdio returns relative URLs plus the portable `devsync://` reference.

## MCP publishing

Create a project document:

```json
{
  "projectId": "my-project",
  "area": "work",
  "title": "Login incident analysis",
  "content": "The token expired before the request completed.",
  "tags": ["incident", "authentication"]
}
```

Pass this input to `create_document`. For shared docs, use `docId` instead of `projectId`; `docId` names the directory under `docs/`. `folder` optionally selects a nested directory. The result includes `id`, `url`, `ref`, `content` and `revision`. Project publication also appends an activity entry.

`read_file` accepts `{ "ref": "a1b2c" }` or the previous `{ "projectId": "my-project", "path": "work/file.md" }` form. It also accepts `docId` plus a docs-relative path.

To call `update_document`, pass `ref` (or location), Markdown `content`, and `expectedRevision` from the latest read. Optional `title` and `tags` replace those fields; omitted fields preserve existing metadata. ID and original creator cannot be supplied or replaced by the client. Concurrent updates using an old revision return a conflict, requiring a fresh read. Activity logs remain append-only; task index edits use task tools. Task-document updates preserve the managed comments section; use `append_task_comment` for a new reply. Altering existing comments through a generic document update is rejected.

### Authorship and audit

Every MCP write tool and REST project/document write accepts optional `agentName`. This is a free, declared name for the current call, with no agent registry or additional permissions. After trimming, a nonempty name becomes the author (`creator`/`createdBy` on creation, `lastEditor` on edits, or `author` on log entries). Omitted, null or whitespace-only names fall back to the authenticated user. Names must be a single line of at most 100 characters, without control characters. Original creators remain immutable when another agent edits a document or task; owner/assignee remains a separate field.

In REST JSON requests, pass `agentName` alongside the other fields. It can also be supplied as a query parameter; a non-null JSON value takes precedence. For multipart uploads and body-less requests, use the query parameter, for example `POST /api/projects/my-project/resources/upload?agentName=Custode`. In MCP, pass it in the tool arguments:

```json
{ "projectId": "my-project", "content": "Audit completed.", "agentName": "Custode" }
```

Each resulting API/MCP mutation audit event records both `actor` (the declared agent, or authenticated fallback) and `authenticatedBy` (the authenticated channel identity, always imposed by the server). For a client authenticated as `marco@example.com`, the example above produces:

```json
{ "actor": "Custode", "authenticatedBy": "marco@example.com" }
```

Raw client fields such as `author`, `creator`, `createdBy`, `editor` and `authenticatedBy` do not override server attribution. A shared REST API token identifies `api-token`; local stdio uses `local-stdio`, and anonymous local REST uses `team`. These technical identities also remain in the audit when `agentName` is supplied. The declared name is operational attribution, not proof of an independent authenticated agent. Concurrent calls sharing one MCP client each carry their own name; no current-agent state is shared. Historical audit records are not backfilled with an inferred identity.

The deprecated `list_plan_items`, `read_plan_item`, `create_plan_item`, `update_plan_item`, `toggle_plan_item` and `delete_plan_item` aliases are removed. Use the corresponding task tools.

### Activity updates over MCP

Use `append_log` for a project diary or update:

```json
{ "projectId": "my-project", "content": "Audit completed. The next action is tracked in the delivery task." }
```

The tool uses the existing activity-log storage, attributes the entry to `agentName` or the authenticated user, and records an `activity_log.appended` audit event with source `mcp` and the server-derived `authenticatedBy`. It returns the entry's ID, author, content, kind and segment path. Entries beyond `DEVSYNC_ACTIVITY_INLINE_MAX_CHARS` (default 800) are saved as Markdown resources and linked from the log; the result includes `artifactPath`. Inserts and segment rotation are serialized per project within the process, preserving unique entry IDs under concurrent requests. Use a single writer process for a vault; separate HTTP/stdio processes do not share the in-process lock.

Like `POST /api/projects/:projectId/logs`, this tool emits `project_log.added` for existing event automations. Logs remain append-only. Task filters and paginated summaries are documented in [tasks](tasks.md).

## Project creation and audit queries

MCP `create_project` uses the same filesystem operation as `POST /api/projects`:

```json
{ "name": "Agent Hub", "slug": "agent-hub", "tags": ["shared"], "agentName": "Coordinator" }
```

`name` is required; `slug`, `owner`, `status`, `tags` and `agentName` are optional. As in REST, the project folder ID is derived from `slug` or `name`, and the display name follows that folder ID. The result includes the project metadata and initial file lists. Existing projects return 409, including when two calls concurrently try to create the same project. Creation is audited with the operational author and authenticated identity.

MCP `list_system_log` and `GET /api/system-log` accept optional `actor`, `authenticatedBy`, `action` and `limit` (default 200, maximum 1000). Actor and authenticated-user filters are exact and case-sensitive after trimming query whitespace. All filters combine with AND and are applied before limiting the newest matching events. For example:

```json
{ "actor": "Custode", "authenticatedBy": "marco@example.com", "limit": 50 }
```

HTTP: `GET /api/system-log?actor=Custode&authenticatedBy=marco%40example.com&limit=50`. The System Log UI provides separate author/authenticated-user fields and shows the authenticated user alongside a different declared author. Historical events lacking `authenticatedBy` do not match an authenticated-user filter; no identity is inferred from their actor.

## Search

The global **Search documents** button and MCP `search_files` use the same index. Queries are plain words joined with AND. Words may occur in different columns or positions; matching ignores case and Latin accents. Punctuation is treated as word separation rather than executable FTS syntax. This release does not apply stemming, typo correction, prefix expansion or semantic search.

Results are one per Markdown file, ranked by FTS5 BM25 with column weights: title 5, filename 2, tags 3, body 1. Each result includes an excerpt, stable ID, URL and current location. Lower BM25 scores rank first. Up to 100 results can be requested (default 50).

Optional filters: `projectId`, `docId`, exact `tag`, exact creator identity `author`, and `type` (`resources`, `work`, `tasks`, `logs`, `readme`, `docs`).

```json
{
  "query": "login token",
  "projectId": "my-project",
  "tag": "incident",
  "type": "work"
}
```

HTTP equivalents are `GET /api/search`, `GET /api/documents`, `POST /api/documents` and `PATCH /api/documents`. The new PATCH API also requires `expectedRevision`. Existing authenticated APIs remain available.

## Index maintenance

The cache lives at `<vault>/.devsync/search.sqlite`, with SQLite WAL sidecars. A local `.gitignore` excludes the cache directory. HTTP and stdio initialize/reconcile at startup and every 30 seconds. Application Markdown writes update the index before returning; Assistant filesystem tools reconcile after tool execution and at run completion. External edits and deletions appear in search after reconciliation; reference reads also reconcile immediately, so moved links resolve without waiting for the interval.

Only files whose size, modification time or change time changed are reread during reconciliation. Ordinary searches query SQLite without rereading all document bodies. Logs are indexed as files, with the matching passage in the excerpt.

To rebuild the derived tables from the vault:

```bash
npm run reindex
```

The production Docker image includes this script; run `node scripts/reindex-documents.mjs` there with the configured data mount/environment.

Use the same vault configuration as the server. If the SQLite file itself is corrupt, stop the HTTP/stdio processes, remove only `.devsync/search.sqlite` and its `-wal`/`-shm` sidecars, and run the rebuild command. Original Markdown files are retained.
