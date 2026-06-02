import { BaseCallbackHandler } from "@langchain/core/callbacks/base"
import { createDeepAgent, FilesystemBackend } from "deepagents"

import { assistantScopeRoot, BASE_ASSISTANT_PROMPT, loadAssistantInstructionContext } from "./assistant-config.js"
import { resolveAgentTools } from "./agent-tools.js"
import { AiToolLogHandler, summarizeToolPayload } from "./ai-logging.js"
import { resolveChatModel } from "./model-resolver.js"
import { filesystemPermissions, hasFilesystemTool } from "./runtime-permissions.js"
import { formatSkillCatalogForPrompt } from "./skills.js"
import { vaultName } from "./storage.js"

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

function promptList(items, fallback = "none") {
  const values = (items ?? [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)

  return values.length ? values.join(", ") : fallback
}

function promptPathList(items) {
  const values = (items ?? [])
    .map((item) => {
      const clean = String(item ?? "").trim().replace(/^\/+/, "")
      return clean === "**" || clean === "**/*" ? "- /**" : `- /${clean}`
    })
    .filter((item) => item !== "- /")

  return values.length ? values.join("\n") : "- none"
}

async function buildSystemPrompt(assistant, scope, skills = []) {
  const virtualRoot = scope.projectId
    ? `data/${vaultName}/projects/${scope.projectId}`
    : `data/${vaultName}`
  const instructionContext = await loadAssistantInstructionContext(scope.projectId)
  const skillCatalog = formatSkillCatalogForPrompt(skills)
  const environment = [
    "<devsync_environment>",
    `Current vault: ${vaultName}`,
    `Current working area id: ${scope.projectId ?? "vault"}`,
    `Mounted root: ${virtualRoot}`,
    `Mounted root is exposed to tools as virtual /`,
    `Current local time: ${localTimestamp()}`,
    `Enabled tools: ${promptList(assistant.tools)}`,
    "Readable paths:",
    promptPathList(assistant.read),
    "Writable paths:",
    promptPathList(assistant.write),
    "</devsync_environment>",
  ].join("\n")

  return [
    BASE_ASSISTANT_PROMPT,
    environment,
    "Use virtual paths only. Do not use absolute host paths.",
    "Use only enabled tools and declared filesystem permissions.",
    "For filesystem output, write only with explicit user intent.",
    instructionContext,
    skillCatalog,
  ].filter(Boolean).join("\n\n")
}

class AgentStreamHandler extends BaseCallbackHandler {
  name = "devsync_agent_stream_handler"
  lc_prefer_streaming = true

  constructor(eventSink, log, context) {
    super()
    this.eventSink = eventSink
    this.toolLogger = log ? new AiToolLogHandler(log, context) : null
  }

  handleLLMNewToken(token) {
    if (token) {
      this.eventSink?.("token", { token })
    }
  }

  handleToolStart(toolInfo, input, runId, _parentRunId, _tags, _metadata, runName) {
    this.eventSink?.("tool_start", {
      runId,
      name: runName ?? toolInfo?.name ?? "tool",
      input: summarizeToolPayload(input),
    })
    this.toolLogger?.handleToolStart(toolInfo, input, runId, _parentRunId, _tags, _metadata, runName)
  }

  handleToolEnd(output, runId) {
    this.eventSink?.("tool_end", {
      runId,
      output: summarizeToolPayload(output),
    })
    this.toolLogger?.handleToolEnd(output, runId)
  }

  handleToolError(error, runId) {
    this.toolLogger?.handleToolError(error, runId)
  }

  handleChainError(error, runId) {
    this.eventSink?.("error", {
      runId,
      message: error instanceof Error ? error.message : "Assistant run failed",
    })
  }
}

export async function runAgent({ agent, projectId, messages, skills = [], eventSink, log }) {
  const scope = { projectId: projectId ?? null }
  const permissions = filesystemPermissions({
    enabled: hasFilesystemTool(agent.tools),
    read: agent.read,
    write: agent.write,
  })
  const scopeRoot = assistantScopeRoot(projectId)

  log?.info({
    agentId: agent.id,
    key: agent.key,
    projectId: projectId ?? null,
    model: agent.model,
    tools: agent.tools,
    read: agent.read,
    write: agent.write,
    skills: skills.map((skill) => skill.name),
    permissions,
    messages: messages.length,
    scopeRoot,
  }, "agent run starting")

  try {
    log?.info({ agentId: agent.id, model: agent.model }, "agent resolving model")
    const model = await resolveChatModel(agent.model)
    const tools = resolveAgentTools(agent.tools, { ...scope, read: agent.read, write: agent.write, skills })
    const systemPrompt = await buildSystemPrompt(agent, scope, skills)

    log?.info({
      agentId: agent.id,
      promptChars: systemPrompt.length,
      customTools: tools.map((tool) => tool.name),
    }, "agent runtime ready")

    const runnable = createDeepAgent({
      name: agent.key,
      model,
      systemPrompt,
      tools,
      backend: new FilesystemBackend({
        rootDir: scopeRoot,
        virtualMode: true,
      }),
      permissions,
    })

    log?.info({ agentId: agent.id }, "agent invoking deepagent")
    const result = await runnable.invoke(
      {
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      },
      {
        callbacks: eventSink || log ? [new AgentStreamHandler(eventSink, log, { agentId: agent.id, projectId: projectId ?? null })] : [],
      }
    )

    const answer = contentToText(result.messages?.at(-1)?.content).trim()
      || "The agent did not produce a text response."

    log?.info({
      agentId: agent.id,
      answerChars: answer.length,
    }, "agent deepagent completed")

    return {
      answer,
    }
  } catch (error) {
    log?.error({
      agentId: agent.id,
      projectId: projectId ?? null,
      error: safeError(error),
    }, "agent run failed")
    throw error
  }
}
