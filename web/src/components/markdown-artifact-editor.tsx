import { useCallback, useEffect, useRef, useState } from "react"

import { CrepeMarkdownEditor } from "@/components/crepe-markdown-editor"
import type {
  CrepeMarkdownEditorHandle,
  MarkdownCommandFile,
} from "@/components/crepe-markdown-editor"
import { sanitizeMarkdownLinks } from "@/lib/markdown-safety"

export type MarkdownEditorMode = "rich" | "source"

export type MarkdownArtifactEditorActions = {
  delete: () => void
  discard: () => void
  save: () => void
  setMode: (mode: MarkdownEditorMode) => void
}

export type MarkdownArtifactEditorStatus = {
  canDelete: boolean
  canDiscard: boolean
  canSave: boolean
  dirty: boolean
  mode: MarkdownEditorMode
  saving: boolean
  title: string
}

type MarkdownArtifactEditorProps = {
  commandFiles?: MarkdownCommandFile[]
  content: string | undefined
  isLoading: boolean
  isSaving: boolean
  path: string
  title: string
  onDelete?: () => void
  onOpenProjectFile?: (path: string) => void
  onSave: (content: string) => Promise<string>
  onUploadImage?: (file: File) => Promise<string>
  resolveUrl?: (url: string) => string
  onActionsChange?: (actions: MarkdownArtifactEditorActions | null) => void
  onStatusChange?: (status: MarkdownArtifactEditorStatus | null) => void
}

type LoadedMarkdownArtifactEditorProps = Omit<
  MarkdownArtifactEditorProps,
  "content" | "isLoading"
> & {
  content: string
}

function splitFrontmatter(markdown: string) {
  const match = markdown.match(/^(---\r?\n[\s\S]*?\r?\n---)((?:[ \t]*\r?\n)*)/)
  if (!match) {
    return { body: markdown, frontmatter: "", separator: "" }
  }

  return {
    body: markdown.slice(match[0].length),
    frontmatter: match[1],
    separator: match[2] || "\n\n",
  }
}

function stripFrontmatter(markdown: string) {
  return sanitizeMarkdownLinks(splitFrontmatter(markdown).body)
}

function normalizeMilkdownMarkdown(markdown: string) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  let fenceMarker: "`" | "~" | null = null

  return lines
    .map((line) => {
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})/)
      if (fence) {
        const marker = fence[1][0] as "`" | "~"
        fenceMarker = fenceMarker === marker ? null : fenceMarker ?? marker
        return line
      }

      if (!fenceMarker && /^[ \t]*<br\s*\/?>[ \t]*$/i.test(line)) {
        return ""
      }

      return line
    })
    .join("\n")
}

function markdownWithExistingFrontmatter(fullMarkdown: string, body: string) {
  const parsed = splitFrontmatter(fullMarkdown)
  const safeBody = sanitizeMarkdownLinks(body)
  return parsed.frontmatter
    ? `${parsed.frontmatter}${parsed.separator}${safeBody.trimStart()}`
    : safeBody
}

function parseFrontmatter(markdown: string) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const fields: Record<string, string> = {}

  if (!match) {
    return fields
  }

  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)

    if (item) {
      fields[item[1]] = item[2]
        .replace(/^"(.*)"$/, "$1")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
    }
  }

  return fields
}

function formatMetaDate(value?: string) {
  if (!value) {
    return ""
  }

  return new Intl.DateTimeFormat("it-IT", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

export function MarkdownArtifactEditor({
  content,
  isLoading,
  ...props
}: MarkdownArtifactEditorProps) {
  if (isLoading) {
    return (
      <section className="relative mx-auto w-full">
        <div className="markdown-editor">
          <div className="px-4 py-4 text-sm text-muted-foreground">
            Loading...
          </div>
        </div>
      </section>
    )
  }

  return (
    <LoadedMarkdownArtifactEditor
      key={props.path}
      content={content ?? ""}
      {...props}
    />
  )
}

function LoadedMarkdownArtifactEditor({
  commandFiles,
  content,
  isSaving,
  path,
  title,
  onDelete,
  onOpenProjectFile,
  onSave,
  onUploadImage,
  resolveUrl,
  onActionsChange,
  onStatusChange,
}: LoadedMarkdownArtifactEditorProps) {
  const initialFullContent = content
  const initialBody = stripFrontmatter(initialFullContent)
  const metadata = parseFrontmatter(content)
  const editorRef = useRef<CrepeMarkdownEditorHandle>(null)
  const [mode, setMode] = useState<MarkdownEditorMode>("rich")
  const [savedFullContent, setSavedFullContent] = useState(initialFullContent)
  const [draftFullContent, setDraftFullContent] = useState(initialFullContent)
  const [savedBody, setSavedBody] = useState(initialBody)
  const [currentContent, setCurrentContent] = useState(initialBody)
  const deleteRef = useRef(onDelete)
  const discardRef = useRef<() => void>(() => undefined)
  const saveRef = useRef<() => void>(() => undefined)
  const sourceTextareaRef = useRef<HTMLTextAreaElement>(null)
  const switchModeRef = useRef<(mode: MarkdownEditorMode) => void>(() => undefined)

  const isDirty =
    mode === "source"
      ? currentContent !== savedFullContent
      : currentContent !== savedBody || draftFullContent !== savedFullContent
  const canDelete = Boolean(onDelete)
  const canEdit = !isSaving

  const resizeSourceTextarea = useCallback(() => {
    const textarea = sourceTextareaRef.current
    if (!textarea) return

    textarea.style.height = "auto"
    textarea.style.height = `${textarea.scrollHeight}px`
  }, [])

  const handleRichChange = useCallback((markdown: string) => {
    setCurrentContent(normalizeMilkdownMarkdown(markdown))
  }, [setCurrentContent])

  function switchMode(nextMode: MarkdownEditorMode) {
    if (nextMode === mode) {
      return
    }

    if (nextMode === "source") {
      if (!isDirty) {
        setCurrentContent(savedFullContent)
        setMode("source")
        return
      }

      const markdown = editorRef.current?.getMarkdown() ?? currentContent
      setCurrentContent(
        markdownWithExistingFrontmatter(
          draftFullContent,
          normalizeMilkdownMarkdown(markdown)
        )
      )
      setMode("source")
      return
    }

    const body = stripFrontmatter(currentContent)
    setDraftFullContent(currentContent)
    setCurrentContent(body)
    setMode("rich")
  }

  async function handleSave() {
    const markdown =
      mode === "source"
        ? currentContent
        : markdownWithExistingFrontmatter(
            draftFullContent,
            normalizeMilkdownMarkdown(
              editorRef.current?.getMarkdown() ?? currentContent
            )
          )
    const saved = await onSave(sanitizeMarkdownLinks(markdown))
    const body = stripFrontmatter(saved)
    setSavedFullContent(saved)
    setDraftFullContent(saved)
    setSavedBody(body)
    setCurrentContent(mode === "source" ? saved : body)
    if (mode === "rich") {
      editorRef.current?.setMarkdown(body)
    }
  }

  function handleDiscard() {
    if (mode === "source") {
      setCurrentContent(savedFullContent)
      setDraftFullContent(savedFullContent)
      return
    }
    setDraftFullContent(savedFullContent)
    setCurrentContent(savedBody)
    if (mode === "rich") {
      editorRef.current?.setMarkdown(savedBody)
    }
  }

  useEffect(() => {
    deleteRef.current = onDelete
    discardRef.current = handleDiscard
    saveRef.current = () => void handleSave()
    switchModeRef.current = switchMode
  })

  useEffect(() => {
    onActionsChange?.({
      delete: () => deleteRef.current?.(),
      discard: () => discardRef.current(),
      save: () => saveRef.current(),
      setMode: (nextMode) => switchModeRef.current(nextMode),
    })
    return () => onActionsChange?.(null)
  }, [onActionsChange])

  useEffect(() => {
    onStatusChange?.({
      canDelete,
      canDiscard: isDirty && !isSaving,
      canSave: isDirty && !isSaving,
      dirty: isDirty,
      mode,
      saving: isSaving,
      title,
    })
  }, [canDelete, isDirty, isSaving, mode, onStatusChange, title])

  useEffect(() => () => onStatusChange?.(null), [onStatusChange])

  useEffect(() => {
    if (mode !== "source") return

    resizeSourceTextarea()
  }, [currentContent, mode, resizeSourceTextarea])

  return (
    <section className="relative mx-auto flex min-h-full w-full flex-col">
      <div className="markdown-editor mb-4">
        <div className="flex max-w-full flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate">{path || title}</span>
          {metadata.creator ? <span>{metadata.creator}</span> : null}
          {metadata.created ? (
            <span>{formatMetaDate(metadata.created)}</span>
          ) : null}
        </div>
      </div>

      {mode === "source" ? (
        <div className="markdown-editor markdown-editor--fill">
          <textarea
            className="markdown-source-editor min-h-[60vh] w-full resize-none overflow-hidden bg-transparent pt-0 pb-4 font-mono text-sm leading-7 text-foreground outline-none placeholder:text-muted-foreground"
            disabled={isSaving}
            onChange={(event) => setCurrentContent(event.target.value)}
            ref={sourceTextareaRef}
            spellCheck={false}
            value={currentContent}
          />
        </div>
      ) : (
        <div className="markdown-editor">
          <CrepeMarkdownEditor
            ref={editorRef}
            className="devsync-crepe-editor--tall"
            commandFiles={commandFiles}
            editable={canEdit}
            editorKey={path}
            initialValue={currentContent}
            onChange={handleRichChange}
            onOpenProjectFile={onOpenProjectFile}
            onUploadImage={onUploadImage}
            resolveUrl={resolveUrl}
          />
        </div>
      )}
    </section>
  )
}
