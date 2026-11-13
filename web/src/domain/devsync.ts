export type ProjectCounts = {
  resources: number
  logs: number
  work: number
  tasks?: number
}

export type ProjectSummary = {
  id: string
  name: string
  owner: string
  status: string
  tags: string[]
  createdAt: string
  updatedAt: string
  counts: ProjectCounts
}

export type ProjectFile = {
  id?: string
  name: string
  path: string
  kind: "resources" | "logs" | "work" | "tasks" | "docs"
  folder?: string
  size: number
  title?: string | null
  owner?: string | null
  deadline?: string | null
  done?: boolean
  createdAt?: string | null
  updatedAt: string
}

export const TASK_STATUSES = ["backlog", "todo", "doing", "pause", "done", "rejected"] as const
export type TaskStatus = typeof TASK_STATUSES[number]
export type Task = ProjectFile & {
  status: TaskStatus
  order: number
  revision: string
  done: boolean
  tags: string[]
}
export type TaskComment = { id: string; author: string; createdAt: string; content: string }
export type TaskRecord = Task & { content: string; descriptionContent: string; comments: TaskComment[] }
export type TaskCommentResult = { comment: TaskComment; path: string; revision: string; task: TaskRecord }
export type TaskPatch = { title?: string; status?: TaskStatus; owner?: string; deadline?: string; tags?: string[]; body?: string; content?: string }

export type DocumentRecord = {
  id: string
  projectId: string | null
  docId: string | null
  path: string
  kind: string
  name: string
  title: string
  author: string
  tags: string[]
  url: string
  ref: string
  revision: string
  updatedAt: string
  content: string
}

export type DocumentSearchResult = Omit<DocumentRecord, "content"> & {
  excerpt: string
  score: number
}

export type ProjectFolder = {
  name: string
  path: string
  folder: string
  kind: "resources" | "work"
  updatedAt: string
}

export type DocsSummary = {
  id: string
  name: string
  updatedAt: string
  counts: {
    files: number
  }
}

export type DocsDetails = DocsSummary & {
  readme: string
  files: ProjectFile[]
}

export type ActivityEntry = {
  id: string
  createdAt: string
  author: string
  kind: "inline" | "artifact"
  artifactPath: string | null
  title: string
  content: string
}

export type NewsEntry = ActivityEntry & {
  projectId: string
  projectName: string
}

export type ActivityLogPage = {
  path: string
  files: string[]
  oldestFile: string | null
  newestFile: string | null
  hasOlder: boolean
  entries: ActivityEntry[]
}

export type SystemLogEvent = {
  id: string
  createdAt: string
  action: string
  source: string
  actor: string | null
  authenticatedBy?: string | null
  projectId: string | null
  target: string | null
  summary: string | null
  metadata?: Record<string, unknown>
}

export type SystemLogPage = {
  path: string
  items: SystemLogEvent[]
}

export type SystemLogFilters = { actor?: string; authenticatedBy?: string; action?: string }

export type NewsPage = {
  items: NewsEntry[]
}

export type MentionInboxItem = {
  id: string
  actor: string | null
  content: string | null
  createdAt: string
  label: string
  projectId: string | null
  summary: string | null
  target: string | null
  targetType: string
  unread: boolean
  userId: string
}

export type MentionInboxPage = {
  items: MentionInboxItem[]
  lastReadAt: string | null
  unreadCount: number
  userId: string
}

export type ProjectDetails = ProjectSummary & {
  activity: ActivityLogPage
  files: {
    resources: ProjectFile[]
    logs: ProjectFile[]
    work: ProjectFile[]
    tasks?: Task[]
  }
  folders: {
    resources: ProjectFolder[]
    work: ProjectFolder[]
  }
}

export type ProjectTask = Task & {
  projectId: string
  projectName: string
}

export type MyTask = ProjectTask

export type MyTaskGroup = {
  project: ProjectSummary
  items: MyTask[]
}

export type CreateProjectRequest = {
  name: string
  owner?: string
  status?: string
  tags?: string[]
}

export type AddTextArtifactRequest = {
  title: string
  content: string
  author?: string
  folder?: string
}

export type AddLinkArtifactRequest = {
  title?: string
  url: string
  notes?: string
  author?: string
  folder?: string
}

export type AddLogRequest = {
  content: string
  author?: string
}

export type CreateTaskRequest = {
  title: string
  status?: TaskStatus
  owner?: string
  deadline?: string
  tags?: string[]
  body?: string
  content?: string
  author?: string
  createdBy?: string
}

export type GitStepResult = {
  command: string
  ok: boolean
  code: number
  stdout: string
  stderr: string
}

export type GitActionResult = {
  action: "pull" | "push"
  ok: boolean
  summary: string
  steps: GitStepResult[]
}
