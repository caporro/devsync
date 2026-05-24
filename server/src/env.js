import fs from "node:fs"
import path from "node:path"

const envPath = path.join(process.cwd(), ".env")

function unquote(value) {
  const trimmed = value.trim()

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

try {
  const content = fs.readFileSync(envPath, "utf8")

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const separator = trimmed.indexOf("=")

    if (separator <= 0) {
      continue
    }

    const key = trimmed.slice(0, separator).trim()
    const value = unquote(trimmed.slice(separator + 1))

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
} catch (error) {
  if (error.code !== "ENOENT") {
    throw error
  }
}
