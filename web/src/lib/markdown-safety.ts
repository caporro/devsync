const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"])

function markdownUrlToken(value: string) {
  const token = value.trim().split(/\s+/, 1)[0] ?? ""
  return token.replace(/^<(.+)>$/, "$1")
}

function hasUnsafeHrefCharacter(value: string) {
  return [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 31 || code === 127 || /\s/.test(char)
  })
}

export function markdownProjectFilePath(url: string) {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/api\/)/i.test(url)) {
    return null
  }

  let normalized = url.split(/[?#]/, 1)[0].replace(/\\/g, "/")

  try {
    normalized = decodeURIComponent(normalized)
  } catch {
    // Keep the original path if it is not URI encoded.
  }

  normalized = normalized
    .replace(/^\/+/, "")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^(?:\.\.\/)+/, "")

  return /^(?:artifacts|generated|plan)\//.test(normalized) ? normalized : null
}

export function safeMarkdownHref(value: string) {
  const href = markdownUrlToken(value)
  if (!href || hasUnsafeHrefCharacter(href)) {
    return null
  }

  const projectPath = markdownProjectFilePath(href)
  if (projectPath) {
    return projectPath
  }

  try {
    const url = new URL(href)
    return SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) ? href : null
  } catch {
    return null
  }
}

export function sanitizeMarkdownLinks(markdown: string) {
  return String(markdown).replace(
    /(!?)\[([^\]\n]*)\]\(([^()\n]*(?:\([^)\n]*\)[^()\n]*)?)\)/g,
    (_raw, image: string, label: string, href: string) => {
      const safeHref = safeMarkdownHref(href)

      if (!safeHref) {
        return label
      }

      return `${image}[${label}](${safeHref})`
    }
  )
}
