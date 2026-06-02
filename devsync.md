# Devsync

## Overview

Devsync is a filesystem-first product for managing a team or solo developer's operational memory, documentation, resources, work, tasks, activity logs, AI Assistant, and automations.

The core idea is simple: every project is a readable folder that can be versioned and synchronized with Git. Devsync provides a UI, API, MCP, Assistant, and automations on top of this structure, without introducing a database until it is truly needed.

The product must work in three modes:

- personal local, started by a developer on their own vault;
- local team, started on a shared repository/vault;
- hosted team, exposed as a service accessible by team members.

The target is an operational tool, not a landing page or a generic CMS. It must help a team keep context, decisions, files, tasks, logs, and automations together in a simple, inspectable, agent-friendly way.

## Principles

- KISS and YAGNI: always choose the smallest solution that works.
- Filesystem first: data must remain readable by editors, shell, Git, and agents.
- Git is the official source of the vault.
- No database for now.
- Markdown for narrative content, small JSON for metadata, JSONL for technical logs.
- Arbitrary projects: Devsync does not impose a domain.
- Assistant and automations must respect declared permissions.
- No hidden magic: explicit errors, stable formats, predictable operations.

## What a Project Represents

A project is an arbitrary information container. It can represent:

- a client;
- an integration;
- a release;
- a company event;
- a vacation plan;
- research;
- an internal initiative;
- any collaborative space the team decides to use.

The project has a base Devsync structure, but its meaning remains open.

## Vault Structure

Single vault per instance for now.

Conceptual structure:

```txt
data/<vault>/
  assistant.md
  roles/
    *.md
  team/
    users.json
    permissions.json
  automations/
    *.md
  docs/
  projects/
    <project-id>/
      project.json
      README.md
      assistant.md
      roles/
        *.md
      automations/
      resources/
      tasks/
        README.md
      logs/
        activity/
          000001.md
        system.jsonl
      work/
```

Runtime chat history is stored outside the Git vault:

```txt
data/runtime/<vault>/chats/
```

## Project Structure

Every project contains:

- `project.json`: project metadata.
- `README.md`: base notes.
- `assistant.md`: prompt and technical configuration for the project Assistant.
- `roles/`: temporary roles selectable in chat.
- `automations/`: project-specific automations.
- `resources/`: raw material, inputs, sources, uploads, links, and notes.
- `tasks/`: high-level project tasks.
- `tasks/README.md`: task index with Markdown checkboxes.
- `logs/activity/`: manual project log, append-only, segmented Markdown.
- `logs/system.jsonl`: technical write log, metadata only.
- `work/`: material produced or refined by automations, Assistant, or people.

## Backend

Current stack:

- Node ESM.
- Fastify.
- Filesystem storage.
- MCP server.
- LangChain/deepagents for Assistant and automations.

Responsibilities:

- HTTP API.
- Local auth.
- Vault/project/file management.
- Task creation.
- Activity log.
- Future system log.
- Vault git pull/push.
- AI Assistant.
- AI automation.
- Automation scheduler/events.
- MCP.

Patterns:

- Thin APIs in `server/src/index.js`.
- Storage in `server/src/storage.js`.
- Separate Assistant/automation runtimes.
- No premature service layers.

## Frontend

Current stack:

- React + Vite + TypeScript.
- TanStack Query.
- Tailwind/shadcn style.
- Hugeicons where already used.

Desired UI:

- dense, readable operational tool;
- global/project sidebar;
- central content area;
- right rail for logs, resources, work, tasks, Assistant, automations;
- in the Plan view, task titles can be edited inline from the index;
- activity input always available in project contexts;
- no landing page;
- no useless decoration.

Existing or planned views:

- Projects.
- Project Log.
- System Log.
- Resources.
- Plan.
- Work files.
- Global docs.
- Assistant.
- Automations.
- Git.
- Config.
- Global and project chat.

## Git and Vault

Git is the official source of the vault.

Decided state:

- one vault per instance;
- manual push/pull for now;
- if Devsync is centrally hosted, ideally only one instance writes to the vault;
- Git conflicts are not handled specifically yet;
- automations do not auto-push by default;
- a dedicated automation tool for pushing can be added.

Avoid for now:

- auto-commit on every operation;
- complex multi-writer handling;
- invisible sync.

## Auth and Users

Current state:

- `AUTH_MODE=none` for local;
- `AUTH_MODE=password` for self-host;
- users/passwords from env.

Decisions:

- in `AUTH_MODE=none`, default author: `user`;
- GitHub/Google OAuth is future Step3+;
- actual team users must be represented in files editable without restart;
- project owner should eventually be selected from the user list, not free text.

No-database proposal:

```json
{
  "users": [
    {
      "id": "claudio",
      "name": "Claudio",
      "email": "claudio@example.com"
    }
  ]
}
```

Planned file:

```txt
data/<vault>/team/users.json
```

Env remains useful for auth bootstrap, secrets, and integrations.

## Permissions

Future step, not implemented yet.

Decisions:

- project-level permissions;
- a user sees only authorized projects;
- if a project has no permission config, it is visible to everyone;
- everyone can create projects;
- no superadmin needed for now;
- MCP/API must hide projects that are not visible;
- assistant config, roles, and automations are editable by all users who can see/edit the project, at least for now.

Proposal:

```json
{
  "groups": {
    "team-dev": ["claudio", "mario"]
  },
  "projects": {
    "project-id": {
      "admins": ["claudio"],
      "editors": ["team-dev"],
      "viewers": []
    }
  }
}
```

Planned file:

```txt
data/<vault>/team/permissions.json
```

Recommended roles:

- `admin`: manages project configuration.
- `editor`: reads/writes content.
- `viewer`: read-only.

These files must be reloadable without restart, by reading on every request or using an `mtime`-based cache.

## Activity Log

There are two distinct logs.

### Project Activity Log

Operational/manual project log.

Characteristics:

- updated almost only by users;
- Markdown format;
- append-only;
- old entries above, new entries below;
- segmented into files such as `logs/activity/000001.md`;
- if text is too long, it becomes a `.md` resource and the log only keeps the link;
- resource uploads add an entry.

Purpose:

- conversational project memory;
- human timeline;
- quick context for team and Assistant.

### System Log

Technical write-operation log.

Recommended decision:

```txt
projects/<project-id>/logs/system.jsonl
```

Format: append-only JSONL, metadata only.

Example:

```json
{"ts":"2026-05-18T10:00:00.000Z","actor":"claudio","action":"resource.create","path":"resources/spec.md","source":"web","runId":null}
```

Useful fields:

- `ts`
- `actor`
- `action`
- `path`
- `source`
- `runId`
- `automationId`
- `assistantId`
- `status`
- `error`

Recommendation:

- exclude it from Git by default to reduce noise and conflicts;
- add a future env `DEVSYNC_VERSION_SYSTEM_LOG=true` if a team wants to version it.

Scheduled automation errors should go into the system log.

## Resources

Resources are files under `resources/`.

Current types:

- file upload;
- Markdown note;
- link saved as Markdown.

Rules:

- readable and safe file names;
- folder views are built dynamically from the filesystem;
- preview/download with correct MIME type;
- Markdown editable from the UI.

Not in scope now:

- OCR;
- PDF/docx text extraction;
- advanced full-text indexing.

## Tasks

Tasks are the project's high-level operational memory.

Rules:

- `tasks/README.md` is the readable Markdown index.
- Every task has a dedicated Markdown file in `tasks/`.
- State is only a Markdown checkbox: `[ ]` open, `[x]` completed.
- Allowed frontmatter: `title`, `createdAt`, `createdBy`, `owner`, `deadline`.
- No structured statuses, priority, source, type, or assignee.
- It is not a work management system: it contains operational decisions, next steps, follow-ups, things to clarify or complete.
- The title shown in the index comes from the task file.
- If the title is edited from the index, Devsync also updates the file frontmatter and H1.
- If the title is edited inside the file, Devsync regenerates `tasks/README.md` with the new title.
- Toggling done/open only changes the checkbox in the index.

## Assistant

Devsync has one main Assistant.

Terminology:

- `Assistant`: main chat.
- `Role`: temporary prompt specialization.
- `Automation`: automatic procedure/execution.
- `Tool`: technical capability available to the Assistant or a automation.

Official files:

```txt
data/<vault>/assistant.md
data/<vault>/roles/*.md
data/<vault>/projects/<project-id>/assistant.md
data/<vault>/projects/<project-id>/roles/*.md
```

Project chat prompt resolution:

```txt
1. hardcoded Devsync base assistant
2. data/<vault>/assistant.md
3. data/<vault>/projects/<project-id>/assistant.md
4. selected role, if present
```

`assistant.md` uses technical frontmatter and Markdown body for the prompt:

```md
---
name: Metering Assistant
description: Project-specific assistant.
model: openai:gpt-4.1-mini
tools:
  - filesystem
  - send_email_ses
read:
  - "**/*"
write:
  - resources/**
  - work/**
---
Use only the current project context.
Answer briefly and operationally.
```

Rules:

- vault assistant and project assistant are combined in the prompt;
- project assistant specializes the vault assistant;
- the UI shows a single resolved Assistant;
- there are no multiple agents visible to the user;
- `tools` are merged from base, vault assistant, and project assistant;
- `read/write` are always relative to the mounted root;
- in project chat, the mounted root is always `data/<vault>/projects/<project-id>`;
- even the vault assistant, when running inside a project, cannot read other projects;
- if no assistant declares `read`, default is `**/*` in the mounted scope;
- if no assistant declares `write`, default is `[]`;
- if `write: []`, Assistant is read-only;
- the Assistant can write only if the tool and runtime permissions allow it.

Role:

```md
---
name: Architect
description: Review technical decisions and trade-offs.
---
Act as a pragmatic software architect.
```

Role rules:

- roles are only temporary prompt additions;
- no tools, model, read/write, or permissions in roles;
- vault roles are available in all projects;
- project roles are added to vault roles;
- if a project role has the same slug as a vault role, it overrides it;
- the chat select does not show duplicates.

Current or planned custom tools:

- `append_activity_log`;
- `save_generated_markdown`;
- `send_email_ses`;
- future Git push tool;
- future Teams tool.

Temporary compatibility:

- `system.md`;
- `agents.md`;
- `agents/*/AGENT.md`.

These files are legacy and only exist as fallback while migrating to the new format.

## Automations

Automations are operational definitions in Markdown:

```txt
data/<vault>/automations/*.md
data/<vault>/projects/<project-id>/automations/*.md
```

Characteristics:

- frontmatter with `trigger`, `tools`, `read`, `write`, `model`;
- can be manual, event-based, or scheduled;
- the running app checks every minute for automations to execute;
- scheduler enabled by default;
- can be disabled with `DEVSYNC_SCHEDULER_ENABLED=false`;
- errors saved in the system log;
- no automatic Git push unless an explicit tool is used.

Decisions:

- automations can write directly if authorized;
- automatic/technical logs go to system log;
- notifications can be sent by automations;
- mentions are likely processed by a cumulative scheduled automation.

## Chat

Assistant chat has two scopes:

- global;
- per-project.

Decisions:

- UI with one main "Assistant" chat;
- role select near the input field;
- `Default` option with no role;
- separate role sections: `Vault roles` and `Project roles`;
- if no roles exist, the select can be hidden or show only `Default`;
- asynchronous communication: POST message, background run, SSE stream by run id;
- chat history must not be versioned in the Git vault;
- better saved outside the vault, for example in runtime data;
- steps shown in the UI are telemetry/tool/runtime events, not private chain-of-thought.

Current default: `data/runtime/<vault>/chats`.

## Mentions

Future feature.

Idea:

- use Tiptap mentions in project log or tasks;
- if `@Claudio` does not resolve to a user, it remains plain text;
- resolvable users come from `team/users.json` or env initially;
- notification does not necessarily need to be immediate: a cumulative scheduled automation is preferable to reduce noise.

Possible channels:

- SES email;
- Teams;
- other future automation tools.

## MCP

MCP should become a complete agentic API.

Current state:

- `list_projects`;
- `get_project`;
- `search_files`;
- `read_file`;
- `list_tasks`;
- `read_task`;
- `create_task`;
- `update_task`;
- `toggle_task`;
- `delete_task`.

Direction:

- respect auth and permissions;
- hide unauthorized projects;
- allow the same operations as the web UI and more;
- read/write resources;
- read/write work files;
- add project log;
- manage tasks;
- start automations;
- query system log.

Desired MCP auth:

- user/password if possible;
- otherwise personal token or controlled session.

## Scheduler

Decisions:

- single instance per vault as an operational assumption;
- no distributed lock for now;
- env:

```env
DEVSYNC_SCHEDULER_ENABLED=true
```

Default: enabled.

If multiple instances point to the same vault, the team must disable the scheduler on replicas.

## Notifications

State:

- SES available as a tool.

Possible extensions:

- Teams;
- mention digests;
- automation failure summary;
- task reminders.

Current decision:

- notifications as automation/Assistant tools, not a dedicated UI feature for now.

## Search

State:

- simple search via filesystem scan.

Future:

- full-text search in a later step;
- possible regenerable local index;
- avoid a database until it is needed.

## Deploy

Targets:

- installable source;
- single fullstack server+web Docker image published on Docker Hub;
- local Electron app.

Docker:

- one image for backend + web build;
- config via env;
- volume for `data/`.

Electron:

- starts embedded local server;
- uses local vault or cloned Git vault;
- if `~/.devsync/config.json` is missing, opens an Electron-only configuration page;
- config wizard to choose data path, vault, Git repo, and base parameters.

Default data path:

```txt
data/
```

Config/env can override the path.

## Config

Current or planned env:

```env
PORT=4000
HOST=127.0.0.1
DEVSYNC_VAULT_NAME=devsync-vault
DEVSYNC_DATA_ROOT=data
DEVSYNC_DATA_DIR=

DEVSYNC_VAULT_REPO_URL=
DEVSYNC_GIT_USERNAME=oauth2
DEVSYNC_GIT_TOKEN=

DEVSYNC_SCHEDULER_ENABLED=true
DEVSYNC_ASSISTANT_MODEL=openai:gpt-4.1-mini

AUTH_MODE=none
AUTH_USERS=
AUTH_SESSION_SECRET=
AUTH_COOKIE_SECURE=false

DEVSYNC_SES_REGION=
DEVSYNC_SES_ACCESS_KEY_ID=
DEVSYNC_SES_SECRET_ACCESS_KEY=
DEVSYNC_SES_FROM_EMAIL=
```

Security note:

- any temporary credential files in root, such as helper access keys, must be removed before distribution or added to ignore rules.

## Rough Roadmap

### Current Step2

- single vault/project Assistant;
- manual automations;
- event/schedule automations;
- AI tools controlled by permissions;
- global/project chat;
- system log;
- MCP improvements.

### Step3 Permissions/Team

- `team/users.json`;
- `team/permissions.json`;
- project visibility;
- owner selected from users;
- future GitHub/Google OAuth;
- MCP/API filtered per user.

### Packaging

- single Docker image;
- local Electron app;
- Electron-only config wizard;
- configurable data path.

### Future

- full-text search;
- mention digest;
- Teams integration;
- richer audit UI;
- project templates;
- vault export/import;
- automation/role/assistant template marketplace.

## Feature Ideas

- Minimal project templates: release, client, integration, event, retrospective.
- Weekly project digest generated by automation.
- "What changed since last sync" for resources/tasks/logs.
- Unified project timeline with filters: manual, AI, file, system.
- Automation library: update situation, release notes, decision log, handover.
- Dedicated decision log: `decisions.md` or resource type `decision`.
- Cumulative mention digest via email/Teams.
- Project health snapshot produced in `work/health.md`.
- More explicit Git status panel: ahead/behind, dirty files, last commit.
- Complete MCP write tools for Assistant and external agents.
- Export project as zip/Markdown bundle.
- Soft archive projects instead of delete.
- "Context pack" for Assistant: generate a compact project bundle.
- UI for testing automations with dry-run.
- Automation tool `git_push_vault`.
- Automation tool `teams_notify`.

## Business Ideas

- Positioning: "filesystem-first project memory for AI-native teams".
- Difference from Notion/Confluence: Git-native, agent-friendly, self-hostable, no database.
- Difference from operational trackers: the Plan stores high-level memory and next steps.
- Difference from AI chat: structured, versionable, operational memory.
- Initial target: technical teams, platform teams, consulting, enterprise integrations, L3 support.
- Strong value: reduces context loss between people, Assistant, and tools.
- Possible model:
  - open source core;
  - Docker image;
  - desktop Electron;
  - paid hosted/team features;
  - paid Teams/OAuth integrations pack;
  - paid automation/assistant templates.
- Initial wedge: "stop losing project context across chats, files, and scattered notes".
- Channel: dev teams already using Git and wanting AI without putting everything into opaque SaaS tools.

## Use Case Ideas

- Project memory for development teams.
- Versioned technical knowledge base.
- Client integration hub.
- Decision and handover register.
- L3 support: bugflow, resources, logs, escalation.
- Release coordination.
- Incident/postmortem workspace.
- Meeting preparation and follow-up.
- Onboarding a new member onto a project.
- Vacation/shift/internal event coordination.
- AI Assistant workspace with controlled permissions.
- Artifact collection from email/link/file with automatic log.
- Periodic reports generated by automation.
- Personal local vault for developers.

## Open Questions

- Multi-writer Git conflict handling.
- Final scheduler/event format.
- Where to save runtime data outside the vault in hosted vs Electron.
- How much of the system log to version.
- Permission depth: only project-level or folders in the future too.
- Final MCP auth strategy.
- Mentions UX and digest notification.
- Electron packaging and Git vault bootstrap.
