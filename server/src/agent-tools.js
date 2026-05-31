import { createHash, createHmac } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

import { tool } from "langchain"
import { z } from "zod"

import {
  addLog,
  createTask,
  dataDir,
  deleteTask,
  listTasks,
  readTask,
  slugify,
  toggleTask,
  updateTask,
} from "./storage.js"
import { appendMentionEvents } from "./mentions.js"
import { appendSystemLogEvent } from "./system-log.js"

const ACTIVITY_INLINE_MAX_CHARS = Number(process.env.DEVSYNC_ACTIVITY_INLINE_MAX_CHARS ?? 800)

function envFirst(names) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) {
      return value
    }
  }

  return ""
}

function hmac(key, value, encoding) {
  return createHmac("sha256", key).update(value, "utf8").digest(encoding)
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function amzDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "")
}

function canonicalHeaderValue(value) {
  return String(value).trim().replace(/\s+/g, " ")
}

function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  return hmac(kService, "aws4_request")
}

function sesConfig() {
  const region = envFirst(["DEVSYNC_SES_REGION", "AWS_REGION", "AWS_DEFAULT_REGION"])
  const accessKeyId = envFirst(["DEVSYNC_SES_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"])
  const secretAccessKey = envFirst(["DEVSYNC_SES_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY"])
  const sessionToken = envFirst(["DEVSYNC_SES_SESSION_TOKEN", "AWS_SESSION_TOKEN"])
  const fromEmail = envFirst(["DEVSYNC_SES_FROM_EMAIL", "AWS_SES_FROM_EMAIL", "SES_FROM_EMAIL"])
  const configurationSetName = envFirst(["DEVSYNC_SES_CONFIGURATION_SET", "AWS_SES_CONFIGURATION_SET"])

  if (!region || !accessKeyId || !secretAccessKey || !fromEmail) {
    throw new Error("send_email_ses requires DEVSYNC_SES_REGION, DEVSYNC_SES_ACCESS_KEY_ID, DEVSYNC_SES_SECRET_ACCESS_KEY and DEVSYNC_SES_FROM_EMAIL.")
  }

  return { accessKeyId, configurationSetName, fromEmail, region, secretAccessKey, sessionToken }
}

async function sendSesEmail(input) {
  const config = sesConfig()
  const host = `email.${config.region}.amazonaws.com`
  const pathName = "/v2/email/outbound-emails"
  const endpoint = `https://${host}${pathName}`
  const now = amzDate()
  const dateStamp = now.slice(0, 8)
  const payload = JSON.stringify({
    FromEmailAddress: config.fromEmail,
    Destination: {
      ToAddresses: input.to,
      CcAddresses: input.cc ?? [],
      BccAddresses: input.bcc ?? [],
    },
    ReplyToAddresses: input.replyTo ?? [],
    Content: {
      Simple: {
        Subject: { Data: input.subject, Charset: "UTF-8" },
        Body: {
          ...(input.text ? { Text: { Data: input.text, Charset: "UTF-8" } } : {}),
          ...(input.html ? { Html: { Data: input.html, Charset: "UTF-8" } } : {}),
        },
      },
    },
    ...(config.configurationSetName ? { ConfigurationSetName: config.configurationSetName } : {}),
  })
  const payloadHash = sha256(payload)
  const headers = {
    "content-type": "application/json",
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": now,
    ...(config.sessionToken ? { "x-amz-security-token": config.sessionToken } : {}),
  }
  const signedHeaders = Object.keys(headers).sort().join(";")
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((key) => `${key}:${canonicalHeaderValue(headers[key])}\n`)
    .join("")
  const canonicalRequest = [
    "POST",
    pathName,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n")
  const credentialScope = `${dateStamp}/${config.region}/ses/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    now,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n")
  const signature = hmac(signingKey(config.secretAccessKey, dateStamp, config.region, "ses"), stringToSign, "hex")
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: payload,
  })
  const body = await response.text()

  if (!response.ok) {
    throw new Error(`AWS SES send failed: ${response.status} ${body}`)
  }

  const parsed = body ? JSON.parse(body) : {}
  return {
    messageId: parsed.MessageId ?? null,
    status: "sent",
  }
}

function safeGeneratedPath(projectId, wantedPath) {
  const fileName = path.basename(String(wantedPath || "generated.md"))
  const cleanName = slugify(fileName.replace(/\.md$/i, "")) + ".md"
  const root = path.join(dataDir, projectId, "generated")
  const target = path.resolve(root, cleanName)
  const relative = path.relative(root, target)

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Invalid generated file path"), { statusCode: 400 })
  }

  return { root, target, relative: `generated/${cleanName}` }
}

async function uniqueGeneratedPath(projectId, wantedPath) {
  const initial = safeGeneratedPath(projectId, wantedPath)
  const parsed = path.parse(initial.target)
  let target = initial.target
  let relative = initial.relative
  let index = 1

  while (true) {
    try {
      await fs.access(target)
      const fileName = `${parsed.name}-${index}${parsed.ext}`
      target = path.join(parsed.dir, fileName)
      relative = `generated/${fileName}`
      index += 1
    } catch {
      return { root: initial.root, target, relative }
    }
  }
}

function cleanVirtualPath(value) {
  return String(value ?? "").trim().replace(/^\/+/, "").replace(/^\.?\//, "")
}

function canWritePath(scope, targetPath) {
  const target = cleanVirtualPath(targetPath)

  return (scope.write ?? []).some((item) => {
    const pattern = cleanVirtualPath(item)
    if (!pattern) return false
    if (pattern === "**" || pattern === "**/*") return true
    if (pattern.endsWith("/**")) {
      const base = pattern.slice(0, -3)
      return target === base || target.startsWith(`${base}/`)
    }
    if (pattern.endsWith("/*")) {
      const base = pattern.slice(0, -2)
      const rest = target.startsWith(`${base}/`) ? target.slice(base.length + 1) : ""
      return Boolean(rest && !rest.includes("/"))
    }
    return target === pattern || target.startsWith(`${pattern}/`)
  })
}

function assertWritePath(scope, operation, targetPath) {
  if (!scope.projectId) {
    throw new Error(`${operation} requires a project scope.`)
  }

  if (!canWritePath(scope, targetPath)) {
    throw new Error(`${operation} requires write permission for ${targetPath}.`)
  }
}

function createSaveGeneratedMarkdownTool(scope) {
  return tool(
    async ({ fileName, title, content }) => {
      if (!scope.projectId) {
        throw new Error("save_generated_markdown requires a project scope.")
      }

      const { root, target, relative } = await uniqueGeneratedPath(scope.projectId, fileName || title)
      assertWritePath(scope, "save_generated_markdown", relative)
      const markdown = `${String(content).trim()}\n`
      await fs.mkdir(root, { recursive: true })
      await fs.writeFile(target, markdown, "utf8")
      await appendSystemLogEvent({
        action: "generated_markdown.saved",
        source: "agent-tool",
        actor: "agent",
        projectId: scope.projectId,
        target: relative,
        summary: `Saved generated markdown ${path.basename(relative)}`,
      })
      await appendMentionEvents({
        actor: "agent",
        after: markdown,
        before: "",
        projectId: scope.projectId,
        source: "agent-tool",
        target: relative,
        targetType: "generated",
      })

      return {
        path: relative,
        message: "Generated markdown saved.",
      }
    },
    {
      name: "save_generated_markdown",
      description: "Save a generated Markdown file under the current project's generated/ folder.",
      schema: z.object({
        fileName: z.string().min(1).describe("Markdown file name, without directories."),
        title: z.string().optional().describe("Short title for the generated file."),
        content: z.string().min(1).describe("Full Markdown content to save."),
      }),
    }
  )
}

function createAppendActivityLogTool(scope) {
  return tool(
    async ({ content, author }) => {
      const text = String(content ?? "")
      assertWritePath(scope, "append_activity_log", "logs/activity/000001.md")

      if (text.trim().length > ACTIVITY_INLINE_MAX_CHARS) {
        assertWritePath(scope, "append_activity_log", "artifacts/activity-log.md")
      }

      return addLog(scope.projectId, {
        author: author || "agent",
        content,
      })
    },
    {
      name: "append_activity_log",
      description: "Append a short entry to the current project's activity log.",
      schema: z.object({
        content: z.string().min(1).describe("Short activity log entry."),
        author: z.string().optional().describe("Author label. Defaults to agent."),
      }),
    }
  )
}

function canWriteTasks(scope, options = {}) {
  return (scope.write ?? []).some((item) => {
    const clean = cleanVirtualPath(item)
    return ["**", "**/*", "tasks", "tasks/**", "tasks/*"].includes(clean)
      || (!options.files && clean === "tasks/README.md")
  })
}

function assertTaskScope(scope, operation) {
  if (!scope.projectId) {
    throw new Error(`${operation} requires a project scope.`)
  }
}

function assertTaskWrite(scope, operation) {
  assertTaskScope(scope, operation)

  if (!canWriteTasks(scope, { files: true })) {
    throw new Error(`${operation} requires write permission for tasks/**.`)
  }
}

function assertTaskIndexWrite(scope, operation) {
  assertTaskScope(scope, operation)

  if (!canWriteTasks(scope)) {
    throw new Error(`${operation} requires write permission for tasks/README.md or tasks/**.`)
  }
}

function createListTasksTool(scope) {
  return tool(
    async () => {
      assertTaskScope(scope, "list_tasks")
      return listTasks(scope.projectId)
    },
    {
      name: "list_tasks",
      description: "List high-level project tasks.",
      schema: z.object({}),
    }
  )
}

function createReadTaskTool(scope) {
  return tool(
    async ({ path: itemPath }) => {
      assertTaskScope(scope, "read_task")
      return readTask(scope.projectId, itemPath)
    },
    {
      name: "read_task",
      description: "Read a project task from tasks/.",
      schema: z.object({
        path: z.string().min(1).describe("Project-relative task path."),
      }),
    }
  )
}

function createCreateTaskTool(scope) {
  return tool(
    async ({ title, owner, deadline, body, createdBy }) => {
      assertTaskWrite(scope, "create_task")
      return createTask(scope.projectId, { title, owner, deadline, body, createdBy: createdBy || "agent" })
    },
    {
      name: "create_task",
      description: "Create a high-level project task in tasks/.",
      schema: z.object({
        title: z.string().min(1).describe("Task title."),
        owner: z.string().optional().describe("Optional owner label."),
        deadline: z.string().optional().describe("Optional deadline as YYYY-MM-DD."),
        body: z.string().optional().describe("Optional Markdown body."),
        createdBy: z.string().optional().describe("Creator label. Defaults to agent."),
      }),
    }
  )
}

function createUpdateTaskTool(scope) {
  return tool(
    async ({ path: itemPath, title, owner, deadline, body, content }) => {
      assertTaskWrite(scope, "update_task")
      return updateTask(scope.projectId, itemPath, { title, owner, deadline, body, content })
    },
    {
      name: "update_task",
      description: "Update a project task in tasks/.",
      schema: z.object({
        path: z.string().min(1).describe("Project-relative task path."),
        title: z.string().optional().describe("New title."),
        owner: z.string().optional().describe("New owner label."),
        deadline: z.string().optional().describe("New deadline as YYYY-MM-DD."),
        body: z.string().optional().describe("New Markdown body."),
        content: z.string().optional().describe("Full Markdown content."),
      }),
    }
  )
}

function createToggleTaskTool(scope) {
  return tool(
    async ({ path: itemPath, done }) => {
      assertTaskIndexWrite(scope, "toggle_task")
      return toggleTask(scope.projectId, itemPath, done)
    },
    {
      name: "toggle_task",
      description: "Toggle or set a task checkbox in tasks/README.md only.",
      schema: z.object({
        path: z.string().min(1).describe("Project-relative task path."),
        done: z.boolean().optional().describe("Optional explicit checkbox value."),
      }),
    }
  )
}

function createDeleteTaskTool(scope) {
  return tool(
    async ({ path: itemPath }) => {
      assertTaskWrite(scope, "delete_task")
      return deleteTask(scope.projectId, itemPath)
    },
    {
      name: "delete_task",
      description: "Delete a project task from tasks/.",
      schema: z.object({
        path: z.string().min(1).describe("Project-relative task path."),
      }),
    }
  )
}

function createSendSesEmailTool() {
  return tool(
    async ({ to, cc, bcc, replyTo, subject, text, html }) => {
      if (!text && !html) {
        throw new Error("send_email_ses requires text or html body.")
      }

      return sendSesEmail({ to, cc, bcc, replyTo, subject, text, html })
    },
    {
      name: "send_email_ses",
      description: "Send an email through AWS SES using Devsync server environment credentials.",
      schema: z.object({
        to: z.array(z.string().email()).min(1).describe("Recipient email addresses."),
        cc: z.array(z.string().email()).optional().describe("CC recipient email addresses."),
        bcc: z.array(z.string().email()).optional().describe("BCC recipient email addresses."),
        replyTo: z.array(z.string().email()).optional().describe("Reply-To email addresses."),
        subject: z.string().min(1).describe("Email subject."),
        text: z.string().optional().describe("Plain text email body."),
        html: z.string().optional().describe("HTML email body."),
      }),
    }
  )
}

export function resolveAgentTools(toolNames, scope) {
  const registry = {
    save_generated_markdown: () => createSaveGeneratedMarkdownTool(scope),
    append_activity_log: () => createAppendActivityLogTool(scope),
    send_email_ses: () => createSendSesEmailTool(),
    list_tasks: () => createListTasksTool(scope),
    read_task: () => createReadTaskTool(scope),
    create_task: () => createCreateTaskTool(scope),
    update_task: () => createUpdateTaskTool(scope),
    toggle_task: () => createToggleTaskTool(scope),
    delete_task: () => createDeleteTaskTool(scope),
  }

  return toolNames.filter((name) => name !== "filesystem").map((name) => {
    const factory = registry[name]
    if (!factory) {
      throw new Error(`Unknown agent tool: ${name}`)
    }
    return factory()
  })
}
