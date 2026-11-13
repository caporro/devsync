import { useState } from "react"
import type { DragEvent } from "react"
import { TASK_STATUSES } from "@/domain/devsync"
import type { Task, TaskPatch, TaskStatus } from "@/domain/devsync"
import type { AuthUser } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TaskTagFilter, TaskTagsEditor } from "@/components/task-tags"

export function TaskStatusSelect({
  value,
  disabled,
  onChange
}: {
  value: TaskStatus
  disabled?: boolean
  onChange: (status: TaskStatus) => void
}) {
  return (
    <select
      aria-label="Task status"
      className="h-8 w-28 shrink-0 rounded-md border border-input bg-background px-2 text-xs text-foreground"
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value as TaskStatus)}
    >
      {TASK_STATUSES.map((status) => (
        <option key={status} value={status}>
          {status}
        </option>
      ))}
    </select>
  )
}

export function TaskOwnerSelect({
  value,
  users,
  disabled,
  onChange
}: {
  value: string
  users: AuthUser[]
  disabled?: boolean
  onChange: (owner: string) => void
}) {
  return (
    <select
      aria-label="Task owner"
      className="h-8 w-36 shrink-0 rounded-md border border-input bg-background px-2 text-xs text-foreground"
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">Unassigned</option>
      {users.map((user) => (
        <option key={user.email} value={user.email}>
          {user.name && user.name !== user.email ? `${user.name} (${user.email})` : user.email}
        </option>
      ))}
      {value && !users.some((user) => user.email === value) ? <option value={value}>{value}</option> : null}
    </select>
  )
}

export function ProjectTasksView({
  tasks,
  users,
  busy,
  onAdd,
  onOpen,
  onUpdate,
  onReorder
}: {
  tasks: Task[]
  users: AuthUser[]
  busy: boolean
  onAdd: () => void
  onOpen: (path: string) => void
  onUpdate: (task: Task, changes: TaskPatch) => Promise<void>
  onReorder: (tasks: Task[]) => Promise<void>
}) {
  const [draggedPath, setDraggedPath] = useState<string | null>(null)
  const [tagFilter, setTagFilter] = useState("")
  const visibleTasks = tagFilter ? tasks.filter((task) => task.tags?.includes(tagFilter)) : tasks
  const [dropTarget, setDropTarget] = useState<{ path: string; after: boolean } | null>(null)

  function dragOver(event: DragEvent<HTMLDivElement>, path: string) {
    if (busy) return
    event.preventDefault()
    const box = event.currentTarget.getBoundingClientRect()
    setDropTarget({ path, after: event.clientY > box.top + box.height / 2 })
  }

  function drop(event: DragEvent<HTMLDivElement>, target: string) {
    event.preventDefault()
    const source = draggedPath || event.dataTransfer.getData("text/plain")
    if (!busy && source && source !== target) {
      const moved = tasks.find((task) => task.path === source)
      const next = tasks.filter((task) => task.path !== source)
      const index = next.findIndex((task) => task.path === target)
      if (moved && index >= 0) {
        next.splice(index + (dropTarget?.path === target && dropTarget.after ? 1 : 0), 0, moved)
        void onReorder(next).catch(() => {})
      }
    }
    setDraggedPath(null)
    setDropTarget(null)
  }

  return (
    <section className="mx-auto max-w-5xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-foreground">Tasks</h1>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TaskTagFilter tasks={tasks} value={tagFilter} onChange={setTagFilter} />
          <Button disabled={busy} variant="outline" onClick={onAdd}>Add task</Button>
        </div>
      </div>
      {visibleTasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
          {tagFilter ? "No tasks match this tag" : "No tasks"}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          {visibleTasks.map((task) => (
            <div
              key={`${task.path}:${task.revision}`}
              className="relative flex min-w-[700px] items-center gap-2 border-b border-border/70 px-3 py-2 last:border-b-0"
              onDragOver={(event) => dragOver(event, task.path)}
              onDrop={(event) => drop(event, task.path)}
            >
              {dropTarget?.path === task.path ? (
                <span
                  className={`pointer-events-none absolute right-3 left-3 h-0.5 bg-foreground ${dropTarget.after ? "bottom-0" : "top-0"}`}
                />
              ) : null}
              <button
                aria-label="Reorder task"
                className="size-7 shrink-0 cursor-grab text-muted-foreground"
                type="button"
                disabled={busy}
                draggable={!busy}
                onDragStart={(event) => {
                  setDraggedPath(task.path)
                  event.dataTransfer.setData("text/plain", task.path)
                }}
                onDragEnd={() => {
                  setDraggedPath(null)
                  setDropTarget(null)
                }}
              >
                ⋮⋮
              </button>
              <TaskStatusSelect
                value={task.status}
                disabled={busy}
                onChange={(status) => {
                  void onUpdate(task, { status }).catch(() => {})
                }}
              />
              <div className="min-w-36 flex-1 space-y-1">
                <Input
                  aria-label="Task title"
                  className={`h-8 min-w-36 border-transparent bg-transparent text-sm shadow-none hover:border-input ${["done", "rejected"].includes(task.status) ? "text-muted-foreground line-through" : ""}`}
                  defaultValue={task.title || task.name}
                  disabled={busy}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur()
                  }}
                  onBlur={(event) => {
                    const title = event.currentTarget.value.trim()
                    if (title && title !== task.title) void onUpdate(task, { title }).catch(() => {})
                    else event.currentTarget.value = task.title || task.name
                  }}
                />
                <TaskTagsEditor value={task.tags ?? []} disabled={busy} onChange={(tags) => onUpdate(task, { tags })} />
              </div>
              <Input
                aria-label="Task deadline"
                className="h-8 w-36 shrink-0 text-xs"
                type="date"
                value={task.deadline || ""}
                disabled={busy}
                onChange={(event) => {
                  void onUpdate(task, { deadline: event.target.value }).catch(() => {})
                }}
              />
              <TaskOwnerSelect
                value={task.owner || ""}
                users={users}
                disabled={busy}
                onChange={(owner) => {
                  void onUpdate(task, { owner }).catch(() => {})
                }}
              />
              <Button variant="ghost" size="xs" onClick={() => onOpen(task.path)}>
                Open
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
