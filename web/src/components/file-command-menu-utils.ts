import {
  File01Icon,
  FileCodeIcon,
  FileImageIcon,
  UserIcon,
} from "@hugeicons/core-free-icons"
import type { IconSvgElement } from "@hugeicons/react"

export type MarkdownCommandFile = {
  kind?: string
  name: string
  path: string
  title?: string | null
}

export type MarkdownCommandUser = {
  email?: string
  name?: string
  username?: string
}

export type CommandMenuItem = {
  group: string
  groupLabel: string
  icon: IconSvgElement
  id: string
  label: string
  onRun: () => void
  subtitle?: string
}

export type CommandMenuGroup = {
  id: string
  items: Array<CommandMenuItem & { index: number }>
  label: string
}

const imageExtensions = new Set([".apng", ".avif", ".gif", ".jpg", ".jpeg", ".png", ".webp"])
const codeExtensions = new Set([".css", ".js", ".json", ".jsx", ".ts", ".tsx", ".yml", ".yaml"])

function extensionOf(path: string) {
  const index = path.lastIndexOf(".")
  return index === -1 ? "" : path.slice(index).toLowerCase()
}

export function fileCommandIcon(file: MarkdownCommandFile) {
  const extension = extensionOf(file.name || file.path)
  if (imageExtensions.has(extension)) return FileImageIcon
  if (codeExtensions.has(extension)) return FileCodeIcon
  return File01Icon
}

function escapeMarkdownLabel(value: string) {
  return value.replace(/([\\[\]])/g, "\\$1")
}

function encodeMarkdownUrl(value: string) {
  return encodeURI(value).replace(/\(/g, "%28").replace(/\)/g, "%29")
}

export function userMentionId(user: MarkdownCommandUser) {
  return String(user.email || user.username || user.name || "team").trim().toLowerCase() || "team"
}

export function userMentionLabel(user: MarkdownCommandUser) {
  return String(user.name || user.email || user.username || userMentionId(user)).trim()
}

export function userMarkdown(user: MarkdownCommandUser) {
  return `@[${escapeMarkdownLabel(userMentionLabel(user))}](devsync:user:${encodeURIComponent(userMentionId(user))})`
}

export function userCommandIcon() {
  return UserIcon
}

export function fileMarkdown(
  file: MarkdownCommandFile,
  options: { embedImages?: boolean; label?: "title" | "name" } = {}
) {
  const labelSource = options.label === "name" ? file.name : file.title?.trim() || file.name
  const label = escapeMarkdownLabel(labelSource)
  const url = encodeMarkdownUrl(file.path)
  const embedImages = options.embedImages ?? true

  return embedImages && imageExtensions.has(extensionOf(file.name))
    ? `![${label}](${url})`
    : `[${label}](${url})`
}

export function groupCommandMenuItems(items: CommandMenuItem[]) {
  const groups: CommandMenuGroup[] = []

  for (const item of items) {
    let group = groups.find((current) => current.id === item.group)
    if (!group) {
      group = { id: item.group, items: [], label: item.groupLabel }
      groups.push(group)
    }

    group.items.push({ ...item, index: groups.reduce((count, current) => count + current.items.length, 0) })
  }

  return groups
}
