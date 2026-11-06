import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createDevsyncMcpServer } from "./mcp-server.js"
import { documentIndex, ensureDataDir } from "./storage.js"

await ensureDataDir()
await documentIndex.reconcile()
const refresh = setInterval(() => {
  void documentIndex.reconcile().catch((error) => console.error("Document index reconciliation failed:", error.message))
}, 30000)
refresh.unref()
const server = createDevsyncMcpServer()
await server.connect(new StdioServerTransport())
const onClose = server.server.onclose
server.server.onclose = () => {
  clearInterval(refresh)
  onClose?.()
  void documentIndex.close().catch((error) => console.error("Document index close failed:", error.message))
}
