import { lazy, Suspense, useState } from "react"
import type { FormEvent } from "react"
import type { TaskComment } from "@/domain/devsync"
import { Button } from "@/components/ui/button"
const MarkdownViewer = lazy(() => import("@/components/markdown-viewer").then((module) => ({ default: module.MarkdownViewer })))

export function TaskComments({ comments, disabled, descriptionDirty, onSubmit, onRefresh, onOpenProjectFile, resolveUrl }: {
  comments: TaskComment[]
  disabled: boolean
  descriptionDirty: boolean
  onSubmit: (content: string) => Promise<void>
  onRefresh: () => Promise<void>
  onOpenProjectFile: (path: string) => void
  resolveUrl: (url: string) => string
}) {
  const [draft, setDraft] = useState("")
  const [pending, setPending] = useState<"submit" | "refresh" | null>(null)
  const [error, setError] = useState("")
  const busy = disabled || Boolean(pending) || descriptionDirty

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || !draft.trim()) return
    setPending("submit")
    setError("")
    try {
      await onSubmit(draft.trim())
      setDraft("")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not add comment")
    } finally { setPending(null) }
  }

  async function refresh() {
    if (busy) return
    setPending("refresh")
    setError("")
    try { await onRefresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not refresh comments") }
    finally { setPending(null) }
  }

  return (
    <section aria-label="Task comments" className="mx-auto mt-6 max-w-3xl border-t border-border pt-4">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-foreground">Comments ({comments.length})</h2>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void refresh() }}>{pending === "refresh" ? "Refreshing…" : "Refresh"}</Button>
      </div>
      {comments.length ? (
        <div className="space-y-3">
          {comments.map((comment) => (
            <article key={comment.id} className="rounded-md border border-border bg-card p-3">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-medium break-words text-foreground">{comment.author}</span>
                <time className="text-muted-foreground" dateTime={comment.createdAt} title={comment.createdAt}>
                  {new Date(comment.createdAt).toLocaleString()}
                </time>
              </div>
              <Suspense fallback={<p className="whitespace-pre-wrap text-sm text-foreground">{comment.content}</p>}>
                <MarkdownViewer content={comment.content} isLoading={false} onOpenProjectFile={onOpenProjectFile} resolveUrl={resolveUrl} />
              </Suspense>
            </article>
          ))}
        </div>
      ) : <p className="text-sm text-muted-foreground">No comments yet.</p>}
      <form className="mt-4 grid gap-2" onSubmit={(event) => { void submit(event) }}>
        <label className="text-sm font-medium text-foreground" htmlFor="task-comment-content">Add comment</label>
        <textarea
          id="task-comment-content"
          className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
          placeholder="Write a comment…"
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        {descriptionDirty ? <p className="text-xs text-muted-foreground">Save the description before adding or refreshing comments.</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={busy || !draft.trim()}>{pending === "submit" ? "Saving…" : "Add comment"}</Button>
        </div>
      </form>
    </section>
  )
}
