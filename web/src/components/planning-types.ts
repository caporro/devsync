export type PlanningColumnId = "text" | "owner" | "start" | "duration" | "progress"

export const PLANNING_COLUMN_OPTIONS: Array<{ id: PlanningColumnId; label: string; required?: boolean }> = [
  { id: "text", label: "Task", required: true },
  { id: "owner", label: "Owner" },
  { id: "start", label: "Start" },
  { id: "duration", label: "Days" },
  { id: "progress", label: "%" },
]

export const PLANNING_DEFAULT_COLUMN_IDS = PLANNING_COLUMN_OPTIONS.map((column) => column.id)

export type PlanningActions = {
  deleteSelected: () => void
  save: () => Promise<void>
  toggleColumn: (id: PlanningColumnId) => void
  toggleTaskList: () => void
  zoomIn: () => void
  zoomOut: () => void
}

export type PlanningStatus = {
  canEdit: boolean
  dirty: boolean
  taskListVisible: boolean
  visibleColumns: PlanningColumnId[]
}
