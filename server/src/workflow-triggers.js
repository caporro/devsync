import { getWorkflowDefinition, listWorkflowDefinitions } from "./workflow-definitions.js"
import { runWorkflow } from "./workflow-runtime.js"
import { listProjects } from "./storage.js"

const runningKeys = new Set()
const lastScheduleRuns = new Map()
let schedulerTimer = null

function eventMatches(workflow, event) {
  if (workflow.trigger !== "event") {
    return false
  }

  if (!workflow.events.length || !workflow.events.includes(event.type)) {
    return false
  }

  const filter = workflow.eventFilter ?? {}
  if (filter.artifactKind && String(filter.artifactKind) !== String(event.payload?.artifactKind ?? "")) {
    return false
  }

  return true
}

function cronMatches(cron, date = new Date()) {
  const parts = String(cron ?? "").trim().split(/\s+/)
  if (parts.length !== 5) {
    return false
  }

  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ]

  return parts.every((part, index) => cronPartMatches(part, values[index]))
}

function cronPartMatches(part, value) {
  return String(part).split(",").some((piece) => {
    if (piece === "*") {
      return true
    }

    const step = piece.match(/^\*\/(\d+)$/)
    if (step) {
      const interval = Number(step[1])
      return Number.isInteger(interval) && interval > 0 && value % interval === 0
    }

    const range = piece.match(/^(\d+)-(\d+)$/)
    if (range) {
      return value >= Number(range[1]) && value <= Number(range[2])
    }

    return value === Number(piece)
  })
}

function scheduleKey(projectId, workflowId, date = new Date()) {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ].join("")

  return `${projectId}:${workflowId}:${stamp}`
}

async function runTriggeredWorkflow({ workflow, projectId, reason, event, log }) {
  const runKey = `${projectId}:${workflow.id}`
  if (runningKeys.has(runKey)) {
    log?.info({ workflowId: workflow.id, projectId, reason }, "workflow trigger skipped: already running")
    return
  }

  runningKeys.add(runKey)
  try {
    log?.info({ workflowId: workflow.id, projectId, reason, eventType: event?.type ?? null }, "workflow trigger run starting")
    await runWorkflow({
      workflow,
      projectId,
      input: [
        `Triggered by: ${reason}`,
        event ? `Event: ${JSON.stringify(event)}` : "",
      ].filter(Boolean).join("\n"),
      log,
    })
    log?.info({ workflowId: workflow.id, projectId, reason }, "workflow trigger run completed")
  } catch (error) {
    log?.error({
      workflowId: workflow.id,
      projectId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    }, "workflow trigger run failed")
  } finally {
    runningKeys.delete(runKey)
  }
}

export async function emitWorkflowEvent(event, log) {
  if (!event?.projectId || !event?.type) {
    return
  }

  const workflows = await listWorkflowDefinitions({ projectId: event.projectId })
  const matching = workflows.filter((workflow) => eventMatches(workflow, event))

  for (const workflow of matching) {
    void runTriggeredWorkflow({
      workflow,
      projectId: event.projectId,
      reason: event.type,
      event,
      log,
    })
  }
}

export function startWorkflowScheduler(log) {
  if (schedulerTimer) {
    return
  }

  schedulerTimer = setInterval(() => {
    void safeRunScheduledWorkflows(log)
  }, 60_000)
  void safeRunScheduledWorkflows(log)
}

async function safeRunScheduledWorkflows(log) {
  try {
    await runScheduledWorkflows(log)
  } catch (error) {
    log?.error({
      error: error instanceof Error ? error.message : String(error),
    }, "workflow scheduler failed")
  }
}

async function runScheduledWorkflows(log) {
  const now = new Date()
  const projects = await listProjects()

  for (const project of projects) {
    const workflows = await listWorkflowDefinitions({ projectId: project.id })
    const scheduled = workflows.filter((workflow) => workflow.trigger === "schedule" && cronMatches(workflow.cron, now))

    for (const workflow of scheduled) {
      const key = scheduleKey(project.id, workflow.id, now)
      if (lastScheduleRuns.has(key)) {
        continue
      }

      lastScheduleRuns.set(key, true)
      void runTriggeredWorkflow({
        workflow,
        projectId: project.id,
        reason: `schedule:${workflow.cron}`,
        log,
      })
    }
  }
}

export async function runWorkflowById({ workflowId, projectId, input, log }) {
  const workflow = await getWorkflowDefinition(workflowId, { projectId })

  if (!workflow) {
    return null
  }

  return runWorkflow({ workflow, projectId, input, log })
}
