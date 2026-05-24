import type { ReactNode } from "react"
import { ArrowRight01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

export type ThoughtStep = {
  id: string
  type: "context" | "tool" | "run_completed"
  status: "running" | "completed"
  name?: string
  input?: string
  output?: string
  payload?: string
}

export type ThoughtRun = {
  id: string
  userMessageId: string
  status: "running" | "completed" | "error"
  isOpen: boolean
  openStepId: string | null
  steps: ThoughtStep[]
}

type ChatThoughtProps = {
  thought: ThoughtRun
  onStepToggle: (stepId: string, open: boolean) => void
  onThoughtToggle: (open: boolean) => void
}

function parseJsonRecord(value?: string) {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as unknown

    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      return null
    }

    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function formatPayload(value?: string) {
  if (!value) {
    return null
  }

  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function getStringValue(record: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }

  return null
}

function getNumberValue(record: Record<string, unknown> | null, keys: string[]) {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === "number") {
      return value
    }
  }

  return null
}

function getToolStepLabel(step: ThoughtStep) {
  if (step.type === "context") {
    const payload = parseJsonRecord(step.payload)
    const summary = getStringValue(payload, ["summary"])

    return summary ?? step.name ?? "Context"
  }

  const input = parseJsonRecord(step.input)
  const parts = [step.name ?? "tool"]
  const filePath = getStringValue(input, ["file_path", "path", "dir_path", "target_path"])
  const query = getStringValue(input, ["query", "pattern", "q", "search_query"])
  const limit = getNumberValue(input, ["limit", "max_results", "max_output_tokens"])
  const offset = getNumberValue(input, ["offset"])

  if (filePath) {
    parts.push(filePath)
  }

  if (query) {
    parts.push(`query "${query}"`)
  }

  if (limit !== null) {
    parts.push(`limit ${limit}`)
  }

  if (offset !== null) {
    parts.push(`offset ${offset}`)
  }

  return parts.join(" · ")
}

function getRunCompletedMeta(step: ThoughtStep) {
  if (step.type !== "run_completed" || !step.payload) {
    return null
  }

  const payload = parseJsonRecord(step.payload)
  if (!payload) {
    return null
  }

  const parts: string[] = []

  if (typeof payload.model === "string") {
    parts.push(payload.model)
  }

  if (typeof payload.totalTokens === "number") {
    parts.push(`${payload.totalTokens.toLocaleString()} tokens`)
  }

  if (typeof payload.costUsd === "number") {
    parts.push(`$${payload.costUsd.toFixed(4)}`)
  }

  return parts.length > 0 ? parts.join(" · ") : null
}

function ThoughtRow({
  children,
  isActive,
}: {
  children: ReactNode
  isActive?: boolean
}) {
  return (
    <div className="grid grid-cols-[10px_minmax(0,1fr)] gap-3">
      <span
        className={cn(
          "mt-[0.6rem] size-1.5 rounded-full bg-border",
          isActive ? "animate-pulse bg-orange-500" : "bg-border"
        )}
      />
      <div className="min-w-0">{children}</div>
    </div>
  )
}

function ToolStep({
  isOpen,
  onToggle,
  step,
}: {
  isOpen: boolean
  onToggle: (open: boolean) => void
  step: ThoughtStep
}) {
  const input = formatPayload(step.input)
  const output = formatPayload(step.output)

  return (
    <ThoughtRow isActive={step.status === "running"}>
      <Collapsible open={isOpen} onOpenChange={onToggle}>
        <CollapsibleTrigger className="flex w-full items-start gap-2 text-left">
          <HugeiconsIcon
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
              isOpen ? "rotate-90" : ""
            )}
            icon={ArrowRight01Icon}
            strokeWidth={2}
          />
          <div className="min-w-0">
            <div className="break-words text-[13px] leading-6 text-foreground">
              {getToolStepLabel(step)}
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent className="pt-3">
          <div className="space-y-3 pl-5">
            {input ? (
              <div className="rounded-[18px] border border-border/50 bg-muted/25 px-4 py-3">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Input
                </div>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-6 text-foreground/85">
                  {input}
                </pre>
              </div>
            ) : null}

            {output ? (
              <div className="rounded-[18px] border border-border/50 bg-muted/25 px-4 py-3">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  Output
                </div>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-6 text-foreground/85">
                  {output}
                </pre>
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </ThoughtRow>
  )
}

export function ChatThought({ thought, onStepToggle, onThoughtToggle }: ChatThoughtProps) {
  return (
    <div className="max-w-[min(100%,42rem)] px-1 py-1">
      <Collapsible open={thought.isOpen} onOpenChange={onThoughtToggle}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 text-left">
          <HugeiconsIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              thought.isOpen ? "rotate-90" : ""
            )}
            icon={ArrowRight01Icon}
            strokeWidth={2}
          />
          <span className="text-[13px] font-medium text-muted-foreground">Thought..</span>
          {thought.status === "running" ? (
            <span className="size-1.5 animate-pulse rounded-full bg-orange-500" />
          ) : null}
        </CollapsibleTrigger>

        <CollapsibleContent className={cn(thought.steps.length > 0 ? "pt-3" : "")}>
          <div className="space-y-3">
            {thought.steps.map((step) =>
              step.type === "tool" ? (
                <ToolStep
                  key={step.id}
                  isOpen={thought.openStepId === step.id}
                  onToggle={(open) => onStepToggle(step.id, open)}
                  step={step}
                />
              ) : step.type === "context" ? (
                <ThoughtRow key={step.id}>
                  <div className="break-words text-[12px] leading-6 text-muted-foreground">
                    {getToolStepLabel(step)}
                  </div>
                </ThoughtRow>
              ) : (
                <ThoughtRow key={step.id}>
                  <div className="break-words text-[12px] leading-6 text-muted-foreground">
                    {getRunCompletedMeta(step) ?? "Completed"}
                  </div>
                </ThoughtRow>
              )
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
