// A client may declare an operational author for one call. Authentication
// remains independent and is always retained for the audit trail.
export function writeAttribution(user, agentName, source) {
  if (agentName != null && typeof agentName !== "string") {
    throw Object.assign(new Error("agentName must be a string"), { statusCode: 400 })
  }
  const name = agentName?.trim() || ""
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(name)) {
    throw Object.assign(new Error("agentName must be a single-line name without control characters"), { statusCode: 400 })
  }
  if (name.length > 100) {
    throw Object.assign(new Error("agentName must be at most 100 characters"), { statusCode: 400 })
  }
  const authenticatedBy = String(user?.email || user?.username || (source === "mcp" ? "local-stdio" : "team"))
  const author = name || authenticatedBy
  return { author, creator: author, createdBy: author, editor: author, authenticatedBy, source }
}
