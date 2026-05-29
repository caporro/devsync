export type ProjectCounts = {
  artifacts: number
  logs: number
  generated: number
  planItems?: number
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
  name: string
  path: string
  kind: "artifacts" | "logs" | "generated" | "plan" | "docs"
  size: number
  title?: string | null
  owner?: string | null
  deadline?: string | null
  done?: boolean
  createdAt?: string | null
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
  projectId: string | null
  target: string | null
  summary: string | null
  metadata?: Record<string, unknown>
}

export type SystemLogPage = {
  path: string
  items: SystemLogEvent[]
}

export type NewsPage = {
  items: NewsEntry[]
}

export type PlanningGanttTask = {
  id?: string | number
  start?: string
  end?: string
  duration?: number
  text?: string
  status?: string
  external_id?: string
  link?: string
  details?: string
  progress?: number
  type?: string
  parent?: string | number
  open?: boolean
  projectId?: string | null
  planItemPath?: string | null
  [key: string]: unknown
}

export type PlanningGanttLink = {
  id?: string | number
  source: string | number
  target: string | number
  type: "s2s" | "s2e" | "e2s" | "e2e"
  lag?: number
}

export type PlanningGanttData = {
  tasks: PlanningGanttTask[]
  links: PlanningGanttLink[]
  updatedAt: string
}

export type ProjectDetails = ProjectSummary & {
  activity: ActivityLogPage
  files: {
    artifacts: ProjectFile[]
    logs: ProjectFile[]
    generated: ProjectFile[]
    plan?: ProjectFile[]
  }
}

export type MyPlanItem = ProjectFile & {
  projectId: string
  projectName: string
}

export type MyPlanItemGroup = {
  project: ProjectSummary
  items: MyPlanItem[]
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
}

export type AddLinkArtifactRequest = {
  title?: string
  url: string
  notes?: string
  author?: string
}

export type AddLogRequest = {
  content: string
  author?: string
}

export type CreatePlanItemRequest = {
  title: string
  owner?: string
  deadline?: string
  body?: string
  content?: string
  author?: string
  createdBy?: string
}

export type PlanIndexItem = {
  path: string
  done: boolean
  title?: string
  owner?: string
  deadline?: string
}

export type FileIndexItem = {
  path: string
  done?: boolean
  title?: string
  owner?: string
  deadline?: string
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
