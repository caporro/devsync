function virtualPattern(value) {
  const raw = String(value ?? "").trim().replace(/^\.?\//, "")

  if (!raw || raw.startsWith("..") || raw.includes("/../")) {
    throw Object.assign(new Error("Invalid runtime path"), { statusCode: 400 })
  }

  if (raw === "**" || raw === "**/*") {
    return "/**"
  }

  return raw.startsWith("/") ? raw : `/${raw}`
}

function permissionPaths(items) {
  return items.map(virtualPattern)
}

function parentDirs(pattern) {
  const clean = String(pattern)
    .replace(/^\/+/, "")
    .replace(/\/\*\*.*$/, "")
    .replace(/\/\*.*$/, "")
  const parts = clean.split("/").filter(Boolean)

  if (parts.length <= 1) {
    return []
  }

  return parts.slice(0, -1).map((_, index) => `/${parts.slice(0, index + 1).join("/")}`)
}

function structuralReadPaths(read, write) {
  const dirs = new Set(["/"])

  for (const item of [...read, ...write]) {
    for (const dir of parentDirs(item)) {
      dirs.add(dir)
    }

    const clean = String(item).replace(/^\/+/, "")
    if (clean.endsWith("/**") || clean.endsWith("/*")) {
      dirs.add(virtualPattern(clean.replace(/\/\*\*?$/, "")))
    }
  }

  return [...dirs]
}

export function hasFilesystemTool(toolNames) {
  return toolNames.includes("filesystem")
}

export function filesystemPermissions({ enabled, read, write }) {
  if (!enabled) {
    return [
      { operations: ["read"], paths: ["/**"], mode: "deny" },
      { operations: ["write"], paths: ["/**"], mode: "deny" },
    ]
  }

  return [
    { operations: ["read"], paths: structuralReadPaths(read, write), mode: "allow" },
    { operations: ["read"], paths: permissionPaths(read), mode: "allow" },
    { operations: ["read"], paths: ["/**"], mode: "deny" },
    { operations: ["write"], paths: permissionPaths(write), mode: "allow" },
    { operations: ["write"], paths: ["/**"], mode: "deny" },
  ]
}
