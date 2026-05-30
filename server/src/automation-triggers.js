import { getAutomationDefinition, listAutomationDefinitions } from "./automation-definitions.js"
import { runAutomation } from "./automation-runtime.js"
import { listProjects } from "./storage.js"

const runningKeys = new Set()
const lastScheduleRuns = new Map()
let schedulerTimer = null

function eventMatches(automation, event) {
  if (automation.trigger !== "event") {
    return false
  }

  if (!automation.events.length || !automation.events.includes(event.type)) {
    return false
  }

  const filter = automation.eventFilter ?? {}
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

function scheduleKey(projectId, automationId, date = new Date()) {
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
  ].join("")

  return `${projectId}:${automationId}:${stamp}`
}

async function runTriggeredAutomation({ automation, projectId, reason, event, log }) {
  const runKey = `${projectId}:${automation.id}`
  if (runningKeys.has(runKey)) {
    log?.info({ automationId: automation.id, projectId, reason }, "automation trigger skipped: already running")
    return
  }

  runningKeys.add(runKey)
  try {
    log?.info({ automationId: automation.id, projectId, reason, eventType: event?.type ?? null }, "automation trigger run starting")
    await runAutomation({
      automation,
      projectId,
      input: [
        `Triggered by: ${reason}`,
        event ? `Event: ${JSON.stringify(event)}` : "",
      ].filter(Boolean).join("\n"),
      log,
    })
    log?.info({ automationId: automation.id, projectId, reason }, "automation trigger run completed")
  } catch (error) {
    log?.error({
      automationId: automation.id,
      projectId,
      reason,
      error: error instanceof Error ? error.message : String(error),
    }, "automation trigger run failed")
  } finally {
    runningKeys.delete(runKey)
  }
}

export async function emitAutomationEvent(event, log) {
  if (!event?.projectId || !event?.type) {
    return
  }

  const automations = await listAutomationDefinitions({ projectId: event.projectId })
  const matching = automations.filter((automation) => eventMatches(automation, event))

  for (const automation of matching) {
    void runTriggeredAutomation({
      automation,
      projectId: event.projectId,
      reason: event.type,
      event,
      log,
    })
  }
}

export function startAutomationScheduler(log) {
  if (schedulerTimer) {
    return
  }

  schedulerTimer = setInterval(() => {
    void safeRunScheduledAutomations(log)
  }, 60_000)
  void safeRunScheduledAutomations(log)
}

async function safeRunScheduledAutomations(log) {
  try {
    await runScheduledAutomations(log)
  } catch (error) {
    log?.error({
      error: error instanceof Error ? error.message : String(error),
    }, "automation scheduler failed")
  }
}

async function runScheduledAutomations(log) {
  const now = new Date()
  const projects = await listProjects()

  for (const project of projects) {
    const automations = await listAutomationDefinitions({ projectId: project.id })
    const scheduled = automations.filter((automation) => automation.trigger === "schedule" && cronMatches(automation.cron, now))

    for (const automation of scheduled) {
      const key = scheduleKey(project.id, automation.id, now)
      if (lastScheduleRuns.has(key)) {
        continue
      }

      lastScheduleRuns.set(key, true)
      void runTriggeredAutomation({
        automation,
        projectId: project.id,
        reason: `schedule:${automation.cron}`,
        log,
      })
    }
  }
}

export async function runAutomationById({ automationId, projectId, input, log }) {
  const automation = await getAutomationDefinition(automationId, { projectId })

  if (!automation) {
    return null
  }

  return runAutomation({ automation, projectId, input, log })
}
