# Vault Layout Reference

Complete vault layout.

```txt
data/<vault>/
  README.md
  assistant.md
  vault-plan.json
  roles/
    architect.md
  workflows/
    update-situation.md
  docs/
    onboarding/
      README.md
  projects/
    project-id/
      project.json
      README.md
      assistant.md
      roles/
        qa.md
      workflows/
        daily-digest.md
      artifacts/
        readme.md
        2026-05-24-note.md
        architecture.png
        sketch.excalidraw
      plan/
        README.md
        2026-05-24-configure-proxy.md
      logs/
        activity/
          2026-05.md
      generated/
        situation.md
  .assistant/
    threads/
```

## Root

| Path | Purpose |
| --- | --- |
| `README.md` | General vault notes. |
| `assistant.md` | Global Assistant instructions. |
| `vault-plan.json` | Global planning data. Task records may include string `status`, `external_id`, and `link` fields. `link` can be external or a project-relative `artifacts/...`, `plan/...`, or `generated/...` path when the task has `projectId`. |
| `roles/` | Global Assistant roles. |
| `workflows/` | Global workflows. |
| `docs/` | Team documentation not tied to a single project. |
| `projects/` | Projects. |
| `.assistant/threads/` | Assistant chat threads and attachments. |

## Project

| Path | Purpose |
| --- | --- |
| `project.json` | Project metadata. |
| `README.md` | Main project notes. |
| `assistant.md` | Project Assistant instructions. |
| `roles/` | Project-specific roles. |
| `workflows/` | Project-specific workflows. |
| `artifacts/` | Project material. |
| `plan/` | Project operating plan. |
| `logs/` | Project logs. |
| `generated/` | Generated outputs. |

## Special Files

| File | Notes |
| --- | --- |
| `artifacts/readme.md` | Artifact index. |
| `plan/README.md` | Plan item index. |
| `logs/activity/*` | Activity log segments. |
| `generated/*.md` | Assistant/workflow outputs. |

## Legacy Compatibility

The code supports some legacy paths:

- `system.md` as the old global assistant file;
- `agents.md` as the old project assistant file;
- `agents/*.md` or `agents/<name>/AGENT.md`;
- `gantt.json` as the old global planning file;
- `tasks/` as the old plan area.

Use the modern paths for new vaults.
