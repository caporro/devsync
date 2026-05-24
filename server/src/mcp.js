import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createDevsyncMcpServer } from "./mcp-server.js"

const server = createDevsyncMcpServer()
await server.connect(new StdioServerTransport())
