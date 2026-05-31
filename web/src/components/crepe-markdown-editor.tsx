import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import type { MutableRefObject } from "react"
import {
  BorderHorizontalIcon,
  CodeIcon,
  CursorTextIcon,
  FileImageIcon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  LeftToRightBlockQuoteIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
} from "@hugeicons/core-free-icons"
import { CrepeBuilder } from "@milkdown/crepe/builder"
import { blockEdit } from "@milkdown/crepe/feature/block-edit"
import { cursor } from "@milkdown/crepe/feature/cursor"
import { imageBlock } from "@milkdown/crepe/feature/image-block"
import { linkTooltip } from "@milkdown/crepe/feature/link-tooltip"
import { listItem } from "@milkdown/crepe/feature/list-item"
import { placeholder } from "@milkdown/crepe/feature/placeholder"
import { toolbar } from "@milkdown/crepe/feature/toolbar"
import { imageBlockSchema } from "@milkdown/kit/component/image-block"
import { commandsCtx, editorViewCtx } from "@milkdown/kit/core"
import {
  addBlockTypeCommand,
  blockquoteSchema,
  bulletListSchema,
  clearTextInCurrentBlockCommand,
  codeBlockSchema,
  headingSchema,
  hrSchema,
  orderedListSchema,
  paragraphSchema,
  setBlockTypeCommand,
  wrapInBlockTypeCommand,
} from "@milkdown/kit/preset/commonmark"
import { Plugin } from "@milkdown/kit/prose/state"
import { $prose, insert as insertMarkdown, replaceAll } from "@milkdown/kit/utils"
import { Milkdown, MilkdownProvider, useEditor } from "@milkdown/react"
import "@milkdown/crepe/theme/common/style.css"

import { CommandMenu } from "@/components/file-command-menu"
import {
  fileCommandIcon,
  fileMarkdown,
  groupCommandMenuItems,
  userCommandIcon,
  userMarkdown,
  userMentionId,
  userMentionLabel,
} from "@/components/file-command-menu-utils"
import type { CommandMenuItem, MarkdownCommandFile, MarkdownCommandUser } from "@/components/file-command-menu-utils"
import { cn } from "@/lib/utils"
import { markdownProjectFilePath, markdownUserMentionId, safeMarkdownHref } from "@/lib/markdown-safety"
import "@/styles/milkdown-theme.css"

export type { MarkdownCommandFile, MarkdownCommandUser } from "@/components/file-command-menu-utils"

export type CrepeMarkdownEditorHandle = {
  getMarkdown: () => string
  setMarkdown: (markdown: string) => void
  setReadonly: (readonly: boolean) => void
}

type CrepeMarkdownEditorProps = {
  className?: string
  commandFiles?: MarkdownCommandFile[]
  commandUsers?: MarkdownCommandUser[]
  editable: boolean
  editorKey: string
  initialValue: string
  onChange?: (markdown: string) => void
  onOpenProjectFile?: (path: string) => void
  onUploadImage?: (file: File) => Promise<string>
  resolveUrl?: (url: string) => string
}

type CrepeMarkdownBodyProps = CrepeMarkdownEditorProps & {
  crepeRef: MutableRefObject<CrepeBuilder | null>
  markdownRef: MutableRefObject<string>
  onChangeRef: MutableRefObject<((markdown: string) => void) | undefined>
  onOpenProjectFileRef: MutableRefObject<((path: string) => void) | undefined>
  onUploadImageRef: MutableRefObject<
    ((file: File) => Promise<string>) | undefined
  >
  resolveUrlRef: MutableRefObject<((url: string) => string) | undefined>
  suppressMarkdownUpdateRef: MutableRefObject<boolean>
  userEditRef: MutableRefObject<boolean>
}

const slashMenuCommands = [
  { id: "text", label: "Text", icon: CursorTextIcon },
  { id: "h1", label: "Heading 1", icon: Heading01Icon },
  { id: "h2", label: "Heading 2", icon: Heading02Icon },
  { id: "h3", label: "Heading 3", icon: Heading03Icon },
  { id: "bullet-list", label: "Bullet list", icon: LeftToRightListBulletIcon },
  {
    id: "ordered-list",
    label: "Numbered list",
    icon: LeftToRightListNumberIcon,
  },
  { id: "quote", label: "Quote", icon: LeftToRightBlockQuoteIcon },
  { id: "code", label: "Code block", icon: CodeIcon },
  { id: "image", label: "Image", icon: FileImageIcon },
  { id: "divider", label: "Divider", icon: BorderHorizontalIcon },
] as const

type SlashMenuCommandId = (typeof slashMenuCommands)[number]["id"]
type CommandMenuTrigger = "/" | "@"

type SlashMenuState = {
  activeIndex: number
  open: boolean
  query: string
  trigger: CommandMenuTrigger
  x: number
  y: number
}

type LinkPointerEvent = {
  clientX: number
  clientY: number
  preventDefault: () => void
  stopPropagation: () => void
  target: EventTarget | null
}

function projectFilePathFromHref(href: string) {
  return markdownProjectFilePath(href)
}

function handleProjectLinkPointer(
  event: LinkPointerEvent,
  onOpenProjectFile?: (path: string) => void
) {
  const target = event.target instanceof Element ? event.target : null
  const pointTarget = document.elementFromPoint(event.clientX, event.clientY)
  const anchor =
    target?.closest<HTMLAnchorElement>("a[href]") ??
    pointTarget?.closest<HTMLAnchorElement>("a[href]")
  const href = anchor?.getAttribute("href")

  if (!href) return false

  const safeHref = safeMarkdownHref(href)
  if (!safeHref) {
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  if (markdownUserMentionId(safeHref)) {
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  const path = projectFilePathFromHref(safeHref)
  if (!path || !onOpenProjectFile) return false

  event.preventDefault()
  event.stopPropagation()
  onOpenProjectFile(path)
  return true
}

function isBlockHandleAddTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false
  }

  const item = target.closest(".milkdown-block-handle .operation-item")
  return Boolean(
    item &&
      item.parentElement?.querySelector(".operation-item") === item
  )
}

function isImageResizeHandleTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest(".milkdown-image-block .image-resize-handle"))
  )
}

function CrepeMarkdownBody({
  className,
  commandFiles = [],
  commandUsers = [],
  crepeRef,
  editable,
  editorKey,
  initialValue,
  markdownRef,
  onChangeRef,
  onOpenProjectFileRef,
  onUploadImageRef,
  resolveUrlRef,
  suppressMarkdownUpdateRef,
  userEditRef,
}: CrepeMarkdownBodyProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [slashMenu, setSlashMenu] = useState<SlashMenuState>({
    activeIndex: 0,
    open: false,
    query: "",
    trigger: "/",
    x: 0,
    y: 0,
  })

  const { loading } = useEditor(
    (root) => {
      const crepe = new CrepeBuilder({
        root,
        defaultValue: initialValue,
      })
        .addFeature(listItem)
        .addFeature(linkTooltip)
        .addFeature(imageBlock, {
          onUpload: async (file) => {
            if (onUploadImageRef.current) {
              return onUploadImageRef.current(file)
            }

            return URL.createObjectURL(file)
          },
          proxyDomURL: (url) => {
            const safeUrl = safeMarkdownHref(url)
            return safeUrl ? resolveUrlRef.current?.(safeUrl) ?? safeUrl : ""
          },
        })
        .addFeature(cursor)
        .addFeature(blockEdit, {
          advancedGroup: null,
          listGroup: null,
          textGroup: null,
        })
        .addFeature(placeholder)
        .addFeature(toolbar)
      const projectLinkPlugin = $prose(
        () =>
          new Plugin({
            props: {
              handleDOMEvents: {
                click: (_, event) =>
                  handleProjectLinkPointer(event, onOpenProjectFileRef.current),
                mousedown: (_, event) =>
                  handleProjectLinkPointer(event, onOpenProjectFileRef.current),
              },
            },
          })
      )

      crepe.editor.use(projectLinkPlugin)

      crepe.setReadonly(!editable)
      crepe.on((listener) => {
        listener.markdownUpdated((_, markdown) => {
          markdownRef.current = markdown

          if (suppressMarkdownUpdateRef.current) {
            suppressMarkdownUpdateRef.current = false
            return
          }

          if (!userEditRef.current) {
            return
          }

          onChangeRef.current?.(markdown)
        })
      })

      crepeRef.current = crepe
      markdownRef.current = initialValue

      return crepe
    },
    [editorKey]
  )

  useEffect(() => {
    crepeRef.current?.setReadonly(!editable)
  }, [crepeRef, editable])

  useEffect(() => {
    return () => {
      if (crepeRef.current) {
        crepeRef.current = null
      }
    }
  }, [crepeRef])

  const canOpenCommandMenu = useCallback((trigger: CommandMenuTrigger) => {
    try {
      return (
        crepeRef.current?.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const { selection } = view.state

          if (!selection.empty) return false

          const parent = selection.$from.parent

          if (trigger === "@") {
            return parent.type.name !== "code_block"
          }

          return (
            ["paragraph", "heading"].includes(parent.type.name) &&
            selection.$from.parentOffset === 0
          )
        }) ?? false
      )
    } catch {
      return false
    }
  }, [crepeRef])

  const canOpenAtMenuAtSelection = useCallback(() => {
    try {
      return (
        crepeRef.current?.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const { selection } = view.state

          if (!selection.empty) return false

          const parent = selection.$from.parent
          if (parent.type.name === "code_block") return false

          const textBefore = parent.textBetween(
            0,
            selection.$from.parentOffset,
            "\n",
            "\n"
          )
          if (!textBefore.endsWith("@")) return false

          const charBeforeTrigger = textBefore.at(-2)
          return !charBeforeTrigger || /\s/.test(charBeforeTrigger)
        }) ?? false
      )
    } catch {
      return false
    }
  }, [crepeRef])

  const getSlashMenuPosition = useCallback(() => {
    const root = rootRef.current
    if (!root) return { x: 8, y: 8 }

    const clampPosition = (x: number, y: number) => {
      const maxX = Math.max(root.clientWidth - 288, 8)
      return {
        x: Math.min(Math.max(x, 8), maxX),
        y: Math.max(y, 8),
      }
    }

    const rootRect = root.getBoundingClientRect()

    try {
      const position = crepeRef.current?.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        const coords = view.coordsAtPos(view.state.selection.from)
        return clampPosition(coords.left - rootRect.left, coords.bottom - rootRect.top + 8)
      })

      if (position) {
        return position
      }
    } catch {
      // Fall back to DOM selection below.
    }

    const selection = window.getSelection()
    const range = selection?.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : null
    range?.collapse(false)

    const rect = range?.getClientRects()[0] ?? range?.getBoundingClientRect()
    return clampPosition(rect ? rect.left - rootRect.left : 8, rect ? rect.bottom - rootRect.top + 8 : 8)
  }, [crepeRef])

  const closeSlashMenu = useCallback(() => {
    setSlashMenu((current) =>
      current.open ? { ...current, open: false } : current
    )
  }, [])

  const openCommandMenu = useCallback(
    (trigger: CommandMenuTrigger) => {
      if (!editable) return

      const canOpen =
        trigger === "@"
          ? canOpenAtMenuAtSelection()
          : canOpenCommandMenu(trigger)
      if (!canOpen) return

      const position = getSlashMenuPosition()
      setSlashMenu({
        activeIndex: 0,
        open: true,
        query: "",
        trigger,
        x: position.x,
        y: position.y,
      })
    },
    [
      canOpenAtMenuAtSelection,
      canOpenCommandMenu,
      editable,
      getSlashMenuPosition,
    ]
  )

  const insertFileMarkdown = useCallback(
    (markdown: string) => {
      closeSlashMenu()
      userEditRef.current = true

      try {
        crepeRef.current?.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx)
          const { state } = view
          const { selection } = state
          const textBefore = selection.$from.parent.textBetween(
            0,
            selection.$from.parentOffset,
            "\n",
            "\n"
          )
          const token = textBefore.match(/(?:^|\s)(@[^\s@]*)$/)?.[1]

          if (token && selection.from >= token.length) {
            view.dispatch(
              state.tr
                .delete(selection.from - token.length, selection.from)
                .scrollIntoView()
            )
          }

          insertMarkdown(markdown, true)(ctx)
          view.focus()
        })
      } catch {
        closeSlashMenu()
      }
    },
    [closeSlashMenu, crepeRef, userEditRef]
  )

  const runSlashCommand = useCallback(
    (commandId: SlashMenuCommandId) => {
      closeSlashMenu()
      userEditRef.current = true

      try {
        crepeRef.current?.editor.action((ctx) => {
          const commands = ctx.get(commandsCtx)
          const view = ctx.get(editorViewCtx)

          commands.call(clearTextInCurrentBlockCommand.key)

          if (commandId === "text") {
            commands.call(setBlockTypeCommand.key, {
              nodeType: paragraphSchema.type(ctx),
            })
          }

          if (commandId === "h1" || commandId === "h2" || commandId === "h3") {
            commands.call(setBlockTypeCommand.key, {
              attrs: { level: Number(commandId.slice(1)) },
              nodeType: headingSchema.type(ctx),
            })
          }

          if (commandId === "bullet-list") {
            commands.call(wrapInBlockTypeCommand.key, {
              nodeType: bulletListSchema.type(ctx),
            })
          }

          if (commandId === "ordered-list") {
            commands.call(wrapInBlockTypeCommand.key, {
              nodeType: orderedListSchema.type(ctx),
            })
          }

          if (commandId === "quote") {
            commands.call(wrapInBlockTypeCommand.key, {
              nodeType: blockquoteSchema.type(ctx),
            })
          }

          if (commandId === "code") {
            commands.call(setBlockTypeCommand.key, {
              nodeType: codeBlockSchema.type(ctx),
            })
          }

          if (commandId === "image") {
            commands.call(addBlockTypeCommand.key, {
              nodeType: imageBlockSchema.type(ctx),
            })
          }

          if (commandId === "divider") {
            commands.call(addBlockTypeCommand.key, {
              nodeType: hrSchema.type(ctx),
            })
          }

          view.focus()
        })
      } catch {
        closeSlashMenu()
      }
    },
    [closeSlashMenu, crepeRef, userEditRef]
  )

  const filteredMenuItems = useMemo(() => {
    const query = slashMenu.query.trim().toLowerCase()
    const items =
      slashMenu.trigger === "/"
        ? slashMenuCommands.map<CommandMenuItem>((command) => ({
            group: "blocks",
            groupLabel: "Blocks",
            icon: command.icon,
            id: `block:${command.id}`,
            label: command.label,
            onRun: () => runSlashCommand(command.id),
          }))
        : [
            ...commandUsers.map<CommandMenuItem>((user) => ({
              group: "users",
              groupLabel: "Users",
              icon: userCommandIcon(),
              id: `user:${userMentionId(user)}`,
              label: userMentionLabel(user),
              onRun: () => insertFileMarkdown(userMarkdown(user)),
              subtitle: user.email || user.username,
            })),
            ...commandFiles.map<CommandMenuItem>((file) => ({
              group: "files",
              groupLabel: "Files",
              icon: fileCommandIcon(file),
              id: `file:${file.path}`,
              label: file.title?.trim() || file.name,
              onRun: () => insertFileMarkdown(fileMarkdown(file)),
              subtitle: file.path,
            })),
          ]

    if (!query) return items

    return items.filter((item) =>
      `${item.label} ${item.subtitle ?? ""}`.toLowerCase().includes(query)
    )
  }, [
    commandFiles,
    commandUsers,
    insertFileMarkdown,
    runSlashCommand,
    slashMenu.query,
    slashMenu.trigger,
  ])
  const menuGroups = useMemo(
    () => groupCommandMenuItems(filteredMenuItems),
    [filteredMenuItems]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null
      if (!editable || !target?.closest(".ProseMirror")) return

      if (slashMenu.open) {
        if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          closeSlashMenu()
          return
        }

        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          event.stopPropagation()
          const delta = event.key === "ArrowDown" ? 1 : -1
          const commandCount = filteredMenuItems.length

          setSlashMenu((current) => ({
            ...current,
            activeIndex:
              commandCount === 0
                ? 0
                : (current.activeIndex + delta + commandCount) % commandCount,
          }))
          return
        }

        if (event.key === "Enter") {
          event.preventDefault()
          event.stopPropagation()
          const command = filteredMenuItems[slashMenu.activeIndex]
          command?.onRun()
          return
        }

        if (event.key === "Backspace") {
          event.preventDefault()
          event.stopPropagation()

          if (!slashMenu.query) {
            closeSlashMenu()
            return
          }

          setSlashMenu((current) => ({
            ...current,
            activeIndex: 0,
            query: current.query.slice(0, -1),
          }))
          return
        }

        if (
          event.key.length === 1 &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          event.preventDefault()
          event.stopPropagation()
          setSlashMenu((current) => ({
            ...current,
            activeIndex: 0,
            query: `${current.query}${event.key}`,
          }))
          return
        }
      }

      if (
        event.key !== "/" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !canOpenCommandMenu("/")
      ) {
        return
      }

      event.preventDefault()
      event.stopPropagation()
      openCommandMenu("/")
    },
    [
      canOpenCommandMenu,
      closeSlashMenu,
      editable,
      filteredMenuItems,
      openCommandMenu,
      slashMenu.activeIndex,
      slashMenu.open,
      slashMenu.query,
    ]
  )

  const handleLinkPointer = useCallback(
    (event: LinkPointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const pointTarget = document.elementFromPoint(event.clientX, event.clientY)
      const anchor =
        target?.closest<HTMLAnchorElement>("a[href]") ??
        pointTarget?.closest<HTMLAnchorElement>("a[href]")
      const href = anchor?.getAttribute("href")

      if (!href) return

      const safeHref = safeMarkdownHref(href)
      if (!safeHref) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      if (markdownUserMentionId(safeHref)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      const path = projectFilePathFromHref(safeHref)
      if (!path || !onOpenProjectFileRef.current) return

      event.preventDefault()
      event.stopPropagation()
      onOpenProjectFileRef.current(path)
    },
    [onOpenProjectFileRef]
  )

  const handleBeforeInput = useCallback(
    (event: React.FormEvent<HTMLDivElement>) => {
      userEditRef.current = true

      const inputEvent = event.nativeEvent as InputEvent
      if (inputEvent.data !== "@") return

      window.setTimeout(() => openCommandMenu("@"), 0)
    },
    [openCommandMenu, userEditRef]
  )

  const handleBlockHandlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isBlockHandleAddTarget(event.target)) return

      userEditRef.current = true
      window.setTimeout(() => openCommandMenu("/"), 0)
    },
    [openCommandMenu, userEditRef]
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (isImageResizeHandleTarget(event.target)) {
        userEditRef.current = true
      }
    },
    [userEditRef]
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    root.addEventListener("click", handleLinkPointer, true)
    root.addEventListener("mousedown", handleLinkPointer, true)
    return () => {
      root.removeEventListener("click", handleLinkPointer, true)
      root.removeEventListener("mousedown", handleLinkPointer, true)
    }
  }, [handleLinkPointer])

  return (
    <div
      className={cn("devsync-crepe-editor", className, loading && "opacity-70")}
      onClickCapture={handleLinkPointer}
      onBeforeInputCapture={handleBeforeInput}
      onDropCapture={() => {
        userEditRef.current = true
      }}
      onKeyDownCapture={handleKeyDown}
      onMouseDownCapture={handleLinkPointer}
      onPasteCapture={() => {
        userEditRef.current = true
      }}
      onPointerDownCapture={handlePointerDown}
      onPointerUpCapture={handleBlockHandlePointerUp}
      ref={rootRef}
    >
      <Milkdown />
      {slashMenu.open ? (
        <CommandMenu
          activeIndex={slashMenu.activeIndex}
          groups={menuGroups}
          onActiveIndexChange={(activeIndex) =>
            setSlashMenu((current) => ({ ...current, activeIndex }))
          }
          onRun={(item) => item.onRun()}
          x={slashMenu.x}
          y={slashMenu.y}
        />
      ) : null}
      {loading ? (
        <div className="px-1 py-4 text-sm text-muted-foreground">
          Loading...
        </div>
      ) : null}
    </div>
  )
}

export const CrepeMarkdownEditor = forwardRef<
  CrepeMarkdownEditorHandle,
  CrepeMarkdownEditorProps
>(function CrepeMarkdownEditor(
  {
    className,
    commandFiles,
    commandUsers,
    editable,
    editorKey,
    initialValue,
    onChange,
    onOpenProjectFile,
    onUploadImage,
    resolveUrl,
  },
  ref
) {
  const crepeRef = useRef<CrepeBuilder | null>(null)
  const markdownRef = useRef(initialValue)
  const onChangeRef = useRef(onChange)
  const onOpenProjectFileRef = useRef(onOpenProjectFile)
  const onUploadImageRef = useRef(onUploadImage)
  const resolveUrlRef = useRef(resolveUrl)
  const suppressMarkdownUpdateRef = useRef(false)
  const userEditRef = useRef(false)

  useEffect(() => {
    suppressMarkdownUpdateRef.current = false
    userEditRef.current = false
  }, [editorKey, initialValue])

  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    onOpenProjectFileRef.current = onOpenProjectFile
  }, [onOpenProjectFile])

  useEffect(() => {
    onUploadImageRef.current = onUploadImage
  }, [onUploadImage])

  useEffect(() => {
    resolveUrlRef.current = resolveUrl
  }, [resolveUrl])

  useImperativeHandle(
    ref,
    () => ({
      getMarkdown: () => crepeRef.current?.getMarkdown() ?? markdownRef.current,
      setMarkdown: (markdown: string) => {
        markdownRef.current = markdown
        suppressMarkdownUpdateRef.current = true
        try {
          crepeRef.current?.editor.action(replaceAll(markdown, true))
        } catch {
          crepeRef.current = null
        } finally {
          window.setTimeout(() => {
            suppressMarkdownUpdateRef.current = false
          }, 0)
        }
      },
      setReadonly: (readonly: boolean) => {
        crepeRef.current?.setReadonly(readonly)
      },
    }),
    []
  )

  return (
    <MilkdownProvider>
      <CrepeMarkdownBody
        className={className}
        commandFiles={commandFiles}
        commandUsers={commandUsers}
        crepeRef={crepeRef}
        editable={editable}
        editorKey={editorKey}
        initialValue={initialValue}
        markdownRef={markdownRef}
        onChangeRef={onChangeRef}
        onOpenProjectFileRef={onOpenProjectFileRef}
        onUploadImageRef={onUploadImageRef}
        resolveUrlRef={resolveUrlRef}
        suppressMarkdownUpdateRef={suppressMarkdownUpdateRef}
        userEditRef={userEditRef}
      />
    </MilkdownProvider>
  )
})
