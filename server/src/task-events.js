import { EventEmitter } from "node:events"

// Storage publishes the same events for HTTP, MCP and internal agent tools.
export const taskEvents = new EventEmitter()
