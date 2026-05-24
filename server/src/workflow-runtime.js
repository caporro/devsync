import fs from "node:fs/promises"
import path from "node:path"

import { createDeepAgent, FilesystemBackend } from "deepagents"

import { assistantScopeRoot, loadAssistantInstructionContext } from "./assistant-config.js"
import { resolveAgentTools } from "./agent-tools.js"
import { AiToolLogHandler } from "./ai-logging.js"
import { resolveChatModel } from "./model-resolver.js"
import { filesystemPermissions, hasFilesystemTool } from "./runtime-permissions.js"
import { addLog, vaultName } from "./storage.js"
import { appendSystemLogEvent } from "./system-log.js"

function contentToText(content) {
  if (typeof content === "string") {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part
        if (typeof part?.text === "string") return part.text
        return ""
      })
      .join("")
  }

  return ""
}

function localTimestamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: process.env.TZ || "Europe/Rome",
  }).format(new Date())
}

function safeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error instanceof Error ? error.message : String(error),
    cause: error?.cause instanceof Error ? error.cause.message : error?.cause ? String(error.cause) : undefined,
    stack: error instanceof Error ? error.stack : undefined,
  }
}

function cleanVirtualPath(value) {
  const clean = String(value ?? "").trim().replace(/^\/+/, "").replace(/^(?:\.\/)+/, "")

  if (!clean || clean === "." || clean.startsWith("..") || clean.includes("/../")) {
    throw Object.assign(new Error("Invalid workflow write path"), { statusCode: 400 })
  }

  return clean
}

function pathInsideRoot(root, target) {
  const relative = path.relative(root, target)
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
}

function snapshotEntry(root, fullPath, stat) {
  const relative = path.relative(root, fullPath).split(path.sep).join("/")

  if (!relative || relative.startsWith("..")) {
    return null
  }

  return {
    path: relative,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

async function addFileSnapshot(root, fullPath, entries) {
  const stat = await fs.lstat(fullPath)

  if (stat.isDirectory()) {
    return false
  }

  const entry = snapshotEntry(root, fullPath, stat)
  if (entry) {
    entries.set(entry.path, entry)
  }

  return true
}

async function collectSnapshots(root, fullPath, entries, recursive) {
  let stat

  try {
    stat = await fs.lstat(fullPath)
  } catch (error) {
    if (error.code === "ENOENT") {
      return
    }
    throw error
  }

  if (!stat.isDirectory()) {
    const entry = snapshotEntry(root, fullPath, stat)
    if (entry) {
      entries.set(entry.path, entry)
    }
    return
  }

  const children = await fs.readdir(fullPath, { withFileTypes: true })
  for (const child of children) {
    const childPath = path.join(fullPath, child.name)

    if (child.isDirectory()) {
      if (recursive) {
        await collectSnapshots(root, childPath, entries, true)
      }
    } else {
      await addFileSnapshot(root, childPath, entries)
    }
  }
}

function resolveWritePatternRoot(scopeRoot, rawPattern) {
  const clean = cleanVirtualPath(rawPattern)
  let mode = "exact"
  let base = clean

  if (clean === "**" || clean === "**/*") {
    mode = "recursive"
    base = "."
  } else if (clean.endsWith("/**")) {
    mode = "recursive"
    base = clean.slice(0, -3) || "."
  } else if (clean.endsWith("/*")) {
    mode = "direct"
    base = clean.slice(0, -2) || "."
  } else if (clean.includes("*")) {
    mode = "recursive"
    base = clean.slice(0, clean.indexOf("*")).replace(/\/?[^/]*$/, "") || "."
  }

  const fullPath = path.resolve(scopeRoot, base)
  const root = path.resolve(scopeRoot)

  if (fullPath !== root && !pathInsideRoot(root, fullPath)) {
    throw Object.assign(new Error("Workflow write path escapes project scope"), { statusCode: 400 })
  }

  return { fullPath, mode }
}

export async function snapshotWorkflowWritePaths(scopeRoot, writePaths = []) {
  const entries = new Map()

  for (const item of writePaths) {
    const { fullPath, mode } = resolveWritePatternRoot(scopeRoot, item)
    await collectSnapshots(scopeRoot, fullPath, entries, mode === "recursive")
  }

  return entries
}

export function diffWorkflowWriteSnapshots(before, after) {
  const added = []
  const modified = []
  const deleted = []

  for (const [filePath, current] of after.entries()) {
    const previous = before.get(filePath)
    if (!previous) {
      added.push(filePath)
    } else if (previous.size !== current.size || previous.mtimeMs !== current.mtimeMs) {
      modified.push(filePath)
    }
  }

  for (const filePath of before.keys()) {
    if (!after.has(filePath)) {
      deleted.push(filePath)
    }
  }

  added.sort()
  modified.sort()
  deleted.sort()

  return {
    added,
    modified,
    deleted,
    changed: [...added, ...modified, ...deleted].sort(),
  }
}

async function appendWorkflowFileAudit({ workflow, projectId, before, after }) {
  const diff = diffWorkflowWriteSnapshots(before, after)

  await appendSystemLogEvent({
    action: "workflow.files_changed",
    source: "workflow-runtime",
    actor: `workflow:${workflow.key}`,
    projectId,
    summary: `Workflow ${workflow.key} changed ${diff.changed.length} file${diff.changed.length === 1 ? "" : "s"}`,
    metadata: {
      workflowId: workflow.id,
      workflowKey: workflow.key,
      added: diff.added,
      modified: diff.modified,
      deleted: diff.deleted,
      changed: diff.changed,
    },
  })

  return diff
}

async function buildSystemPrompt(workflow, projectId) {
  const instructionContext = await loadAssistantInstructionContext(projectId)
  const contract = [
    `<workflow_contract>`,
    `Allowed tools: ${workflow.tools.join(", ") || "none"}`,
    `Readable paths:`,
    ...workflow.read.map((item) => `- /${String(item).replace(/^\/+/, "")}`),
    `Writable paths:`,
    ...(workflow.write.length ? workflow.write.map((item) => `- /${String(item).replace(/^\/+/, "")}`) : ["- none"]),
    `You must write only to the exact writable paths above. If the target file is not writable, stop and report the mismatch.`,
    `</workflow_contract>`,
  ].join("\n")

  return [
    `Current local time: ${localTimestamp()}.`,
    `Filesystem root mounted as virtual / is data/${vaultName}/projects/${projectId}.`,
    "You are running a Devsync workflow, not a chat session.",
    "Use virtual paths only. Do not use absolute host paths.",
    "Read only workflow-declared inputs and write only workflow-declared outputs.",
    "Preserve existing human-readable Markdown/JSON formats.",
    "Do not invent facts. Record uncertainty explicitly.",
    contract,
    instructionContext,
    `<workflow_instructions>\n${workflow.prompt}\n</workflow_instructions>`,
  ].filter(Boolean).join("\n\n")
}

export async function runWorkflow({ workflow, projectId, input, log }) {
  if (!projectId) {
    throw Object.assign(new Error("Workflow runs require a project scope"), { statusCode: 400 })
  }

  const permissions = filesystemPermissions({
    enabled: hasFilesystemTool(workflow.tools),
    read: workflow.read,
    write: workflow.write,
  })
  const scopeRoot = assistantScopeRoot(projectId)
  const beforeWriteSnapshot = await snapshotWorkflowWritePaths(scopeRoot, workflow.write)

  log?.info({
    workflowId: workflow.id,
    key: workflow.key,
    projectId,
    model: workflow.model,
    tools: workflow.tools,
    read: workflow.read,
    write: workflow.write,
    permissions,
    scopeRoot,
  }, "workflow run starting")

  try {
    log?.info({ workflowId: workflow.id, model: workflow.model }, "workflow resolving model")
    const model = await resolveChatModel(workflow.model)
    const systemPrompt = await buildSystemPrompt(workflow, projectId)
    const tools = resolveAgentTools(workflow.tools, { projectId, read: workflow.read, write: workflow.write })

    log?.info({
      workflowId: workflow.id,
      promptChars: systemPrompt.length,
      customTools: tools.map((tool) => tool.name),
    }, "workflow runtime ready")

    const runnable = createDeepAgent({
      name: workflow.key,
      model,
      systemPrompt,
      tools,
      backend: new FilesystemBackend({
        rootDir: scopeRoot,
        virtualMode: true,
      }),
      permissions,
    })

    log?.info({ workflowId: workflow.id }, "workflow invoking deepagent")
    let result
    try {
      result = await runnable.invoke(
        {
          messages: [
            {
              role: "user",
              content: [
                `Run workflow "${workflow.title}".`,
                input ? `Runtime input:\n${input}` : "",
                "Return a concise summary of what changed.",
              ].filter(Boolean).join("\n\n"),
            },
          ],
        },
        {
          callbacks: log ? [new AiToolLogHandler(log, { workflowId: workflow.id, projectId })] : [],
        }
      )
    } finally {
      await appendWorkflowFileAudit({
        workflow,
        projectId,
        before: beforeWriteSnapshot,
        after: await snapshotWorkflowWritePaths(scopeRoot, workflow.write),
      })
    }

    const answer = contentToText(result.messages?.at(-1)?.content).trim()
      || "Workflow completed."

    log?.info({
      workflowId: workflow.id,
      answerChars: answer.length,
    }, "workflow deepagent completed")

    await addLog(projectId, {
      author: `workflow:${workflow.key}`,
      content: answer,
    })

    log?.info({ workflowId: workflow.id }, "workflow activity log appended")

    return {
      answer,
    }
  } catch (error) {
    log?.error({
      workflowId: workflow.id,
      projectId,
      error: safeError(error),
    }, "workflow run failed")
    throw error
  }
}
