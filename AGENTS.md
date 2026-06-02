# Devsync - Agent Operating Manual

> When in doubt, choose the simplest solution that works. KISS and YAGNI are project rules, not preferences.

## 0. Scope
This repository contains Devsync: a filesystem-first system for managing team project documentation, resources, work, and activity logs.

Main structure:
- `server/`: Node/Fastify backend, HTTP API, filesystem storage, MCP server.
- `web/`: React/Vite frontend.
- `data/<vault>/`: local runtime data. The vault name is defined by `DEVSYNC_VAULT_NAME`.
- `data/<vault>/projects/`: local projects. Each folder is one project.
- root: Docker, compose, README, shared config.

Operating rule:
- If the request concerns APIs, storage, MCP, or filesystem behavior, work in `server/`.
- If it concerns UI/UX, components, or client state, work in `web/`.
- Touch both only for end-to-end integrations or API contract changes.

## 1. Philosophy
Devsync must stay simple, readable, and maintainable by AI agents.

Non-negotiable principles:
1. KISS: fewer moving parts, fewer abstractions, less magic.
2. YAGNI: do not build future layers until the current product path needs them.
3. Filesystem first: data must remain inspectable and versionable with git.
4. No database until it is truly needed. If needed, prefer SQLite.
5. Make the real path work first, then refine.
6. If a feature requires a lot of architecture, it is probably too early.

Guiding question: what is the smallest, clearest, most predictable solution that solves the current need?

## 2. Domain
A Devsync project is a folder under `data/<vault>/projects/`.

Core concepts:
- `project.json`: project metadata such as name, owner, status, and tags.
- `README.md`: base project notes.
- `resources/`: raw material, input, sources, uploads, links, notes, images, and PDFs.
- `logs/activity.md`: append-only project activity log.
- `work/`: material produced or refined by Assistant, automations, or people.

Activity log:
- Must behave like a chat: older entries above, newer entries below.
- The input must stay sticky at the bottom in the UI.
- If a text log is long, store it as a `.md` resource and keep only the link in the log.
- Uploads must add an entry to the log.

## 3. Current Product
Current scope includes:
- project management;
- resource/work file management;
- ingestion from uploads, links, and textarea;
- activity log;
- project metadata;
- Assistant chat;
- assistant roles and project/vault instructions;
- automation definitions, manual runs, event triggers, and scheduled runs;
- MCP server with authenticated tools.

Still out of scope unless explicitly requested:
- live external integrations beyond configured tools;
- automatic commit import;
- complex RBAC or organization permissions.

## 4. Backend
Stack:
- Node ESM.
- Fastify.
- Filesystem storage.
- Node MCP server.

Patterns:
- Keep APIs thin in `server/src/index.js`.
- Keep filesystem logic in `server/src/storage.js`.
- Keep MCP logic in `server/src/mcp.js`.
- Avoid additional frameworks unless there is a concrete need.
- Prefer small, testable functions over premature classes or service layers.

Filesystem rules:
- Never save outside `data/<vault>/`.
- Always validate project ids and relative paths.
- Prevent path traversal.
- Do not read binary files as UTF-8 unless they are known text files.
- For download/preview, use streams or buffers with the correct MIME type.
- Do not delete user data without explicit confirmation.

## 5. Frontend
Stack:
- React + Vite + TypeScript.
- TanStack Query.
- Tailwind/shadcn style.
- Hugeicons where already used.

UI principles:
- Operational tool, not a landing page.
- Dense, readable, predictable layout.
- No useless decorative components.
- Avoid hidden state or magic behavior.
- Every destructive action must be confirmed.

Project view:
- Left sidebar: global navigation and projects.
- Center area: selected content.
- Right rail: activity log, Assistant/automations, resources, work, tasks.
- Activity input always visible at the bottom.

## 6. Data Contracts
Keep files human-friendly and agent-friendly.

Preferences:
- Small, stable JSON for structured metadata.
- Markdown for narrative content.
- Append-only activity log with machine-readable markers.
- Readable, safe file names.
- No complex index if a directory scan is enough.

Before changing a data format:
1. Verify compatibility with existing data.
2. Keep migration simple or preserve backward compatibility.
3. Update the README if the contract changes.

## 7. Testing
Use pragmatic tests for the touched path.

Useful commands:
```bash
npm start
npm run build
npm --prefix web run lint
node --check server/src/index.js
npm run mcp
```

E2E/UI rule:
- Do not run e2e tests automatically.
- Do not start servers automatically.
- Do not open browsers automatically.
- Do not perform interactive UI verification unless the user explicitly asks for it.

For visual bugs:
- Verify raw data through the API before changing CSS.
- For file previews, check bytes, MIME type, and browser rendering.
- Do not guess through trial and error when the cause is unclear.

## 8. Operating Mode
Default: Builder Mode.
- Read the minimum useful context.
- Make small, local changes.
- Do not introduce unrelated refactors.
- Do not install dependencies without a strong reason.
- Do not create abstractions "for the future".
- Explain tradeoffs only when they are needed for a decision.

If a solution looks elegant but increases moving parts, choose a simpler one.

## 9. Invariants
Always preserve:
1. Data readable from the filesystem.
2. Git/version-control compatibility.
3. Small, predictable APIs.
4. No hardcoded secrets.
5. Assistant and automation writes must stay permission-scoped, auditable, and filesystem-first.
6. UI consistent with dark/light themes.
7. Explicit errors, no dangerous silent fallbacks.

## 10. Goal
Every change must improve at least one of:
`simplicity`, `reliability`, `readability`, `operability`.

If it improves nothing, do not make it.
