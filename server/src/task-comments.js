const SECTION = "<!-- devsync:task-comments -->"
const NAMESPACE = "<!-- devsync:task-comment"
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/

function invalid(message = "Invalid task comment section. Inspect the task Markdown.") {
  return Object.assign(new Error(message), { statusCode: 400 })
}

function heading(comment) {
  const author = comment.author
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|]/g, "\\$&")
  return `### ${comment.createdAt} — ${author}`
}

function separator(content) {
  return content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n"
}

export function assertNoTaskCommentMarkers(content) {
  if (String(content).includes(NAMESPACE)) {
    throw invalid("Task comment markers are reserved. Use append_task_comment to add a comment.")
  }
}

export function splitTaskComments(content) {
  const raw = String(content)
  const headerLength = raw.match(FRONTMATTER)?.[0].length ?? 0
  const body = raw.slice(headerLength)
  const offset = body.indexOf(SECTION)
  if (offset === -1) {
    assertNoTaskCommentMarkers(body)
    return { descriptionContent: raw, section: "", comments: [] }
  }
  if ((offset > 0 && body[offset - 1] !== "\n") || body.indexOf(SECTION, offset + SECTION.length) !== -1) throw invalid()
  const section = body.slice(offset)
  const markers = [...section.matchAll(/^<!-- devsync:task-comment (\{[^\r\n]*\}) -->\r?\n/gm)]
  if (!markers.length || section.slice(SECTION.length, markers[0].index).trim() !== "## Comments" ||
    (body.match(/<!-- devsync:task-comment/g) ?? []).length !== markers.length + 1) throw invalid()
  const ids = new Set()
  const comments = markers.map((marker, index) => {
    let metadata
    try {
      metadata = JSON.parse(marker[1])
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(metadata.id) || ids.has(metadata.id) ||
        typeof metadata.author !== "string" || !metadata.author.trim() || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(metadata.author) ||
        typeof metadata.createdAt !== "string" || new Date(metadata.createdAt).toISOString() !== metadata.createdAt) throw invalid()
    } catch { throw invalid() }
    ids.add(metadata.id)
    const chunk = section.slice(marker.index + marker[0].length, markers[index + 1]?.index)
    const label = heading(metadata)
    if (!chunk.startsWith(`${label}\n`) && !chunk.startsWith(`${label}\r\n`)) throw invalid()
    const text = chunk.slice(label.length).trim()
    if (!text) throw invalid()
    return { id: metadata.id, author: metadata.author, createdAt: metadata.createdAt, content: text }
  })
  return { descriptionContent: raw.slice(0, headerLength + offset), section, comments }
}

export function preserveTaskComments(existing, incoming) {
  const before = splitTaskComments(existing)
  const next = splitTaskComments(incoming)
  if (next.section && next.section.trimEnd() !== before.section.trimEnd()) {
    throw invalid("Task comments are append-only. Edit the description or use append_task_comment.")
  }
  return before.section
    ? `${next.descriptionContent}${separator(next.descriptionContent)}${before.section}`
    : next.descriptionContent
}

export function withTaskComment(content, comment) {
  assertNoTaskCommentMarkers(comment.content)
  const parsed = splitTaskComments(content)
  const metadata = JSON.stringify({ id: comment.id, author: comment.author, createdAt: comment.createdAt })
    .replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
  const block = `<!-- devsync:task-comment ${metadata} -->\n${heading(comment)}\n\n${comment.content}\n`
  return `${content}${separator(content)}${parsed.section ? "" : `${SECTION}\n## Comments\n\n`}${block}`
}
