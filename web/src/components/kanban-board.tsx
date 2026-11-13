import { useEffect, useState } from "react"
import type { DragEvent } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon } from "@hugeicons/core-free-icons"
import { TASK_STATUSES } from "@/domain/devsync"
import type { ProjectSummary, ProjectTask, TaskPatch, TaskStatus } from "@/domain/devsync"
import type { AuthUser } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { TaskTagFilter, TaskTagLabels } from "@/components/task-tags"

const COLLAPSED_COLUMNS_KEY = "devsync:kanban:collapsed-columns"

function loadCollapsedColumns(): TaskStatus[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(COLLAPSED_COLUMNS_KEY) ?? "[]")
    return Array.isArray(saved) ? TASK_STATUSES.filter((status) => saved.includes(status)) : []
  } catch {
    return []
  }
}

function taskKey(task: ProjectTask) {
  return `${task.projectId}:${task.path}`
}

export function KanbanBoard({
  tasks,
  projects,
  projectId,
  users,
  busy,
  isLoading,
  onProjectChange,
  onAdd,
  onOpenList,
  onOpen,
  onUpdate
}: {
  tasks: ProjectTask[]
  projects: ProjectSummary[]
  projectId: string | null
  users: AuthUser[]
  busy: boolean
  isLoading: boolean
  onProjectChange: (projectId: string | null) => void
  onAdd: () => void
  onOpenList: () => void
  onOpen: (task: ProjectTask) => void
  onUpdate: (task: ProjectTask, changes: TaskPatch) => Promise<void>
}) {
  const [draggedTask, setDraggedTask] = useState<ProjectTask | null>(null)
  const [dropStatus, setDropStatus] = useState<TaskStatus | null>(null)
  const [collapsed, setCollapsed] = useState<TaskStatus[]>(loadCollapsedColumns)
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_COLUMNS_KEY, JSON.stringify(collapsed))
    } catch (error) {
      console.warn("Could not save Kanban column preferences", error)
    }
  }, [collapsed])
  const [tagFilter, setTagFilter] = useState("")
  const projectTasks = projectId ? tasks.filter((task) => task.projectId === projectId) : tasks
  const visibleTasks = tagFilter ? projectTasks.filter((task) => task.tags?.includes(tagFilter)) : projectTasks
  const columns = TASK_STATUSES.map((status) => (collapsed.includes(status) ? "3.5rem" : "minmax(160px, 1fr)")).join(
    " "
  )

  function resetDrag() {
    setDraggedTask(null)
    setDropStatus(null)
  }

  function dragOver(event: DragEvent<HTMLElement>, status: TaskStatus) {
    if (busy || !draggedTask) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = "move"
    setDropStatus(status)
  }

  function changeStatus(task: ProjectTask, status: TaskStatus) {
    if (!busy && task.status !== status) {
      // The shared handler reports failures and reloads the current task revisions.
      void onUpdate(task, { status }).catch(() => {})
    }
  }

  function drop(event: DragEvent<HTMLElement>, status: TaskStatus) {
    event.preventDefault()
    event.stopPropagation()
    const task = draggedTask
    resetDrag()
    if (task) changeStatus(task, status)
  }

  function toggleColumn(status: TaskStatus) {
    setCollapsed((current) =>
      current.includes(status) ? current.filter((item) => item !== status) : [...current, status]
    )
  }

  return (
    <section aria-label="Kanban board" className="min-w-0">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Kanban</h1>
          <p className="mt-1 text-xs text-muted-foreground">Drag a task to change its status.</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <select
            aria-label="Filter by project"
            className="h-9 max-w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
            value={projectId ?? ""}
            onChange={(event) => {
              resetDrag()
              setTagFilter("")
              onProjectChange(event.target.value || null)
            }}
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
            {projectId && !projects.some((project) => project.id === projectId) ? (
              <option value={projectId}>Unavailable project: {projectId}</option>
            ) : null}
          </select>
          <TaskTagFilter tasks={projectTasks} value={tagFilter} onChange={(tag) => { resetDrag(); setTagFilter(tag) }} />
          <span aria-live="polite" className="text-xs text-muted-foreground">
            {isLoading ? "Loading..." : busy ? "Saving..." : `${visibleTasks.length} tasks`}
          </span>
          {projectId && projects.some((project) => project.id === projectId) ? (
            <Button variant="ghost" onClick={onOpenList}>
              Task list
            </Button>
          ) : null}
          <Button disabled={busy || isLoading || projects.length === 0} variant="outline" onClick={onAdd}>
            Add task
          </Button>
        </div>
      </div>
      <div className="w-full min-w-0 overflow-x-auto pb-3">
        <div className="grid items-stretch gap-3" style={{ gridTemplateColumns: columns }}>
          {TASK_STATUSES.map((status) => {
            const items = visibleTasks.filter((task) => task.status === status)
            const isCollapsed = collapsed.includes(status)
            return (
              <section
                key={status}
                aria-label={`${status} column`}
                className={cn(
                  "min-h-72 min-w-0 rounded-lg border border-border bg-muted/30 transition-colors",
                  dropStatus === status && "border-primary bg-primary/5"
                )}
                onDragOver={(event) => dragOver(event, status)}
                onDragLeave={(event) => {
                  const next = event.relatedTarget
                  if (!(next instanceof Node) || !event.currentTarget.contains(next)) setDropStatus(null)
                }}
                onDrop={(event) => drop(event, status)}
              >
                <h2>
                  <button
                    type="button"
                    aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${status} column`}
                    aria-expanded={!isCollapsed}
                    aria-controls={`kanban-column-${status}`}
                    className={cn(
                      "flex w-full gap-2 text-sm font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring",
                      isCollapsed
                        ? "flex-col items-center px-2 py-3"
                        : "items-center justify-between border-b border-border/70 px-3 py-3"
                    )}
                    onClick={() => toggleColumn(status)}
                  >
                    <span className={isCollapsed ? "[writing-mode:vertical-rl]" : "truncate"}>{status}</span>
                    <span className="text-xs font-normal text-muted-foreground tabular-nums">{items.length}</span>
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      strokeWidth={2}
                      className={cn("size-4 shrink-0", !isCollapsed && "rotate-180")}
                    />
                  </button>
                </h2>
                <div id={`kanban-column-${status}`} hidden={isCollapsed} className="space-y-2 p-2">
                  {items.length === 0 && !isLoading ? (
                    <p className="px-2 py-5 text-center text-xs text-muted-foreground">No tasks</p>
                  ) : null}
                  {items.map((task) => (
                    <article
                      key={taskKey(task)}
                      aria-label={`${task.projectName}: ${task.title || task.name}`}
                      draggable={!busy && !isLoading}
                      className={cn(
                        "min-w-0 rounded-md border border-border bg-card p-3 text-card-foreground shadow-sm",
                        !busy && "cursor-grab active:cursor-grabbing",
                        draggedTask && taskKey(draggedTask) === taskKey(task) && "opacity-50"
                      )}
                      onDragStart={(event) => {
                        event.stopPropagation()
                        event.dataTransfer.effectAllowed = "move"
                        event.dataTransfer.setData("text/plain", taskKey(task))
                        setDraggedTask(task)
                      }}
                      onDragEnd={resetDrag}
                    >
                      <p className="mb-2 truncate text-xs font-medium text-muted-foreground" title={task.projectName}>
                        {task.projectName}
                      </p>
                      <button
                        className="w-full text-left text-sm font-medium break-words hover:underline"
                        type="button"
                        onClick={() => onOpen(task)}
                      >
                        {task.title || task.name}
                      </button>
                      <TaskTagLabels tags={task.tags ?? []} />
                      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                        <p className="break-words">
                          {users.find((user) => user.email === task.owner)?.name || task.owner || "Unassigned"}
                        </p>
                        {task.deadline ? <p>Due {task.deadline}</p> : null}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </section>
  )
}
