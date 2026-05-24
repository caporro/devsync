import fs from "node:fs/promises"

function unquote(value) {
  return String(value).trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1")
}

function parseFrontmatterValue(value) {
  const trimmed = String(value ?? "").trim()

  if (!trimmed) {
    return ""
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item))
      .filter(Boolean)
  }

  return unquote(trimmed)
}

export function parseFrontmatter(raw) {
  const match = String(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)

  if (!match) {
    return { data: {}, body: String(raw).trim() }
  }

  const data = {}
  const lines = match[1].split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const item = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)

    if (!item) {
      continue
    }

    const key = item[1]
    const value = item[2]

    if (value.trim()) {
      data[key] = parseFrontmatterValue(value)
      continue
    }

    const values = []
    while (lines[index + 1]?.match(/^\s+-\s+/)) {
      index += 1
      values.push(unquote(lines[index].replace(/^\s+-\s+/, "")))
    }

    if (values.length) {
      data[key] = values
      continue
    }

    const nested = {}
    while (lines[index + 1]?.match(/^\s+[A-Za-z][A-Za-z0-9_-]*:\s*/)) {
      index += 1
      const nestedItem = lines[index].match(/^\s+([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
      if (nestedItem) {
        nested[nestedItem[1]] = parseFrontmatterValue(nestedItem[2])
      }
    }
    data[key] = nested
  }

  return {
    data,
    body: String(raw).slice(match[0].length).trim(),
  }
}

export function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean)
  }

  if (!value) {
    return []
  }

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export function hasFrontmatterKey(data, key) {
  return Object.prototype.hasOwnProperty.call(data, key)
}

export async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") {
      return null
    }

    throw error
  }
}
