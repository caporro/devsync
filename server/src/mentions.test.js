import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { after, test } from "node:test"

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "devsync-mentions-"))

process.env.DEVSYNC_DATA_ROOT = tempRoot
process.env.DEVSYNC_VAULT_NAME = "mentions-vault"

const {
  addedUserMentions,
  appendMentionEvents,
  extractUserMentions,
  listMentionInbox,
  markInboxRead,
} = await import("./mentions.js")

after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true })
})

test("extracts markdown user mentions", () => {
  assert.deepEqual(
    extractUserMentions("Ping @[Claudio](devsync:user:claudio%40example.com)").map((item) => ({
      label: item.label,
      userId: item.userId,
    })),
    [{ label: "Claudio", userId: "claudio@example.com" }]
  )
})

test("detects only newly added user mentions", () => {
  const before = "@[Claudio](devsync:user:claudio)"
  const after = `${before} and @[Ada](devsync:user:ada) plus @[Ada](devsync:user:ada)`

  assert.deepEqual(
    addedUserMentions(before, after).map((item) => item.userId),
    ["ada", "ada"]
  )
})

test("stores mention events in system log and unread state in data users", async () => {
  await appendMentionEvents({
    actor: "Mario",
    after: "@[Ada](devsync:user:ada)",
    before: "",
    projectId: "demo",
    source: "test",
    target: "artifacts/spec.md",
    targetType: "artifact",
  })

  const inbox = await listMentionInbox({ email: "ada" })

  assert.equal(inbox.unreadCount, 1)
  assert.equal(inbox.items[0].target, "artifacts/spec.md")
  assert.equal(inbox.items[0].targetType, "artifact")
  assert.equal(inbox.items[0].content, "@Ada")

  await markInboxRead({ email: "ada" }, { lastReadAt: "9999-01-01T00:00:00.000Z" })

  const readInbox = await listMentionInbox({ email: "ada" })
  const state = JSON.parse(await fs.readFile(path.join(tempRoot, "users", "ada", "inbox-state.json"), "utf8"))

  assert.equal(readInbox.unreadCount, 0)
  assert.equal(state.lastReadAt, "9999-01-01T00:00:00.000Z")
})

test("storage writes mention events when content adds a mention", async () => {
  const { addLog, createProject, ensureDataDir } = await import("./storage.js")

  await ensureDataDir()
  await createProject({ name: "Mention Flow", slug: "mention-flow" })
  await addLog("mention-flow", {
    author: "Mario",
    content: "Ping @[Bea](devsync:user:bea)",
  })

  const inbox = await listMentionInbox({ email: "bea" })

  assert.equal(inbox.unreadCount, 1)
  assert.equal(inbox.items[0].projectId, "mention-flow")
  assert.match(inbox.items[0].target, /^logs\/activity\//)
  assert.equal(inbox.items[0].content, "Ping @Bea")
})
