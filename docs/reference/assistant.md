# Assistant Reference

Devsync has one Assistant. Assistant files add instructions and configuration for that Assistant.

## Files

Global Assistant:

```txt
data/<vault>/assistant.md
```

Project Assistant:

```txt
data/<vault>/projects/<project>/assistant.md
```

## Prompt Order

The runtime system prompt is composed in this order:

```txt
base Devsync prompt
+ current local time
+ virtual filesystem root
+ tool/path/write rules
+ vault assistant prompt
+ project assistant prompt
+ available skill catalog
```

Assistant prompt bodies are additive. The project assistant does not delete the vault assistant. If project instructions conflict with vault instructions, the project instructions appear later and should be treated as more specific.

## Frontmatter

Assistant files may include frontmatter:

```md
---
title: "Project Operator"
description: "Assistant for project operations"
model: openai:gpt-4.1-mini
tools:
  - filesystem
  - save_generated_markdown
read:
  - "**/*"
write:
  - work/**
  - tasks/**
---
Project-specific instructions go here.
```

Resolution rules:

| Field | Rule |
| --- | --- |
| `title` | project > vault > base |
| `description` | project > vault > base |
| `model` | project > vault > base |
| `tools` | merged from base, vault, and project |
| `read` | if declared, merged from vault and project; otherwise base |
| `write` | if declared, merged from vault and project; otherwise base |

Base Assistant defaults:

```txt
model: DEVSYNC_ASSISTANT_MODEL, then DEVSYNC_AGENT_MODEL, then openai:gpt-4.1-mini
tools: filesystem, use_skill
read: **/*
write: tasks/**, resources/**, work/**, automations/**
```

## Skills

Skills are listed in the system prompt as a catalog only. Full skill instructions are loaded later with the `use_skill` tool.

System skills:

```txt
server/skills/<skill-name>/SKILL.md
```

Vault skills:

```txt
data/<vault>/skills/<skill-name>/SKILL.md
```

Vault skill config:

```txt
data/<vault>/config/skills.json
```

Example:

```json
{
  "disabledSystemSkills": [
    "project-status",
    "extract-tasks"
  ]
}
```

Skill resolution:

- system skills are loaded first;
- disabled system skills are removed;
- vault skills override system skills with the same name;
- project-level skills are not supported.

## Legacy Compatibility

The code still supports legacy Assistant files:

- `data/<vault>/system.md`
- `data/<vault>/agents/*.md`
- `data/<vault>/agents/<name>/AGENT.md`
- `data/<vault>/projects/<project>/agents.md`
- `data/<vault>/projects/<project>/agents/*.md`
- `data/<vault>/projects/<project>/agents/<name>/AGENT.md`

Use `assistant.md` for new vaults and projects.
