function originUrl(value) {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Expected an HTTP(S) origin")
  return url
}

export function createRequestGuard({ authMode, publicUrl = "", allowedOrigins = "", bindHost = "" }) {
  const publicOrigin = publicUrl ? originUrl(publicUrl) : null
  const explicitOrigins = new Set(String(allowedOrigins).split(",").map((value) => value.trim()).filter(Boolean).map((value) => originUrl(value).origin))
  if (publicOrigin) explicitOrigins.add(publicOrigin.origin)
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"])
  if (publicOrigin) localHosts.add(publicOrigin.hostname)
  if (bindHost && !["0.0.0.0", "::", "[::]"].includes(bindHost)) {
    localHosts.add(originUrl(`http://${bindHost.includes(":") && !bindHost.startsWith("[") ? `[${bindHost}]` : bindHost}`).hostname)
  }

  return (request) => {
    let target
    const authority = request.headers.host ?? request.host
    try {
      if (typeof authority !== "string" || /[/\\?#@\s]/.test(authority)) return "Invalid Host header"
      target = originUrl(`${request.protocol}://${authority}`)
    } catch { return "Invalid Host header" }

    const route = request.routeOptions.url ?? ""
    // A public health probe contains no vault data and may use a container DNS name.
    if (authMode === "none" && route !== "/api/health" && !localHosts.has(target.hostname)) {
      return "Untrusted Host; configure DEVSYNC_PUBLIC_URL for a custom hostname"
    }
    if (!route.startsWith("/api/") && route !== "/mcp") return null
    const origin = request.headers.origin
    if (origin !== undefined) {
      let source
      try {
        if (typeof origin !== "string" || origin.trim() !== origin) return "Untrusted Origin"
        source = originUrl(origin)
        if (source.pathname !== "/" || source.search || source.hash) return "Untrusted Origin"
      } catch { return "Untrusted Origin" }
      if (source.origin === target.origin || explicitOrigins.has(source.origin)) return null
      // HTTPS termination may leave Fastify on HTTP. Only an upgrade on the same
      // authority is accepted; arbitrary forwarded headers are never trusted.
      if (source.protocol === "https:" && target.protocol === "http:" && source.host === target.host) return null
      return "Untrusted Origin"
    }
    if (request.headers["sec-fetch-site"] === "cross-site") return "Cross-site browser request rejected"
    return null
  }
}
