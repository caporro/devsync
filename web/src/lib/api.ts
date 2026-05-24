import type {
  ActivityEntry,
  ActivityLogPage,
  AddLinkArtifactRequest,
  AddLogRequest,
  AddTextArtifactRequest,
  CreateProjectRequest,
  CreatePlanItemRequest,
  DocsDetails,
  DocsSummary,
  FileIndexItem,
  GitActionResult,
  MyPlanItemGroup,
  PlanningGanttData,
  PlanIndexItem,
  ProjectDetails,
  ProjectSummary,
  SystemLogPage,
} from "@/domain/devsync"

export type AuthUser = {
  username: string
  email: string
  name: string
  authMode: string
}

export type AuthStatus =
  | {
      authenticated: true
      authMode: string
      user: AuthUser
    }
  | {
      authenticated: false
      authMode: string
    }

export type McpToken = {
  id: string
  name: string
  userEmail: string
  userName: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
}

export type AgentDefinition = {
  id: string
  key: string
  title: string
  description: string
  model: string
  scope: "global" | "project" | "both"
  tools: string[]
  read: string[]
  write: string[]
  source: "global" | "project"
  projectId: string | null
}

export type AssistantConfig = {
  id: string
  key: string
  title: string
  description: string
  model: string
  tools: string[]
  read: string[]
  write: string[]
  projectId: string | null
  overrides: {
    vault: boolean
    project: boolean
  }
  sources: {
    vault: {
      scope: "vault"
      legacy: boolean
      kind: string
      path: string
    } | null
    project: {
      scope: "project"
      projectId: string
      legacy: boolean
      kind: string
      path: string
    } | null
  }
}

export type AssistantRole = {
  slug: string
  name: string
  description: string
  content: string
  scope: "vault" | "project"
  projectId: string | null
  overridesVault: boolean
}

export type WorkflowDefinition = {
  id: string
  key: string
  title: string
  description: string
  model: string
  tools: string[]
  trigger: string
  read: string[]
  write: string[]
  source: "global" | "project"
  projectId: string | null
}

export type AgentThread = {
  id: string
  title: string | null
  agentId: string
  projectId: string | null
  createdAt: string
  updatedAt: string
}

export type AgentAttachment = {
  id: string
  name: string
  path: string
  mimeType: string
  size: number
  createdAt: string
}

export type AgentMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  attachments?: AgentAttachment[]
  runId: string | null
  createdAt: string
}

export type AgentRunEvent = {
  event: string
  data: unknown
  createdAt?: string
}

export type AgentRun = {
  id: string
  status: "running" | "completed" | "error"
  userMessageId: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  events: AgentRunEvent[]
  streamUrl: string | null
}

export type AgentThreadHistory = {
  attachments: AgentAttachment[]
  thread: AgentThread
  messages: AgentMessage[]
  runs: AgentRun[]
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (response.ok) {
    if (response.status === 204) {
      return undefined as T
    }

    return response.json() as Promise<T>
  }

  const body = (await response.json().catch(() => null)) as { error?: string } | null
  throw new Error(body?.error ?? `Request failed: ${response.status}`)
}

async function jsonRequest<T>(url: string, init: RequestInit = {}) {
  const headers = {
    ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    ...init.headers,
  }

  return parseResponse<T>(
    await fetch(url, {
      ...init,
      credentials: "same-origin",
      headers,
    })
  )
}

export async function getCurrentUser(): Promise<AuthStatus> {
  const response = await fetch("/api/auth/me", {
    credentials: "same-origin",
  })

  if (response.status === 401) {
    const body = (await response.json().catch(() => null)) as { authMode?: string } | null
    return { authenticated: false, authMode: body?.authMode ?? "password" }
  }

  return parseResponse<AuthStatus>(response)
}

export async function listUsers() {
  return jsonRequest<{ users: AuthUser[] }>("/api/users")
}

export async function listMyPlanItems() {
  return jsonRequest<{ items: MyPlanItemGroup[] }>("/api/my/plan-items")
}

export async function login(email: string, password: string) {
  return jsonRequest<AuthStatus>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  })
}

export async function logout() {
  return jsonRequest<{ ok: true }>("/api/auth/logout", {
    method: "POST",
  })
}

export async function listMcpTokens() {
  return jsonRequest<{ items: McpToken[] }>("/api/mcp-tokens")
}

export async function createMcpToken(name: string) {
  return jsonRequest<{ token: string; item: McpToken }>("/api/mcp-tokens", {
    method: "POST",
    body: JSON.stringify({ name }),
  })
}

export async function deleteMcpToken(tokenId: string) {
  return jsonRequest<{ ok: true }>(`/api/mcp-tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
  })
}

export async function listProjects() {
  return jsonRequest<{ items: ProjectSummary[] }>("/api/projects")
}

export async function listDocs() {
  return jsonRequest<{ items: DocsSummary[] }>("/api/docs")
}

export async function listAgents(projectId?: string | null) {
  const search = new URLSearchParams()
  if (projectId) {
    search.set("projectId", projectId)
  }

  return jsonRequest<{ items: AgentDefinition[] }>(
    `/api/agents${search.size ? `?${search.toString()}` : ""}`
  )
}

export async function getAssistantConfig(projectId?: string | null) {
  const search = new URLSearchParams()
  if (projectId) {
    search.set("projectId", projectId)
  }

  return jsonRequest<AssistantConfig>(
    `/api/assistant${search.size ? `?${search.toString()}` : ""}`
  )
}

export async function listAssistantRoles(projectId?: string | null) {
  const search = new URLSearchParams()
  if (projectId) {
    search.set("projectId", projectId)
  }

  return jsonRequest<{ items: AssistantRole[] }>(
    `/api/assistant/roles${search.size ? `?${search.toString()}` : ""}`
  )
}

export async function readAssistantRole(scope: AssistantRole["scope"], slug: string, projectId?: string | null) {
  const search = new URLSearchParams()
  if (projectId) {
    search.set("projectId", projectId)
  }

  return jsonRequest<AssistantRole>(
    `/api/assistant/roles/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}${search.size ? `?${search.toString()}` : ""}`
  )
}

export async function createAssistantRole(body: {
  scope: AssistantRole["scope"]
  projectId?: string | null
  slug?: string
  name?: string
  description?: string
  content?: string
}) {
  return jsonRequest<AssistantRole>("/api/assistant/roles", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export async function updateAssistantRole(scope: AssistantRole["scope"], slug: string, body: {
  projectId?: string | null
  name?: string
  description?: string
  content?: string
}) {
  return jsonRequest<AssistantRole>(
    `/api/assistant/roles/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    }
  )
}

export async function deleteAssistantRole(scope: AssistantRole["scope"], slug: string, projectId?: string | null) {
  const search = new URLSearchParams()
  if (projectId) {
    search.set("projectId", projectId)
  }

  await jsonRequest<void>(
    `/api/assistant/roles/${encodeURIComponent(scope)}/${encodeURIComponent(slug)}${search.size ? `?${search.toString()}` : ""}`,
    { method: "DELETE" }
  )
}

export async function listWorkflows(projectId?: string | null) {
  const search = new URLSearchParams()
  if (projectId) {
    search.set("projectId", projectId)
  }

  return jsonRequest<{ items: WorkflowDefinition[] }>(
    `/api/workflows${search.size ? `?${search.toString()}` : ""}`
  )
}

export async function runWorkflow(workflowId: string, projectId: string, input?: string) {
  return jsonRequest<{
    workflow: WorkflowDefinition
    result: { answer: string }
  }>(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
    method: "POST",
    body: JSON.stringify({ projectId, input }),
  })
}

export async function listAgentThreads(projectId?: string | null) {
  const search = new URLSearchParams()
  if (projectId) {
    search.set("projectId", projectId)
  }

  return jsonRequest<{ items: AgentThread[] }>(
    `/api/agent-threads${search.size ? `?${search.toString()}` : ""}`
  )
}

export async function createAgentThread(body: {
  title?: string | null
  agentId?: string
  projectId?: string | null
}) {
  return jsonRequest<AgentThread>("/api/agent-threads", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export async function getAgentThread(threadId: string) {
  return jsonRequest<AgentThreadHistory>(`/api/agent-threads/${threadId}`)
}

export async function uploadAgentAttachment(threadId: string, file: File) {
  const formData = new FormData()
  formData.set("file", file)

  return parseResponse<AgentAttachment>(
    await fetch(`/api/agent-threads/${encodeURIComponent(threadId)}/attachments`, {
      method: "POST",
      credentials: "same-origin",
      body: formData,
    })
  )
}

export function agentAttachmentUrl(threadId: string, attachmentId: string) {
  return `/api/agent-threads/${encodeURIComponent(threadId)}/attachments/${encodeURIComponent(attachmentId)}`
}

export async function sendAgentMessage(
  threadId: string,
  content: string,
  selectedRole?: string | null,
  attachmentIds: string[] = [],
  title?: string | null
) {
  return jsonRequest<{
    run: { id: string; status: string }
    userMessage: AgentMessage
    streamUrl: string
  }>(`/api/agent-threads/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify({ attachmentIds, content, selectedRole: selectedRole || null, title: title || null }),
  })
}

export async function getDocsFolder(docId: string) {
  return jsonRequest<DocsDetails>(`/api/docs/${docId}`)
}

export async function getAppReadme() {
  const response = await fetch("/api/readme", {
    credentials: "same-origin",
  })

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`)
  }

  return response.text()
}

export async function getSystemLog(limit = 200) {
  return jsonRequest<SystemLogPage>(`/api/system-log?limit=${encodeURIComponent(String(limit))}`)
}

export async function getPlanningGantt() {
  return jsonRequest<PlanningGanttData>("/api/planning")
}

export async function updatePlanningGantt(body: Pick<PlanningGanttData, "tasks" | "links">) {
  return jsonRequest<PlanningGanttData>("/api/planning", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

export async function gitPull() {
  return jsonRequest<GitActionResult>("/api/git/pull", {
    method: "POST",
  })
}

export async function gitPush() {
  return jsonRequest<GitActionResult>("/api/git/push", {
    method: "POST",
  })
}

export async function createProject(body: CreateProjectRequest) {
  return jsonRequest<ProjectDetails>("/api/projects", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export async function getProject(projectId: string, options: { activityFiles?: number } = {}) {
  const search = new URLSearchParams()

  if (options.activityFiles) {
    search.set("activityFiles", String(options.activityFiles))
  }

  return jsonRequest<ProjectDetails>(
    `/api/projects/${projectId}${search.size ? `?${search.toString()}` : ""}`
  )
}

export async function getProjectActivity(projectId: string, options: { files?: number; before?: string | null } = {}) {
  const search = new URLSearchParams()

  if (options.files) {
    search.set("files", String(options.files))
  }

  if (options.before) {
    search.set("before", options.before)
  }

  return jsonRequest<ActivityLogPage>(
    `/api/projects/${projectId}/activity${search.size ? `?${search.toString()}` : ""}`
  )
}

export async function updateProject(projectId: string, body: Partial<CreateProjectRequest>) {
  return jsonRequest<ProjectDetails>(`/api/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

export async function addLog(projectId: string, body: AddLogRequest) {
  return jsonRequest<ActivityEntry>(`/api/projects/${projectId}/logs`, {
    method: "POST",
    body: JSON.stringify(body),
  })
}

export async function addTextArtifact(projectId: string, body: AddTextArtifactRequest) {
  return jsonRequest<{ name: string; path: string }>(
    `/api/projects/${projectId}/artifacts/text`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  )
}

export async function addLinkArtifact(projectId: string, body: AddLinkArtifactRequest) {
  return jsonRequest<{ name: string; path: string }>(
    `/api/projects/${projectId}/artifacts/link`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  )
}

export async function addExcalidrawArtifact(projectId: string, body: { title?: string; content?: string; author?: string }) {
  return jsonRequest<{ name: string; path: string }>(
    `/api/projects/${projectId}/artifacts/excalidraw`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  )
}

export async function uploadArtifact(projectId: string, file: File, author?: string) {
  const formData = new FormData()
  if (author) {
    formData.set("author", author)
  }
  formData.set("file", file)

  return parseResponse<{ name: string; path: string }>(
    await fetch(`/api/projects/${projectId}/artifacts/upload`, {
      method: "POST",
      credentials: "same-origin",
      body: formData,
    })
  )
}

export async function createPlanItem(projectId: string, body: CreatePlanItemRequest) {
  return jsonRequest<{ name: string; path: string }>(
    `/api/projects/${projectId}/plan/items`,
    {
      method: "POST",
      body: JSON.stringify(body),
    }
  )
}

export async function updatePlanIndex(projectId: string, items: PlanIndexItem[]) {
  return jsonRequest<{ path: string; size: number; content: string }>(
    `/api/projects/${projectId}/plan/readme`,
    {
      method: "PATCH",
      body: JSON.stringify({ items }),
    }
  )
}

export async function updateArtifactIndex(projectId: string, items: FileIndexItem[]) {
  return jsonRequest<{ path: string; size: number; content: string }>(
    `/api/projects/${projectId}/artifacts/readme`,
    {
      method: "PATCH",
      body: JSON.stringify({ items }),
    }
  )
}

export async function updateArtifactContent(projectId: string, path: string, content: string, author?: string) {
  return jsonRequest<{ path: string; size: number; content: string }>(
    `/api/projects/${projectId}/artifacts?path=${encodeURIComponent(path)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ content, author }),
    }
  )
}

export async function updateExcalidrawArtifact(
  projectId: string,
  path: string,
  content: string,
  author?: string,
  title?: string
) {
  return jsonRequest<{ path: string; size: number; content: string }>(
    `/api/projects/${projectId}/artifacts/excalidraw?path=${encodeURIComponent(path)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ content, author, title }),
    }
  )
}

export async function updateGeneratedContent(projectId: string, path: string, content: string, author?: string) {
  return jsonRequest<{ path: string; size: number; content: string }>(
    `/api/projects/${projectId}/generated/content?path=${encodeURIComponent(path)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ content, author }),
    }
  )
}

export async function updatePlanItemContent(projectId: string, path: string, content: string, author?: string) {
  return jsonRequest<{ path: string; size: number; content: string }>(
    `/api/projects/${projectId}/plan/items/content?path=${encodeURIComponent(path)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ content, author }),
    }
  )
}

export async function deleteArtifact(projectId: string, path: string) {
  return jsonRequest<{ path: string; deleted: boolean }>(
    `/api/projects/${projectId}/artifacts?path=${encodeURIComponent(path)}`,
    {
      method: "DELETE",
    }
  )
}

export async function togglePlanItem(projectId: string, path: string, done?: boolean) {
  return jsonRequest<{ path: string; itemPath: string; done: boolean; content: string }>(
    `/api/projects/${projectId}/plan/items/toggle?path=${encodeURIComponent(path)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ done }),
    }
  )
}

export async function deletePlanItem(projectId: string, path: string) {
  return jsonRequest<{ path: string; deleted: boolean }>(
    `/api/projects/${projectId}/plan/items?path=${encodeURIComponent(path)}`,
    {
      method: "DELETE",
    }
  )
}

export async function readFile(projectId: string, path: string) {
  const response = await fetch(
    `/api/projects/${projectId}/files/raw?path=${encodeURIComponent(path)}`,
    {
      credentials: "same-origin",
    }
  )

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed: ${response.status}`)
  }

  return response.text()
}

export function downloadUrl(projectId: string, path: string) {
  return `/api/projects/${projectId}/files/download?path=${encodeURIComponent(path)}`
}

export async function readDocsFile(docId: string, path: string) {
  const response = await fetch(
    `/api/docs/${docId}/files/raw?path=${encodeURIComponent(path)}`,
    {
      credentials: "same-origin",
    }
  )

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed: ${response.status}`)
  }

  return response.text()
}

export function docsDownloadUrl(docId: string, path: string) {
  return `/api/docs/${docId}/files/download?path=${encodeURIComponent(path)}`
}
