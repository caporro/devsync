export type PlanningColumnId = "text" | "owner" | "status" | "external_id" | "link" | "start" | "duration" | "progress"

export const PLANNING_COLUMN_OPTIONS: Array<{ id: PlanningColumnId; label: string; required?: boolean }> = [
  { id: "text", label: "Task", required: true },
  { id: "owner", label: "Owner" },
  { id: "status", label: "Status" },
  { id: "external_id", label: "External ID" },
  { id: "link", label: "Link" },
  { id: "start", label: "Start" },
  { id: "duration", label: "Days" },
  { id: "progress", label: "%" },
]

export const PLANNING_DEFAULT_COLUMN_IDS = PLANNING_COLUMN_OPTIONS.map((column) => column.id)

export type PlanningActions = {
  deleteSelected: () => void
  filterByOwner: (owner: string | null) => void
  save: () => Promise<void>
  toggleColumn: (id: PlanningColumnId) => void
  toggleTaskList: () => void
  zoomIn: () => void
  zoomOut: () => void
}

export type PlanningStatus = {
  canEdit: boolean
  dirty: boolean
  ownerFilter: string | null
  ownerOptions: string[]
  taskListVisible: boolean
  visibleColumns: PlanningColumnId[]
}
