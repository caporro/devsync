import { describe, expect, it, vi } from "vitest"
import { createChatService } from "@/application/chat-service"
import type {
  ChatStreamEvent,
  ChatTransport,
  ConversationStore,
  Thread,
  ThreadHistory,
  ThreadMessage,
} from "@/domain/chat"

function createMemoryStore(thread: Thread): ConversationStore {
  const history: ThreadHistory = {
    thread,
    messages: [],
  }

  return {
    async listThreads() {
      return { items: [history.thread] }
    },
    async createThread() {
      return history.thread
    },
    async deleteThread() {},
    async getThreadHistory() {
      return history
    },
    async appendMessage(threadId: string, message: ThreadMessage) {
      expect(threadId).toBe(thread.id)
      history.messages.push(message)
      history.thread = {
        ...history.thread,
        updatedAt: message.createdAt,
      }
    },
  }
}

describe("chat service", () => {
  it("persists user and assistant messages around the transport", async () => {
    const thread = {
      id: "thread-1",
      title: "alpha",
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:00:00.000Z",
    }
    const store = createMemoryStore(thread)
    const events: ChatStreamEvent[] = []
    let onEvent: ((event: ChatStreamEvent) => Promise<void> | void) | undefined

    const transport: ChatTransport = {
      async sendMessage(_input, handlers) {
        onEvent = handlers.onEvent
        return { runId: "run-1" }
      },
    }

    const service = createChatService({
      capabilities: {
        threadDeletion: true,
        attachments: false,
        webSearchToggle: true,
        modeToggle: true,
      },
      store,
      transport,
      createId: (() => {
        const ids = ["run-1", "user-1", "assistant-1"]
        return () => ids.shift() ?? "extra-id"
      })(),
      now: (() => {
        const times = [
          "2026-01-01T10:00:01.000Z",
          "2026-01-01T10:00:02.000Z",
        ]
        return () => times.shift() ?? "2026-01-01T10:00:03.000Z"
      })(),
    })

    const started = await service.sendMessage(
      {
        threadId: thread.id,
        content: "hello",
      },
      {
        onEvent: (event) => {
          events.push(event)
        },
      }
    )

    await onEvent?.({
      type: "assistant_message",
      message: {
        id: "assistant-1",
        role: "assistant",
        content: "world",
        runId: started.runId,
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    })

    const history = await store.getThreadHistory(thread.id)

    expect(started.userMessage).toEqual({
      id: "user-1",
      role: "user",
      content: "hello",
      runId: "run-1",
      createdAt: "2026-01-01T10:00:01.000Z",
    })
    expect(history.messages).toEqual([
      started.userMessage,
      {
        id: "assistant-1",
        role: "assistant",
        content: "world",
        runId: "run-1",
        createdAt: "2026-01-01T10:00:02.000Z",
      },
    ])
    expect(events).toEqual([
      {
        type: "assistant_message",
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "world",
          runId: "run-1",
          createdAt: "2026-01-01T10:00:02.000Z",
        },
      },
    ])
  })

  it("forwards transport errors without appending assistant messages", async () => {
    const thread = {
      id: "thread-1",
      title: "alpha",
      createdAt: "2026-01-01T10:00:00.000Z",
      updatedAt: "2026-01-01T10:00:00.000Z",
    }
    const store = createMemoryStore(thread)
    const onEvent = vi.fn()

    const transport: ChatTransport = {
      async sendMessage(_input, handlers) {
        await handlers.onEvent({
          type: "error",
          message: "boom",
        })
        return { runId: "run-1" }
      },
    }

    const service = createChatService({
      capabilities: {
        threadDeletion: true,
        attachments: false,
        webSearchToggle: true,
        modeToggle: true,
      },
      store,
      transport,
      createId: (() => {
        const ids = ["run-1", "user-1"]
        return () => ids.shift() ?? "extra-id"
      })(),
      now: () => "2026-01-01T10:00:01.000Z",
    })

    await service.sendMessage(
      {
        threadId: thread.id,
        content: "hello",
      },
      { onEvent }
    )

    const history = await store.getThreadHistory(thread.id)
    expect(history.messages).toHaveLength(1)
    expect(onEvent).toHaveBeenCalledWith({
      type: "error",
      message: "boom",
    })
  })
})
