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
    throw Object.assign(new Error("Invalid automation write path"), { statusCode: 400 })
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
    throw Object.assign(new Error("Automation write path escapes project scope"), { statusCode: 400 })
  }

  return { fullPath, mode }
}

export async function snapshotAutomationWritePaths(scopeRoot, writePaths = []) {
  const entries = new Map()

  for (const item of writePaths) {
    const { fullPath, mode } = resolveWritePatternRoot(scopeRoot, item)
    await collectSnapshots(scopeRoot, fullPath, entries, mode === "recursive")
  }

  return entries
}

export function diffAutomationWriteSnapshots(before, after) {
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

async function appendAutomationFileAudit({ automation, projectId, before, after }) {
  const diff = diffAutomationWriteSnapshots(before, after)

  await appendSystemLogEvent({
    action: "automation.files_changed",
    source: "automation-runtime",
    actor: `automation:${automation.key}`,
    projectId,
    summary: `Automation ${automation.key} changed ${diff.changed.length} file${diff.changed.length === 1 ? "" : "s"}`,
    metadata: {
      automationId: automation.id,
      automationKey: automation.key,
      added: diff.added,
      modified: diff.modified,
      deleted: diff.deleted,
      changed: diff.changed,
    },
  })

  return diff
}

async function buildSystemPrompt(automation, projectId) {
  const instructionContext = await loadAssistantInstructionContext(projectId)
  const contract = [
    `<automation_contract>`,
    `Allowed tools: ${automation.tools.join(", ") || "none"}`,
    `Readable paths:`,
    ...automation.read.map((item) => `- /${String(item).replace(/^\/+/, "")}`),
    `Writable paths:`,
    ...(automation.write.length ? automation.write.map((item) => `- /${String(item).replace(/^\/+/, "")}`) : ["- none"]),
    `You must write only to the exact writable paths above. If the target file is not writable, stop and report the mismatch.`,
    `</automation_contract>`,
  ].join("\n")

  return [
    `Current local time: ${localTimestamp()}.`,
    `Filesystem root mounted as virtual / is data/${vaultName}/projects/${projectId}.`,
    "You are running a Devsync automation, not a chat session.",
    "Use virtual paths only. Do not use absolute host paths.",
    "Read only automation-declared inputs and write only automation-declared outputs.",
    "Preserve existing human-readable Markdown/JSON formats.",
    "Do not invent facts. Record uncertainty explicitly.",
    contract,
    instructionContext,
    `<automation_instructions>\n${automation.prompt}\n</automation_instructions>`,
  ].filter(Boolean).join("\n\n")
}

export async function runAutomation({ automation, projectId, input, log }) {
  if (!projectId) {
    throw Object.assign(new Error("Automation runs require a project scope"), { statusCode: 400 })
  }

  const permissions = filesystemPermissions({
    enabled: hasFilesystemTool(automation.tools),
    read: automation.read,
    write: automation.write,
  })
  const scopeRoot = assistantScopeRoot(projectId)
  const beforeWriteSnapshot = await snapshotAutomationWritePaths(scopeRoot, automation.write)

  log?.info({
    automationId: automation.id,
    key: automation.key,
    projectId,
    model: automation.model,
    tools: automation.tools,
    read: automation.read,
    write: automation.write,
    permissions,
    scopeRoot,
  }, "automation run starting")

  try {
    log?.info({ automationId: automation.id, model: automation.model }, "automation resolving model")
    const model = await resolveChatModel(automation.model)
    const systemPrompt = await buildSystemPrompt(automation, projectId)
    const tools = resolveAgentTools(automation.tools, { projectId, read: automation.read, write: automation.write })

    log?.info({
      automationId: automation.id,
      promptChars: systemPrompt.length,
      customTools: tools.map((tool) => tool.name),
    }, "automation runtime ready")

    const runnable = createDeepAgent({
      name: automation.key,
      model,
      systemPrompt,
      tools,
      backend: new FilesystemBackend({
        rootDir: scopeRoot,
        virtualMode: true,
      }),
      permissions,
    })

    log?.info({ automationId: automation.id }, "automation invoking deepagent")
    let result
    try {
      result = await runnable.invoke(
        {
          messages: [
            {
              role: "user",
              content: [
                `Run automation "${automation.title}".`,
                input ? `Runtime input:\n${input}` : "",
                "Return a concise summary of what changed.",
              ].filter(Boolean).join("\n\n"),
            },
          ],
        },
        {
          callbacks: log ? [new AiToolLogHandler(log, { automationId: automation.id, projectId })] : [],
        }
      )
    } finally {
      await appendAutomationFileAudit({
        automation,
        projectId,
        before: beforeWriteSnapshot,
        after: await snapshotAutomationWritePaths(scopeRoot, automation.write),
      })
    }

    const answer = contentToText(result.messages?.at(-1)?.content).trim()
      || "Automation completed."

    log?.info({
      automationId: automation.id,
      answerChars: answer.length,
    }, "automation deepagent completed")

    await addLog(projectId, {
      author: `automation:${automation.key}`,
      content: answer,
    })

    log?.info({ automationId: automation.id }, "automation activity log appended")

    return {
      answer,
    }
  } catch (error) {
    log?.error({
      automationId: automation.id,
      projectId,
      error: safeError(error),
    }, "automation run failed")
    throw error
  }
}
