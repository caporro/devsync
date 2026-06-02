import { describe, expect, it } from "vitest"

import { safeMarkdownHref, sanitizeMarkdownLinks } from "@/lib/markdown-safety"

describe("markdown safety", () => {
  it("keeps only safe external and project markdown links", () => {
    expect(safeMarkdownHref("https://example.com/a")).toBe("https://example.com/a")
    expect(safeMarkdownHref("mailto:team@example.com")).toBe("mailto:team@example.com")
    expect(safeMarkdownHref("../artifacts/report.md")).toBe("resources/report.md")
    expect(safeMarkdownHref("../generated/report.md")).toBe("work/report.md")
    expect(safeMarkdownHref("javascript:alert(1)")).toBeNull()
    expect(safeMarkdownHref("data:text/html,boom")).toBeNull()
  })

  it("strips unsafe markdown link targets before render or save", () => {
    const markdown = [
      "[safe](https://example.com)",
      "[project](../artifacts/report.md)",
      "[bad](javascript:alert(1))",
      "![bad image](data:image/svg+xml,boom)",
    ].join("\n")

    expect(sanitizeMarkdownLinks(markdown)).toBe([
      "[safe](https://example.com)",
      "[project](resources/report.md)",
      "bad",
      "bad image",
    ].join("\n"))
  })
})
