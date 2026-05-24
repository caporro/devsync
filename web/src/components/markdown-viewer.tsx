import { CrepeMarkdownEditor } from "@/components/crepe-markdown-editor"
import { sanitizeMarkdownLinks } from "@/lib/markdown-safety"

function stripFrontmatter(markdown: string) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
}

export function MarkdownViewer({
  content,
  isLoading,
  onOpenProjectFile,
  resolveUrl,
}: {
  content: string | undefined
  isLoading: boolean
  onOpenProjectFile?: (path: string) => void
  resolveUrl?: (url: string) => string
}) {
  const body = sanitizeMarkdownLinks(stripFrontmatter(content ?? ""))

  return (
    <section className="mx-auto w-full">
      <div className="markdown-editor">
        {isLoading ? (
          <div className="px-1 py-4 text-sm text-muted-foreground">
            Loading...
          </div>
        ) : (
          <CrepeMarkdownEditor
            key={body}
            editable={false}
            editorKey={body}
            initialValue={body}
            onOpenProjectFile={onOpenProjectFile}
            resolveUrl={resolveUrl}
          />
        )}
      </div>
    </section>
  )
}
