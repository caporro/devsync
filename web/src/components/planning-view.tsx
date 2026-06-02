import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { MouseEvent, WheelEvent } from "react"
import { Editor, Gantt, Willow, WillowDark } from "@svar-ui/react-gantt"
import type { IApi, IColumnConfig, ILink, ITask } from "@svar-ui/react-gantt"
import { HugeiconsIcon } from "@hugeicons/react"
import { FilterIcon, FilterRemoveIcon, LinkSquare01Icon } from "@hugeicons/core-free-icons"
import "@svar-ui/react-gantt/all.css"

import type { PlanningGanttData, PlanningGanttLink, PlanningGanttTask } from "@/domain/devsync"
import {
  PLANNING_COLUMN_OPTIONS,
  PLANNING_DEFAULT_COLUMN_IDS,
} from "@/components/planning-types"
import type {
  PlanningActions,
  PlanningColumnId,
  PlanningStatus,
} from "@/components/planning-types"
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
import { cn } from "@/lib/utils"

type PlanningTaskId = string | number
type PlanningProjectFileOpener = (projectId: string, path: string) => void
type PlanningCalendar = {
  addRule: () => undefined
  clone: () => PlanningCalendar
  addWorkingDays: (start: Date, days: number) => Date
  addWorkingHours: (start: Date, hours: number) => Date
  getDayHours: (date: Date) => number
  getNextWorkingDay: (date: Date) => Date
  getPreviousWorkingDay: (date: Date) => Date
  getWorkingDays: (start: Date, end: Date) => number
  getWorkingHours: (start: Date, end?: Date) => number
  isWorkingDay: (date: Date) => boolean
  setDayHours: () => undefined
  setRangeHours: () => undefined
}

const PLANNING_COLUMN_STORAGE_KEY = "devsync.planning.columns"
const PLANNING_OFF_DAYS_ENABLED = false
const PLANNING_COLUMN_BY_ID: Record<PlanningColumnId, IColumnConfig> = {
  text: { id: "text", header: "Step", flexgrow: 2, editor: "text" },
  owner: { id: "owner", header: "Owner", flexgrow: 1, editor: "text" },
  status: { id: "status", header: "Status", flexgrow: 1, editor: "text" },
  external_id: { id: "external_id", header: "External ID", flexgrow: 1, editor: "text" },
  link: { id: "link", header: "Link", flexgrow: 1, editor: "text" },
  start: { id: "start", header: "Start", align: "center", flexgrow: 1, editor: "datepicker" },
  duration: { id: "duration", header: "Days", align: "center", width: 72, editor: "text" },
  progress: { id: "progress", header: "%", align: "center", width: 64, editor: "text" },
}
const PLANNING_ADD_TASK_COLUMN_BASE: IColumnConfig = { id: "add-task", header: "", width: 96, align: "center" }
const PLANNING_GANTT_SCALES = [
  { unit: "month", step: 1, format: "%F %Y" },
  { unit: "day", step: 1, format: "%j" },
]
const PLANNING_EDITOR_ITEMS = [
  { key: "text", comp: "text", label: "Name", config: { placeholder: "Add step name" } },
  { key: "owner", comp: "text", label: "Owner", config: { placeholder: "Add owner" } },
  { key: "status", comp: "text", label: "Status", config: { placeholder: "Add status" } },
  { key: "external_id", comp: "text", label: "External ID", config: { placeholder: "Add external ID" } },
  { key: "link", comp: "text", label: "Link", config: { placeholder: "Add link" } },
  { key: "details", comp: "textarea", label: "Description", config: { placeholder: "Add description" } },
  {
    key: "type",
    comp: "select",
    label: "Type",
    options: [
      { id: "task", label: "Step" },
      { id: "summary", label: "Summary" },
      { id: "milestone", label: "Milestone" },
    ],
    isHidden: planningTaskHasNoParent,
  },
  { key: "start", comp: "date", label: "Start date", config: { format: "%d-%m-%Y" }, isHidden: planningTaskIsSummary },
  { key: "end", comp: "date", label: "End date", isHidden: planningTaskHasComputedEnd },
  { key: "duration", comp: "counter", label: "Duration", config: { min: 1 }, isHidden: planningTaskHasComputedEnd },
  { key: "progress", comp: "slider", label: "Progress", config: { min: 1, max: 100 }, isHidden: planningTaskIsMilestoneOrRoot },
  { key: "links", comp: "links", label: "", isHidden: planningTaskHasNoParent },
]

function ganttDate(value: unknown) {
  if (!value) {
    return undefined
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value
  }

  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/)
  if (!match) {
    return undefined
  }

  return new Date(`${match[1]}T00:00:00`)
}

function serializeGanttDate(value: unknown) {
  if (!value) {
    return undefined
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }

  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1]
}

function serializeGanttTask(task: ITask): PlanningGanttTask {
  const result: PlanningGanttTask = {}

  Object.entries(task).forEach(([key, value]) => {
    if (key === "data" || key.startsWith("$") || value === undefined || typeof value === "function") {
      return
    }

    if (key === "start" || key === "end") {
      const date = serializeGanttDate(value)
      if (date) {
        result[key] = date
      }
      return
    }

    result[key] = value
  })

  return result
}

function flattenPlanningTasks(tasks: PlanningGanttTask[]) {
  const result: PlanningGanttTask[] = []
  const indexById = new Map<string, number>()

  function visit(task: PlanningGanttTask, parent?: PlanningTaskId) {
    const { data, ...flatTask } = task
    const id = planningIdKey(flatTask.id)

    if (parent !== undefined && (flatTask.parent === undefined || flatTask.parent === null || flatTask.parent === "")) {
      flatTask.parent = parent
    }

    if (id && indexById.has(id)) {
      result[indexById.get(id)!] = flatTask
    } else {
      if (id) {
        indexById.set(id, result.length)
      }
      result.push(flatTask)
    }

    if (Array.isArray(data)) {
      data.forEach((child) => visit(child, flatTask.id))
    }
  }

  tasks.forEach((task) => visit(task))
  return result
}

function toGanttTasks(tasks: PlanningGanttTask[]): ITask[] {
  const flatTasks = flattenPlanningTasks(tasks)
  const childCounts = new Map<string, number>()

  flatTasks.forEach((task) => {
    const parent = planningIdKey(task.parent)
    if (parent && parent !== "0") {
      childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1)
    }
  })

  return flatTasks.map((task) => {
    const next: ITask = {
      ...task,
      start: ganttDate(task.start),
      end: ganttDate(task.end),
    }
    const id = planningIdKey(next.id)

    delete next.data
    if (!id || !childCounts.has(id)) {
      delete next.open
    }

    return next
  })
}

function serializeGanttLink(link: ILink): PlanningGanttLink | null {
  if (link.source === undefined || link.target === undefined) {
    return null
  }

  return {
    ...link,
    type: ["s2s", "s2e", "e2s", "e2e"].includes(link.type) ? link.type : "e2s",
    source: link.source,
    target: link.target,
  }
}

function planningIdKey(value: unknown) {
  return value === undefined || value === null || value === "" ? "" : String(value)
}

function planningTaskOwner(task: ITask | PlanningGanttTask) {
  return String(task.owner ?? "").trim()
}

function planningRootParent(value: unknown) {
  const key = planningIdKey(value)
  return !key || key === "0"
}

function planningLinkKey(link: PlanningGanttLink | ILink) {
  const id = planningIdKey(link.id)
  return id
    ? `id:${id}`
    : `edge:${planningIdKey(link.source)}:${planningIdKey(link.target)}:${link.type}:${String(link.lag ?? "")}`
}

function collectPlanningBranchIds(tasks: Array<ITask | PlanningGanttTask>, rootId: PlanningTaskId | null) {
  const rootKey = planningIdKey(rootId)
  if (!rootKey) {
    return null
  }

  const taskIds = new Set<string>()
  const childrenByParent = new Map<string, string[]>()

  tasks.forEach((task) => {
    const id = planningIdKey(task.id)
    const parent = planningIdKey(task.parent)

    if (!id) {
      return
    }

    taskIds.add(id)
    if (parent && parent !== "0") {
      childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), id])
    }
  })

  if (!taskIds.has(rootKey)) {
    return null
  }

  const branchIds = new Set<string>([rootKey])
  const queue = [rootKey]

  while (queue.length) {
    const current = queue.shift()
    if (!current) {
      continue
    }

    ;(childrenByParent.get(current) ?? []).forEach((childId) => {
      if (!branchIds.has(childId)) {
        branchIds.add(childId)
        queue.push(childId)
      }
    })
  }

  return branchIds
}

function taskHasPlanningAncestor(
  task: ITask | PlanningGanttTask,
  ancestorIds: Set<string>,
  parentById: Map<string, string>
) {
  const seen = new Set<string>()
  let parent = planningIdKey(task.parent)

  while (parent && parent !== "0" && !seen.has(parent)) {
    if (ancestorIds.has(parent)) {
      return true
    }

    seen.add(parent)
    parent = parentById.get(parent) ?? ""
  }

  return false
}

function hasUnsafeHrefCharacter(value: string) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 31 || code === 127 || /\s/.test(char)
  })
}

function validPlanningProjectId(value: unknown) {
  const projectId = String(value ?? "").trim()
  return /^[a-z0-9][a-z0-9_-]*$/.test(projectId) ? projectId : null
}

function encodePlanningRoutePath(value: string, section: string) {
  const parts = value.split("/").filter(Boolean)
  const scopedParts = parts[0] === section ? parts.slice(1) : parts

  if (!scopedParts.length || scopedParts.some((part) => part === "." || part === "..")) {
    return null
  }

  return scopedParts.map(encodeURIComponent).join("/")
}

function planningInternalLink(value: string, row: ITask) {
  let normalized = value.split(/[?#]/, 1)[0].replace(/\\/g, "/")

  try {
    normalized = decodeURIComponent(normalized)
  } catch {
    // Keep the original path if it is not URI encoded.
  }

  normalized = normalized.replace(/^\/+/, "").replace(/^(?:\.\/)+/, "")

  const routed = normalized.match(/^projects\/([^/]+)\/(resources|artifacts|work|generated|tasks)\/(.+)$/)
  if (routed) {
    const [, projectId, rawSection, path] = routed
    const section = rawSection === "artifacts" ? "resources" : rawSection === "generated" ? "work" : rawSection
    const routePath = encodePlanningRoutePath(path, section)
    return routePath && validPlanningProjectId(projectId)
      ? { href: `/projects/${encodeURIComponent(projectId)}/${section}/${routePath}`, path: `${section}/${path}`, projectId, type: "internal" as const }
      : null
  }

  const relative = normalized.match(/^(resources|artifacts|work|generated|tasks)\/(.+)$/)
  const projectId = validPlanningProjectId(row.projectId)
  if (relative && projectId) {
    const [, rawSection, path] = relative
    const section = rawSection === "artifacts" ? "resources" : rawSection === "generated" ? "work" : rawSection
    const routePath = encodePlanningRoutePath(path, section)
    return routePath
      ? { href: `/projects/${encodeURIComponent(projectId)}/${section}/${routePath}`, path: `${section}/${path}`, projectId, type: "internal" as const }
      : null
  }

  return null
}

function planningExternalLink(value: string) {
  try {
    const url = new URL(value)
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
      ? { href: value, type: "external" as const }
      : null
  } catch {
    return null
  }
}

function resolvePlanningLink(value: unknown, row: ITask) {
  const href = String(value ?? "").trim()
  if (!href || hasUnsafeHrefCharacter(href)) {
    return null
  }

  return planningInternalLink(href, row) ?? planningExternalLink(href)
}

function PlanningActionCell({
  activeBranchTaskId,
  onFilterTask,
  onOpenProjectFile,
  row,
}: Parameters<NonNullable<IColumnConfig["cell"]>>[0] & {
  activeBranchTaskId?: PlanningTaskId | null
  onFilterTask?: (id: PlanningTaskId) => void
  onOpenProjectFile?: PlanningProjectFileOpener
}) {
  const link = resolvePlanningLink(row.link, row)
  const branchFilterActive = planningIdKey(row.id) === planningIdKey(activeBranchTaskId)

  return (
    <div className="devsync-gantt-actions">
      {link ? (
        <a
          aria-label="Open link"
          className="devsync-gantt-action devsync-gantt-link-action"
          href={link.href}
          onClick={(event) => {
            event.stopPropagation()
            if (link.type === "internal" && onOpenProjectFile && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
              event.preventDefault()
              onOpenProjectFile(link.projectId, link.path)
            }
          }}
          onMouseDown={(event) => event.stopPropagation()}
          rel="noreferrer"
          target={link.type === "external" && /^https?:\/\//i.test(link.href) ? "_blank" : undefined}
          title="Open link"
        >
          <HugeiconsIcon className="size-4" icon={LinkSquare01Icon} strokeWidth={2} />
        </a>
      ) : null}
      <button
        aria-label={branchFilterActive ? "Clear filters" : "Filter branch"}
        className={cn("devsync-gantt-action", branchFilterActive && "devsync-gantt-action--active")}
        onClick={(event) => {
          event.stopPropagation()
          if (row.id !== undefined && row.id !== null) {
            onFilterTask?.(row.id)
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
        title={branchFilterActive ? "Clear filters" : "Filter branch"}
        type="button"
      >
        <HugeiconsIcon className="size-4" icon={branchFilterActive ? FilterRemoveIcon : FilterIcon} strokeWidth={2} />
      </button>
      <i className="devsync-gantt-action wxi-plus" data-action="add-task" title="Add step" />
    </div>
  )
}

function planningTaskIsSummary(task: ITask) {
  return task.type === "summary"
}

function planningTaskIsMilestone(task: ITask) {
  return task.type === "milestone"
}

function planningTaskHasNoParent(task: ITask) {
  return task.parent === undefined
}

function planningTaskHasComputedEnd(task: ITask) {
  return planningTaskIsSummary(task) || planningTaskIsMilestone(task)
}

function planningTaskIsMilestoneOrRoot(task: ITask) {
  return planningTaskIsMilestone(task) || planningTaskHasNoParent(task)
}

function normalizePlanningColumns(ids: PlanningColumnId[]) {
  const selected = new Set(ids)

  return PLANNING_COLUMN_OPTIONS
    .filter((option) => option.required || selected.has(option.id))
    .map((option) => option.id)
}

function initialPlanningColumns() {
  if (typeof window === "undefined") {
    return PLANNING_DEFAULT_COLUMN_IDS
  }

  try {
    const raw = window.localStorage.getItem(PLANNING_COLUMN_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) {
      return normalizePlanningColumns(parsed.filter((id): id is PlanningColumnId =>
        PLANNING_COLUMN_OPTIONS.some((option) => option.id === id)
      ))
    }
  } catch {
    return PLANNING_DEFAULT_COLUMN_IDS
  }

  return PLANNING_DEFAULT_COLUMN_IDS
}

function planningActionColumn(
  onOpenProjectFile?: PlanningProjectFileOpener,
  onFilterTask?: (id: PlanningTaskId) => void,
  activeBranchTaskId?: PlanningTaskId | null
): IColumnConfig {
  return {
    ...PLANNING_ADD_TASK_COLUMN_BASE,
    cell: (props) => (
      <PlanningActionCell
        {...props}
        activeBranchTaskId={activeBranchTaskId}
        onFilterTask={onFilterTask}
        onOpenProjectFile={onOpenProjectFile}
      />
    ),
  }
}

function planningColumnsFor(
  ids: PlanningColumnId[],
  onOpenProjectFile?: PlanningProjectFileOpener,
  onFilterTask?: (id: PlanningTaskId) => void,
  activeBranchTaskId?: PlanningTaskId | null
) {
  const selected = new Set(normalizePlanningColumns(ids))
  const columns = PLANNING_COLUMN_OPTIONS
    .filter((option) => selected.has(option.id))
    .map((option) => PLANNING_COLUMN_BY_ID[option.id])

  return [...columns, planningActionColumn(onOpenProjectFile, onFilterTask, activeBranchTaskId)]
}

function planningDefaultTask(respectOffDays: boolean) {
  return {
    text: "New step",
    owner: "",
    status: "",
    external_id: "",
    link: "",
    start: respectOffDays ? nextPlanningWorkingDate(new Date()) : planningDay(new Date()),
    duration: 1,
    progress: 0,
    type: "task",
  }
}

const PLANNING_OFF_DAYS = new Set([0, 5, 6])
const PLANNING_WORKING_HOURS = 8

function planningDay(value: Date) {
  const date = new Date(value)
  date.setHours(0, 0, 0, 0)
  return date
}

function isPlanningOffDay(value: Date) {
  return PLANNING_OFF_DAYS.has(value.getDay())
}

function isPlanningWorkingDay(value: Date) {
  return !isPlanningOffDay(value)
}

function shiftPlanningWorkingDay(value: Date, step: 1 | -1) {
  const date = planningDay(value)

  do {
    date.setDate(date.getDate() + step)
  } while (!isPlanningWorkingDay(date))

  return date
}

function nextPlanningWorkingDate(value: Date) {
  const date = planningDay(value)

  while (isPlanningOffDay(date)) {
    date.setDate(date.getDate() + 1)
  }

  return date
}

function highlightPlanningTime(date: Date, unit: "day" | "hour") {
  return unit === "day" && isPlanningOffDay(date) ? "wx-weekend" : ""
}

function createPlanningCalendar(): PlanningCalendar {
  return {
    isWorkingDay: isPlanningWorkingDay,
    addRule: () => undefined,
    clone: createPlanningCalendar,
    addWorkingDays: (start, days) => {
      const step = days < 0 ? -1 : 1
      let date = planningDay(start)

      if (!isPlanningWorkingDay(date)) {
        date = shiftPlanningWorkingDay(date, step)
      }

      for (let index = 0; index < Math.abs(days); index += 1) {
        date = shiftPlanningWorkingDay(date, step)
      }

      return date
    },
    addWorkingHours: (start, hours) => {
      const days = Math.round(hours / PLANNING_WORKING_HOURS)
      return createPlanningCalendar().addWorkingDays(start, days)
    },
    getDayHours: (date) => isPlanningWorkingDay(date) ? PLANNING_WORKING_HOURS : 0,
    getNextWorkingDay: (date) => shiftPlanningWorkingDay(date, 1),
    getPreviousWorkingDay: (date) => shiftPlanningWorkingDay(date, -1),
    getWorkingDays: (start, end) => {
      const step = start <= end ? 1 : -1
      const cursor = planningDay(start)
      const limit = planningDay(end)
      let count = 0

      while (step > 0 ? cursor < limit : cursor > limit) {
        if (isPlanningWorkingDay(cursor)) {
          count += step
        }
        cursor.setDate(cursor.getDate() + step)
      }

      return count
    },
    getWorkingHours: (start, end = start) => {
      return createPlanningCalendar().getWorkingDays(start, end) * PLANNING_WORKING_HOURS
    },
    setDayHours: () => undefined,
    setRangeHours: () => undefined,
  }
}

const PLANNING_CALENDAR = createPlanningCalendar()

export function PlanningView({
  data,
  isDark,
  isLoading,
  onActionsChange,
  onOpenProjectFile,
  onSave,
  onStatusChange,
}: {
  data: PlanningGanttData | undefined
  isDark: boolean
  isLoading: boolean
  onActionsChange: (actions: PlanningActions | null) => void
  onOpenProjectFile?: PlanningProjectFileOpener
  onSave: (data: Pick<PlanningGanttData, "tasks" | "links">) => Promise<void>
  onStatusChange: (status: PlanningStatus | null) => void
}) {
  const apiRef = useRef<IApi | null>(null)
  const ganttRootRef = useRef<HTMLDivElement | null>(null)
  const deleteConfirmedRef = useRef(false)
  const respectOffDaysRef = useRef(PLANNING_OFF_DAYS_ENABLED)
  const spacePressedRef = useRef(false)
  const panStateRef = useRef<{ chart: HTMLElement; startX: number; scrollLeft: number } | null>(null)
  const [api, setApi] = useState<IApi | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [isPanning, setIsPanning] = useState(false)
  const [panReady, setPanReady] = useState(false)
  const [selectedTaskId, setSelectedTaskId] = useState<PlanningTaskId | null>(null)
  const [taskListVisible, setTaskListVisible] = useState(true)
  const [visibleColumns, setVisibleColumns] = useState<PlanningColumnId[]>(initialPlanningColumns)
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null)
  const [branchFilterTaskId, setBranchFilterTaskId] = useState<PlanningTaskId | null>(null)
  const [pendingDeleteIds, setPendingDeleteIds] = useState<PlanningTaskId[]>([])
  const tasks = useMemo(() => toGanttTasks(data?.tasks ?? []), [data?.tasks])
  const links = useMemo(() => data?.links ?? [], [data?.links])
  const Theme = isDark ? WillowDark : Willow

  const markDirty = useCallback(() => {
    setIsDirty(true)
  }, [])

  const refreshLayout = useCallback(() => {
    const resize = () => {
      const nextApi = apiRef.current
      const chart = ganttRootRef.current?.querySelector<HTMLElement>(".wx-chart")

      if (!nextApi || !chart) {
        return
      }

      const bounds = chart.getBoundingClientRect()
      void nextApi.exec("resize-chart", {
        width: bounds.width,
        height: bounds.height,
        scrollSize: chart.offsetHeight - chart.clientHeight,
      })
    }

    window.requestAnimationFrame(resize)
    window.setTimeout(resize, 80)
    window.setTimeout(resize, 180)
  }, [])

  const closeEditor = useCallback(() => {
    void apiRef.current?.exec("show-editor", { id: null as unknown as PlanningTaskId })
    refreshLayout()
  }, [refreshLayout])

  const applyBranchFilter = useCallback((id: PlanningTaskId) => {
    if (planningIdKey(id) === planningIdKey(branchFilterTaskId)) {
      setOwnerFilter(null)
      setBranchFilterTaskId(null)
      setSelectedTaskId(null)
      return
    }

    setBranchFilterTaskId(id)
    setSelectedTaskId(id)
  }, [branchFilterTaskId])

  const columns = useMemo(
    () => planningColumnsFor(visibleColumns, onOpenProjectFile, applyBranchFilter, branchFilterTaskId),
    [applyBranchFilter, branchFilterTaskId, onOpenProjectFile, visibleColumns]
  )

  const ownerOptions = useMemo(() => {
    return Array.from(new Set(tasks.map(planningTaskOwner).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  }, [tasks])

  const branchIds = useMemo(() => collectPlanningBranchIds(tasks, branchFilterTaskId), [branchFilterTaskId, tasks])
  const activeOwnerFilter = ownerFilter && ownerOptions.includes(ownerFilter) ? ownerFilter : null
  const filtersActive = Boolean(activeOwnerFilter || branchIds)

  const visibleTaskKeys = useMemo(() => {
    const next = new Set<string>()

    tasks.forEach((task) => {
      const id = planningIdKey(task.id)

      if (!id) {
        return
      }

      if (activeOwnerFilter && planningTaskOwner(task) !== activeOwnerFilter) {
        return
      }

      if (branchIds && !branchIds.has(id)) {
        return
      }

      next.add(id)
    })

    return next
  }, [activeOwnerFilter, branchIds, tasks])

  const parentOverrides = useMemo(() => {
    const next = new Map<string, PlanningTaskId>()

    tasks.forEach((task) => {
      const id = planningIdKey(task.id)
      const parent = planningIdKey(task.parent)

      if (id && parent && parent !== "0" && visibleTaskKeys.has(id) && !visibleTaskKeys.has(parent)) {
        next.set(id, task.parent as PlanningTaskId)
      }
    })

    return next
  }, [tasks, visibleTaskKeys])

  const visibleTasks = useMemo(() => {
    const nextTasks = filtersActive
      ? tasks.filter((task) => {
        const id = planningIdKey(task.id)
        return id && visibleTaskKeys.has(id)
      })
      .map((task) => {
        const id = planningIdKey(task.id)
        if (!parentOverrides.has(id)) {
          return task
        }

        const next = { ...task }
        delete next.parent
        return next
      })
      : tasks
    const childCounts = new Map<string, number>()

    nextTasks.forEach((task) => {
      const parent = planningIdKey(task.parent)
      if (parent && parent !== "0") {
        childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1)
      }
    })

    return nextTasks.map((task) => {
      const next = { ...task }
      const id = planningIdKey(next.id)

      delete next.data
      if (!id || !childCounts.has(id)) {
        delete next.open
      }

      return next
    })
  }, [filtersActive, parentOverrides, tasks, visibleTaskKeys])

  const visibleLinkKeys = useMemo(() => {
    if (!filtersActive) {
      return new Set(links.map(planningLinkKey))
    }

    return new Set(
      links
        .filter((link) => visibleTaskKeys.has(planningIdKey(link.source)) && visibleTaskKeys.has(planningIdKey(link.target)))
        .map(planningLinkKey)
    )
  }, [filtersActive, links, visibleTaskKeys])

  const visibleLinks = useMemo(() => {
    if (!filtersActive) {
      return links
    }

    return links.filter((link) => visibleLinkKeys.has(planningLinkKey(link)))
  }, [filtersActive, links, visibleLinkKeys])

  const selectedTaskVisible = useMemo(() => {
    const selectedKey = planningIdKey(selectedTaskId)
    return !filtersActive || !selectedKey || visibleTaskKeys.has(selectedKey)
  }, [filtersActive, selectedTaskId, visibleTaskKeys])

  const requestDelete = useCallback((ids: PlanningTaskId[]) => {
    if (ids.length) {
      setPendingDeleteIds(ids)
    }
  }, [])

  const currentSelectedIds = useCallback(() => {
    const selected = apiRef.current?.getState().selected ?? []
    return selected.length ? selected : selectedTaskId ? [selectedTaskId] : []
  }, [selectedTaskId])

  const handleInit = useCallback((nextApi: IApi) => {
    apiRef.current = nextApi
    setApi(nextApi)

    const tag = Symbol("planning-gantt")
    nextApi.intercept("add-task", (event) => {
      event.task = {
        ...planningDefaultTask(respectOffDaysRef.current),
        ...event.task,
        text: String(event.task?.text ?? "").trim() || "New step",
      }
      event.select = true
      event.show = true
    }, { tag })

    nextApi.intercept("delete-task", (event) => {
      if (deleteConfirmedRef.current) {
        return
      }

      requestDelete([event.id])
      return false
    }, { tag })

    ;["add-task", "update-task", "delete-task", "move-task", "copy-task", "add-link", "update-link", "delete-link"].forEach((eventName) => {
      nextApi.on(eventName, () => {
        markDirty()
        refreshLayout()
      }, { tag })
    })

    nextApi.on("select-task", () => {
      window.setTimeout(() => setSelectedTaskId(nextApi.getState().selected?.[0] ?? null), 0)
    }, { tag })

    nextApi.on("add-task", (event) => {
      window.setTimeout(() => {
        if (event.id) {
          setSelectedTaskId(event.id)
          void nextApi.exec("show-editor", { id: event.id })
          refreshLayout()
        }
      }, 0)
    }, { tag })
  }, [markDirty, refreshLayout, requestDelete])

  const handleSave = useCallback(async () => {
    const nextApi = apiRef.current
    const apiTasks = nextApi?.serialize() ?? visibleTasks
    const nextTasks = apiTasks.map((task) => {
      const result = serializeGanttTask(task)
      const originalParent = parentOverrides.get(planningIdKey(result.id))

      if (originalParent !== undefined && planningRootParent(result.parent)) {
        result.parent = originalParent
      }

      return result
    })
    const stateLinks = nextApi?.getState().links.map((link) => link) ?? visibleLinks
    const nextLinks = stateLinks.map(serializeGanttLink).filter((link): link is PlanningGanttLink => Boolean(link))

    if (!filtersActive) {
      await onSave({
        tasks: nextTasks,
        links: nextLinks,
      })
      setIsDirty(false)
      return
    }

    const allTasks = tasks.map(serializeGanttTask)
    const originalTaskKeys = new Set(allTasks.map((task) => planningIdKey(task.id)).filter(Boolean))
    const visibleOriginalTaskKeys = new Set(visibleTasks.map((task) => planningIdKey(task.id)).filter(Boolean))
    const savedTaskKeys = new Set(nextTasks.map((task) => planningIdKey(task.id)).filter(Boolean))
    const deletedTaskKeys = new Set(
      Array.from(visibleOriginalTaskKeys).filter((key) => !savedTaskKeys.has(key))
    )
    const parentById = new Map(
      allTasks
        .map((task) => [planningIdKey(task.id), planningIdKey(task.parent)] as const)
        .filter(([id]) => Boolean(id))
    )
    const removedTaskKeys = new Set(deletedTaskKeys)

    allTasks.forEach((task) => {
      const id = planningIdKey(task.id)
      if (id && !visibleOriginalTaskKeys.has(id) && taskHasPlanningAncestor(task, deletedTaskKeys, parentById)) {
        removedTaskKeys.add(id)
      }
    })

    const savedTaskById = new Map(
      nextTasks
        .map((task) => [planningIdKey(task.id), task] as const)
        .filter(([id]) => Boolean(id))
    )
    const mergedTasks: PlanningGanttTask[] = []

    allTasks.forEach((task) => {
      const id = planningIdKey(task.id)

      if (id && removedTaskKeys.has(id)) {
        return
      }

      const savedTask = savedTaskById.get(id)
      if (savedTask) {
        mergedTasks.push(savedTask)
        return
      }

      if (id && visibleOriginalTaskKeys.has(id)) {
        return
      }

      mergedTasks.push(task)
    })

    nextTasks.forEach((task) => {
      const id = planningIdKey(task.id)
      if (!id || !originalTaskKeys.has(id)) {
        mergedTasks.push(task)
      }
    })

    const savedLinkByKey = new Map(nextLinks.map((link) => [planningLinkKey(link), link] as const))
    const mergedLinks: PlanningGanttLink[] = []

    links.forEach((link) => {
      const key = planningLinkKey(link)
      const hasRemovedTask = removedTaskKeys.has(planningIdKey(link.source)) || removedTaskKeys.has(planningIdKey(link.target))

      if (hasRemovedTask) {
        return
      }

      const savedLink = savedLinkByKey.get(key)
      if (savedLink) {
        mergedLinks.push(savedLink)
        return
      }

      if (visibleLinkKeys.has(key)) {
        return
      }

      mergedLinks.push(link)
    })

    nextLinks.forEach((link) => {
      const key = planningLinkKey(link)
      const hasRemovedTask = removedTaskKeys.has(planningIdKey(link.source)) || removedTaskKeys.has(planningIdKey(link.target))

      if (!hasRemovedTask && !links.some((current) => planningLinkKey(current) === key)) {
        mergedLinks.push(link)
      }
    })

    await onSave({ tasks: mergedTasks, links: mergedLinks })
    setIsDirty(false)
  }, [filtersActive, links, onSave, parentOverrides, tasks, visibleLinkKeys, visibleLinks, visibleTasks])

  const confirmDeleteTasks = useCallback(() => {
    const nextApi = apiRef.current

    if (!nextApi || !pendingDeleteIds.length) {
      setPendingDeleteIds([])
      return
    }

    deleteConfirmedRef.current = true
    pendingDeleteIds.forEach((id) => {
      void nextApi.exec("delete-task", { id })
    })
    deleteConfirmedRef.current = false
    setSelectedTaskId(null)
    setPendingDeleteIds([])
    closeEditor()
  }, [closeEditor, pendingDeleteIds])

  const actions = useMemo<PlanningActions>(() => ({
    deleteSelected: () => {
      requestDelete(currentSelectedIds())
    },
    filterByOwner: (owner) => {
      setOwnerFilter(owner?.trim() || null)
      refreshLayout()
    },
    save: handleSave,
    toggleColumn: (id) => {
      if (id === "text") {
        return
      }

      setVisibleColumns((current) => {
        const next = current.includes(id)
          ? current.filter((columnId) => columnId !== id)
          : [...current, id]

        return normalizePlanningColumns(next)
      })
      refreshLayout()
    },
    toggleTaskList: () => {
      setTaskListVisible((current) => !current)
      refreshLayout()
    },
    zoomIn: () => {
      void apiRef.current?.exec("zoom-scale", { dir: 1 }).then(refreshLayout)
    },
    zoomOut: () => {
      void apiRef.current?.exec("zoom-scale", { dir: -1 }).then(refreshLayout)
    },
  }), [currentSelectedIds, handleSave, refreshLayout, requestDelete])

  useEffect(() => {
    onActionsChange(actions)
    return () => onActionsChange(null)
  }, [actions, onActionsChange])

  useEffect(() => {
    onStatusChange({
      canEdit: Boolean(selectedTaskId && selectedTaskVisible),
      dirty: isDirty,
      ownerFilter: activeOwnerFilter,
      ownerOptions,
      taskListVisible,
      visibleColumns,
    })
  }, [activeOwnerFilter, isDirty, onStatusChange, ownerOptions, selectedTaskId, selectedTaskVisible, taskListVisible, visibleColumns])

  useEffect(() => () => onStatusChange(null), [onStatusChange])

  useEffect(() => {
    window.localStorage.setItem(PLANNING_COLUMN_STORAGE_KEY, JSON.stringify(visibleColumns))
    refreshLayout()
  }, [refreshLayout, visibleColumns])

  useEffect(() => {
    if (!api) {
      return
    }

    function handleDocumentMouseDown(event: globalThis.MouseEvent) {
      const target = event.target
      const editor = ganttRootRef.current?.querySelector(".wx-gantt-editor")

      if (!editor || !(target instanceof Element)) {
        return
      }

      if (target.closest(".wx-gantt-editor, .wx-dropdown, .wx-popup, [role='dialog'], [data-slot='dropdown-menu-content']")) {
        return
      }

      closeEditor()
    }

    document.addEventListener("mousedown", handleDocumentMouseDown)
    return () => document.removeEventListener("mousedown", handleDocumentMouseDown)
  }, [api, closeEditor])

  useEffect(() => {
    if (!api || !ganttRootRef.current) {
      return
    }

    const root = ganttRootRef.current
    const observer = new ResizeObserver(refreshLayout)
    const observed = [
      root,
      root.querySelector(".wx-table-container"),
      root.querySelector(".wx-layout > .wx-content"),
      root.querySelector(".wx-chart"),
    ].filter((element): element is Element => Boolean(element))

    observed.forEach((element) => observer.observe(element))
    window.addEventListener("resize", refreshLayout)
    refreshLayout()

    return () => {
      observer.disconnect()
      window.removeEventListener("resize", refreshLayout)
    }
  }, [api, refreshLayout])

  useEffect(() => {
    refreshLayout()
  }, [columns, isDirty, refreshLayout, taskListVisible, visibleLinks, visibleTasks])

  useEffect(() => {
    function isInputTarget(target: EventTarget | null) {
      return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true'], .wx-gantt-editor"))
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.code !== "Space" || isInputTarget(event.target)) {
        return
      }

      event.preventDefault()
      spacePressedRef.current = true
      setPanReady(true)
    }

    function handleKeyUp(event: globalThis.KeyboardEvent) {
      if (event.code !== "Space") {
        return
      }

      spacePressedRef.current = false
      panStateRef.current = null
      document.body.style.userSelect = ""
      setPanReady(false)
      setIsPanning(false)
    }

    document.addEventListener("keydown", handleKeyDown)
    document.addEventListener("keyup", handleKeyUp)

    return () => {
      document.removeEventListener("keydown", handleKeyDown)
      document.removeEventListener("keyup", handleKeyUp)
      document.body.style.userSelect = ""
    }
  }, [])

  useEffect(() => {
    function handleMouseMove(event: globalThis.MouseEvent) {
      const pan = panStateRef.current

      if (!pan) {
        return
      }

      event.preventDefault()
      pan.chart.scrollLeft = pan.scrollLeft - (event.clientX - pan.startX)
    }

    function handleMouseUp() {
      if (!panStateRef.current) {
        return
      }

      panStateRef.current = null
      document.body.style.userSelect = ""
      setIsPanning(false)
      refreshLayout()
    }

    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)

    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
    }
  }, [refreshLayout])

  function handleMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (!spacePressedRef.current || event.button !== 0 || !(event.target instanceof Element)) {
      return
    }

    const chart = ganttRootRef.current?.querySelector<HTMLElement>(".wx-chart")

    if (!chart || !event.target.closest(".wx-chart")) {
      return
    }

    event.preventDefault()
    document.body.style.userSelect = "none"
    panStateRef.current = {
      chart,
      startX: event.clientX,
      scrollLeft: chart.scrollLeft,
    }
    setIsPanning(true)
  }

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    if (!event.metaKey && !event.ctrlKey) {
      return
    }

    event.preventDefault()
    void apiRef.current?.exec("zoom-scale", {
      dir: event.deltaY < 0 ? 1 : -1,
      offset: event.currentTarget.clientWidth / 2,
    }).then(refreshLayout)
  }

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      {isLoading ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>
      ) : (
        <div className="devsync-gantt-shell h-full min-h-0">
          <Theme fonts={false}>
            <div
              className={cn(
                "devsync-gantt h-full min-h-0 min-w-0",
                !taskListVisible && "devsync-gantt--chart-only",
                panReady && "devsync-gantt--pan-ready",
                isPanning && "devsync-gantt--panning"
              )}
              onMouseDown={handleMouseDown}
              onWheel={handleWheel}
              ref={ganttRootRef}
            >
              {api ? <Editor api={api} autoSave={false} items={PLANNING_EDITOR_ITEMS} placement="sidebar" /> : null}
              <div className="h-full min-h-0 min-w-0">
                <Gantt
                  autoScale
                  calendar={PLANNING_OFF_DAYS_ENABLED ? PLANNING_CALENDAR : undefined}
                  cellBorders="full"
                  columns={columns}
                  highlightTime={highlightPlanningTime}
                  init={handleInit}
                  links={visibleLinks}
                  ref={apiRef}
                  scales={PLANNING_GANTT_SCALES}
                  tasks={visibleTasks}
                  zoom
                />
              </div>
            </div>
          </Theme>
        </div>
      )}
      <AlertDialog open={pendingDeleteIds.length > 0} onOpenChange={(open) => {
        if (!open) {
          setPendingDeleteIds([])
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete step?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the selected step{pendingDeleteIds.length > 1 ? "s" : ""} and related links.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteTasks}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
