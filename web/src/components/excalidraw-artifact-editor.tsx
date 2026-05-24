import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import { Excalidraw, serializeAsJSON } from "@excalidraw/excalidraw"
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types"
import "@excalidraw/excalidraw/index.css"

export type ExcalidrawArtifactActions = {
  rename: (title: string) => Promise<void>
  save: () => Promise<void>
}

export type ExcalidrawArtifactStatus = {
  canSave: boolean
  dirty: boolean
  title: string
}

type ExcalidrawArtifactEditorProps = {
  content: string | undefined
  isLoading: boolean
  path: string
  title: string
  onActionsChange: (actions: ExcalidrawArtifactActions | null) => void
  onDirtyChange: (dirty: boolean) => void
  onStatusChange: (status: ExcalidrawArtifactStatus | null) => void
  onSave: (content: string, title?: string) => Promise<string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function emptyExcalidrawDocument(name: string) {
  return JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "devsync",
      elements: [],
      appState: {
        name,
      },
      files: {},
    },
    null,
    2
  )
}

function fingerprintExcalidrawContent(content: string) {
  try {
    const data = JSON.parse(content) as unknown
    if (isRecord(data) && isRecord(data.appState)) {
      delete data.appState.name
    }

    return JSON.stringify(data)
  } catch {
    return content.trim()
  }
}

function titleFromExcalidrawContent(content: string, fallback: string) {
  try {
    const data = JSON.parse(content) as unknown
    if (isRecord(data) && isRecord(data.appState)) {
      return String(data.appState.name ?? fallback).trim() || fallback
    }
  } catch {
    return fallback
  }

  return fallback
}

function parseInitialData(content: string | undefined, title: string): ExcalidrawInitialDataState {
  const raw = content?.trim() || emptyExcalidrawDocument(title)
  const data = JSON.parse(raw) as unknown

  if (!isRecord(data)) {
    throw new Error("Invalid Excalidraw file")
  }

  const appState = isRecord(data.appState) ? data.appState : {}

  return {
    elements: Array.isArray(data.elements)
      ? data.elements as ExcalidrawInitialDataState["elements"]
      : [],
    appState: {
      ...appState,
      name: String(appState.name ?? title),
    } as ExcalidrawInitialDataState["appState"],
    files: isRecord(data.files) ? data.files as BinaryFiles : {},
    scrollToContent: true,
  }
}

function useResolvedExcalidrawTheme() {
  const getTheme = () => document.documentElement.classList.contains("dark") ? "dark" : "light"
  const [theme, setTheme] = useState<"dark" | "light">(getTheme)

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(getTheme()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return theme
}

export function ExcalidrawArtifactEditor({
  content,
  isLoading,
  path,
  title,
  onActionsChange,
  onDirtyChange,
  onStatusChange,
  onSave,
}: ExcalidrawArtifactEditorProps) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const initialContent = content ?? emptyExcalidrawDocument(title)
  const [sceneTitle, setSceneTitle] = useState(() => titleFromExcalidrawContent(initialContent, title))
  const lastSavedFingerprintRef = useRef(fingerprintExcalidrawContent(initialContent))
  const currentContentRef = useRef(initialContent)
  const hasSeenInitialChangeRef = useRef(false)
  const onDirtyChangeRef = useRef(onDirtyChange)
  const onStatusChangeRef = useRef(onStatusChange)
  const theme = useResolvedExcalidrawTheme()

  const parsed = useMemo((): { data: ExcalidrawInitialDataState | null; error: string | null } => {
    try {
      return { data: parseInitialData(content, title), error: null }
    } catch (error) {
      return {
        data: null,
        error: error instanceof Error ? error.message : "Invalid Excalidraw file",
      }
    }
  }, [content, title])

  useEffect(() => {
    const nextContent = content ?? emptyExcalidrawDocument(title)
    lastSavedFingerprintRef.current = fingerprintExcalidrawContent(nextContent)
    currentContentRef.current = nextContent
  }, [content, title])

  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange
  }, [onDirtyChange])

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange
  }, [onStatusChange])

  useEffect(() => {
    onDirtyChangeRef.current(isDirty)
  }, [isDirty])

  useEffect(() => () => {
    onDirtyChangeRef.current(false)
    onStatusChangeRef.current(null)
    onActionsChange(null)
  }, [onActionsChange])

  useEffect(() => {
    onStatusChangeRef.current({
      canSave: Boolean(api),
      dirty: isDirty,
      title: sceneTitle,
    })
  }, [api, isDirty, sceneTitle])

  useEffect(() => {
    if (!isDirty) {
      return undefined
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""
    }

    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => window.removeEventListener("beforeunload", handleBeforeUnload)
  }, [isDirty])

  const handleChange = useCallback((
    elements: readonly ExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles
  ) => {
    const nextContent = serializeAsJSON(elements, appState, files, "local")
    const nextTitle = String(appState.name ?? title).trim() || title
    currentContentRef.current = nextContent
    setSceneTitle(nextTitle)
    const nextFingerprint = fingerprintExcalidrawContent(nextContent)

    if (!hasSeenInitialChangeRef.current) {
      hasSeenInitialChangeRef.current = true
      lastSavedFingerprintRef.current = nextFingerprint
      setIsDirty(false)
      return
    }

    setIsDirty(nextFingerprint !== lastSavedFingerprintRef.current)
  }, [title])

  const handleSave = useCallback(async () => {
    if (!api) {
      return
    }

    const nextContent = currentContentRef.current || serializeAsJSON(
      api.getSceneElements(),
      api.getAppState(),
      api.getFiles(),
      "local"
    )
    const savedContent = await onSave(nextContent, sceneTitle)
    lastSavedFingerprintRef.current = fingerprintExcalidrawContent(savedContent)
    currentContentRef.current = nextContent
    setIsDirty(false)
  }, [api, onSave, sceneTitle])

  const handleRename = useCallback(async (nextTitle: string) => {
    if (!api) {
      return
    }

    const cleanTitle = nextTitle.trim() || title
    const nextContent = serializeAsJSON(
      api.getSceneElements(),
      {
        ...api.getAppState(),
        name: cleanTitle,
      },
      api.getFiles(),
      "local"
    )

    api.updateScene({ appState: { name: cleanTitle } })
    setSceneTitle(cleanTitle)
    const savedContent = await onSave(nextContent, cleanTitle)
    lastSavedFingerprintRef.current = fingerprintExcalidrawContent(savedContent)
    currentContentRef.current = nextContent
    setIsDirty(false)
  }, [api, onSave, title])

  useEffect(() => {
    onActionsChange(api ? { rename: handleRename, save: handleSave } : null)
  }, [api, handleRename, handleSave, onActionsChange])

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading...</div>
  }

  if (parsed.error || !parsed.data) {
    return (
      <section className="mx-auto max-w-3xl">
        <h1 className="truncate text-xl font-semibold text-foreground">{title}</h1>
        <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {parsed.error ?? "Invalid Excalidraw file"}
        </div>
      </section>
    )
  }

  return (
    <section aria-label={path} className="flex h-full min-h-0 flex-col">
      <div className="min-h-[520px] flex-1 overflow-hidden bg-card">
        <Excalidraw
          aiEnabled={false}
          excalidrawAPI={(nextApi) => setApi(nextApi)}
          handleKeyboardGlobally={false}
          initialData={parsed.data}
          name={title}
          theme={theme}
          UIOptions={{
            canvasActions: {
              export: false,
              loadScene: false,
              saveAsImage: false,
              saveToActiveFile: false,
            },
            tools: {
              image: true,
            },
          }}
          onChange={handleChange}
        />
      </div>
    </section>
  )
}
