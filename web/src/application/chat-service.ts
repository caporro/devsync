import type {
  ChatCapabilities,
  ChatService,
  ChatTransport,
  ConversationStore,
  SendMessageHandlers,
  SendMessageRequest,
} from "@/domain/chat"

type ChatServiceOptions = {
  capabilities: ChatCapabilities
  store: ConversationStore
  transport: ChatTransport
  createId?: () => string
  now?: () => string
}

function defaultCreateId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function defaultNow() {
  return new Date().toISOString()
}

export function createChatService({
  capabilities,
  store,
  transport,
  createId = defaultCreateId,
  now = defaultNow,
}: ChatServiceOptions): ChatService {
  return {
    capabilities,
    listThreads: () => store.listThreads(),
    createThread: (body) => store.createThread(body),
    deleteThread: (threadId) => store.deleteThread(threadId),
    getThreadHistory: (threadId) => store.getThreadHistory(threadId),
    async sendMessage(
      body: SendMessageRequest,
      { onEvent, signal }: SendMessageHandlers
    ) {
      const runId = createId()
      const userMessage = {
        id: createId(),
        role: "user" as const,
        content: body.content,
        runId,
        createdAt: now(),
      }

      await transport.sendMessage(
        {
          content: body.content,
          runId,
          signal,
        },
        {
          onEvent: async (event) => {
            if (event.type === "assistant_message") {
              await store.appendMessage(body.threadId, event.message)
            }

            onEvent(event)
          },
        }
      )

      await store.appendMessage(body.threadId, userMessage)

      return {
        runId,
        userMessage,
      }
    },
  }
}
