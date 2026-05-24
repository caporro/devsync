import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { MouseEvent, WheelEvent } from "react"
import { Editor, Gantt, Willow, WillowDark } from "@svar-ui/react-gantt"
import type { IApi, IColumnConfig, ILink, ITask } from "@svar-ui/react-gantt"
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
  text: { id: "text", header: "Task", flexgrow: 2, editor: "text" },
  owner: { id: "owner", header: "Owner", flexgrow: 1, editor: "text" },
  start: { id: "start", header: "Start", align: "center", flexgrow: 1, editor: "datepicker" },
  duration: { id: "duration", header: "Days", align: "center", width: 72, editor: "text" },
  progress: { id: "progress", header: "%", align: "center", width: 64, editor: "text" },
}
const PLANNING_ADD_TASK_COLUMN: IColumnConfig = { id: "add-task", header: "", width: 48, align: "center" }
const PLANNING_GANTT_SCALES = [
  { unit: "month", step: 1, format: "%F %Y" },
  { unit: "day", step: 1, format: "%j" },
]
const PLANNING_EDITOR_ITEMS = [
  { key: "text", comp: "text", label: "Name", config: { placeholder: "Add task name" } },
  { key: "owner", comp: "text", label: "Owner", config: { placeholder: "Add owner" } },
  { key: "details", comp: "textarea", label: "Description", config: { placeholder: "Add description" } },
  {
    key: "type",
    comp: "select",
    label: "Type",
    options: [
      { id: "task", label: "Task" },
      { id: "summary", label: "Summary task" },
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

function toGanttTasks(tasks: PlanningGanttTask[]): ITask[] {
  return tasks.map((task) => ({
    ...task,
    start: ganttDate(task.start),
    end: ganttDate(task.end),
  }))
}

function serializeGanttTask(task: ITask): PlanningGanttTask {
  const result: PlanningGanttTask = {}

  Object.entries(task).forEach(([key, value]) => {
    if (key.startsWith("$") || value === undefined || typeof value === "function") {
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

function planningColumnsFor(ids: PlanningColumnId[]) {
  const selected = new Set(normalizePlanningColumns(ids))
  const columns = PLANNING_COLUMN_OPTIONS
    .filter((option) => selected.has(option.id))
    .map((option) => PLANNING_COLUMN_BY_ID[option.id])

  return [...columns, PLANNING_ADD_TASK_COLUMN]
}

function planningDefaultTask(respectOffDays: boolean) {
  return {
    text: "New task",
    owner: "",
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
  onSave,
  onStatusChange,
}: {
  data: PlanningGanttData | undefined
  isDark: boolean
  isLoading: boolean
  onActionsChange: (actions: PlanningActions | null) => void
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
  const [pendingDeleteIds, setPendingDeleteIds] = useState<PlanningTaskId[]>([])
  const columns = useMemo(() => planningColumnsFor(visibleColumns), [visibleColumns])
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
        text: String(event.task?.text ?? "").trim() || "New task",
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
    const stateLinks = nextApi?.getState().links.map((link) => link) ?? links
    const nextLinks = stateLinks.map(serializeGanttLink).filter((link): link is PlanningGanttLink => Boolean(link))

    await onSave({
      tasks: (nextApi?.serialize() ?? tasks).map(serializeGanttTask),
      links: nextLinks,
    })
    setIsDirty(false)
  }, [links, onSave, tasks])

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
      canEdit: Boolean(selectedTaskId),
      dirty: isDirty,
      taskListVisible,
      visibleColumns,
    })
  }, [isDirty, onStatusChange, selectedTaskId, taskListVisible, visibleColumns])

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
  }, [columns, isDirty, refreshLayout, taskListVisible])

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
                  highlightTime={PLANNING_OFF_DAYS_ENABLED ? highlightPlanningTime : undefined}
                  init={handleInit}
                  links={links}
                  ref={apiRef}
                  scales={PLANNING_GANTT_SCALES}
                  tasks={tasks}
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
            <AlertDialogTitle>Delete task?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the selected task{pendingDeleteIds.length > 1 ? "s" : ""} and related links.
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
