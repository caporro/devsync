import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createDevsyncMcpServer } from "./mcp-server.js"
import { ensureDataDir } from "./storage.js"

await ensureDataDir()
const server = createDevsyncMcpServer()
await server.connect(new StdioServerTransport())
