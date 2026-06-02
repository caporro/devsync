# Vault Layout Reference

Complete vault layout.

```txt
data/<vault>/
  README.md
  assistant.md
  vault-plan.json
  config/
    skills.json
  skills/
    project-status/
      SKILL.md
  automations/
    update-situation.md
  docs/
    onboarding/
      README.md
  projects/
    project-id/
      project.json
      README.md
      assistant.md
      automations/
        daily-digest.md
      resources/
        2026-05-24-note.md
        architecture.png
        sketch.excalidraw
      tasks/
        README.md
        2026-05-24-configure-proxy.md
      logs/
        activity/
          2026-05.md
      work/
        situation.md
```

Assistant chat runtime is outside the vault:

```txt
data/runtime/<vault>/chats/
```

## Root

| Path | Purpose |
| --- | --- |
| `README.md` | General vault notes. |
| `assistant.md` | Global Assistant instructions. |
| `vault-plan.json` | Global planning data. Task records may include string `status`, `external_id`, and `link` fields. `link` can be external or a project-relative `resources/...`, `tasks/...`, or `work/...` path when the task has `projectId`. |
| `config/skills.json` | Vault skill config, including disabled system skills. |
| `skills/` | Vault Assistant skills. |
| `automations/` | Global automations. |
| `docs/` | Team documentation not tied to a single project. |
| `projects/` | Projects. |

## Project

| Path | Purpose |
| --- | --- |
| `project.json` | Project metadata. |
| `README.md` | Main project notes. |
| `assistant.md` | Project Assistant instructions. |
| `automations/` | Project-specific automations. |
| `resources/` | Raw material, inputs, sources, uploads, links, and notes. |
| `tasks/` | Project tasks. |
| `logs/` | Project logs. |
| `work/` | Produced or refined material from Assistant, automations, or people. |

## Special Files

| File | Notes |
| --- | --- |
| `tasks/README.md` | Task index. |
| `logs/activity/*` | Activity log segments. |
| `work/*.md` | Assistant/automation/person-produced outputs. |

Assistant resolution details: [assistant.md](assistant.md).

## Legacy Compatibility

The code supports some legacy paths:

- `system.md` as the old global assistant file;
- `agents.md` as the old project assistant file;
- `agents/*.md` or `agents/<name>/AGENT.md`;
- `gantt.json` as the old global planning file;
- `plan/` as the old task area;
- `artifacts/` as the old resources area;
- `generated/` as the old work area.

Use the modern paths for new vaults.
