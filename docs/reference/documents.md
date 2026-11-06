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

To call `update_document`, pass `ref` (or location), Markdown `content`, and `expectedRevision` from the latest read. Optional `title` and `tags` replace those fields; omitted fields preserve existing metadata. ID and original creator cannot be supplied or replaced by the client. Concurrent updates using an old revision return a conflict, requiring a fresh read. Activity logs remain append-only; task index edits use task tools.

Personal HTTP MCP tokens determine `creator`/`createdBy` and `lastEditor`. Shared API tokens use the technical identity `api-token`; local stdio uses `local-stdio`. The client cannot select the author. HTTP UI/API writes likewise derive the actor from the authenticated user. Original creator and owner/assignee are separate concepts.

The deprecated `list_plan_items`, `read_plan_item`, `create_plan_item`, `update_plan_item`, `toggle_plan_item` and `delete_plan_item` aliases are removed. Use the corresponding task tools.

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

Use the same vault configuration as the server. If the SQLite file itself is corrupt, stop the HTTP/stdio processes, remove only `.devsync/search.sqlite` and its `-wal`/`-shm` sidecars, and run the rebuild command. Original Markdown files are retained.
