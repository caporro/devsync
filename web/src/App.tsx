import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ChangeEvent, DragEvent, FormEvent, KeyboardEvent, ReactNode, RefObject } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AddCircleIcon,
  ArrowDown03Icon,
  ArrowUp03Icon,
  Copy01Icon,
  DarkModeIcon,
  Delete02Icon,
  DragDropVerticalIcon,
  DrawingModeIcon,
  Edit02Icon,
  FileCodeIcon,
  FileImageIcon,
  FileLinkIcon,
  FileUnknownIcon,
  FloppyDiskIcon,
  FullScreenIcon,
  GitBranchIcon,
  Key01Icon,
  MinimizeScreenIcon,
  Mic01Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  Pdf01Icon,
  Settings05Icon,
  SourceCodeIcon,
  TextBoldIcon,
  Txt01Icon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons"

import { AppSidebar } from "@/components/app-sidebar"
import { ChatThought } from "@/components/chat-thought"
import type { ThoughtRun, ThoughtStep } from "@/components/chat-thought"
import { CommandMenuList } from "@/components/file-command-menu"
import {
  fileCommandIcon,
  fileMarkdown,
  groupCommandMenuItems,
} from "@/components/file-command-menu-utils"
import type { CommandMenuItem } from "@/components/file-command-menu-utils"
import type { MarkdownArtifactEditorActions, MarkdownArtifactEditorStatus } from "@/components/markdown-artifact-editor"
import {
  PLANNING_COLUMN_OPTIONS,
  PLANNING_DEFAULT_COLUMN_IDS,
} from "@/components/planning-types"
import type { PlanningActions, PlanningStatus } from "@/components/planning-types"
import type { ExcalidrawArtifactActions, ExcalidrawArtifactStatus } from "@/components/excalidraw-artifact-editor"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  SidebarInset,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu"
import {
  addLog,
  addExcalidrawArtifact,
  addTextArtifact,
  agentAttachmentUrl,
  createPlanItem,
  createAgentThread,
  createMcpToken,
  createProject,
  deleteMcpToken,
  deleteArtifact,
  deletePlanItem,
  docsDownloadUrl,
  downloadUrl,
  getAssistantConfig,
  gitPull,
  gitPush,
  getAgentThread,
  getCurrentUser,
  getAppReadme,
  getDocsFolder,
  getPlanningGantt,
  getProject,
  getProjectActivity,
  getSystemLog,
  listAssistantRoles,
  listAgentThreads,
  listDocs,
  listMcpTokens,
  listMyPlanItems,
  listProjects,
  listUsers,
  listWorkflows,
  login,
  logout,
  readDocsFile,
  readFile,
  updateArtifactIndex,
  updateArtifactContent,
  updateExcalidrawArtifact,
  updateGeneratedContent,
  updatePlanningGantt,
  updatePlanIndex,
  updatePlanItemContent,
  updateProject,
  uploadArtifact,
  runWorkflow,
  sendAgentMessage,
  togglePlanItem,
  uploadAgentAttachment,
} from "@/lib/api"
import { cn } from "@/lib/utils"
import type { ActivityEntry, DocsSummary, FileIndexItem, GitActionResult, MyPlanItem, MyPlanItemGroup, PlanningGanttData, ProjectDetails, ProjectFile, ProjectSummary, SystemLogEvent } from "@/domain/devsync"
import type { AgentAttachment, AgentMessage, AgentRun, AgentRunEvent, AgentThread, AgentThreadHistory, AssistantRole, AuthStatus, AuthUser, McpToken, WorkflowDefinition } from "@/lib/api"

const EMPTY_PROJECTS: ProjectSummary[] = []
const EMPTY_DOCS: DocsSummary[] = []
const EMPTY_FILES: ProjectFile[] = []
const ARTIFACT_INDEX_PATH = "artifacts/readme.md"
const PLAN_INDEX_PATH = "plan/README.md"
const CHAT_MAX_WIDTH = "max-w-[760px]"
const CHAT_THREAD_MENU_VALUE = "threads"
const THREAD_TITLE_MAX_LENGTH = 36
const DEFAULT_PROJECT_STATUSES = ["unplanned", "planned", "active", "closed", "archived"]
const PROJECT_STATUS_OPTIONS = projectStatusOptionsFromEnv(import.meta.env.VITE_DEVSYNC_PROJECT_STATUSES)
const ExcalidrawArtifactEditor = lazy(() =>
  import("@/components/excalidraw-artifact-editor").then((module) => ({
    default: module.ExcalidrawArtifactEditor,
  }))
)
const MarkdownArtifactEditor = lazy(() =>
  import("@/components/markdown-artifact-editor").then((module) => ({
    default: module.MarkdownArtifactEditor,
  }))
)
const MarkdownViewer = lazy(() =>
  import("@/components/markdown-viewer").then((module) => ({
    default: module.MarkdownViewer,
  }))
)
const PlanningView = lazy(() =>
  import("@/components/planning-view").then((module) => ({
    default: module.PlanningView,
  }))
)

type MainView = "activity" | "system-log" | "chat" | "agents" | "artifacts" | "artifact" | "generated-file" | "config" | "readme" | "placeholder" | "plan" | "plan-item" | "my-items" | "docs" | "git" | "planning"
type AppRoute = {
  mainView: MainView
  projectId: string | null
  docId: string | null
  artifactPath: string | null
  generatedPath: string | null
  planItemPath: string | null
  docFilePath: string | null
  placeholderTitle: string
  agentId: string
  agentThreadId: string | null
}

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpg", ".jpeg", ".png", ".webp"])
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".csv", ".log"])
const EXCALIDRAW_EXTENSION = ".excalidraw"
const ALERT_DISMISS_MS = 3500

function markdownProjectFilePath(url: string) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/api\/)/i.test(url)) {
    return null
  }

  let normalized = url.split(/[?#]/, 1)[0].replace(/\\/g, "/")

  try {
    normalized = decodeURIComponent(normalized)
  } catch {
    // Keep the original path if it is not URI encoded.
  }

  normalized = normalized
    .replace(/^\/+/, "")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^(?:\.\.\/)+/, "")

  return /^(?:artifacts|generated|plan)\//.test(normalized) ? normalized : null
}

function decodeMarkdownLabel(value: string) {
  return value.replace(/\\([\\[\]])/g, "$1")
}

function markdownLinkUrl(value: string) {
  const url = value.trim().split(/\s+/, 1)[0] ?? ""
  return url.replace(/^<(.+)>$/, "$1")
}

function hasUnsafeHrefCharacter(value: string) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 31 || code === 127 || /\s/.test(char)
  })
}

function safeExternalMarkdownHref(value: string) {
  const href = value.trim()
  if (!href || hasUnsafeHrefCharacter(href)) {
    return null
  }

  try {
    const url = new URL(href)
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) ? href : null
  } catch {
    return null
  }
}

function opensInNewTab(href: string) {
  return /^https?:\/\//i.test(href)
}

function fileNameFromPath(value: string) {
  const path = markdownProjectFilePath(value) ?? value.split(/[?#]/, 1)[0].replace(/\\/g, "/")

  try {
    return decodeURIComponent(path).split("/").filter(Boolean).pop() || path
  } catch {
    return path.split("/").filter(Boolean).pop() || path
  }
}

function markdownLinkDisplayName(label: string, url: string) {
  const normalizedLabel = decodeMarkdownLabel(label).trim()
  const display = normalizedLabel || fileNameFromPath(markdownLinkUrl(url))

  return display.includes("/") ? display.split("/").filter(Boolean).pop() || display : display
}

function readableTextFromMarkdown(value: string) {
  return value
    .replace(/!?\[([^\]\n]*)\]\(([^)\n]*)(?:\)|$)/g, (_, label: string, url: string) =>
      markdownLinkDisplayName(label, url)
    )
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/[#>*_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function projectMarkdownAssetUrl(projectId: string, url: string) {
  const path = markdownProjectFilePath(url)
  return path ? downloadUrl(projectId, path) : url
}

function emptyRoute(mainView: MainView = "activity"): AppRoute {
  return {
    mainView,
    projectId: null,
    docId: null,
    artifactPath: null,
    generatedPath: null,
    planItemPath: null,
    docFilePath: null,
    placeholderTitle: "",
    agentId: "",
    agentThreadId: null,
  }
}

function encodePathPart(value: string) {
  return encodeURIComponent(value)
}

function decodePathPart(value: string | undefined) {
  if (!value) {
    return ""
  }

  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function scopedRouteFilePath(dirName: string, parts: string[]) {
  const filePath = parts.map(decodePathPart).filter(Boolean).join("/")

  if (!filePath) {
    return null
  }

  return filePath.startsWith(`${dirName}/`) ? filePath : `${dirName}/${filePath}`
}

function routeFilePathParts(filePath: string, dirName?: string) {
  const relativePath = dirName && filePath.startsWith(`${dirName}/`)
    ? filePath.slice(dirName.length + 1)
    : filePath

  return relativePath.split("/").filter(Boolean).map(encodePathPart).join("/")
}

function parseAppRoute(pathname = window.location.pathname, search = window.location.search): AppRoute {
  const parts = pathname.split("/").filter(Boolean)
  const query = new URLSearchParams(search)

  if (parts[0] === "projects" && parts[1]) {
    const projectId = decodePathPart(parts[1])
    const section = parts[2] ?? "activity"

    if (section === "artifacts") {
      const artifactPath = scopedRouteFilePath("artifacts", parts.slice(3))
      return { ...emptyRoute(artifactPath ? "artifact" : "artifacts"), projectId, artifactPath }
    }

    if (section === "plan") {
      const planItemPath = scopedRouteFilePath("plan", parts.slice(3))
      return { ...emptyRoute(planItemPath ? "plan-item" : "plan"), projectId, planItemPath }
    }

    if (section === "agents" || section === "assistant") {
      return {
        ...emptyRoute("agents"),
        projectId,
        agentId: decodePathPart(parts[3]),
        agentThreadId: query.get("thread"),
      }
    }

    if (section === "chat") {
      return { ...emptyRoute("chat"), projectId }
    }

    if (section === "config") {
      return { ...emptyRoute("config"), projectId }
    }

    if (section === "generated") {
      const generatedPath = scopedRouteFilePath("generated", parts.slice(3))
      if (generatedPath) {
        return { ...emptyRoute("generated-file"), projectId, generatedPath }
      }

      return {
        ...emptyRoute("placeholder"),
        projectId,
        placeholderTitle: "generated",
      }
    }

    return { ...emptyRoute("activity"), projectId }
  }

  if (parts[0] === "docs") {
    return {
      ...emptyRoute("docs"),
      docId: decodePathPart(parts[1]) || null,
      docFilePath: parts[2] === "file" ? parts.slice(3).map(decodePathPart).filter(Boolean).join("/") || null : null,
    }
  }

  if (parts[0] === "my-items") {
    return emptyRoute("my-items")
  }

  if (parts[0] === "planning") {
    return emptyRoute("planning")
  }

  if (parts[0] === "system-log") {
    return emptyRoute("system-log")
  }

  if (parts[0] === "agents" || parts[0] === "assistant") {
    return {
      ...emptyRoute("agents"),
      agentId: decodePathPart(parts[1]),
      agentThreadId: query.get("thread"),
    }
  }

  if (parts[0] === "git") {
    return emptyRoute("git")
  }

  if (parts[0] === "readme") {
    return emptyRoute("readme")
  }

  return emptyRoute("activity")
}

function buildAppPath(route: AppRoute) {
  if (route.mainView === "docs") {
    if (!route.docId) {
      return "/docs"
    }

    const base = `/docs/${encodePathPart(route.docId)}`
    return route.docFilePath ? `${base}/file/${routeFilePathParts(route.docFilePath)}` : base
  }

  if (route.mainView === "my-items") {
    return "/my-items"
  }

  if (route.mainView === "planning") {
    return "/planning"
  }

  if (route.mainView === "system-log") {
    return "/system-log"
  }

  if (route.mainView === "git") {
    return "/git"
  }

  if (route.mainView === "readme") {
    return "/readme"
  }

  if (route.mainView === "agents" && !route.projectId) {
    return route.agentThreadId ? `/assistant?thread=${encodePathPart(route.agentThreadId)}` : "/assistant"
  }

  if (!route.projectId) {
    return "/"
  }

  const base = `/projects/${encodePathPart(route.projectId)}`

  if (route.mainView === "artifacts") {
    return `${base}/artifacts`
  }

  if (route.mainView === "artifact") {
    return route.artifactPath
      ? `${base}/artifacts/${routeFilePathParts(route.artifactPath, "artifacts")}`
      : `${base}/artifacts`
  }

  if (route.mainView === "generated-file") {
    return route.generatedPath
      ? `${base}/generated/${routeFilePathParts(route.generatedPath, "generated")}`
      : `${base}/generated`
  }

  if (route.mainView === "plan") {
    return `${base}/plan`
  }

  if (route.mainView === "plan-item") {
    return route.planItemPath ? `${base}/plan/${routeFilePathParts(route.planItemPath, "plan")}` : `${base}/plan`
  }

  if (route.mainView === "agents") {
    return route.agentThreadId
      ? `${base}/assistant?thread=${encodePathPart(route.agentThreadId)}`
      : `${base}/assistant`
  }

  if (route.mainView === "chat") {
    return `${base}/chat`
  }

  if (route.mainView === "config") {
    return `${base}/config`
  }

  if (route.mainView === "placeholder") {
    return route.placeholderTitle && route.placeholderTitle !== "generated"
      ? `${base}/generated/${encodePathPart(route.placeholderTitle)}`
      : `${base}/generated`
  }

  return `${base}/activity`
}

function extensionOf(fileName: string) {
  const index = fileName.lastIndexOf(".")
  return index === -1 ? "" : fileName.slice(index).toLowerCase()
}

function isImageFile(fileName: string) {
  return IMAGE_EXTENSIONS.has(extensionOf(fileName))
}

function isTextFile(fileName: string) {
  return TEXT_EXTENSIONS.has(extensionOf(fileName))
}

function isMarkdownFile(fileName: string) {
  return extensionOf(fileName) === ".md"
}

function isExcalidrawFile(fileName: string) {
  return extensionOf(fileName) === EXCALIDRAW_EXTENSION
}

function projectStatusOptionsFromEnv(value: unknown) {
  const items = typeof value === "string"
    ? value.split(",").map((item) => item.trim()).filter(Boolean)
    : []

  return items.length > 0 ? items : DEFAULT_PROJECT_STATUSES
}

function labelFromValue(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
}

function optionsWithCurrent(options: string[], current: string) {
  return current && !options.includes(current) ? [...options, current] : options
}

function iconForFile(fileName: string) {
  const extension = extensionOf(fileName)

  if (IMAGE_EXTENSIONS.has(extension)) {
    return FileImageIcon
  }

  if (extension === ".md" || extension === ".txt" || extension === ".log") {
    return Txt01Icon
  }

  if (extension === ".pdf") {
    return Pdf01Icon
  }

  if (extension === ".json" || extension === ".yaml" || extension === ".yml") {
    return FileCodeIcon
  }

  if (extension === EXCALIDRAW_EXTENSION) {
    return DrawingModeIcon
  }

  if (extension === ".url") {
    return FileLinkIcon
  }

  return FileUnknownIcon
}

function displayFileTitle(file: ProjectFile) {
  return file.title?.trim() || file.name
}

function formatSystemLogDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function SystemLogView({
  events,
  isLoading,
  path,
}: {
  events: SystemLogEvent[]
  isLoading: boolean
  path?: string
}) {
  return (
    <section className="mx-auto w-full max-w-5xl">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-foreground">System Log</h1>
        <div className="mt-1 text-xs text-muted-foreground">{path ?? "system-log/events.ndjson"}</div>
      </div>
      {isLoading ? (
        <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">Loading...</div>
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/20 p-4 text-sm text-muted-foreground">No system events yet.</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[160px_170px_1fr_180px] gap-3 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>Time</span>
            <span>Action</span>
            <span>Summary</span>
            <span>Target</span>
          </div>
          <div className="divide-y divide-border">
            {events.map((event) => (
              <div className="grid grid-cols-[160px_170px_1fr_180px] gap-3 px-3 py-2 text-xs" key={event.id}>
                <span className="text-muted-foreground">{formatSystemLogDate(event.createdAt)}</span>
                <span className="font-medium text-foreground">{event.action}</span>
                <span className="min-w-0 truncate text-foreground">
                  {event.summary ?? event.source}
                  {event.actor ? <span className="ml-2 text-muted-foreground">by {event.actor}</span> : null}
                  {event.projectId ? <span className="ml-2 text-muted-foreground">in {event.projectId}</span> : null}
                </span>
                <span className="truncate text-muted-foreground">{event.target ?? "-"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

type FileIndexRow = FileIndexItem & {
  title: string
  file: ProjectFile
  done: boolean
  owner?: string
  deadline?: string
}
type DropPlacement = "before" | "after"
type DropTarget = {
  path: string
  placement: DropPlacement
}

function normalizeProjectIndexPath(value: string, dirName: string) {
  const clean = value.trim().replace(/^\.?\//, "").replace(new RegExp(`^${dirName}/`), "")
  let decoded = clean

  try {
    decoded = decodeURIComponent(clean)
  } catch {
    decoded = clean
  }

  const fileName = decoded.split("/").filter(Boolean).pop() ?? ""
  return fileName ? `${dirName}/${fileName}` : ""
}

function parseIndexSuffix(value: string | undefined) {
  const parts = String(value ?? "")
    .split(/\s+(?:—|-)\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
  let owner = ""
  let deadline = ""

  for (const part of parts) {
    const due = part.match(/^(?:due|deadline):?\s*(\d{4}-\d{2}-\d{2})$/i)
    if (due) {
      deadline = due[1]
    } else if (!owner) {
      owner = part
    }
  }

  return { owner, deadline }
}

function parseFileIndex(content: string | undefined, files: ProjectFile[], dirName: string): FileIndexRow[] {
  const fileByPath = new Map(files.map((file) => [file.path, file]))
  const used = new Set<string>()
  const rows: FileIndexRow[] = []
  const matcher = /^-[ \t]+(?:\[([ xX])\][ \t]+)?\[([^\]\r\n]*)\]\(([^)\r\n]+)\)(?:[ \t]+(?:—|-)[ \t]*(.+?))?[ \t]*$/gm
  let match

  while ((match = matcher.exec(content ?? ""))) {
    const filePath = normalizeProjectIndexPath(match[3], dirName)
    const file = fileByPath.get(filePath)

    if (!file || used.has(filePath)) {
      continue
    }

    const suffix = parseIndexSuffix(match[4])
    rows.push({
      path: filePath,
      title: isExcalidrawFile(file.name) ? displayFileTitle(file) : match[2].trim() || displayFileTitle(file),
      done: match[1]?.toLowerCase() === "x",
      owner: suffix.owner || file.owner || "",
      deadline: suffix.deadline || file.deadline || "",
      file,
    })
    used.add(filePath)
  }

  for (const file of files) {
    if (!used.has(file.path)) {
      rows.push({
        path: file.path,
        title: displayFileTitle(file),
        done: false,
        owner: file.owner || "",
        deadline: file.deadline || "",
        file,
      })
    }
  }

  return rows
}

function formatActivityDate(value: string) {
  const date = new Date(value)
  const pad = (item: number) => String(item).padStart(2, "0")

  return [
    `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join("-")
}

function formatSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function deriveAssistantThreadTitle(content: string) {
  const normalized = readableTextFromMarkdown(content)
  if (!normalized) {
    return "New chat"
  }

  if (normalized.length <= THREAD_TITLE_MAX_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, THREAD_TITLE_MAX_LENGTH - 3).trimEnd()}...`
}

function parseStreamPayload<T>(event: MessageEvent) {
  try {
    return JSON.parse(event.data) as T
  } catch {
    return null
  }
}

function stringifyStreamPayload(payload: unknown) {
  if (payload == null) {
    return undefined
  }

  if (typeof payload === "string") {
    return payload
  }

  try {
    return JSON.stringify(payload, null, 2)
  } catch {
    return String(payload)
  }
}

function isImageAttachment(attachment: AgentAttachment) {
  return IMAGE_EXTENSIONS.has(extensionOf(attachment.name))
}

function formatAttachmentSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function createThoughtRun(runId: string, userMessageId: string): ThoughtRun {
  return {
    id: runId,
    userMessageId,
    status: "running",
    isOpen: true,
    openStepId: null,
    steps: [],
  }
}

function applyRunEventToThought(thought: ThoughtRun, event: AgentRunEvent): ThoughtRun {
  const payload = event.data as Record<string, unknown> | null

  if (event.event === "context") {
    return upsertThoughtStep(
      thought,
      {
        id: `context-${event.createdAt ?? thought.steps.length}`,
        type: "context",
        status: "completed",
        name: "Context",
        payload: stringifyStreamPayload(payload),
      },
      { status: thought.status }
    )
  }

  if (event.event === "tool_start") {
    const stepId = typeof payload?.runId === "string" ? payload.runId : `${String(payload?.name ?? "tool")}-${thought.steps.length}`

    return upsertThoughtStep(
      thought,
      {
        id: stepId,
        type: "tool",
        status: "running",
        name: typeof payload?.name === "string" ? payload.name : "tool",
        input: stringifyStreamPayload(payload?.input),
      },
      { isOpen: true, openStepId: stepId, status: "running" }
    )
  }

  if (event.event === "tool_end") {
    const runId = typeof payload?.runId === "string" ? payload.runId : null
    const existingStep = runId ? thought.steps.find((step) => step.id === runId) : null
    const stepId = runId ?? existingStep?.id ?? `tool-${thought.steps.length}`

    return upsertThoughtStep(
      thought,
      {
        id: stepId,
        type: "tool",
        status: "completed",
        name: existingStep?.name ?? "tool",
        input: existingStep?.input,
        output: stringifyStreamPayload(payload?.output),
      },
      { status: "running" }
    )
  }

  if (event.event === "run_completed") {
    return upsertThoughtStep(
      thought,
      {
        id: "run_completed",
        type: "run_completed",
        status: "completed",
        payload: stringifyStreamPayload(payload),
      },
      { isOpen: false, openStepId: null, status: "completed" }
    )
  }

  if (event.event === "error") {
    return { ...thought, isOpen: true, openStepId: null, status: "error" }
  }

  return thought
}

function thoughtRunsFromAgentRuns(runs: AgentRun[]) {
  return runs.map((run) => {
    let thought = createThoughtRun(run.id, run.userMessageId)
    thought.status = run.status
    thought.isOpen = run.status === "running"

    for (const event of run.events) {
      thought = applyRunEventToThought(thought, event)
    }

    return thought
  })
}

function draftFromRun(run: AgentRun | null) {
  if (!run || run.status !== "running") {
    return ""
  }

  const hasFinalMessage = run.events.some((event) => event.event === "message")
  if (hasFinalMessage) {
    return ""
  }

  return run.events
    .filter((event) => event.event === "token")
    .map((event) => {
      const data = event.data as { token?: unknown }
      return typeof data?.token === "string" ? data.token : ""
    })
    .join("")
}

function upsertThoughtStep(
  thought: ThoughtRun,
  step: ThoughtStep,
  options?: {
    isOpen?: boolean
    openStepId?: string | null
    status?: ThoughtRun["status"]
  }
) {
  const nextSteps = thought.steps.some((candidate) => candidate.id === step.id)
    ? thought.steps.map((candidate) => (candidate.id === step.id ? step : candidate))
    : [...thought.steps, step]

  return {
    ...thought,
    steps: nextSteps,
    isOpen: options?.isOpen ?? thought.isOpen,
    openStepId:
      options && "openStepId" in options ? (options.openStepId ?? null) : thought.openStepId,
    status: options?.status ?? thought.status,
  }
}

function updateThreadThoughtRun(
  store: Record<string, ThoughtRun[]>,
  threadId: string,
  runId: string,
  userMessageId: string | null,
  updater: (thought: ThoughtRun) => ThoughtRun
) {
  const currentRuns = store[threadId] ?? []
  let didUpdate = false

  const nextRuns = currentRuns.map((thought) => {
    if (thought.id !== runId) {
      return thought
    }

    didUpdate = true
    return updater(thought)
  })

  if (!didUpdate && userMessageId) {
    nextRuns.push(updater(createThoughtRun(runId, userMessageId)))
  }

  return {
    ...store,
    [threadId]: nextRuns,
  }
}

function resizeAssistantComposer(element: HTMLTextAreaElement) {
  const maxHeight = 160
  element.style.height = "0px"
  element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
  element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden"
}

function fileMentionTokenAt(value: string, cursor: number) {
  const textBefore = value.slice(0, cursor)
  const token = textBefore.match(/(?:^|\s)(@[^\s@]*)$/)?.[1]

  if (!token) {
    return null
  }

  return {
    end: cursor,
    query: token.slice(1),
    start: cursor - token.length,
  }
}

function handleAssistantComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
    return
  }

  event.preventDefault()
  event.currentTarget.form?.requestSubmit()
}

type MarkdownBlock =
  | { content: string; type: "blockquote" | "paragraph" }
  | { content: string; language: string; type: "code" }
  | { content: string; level: number; type: "heading" }
  | { items: string[]; type: "ordered-list" | "unordered-list" }

function isMarkdownBlockStart(line: string) {
  return (
    /^```/.test(line) ||
    /^#{1,4}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*]\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line)
  )
}

function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const blocks: MarkdownBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = line.match(/^```(\S*)/)
    if (fence) {
      index += 1
      const content: string[] = []

      while (index < lines.length && !/^```/.test(lines[index])) {
        content.push(lines[index])
        index += 1
      }

      if (index < lines.length) {
        index += 1
      }

      blocks.push({ content: content.join("\n"), language: fence[1] ?? "", type: "code" })
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/)
    if (heading) {
      blocks.push({ content: heading[2], level: heading[1].length, type: "heading" })
      index += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const content: string[] = []

      while (index < lines.length && /^>\s?/.test(lines[index])) {
        content.push(lines[index].replace(/^>\s?/, ""))
        index += 1
      }

      blocks.push({ content: content.join("\n"), type: "blockquote" })
      continue
    }

    if (/^[-*]\s+/.test(line)) {
      const items: string[] = []

      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^[-*]\s+/, ""))
        index += 1
      }

      blocks.push({ items, type: "unordered-list" })
      continue
    }

    if (/^\d+[.)]\s+/.test(line)) {
      const items: string[] = []

      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\d+[.)]\s+/, ""))
        index += 1
      }

      blocks.push({ items, type: "ordered-list" })
      continue
    }

    const content = [line]
    index += 1

    while (index < lines.length && lines[index].trim() && !isMarkdownBlockStart(lines[index])) {
      content.push(lines[index])
      index += 1
    }

    blocks.push({ content: content.join("\n"), type: "paragraph" })
  }

  return blocks
}

function pushInlineText(nodes: ReactNode[], text: string, keyPrefix: string) {
  if (!text) {
    return
  }

  const parts = text.split("\n")
  parts.forEach((part, index) => {
    if (index > 0) {
      nodes.push(<br key={`${keyPrefix}-br-${index}`} />)
    }
    if (part) {
      nodes.push(part)
    }
  })
}

function parseMarkdownLinkToken(token: string) {
  const match = token.match(/^(!?)\[([^\]\n]*)\]\(([^)\n]+)\)$/)
  if (!match) {
    return null
  }

  return {
    image: Boolean(match[1]),
    label: match[2],
    url: markdownLinkUrl(match[3]),
  }
}

function renderInlineMarkdown(
  text: string,
  options: {
    linkClassName?: string
    onOpenProjectFile?: (path: string) => void
  } = {},
  keyPrefix = "inline"
): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /(`[^`\n]+`)|(!?\[[^\]\n]*\]\([^)]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text))) {
    pushInlineText(nodes, text.slice(lastIndex, match.index), `${keyPrefix}-text-${match.index}`)

    const token = match[0]
    const key = `${keyPrefix}-${match.index}`
    const link = parseMarkdownLinkToken(token)

    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
          {token.slice(1, -1)}
        </code>
      )
    } else if (link) {
      const projectPath = markdownProjectFilePath(link.url)
      const label = markdownLinkDisplayName(link.label, link.url)
      const className = cn("underline underline-offset-2", options.linkClassName)

      if (projectPath && options.onOpenProjectFile) {
        nodes.push(
          <a
            className={className}
            href={link.url}
            key={key}
            onClick={(event) => {
              event.preventDefault()
              options.onOpenProjectFile?.(projectPath)
            }}
          >
            {label}
          </a>
        )
      } else {
        const safeHref = safeExternalMarkdownHref(link.url)
        if (!safeHref) {
          nodes.push(label)
          lastIndex = pattern.lastIndex
          continue
        }

        nodes.push(
          <a
            className={className}
            href={safeHref}
            key={key}
            rel={opensInNewTab(safeHref) ? "noreferrer" : undefined}
            target={opensInNewTab(safeHref) ? "_blank" : undefined}
          >
            {label}
          </a>
        )
      }
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(token.slice(2, -2), options, key)}</strong>)
    } else {
      nodes.push(<em key={key}>{renderInlineMarkdown(token.slice(1, -1), options, key)}</em>)
    }

    lastIndex = pattern.lastIndex
  }

  pushInlineText(nodes, text.slice(lastIndex), `${keyPrefix}-text-end`)

  return nodes
}

function renderComposerDisplayText(value: string) {
  const nodes: ReactNode[] = []
  const pattern = /!?\[([^\]\n]*)\]\(([^)\n]+)\)/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(value))) {
    pushInlineText(nodes, value.slice(lastIndex, match.index), `composer-text-${match.index}`)
    nodes.push(
      <span className="underline underline-offset-2" key={`composer-link-${match.index}`}>
        {markdownLinkDisplayName(match[1], match[2])}
      </span>
    )
    lastIndex = pattern.lastIndex
  }

  pushInlineText(nodes, value.slice(lastIndex), "composer-text-end")
  return nodes
}

function MarkdownMessage({
  className,
  content,
  linkClassName,
  onOpenProjectFile,
}: {
  className?: string
  content: string
  linkClassName?: string
  onOpenProjectFile?: (path: string) => void
}) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content])

  return (
    <div className={cn("space-y-3 break-words", className)}>
      {blocks.map((block, index) => {
        const inlineOptions = { linkClassName, onOpenProjectFile }

        if (block.type === "code") {
          return (
            <pre
              className="overflow-x-auto rounded-md border border-border/70 bg-muted/70 px-3 py-2 text-[12px] leading-5"
              key={index}
            >
              <code>{block.content}</code>
            </pre>
          )
        }

        if (block.type === "heading") {
          const HeadingTag = `h${Math.min(block.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6"
          return (
            <HeadingTag className="font-semibold leading-6 text-current" key={index}>
              {renderInlineMarkdown(block.content, inlineOptions, `heading-${index}`)}
            </HeadingTag>
          )
        }

        if (block.type === "blockquote") {
          return (
            <blockquote className="border-l-2 border-current/30 pl-3 text-current/80" key={index}>
              {renderInlineMarkdown(block.content, inlineOptions, `quote-${index}`)}
            </blockquote>
          )
        }

        if (block.type === "unordered-list" || block.type === "ordered-list") {
          const ListTag = block.type === "ordered-list" ? "ol" : "ul"
          return (
            <ListTag
              className={cn("space-y-1 pl-5", block.type === "ordered-list" ? "list-decimal" : "list-disc")}
              key={index}
            >
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>
                  {renderInlineMarkdown(item, inlineOptions, `item-${index}-${itemIndex}`)}
                </li>
              ))}
            </ListTag>
          )
        }

        if (block.type === "paragraph") {
          return (
            <p className="whitespace-pre-wrap" key={index}>
              {renderInlineMarkdown(block.content, inlineOptions, `paragraph-${index}`)}
            </p>
          )
        }

        return null
      })}
    </div>
  )
}

function ChatAttachments({
  attachments,
  isAddingToArtifacts,
  onAddToArtifacts,
  onRemove,
  threadId,
}: {
  attachments: AgentAttachment[]
  isAddingToArtifacts?: boolean
  onAddToArtifacts?: (attachment: AgentAttachment, threadId: string) => void
  onRemove?: (attachmentId: string) => void
  threadId: string | null
}) {
  if (attachments.length === 0) {
    return null
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {attachments.map((attachment) => {
        const content = (
          <>
            {threadId && isImageAttachment(attachment) ? (
              <img
                alt={attachment.name}
                className="size-8 rounded object-cover"
                src={agentAttachmentUrl(threadId, attachment.id)}
              />
            ) : null}
            <span className="min-w-0 truncate">{attachment.name}</span>
            <span className="shrink-0 text-muted-foreground">{formatAttachmentSize(attachment.size)}</span>
          </>
        )

        if (threadId && onAddToArtifacts) {
          return (
            <DropdownMenu key={attachment.id}>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex max-w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground hover:bg-muted"
                  type="button"
                >
                  {content}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-44">
                <DropdownMenuItem
                  disabled={isAddingToArtifacts}
                  onSelect={() => onAddToArtifacts(attachment, threadId)}
                >
                  <HugeiconsIcon icon={FileLinkIcon} strokeWidth={2} />
                  Add to artifacts
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        }

        return (
          <div
            className="flex max-w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
            key={attachment.id}
          >
            {content}
            {onRemove ? (
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={() => onRemove(attachment.id)}
                type="button"
              >
                Remove
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function activityActorOrEvent(entry: ActivityEntry) {
  return entry.author
}

function activityActorClass(value: string) {
  const palette = [
    "text-sky-600 dark:text-sky-400",
    "text-emerald-600 dark:text-emerald-400",
    "text-amber-600 dark:text-amber-400",
    "text-rose-600 dark:text-rose-400",
    "text-violet-600 dark:text-violet-400",
    "text-cyan-600 dark:text-cyan-400",
  ]
  let hash = 0

  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % palette.length
  }

  return palette[hash]
}

function artifactPathFromActivityHref(href: string) {
  const path = href.replace(/^\.?\//, "").replace(/^\.\.\//, "")
  return path.startsWith("artifacts/") ? path : null
}

function renderActivityContent(content: string, onOpenArtifact: (path: string) => void) {
  const nodes = []
  const matcher = /\[([^\]]+)\]\(([^)]+)\)/g
  let lastIndex = 0
  let match

  while ((match = matcher.exec(content))) {
    const [raw, label, href] = match

    if (match.index > lastIndex) {
      nodes.push(content.slice(lastIndex, match.index))
    }

    const artifactPath = artifactPathFromActivityHref(href)
    if (artifactPath) {
      nodes.push(
        <a
          className="font-medium text-primary underline-offset-2 hover:underline"
          href={artifactPath}
          key={`${match.index}-${href}`}
          onClick={(event) => {
            event.preventDefault()
            onOpenArtifact(artifactPath)
          }}
        >
          {label}
        </a>
      )
    } else {
      const safeHref = safeExternalMarkdownHref(href)
      if (!safeHref) {
        nodes.push(label)
        lastIndex = match.index + raw.length
        continue
      }

      nodes.push(
        <a
          className="font-medium text-primary underline-offset-2 hover:underline"
          href={safeHref}
          key={`${match.index}-${href}`}
          rel={opensInNewTab(safeHref) ? "noreferrer" : undefined}
          target={opensInNewTab(safeHref) ? "_blank" : undefined}
        >
          {label}
        </a>
      )
    }

    lastIndex = match.index + raw.length
  }

  if (lastIndex < content.length) {
    nodes.push(content.slice(lastIndex))
  }

  return nodes.length > 0 ? nodes : content
}

function ActivityEntryView({
  entry,
  onOpenArtifact,
}: {
  entry: ActivityEntry
  onOpenArtifact: (path: string) => void
}) {
  const actorOrEvent = activityActorOrEvent(entry)

  return (
    <article className="py-1.5 text-xs leading-5 text-foreground">
      <div className="whitespace-pre-wrap">
        <span className="text-muted-foreground">{formatActivityDate(entry.createdAt)}</span>
        <span className="text-muted-foreground"> - </span>
        <span className={cn("font-medium", activityActorClass(actorOrEvent))}>{actorOrEvent}</span>
        <span>: </span>
        <span>{renderActivityContent(entry.content, onOpenArtifact)}</span>
      </div>
    </article>
  )
}

function ProjectRail({
  activePath,
  activeGeneratedPath,
  activePlanItemPath,
  busyWorkflowId,
  workflows,
  artifacts,
  generatedFiles,
  planItems,
  view,
  onOpenConfig,
  onOpenActivity,
  onOpenAssistant,
  onOpenArtifacts,
  onOpenArtifact,
  onOpenGeneratedFile,
  onAddArtifact,
  onCreateDrawing,
  onAddPlanItem,
  onRunWorkflow,
  onOpenPlan,
  onOpenPlanItem,
}: {
  activePath: string | null
  activeGeneratedPath: string | null
  activePlanItemPath: string | null
  busyWorkflowId: string | null
  workflows: WorkflowDefinition[]
  artifacts: ProjectFile[]
  generatedFiles: ProjectFile[]
  planItems: ProjectFile[]
  view: MainView
  onOpenConfig: () => void
  onOpenActivity: () => void
  onOpenAssistant: () => void
  onOpenArtifacts: () => void
  onOpenArtifact: (path: string) => void
  onOpenGeneratedFile: (path: string) => void
  onAddArtifact: () => void
  onCreateDrawing: () => void
  onAddPlanItem: () => void
  onRunWorkflow: (workflowId: string) => void
  onOpenPlan: () => void
  onOpenPlanItem: (path: string) => void
}) {
  return (
    <aside className="hidden w-[260px] shrink-0 overflow-y-auto border-l border-border/70 bg-background px-4 py-5 lg:block">
      <section className="space-y-1">
        <button
          className={cn(
            "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-muted",
            view === "activity" && activePath === null && "bg-muted text-foreground"
          )}
          onClick={onOpenActivity}
          type="button"
        >
          <span>Project Log</span>
        </button>
        <button
          className={cn(
            "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-muted",
            view === "agents" && "bg-muted text-foreground"
          )}
          onClick={onOpenAssistant}
          type="button"
        >
          <span>Assistant</span>
        </button>
        <button
          className={cn(
            "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium hover:bg-muted",
            view === "config" && "bg-muted text-foreground"
          )}
          onClick={onOpenConfig}
          type="button"
        >
          <HugeiconsIcon className="size-4 shrink-0 text-muted-foreground" icon={Settings05Icon} strokeWidth={2} />
          <span>Config</span>
        </button>
      </section>

      <section className="mt-6 space-y-2">
        <div className="px-2 text-sm font-semibold text-muted-foreground">Workflows</div>
        <div className="space-y-1">
          {workflows.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">Empty</div>
          ) : (
            workflows.map((workflow) => (
              <button
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                disabled={Boolean(busyWorkflowId)}
                key={workflow.id}
                onClick={() => onRunWorkflow(workflow.id)}
                title={workflow.description || workflow.title}
                type="button"
              >
                <HugeiconsIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  icon={FileCodeIcon}
                  strokeWidth={2}
                />
                <span className="min-w-0 truncate">
                  {busyWorkflowId === workflow.id ? "Running..." : workflow.title}
                </span>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="mt-6 space-y-2">
        <div className="px-2 text-sm font-semibold text-muted-foreground">Generated</div>
        <div className="space-y-1">
          {generatedFiles.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">Empty</div>
          ) : (
            generatedFiles.map((file) => (
              <button
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  view === "generated-file" && activeGeneratedPath === file.path && "bg-muted text-foreground"
                )}
                key={file.path}
                onClick={() => onOpenGeneratedFile(file.path)}
                type="button"
              >
                <HugeiconsIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  icon={FileCodeIcon}
                  strokeWidth={2}
                />
                <span className="min-w-0 truncate">{displayFileTitle(file)}</span>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="mt-6 space-y-2">
        <div className="flex items-center justify-between gap-2 px-2 text-sm font-semibold text-muted-foreground">
          <button
            className={cn(
              "-ml-2 rounded-md px-2 py-1 text-left hover:bg-muted hover:text-foreground",
              view === "artifacts" && "bg-muted text-foreground"
            )}
            onClick={onOpenArtifacts}
            type="button"
          >
            Artifacts
          </button>
          <div className="flex items-center gap-1">
            <button
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onCreateDrawing}
              title="New drawing"
              type="button"
            >
              <HugeiconsIcon icon={DrawingModeIcon} strokeWidth={2} className="size-4" />
            </button>
            <button
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={onAddArtifact}
              title="Add artifact"
              type="button"
            >
              <HugeiconsIcon icon={AddCircleIcon} strokeWidth={2} className="size-4" />
            </button>
          </div>
        </div>
        <div className="space-y-1">
          {artifacts.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">Empty</div>
          ) : (
            artifacts.map((file) => (
              <button
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  view === "artifact" && activePath === file.path && "bg-muted text-foreground"
                )}
                key={file.path}
                onClick={() => onOpenArtifact(file.path)}
                type="button"
              >
                <HugeiconsIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  icon={iconForFile(file.name)}
                  strokeWidth={2}
                />
                <span className="min-w-0 truncate">{displayFileTitle(file)}</span>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="mt-6 space-y-2">
        <div className="flex items-center justify-between gap-2 px-2 text-sm font-semibold text-muted-foreground">
          <button
            className={cn(
              "-ml-2 rounded-md px-2 py-1 text-left hover:bg-muted hover:text-foreground",
              view === "plan" && "bg-muted text-foreground"
            )}
            onClick={onOpenPlan}
            type="button"
          >
            Plan
          </button>
          <button
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={onAddPlanItem}
            title="Add plan item"
            type="button"
          >
            <HugeiconsIcon icon={AddCircleIcon} strokeWidth={2} className="size-4" />
          </button>
        </div>
        <div className="space-y-1">
          {planItems.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">No plan items</div>
          ) : (
            planItems.map((planItem) => (
              <button
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  view === "plan-item" && activePlanItemPath === planItem.path && "bg-muted text-foreground"
                )}
                key={planItem.path}
                onClick={() => onOpenPlanItem(planItem.path)}
                type="button"
              >
                <HugeiconsIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  icon={iconForFile(planItem.name)}
                  strokeWidth={2}
                />
                <span className="truncate">{displayFileTitle(planItem)}</span>
              </button>
            ))
          )}
        </div>
      </section>
    </aside>
  )
}

function DocsRail({
  activePath,
  files,
  onOpenFile,
}: {
  activePath: string | null
  files: ProjectFile[]
  onOpenFile: (path: string) => void
}) {
  return (
    <aside className="hidden w-[260px] shrink-0 overflow-y-auto border-l border-border/70 bg-background px-4 py-5 lg:block">
      <section className="space-y-2">
        <div className="px-2 text-sm font-semibold text-muted-foreground">Files</div>
        <div className="space-y-1">
          {files.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">Empty</div>
          ) : (
            files.map((file) => (
              <button
                className={cn(
                  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted",
                  activePath === file.path && "bg-muted text-foreground"
                )}
                key={file.path}
                onClick={() => onOpenFile(file.path)}
                type="button"
              >
                <HugeiconsIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  icon={iconForFile(file.name)}
                  strokeWidth={2}
                />
                <span className="min-w-0 truncate">{displayFileTitle(file)}</span>
              </button>
            ))
          )}
        </div>
      </section>
    </aside>
  )
}

function AssistantChatView({
  bottomRef,
  commandFiles,
  draft,
  error,
  input,
  isAddingToArtifacts,
  isUploadingAttachment,
  isLoading,
  isSending,
  messages,
  pendingAttachments,
  roles,
  selectedRole,
  selectedThreadId,
  thoughts,
  threads,
  onAddAttachmentToArtifacts,
  onAddMessageToArtifacts,
  onInputChange,
  onAttachmentRemove,
  onAttachmentUpload,
  onNewThread,
  onOpenProjectFile,
  onRoleChange,
  onSubmit,
  onThoughtStepToggle,
  onThoughtToggle,
  onThreadChange,
}: {
  bottomRef: RefObject<HTMLDivElement | null>
  commandFiles: ProjectFile[]
  draft: string
  error: string | null
  input: string
  isAddingToArtifacts: boolean
  isUploadingAttachment: boolean
  isLoading: boolean
  isSending: boolean
  messages: AgentMessage[]
  pendingAttachments: AgentAttachment[]
  roles: AssistantRole[]
  selectedRole: string
  selectedThreadId: string | null
  thoughts: ThoughtRun[]
  threads: AgentThread[]
  onAddAttachmentToArtifacts: (attachment: AgentAttachment, threadId: string) => void
  onAddMessageToArtifacts: (message: AgentMessage) => void
  onInputChange: (value: string) => void
  onAttachmentRemove: (attachmentId: string) => void
  onAttachmentUpload: (files: File[]) => void
  onNewThread: () => void
  onOpenProjectFile?: (path: string) => void
  onRoleChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onThoughtStepToggle: (runId: string, stepId: string, open: boolean) => void
  onThoughtToggle: (runId: string, open: boolean) => void
  onThreadChange: (threadId: string) => void
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [fileMenu, setFileMenu] = useState({
    activeIndex: 0,
    open: false,
    query: "",
  })
  const [threadMenuValue, setThreadMenuValue] = useState("")
  const vaultRoles = roles.filter((role) => role.scope === "vault")
  const projectRoles = roles.filter((role) => role.scope === "project")
  const hasRoles = roles.length > 0
  const thoughtsByUserMessageId = new Map(thoughts.map((thought) => [thought.userMessageId, thought]))
  const activeThought = [...thoughts].reverse().find((thought) => thought.status === "running")
  const isEmpty = !isLoading && messages.length === 0 && !draft
  const latestThreads = threads.slice(0, 15)
  const selectedThread = selectedThreadId
    ? threads.find((thread) => thread.id === selectedThreadId) ?? null
    : null
  const selectedThreadTitle = selectedThread
    ? deriveAssistantThreadTitle(selectedThread.title ?? "Untitled")
    : "New chat"
  const closeFileMenu = useCallback(() => {
    setFileMenu((current) =>
      current.open ? { ...current, open: false } : current
    )
  }, [])
  const syncFileMenu = useCallback((element: HTMLTextAreaElement, value = element.value) => {
    const token = fileMentionTokenAt(value, element.selectionStart)

    if (!token) {
      closeFileMenu()
      return
    }

    setFileMenu({
      activeIndex: 0,
      open: true,
      query: token.query,
    })
  }, [closeFileMenu])
  const insertFileMention = useCallback((file: ProjectFile) => {
    const element = textareaRef.current
    const currentValue = element?.value ?? input
    const cursor = element?.selectionStart ?? currentValue.length
    const token = fileMentionTokenAt(currentValue, cursor)
    const markdown = fileMarkdown(file, { embedImages: false, label: "name" })
    const nextValue = token
      ? `${currentValue.slice(0, token.start)}${markdown}${currentValue.slice(token.end)}`
      : `${currentValue}${markdown}`
    const nextCursor = token ? token.start + markdown.length : nextValue.length

    onInputChange(nextValue)
    closeFileMenu()
    window.requestAnimationFrame(() => {
      const nextElement = textareaRef.current
      if (!nextElement) return

      nextElement.focus()
      nextElement.setSelectionRange(nextCursor, nextCursor)
      resizeAssistantComposer(nextElement)
    })
  }, [closeFileMenu, input, onInputChange])
  const filteredFileItems = useMemo(() => {
    const query = fileMenu.query.trim().toLowerCase()
    const items = commandFiles.map<CommandMenuItem>((file) => ({
      group: "files",
      groupLabel: "Files",
      icon: fileCommandIcon(file),
      id: `file:${file.path}`,
      label: file.title?.trim() || file.name,
      onRun: () => insertFileMention(file),
      subtitle: file.path,
    }))

    if (!query) return items

    return items.filter((item) =>
      `${item.label} ${item.subtitle ?? ""}`.toLowerCase().includes(query)
    )
  }, [commandFiles, fileMenu.query, insertFileMention])
  const fileMenuGroups = useMemo(
    () => groupCommandMenuItems(filteredFileItems),
    [filteredFileItems]
  )
  const handleComposerChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    onInputChange(event.target.value)
    syncFileMenu(event.target)
  }, [onInputChange, syncFileMenu])
  const handleComposerKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (fileMenu.open) {
      if (event.key === "Escape") {
        event.preventDefault()
        closeFileMenu()
        return
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? 1 : -1
        const itemCount = filteredFileItems.length

        setFileMenu((current) => ({
          ...current,
          activeIndex:
            itemCount === 0
              ? 0
              : (current.activeIndex + delta + itemCount) % itemCount,
        }))
        return
      }

      if (event.key === "Enter") {
        event.preventDefault()
        filteredFileItems[fileMenu.activeIndex]?.onRun()
        return
      }
    }

    handleAssistantComposerKeyDown(event)
  }, [
    closeFileMenu,
    fileMenu.activeIndex,
    fileMenu.open,
    filteredFileItems,
  ])

  return (
    <section className={cn("mx-auto flex min-h-full w-full flex-col", CHAT_MAX_WIDTH)}>
      <div className="mb-6 flex min-w-0 items-center gap-2">
        <NavigationMenu
          className="min-w-0"
          delayDuration={0}
          onValueChange={setThreadMenuValue}
          skipDelayDuration={0}
          value={threadMenuValue}
        >
          <NavigationMenuList>
            <NavigationMenuItem value={CHAT_THREAD_MENU_VALUE}>
              <NavigationMenuTrigger
                className="max-w-[min(22rem,calc(100vw-8rem))]"
                onClick={(event) => {
                  event.preventDefault()
                  setThreadMenuValue((current) =>
                    current === CHAT_THREAD_MENU_VALUE ? "" : CHAT_THREAD_MENU_VALUE
                  )
                }}
              >
                <span className="truncate">{selectedThreadTitle}</span>
                <span
                  aria-hidden="true"
                  className="-mt-0.5 size-2 shrink-0 rotate-45 border-r border-b border-current opacity-80"
                />
              </NavigationMenuTrigger>
              <NavigationMenuContent className="w-[min(22rem,calc(100vw-2rem))]">
                <div className="max-h-[22rem] overflow-y-auto p-1">
                  {latestThreads.map((thread) => (
                    <NavigationMenuLink asChild key={thread.id}>
                      <button
                        className={cn(
                          "flex w-full min-w-0 flex-col text-left",
                          selectedThreadId === thread.id && "bg-muted text-foreground"
                        )}
                        onClick={() => {
                          setThreadMenuValue("")
                          onThreadChange(thread.id)
                        }}
                        type="button"
                      >
                        <span className="truncate">{deriveAssistantThreadTitle(thread.title ?? "Untitled")}</span>
                      </button>
                    </NavigationMenuLink>
                  ))}
                  {latestThreads.length === 0 ? (
                    <div className="px-2 py-1.5 text-sm text-muted-foreground">No chats yet</div>
                  ) : null}
                </div>
              </NavigationMenuContent>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
        <Button
          disabled={isSending}
          onClick={() => {
            setThreadMenuValue("")
            onNewThread()
          }}
          type="button"
          variant="outline"
        >
          <HugeiconsIcon icon={AddCircleIcon} strokeWidth={2} />
          New chat
        </Button>
      </div>

      <div className="min-h-0 flex-1">
        {isEmpty ? (
          <div className="space-y-4">
            <div className="flex min-h-[45vh] items-center justify-center text-center">
              <div className="max-w-xl">
                <h3 className="text-3xl font-semibold tracking-tight text-foreground">New chat</h3>
                <p className="mt-3 text-[15px] leading-7 text-muted-foreground">
                  Dimmi cosa vuoi costruire, sistemare o esplorare.
                </p>
              </div>
            </div>
            {error ? (
              <div className="rounded-[20px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
                {error}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex w-full flex-col gap-8">
            <section className="space-y-4">
              {isLoading ? (
                <div className="rounded-[24px] border border-border/70 bg-card px-5 py-6 text-[13px] text-muted-foreground">
                  Loading thread history...
                </div>
              ) : null}

              {messages.map((message) => {
                const isUser = message.role === "user"
                const thought = thoughtsByUserMessageId.get(message.id)
                const isCurrentTurnAnchor = activeThought?.userMessageId === message.id

                return (
                  <div key={message.id} className="space-y-4">
                    <section className={cn("flex", isUser ? "justify-end" : "justify-start")}>
                      {isUser ? (
                        <div className="max-w-[min(100%,42rem)] rounded-[22px] border border-primary/15 bg-primary px-5 py-4 text-[13px] leading-6 text-primary-foreground shadow-sm md:text-[14px]">
                          <MarkdownMessage
                            content={message.content}
                            linkClassName="decoration-current"
                            onOpenProjectFile={onOpenProjectFile}
                          />
                          <ChatAttachments
                            attachments={message.attachments ?? []}
                            isAddingToArtifacts={isAddingToArtifacts}
                            onAddToArtifacts={onAddAttachmentToArtifacts}
                            threadId={selectedThreadId}
                          />
                        </div>
                      ) : (
                        <div className="max-w-[min(100%,42rem)] px-1 py-1 text-[13px] leading-7 text-foreground md:text-[14px]">
                          <MarkdownMessage
                            content={message.content}
                            onOpenProjectFile={onOpenProjectFile}
                          />
                          {message.content.trim() ? (
                            <button
                              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                              disabled={isAddingToArtifacts}
                              onClick={() => onAddMessageToArtifacts(message)}
                              type="button"
                            >
                              <HugeiconsIcon className="size-3.5" icon={FileLinkIcon} strokeWidth={2} />
                              Add to artifacts
                            </button>
                          ) : null}
                        </div>
                      )}
                    </section>

                    {thought ? (
                      <>
                        <section className="flex justify-start">
                          <ChatThought
                            thought={thought}
                            onStepToggle={(stepId, open) => onThoughtStepToggle(thought.id, stepId, open)}
                            onThoughtToggle={(open) =>
                              onThoughtToggle(thought.id, thought.status === "running" ? true : open)
                            }
                          />
                        </section>

                        {isCurrentTurnAnchor && draft ? (
                          <section className="flex justify-start">
                            <div className="max-w-[min(100%,42rem)] px-1 py-1 text-[13px] leading-7 text-foreground md:text-[14px]">
                              <MarkdownMessage
                                content={draft}
                                onOpenProjectFile={onOpenProjectFile}
                              />
                            </div>
                          </section>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                )
              })}

              {draft && !activeThought ? (
                <section className="flex justify-start">
                  <div className="max-w-[min(100%,42rem)] px-1 py-1 text-[13px] leading-7 text-foreground md:text-[14px]">
                    <MarkdownMessage
                      content={draft}
                      onOpenProjectFile={onOpenProjectFile}
                    />
                  </div>
                </section>
              ) : null}

              {error ? (
                <div className="rounded-[20px] border border-destructive/30 bg-destructive/10 px-4 py-3 text-[13px] text-destructive">
                  {error}
                </div>
              ) : null}

              <div ref={bottomRef} />
            </section>
          </div>
        )}
      </div>

      <footer className="sticky bottom-0 z-10 shrink-0 bg-background pt-5">
        <div className="relative rounded-[26px] border border-border bg-card px-4 py-2.5 shadow-[0_14px_24px_rgba(15,23,42,0.08)]">
          {fileMenu.open ? (
            <div className="absolute bottom-[calc(100%+8px)] left-0 z-50">
              <CommandMenuList
                activeIndex={fileMenu.activeIndex}
                className="w-[min(18rem,calc(100vw-2rem))]"
                groups={fileMenuGroups}
                onActiveIndexChange={(activeIndex) =>
                  setFileMenu((current) => ({ ...current, activeIndex }))
                }
                onRun={(item) => item.onRun()}
              />
            </div>
          ) : null}
          <form className="flex flex-col gap-2.5" onSubmit={onSubmit}>
            <ChatAttachments
              attachments={pendingAttachments}
              onRemove={onAttachmentRemove}
              threadId={selectedThreadId}
            />
            <div className="relative">
              {input ? (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 top-0 whitespace-pre-wrap break-words text-[13px] leading-5 text-foreground"
                >
                  {renderComposerDisplayText(input)}
                </div>
              ) : null}
              <textarea
                className={cn(
                  "min-h-0 w-full resize-none bg-transparent text-[13px] leading-5 text-foreground outline-none placeholder:text-muted-foreground",
                  input && "text-transparent caret-foreground"
                )}
                disabled={isSending}
                onBlur={() => window.setTimeout(closeFileMenu, 0)}
                onChange={handleComposerChange}
                onClick={(event) => {
                  if (fileMenu.open) syncFileMenu(event.currentTarget)
                }}
                onInput={(event) => resizeAssistantComposer(event.currentTarget)}
                onKeyDown={handleComposerKeyDown}
                placeholder="Ask for follow-up changes"
                ref={textareaRef}
                rows={1}
                style={{ height: "20px", overflowY: "hidden" }}
                value={input}
              />
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <input
                className="hidden"
                multiple
                onChange={(event) => {
                  const files = Array.from(event.target.files ?? [])
                  if (files.length) {
                    onAttachmentUpload(files)
                  }
                  event.target.value = ""
                }}
                ref={fileInputRef}
                type="file"
              />
              <button
                aria-label="Add"
                className="inline-flex size-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition hover:bg-muted"
                disabled={isSending || isUploadingAttachment}
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                <HugeiconsIcon className="size-4.5" icon={AddCircleIcon} strokeWidth={2} />
              </button>
              {isUploadingAttachment ? (
                <span className="text-xs text-muted-foreground">Uploading...</span>
              ) : null}

              {hasRoles ? (
                <label className="inline-flex min-w-0 items-center gap-2 rounded-full px-1 py-0.5 text-[12px] text-foreground">
                  <select
                    className="max-w-56 appearance-none bg-transparent pr-4 outline-none"
                    disabled={isSending}
                    onChange={(event) => onRoleChange(event.target.value)}
                    value={selectedRole}
                  >
                    <option value="">Default</option>
                    {vaultRoles.length ? (
                      <optgroup label="Vault roles">
                        {vaultRoles.map((role) => (
                          <option key={role.slug} value={role.slug}>
                            {role.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    {projectRoles.length ? (
                      <optgroup label="Project roles">
                        {projectRoles.map((role) => (
                          <option key={role.slug} value={role.slug}>
                            {role.overridesVault ? `${role.name} · overrides vault` : role.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </select>
                  <HugeiconsIcon
                    className="size-3.5 text-muted-foreground"
                    icon={ArrowDown03Icon}
                    strokeWidth={2}
                  />
                </label>
              ) : null}

              <div className="ml-auto flex items-center gap-2">
                <button
                  aria-label="Voice input"
                  className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted"
                  type="button"
                >
                  <HugeiconsIcon className="size-4.5" icon={Mic01Icon} strokeWidth={2} />
                </button>
                <Button
                  className="size-10 rounded-full p-0"
                  disabled={!input.trim() || isSending}
                  type="submit"
                >
                  <HugeiconsIcon className="size-4.5" icon={ArrowUp03Icon} strokeWidth={2} />
                </Button>
              </div>
            </div>
          </form>
        </div>
      </footer>
    </section>
  )
}

function ConfigView({
  isSaving,
  name,
  owner,
  ownerOptions,
  status,
  statusOptions,
  tags,
  onNameChange,
  onOwnerChange,
  onStatusChange,
  onSubmit,
  onTagsChange,
}: {
  isSaving: boolean
  name: string
  owner: string
  ownerOptions: string[]
  status: string
  statusOptions: string[]
  tags: string
  onNameChange: (value: string) => void
  onOwnerChange: (value: string) => void
  onStatusChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTagsChange: (value: string) => void
}) {
  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-foreground">Project config</h1>
        <div className="mt-1 text-xs text-muted-foreground">Folder-backed project settings</div>
      </div>

      <form className="grid gap-4 rounded-lg border border-border bg-card p-4" onSubmit={onSubmit}>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-foreground">Name / folder</span>
          <Input name="project-name" onChange={(event) => onNameChange(event.target.value)} value={name} />
          <span className="text-xs text-muted-foreground">Saving this field renames the project folder.</span>
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-foreground">Owner</span>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            name="project-owner"
            onChange={(event) => onOwnerChange(event.target.value)}
            value={owner}
          >
            <option value="">Unassigned</option>
            {optionsWithCurrent(ownerOptions, owner).map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-foreground">Status</span>
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
            name="project-status"
            onChange={(event) => onStatusChange(event.target.value)}
            value={status}
          >
            {optionsWithCurrent(statusOptions, status).map((item) => (
              <option key={item} value={item}>
                {labelFromValue(item)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm">
          <span className="font-medium text-foreground">Tags</span>
          <Input
            name="project-tags"
            onChange={(event) => onTagsChange(event.target.value)}
            placeholder="backend, migration"
            value={tags}
          />
        </label>
        <div className="flex justify-end">
          <Button disabled={isSaving || !name.trim()} type="submit">
            Save config
          </Button>
        </div>
      </form>
    </section>
  )
}

function PlaceholderView({ title }: { title: string }) {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      <div className="mt-3 rounded-lg border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
        Content not available yet.
      </div>
    </section>
  )
}

function TextFileView({
  content,
  isLoading,
}: {
  content: string | undefined
  isLoading: boolean
}) {
  return (
    <section className="mx-auto max-w-3xl">
      <pre className="whitespace-pre-wrap text-sm leading-7 text-foreground">
        {isLoading ? "Loading..." : content ?? ""}
      </pre>
    </section>
  )
}

function gitStepOutput(step: GitActionResult["steps"][number]) {
  return [`$ ${step.command}`, step.stdout.trim(), step.stderr.trim()].filter(Boolean).join("\n")
}

function GitView({
  busyAction,
  result,
  onPull,
  onPush,
}: {
  busyAction: string | null
  result: GitActionResult | null
  onPull: () => void
  onPush: () => void
}) {
  const isPulling = busyAction === "git-pull"
  const isPushing = busyAction === "git-push"
  const output = result?.steps.map(gitStepOutput).filter(Boolean).join("\n\n") || "No output."

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-5">
        <h1 className="text-xl font-semibold text-foreground">Git</h1>
        <div className="mt-1 text-xs text-muted-foreground">vault versioning</div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={Boolean(busyAction)} onClick={onPull} type="button" variant="outline">
          <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} />
          {isPulling ? "Pulling..." : "Git pull"}
        </Button>
        <Button disabled={Boolean(busyAction)} onClick={onPush} type="button">
          <HugeiconsIcon icon={ArrowUp03Icon} strokeWidth={2} />
          {isPushing ? "Pushing..." : "Git push"}
        </Button>
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-border bg-card">
        <div className="border-b border-border/70 px-4 py-3 text-sm font-medium text-foreground">
          {result ? result.summary : "Ready"}
        </div>
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap px-4 py-3 text-xs leading-6 text-muted-foreground">
          {output}
        </pre>
      </div>
    </section>
  )
}

function MyItemsView({
  groups,
  isLoading,
  isSaving,
  onOpenItem,
  onToggleItem,
}: {
  groups: MyPlanItemGroup[]
  isLoading: boolean
  isSaving: boolean
  onOpenItem: (item: MyPlanItem) => void
  onToggleItem: (item: MyPlanItem, done: boolean) => void
}) {
  const total = groups.reduce((count, group) => count + group.items.length, 0)

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-4">
        <h1 className="text-xl font-semibold text-foreground">My items</h1>
        <div className="mt-1 text-xs text-muted-foreground">
          {isLoading ? "Loading..." : `${total} assigned plan item${total === 1 ? "" : "s"}`}
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          No assigned plan items.
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <section className="overflow-hidden rounded-lg border border-border bg-card" key={group.project.id}>
              <div className="border-b border-border/70 px-3 py-2">
                <div className="truncate text-sm font-semibold text-foreground">{group.project.name}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">{group.items.length} items</div>
              </div>
              {group.items.map((item) => (
                <div
                  className="flex min-w-0 items-center gap-3 border-b border-border/70 px-3 py-2 last:border-b-0"
                  key={`${item.projectId}:${item.path}`}
                >
                  <input
                    checked={Boolean(item.done)}
                    className="size-4 shrink-0 accent-foreground"
                    disabled={isSaving}
                    onChange={(event) => onToggleItem(item, event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <button
                    className={cn(
                      "min-w-0 flex-1 text-left text-sm font-medium text-foreground hover:underline",
                      item.done && "text-muted-foreground line-through"
                    )}
                    onClick={() => onOpenItem(item)}
                    type="button"
                  >
                    <span className="block truncate">{displayFileTitle(item)}</span>
                    <span className="block truncate text-xs font-normal text-muted-foreground">{item.path}</span>
                  </button>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {item.deadline ? `due ${item.deadline}` : "No date"}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </section>
  )
}

function FileIndexView({
  checkboxes = false,
  content,
  addLabel = "Add",
  emptyLabel = "Empty",
  files,
  indexPath,
  isLoading,
  isSaving,
  ownerOptions = [],
  title,
  onAdd,
  onCreateDrawing,
  onOpenFile,
  onSaveItems,
}: {
  checkboxes?: boolean
  content: string | undefined
  addLabel?: string
  emptyLabel?: string
  files: ProjectFile[]
  indexPath: string
  isLoading: boolean
  isSaving: boolean
  ownerOptions?: string[]
  title: string
  onAdd: () => void
  onCreateDrawing?: () => void
  onOpenFile: (path: string) => void
  onSaveItems: (items: FileIndexItem[]) => Promise<void>
}) {
  const dirName = indexPath.split("/")[0] ?? ""
  const parsedItems = useMemo(() => parseFileIndex(content, files, dirName), [content, dirName, files])
  const [items, setItems] = useState<FileIndexRow[]>(parsedItems)
  const [draggedPath, setDraggedPath] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [editingDeadlinePath, setEditingDeadlinePath] = useState<string | null>(null)
  const [editingOwnerPath, setEditingOwnerPath] = useState<string | null>(null)

  useEffect(() => {
    setItems(parsedItems)
  }, [parsedItems])

  function persist(nextItems: FileIndexRow[]) {
    setItems(nextItems)
    void onSaveItems(nextItems.map((item) => ({
      path: item.path,
      done: item.done,
      title: item.title,
      owner: item.owner,
      deadline: item.deadline,
    }))).catch(() => {
      setItems(parsedItems)
    })
  }

  function handleToggle(path: string) {
    persist(items.map((item) => item.path === path ? { ...item, done: !item.done } : item))
  }

  function handleTitleDraft(path: string, title: string) {
    setItems(items.map((item) => item.path === path ? { ...item, title } : item))
  }

  function handleTitleCommit(path: string, value: string) {
    const title = value.trim()
    const current = items.find((item) => item.path === path)

    if (!current) {
      return
    }

    if (!title) {
      const fallback = parsedItems.find((item) => item.path === path)?.title || displayFileTitle(current.file)
      setItems(items.map((item) => item.path === path ? { ...item, title: fallback } : item))
      return
    }

    if (title === parsedItems.find((item) => item.path === path)?.title) {
      setItems(items.map((item) => item.path === path ? { ...item, title } : item))
      return
    }

    persist(items.map((item) => item.path === path ? { ...item, title } : item))
  }

  function handleDeadlineChange(path: string, deadline: string) {
    persist(items.map((item) => item.path === path ? { ...item, deadline } : item))
    setEditingDeadlinePath(null)
  }

  function handleOwnerChange(path: string, owner: string) {
    persist(items.map((item) => item.path === path ? { ...item, owner } : item))
    setEditingOwnerPath(null)
  }

  function handleDragStart(event: DragEvent<HTMLButtonElement>, path: string) {
    setDraggedPath(path)
    setDropTarget(null)
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", path)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, targetPath: string) {
    event.preventDefault()
    event.dataTransfer.dropEffect = "move"

    const box = event.currentTarget.getBoundingClientRect()
    const placement: DropPlacement = event.clientY < box.top + box.height / 2 ? "before" : "after"
    setDropTarget({ path: targetPath, placement })
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, targetPath: string) {
    event.preventDefault()
    const sourcePath = draggedPath || event.dataTransfer.getData("text/plain")
    const placement = dropTarget?.path === targetPath ? dropTarget.placement : "before"

    if (!sourcePath || sourcePath === targetPath) {
      setDraggedPath(null)
      setDropTarget(null)
      return
    }

    const fromIndex = items.findIndex((item) => item.path === sourcePath)
    const targetIndex = items.findIndex((item) => item.path === targetPath)

    if (fromIndex === -1 || targetIndex === -1) {
      setDraggedPath(null)
      setDropTarget(null)
      return
    }

    const nextItems = [...items]
    const [moved] = nextItems.splice(fromIndex, 1)
    const nextTargetIndex = nextItems.findIndex((item) => item.path === targetPath)
    nextItems.splice(placement === "after" ? nextTargetIndex + 1 : nextTargetIndex, 0, moved)
    setDraggedPath(null)
    setDropTarget(null)
    persist(nextItems)
  }

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{title}</h1>
          <div className="mt-1 text-xs text-muted-foreground">{indexPath}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onCreateDrawing ? (
            <Button disabled={isSaving} onClick={onCreateDrawing} type="button" variant="outline">
              <HugeiconsIcon icon={DrawingModeIcon} strokeWidth={2} />
              New drawing
            </Button>
          ) : null}
          <Button disabled={isSaving} onClick={onAdd} type="button" variant="outline">
            <HugeiconsIcon icon={AddCircleIcon} strokeWidth={2} />
            {addLabel}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {items.map((item) => (
            <div
              className={cn(
                "relative flex min-w-0 items-center gap-3 border-b border-border/70 px-3 py-2 last:border-b-0",
                draggedPath === item.path && "opacity-60"
              )}
              key={item.path}
              onDragOver={(event) => handleDragOver(event, item.path)}
              onDrop={(event) => handleDrop(event, item.path)}
            >
              {dropTarget?.path === item.path ? (
                <span
                  className={cn(
                    "pointer-events-none absolute left-3 right-3 h-0.5 rounded-full bg-foreground",
                    dropTarget.placement === "before" ? "top-0" : "bottom-0"
                  )}
                />
              ) : null}
              <button
                className="inline-flex size-7 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
                disabled={isSaving}
                draggable={!isSaving}
                onDragEnd={() => {
                  setDraggedPath(null)
                  setDropTarget(null)
                }}
                onDragStart={(event) => handleDragStart(event, item.path)}
                title="Reorder item"
                type="button"
              >
                <HugeiconsIcon icon={DragDropVerticalIcon} strokeWidth={2} className="size-4" />
              </button>
              {checkboxes ? (
                <input
                  checked={item.done}
                  className="size-4 shrink-0 accent-foreground"
                  disabled={isSaving}
                  onChange={() => handleToggle(item.path)}
                  type="checkbox"
                />
              ) : null}
              {checkboxes ? (
                <div className="min-w-0 flex-1">
                  <Input
                    aria-label="Plan item title"
                    className={cn(
                      "h-8 min-w-0 border-transparent bg-transparent px-2 text-sm font-medium shadow-none hover:border-input focus-visible:border-ring",
                      item.done && "text-muted-foreground line-through"
                    )}
                    disabled={isSaving}
                    onBlur={(event) => handleTitleCommit(item.path, event.currentTarget.value)}
                    onChange={(event) => handleTitleDraft(item.path, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.currentTarget.blur()
                      }
                    }}
                    value={item.title}
                  />
                </div>
              ) : (
                <button
                  className="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground hover:underline"
                  onClick={() => onOpenFile(item.path)}
                  type="button"
                >
                  {item.title}
                </button>
              )}
              {checkboxes ? (
                editingDeadlinePath === item.path ? (
                  <Input
                    aria-label="Plan item deadline"
                    autoComplete="off"
                    autoFocus
                    className="h-8 w-32 shrink-0 px-2 text-xs sm:w-36"
                    disabled={isSaving}
                    onBlur={() => setEditingDeadlinePath(null)}
                    onChange={(event) => handleDeadlineChange(item.path, event.target.value)}
                    type="date"
                    value={item.deadline ?? ""}
                  />
                ) : (
                  <button
                    className={cn(
                      "h-8 w-32 shrink-0 truncate rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground sm:w-36",
                      item.deadline && "text-foreground"
                    )}
                    disabled={isSaving}
                    onClick={() => setEditingDeadlinePath(item.path)}
                    type="button"
                  >
                    {item.deadline || "No date"}
                  </button>
                )
              ) : null}
              {checkboxes ? (
                editingOwnerPath === item.path ? (
                  <select
                    aria-label="Plan item owner"
                    autoFocus
                    className="h-8 w-36 shrink-0 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    disabled={isSaving}
                    onBlur={() => setEditingOwnerPath(null)}
                    onChange={(event) => handleOwnerChange(item.path, event.target.value)}
                    value={item.owner ?? ""}
                  >
                    <option value="">Unassigned</option>
                    {ownerOptions.map((owner) => (
                      <option key={owner} value={owner}>
                        {owner}
                      </option>
                    ))}
                    {item.owner && !ownerOptions.includes(item.owner) ? (
                      <option value={item.owner}>{item.owner}</option>
                    ) : null}
                  </select>
                ) : (
                  <button
                    className={cn(
                      "inline-flex h-8 w-32 shrink-0 items-center truncate rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground sm:w-36",
                      item.owner && "text-foreground"
                    )}
                    disabled={isSaving}
                    onClick={() => setEditingOwnerPath(item.path)}
                    type="button"
                  >
                    {item.owner || "Unassigned"}
                  </button>
                )
              ) : (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{item.file.name}</span>
              )}
              {checkboxes ? (
                <button
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  onClick={() => onOpenFile(item.path)}
                  title="Open plan item"
                  type="button"
                >
                  <HugeiconsIcon icon={FileCodeIcon} strokeWidth={2} className="size-4" />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ArtifactView({
  content,
  isLoading,
  isSaving,
  projectId,
  artifact,
  commandFiles,
  onDelete,
  onDirtyChange,
  onDrawingActionsChange,
  onDrawingStatusChange,
  onOpenProjectFile,
  onSaveExcalidraw,
  onSaveMarkdown,
  onUploadImage,
  onMarkdownActionsChange,
  onMarkdownStatusChange,
  resolveUrl,
}: {
  content: string | undefined
  isLoading: boolean
  isSaving: boolean
  projectId: string
  artifact: ProjectFile
  commandFiles: ProjectFile[]
  onDelete: (path: string) => void
  onDirtyChange: (path: string, dirty: boolean) => void
  onDrawingActionsChange: (actions: ExcalidrawArtifactActions | null) => void
  onDrawingStatusChange: (status: ExcalidrawArtifactStatus | null) => void
  onOpenProjectFile?: (path: string) => void
  onSaveExcalidraw: (path: string, content: string, title?: string) => Promise<string>
  onSaveMarkdown: (path: string, content: string) => Promise<string>
  onUploadImage?: (file: File) => Promise<string>
  onMarkdownActionsChange?: (actions: MarkdownArtifactEditorActions | null) => void
  onMarkdownStatusChange?: (status: MarkdownArtifactEditorStatus | null) => void
  resolveUrl?: (url: string) => string
}) {
  const src = downloadUrl(projectId, artifact.path)

  if (isImageFile(artifact.name)) {
    return (
      <section className="mx-auto max-w-4xl">
        <div className="mb-5">
          <h1 className="truncate text-xl font-semibold text-foreground">{artifact.name}</h1>
          <div className="mt-1 text-xs text-muted-foreground">
            {artifact.path} / {formatSize(artifact.size)}
          </div>
        </div>
        <div className="flex h-[min(70vh,640px)] min-h-72 items-center justify-center rounded-lg border border-border bg-card p-3">
          <img alt={artifact.name} className="h-full max-h-full w-full max-w-full object-contain" src={src} />
        </div>
      </section>
    )
  }

  if (isExcalidrawFile(artifact.name)) {
    return (
      <Suspense fallback={<div className="text-sm text-muted-foreground">Loading...</div>}>
        <ExcalidrawArtifactEditor
          key={artifact.path}
          content={content}
          isLoading={isLoading}
          path={artifact.path}
          title={displayFileTitle(artifact)}
          onActionsChange={onDrawingActionsChange}
          onDirtyChange={(dirty) => onDirtyChange(artifact.path, dirty)}
          onStatusChange={onDrawingStatusChange}
          onSave={(nextContent, nextTitle) => onSaveExcalidraw(artifact.path, nextContent, nextTitle)}
        />
      </Suspense>
    )
  }

  if (isMarkdownFile(artifact.name)) {
    if (isLoading) {
      return (
        <TextFileView
          content={content}
          isLoading={isLoading}
        />
      )
    }

    return (
      <MarkdownArtifactEditor
        key={artifact.path}
        content={content}
        isLoading={false}
        isSaving={isSaving}
        commandFiles={commandFiles}
        path={artifact.name}
        title={artifact.name}
        onDelete={() => onDelete(artifact.path)}
        onOpenProjectFile={onOpenProjectFile}
        onSave={(nextContent) => onSaveMarkdown(artifact.path, nextContent)}
        onUploadImage={onUploadImage}
        onActionsChange={onMarkdownActionsChange}
        onStatusChange={onMarkdownStatusChange}
        resolveUrl={resolveUrl}
      />
    )
  }

  if (isTextFile(artifact.name)) {
    return (
      <TextFileView
        content={content}
        isLoading={isLoading}
      />
    )
  }

  return (
    <section className="mx-auto max-w-3xl">
      <div className="mb-5">
        <h1 className="truncate text-xl font-semibold text-foreground">{artifact.name}</h1>
        <div className="mt-1 text-xs text-muted-foreground">
          {artifact.path} / {formatSize(artifact.size)}
        </div>
      </div>
      <a
        className="inline-flex rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
        href={src}
      >
        Download file
      </a>
    </section>
  )
}

function ArtifactDialog({
  busy,
  file,
  open,
  textContent,
  textTitle,
  onFileChange,
  onOpenChange,
  onSubmit,
  onTextContentChange,
  onTextTitleChange,
}: {
  busy: boolean
  file: File | null
  open: boolean
  textContent: string
  textTitle: string
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void
  onOpenChange: (open: boolean) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTextContentChange: (value: string) => void
  onTextTitleChange: (value: string) => void
}) {
  const canSubmit = !busy && (Boolean(file) || Boolean(textContent.trim()))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add artifact</DialogTitle>
          <DialogDescription>Upload a file or paste markdown text.</DialogDescription>
        </DialogHeader>

        <form className="grid gap-5" onSubmit={onSubmit}>
          <section className="grid gap-2">
            <div className="text-sm font-medium text-foreground">File</div>
            <Input name="artifact-file" onChange={onFileChange} type="file" />
            <div className="truncate text-xs text-muted-foreground">
              {file?.name ?? "No file selected"}
            </div>
          </section>

          <section className="grid gap-3">
            <div className="text-sm font-medium text-foreground">Text</div>
            <Input
              name="artifact-title"
              onChange={(event) => onTextTitleChange(event.target.value)}
              placeholder="Title"
              value={textTitle}
            />
            <textarea
              className="min-h-40 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              name="artifact-content"
              onChange={(event) => onTextContentChange(event.target.value)}
              placeholder="Paste markdown or plain text"
              value={textContent}
            />
          </section>

          <DialogFooter>
            <Button disabled={busy} onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!canSubmit} type="submit">
              Save artifact
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function DrawingNameDialog({
  busy,
  mode,
  open,
  title,
  onOpenChange,
  onSubmit,
  onTitleChange,
}: {
  busy: boolean
  mode: "create" | "rename"
  open: boolean
  title: string
  onOpenChange: (open: boolean) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTitleChange: (value: string) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New drawing" : "Rename drawing"}</DialogTitle>
          <DialogDescription>
            {mode === "create" ? "Confirm the drawing name before creating it." : "Update the saved drawing name."}
          </DialogDescription>
        </DialogHeader>

        <form className="grid gap-5" onSubmit={onSubmit}>
          <Input
            autoFocus
            name="drawing-title"
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Drawing name"
            value={title}
          />
          <DialogFooter>
            <Button disabled={busy} onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={busy || !title.trim()} type="submit">
              {mode === "create" ? "Create" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function PlanItemDialog({
  busy,
  open,
  body,
  deadline,
  owner,
  ownerOptions,
  title,
  onBodyChange,
  onDeadlineChange,
  onOpenChange,
  onOwnerChange,
  onSubmit,
  onTitleChange,
}: {
  busy: boolean
  open: boolean
  body: string
  deadline: string
  owner: string
  ownerOptions: string[]
  title: string
  onBodyChange: (value: string) => void
  onDeadlineChange: (value: string) => void
  onOpenChange: (open: boolean) => void
  onOwnerChange: (value: string) => void
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  onTitleChange: (value: string) => void
}) {
  const canSubmit = !busy && Boolean(title.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add plan item</DialogTitle>
          <DialogDescription>Create a high-level project plan item.</DialogDescription>
        </DialogHeader>

        <form className="grid gap-5" onSubmit={onSubmit}>
          <section className="grid gap-3">
            <div className="text-sm font-medium text-foreground">Plan item</div>
            <Input
              name="plan-item-title"
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="Plan item title"
              value={title}
            />
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              name="plan-item-owner"
              onChange={(event) => onOwnerChange(event.target.value)}
              value={owner}
            >
              <option value="">Unassigned</option>
              {optionsWithCurrent(ownerOptions, owner).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
            <Input
              aria-label="Plan item deadline"
              autoComplete="off"
              name="plan-item-deadline"
              onChange={(event) => onDeadlineChange(event.target.value)}
              type="date"
              value={deadline}
            />
            <textarea
              className="min-h-32 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              name="plan-item-body"
              onChange={(event) => onBodyChange(event.target.value)}
              placeholder="Notes"
              value={body}
            />
          </section>

          <DialogFooter>
            <Button disabled={busy} onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!canSubmit} type="submit">
              Create plan item
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function AuthLoading() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-5 text-sm text-muted-foreground">
      Loading...
    </main>
  )
}

function LoginScreen({
  onLogin,
}: {
  onLogin: (status: AuthStatus) => void
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError("")
    setIsSubmitting(true)

    try {
      const status = await login(email.trim(), password)

      if (!status.authenticated) {
        setError("Invalid credentials")
        return
      }

      onLogin(status)
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Login failed")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-5">
      <form className="w-full max-w-sm rounded-lg border border-border bg-card p-5" onSubmit={handleSubmit}>
        <div className="mb-5">
          <h1 className="text-lg font-semibold text-foreground">Devsync</h1>
          <p className="mt-1 text-sm text-muted-foreground">Login required</p>
        </div>
        <label className="grid gap-1.5 text-sm font-medium text-foreground">
          Email
          <Input
            autoComplete="email"
            autoFocus
            className="h-9"
            disabled={isSubmitting}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
        </label>
        <label className="mt-3 grid gap-1.5 text-sm font-medium text-foreground">
          Password
          <Input
            autoComplete="current-password"
            className="h-9"
            disabled={isSubmitting}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </label>
        {error ? <div className="mt-3 text-sm text-destructive">{error}</div> : null}
        <Button className="mt-5 h-9 w-full" disabled={isSubmitting || !email.trim() || !password} type="submit">
          {isSubmitting ? "Logging in" : "Log in"}
        </Button>
      </form>
    </main>
  )
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    const element = document.createElement("textarea")
    element.value = value
    element.style.position = "fixed"
    element.style.opacity = "0"
    document.body.appendChild(element)
    element.select()
    document.execCommand("copy")
    document.body.removeChild(element)
  }
}

function McpTokensDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState("Codex")
  const [createdToken, setCreatedToken] = useState("")
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")
  const [busy, setBusy] = useState(false)
  const tokensQuery = useQuery({
    queryKey: ["mcp-tokens"],
    queryFn: listMcpTokens,
    enabled: open,
  })
  const tokens = tokensQuery.data?.items ?? []
  const mcpUrl = typeof window === "undefined" ? "/mcp" : `${window.location.origin}/mcp`
  const codexCommand = `codex mcp add devsync --url ${mcpUrl} --bearer-token-env-var DEVSYNC_MCP_TOKEN`

  useEffect(() => {
    if (!open) {
      setCreatedToken("")
      setError("")
      setStatus("")
    }
  }, [open])

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError("")
    setStatus("")

    try {
      const result = await createMcpToken(name)
      setCreatedToken(result.token)
      setStatus("Token generated")
      await queryClient.invalidateQueries({ queryKey: ["mcp-tokens"] })
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Token generation failed")
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(token: McpToken) {
    if (!window.confirm(`Revoke MCP token "${token.name}"?`)) {
      return
    }

    setBusy(true)
    setError("")
    setStatus("")

    try {
      await deleteMcpToken(token.id)
      setStatus("Token revoked")
      await queryClient.invalidateQueries({ queryKey: ["mcp-tokens"] })
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Token revoke failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>MCP tokens</DialogTitle>
          <DialogDescription>Personal bearer tokens for MCP clients.</DialogDescription>
        </DialogHeader>

        <form className="grid gap-3" onSubmit={handleCreate}>
          <label className="grid gap-1.5 text-sm font-medium text-foreground">
            Token name
            <div className="flex gap-2">
              <Input
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
                value={name}
              />
              <Button className="shrink-0" disabled={busy || !name.trim()} type="submit">
                <HugeiconsIcon icon={Key01Icon} strokeWidth={2} />
                Generate
              </Button>
            </div>
          </label>
        </form>

        {createdToken ? (
          <section className="grid gap-2 rounded-md border border-border bg-muted/20 p-3">
            <div className="text-xs font-medium text-foreground">Copy now. It will not be shown again.</div>
            <code className="block max-h-24 overflow-auto rounded border border-border bg-background p-2 text-xs text-foreground">
              {createdToken}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" type="button" variant="outline" onClick={() => copyText(createdToken)}>
                <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
                Copy token
              </Button>
              <Button size="sm" type="button" variant="outline" onClick={() => copyText(codexCommand)}>
                <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
                Copy Codex command
              </Button>
            </div>
          </section>
        ) : null}

        <section className="grid gap-2">
          <div className="text-xs font-medium uppercase tracking-normal text-muted-foreground">Codex</div>
          <code className="block overflow-auto rounded-md border border-border bg-muted/20 p-2 text-xs text-foreground">
            {codexCommand}
          </code>
        </section>

        <section className="overflow-hidden rounded-md border border-border">
          <div className="grid grid-cols-[1fr_150px_120px] gap-3 border-b border-border bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>Name</span>
            <span>Last used</span>
            <span />
          </div>
          {tokensQuery.isLoading ? (
            <div className="px-3 py-4 text-sm text-muted-foreground">Loading...</div>
          ) : tokens.length ? (
            <div className="divide-y divide-border">
              {tokens.map((token) => (
                <div className="grid grid-cols-[1fr_150px_120px] items-center gap-3 px-3 py-2 text-sm" key={token.id}>
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">{token.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {token.prefix}... created {formatSystemLogDate(token.createdAt)}
                    </div>
                  </div>
                  <span className="truncate text-xs text-muted-foreground">
                    {token.lastUsedAt ? formatSystemLogDate(token.lastUsedAt) : "Never"}
                  </span>
                  <Button disabled={busy} size="sm" type="button" variant="outline" onClick={() => handleDelete(token)}>
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    Revoke
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-4 text-sm text-muted-foreground">No tokens yet.</div>
          )}
        </section>

        {error ? <div className="text-sm text-destructive">{error}</div> : null}
        {status ? <div className="text-sm text-muted-foreground">{status}</div> : null}
      </DialogContent>
    </Dialog>
  )
}

export function App() {
  const queryClient = useQueryClient()
  const authQuery = useQuery({
    queryKey: ["auth", "me"],
    queryFn: getCurrentUser,
    retry: false,
  })

  async function handleLogout() {
    await logout()
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "auth" })
    await authQuery.refetch()
  }

  if (authQuery.isLoading) {
    return <AuthLoading />
  }

  if (authQuery.isError) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background px-5 text-sm text-destructive">
        Auth check failed
      </main>
    )
  }

  if (!authQuery.data?.authenticated) {
    return <LoginScreen onLogin={(status) => queryClient.setQueryData(["auth", "me"], status)} />
  }

  return <WorkspaceApp currentUser={authQuery.data.user} onLogout={handleLogout} />
}

function WorkspaceApp({
  currentUser,
  onLogout,
}: {
  currentUser: AuthUser
  onLogout: () => void
}) {
  const queryClient = useQueryClient()
  const { setTheme, theme } = useTheme()
  const activityScrollRef = useRef<HTMLDivElement | null>(null)
  const activityBottomRef = useRef<HTMLDivElement | null>(null)
  const assistantBottomRef = useRef<HTMLDivElement | null>(null)
  const assistantScrollFrameRef = useRef<number | null>(null)
  const agentEventSourceRef = useRef<EventSource | null>(null)
  const logTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const drawingActionsRef = useRef<ExcalidrawArtifactActions | null>(null)
  const markdownActionsRef = useRef<MarkdownArtifactEditorActions | null>(null)
  const planningActionsRef = useRef<PlanningActions | null>(null)
  const isLoadingOlderRef = useRef(false)
  const initialRoute = useMemo(() => parseAppRoute(), [])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialRoute.projectId)
  const [selectedDocId, setSelectedDocId] = useState<string | null>(initialRoute.docId)
  const [selectedArtifactPath, setSelectedArtifactPath] = useState<string | null>(initialRoute.artifactPath)
  const [selectedGeneratedPath, setSelectedGeneratedPath] = useState<string | null>(initialRoute.generatedPath)
  const [selectedPlanItemPath, setSelectedPlanItemPath] = useState<string | null>(initialRoute.planItemPath)
  const [selectedDocFilePath, setSelectedDocFilePath] = useState<string | null>(initialRoute.docFilePath)
  const [mainView, setMainView] = useState<MainView>(initialRoute.mainView)
  const [placeholderTitle, setPlaceholderTitle] = useState(initialRoute.placeholderTitle)
  const [isLoadingOlderActivity, setIsLoadingOlderActivity] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [message, setMessage] = useState<{ type: "ok" | "error"; text: string } | null>(null)
  const [logContent, setLogContent] = useState("")
  const [logFileMenu, setLogFileMenu] = useState({
    activeIndex: 0,
    open: false,
    query: "",
  })
  const [artifactDialogOpen, setArtifactDialogOpen] = useState(false)
  const [mcpTokensOpen, setMcpTokensOpen] = useState(false)
  const [artifactFile, setArtifactFile] = useState<File | null>(null)
  const [artifactTextTitle, setArtifactTextTitle] = useState("")
  const [artifactTextContent, setArtifactTextContent] = useState("")
  const [unsavedDrawingPath, setUnsavedDrawingPath] = useState<string | null>(null)
  const [drawingDialogMode, setDrawingDialogMode] = useState<"create" | "rename" | null>(null)
  const [drawingDialogTitle, setDrawingDialogTitle] = useState("Drawing")
  const [drawingFullscreen, setDrawingFullscreen] = useState(false)
  const [drawingStatus, setDrawingStatus] = useState<ExcalidrawArtifactStatus | null>(null)
  const [markdownStatus, setMarkdownStatus] = useState<MarkdownArtifactEditorStatus | null>(null)
  const [planningFullscreen, setPlanningFullscreen] = useState(false)
  const [planningStatus, setPlanningStatus] = useState<PlanningStatus | null>(null)
  const [planItemDialogOpen, setPlanItemDialogOpen] = useState(false)
  const [planItemTitle, setPlanItemTitle] = useState("")
  const [planItemOwner, setPlanItemOwner] = useState("")
  const [planItemDeadline, setPlanItemDeadline] = useState("")
  const [planItemBody, setPlanItemBody] = useState("")
  const [configName, setConfigName] = useState("")
  const [configOwner, setConfigOwner] = useState("")
  const [configStatus, setConfigStatus] = useState("")
  const [configTags, setConfigTags] = useState("")
  const [gitResult, setGitResult] = useState<GitActionResult | null>(null)
  const [selectedAgentThreadId, setSelectedAgentThreadId] = useState<string | null>(initialRoute.agentThreadId)
  const [selectedAssistantRole, setSelectedAssistantRole] = useState("")
  const [agentInput, setAgentInput] = useState("")
  const [agentDraft, setAgentDraft] = useState("")
  const [agentError, setAgentError] = useState<string | null>(null)
  const [agentPendingAttachments, setAgentPendingAttachments] = useState<AgentAttachment[]>([])
  const [assistantThoughtsByThread, setAssistantThoughtsByThread] = useState<Record<string, ThoughtRun[]>>({})
  const [isCreatingAgentThread, setIsCreatingAgentThread] = useState(false)
  const [isAgentSending, setIsAgentSending] = useState(false)
  const [isUploadingAgentAttachment, setIsUploadingAgentAttachment] = useState(false)
  const [pendingWorkflowId, setPendingWorkflowId] = useState<string | null>(null)

  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
  })
  const docsQuery = useQuery({
    queryKey: ["docs"],
    queryFn: listDocs,
  })
  const usersQuery = useQuery({
    queryKey: ["users"],
    queryFn: listUsers,
  })
  const myItemsQuery = useQuery({
    queryKey: ["my-plan-items"],
    queryFn: listMyPlanItems,
    enabled: mainView === "my-items",
  })
  const projects = projectsQuery.data?.items ?? EMPTY_PROJECTS
  const docs = docsQuery.data?.items ?? EMPTY_DOCS
  const ownerOptions = useMemo(
    () => Array.from(
      new Set(
        (usersQuery.data?.users ?? [currentUser])
          .map((user) => user.name || user.email || user.username)
          .filter(Boolean)
      )
    ).sort(),
    [currentUser, usersQuery.data?.users]
  )
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null
  const projectQuery = useQuery({
    queryKey: ["project", selectedProjectId],
    queryFn: () => getProject(selectedProjectId!, { activityFiles: 2 }),
    enabled: Boolean(selectedProjectId),
  })
  const project = projectQuery.data ?? selectedProject
  const currentAuthor = currentUser.name || currentUser.email || "team"
  const docsFolderQuery = useQuery({
    queryKey: ["docs-folder", selectedDocId],
    queryFn: () => getDocsFolder(selectedDocId!),
    enabled: Boolean(selectedDocId && mainView === "docs"),
  })
  const docsFolder = docsFolderQuery.data ?? null
  const readmeQuery = useQuery({
    queryKey: ["app-readme"],
    queryFn: getAppReadme,
    enabled: mainView === "readme",
  })
  const systemLogQuery = useQuery({
    queryKey: ["system-log"],
    queryFn: () => getSystemLog(200),
    enabled: mainView === "system-log",
  })
  const planningQuery = useQuery({
    queryKey: ["planning-gantt"],
    queryFn: getPlanningGantt,
    enabled: mainView === "planning",
    refetchOnWindowFocus: false,
  })
  const assistantQuery = useQuery({
    queryKey: ["assistant", selectedProjectId ?? "global"],
    queryFn: () => getAssistantConfig(selectedProjectId),
    enabled: mainView === "agents",
  })
  const assistantRolesQuery = useQuery({
    queryKey: ["assistant-roles", selectedProjectId ?? "global"],
    queryFn: () => listAssistantRoles(selectedProjectId),
    enabled: mainView === "agents",
  })
  const workflowsQuery = useQuery({
    queryKey: ["workflows", selectedProjectId ?? "global"],
    queryFn: () => listWorkflows(selectedProjectId),
    enabled: Boolean(selectedProjectId),
  })
  const agentThreadsQuery = useQuery({
    queryKey: ["agent-threads", selectedProjectId ?? "global"],
    queryFn: () => listAgentThreads(selectedProjectId),
    enabled: mainView === "agents",
  })
  const agentThreadQuery = useQuery({
    queryKey: ["agent-thread", selectedAgentThreadId],
    queryFn: () => getAgentThread(selectedAgentThreadId!),
    enabled: Boolean(mainView === "agents" && selectedAgentThreadId),
  })

  useEffect(() => {
    function applyCurrentRoute() {
      const route = parseAppRoute()

      agentEventSourceRef.current?.close()
      agentEventSourceRef.current = null
      setSelectedProjectId(route.projectId)
      setSelectedDocId(route.docId)
      setSelectedArtifactPath(route.artifactPath)
      setSelectedGeneratedPath(route.generatedPath)
      setSelectedPlanItemPath(route.planItemPath)
      setSelectedDocFilePath(route.docFilePath)
      setSelectedAgentThreadId(route.agentThreadId)
      setIsCreatingAgentThread(!route.agentThreadId)
      setPlaceholderTitle(route.placeholderTitle)
      setAgentDraft("")
      setAgentError(null)
      isLoadingOlderRef.current = false
      setIsLoadingOlderActivity(false)
      setMainView(route.mainView)
    }

    window.addEventListener("popstate", applyCurrentRoute)
    return () => window.removeEventListener("popstate", applyCurrentRoute)
  }, [])

  useEffect(() => {
    const needsProject = !["agents", "docs", "git", "my-items", "planning", "readme", "system-log"].includes(mainView)
    if (needsProject && !selectedProjectId && projects.length > 0) {
      return
    }

    const nextPath = buildAppPath({
      mainView,
      projectId: selectedProjectId,
      docId: selectedDocId,
      artifactPath: selectedArtifactPath,
      generatedPath: selectedGeneratedPath,
      planItemPath: selectedPlanItemPath,
      docFilePath: selectedDocFilePath,
      placeholderTitle,
      agentId: "",
      agentThreadId: selectedAgentThreadId,
    })
    const currentPath = `${window.location.pathname}${window.location.search}`

    if (nextPath !== currentPath) {
      window.history.pushState(null, "", nextPath)
    }
  }, [
    mainView,
    selectedProjectId,
    selectedDocId,
    selectedArtifactPath,
    selectedGeneratedPath,
    selectedPlanItemPath,
    selectedDocFilePath,
    placeholderTitle,
    selectedAgentThreadId,
    projects.length,
  ])

  useEffect(() => {
    if (["agents", "docs", "git", "my-items", "planning", "readme", "system-log"].includes(mainView)) {
      return
    }

    if (!projectsQuery.isFetched) {
      return
    }

    if (projects.length === 0) {
      setSelectedProjectId(null)
      setSelectedArtifactPath(null)
      setSelectedPlanItemPath(null)
      return
    }

    if (!selectedProjectId || !projects.some((item) => item.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id)
      setSelectedArtifactPath(null)
      setSelectedPlanItemPath(null)
    }
  }, [mainView, projects, projectsQuery.isFetched, selectedProjectId])

  useEffect(() => {
    return () => {
      agentEventSourceRef.current?.close()
      agentEventSourceRef.current = null
      if (assistantScrollFrameRef.current !== null) {
        cancelAnimationFrame(assistantScrollFrameRef.current)
        assistantScrollFrameRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (mainView !== "agents") {
      return
    }

    if (isCreatingAgentThread) {
      return
    }

    const threads = agentThreadsQuery.data?.items ?? []
    if (!selectedAgentThreadId || !threads.some((thread) => thread.id === selectedAgentThreadId)) {
      setSelectedAgentThreadId(threads[0]?.id ?? null)
    }
  }, [agentThreadsQuery.data?.items, mainView, selectedAgentThreadId, isCreatingAgentThread])

  const scrollAssistantToBottom = useCallback(() => {
    if (mainView !== "agents") {
      return
    }

    if (assistantScrollFrameRef.current !== null) {
      cancelAnimationFrame(assistantScrollFrameRef.current)
    }

    assistantScrollFrameRef.current = requestAnimationFrame(() => {
      assistantScrollFrameRef.current = null
      const scrollContainer = activityScrollRef.current

      if (!scrollContainer) {
        return
      }

      scrollContainer.scrollTop = scrollContainer.scrollHeight

      requestAnimationFrame(() => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight
      })
    })
  }, [mainView])

  useEffect(() => {
    if (!selectedAssistantRole) {
      return
    }

    const roles = assistantRolesQuery.data?.items ?? []
    if (assistantRolesQuery.isFetched && !roles.some((role) => role.slug === selectedAssistantRole)) {
      setSelectedAssistantRole("")
    }
  }, [assistantRolesQuery.data?.items, assistantRolesQuery.isFetched, selectedAssistantRole])

  useEffect(() => {
    if (mainView !== "agents") {
      return
    }

    scrollAssistantToBottom()
  }, [
    agentDraft,
    assistantThoughtsByThread,
    agentThreadQuery.data?.messages.length,
    mainView,
    selectedAgentThreadId,
    scrollAssistantToBottom,
  ])

  useEffect(() => {
    if (!project) {
      setConfigName("")
      setConfigOwner("")
      setConfigStatus("")
      setConfigTags("")
      return
    }

    setConfigName(project.name)
    setConfigOwner(project.owner)
    setConfigStatus(project.status)
    setConfigTags(project.tags.join(", "))
  }, [project])

  useEffect(() => {
    if (!message) {
      return
    }

    const timeoutId = window.setTimeout(() => setMessage(null), ALERT_DISMISS_MS)
    return () => window.clearTimeout(timeoutId)
  }, [message])

  const refresh = useCallback(async (projectId: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["projects"] }),
      queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
    ])
  }, [queryClient])

  const resolveMarkdownAssetUrl = useCallback(
    (url: string) => (selectedProjectId ? projectMarkdownAssetUrl(selectedProjectId, url) : url),
    [selectedProjectId]
  )

  const handleUploadMarkdownImage = useCallback(
    async (file: File) => {
      if (!selectedProjectId) {
        throw new Error("Project is required")
      }

      const artifact = await uploadArtifact(selectedProjectId, file, currentAuthor)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project", selectedProjectId] }),
        queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, ARTIFACT_INDEX_PATH] }),
      ])

      return "../" + artifact.path
    },
    [currentAuthor, queryClient, selectedProjectId]
  )

  async function run(
    action: string,
    work: () => Promise<void>,
    options: { throwOnError?: boolean; successMessage?: string } = {}
  ) {
    setBusyAction(action)
    setMessage(null)

    try {
      await work()
      setMessage({ type: "ok", text: options.successMessage ?? "Saved" })
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Request failed",
      })
      if (options.throwOnError) {
        throw error
      }
    } finally {
      setBusyAction(null)
    }
  }

  function canLeaveDrawing(nextArtifactPath: string | null = null) {
    if (!unsavedDrawingPath || unsavedDrawingPath === nextArtifactPath) {
      return true
    }

    return window.confirm("Discard unsaved drawing changes?")
  }

  function markDrawingDirty(path: string, dirty: boolean) {
    setUnsavedDrawingPath((current) => {
      if (dirty) {
        return path
      }

      return current === path ? null : current
    })
  }

  type NavigationTarget = {
    artifactPath?: string | null
    generatedPath?: string | null
    mainView?: MainView
    planItemPath?: string | null
  }

  function normalizeNavigationTarget(target?: string | NavigationTarget | null): NavigationTarget {
    if (typeof target === "string") {
      return { artifactPath: target, mainView: "artifact" }
    }

    return target ?? {}
  }

  function currentMarkdownRouteKey() {
    if (!markdownHeaderStatus?.dirty) {
      return null
    }

    if (mainView === "artifact" && selectedArtifactPath) {
      return `artifact:${selectedArtifactPath}`
    }

    if (mainView === "generated-file" && selectedGeneratedPath) {
      return `generated:${selectedGeneratedPath}`
    }

    if (mainView === "plan-item" && selectedPlanItemPath) {
      return `plan:${selectedPlanItemPath}`
    }

    return "markdown"
  }

  function targetMarkdownRouteKey(target: NavigationTarget) {
    if (target.mainView === "artifact" && target.artifactPath) {
      return `artifact:${target.artifactPath}`
    }

    if (target.mainView === "generated-file" && target.generatedPath) {
      return `generated:${target.generatedPath}`
    }

    if (target.mainView === "plan-item" && target.planItemPath) {
      return `plan:${target.planItemPath}`
    }

    return null
  }

  function canLeaveMarkdown(target: NavigationTarget) {
    const currentRoute = currentMarkdownRouteKey()
    if (!currentRoute || currentRoute === targetMarkdownRouteKey(target)) {
      return true
    }

    return window.confirm("Discard unsaved markdown changes?")
  }

  function guardedNavigation(action: () => void, target?: string | NavigationTarget | null) {
    const next = normalizeNavigationTarget(target)
    const nextArtifactPath = next.mainView === "artifact" ? next.artifactPath ?? null : null

    if (!canLeaveDrawing(nextArtifactPath)) {
      return
    }

    if (!canLeaveMarkdown(next)) {
      return
    }

    if (nextArtifactPath !== unsavedDrawingPath) {
      setUnsavedDrawingPath(null)
    }

    action()
  }

  const handleDrawingActionsChange = useCallback((actions: ExcalidrawArtifactActions | null) => {
    drawingActionsRef.current = actions
  }, [])

  const handleMarkdownActionsChange = useCallback((actions: MarkdownArtifactEditorActions | null) => {
    markdownActionsRef.current = actions
  }, [])

  const handleMarkdownStatusChange = useCallback((status: MarkdownArtifactEditorStatus | null) => {
    setMarkdownStatus(status)
  }, [])

  const handlePlanningActionsChange = useCallback((actions: PlanningActions | null) => {
    planningActionsRef.current = actions
  }, [])

  const handlePlanningStatusChange = useCallback((status: PlanningStatus | null) => {
    setPlanningStatus(status)
  }, [])

  function toggleTheme() {
    const isDark = document.documentElement.classList.contains("dark")
    setTheme(isDark ? "light" : "dark")
  }

  const appendAgentMessageToCache = useCallback((threadId: string, nextMessage: AgentMessage) => {
    queryClient.setQueryData<AgentThreadHistory | undefined>(["agent-thread", threadId], (current) => {
      if (!current) {
        return current
      }

      return {
        ...current,
        messages: current.messages.some((message) => message.id === nextMessage.id)
          ? current.messages
          : [...current.messages, nextMessage],
      }
    })
  }, [queryClient])

  function handleAssistantThoughtToggle(runId: string, open: boolean) {
    if (!selectedAgentThreadId) {
      return
    }

    setAssistantThoughtsByThread((current) =>
      updateThreadThoughtRun(current, selectedAgentThreadId, runId, null, (thought) => ({
        ...thought,
        isOpen: open,
      }))
    )
  }

  function handleAssistantThoughtStepToggle(runId: string, stepId: string, open: boolean) {
    if (!selectedAgentThreadId) {
      return
    }

    setAssistantThoughtsByThread((current) =>
      updateThreadThoughtRun(current, selectedAgentThreadId, runId, null, (thought) => ({
        ...thought,
        openStepId: open ? stepId : null,
      }))
    )
  }

  function handleNewAgentThread() {
    agentEventSourceRef.current?.close()
    agentEventSourceRef.current = null
    setSelectedAgentThreadId(null)
    setIsCreatingAgentThread(true)
    setAgentDraft("")
    setAgentError(null)
    setAgentPendingAttachments([])
  }

  function handleAgentThreadChange(threadId: string) {
    agentEventSourceRef.current?.close()
    agentEventSourceRef.current = null
    setSelectedAgentThreadId(threadId || null)
    setIsCreatingAgentThread(!threadId)
    setAgentPendingAttachments([])
    if (!threadId) {
      setAgentError(null)
      setAgentDraft("")
    }
  }

  function handleOpenAssistant() {
    if (!canLeaveDrawing()) {
      return
    }

    agentEventSourceRef.current?.close()
    agentEventSourceRef.current = null
    setSelectedAgentThreadId(null)
    setSelectedArtifactPath(null)
    setSelectedGeneratedPath(null)
    setSelectedPlanItemPath(null)
    setUnsavedDrawingPath(null)
    setPlaceholderTitle("")
    setAgentDraft("")
    setAgentError(null)
    setAgentPendingAttachments([])
    setMainView("agents")
  }

  async function ensureAgentThread(title: string | null = null) {
    if (selectedAgentThreadId) {
      return selectedAgentThreadId
    }

    const created = await createAgentThread({
      title,
      projectId: selectedProjectId,
    })

    setIsCreatingAgentThread(false)
    setSelectedAgentThreadId(created.id)
    queryClient.setQueryData<{ items: AgentThread[] } | undefined>(
      ["agent-threads", selectedProjectId ?? "global"],
      (current) => ({ items: [created, ...(current?.items ?? [])] })
    )
    queryClient.setQueryData<AgentThreadHistory>(["agent-thread", created.id], {
      attachments: [],
      thread: created,
      messages: [],
      runs: [],
    })

    return created.id
  }

  async function handleAgentAttachmentUpload(files: File[]) {
    if (isUploadingAgentAttachment) {
      return
    }

    setIsUploadingAgentAttachment(true)
    setAgentError(null)

    try {
      const threadId = await ensureAgentThread(null)
      const uploaded: AgentAttachment[] = []

      for (const file of files) {
        uploaded.push(await uploadAgentAttachment(threadId, file))
      }

      setAgentPendingAttachments((current) => [...current, ...uploaded])
      queryClient.setQueryData<AgentThreadHistory | undefined>(["agent-thread", threadId], (current) =>
        current
          ? { ...current, attachments: [...(current.attachments ?? []), ...uploaded] }
          : current
      )
    } catch (error) {
      setAgentError(error instanceof Error ? error.message : "Attachment upload failed")
    } finally {
      setIsUploadingAgentAttachment(false)
    }
  }

  function handleAgentAttachmentRemove(attachmentId: string) {
    setAgentPendingAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
  }

  async function handleAgentAttachmentAddToArtifacts(attachment: AgentAttachment, threadId: string) {
    if (!selectedProjectId) {
      setMessage({ type: "error", text: "Project is required" })
      return
    }

    await run("assistant-artifact", async () => {
      const response = await fetch(agentAttachmentUrl(threadId, attachment.id), {
        credentials: "same-origin",
      })

      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`)
      }

      const blob = await response.blob()
      await uploadArtifact(
        selectedProjectId,
        new File([blob], attachment.name, { type: attachment.mimeType || blob.type }),
        currentAuthor
      )
      await refresh(selectedProjectId)
      await queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, ARTIFACT_INDEX_PATH] })
    }, { successMessage: "Added to artifacts" })
  }

  async function handleAgentMessageAddToArtifacts(message: AgentMessage) {
    if (!selectedProjectId) {
      setMessage({ type: "error", text: "Project is required" })
      return
    }

    const content = message.content.trim()
    if (!content) {
      return
    }

    await run("assistant-artifact", async () => {
      await addTextArtifact(selectedProjectId, {
        title: deriveAssistantThreadTitle(content) || "Assistant response",
        content,
        author: currentAuthor,
      })
      await refresh(selectedProjectId)
      await queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, ARTIFACT_INDEX_PATH] })
    }, { successMessage: "Added to artifacts" })
  }

  const connectAgentRunStream = useCallback(({
    runId,
    streamUrl,
    threadId,
    userMessageId,
  }: {
    runId: string
    streamUrl: string
    threadId: string
    userMessageId: string
  }) => {
    agentEventSourceRef.current?.close()
    setAgentDraft("")
    setIsAgentSending(true)
    const stream = new EventSource(streamUrl)
    agentEventSourceRef.current = stream

    stream.addEventListener("token", (streamEvent) => {
      const payload = parseStreamPayload<{ token?: string }>(streamEvent)
      if (payload?.token) {
        setAgentDraft((current) => `${current}${payload.token}`)
        scrollAssistantToBottom()
        setAssistantThoughtsByThread((current) =>
          updateThreadThoughtRun(current, threadId, runId, userMessageId, (thought) => ({
            ...thought,
            isOpen: true,
            openStepId: null,
            status: "running",
          }))
        )
      }
    })

    stream.addEventListener("message", (streamEvent) => {
      const payload = parseStreamPayload<AgentMessage>(streamEvent)
      if (payload) {
        appendAgentMessageToCache(threadId, payload)
        setAgentDraft("")
        scrollAssistantToBottom()
        setAssistantThoughtsByThread((current) =>
          updateThreadThoughtRun(current, threadId, runId, userMessageId, (thought) => ({
            ...thought,
            isOpen: true,
            openStepId: null,
            status: "running",
          }))
        )
      }
    })

    stream.addEventListener("context", (streamEvent) => {
      const payload = parseStreamPayload<{ summary?: string }>(streamEvent)
      if (!payload) return

      setAssistantThoughtsByThread((current) =>
        updateThreadThoughtRun(current, threadId, runId, userMessageId, (thought) =>
          upsertThoughtStep(
            thought,
            {
              id: `context-${payload.summary ?? thought.steps.length}`,
              type: "context",
              status: "completed",
              name: "Context",
              payload: stringifyStreamPayload(payload),
            },
            { status: "running" }
          )
        )
      )
    })

    stream.addEventListener("tool_start", (streamEvent) => {
      const payload = parseStreamPayload<{
        runId?: string
        name?: string
        input?: unknown
      }>(streamEvent)
      if (!payload) return

      setAssistantThoughtsByThread((current) =>
        updateThreadThoughtRun(current, threadId, runId, userMessageId, (thought) => {
          const stepId = payload.runId ?? `${payload.name ?? "tool"}-${thought.steps.length}`

          return upsertThoughtStep(
            thought,
            {
              id: stepId,
              type: "tool",
              status: "running",
              name: payload.name ?? "tool",
              input: stringifyStreamPayload(payload.input),
            },
            {
              isOpen: true,
              openStepId: stepId,
              status: "running",
            }
          )
        })
      )
    })

    stream.addEventListener("tool_end", (streamEvent) => {
      const payload = parseStreamPayload<{
        runId?: string
        output?: unknown
      }>(streamEvent)
      if (!payload) return

      setAssistantThoughtsByThread((current) =>
        updateThreadThoughtRun(current, threadId, runId, userMessageId, (thought) => {
          const existingStep =
            (payload.runId ? thought.steps.find((step) => step.id === payload.runId) : null) ?? null
          const stepId = payload.runId ?? existingStep?.id ?? `tool-${thought.steps.length}`

          return upsertThoughtStep(
            thought,
            {
              id: stepId,
              type: "tool",
              status: "completed",
              name: existingStep?.name ?? "tool",
              input: existingStep?.input,
              output: stringifyStreamPayload(payload.output),
            },
            {
              isOpen: true,
              openStepId: thought.openStepId === stepId ? stepId : thought.openStepId,
              status: "running",
            }
          )
        })
      )
    })

    stream.addEventListener("run_completed", (streamEvent) => {
      const payload = parseStreamPayload<{
        id?: string
        status?: string
        model?: string
        totalTokens?: number
        costUsd?: number
      }>(streamEvent)

      stream.close()
      if (agentEventSourceRef.current === stream) {
        agentEventSourceRef.current = null
      }
      setIsAgentSending(false)
      setAgentDraft("")
      setAssistantThoughtsByThread((current) =>
        updateThreadThoughtRun(current, threadId, runId, userMessageId, (thought) =>
          upsertThoughtStep(
            thought,
            {
              id: "run_completed",
              type: "run_completed",
              status: "completed",
              payload: stringifyStreamPayload(payload),
            },
            {
              isOpen: false,
              openStepId: null,
              status: "completed",
            }
          )
        )
      )
      scrollAssistantToBottom()
      void queryClient.invalidateQueries({ queryKey: ["agent-thread", threadId] })
      void queryClient.invalidateQueries({ queryKey: ["agent-threads", selectedProjectId ?? "global"] })
      if (selectedProjectId) {
        void refresh(selectedProjectId)
      }
    })

    stream.addEventListener("error", (streamEvent) => {
      const payload = "data" in streamEvent
        ? parseStreamPayload<{ message?: string }>(streamEvent as MessageEvent)
        : null
      stream.close()
      if (agentEventSourceRef.current === stream) {
        agentEventSourceRef.current = null
      }
      setIsAgentSending(false)
      setAgentDraft("")
      setAgentError(payload?.message ?? "Assistant stream failed")
      scrollAssistantToBottom()
      setAssistantThoughtsByThread((current) =>
        updateThreadThoughtRun(current, threadId, runId, userMessageId, (thought) => ({
          ...thought,
          isOpen: true,
          openStepId: null,
          status: "error",
        }))
      )
    })
  }, [appendAgentMessageToCache, queryClient, refresh, scrollAssistantToBottom, selectedProjectId])

  useEffect(() => {
    if (!selectedAgentThreadId || !agentThreadQuery.data?.runs) {
      return
    }

    const runs = agentThreadQuery.data.runs
    const activeRun = runs.find((run) => run.status === "running") ?? null

    setAssistantThoughtsByThread((current) => ({
      ...current,
      [selectedAgentThreadId]: thoughtRunsFromAgentRuns(runs),
    }))

    if (!agentEventSourceRef.current) {
      setAgentDraft(draftFromRun(activeRun))
    }

    setIsAgentSending(Boolean(activeRun && mainView === "agents"))
  }, [agentThreadQuery.data?.runs, mainView, selectedAgentThreadId])

  useEffect(() => {
    if (mainView !== "agents" || !selectedAgentThreadId || agentEventSourceRef.current) {
      return
    }

    const activeRun = agentThreadQuery.data?.runs.find((run) => run.status === "running" && run.streamUrl)
    if (!activeRun?.streamUrl) {
      return
    }

    connectAgentRunStream({
      runId: activeRun.id,
      streamUrl: activeRun.streamUrl,
      threadId: selectedAgentThreadId,
      userMessageId: activeRun.userMessageId,
    })
  }, [agentThreadQuery.data?.runs, connectAgentRunStream, mainView, selectedAgentThreadId])

  async function handleAgentSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const content = agentInput.trim()

    if (!content || isAgentSending) {
      return
    }

    setIsAgentSending(true)
    setAgentInput("")
    setAgentDraft("")
    setAgentError(null)
    agentEventSourceRef.current?.close()

    try {
      let threadId = selectedAgentThreadId
      const threadTitle = deriveAssistantThreadTitle(content)

      if (!threadId) {
        threadId = await ensureAgentThread(threadTitle)
        scrollAssistantToBottom()
      }

      const attachmentIds = agentPendingAttachments.map((attachment) => attachment.id)
      const response = await sendAgentMessage(threadId, content, selectedAssistantRole, attachmentIds, threadTitle)
      const assistantRunId = response.run.id
      const userMessageId = response.userMessage.id

      setAgentPendingAttachments([])
      appendAgentMessageToCache(threadId, response.userMessage)
      queryClient.setQueryData<{ items: AgentThread[] } | undefined>(
        ["agent-threads", selectedProjectId ?? "global"],
        (current) => current
          ? {
              items: current.items.map((thread) =>
                thread.id === threadId && !thread.title ? { ...thread, title: threadTitle } : thread
              ),
            }
          : current
      )
      queryClient.setQueryData<AgentThreadHistory | undefined>(["agent-thread", threadId], (current) =>
        current
          ? {
              ...current,
              thread: !current.thread.title ? { ...current.thread, title: threadTitle } : current.thread,
              runs: [
                ...(current.runs ?? []),
                {
                  id: assistantRunId,
                  status: "running",
                  userMessageId,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  completedAt: null,
                  events: [{
                    event: "run_started",
                    data: { runId: assistantRunId, threadId, userMessageId },
                    createdAt: new Date().toISOString(),
                  }],
                  streamUrl: response.streamUrl,
                },
              ],
            }
          : current
      )
      scrollAssistantToBottom()
      setAssistantThoughtsByThread((current) =>
        updateThreadThoughtRun(current, threadId!, assistantRunId, userMessageId, (thought) => ({
          ...thought,
          status: "running",
          isOpen: true,
        }))
      )

      connectAgentRunStream({
        runId: assistantRunId,
        streamUrl: response.streamUrl,
        threadId,
        userMessageId,
      })
    } catch (error) {
      setIsAgentSending(false)
      setAgentDraft("")
      setAgentError(error instanceof Error ? error.message : "Assistant request failed")
    }
  }

  async function handleCreateProject() {
    if (!canLeaveDrawing()) {
      return
    }

    const name = window.prompt("Project name")

    if (!name?.trim()) {
      return
    }

    const owner = window.prompt("Owner") ?? ""

    await run("create-project", async () => {
      const created = await createProject({
        name: name.trim(),
        owner: owner.trim(),
        status: "active",
      })
      setSelectedProjectId(created.id)
      setSelectedDocId(null)
      setSelectedArtifactPath(null)
      setSelectedPlanItemPath(null)
      setUnsavedDrawingPath(null)
      setSelectedDocFilePath(null)
      setMainView("activity")
      setPlaceholderTitle("")
      isLoadingOlderRef.current = false
      setIsLoadingOlderActivity(false)
      await refresh(created.id)
    })
  }

  function handleSelectProject(projectId: string) {
    guardedNavigation(() => {
      setSelectedProjectId(projectId)
      setSelectedDocId(null)
      setSelectedArtifactPath(null)
      setSelectedGeneratedPath(null)
      setSelectedPlanItemPath(null)
      setSelectedDocFilePath(null)
      setMainView("activity")
      setPlaceholderTitle("")
      isLoadingOlderRef.current = false
      setIsLoadingOlderActivity(false)
    })
  }

  function handleSelectDoc(docId: string) {
    guardedNavigation(() => {
      setSelectedDocId(docId)
      setSelectedProjectId(null)
      setSelectedArtifactPath(null)
      setSelectedGeneratedPath(null)
      setSelectedPlanItemPath(null)
      setSelectedDocFilePath(null)
      setPlaceholderTitle("")
      setMainView("docs")
    })
  }

  async function handleLogSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedProjectId || !logContent.trim()) {
      return
    }

    await run("log", async () => {
      await addLog(selectedProjectId, {
        author: currentAuthor,
        content: logContent,
      })
      setLogContent("")
      setSelectedArtifactPath(null)
      setSelectedPlanItemPath(null)
      setMainView("activity")
      await refresh(selectedProjectId)
    })
  }

  async function handleConfigSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedProjectId || !configName.trim()) {
      return
    }

    const projectId = selectedProjectId
    const nextName = configName.trim()
    const shouldRenameProject = !project || nextName !== project.name

    await run("config", async () => {
      const updated = await updateProject(projectId, {
        ...(shouldRenameProject ? { name: nextName } : {}),
        owner: configOwner.trim(),
        status: configStatus.trim() || "active",
        tags: configTags.split(",").map((item) => item.trim()).filter(Boolean),
      })
      queryClient.setQueryData<ProjectDetails>(["project", updated.id], updated)
      queryClient.setQueryData<{ items: ProjectSummary[] }>(["projects"], (current) => {
        if (!current) {
          return current
        }

        const items = current.items.filter((item) => item.id !== projectId && item.id !== updated.id)

        return { items: [updated, ...items] }
      })
      if (updated.id !== projectId) {
        setSelectedProjectId(updated.id)
      }
      await refresh(updated.id)
    })
  }

  async function handleGitAction(action: "pull" | "push") {
    setBusyAction(`git-${action}`)
    setMessage(null)

    try {
      const result = action === "pull" ? await gitPull() : await gitPush()
      setGitResult(result)
      setMessage({ type: result.ok ? "ok" : "error", text: result.summary })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project"] }),
        queryClient.invalidateQueries({ queryKey: ["docs"] }),
      ])
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Request failed",
      })
    } finally {
      setBusyAction(null)
    }
  }

  async function handleSavePlanningGantt(data: Pick<PlanningGanttData, "tasks" | "links">) {
    await run("planning-gantt", async () => {
      const saved = await updatePlanningGantt(data)
      queryClient.setQueryData(["planning-gantt"], saved)
      await queryClient.invalidateQueries({ queryKey: ["system-log"] })
    })
  }

  function handleLogKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault()
      event.currentTarget.form?.requestSubmit()
    }
  }

  async function handleLoadOlderActivity() {
    const activity = projectQuery.data?.activity

    if (!selectedProjectId || !activity?.hasOlder || !activity.oldestFile || isLoadingOlderActivity) {
      return
    }

    setIsLoadingOlderActivity(true)
    isLoadingOlderRef.current = true

    try {
      const older = await getProjectActivity(selectedProjectId, {
        before: activity.oldestFile,
        files: 1,
      })

      queryClient.setQueryData<ProjectDetails>(["project", selectedProjectId], (current) => {
        if (!current) {
          return current
        }

        return {
          ...current,
          activity: {
            ...current.activity,
            files: [...older.files, ...current.activity.files],
            oldestFile: older.oldestFile ?? current.activity.oldestFile,
            hasOlder: older.hasOlder,
            entries: [...older.entries, ...current.activity.entries],
          },
        }
      })

      if (older.entries.length === 0) {
        isLoadingOlderRef.current = false
      }
    } catch (error) {
      isLoadingOlderRef.current = false
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "Request failed",
      })
    } finally {
      setIsLoadingOlderActivity(false)
    }
  }

  function handleArtifactFileChange(event: ChangeEvent<HTMLInputElement>) {
    setArtifactFile(event.target.files?.[0] ?? null)
  }

  function resetArtifactDialog() {
    setArtifactFile(null)
    setArtifactTextTitle("")
    setArtifactTextContent("")
  }

  function resetPlanItemDialog() {
    setPlanItemTitle("")
    setPlanItemOwner("")
    setPlanItemDeadline("")
    setPlanItemBody("")
  }

  async function handleArtifactSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedProjectId) {
      return
    }

    await run("artifact", async () => {
      if (artifactFile) {
        await uploadArtifact(selectedProjectId, artifactFile, currentAuthor)
      }

      if (artifactTextContent.trim()) {
        await addTextArtifact(selectedProjectId, {
          title: artifactTextTitle.trim() || "Note",
          content: artifactTextContent,
          author: currentAuthor,
        })
      }

      resetArtifactDialog()
      setArtifactDialogOpen(false)
      setSelectedArtifactPath(null)
      setSelectedPlanItemPath(null)
      setPlaceholderTitle("")
      setMainView("artifacts")
      await refresh(selectedProjectId)
      await queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, ARTIFACT_INDEX_PATH] })
    })
  }

  function handleRequestCreateDrawing() {
    if (!selectedProjectId || !canLeaveDrawing()) {
      return
    }

    setDrawingDialogTitle("Drawing")
    setDrawingDialogMode("create")
  }

  function handleRequestRenameDrawing() {
    if (!selectedArtifact || !isExcalidrawFile(selectedArtifact.name)) {
      return
    }

    setDrawingDialogTitle(drawingStatus?.title || displayFileTitle(selectedArtifact))
    setDrawingDialogMode("rename")
  }

  async function handleDrawingDialogSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedProjectId || !drawingDialogMode) {
      return
    }

    const title = drawingDialogTitle.trim() || "Drawing"

    if (drawingDialogMode === "rename") {
      const actions = drawingActionsRef.current
      if (!actions) {
        return
      }

      await actions.rename(title)
      setDrawingDialogMode(null)
      return
    }

    let createdPath: string | null = null
    await run("excalidraw-create", async () => {
      const created = await addExcalidrawArtifact(selectedProjectId, {
        title,
        author: currentAuthor,
      })
      createdPath = created.path
      setSelectedArtifactPath(created.path)
      setSelectedGeneratedPath(null)
      setSelectedPlanItemPath(null)
      setUnsavedDrawingPath(null)
      setPlaceholderTitle("")
      setMainView("artifact")
      await refresh(selectedProjectId)
      await queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, ARTIFACT_INDEX_PATH] })
    })

    if (createdPath) {
      await queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, createdPath] })
    }

    setDrawingDialogMode(null)
  }

  async function handlePlanItemSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedProjectId) {
      return
    }

    await run("plan-item", async () => {
      await createPlanItem(selectedProjectId, {
        title: planItemTitle.trim(),
        owner: planItemOwner.trim(),
        deadline: planItemDeadline,
        body: planItemBody,
        createdBy: currentAuthor,
      })

      resetPlanItemDialog()
      setPlanItemDialogOpen(false)
      setSelectedArtifactPath(null)
      setSelectedPlanItemPath(null)
      setPlaceholderTitle("")
      setMainView("plan")
      await refresh(selectedProjectId)
      await queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, PLAN_INDEX_PATH] })
    })
  }

  const canWrite = Boolean(selectedProjectId) && !busyAction
  const entries = projectQuery.data?.activity?.entries ?? []
  const assistantRoles = assistantRolesQuery.data?.items ?? []
  const workflows = workflowsQuery.data?.items ?? []
  const pendingWorkflow = workflows.find((workflow) => workflow.id === pendingWorkflowId) ?? null
  const busyWorkflowId = busyAction?.startsWith("workflow:") ? busyAction.slice("workflow:".length) : null
  const agentThreads = agentThreadsQuery.data?.items ?? []
  const agentMessages = agentThreadQuery.data?.messages ?? []
  const selectedAssistantThoughts = selectedAgentThreadId
    ? assistantThoughtsByThread[selectedAgentThreadId] ?? []
    : []
  const artifacts = projectQuery.data?.files.artifacts ?? EMPTY_FILES
  const generated = projectQuery.data?.files.generated ?? EMPTY_FILES
  const planItems = projectQuery.data?.files.plan ?? EMPTY_FILES
  const markdownCommandFiles = useMemo(() => {
    const seen = new Set<string>()

    return [...artifacts, ...generated, ...planItems].filter((file) => {
      if (seen.has(file.path)) return false
      seen.add(file.path)
      return true
    })
  }, [artifacts, generated, planItems])
  const closeLogFileMenu = useCallback(() => {
    setLogFileMenu((current) =>
      current.open ? { ...current, open: false } : current
    )
  }, [])
  const syncLogFileMenu = useCallback((element: HTMLTextAreaElement, value = element.value) => {
    const token = fileMentionTokenAt(value, element.selectionStart)

    if (!token) {
      closeLogFileMenu()
      return
    }

    setLogFileMenu({
      activeIndex: 0,
      open: true,
      query: token.query,
    })
  }, [closeLogFileMenu])
  const insertLogFileMention = useCallback((file: ProjectFile) => {
    const element = logTextareaRef.current
    const currentValue = element?.value ?? logContent
    const cursor = element?.selectionStart ?? currentValue.length
    const token = fileMentionTokenAt(currentValue, cursor)
    const markdown = fileMarkdown(file, { embedImages: false })
    const nextValue = token
      ? `${currentValue.slice(0, token.start)}${markdown}${currentValue.slice(token.end)}`
      : `${currentValue}${markdown}`
    const nextCursor = token ? token.start + markdown.length : nextValue.length

    setLogContent(nextValue)
    closeLogFileMenu()
    window.requestAnimationFrame(() => {
      const nextElement = logTextareaRef.current
      if (!nextElement) return

      nextElement.focus()
      nextElement.setSelectionRange(nextCursor, nextCursor)
    })
  }, [closeLogFileMenu, logContent])
  const filteredLogFileItems = useMemo(() => {
    const query = logFileMenu.query.trim().toLowerCase()
    const items = markdownCommandFiles.map<CommandMenuItem>((file) => ({
      group: "files",
      groupLabel: "Files",
      icon: fileCommandIcon(file),
      id: `file:${file.path}`,
      label: file.title?.trim() || file.name,
      onRun: () => insertLogFileMention(file),
      subtitle: file.path,
    }))

    if (!query) return items

    return items.filter((item) =>
      `${item.label} ${item.subtitle ?? ""}`.toLowerCase().includes(query)
    )
  }, [insertLogFileMention, logFileMenu.query, markdownCommandFiles])
  const logFileMenuGroups = useMemo(
    () => groupCommandMenuItems(filteredLogFileItems),
    [filteredLogFileItems]
  )

  function handleLogContentChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setLogContent(event.target.value)
    syncLogFileMenu(event.target)
  }

  function handleLogContentKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (logFileMenu.open) {
      if (event.key === "Escape") {
        event.preventDefault()
        closeLogFileMenu()
        return
      }

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const delta = event.key === "ArrowDown" ? 1 : -1
        const itemCount = filteredLogFileItems.length

        setLogFileMenu((current) => ({
          ...current,
          activeIndex:
            itemCount === 0
              ? 0
              : (current.activeIndex + delta + itemCount) % itemCount,
        }))
        return
      }

      if (event.key === "Enter") {
        event.preventDefault()
        filteredLogFileItems[logFileMenu.activeIndex]?.onRun()
        return
      }
    }

    handleLogKeyDown(event)
  }

  function handleOpenProjectFileLink(path: string) {
    const normalized = markdownProjectFilePath(path) ?? path

    if (normalized.startsWith("artifacts/")) {
      guardedNavigation(() => {
        setSelectedArtifactPath(normalized)
        setSelectedGeneratedPath(null)
        setSelectedPlanItemPath(null)
        setPlaceholderTitle("")
        setMainView("artifact")
      }, { artifactPath: normalized, mainView: "artifact" })
      return
    }

    if (normalized.startsWith("generated/")) {
      guardedNavigation(() => {
        setSelectedArtifactPath(null)
        setSelectedGeneratedPath(normalized)
        setSelectedPlanItemPath(null)
        setPlaceholderTitle("")
        setMainView("generated-file")
      }, { generatedPath: normalized, mainView: "generated-file" })
      return
    }

    if (normalized.startsWith("plan/")) {
      guardedNavigation(() => {
        setSelectedArtifactPath(null)
        setSelectedGeneratedPath(null)
        setSelectedPlanItemPath(normalized)
        setPlaceholderTitle("")
        setMainView("plan-item")
      }, { mainView: "plan-item", planItemPath: normalized })
    }
  }

  const myItemGroups = myItemsQuery.data?.items ?? []
  const docFiles = docsFolder?.files ?? EMPTY_FILES
  const selectedArtifact = artifacts.find((file) => file.path === selectedArtifactPath) ?? null
  const selectedGenerated = generated.find((file) => file.path === selectedGeneratedPath) ?? null
  const selectedPlanItem = planItems.find((file) => file.path === selectedPlanItemPath) ?? null
  const selectedDocFile = docFiles.find((file) => file.path === selectedDocFilePath) ?? null
  const selectedArtifactIsExcalidraw = Boolean(selectedArtifact && isExcalidrawFile(selectedArtifact.name))
  const markdownHeaderStatus =
    markdownStatus &&
    (
      (mainView === "artifact" && selectedArtifact && isMarkdownFile(selectedArtifact.name) && markdownStatus.title === selectedArtifact.name) ||
      (mainView === "generated-file" && selectedGenerated && isMarkdownFile(selectedGenerated.name) && markdownStatus.title === selectedGenerated.name) ||
      (mainView === "plan-item" && selectedPlanItem && isMarkdownFile(selectedPlanItem.name) && markdownStatus.title === selectedPlanItem.name)
    )
      ? markdownStatus
      : null
  const drawingFullscreenActive = selectedArtifactIsExcalidraw && drawingFullscreen
  const planningFullscreenActive = mainView === "planning" && planningFullscreen
  const immersiveViewActive = drawingFullscreenActive || planningFullscreenActive
  const isGlobalView = ["docs", "git", "my-items", "planning", "readme", "system-log"].includes(mainView) || (mainView === "agents" && !selectedProjectId)
  const isActivityLogView = mainView === "activity" && !selectedArtifact && !selectedPlanItem
  const artifactQuery = useQuery({
    queryKey: ["project-file", selectedProjectId, selectedArtifactPath],
    queryFn: () => readFile(selectedProjectId!, selectedArtifactPath!),
    enabled: Boolean(
      selectedProjectId &&
        selectedArtifactPath &&
        selectedArtifact &&
        (isTextFile(selectedArtifact.name) || isExcalidrawFile(selectedArtifact.name))
    ),
  })
  const planItemQuery = useQuery({
    queryKey: ["project-file", selectedProjectId, selectedPlanItemPath],
    queryFn: () => readFile(selectedProjectId!, selectedPlanItemPath!),
    enabled: Boolean(
      selectedProjectId &&
        selectedPlanItemPath &&
      selectedPlanItem &&
        isTextFile(selectedPlanItem.name)
    ),
  })
  const generatedQuery = useQuery({
    queryKey: ["project-file", selectedProjectId, selectedGeneratedPath],
    queryFn: () => readFile(selectedProjectId!, selectedGeneratedPath!),
    enabled: Boolean(
      selectedProjectId &&
        selectedGeneratedPath &&
        selectedGenerated &&
        isTextFile(selectedGenerated.name)
    ),
  })
  const planItemIndexQuery = useQuery({
    queryKey: ["project-file", selectedProjectId, PLAN_INDEX_PATH],
    queryFn: () => readFile(selectedProjectId!, PLAN_INDEX_PATH),
    enabled: Boolean(selectedProjectId && mainView === "plan"),
  })
  const artifactIndexQuery = useQuery({
    queryKey: ["project-file", selectedProjectId, ARTIFACT_INDEX_PATH],
    queryFn: () => readFile(selectedProjectId!, ARTIFACT_INDEX_PATH),
    enabled: Boolean(selectedProjectId && mainView === "artifacts"),
  })
  const docFileQuery = useQuery({
    queryKey: ["docs-file", selectedDocId, selectedDocFilePath],
    queryFn: () => readDocsFile(selectedDocId!, selectedDocFilePath!),
    enabled: Boolean(
      selectedDocId &&
        selectedDocFilePath &&
        selectedDocFile &&
        isTextFile(selectedDocFile.name)
    ),
  })

  useEffect(() => {
    if (selectedArtifactIsExcalidraw) {
      return
    }

    drawingActionsRef.current = null
    setDrawingFullscreen(false)
    setDrawingStatus(null)
  }, [selectedArtifactIsExcalidraw])

  useEffect(() => {
    if (mainView === "planning") {
      return
    }

    planningActionsRef.current = null
    setPlanningFullscreen(false)
    setPlanningStatus(null)
  }, [mainView])

  async function handleSaveDrawing() {
    await drawingActionsRef.current?.save()
  }

  async function handleDeleteArtifact(path: string) {
    if (!selectedProjectId || !window.confirm("Delete artifact?")) {
      return
    }

    await run("artifact-delete", async () => {
      await deleteArtifact(selectedProjectId, path)
      if (selectedArtifactPath === path) {
        setSelectedArtifactPath(null)
        setUnsavedDrawingPath(null)
        setSelectedPlanItemPath(null)
        setMainView("artifacts")
      }
      await Promise.all([
        refresh(selectedProjectId),
        queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, ARTIFACT_INDEX_PATH] }),
      ])
    })
  }

  async function handleDeletePlanItem(path: string) {
    if (!selectedProjectId || !window.confirm("Delete plan item?")) {
      return
    }

    await run("planItem-delete", async () => {
      await deletePlanItem(selectedProjectId, path)
      if (selectedPlanItemPath === path) {
        setSelectedPlanItemPath(null)
        setSelectedArtifactPath(null)
        setMainView("plan")
      }
      await Promise.all([
        refresh(selectedProjectId),
        queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, PLAN_INDEX_PATH] }),
      ])
    })
  }

  async function handleSaveMarkdownArtifact(path: string, content: string) {
    if (!selectedProjectId) {
      return content
    }

    let savedContent = content
    await run(
      "artifact-content",
      async () => {
        const saved = await updateArtifactContent(selectedProjectId, path, content, currentAuthor)
        savedContent = saved.content
        queryClient.setQueryData(["project-file", selectedProjectId, path], saved.content)
        await Promise.all([
          refresh(selectedProjectId),
          queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, path] }),
          queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, ARTIFACT_INDEX_PATH] }),
        ])
      },
      { throwOnError: true }
    )

    return savedContent
  }

  async function handleSaveExcalidrawArtifact(path: string, content: string, title?: string) {
    if (!selectedProjectId) {
      return content
    }

    let savedContent = content
    await run(
      "excalidraw-content",
      async () => {
        const saved = await updateExcalidrawArtifact(selectedProjectId, path, content, currentAuthor, title)
        savedContent = saved.content
        setUnsavedDrawingPath(null)
        queryClient.setQueryData(["project-file", selectedProjectId, path], saved.content)
        await Promise.all([
          refresh(selectedProjectId),
          queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, path] }),
          queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, ARTIFACT_INDEX_PATH] }),
        ])
      },
      { throwOnError: true }
    )

    return savedContent
  }

  async function handleSaveMarkdownGenerated(path: string, content: string) {
    if (!selectedProjectId) {
      return content
    }

    let savedContent = content
    await run(
      "generated-content",
      async () => {
        const saved = await updateGeneratedContent(selectedProjectId, path, content, currentAuthor)
        savedContent = saved.content
        queryClient.setQueryData(["project-file", selectedProjectId, path], saved.content)
        await Promise.all([
          refresh(selectedProjectId),
          queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, path] }),
        ])
      },
      { throwOnError: true }
    )

    return savedContent
  }

  async function handleSaveMarkdownPlanItem(path: string, content: string) {
    if (!selectedProjectId) {
      return content
    }

    let savedContent = content
    await run(
      "planItem-content",
      async () => {
        const saved = await updatePlanItemContent(selectedProjectId, path, content, currentAuthor)
        savedContent = saved.content
        queryClient.setQueryData(["project-file", selectedProjectId, path], saved.content)
        await Promise.all([
          refresh(selectedProjectId),
          queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, path] }),
          queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, PLAN_INDEX_PATH] }),
        ])
      },
      { throwOnError: true }
    )

    return savedContent
  }

  async function handleSaveArtifactIndex(items: FileIndexItem[]) {
    if (!selectedProjectId) {
      return
    }

    await run(
      "artifact-index",
      async () => {
        const saved = await updateArtifactIndex(selectedProjectId, items)
        queryClient.setQueryData(["project-file", selectedProjectId, ARTIFACT_INDEX_PATH], saved.content)
        await Promise.all([
          refresh(selectedProjectId),
          queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, ARTIFACT_INDEX_PATH] }),
        ])
      },
      { throwOnError: true }
    )
  }

  async function handleSavePlanIndex(items: FileIndexItem[]) {
    if (!selectedProjectId) {
      return
    }

    await run(
      "planItem-index",
      async () => {
        const saved = await updatePlanIndex(
          selectedProjectId,
          items.map((item) => ({
            path: item.path,
            done: Boolean(item.done),
            title: item.title,
            owner: item.owner,
            deadline: item.deadline,
          }))
        )
        queryClient.setQueryData(["project-file", selectedProjectId, PLAN_INDEX_PATH], saved.content)
        await Promise.all([
          refresh(selectedProjectId),
          queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId, PLAN_INDEX_PATH] }),
        ])
      },
      { throwOnError: true }
    )
  }

  function handleOpenMyPlanItem(item: MyPlanItem) {
    guardedNavigation(() => {
      setSelectedDocId(null)
      setSelectedProjectId(item.projectId)
      setSelectedArtifactPath(null)
      setSelectedGeneratedPath(null)
      setSelectedPlanItemPath(item.path)
      setSelectedDocFilePath(null)
      setPlaceholderTitle("")
      setMainView("plan-item")
    })
  }

  async function handleToggleMyPlanItem(item: MyPlanItem, done: boolean) {
    await run("my-plan-item", async () => {
      const saved = await togglePlanItem(item.projectId, item.path, done)
      queryClient.setQueryData(["project-file", item.projectId, PLAN_INDEX_PATH], saved.content)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["my-plan-items"] }),
        refresh(item.projectId),
        queryClient.invalidateQueries({ queryKey: ["project-file", item.projectId, PLAN_INDEX_PATH] }),
      ])
    })
  }

  async function handleRunWorkflow(workflowId: string) {
    if (!selectedProjectId) {
      return
    }

    setPendingWorkflowId(null)
    await run(
      `workflow:${workflowId}`,
      async () => {
        await runWorkflow(workflowId, selectedProjectId)
        await Promise.all([
          refresh(selectedProjectId),
          queryClient.invalidateQueries({ queryKey: ["workflows", selectedProjectId] }),
          queryClient.invalidateQueries({ queryKey: ["project-file", selectedProjectId] }),
        ])
      },
      { successMessage: "Workflow completed" }
    )
  }

  useEffect(() => {
    if (mainView !== "activity") {
      return
    }

    if (isLoadingOlderRef.current) {
      isLoadingOlderRef.current = false
      return
    }

    activityBottomRef.current?.scrollIntoView({ block: "end" })
  }, [entries.length, mainView, selectedProjectId])

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      {message ? (
        <div
          className="pointer-events-none fixed inset-x-0 top-4 z-50 flex justify-center px-4"
        >
          <div
            role="status"
            className={cn(
              "pointer-events-auto flex min-h-11 min-w-0 max-w-xl items-center rounded-md border px-4 py-2.5 shadow-lg",
              message.type === "ok"
                ? "border-emerald-500/40 bg-emerald-600 text-white"
                : "border-destructive/40 bg-destructive text-white"
            )}
          >
            <span className="truncate text-sm font-medium">{message.text}</span>
          </div>
        </div>
      ) : null}

      <McpTokensDialog open={mcpTokensOpen} onOpenChange={setMcpTokensOpen} />

      <SidebarProvider className="min-h-0 flex-1 overflow-hidden">
        {immersiveViewActive ? null : (
        <AppSidebar
          activeView={
            mainView === "generated-file" || (mainView === "placeholder" && placeholderTitle === "generated")
            ? "generated"
            : mainView === "plan-item"
              ? "plan"
              : mainView
          }
          projects={projects}
          docs={docs}
          isLoading={projectsQuery.isLoading}
          isDocsLoading={docsQuery.isLoading}
          isCreateDisabled={Boolean(busyAction)}
          onLogout={currentUser.authMode === "none" ? undefined : onLogout}
          onCreateThread={handleCreateProject}
          onDocSelect={handleSelectDoc}
          onOpenMyItems={() => {
            guardedNavigation(() => {
              setSelectedDocId(null)
              setSelectedProjectId(null)
              setSelectedArtifactPath(null)
              setSelectedGeneratedPath(null)
              setSelectedPlanItemPath(null)
              setSelectedDocFilePath(null)
              setPlaceholderTitle("")
              setMainView("my-items")
            })
          }}
          onOpenPlanning={() => {
            guardedNavigation(() => {
              setSelectedDocId(null)
              setSelectedProjectId(null)
              setSelectedArtifactPath(null)
              setSelectedGeneratedPath(null)
              setSelectedPlanItemPath(null)
              setSelectedDocFilePath(null)
              setPlaceholderTitle("")
              setMainView("planning")
            })
          }}
          onOpenGit={() => {
            guardedNavigation(() => {
              setSelectedDocId(null)
              setSelectedProjectId(null)
              setSelectedArtifactPath(null)
              setSelectedGeneratedPath(null)
              setSelectedPlanItemPath(null)
              setSelectedDocFilePath(null)
              setPlaceholderTitle("")
              setMainView("git")
            })
          }}
          onOpenSystemLog={() => {
            guardedNavigation(() => {
              setSelectedDocId(null)
              setSelectedProjectId(null)
              setSelectedArtifactPath(null)
              setSelectedGeneratedPath(null)
              setSelectedPlanItemPath(null)
              setSelectedDocFilePath(null)
              setPlaceholderTitle("")
              setMainView("system-log")
            })
          }}
          onOpenMcpTokens={currentUser.authMode === "none" ? undefined : () => setMcpTokensOpen(true)}
          onOpenReadme={() => {
            guardedNavigation(() => {
              setSelectedDocId(null)
              setSelectedProjectId(null)
              setSelectedArtifactPath(null)
              setSelectedGeneratedPath(null)
              setSelectedPlanItemPath(null)
              setSelectedDocFilePath(null)
              setPlaceholderTitle("")
              setMainView("readme")
            })
          }}
          onThreadSelect={handleSelectProject}
          selectedDocId={selectedDocId}
          selectedThreadId={isGlobalView ? null : selectedProjectId}
          user={{
            name: currentUser.name || currentUser.email || currentUser.username,
            email: currentUser.authMode === "none" ? "auth disabled" : currentUser.email,
            avatar: "",
          }}
        />
        )}
        {immersiveViewActive ? null : <SidebarRail />}
        <SidebarInset className={cn(
          "flex min-h-0 overflow-hidden bg-background",
          immersiveViewActive ? "rounded-none border-0 shadow-none" : "rounded-[28px] border border-border/60 shadow-sm"
        )}>
          <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-background px-3 md:px-4">
            {immersiveViewActive ? null : <SidebarTrigger />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[15px] font-semibold text-foreground">
                {selectedArtifactIsExcalidraw && selectedArtifact
                  ? drawingStatus?.title || displayFileTitle(selectedArtifact)
                  : markdownHeaderStatus
                    ? markdownHeaderStatus.title
                  : mainView === "docs" && docsFolder
                  ? `Docs - ${docsFolder.name}`
                  : mainView === "agents"
                    ? "Assistant"
                  : mainView === "git"
                    ? "Git"
                    : mainView === "system-log"
                      ? "System Log"
                    : mainView === "my-items"
                      ? "My items"
                    : mainView === "planning"
                      ? "Planning"
                    : mainView === "readme"
                      ? "Readme"
                    : project
                    ? `${project.name}${project.owner ? ` - ${project.owner}` : ""}${project.status ? ` (${project.status})` : ""}`
                    : "Devsync"}
              </div>
            </div>
            {selectedArtifactIsExcalidraw && selectedArtifact ? (
              <div className="flex shrink-0 items-center gap-2">
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {drawingStatus?.dirty ? "Unsaved" : "Saved"}
                </span>
                <Button
                  disabled={!drawingStatus?.dirty || busyAction === "excalidraw-content" || !drawingStatus?.canSave}
                  onClick={() => void handleSaveDrawing()}
                  title="Save drawing"
                  type="button"
                >
                  <HugeiconsIcon icon={FloppyDiskIcon} strokeWidth={2} />
                  Save
                </Button>
                <Button
                  disabled={busyAction === "excalidraw-content" || !drawingStatus?.canSave}
                  onClick={handleRequestRenameDrawing}
                  title="Rename drawing"
                  type="button"
                  variant="outline"
                >
                  <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
                  Rename
                </Button>
                <Button
                  onClick={() => setDrawingFullscreen((current) => !current)}
                  size="icon"
                  title={drawingFullscreenActive ? "Exit fullscreen" : "Fullscreen"}
                  type="button"
                  variant="outline"
                >
                  <HugeiconsIcon icon={drawingFullscreenActive ? MinimizeScreenIcon : FullScreenIcon} strokeWidth={2} />
                </Button>
                <Button
                  disabled={busyAction === "artifact-delete"}
                  onClick={() => handleDeleteArtifact(selectedArtifact.path)}
                  size="icon"
                  title="Delete drawing"
                  type="button"
                  variant="destructive"
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
              </div>
            ) : markdownHeaderStatus ? (
              <div className="flex shrink-0 items-center gap-2">
                <span className="hidden text-xs text-muted-foreground lg:inline">
                  {markdownHeaderStatus.dirty ? "Unsaved" : "Saved"}
                </span>
                <div className="flex items-center rounded-md bg-muted p-0.5">
                  <Button
                    aria-pressed={markdownHeaderStatus.mode === "rich"}
                    className={cn(markdownHeaderStatus.mode === "rich" && "bg-background shadow-sm")}
                    disabled={markdownHeaderStatus.saving}
                    onClick={() => markdownActionsRef.current?.setMode("rich")}
                    size="sm"
                    title="Rich editor"
                    type="button"
                    variant="ghost"
                  >
                    <HugeiconsIcon icon={TextBoldIcon} strokeWidth={2} />
                    Rich
                  </Button>
                  <Button
                    aria-pressed={markdownHeaderStatus.mode === "source"}
                    className={cn(markdownHeaderStatus.mode === "source" && "bg-background shadow-sm")}
                    disabled={markdownHeaderStatus.saving}
                    onClick={() => markdownActionsRef.current?.setMode("source")}
                    size="sm"
                    title="Markdown source"
                    type="button"
                    variant="ghost"
                  >
                    <HugeiconsIcon icon={SourceCodeIcon} strokeWidth={2} />
                    Markdown
                  </Button>
                </div>
                <Button
                  disabled={!markdownHeaderStatus.canDiscard}
                  onClick={() => markdownActionsRef.current?.discard()}
                  title="Discard markdown changes"
                  type="button"
                  variant="outline"
                >
                  Discard
                </Button>
                <Button
                  disabled={!markdownHeaderStatus.canSave}
                  onClick={() => markdownActionsRef.current?.save()}
                  title="Save markdown"
                  type="button"
                >
                  <HugeiconsIcon icon={FloppyDiskIcon} strokeWidth={2} />
                  {markdownHeaderStatus.saving ? "Saving..." : "Save"}
                </Button>
                {markdownHeaderStatus.canDelete ? (
                  <Button
                    disabled={markdownHeaderStatus.saving}
                    onClick={() => markdownActionsRef.current?.delete()}
                    size="icon"
                    title="Delete markdown file"
                    type="button"
                    variant="destructive"
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  </Button>
                ) : null}
              </div>
            ) : mainView === "planning" ? (
              <div className="flex shrink-0 items-center gap-2">
                <span className="hidden text-xs text-muted-foreground lg:inline">
                  {planningStatus?.dirty ? "Unsaved" : "Saved"}
                </span>
                <Button
                  disabled={!planningStatus?.canEdit}
                  onClick={() => planningActionsRef.current?.deleteSelected()}
                  size="icon"
                  title="Delete task"
                  type="button"
                  variant="outline"
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button disabled={!planningActionsRef.current} title="Task columns" type="button" variant="outline">
                      Columns
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuLabel>Task columns</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {PLANNING_COLUMN_OPTIONS.map((option) => (
                      <DropdownMenuCheckboxItem
                        checked={(planningStatus?.visibleColumns ?? PLANNING_DEFAULT_COLUMN_IDS).includes(option.id)}
                        disabled={option.required}
                        key={option.id}
                        onCheckedChange={() => planningActionsRef.current?.toggleColumn(option.id)}
                        onSelect={(event) => event.preventDefault()}
                      >
                        {option.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  onClick={() => planningActionsRef.current?.zoomOut()}
                  size="icon"
                  title="Zoom out"
                  type="button"
                  variant="outline"
                >
                  <HugeiconsIcon icon={ZoomOutAreaIcon} strokeWidth={2} />
                </Button>
                <Button
                  onClick={() => planningActionsRef.current?.zoomIn()}
                  size="icon"
                  title="Zoom in"
                  type="button"
                  variant="outline"
                >
                  <HugeiconsIcon icon={ZoomInAreaIcon} strokeWidth={2} />
                </Button>
                <Button
                  onClick={() => planningActionsRef.current?.toggleTaskList()}
                  size="icon"
                  title={planningStatus?.taskListVisible ? "Hide task list" : "Show task list"}
                  type="button"
                  variant="outline"
                >
                  <HugeiconsIcon icon={planningStatus?.taskListVisible ? PanelLeftCloseIcon : PanelLeftOpenIcon} strokeWidth={2} />
                </Button>
                <Button
                  disabled={busyAction === "planning-gantt"}
                  onClick={() => void planningActionsRef.current?.save()}
                  title="Save planning"
                  type="button"
                >
                  <HugeiconsIcon icon={FloppyDiskIcon} strokeWidth={2} />
                  {busyAction === "planning-gantt" ? "Saving..." : "Save"}
                </Button>
                <Button
                  onClick={() => setPlanningFullscreen((current) => !current)}
                  size="icon"
                  title={planningFullscreenActive ? "Exit fullscreen" : "Fullscreen"}
                  type="button"
                  variant="outline"
                >
                  <HugeiconsIcon icon={planningFullscreenActive ? MinimizeScreenIcon : FullScreenIcon} strokeWidth={2} />
                </Button>
              </div>
            ) : null}
            <Button onClick={toggleTheme} size="icon" title={`Theme: ${theme}`} type="button" variant="ghost">
              <HugeiconsIcon icon={DarkModeIcon} strokeWidth={2} />
            </Button>
          </header>

          {!isGlobalView && !project ? (
            <main className="flex min-h-0 flex-1 items-center justify-center px-5 text-center">
              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">Devsync</h1>
                <p className="mt-2 text-sm font-medium leading-6 text-foreground">
                  Project memory for AI-heavy teams
                </p>
                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  Create the first project from the sidebar.
                </p>
              </div>
            </main>
          ) : (
            <div className="flex min-h-0 flex-1 overflow-hidden">
              <main className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto] overflow-hidden">
                <div
                  className={cn(
                    "min-h-0 flex-1 overflow-y-auto px-5 py-5 md:px-8 md:py-6",
                    (selectedArtifactIsExcalidraw || mainView === "planning") && "overflow-hidden p-0 md:p-0"
                  )}
                  ref={activityScrollRef}
                >
                  <Suspense fallback={<div className="text-sm text-muted-foreground">Loading...</div>}>
                    {mainView === "docs" ? (
                    selectedDocFile ? (
                      isImageFile(selectedDocFile.name) ? (
                        <section className="mx-auto max-w-4xl">
                          <div className="mb-5">
                            <h1 className="truncate text-xl font-semibold text-foreground">
                              {selectedDocFile.name}
                            </h1>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {selectedDocFile.path} / {formatSize(selectedDocFile.size)}
                            </div>
                          </div>
                          <div className="flex h-[min(70vh,640px)] min-h-72 items-center justify-center rounded-lg border border-border bg-card p-3">
                            <img
                              alt={selectedDocFile.name}
                              className="h-full max-h-full w-full max-w-full object-contain"
                              src={docsDownloadUrl(selectedDocId!, selectedDocFile.path)}
                            />
                          </div>
                        </section>
                      ) : isTextFile(selectedDocFile.name) ? (
                        <TextFileView
                          content={docFileQuery.data}
                          isLoading={docFileQuery.isLoading}
                        />
                      ) : (
                        <section className="mx-auto max-w-3xl">
                          <div className="mb-5">
                            <h1 className="truncate text-xl font-semibold text-foreground">
                              {displayFileTitle(selectedDocFile)}
                            </h1>
                            <div className="mt-1 text-xs text-muted-foreground">{selectedDocFile.path}</div>
                          </div>
                          <a
                            className="inline-flex rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                            href={docsDownloadUrl(selectedDocId!, selectedDocFile.path)}
                          >
                            Download file
                          </a>
                        </section>
                      )
                    ) : (
                      <TextFileView
                        content={docsFolderQuery.isLoading ? "" : docsFolder?.readme || "README.md not found."}
                        isLoading={docsFolderQuery.isLoading}
                      />
                    )
                  ) : mainView === "agents" ? (
                    <AssistantChatView
                      bottomRef={assistantBottomRef}
                      commandFiles={markdownCommandFiles}
                      draft={agentDraft}
                      error={agentError}
                      input={agentInput}
                      isAddingToArtifacts={busyAction === "assistant-artifact"}
                      isLoading={assistantQuery.isLoading || assistantRolesQuery.isLoading || agentThreadsQuery.isLoading || agentThreadQuery.isLoading}
                      isSending={isAgentSending}
                      isUploadingAttachment={isUploadingAgentAttachment}
                      messages={agentMessages}
                      pendingAttachments={agentPendingAttachments}
                      roles={assistantRoles}
                      selectedRole={selectedAssistantRole}
                      selectedThreadId={selectedAgentThreadId}
                      thoughts={selectedAssistantThoughts}
                      threads={agentThreads}
                      onAddAttachmentToArtifacts={handleAgentAttachmentAddToArtifacts}
                      onAddMessageToArtifacts={handleAgentMessageAddToArtifacts}
                      onAttachmentRemove={handleAgentAttachmentRemove}
                      onAttachmentUpload={handleAgentAttachmentUpload}
                      onInputChange={setAgentInput}
                      onNewThread={handleNewAgentThread}
                      onOpenProjectFile={handleOpenProjectFileLink}
                      onRoleChange={setSelectedAssistantRole}
                      onSubmit={handleAgentSubmit}
                      onThoughtStepToggle={handleAssistantThoughtStepToggle}
                      onThoughtToggle={handleAssistantThoughtToggle}
                      onThreadChange={handleAgentThreadChange}
                    />
                  ) : mainView === "git" ? (
                    <GitView
                      busyAction={busyAction}
                      result={gitResult}
                      onPull={() => void handleGitAction("pull")}
                      onPush={() => void handleGitAction("push")}
                    />
                  ) : mainView === "my-items" ? (
                    <MyItemsView
                      groups={myItemGroups}
                      isLoading={myItemsQuery.isLoading}
                      isSaving={busyAction === "my-plan-item"}
                      onOpenItem={handleOpenMyPlanItem}
                      onToggleItem={(item, done) => void handleToggleMyPlanItem(item, done)}
                    />
                  ) : mainView === "planning" ? (
                    <PlanningView
                      data={planningQuery.data}
                      isDark={theme === "dark" || (theme === "system" && document.documentElement.classList.contains("dark"))}
                      isLoading={planningQuery.isLoading}
                      onActionsChange={handlePlanningActionsChange}
                      onSave={handleSavePlanningGantt}
                      onStatusChange={handlePlanningStatusChange}
                    />
                  ) : mainView === "config" ? (
                    <ConfigView
                      isSaving={busyAction === "config"}
                      name={configName}
                      owner={configOwner}
                      ownerOptions={ownerOptions}
                      status={configStatus}
                      statusOptions={PROJECT_STATUS_OPTIONS}
                      tags={configTags}
                      onNameChange={setConfigName}
                      onOwnerChange={setConfigOwner}
                      onStatusChange={setConfigStatus}
                      onSubmit={handleConfigSubmit}
                      onTagsChange={setConfigTags}
                    />
                  ) : mainView === "readme" ? (
                    <MarkdownViewer
                      content={readmeQuery.data}
                      isLoading={readmeQuery.isLoading}
                      onOpenProjectFile={handleOpenProjectFileLink}
                      resolveUrl={resolveMarkdownAssetUrl}
                    />
                  ) : mainView === "artifacts" ? (
                    <FileIndexView
                      content={artifactIndexQuery.data}
                      files={artifacts}
                      indexPath={ARTIFACT_INDEX_PATH}
                      isLoading={artifactIndexQuery.isLoading}
                      isSaving={busyAction === "artifact-index"}
                      title="Artifacts"
                      onAdd={() => guardedNavigation(() => setArtifactDialogOpen(true))}
                      onCreateDrawing={handleRequestCreateDrawing}
                      onOpenFile={(path) => {
                        guardedNavigation(() => {
                          setSelectedArtifactPath(path)
                          setSelectedGeneratedPath(null)
                          setSelectedPlanItemPath(null)
                          setPlaceholderTitle("")
                          setMainView("artifact")
                        }, path)
                      }}
                      onSaveItems={handleSaveArtifactIndex}
                    />
                  ) : mainView === "plan" ? (
                    <FileIndexView
                      checkboxes
                      addLabel="Add plan item"
                      content={planItemIndexQuery.data}
                      emptyLabel="No plan items"
                      files={planItems}
                      indexPath={PLAN_INDEX_PATH}
                      isLoading={planItemIndexQuery.isLoading}
                      isSaving={busyAction === "planItem-index"}
                      ownerOptions={ownerOptions}
                      title="Plan"
                      onAdd={() => guardedNavigation(() => setPlanItemDialogOpen(true))}
                      onOpenFile={(path) => {
                        guardedNavigation(() => {
                          setSelectedArtifactPath(null)
                          setSelectedGeneratedPath(null)
                          setSelectedPlanItemPath(path)
                          setPlaceholderTitle("")
                          setMainView("plan-item")
                        })
                      }}
                      onSaveItems={handleSavePlanIndex}
                    />
                  ) : mainView === "plan-item" && selectedPlanItem ? (
                    isMarkdownFile(selectedPlanItem.name) ? (
                      planItemQuery.isLoading ? (
                        <TextFileView
                          content={planItemQuery.data}
                          isLoading={planItemQuery.isLoading}
                        />
                      ) : (
                        <MarkdownArtifactEditor
                          key={selectedPlanItem.path}
                          content={planItemQuery.data}
                          isLoading={false}
                          isSaving={busyAction === "planItem-content"}
                          commandFiles={markdownCommandFiles}
                          path={selectedPlanItem.name}
                          title={selectedPlanItem.name}
                          onDelete={() => handleDeletePlanItem(selectedPlanItem.path)}
                          onOpenProjectFile={handleOpenProjectFileLink}
                          onSave={(nextContent) => handleSaveMarkdownPlanItem(selectedPlanItem.path, nextContent)}
                          onUploadImage={handleUploadMarkdownImage}
                          onActionsChange={handleMarkdownActionsChange}
                          onStatusChange={handleMarkdownStatusChange}
                          resolveUrl={resolveMarkdownAssetUrl}
                        />
                      )
                    ) : isTextFile(selectedPlanItem.name) ? (
                      <TextFileView
                        content={planItemQuery.data}
                        isLoading={planItemQuery.isLoading}
                      />
                    ) : (
                      <section className="mx-auto max-w-3xl">
                        <div className="mb-5">
                          <h1 className="truncate text-xl font-semibold text-foreground">
                            {displayFileTitle(selectedPlanItem)}
                          </h1>
                          <div className="mt-1 text-xs text-muted-foreground">{selectedPlanItem.name}</div>
                        </div>
                        <div className="flex gap-2">
                          <a
                            className="inline-flex rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                            href={downloadUrl(project!.id, selectedPlanItem.path)}
                          >
                            Download file
                          </a>
                          <Button onClick={() => handleDeletePlanItem(selectedPlanItem.path)} type="button" variant="destructive">
                            Delete
                          </Button>
                        </div>
                      </section>
                    )
                  ) : mainView === "generated-file" && selectedGenerated ? (
                    isMarkdownFile(selectedGenerated.name) ? (
                      generatedQuery.isLoading ? (
                        <TextFileView
                          content={generatedQuery.data}
                          isLoading={generatedQuery.isLoading}
                        />
                      ) : (
                        <MarkdownArtifactEditor
                          key={selectedGenerated.path}
                          content={generatedQuery.data}
                          isLoading={false}
                          isSaving={busyAction === "generated-content"}
                          commandFiles={markdownCommandFiles}
                          path={selectedGenerated.name}
                          title={selectedGenerated.name}
                          onOpenProjectFile={handleOpenProjectFileLink}
                          onSave={(nextContent) => handleSaveMarkdownGenerated(selectedGenerated.path, nextContent)}
                          onUploadImage={handleUploadMarkdownImage}
                          onActionsChange={handleMarkdownActionsChange}
                          onStatusChange={handleMarkdownStatusChange}
                          resolveUrl={resolveMarkdownAssetUrl}
                        />
                      )
                    ) : isTextFile(selectedGenerated.name) ? (
                      <TextFileView
                        content={generatedQuery.data}
                        isLoading={generatedQuery.isLoading}
                      />
                    ) : (
                      <section className="mx-auto max-w-3xl">
                        <div className="mb-5">
                          <h1 className="truncate text-xl font-semibold text-foreground">
                            {displayFileTitle(selectedGenerated)}
                          </h1>
                          <div className="mt-1 text-xs text-muted-foreground">{selectedGenerated.path}</div>
                        </div>
                        <a
                          className="inline-flex rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                          href={downloadUrl(project!.id, selectedGenerated.path)}
                        >
                          Download file
                        </a>
                      </section>
                    )
                  ) : mainView === "system-log" ? (
                    <SystemLogView
                      events={systemLogQuery.data?.items ?? []}
                      isLoading={systemLogQuery.isLoading}
                      path={systemLogQuery.data?.path}
                    />
                  ) : mainView === "chat" ? (
                    <PlaceholderView title="Chat" />
                  ) : mainView === "placeholder" ? (
                    <PlaceholderView title={placeholderTitle} />
                  ) : selectedArtifact ? (
                    <ArtifactView
                      artifact={selectedArtifact}
                      commandFiles={markdownCommandFiles}
                      content={artifactQuery.data}
                      isLoading={artifactQuery.isLoading}
                      isSaving={busyAction === "artifact-content" || busyAction === "excalidraw-content"}
                      projectId={project!.id}
                      onDelete={handleDeleteArtifact}
                      onDirtyChange={markDrawingDirty}
                      onDrawingActionsChange={handleDrawingActionsChange}
                      onDrawingStatusChange={setDrawingStatus}
                      onOpenProjectFile={handleOpenProjectFileLink}
                      onSaveExcalidraw={handleSaveExcalidrawArtifact}
                      onSaveMarkdown={handleSaveMarkdownArtifact}
                      onUploadImage={handleUploadMarkdownImage}
                      onMarkdownActionsChange={handleMarkdownActionsChange}
                      onMarkdownStatusChange={handleMarkdownStatusChange}
                      resolveUrl={resolveMarkdownAssetUrl}
                    />
                  ) : (
                    <section className="mx-auto max-w-3xl">
                      <div className="mb-4">
                        <h1 className="text-xl font-semibold text-foreground">Project Log</h1>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {projectQuery.data?.activity.path ?? "logs/activity"} /{" "}
                          {projectQuery.data?.activity?.files.length ?? 0} files loaded
                        </div>
                      </div>
                      {entries.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                          No activity yet.
                        </div>
                      ) : (
                        <div>
                          {projectQuery.data?.activity.hasOlder ? (
                            <div className="mb-3 flex justify-center">
                              <Button
                                disabled={isLoadingOlderActivity}
                                onClick={handleLoadOlderActivity}
                                type="button"
                                variant="outline"
                              >
                                {isLoadingOlderActivity ? "Loading..." : "Load older"}
                              </Button>
                            </div>
                          ) : null}
                          {entries.map((entry) => (
                            <ActivityEntryView
                              entry={entry}
                              key={entry.id}
                              onOpenArtifact={(path) => {
                                guardedNavigation(() => {
                                  setSelectedArtifactPath(path)
                                  setSelectedGeneratedPath(null)
                                  setSelectedPlanItemPath(null)
                                  setMainView("artifact")
                                }, path)
                              }}
                            />
                          ))}
                          <div ref={activityBottomRef} />
                        </div>
                      )}
                    </section>
                    )}
                  </Suspense>
                </div>

                {isActivityLogView ? (
                  <footer className="sticky bottom-0 z-10 shrink-0 border-t border-border/70 bg-background px-5 py-4 md:px-8">
                    <form className="mx-auto max-w-3xl" onSubmit={handleLogSubmit}>
                      <div className="relative rounded-lg border border-border bg-card p-3">
                        {logFileMenu.open ? (
                          <div className="absolute bottom-[calc(100%+8px)] left-0 z-50">
                            <CommandMenuList
                              activeIndex={logFileMenu.activeIndex}
                              className="w-[min(18rem,calc(100vw-2rem))]"
                              groups={logFileMenuGroups}
                              onActiveIndexChange={(activeIndex) =>
                                setLogFileMenu((current) => ({ ...current, activeIndex }))
                              }
                              onRun={(item) => item.onRun()}
                            />
                          </div>
                        ) : null}
                        <textarea
                          className="max-h-40 min-h-16 w-full resize-none bg-transparent text-sm leading-6 text-foreground outline-none placeholder:text-muted-foreground"
                          name="activity-log-content"
                          onBlur={() => window.setTimeout(closeLogFileMenu, 0)}
                          onChange={handleLogContentChange}
                          onClick={(event) => {
                            if (logFileMenu.open) syncLogFileMenu(event.currentTarget)
                          }}
                          onKeyDown={handleLogContentKeyDown}
                          placeholder="project log input"
                          ref={logTextareaRef}
                          value={logContent}
                        />
                        <div className="mt-2 flex justify-end">
                          <Button disabled={!canWrite || !logContent.trim()} type="submit">
                            <HugeiconsIcon icon={ArrowUp03Icon} strokeWidth={2} />
                            Save
                          </Button>
                        </div>
                      </div>
                    </form>
                  </footer>
                ) : null}
              </main>

              {immersiveViewActive ? null : mainView === "docs" ? (
                <DocsRail
                  activePath={selectedDocFilePath}
                  files={docFiles}
                  onOpenFile={(path) => setSelectedDocFilePath(path)}
                />
	              ) : isGlobalView ? null : (
	                <ProjectRail
	                  activePath={selectedArtifactPath}
                    activeGeneratedPath={selectedGeneratedPath}
	                  activePlanItemPath={selectedPlanItemPath}
	                  artifacts={artifacts}
                    busyWorkflowId={busyWorkflowId}
                    generatedFiles={generated}
	                  planItems={planItems}
	                  view={mainView}
                    workflows={workflows}
	                  onAddArtifact={() => guardedNavigation(() => setArtifactDialogOpen(true))}
                    onCreateDrawing={handleRequestCreateDrawing}
	                  onAddPlanItem={() => guardedNavigation(() => setPlanItemDialogOpen(true))}
                    onRunWorkflow={setPendingWorkflowId}
                    onOpenConfig={() => {
                      guardedNavigation(() => {
                        setSelectedArtifactPath(null)
                        setSelectedGeneratedPath(null)
                        setSelectedPlanItemPath(null)
                        setMainView("config")
                      })
                    }}
	                  onOpenActivity={() => {
	                    guardedNavigation(() => {
	                      setSelectedArtifactPath(null)
                        setSelectedGeneratedPath(null)
	                      setSelectedPlanItemPath(null)
	                      setPlaceholderTitle("")
	                      setMainView("activity")
                      })
	                  }}
	                  onOpenAssistant={() => {
	                    handleOpenAssistant()
	                  }}
	                  onOpenArtifacts={() => {
	                    guardedNavigation(() => {
	                      setSelectedArtifactPath(null)
                        setSelectedGeneratedPath(null)
	                      setSelectedPlanItemPath(null)
	                      setPlaceholderTitle("")
	                      setMainView("artifacts")
                      })
	                  }}
                  onOpenArtifact={(path) => {
                    guardedNavigation(() => {
                      setSelectedArtifactPath(path)
                      setSelectedGeneratedPath(null)
                      setSelectedPlanItemPath(null)
                      setPlaceholderTitle("")
                      setMainView("artifact")
                    }, path)
                  }}
                  onOpenGeneratedFile={(path) => {
                    guardedNavigation(() => {
                      setSelectedArtifactPath(null)
                      setSelectedGeneratedPath(path)
                      setSelectedPlanItemPath(null)
                      setPlaceholderTitle("")
                      setMainView("generated-file")
                    })
                  }}
	                  onOpenPlan={() => {
                    guardedNavigation(() => {
                      setSelectedArtifactPath(null)
                      setSelectedGeneratedPath(null)
                      setSelectedPlanItemPath(null)
                      setPlaceholderTitle("")
                      setMainView("plan")
                    })
                  }}
                  onOpenPlanItem={(path) => {
                    guardedNavigation(() => {
                      setSelectedArtifactPath(null)
                      setSelectedGeneratedPath(null)
                      setSelectedPlanItemPath(path)
                      setPlaceholderTitle("")
                      setMainView("plan-item")
                    })
                  }}
                />
              )}
            </div>
          )}
        </section>
      </SidebarInset>
        <ArtifactDialog
          busy={busyAction === "artifact"}
          file={artifactFile}
          open={artifactDialogOpen}
          textContent={artifactTextContent}
          textTitle={artifactTextTitle}
          onFileChange={handleArtifactFileChange}
          onOpenChange={(open) => {
            setArtifactDialogOpen(open)
            if (!open) {
              resetArtifactDialog()
            }
          }}
          onSubmit={handleArtifactSubmit}
          onTextContentChange={setArtifactTextContent}
          onTextTitleChange={setArtifactTextTitle}
        />
        <DrawingNameDialog
          busy={busyAction === "excalidraw-create" || busyAction === "excalidraw-content"}
          mode={drawingDialogMode ?? "create"}
          open={Boolean(drawingDialogMode)}
          title={drawingDialogTitle}
          onOpenChange={(open) => {
            if (!open) {
              setDrawingDialogMode(null)
            }
          }}
          onSubmit={handleDrawingDialogSubmit}
          onTitleChange={setDrawingDialogTitle}
        />
        <PlanItemDialog
          busy={busyAction === "plan-item"}
          body={planItemBody}
          deadline={planItemDeadline}
          open={planItemDialogOpen}
          owner={planItemOwner}
          ownerOptions={ownerOptions}
          title={planItemTitle}
          onBodyChange={setPlanItemBody}
          onDeadlineChange={setPlanItemDeadline}
          onOpenChange={(open) => {
            setPlanItemDialogOpen(open)
            if (!open) {
              resetPlanItemDialog()
            }
          }}
          onOwnerChange={setPlanItemOwner}
          onSubmit={handlePlanItemSubmit}
          onTitleChange={setPlanItemTitle}
        />
        <AlertDialog open={Boolean(pendingWorkflow)} onOpenChange={(open) => {
          if (!open) {
            setPendingWorkflowId(null)
          }
        }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Run workflow?</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingWorkflow
                  ? `${pendingWorkflow.title} will run with its configured tools and file permissions.`
                  : "This workflow will run with its configured tools and file permissions."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {pendingWorkflow ? (
              <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">Tools:</span>{" "}
                  {pendingWorkflow.tools.length ? pendingWorkflow.tools.join(", ") : "none"}
                </div>
                <div>
                  <span className="font-medium text-foreground">Read:</span>{" "}
                  {pendingWorkflow.read.length ? pendingWorkflow.read.join(", ") : "none"}
                </div>
                <div>
                  <span className="font-medium text-foreground">Write:</span>{" "}
                  {pendingWorkflow.write.length ? pendingWorkflow.write.join(", ") : "none"}
                </div>
              </div>
            ) : null}
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={!pendingWorkflow || Boolean(busyWorkflowId)}
                onClick={() => {
                  if (pendingWorkflow) {
                    void handleRunWorkflow(pendingWorkflow.id)
                  }
                }}
              >
                Run
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SidebarProvider>
    </div>
  )
}

export default App
