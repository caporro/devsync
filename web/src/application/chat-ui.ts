import type { Thread } from "@/domain/chat"

const THREAD_TITLE_MAX_LENGTH = 60

export function getThreadLabel(thread: Pick<Thread, "title"> | null | undefined) {
  return thread?.title ?? "Untitled thread"
}

export function getUserFirstName(name: string | null | undefined) {
  const trimmed = name?.trim()
  if (!trimmed) {
    return "there"
  }

  return trimmed.split(/\s+/)[0]
}

export function deriveThreadTitle(content: string) {
  const normalized = content.replace(/\s+/g, " ").trim()
  if (!normalized) {
    return "New chat"
  }

  if (normalized.length <= THREAD_TITLE_MAX_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, THREAD_TITLE_MAX_LENGTH - 3).trimEnd()}...`
}

export function resizeComposer(element: HTMLTextAreaElement) {
  const maxHeight = 160
  element.style.height = "0px"
  element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
  element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden"
}
