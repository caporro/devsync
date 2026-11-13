import { useState } from "react"
import type { Task } from "@/domain/devsync"
import { Input } from "@/components/ui/input"

export function TaskTagsEditor({
  value,
  disabled,
  onChange
}: {
  value: string[]
  disabled?: boolean
  onChange: (tags: string[]) => void | Promise<void>
}) {
  const [draft, setDraft] = useState("")

  function addTag() {
    if (disabled) return
    const tag = draft.trim()
    if (!tag || value.includes(tag)) { setDraft(""); return }
    setDraft("")
    void Promise.resolve(onChange([...value, tag])).catch(() => setDraft(tag))
  }

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      onBlur={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) addTag()
      }}
    >
      {[...new Set(value)].map((tag) => (
        <span key={tag} className="inline-flex max-w-full items-center gap-1 rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-foreground">
          <span className="truncate" title={tag}>{tag}</span>
          <button
            type="button"
            aria-label={`Remove tag ${tag}`}
            className="text-muted-foreground hover:text-foreground"
            disabled={disabled}
            onClick={() => { void Promise.resolve(onChange(value.filter((item) => item !== tag))).catch(() => {}) }}
          >×</button>
        </span>
      ))}
      <Input
        aria-label="Add task tag"
        placeholder="Add tag (Enter)"
        className="h-7 w-36 min-w-24 flex-1 text-xs"
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); addTag() }
        }}
      />
    </div>
  )
}

export function TaskTagFilter({ tasks, value, onChange }: {
  tasks: Task[]
  value: string
  onChange: (tag: string) => void
}) {
  const tags = [...new Set(tasks.flatMap((task) => task.tags ?? []))].sort((a, b) => a.localeCompare(b))
  return (
    <select
      aria-label="Filter by tag"
      className="h-9 max-w-52 rounded-md border border-input bg-background px-3 text-sm text-foreground"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">All tags</option>
      {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
      {value && !tags.includes(value) ? <option value={value}>{value}</option> : null}
    </select>
  )
}

export function TaskTagLabels({ tags }: { tags: string[] }) {
  return tags.length ? (
    <div className="mt-2 flex flex-wrap gap-1">
      {[...new Set(tags)].map((tag) => <span key={tag} title={tag} className="max-w-full truncate rounded border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{tag}</span>)}
    </div>
  ) : null
}
