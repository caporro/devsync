import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { searchDocuments } from "@/lib/api"
import type { DocumentSearchResult, ProjectSummary } from "@/domain/devsync"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"

export function DocumentSearch({ open, onOpenChange, onSelect, projects }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (document: DocumentSearchResult) => void
  projects: ProjectSummary[]
}) {
  const [draft, setDraft] = useState({ query: "", projectId: "", type: "", tag: "", author: "" })
  const [filters, setFilters] = useState(draft)
  const results = useQuery({
    queryKey: ["document-search", filters],
    queryFn: () => searchDocuments(filters),
    enabled: open && Boolean(filters.query.trim()),
    staleTime: 0,
  })
  const selectClass = "h-9 min-w-0 rounded-md border border-input bg-background px-2 text-sm"
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Search documents</DialogTitle>
        <DialogDescription>Search projects and shared docs. Every word must match; results are ordered by relevance.</DialogDescription>
      </DialogHeader>
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault()
        if (JSON.stringify(draft) === JSON.stringify(filters)) void results.refetch()
        else setFilters({ ...draft })
      }}>
        <div className="flex gap-2">
          <Input aria-label="Search words" placeholder="Search words…" value={draft.query} onChange={(event) => setDraft({ ...draft, query: event.target.value })} />
          <Button disabled={!draft.query.trim() || results.isFetching} type="submit">Search</Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <select aria-label="Project filter" className={selectClass} value={draft.projectId} onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}>
            <option value="">All projects and docs</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <select aria-label="Document type filter" className={selectClass} value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
            <option value="">All types</option>
            {[["resources", "Resources"], ["work", "Work"], ["tasks", "Tasks"], ["logs", "Activity logs"], ["readme", "Project notes"], ["docs", "Shared docs"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <Input aria-label="Tag filter" placeholder="Tag (exact)" value={draft.tag} onChange={(event) => setDraft({ ...draft, tag: event.target.value })} />
          <Input aria-label="Author filter" placeholder="Author email (exact)" value={draft.author} onChange={(event) => setDraft({ ...draft, author: event.target.value })} />
        </div>
      </form>
      <div aria-live="polite" className="max-h-[50vh] space-y-2 overflow-y-auto">
        {results.isFetching ? <p className="text-sm text-muted-foreground">Searching…</p> : null}
        {results.error ? <p className="text-sm text-destructive">{results.error.message}</p> : null}
        {!results.isFetching && results.data?.items.length === 0 ? <p className="text-sm text-muted-foreground">No documents match all words and filters.</p> : null}
        {results.data?.items.map((document) => <button className="block w-full rounded-md border p-3 text-left hover:bg-muted" key={document.id} onClick={() => onSelect(document)} type="button">
          <span className="block text-sm font-medium">{document.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{document.projectId || `docs/${document.docId}`} / {document.path}</span>
          <span className="mt-1 block line-clamp-3 text-sm text-muted-foreground">{document.excerpt}</span>
        </button>)}
      </div>
    </DialogContent>
  </Dialog>
}
