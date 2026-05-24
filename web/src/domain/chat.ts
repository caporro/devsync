export type Thread = {
  id: string
  title: string | null
  createdAt: string
  updatedAt: string
}

export type ThreadMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  runId: string | null
  createdAt: string
}

export type ThreadHistory = {
  thread: Thread
  messages: ThreadMessage[]
}

export type CreateThreadRequest = {
  title?: string
}

export type ChatCapabilities = {
  threadDeletion: boolean
  attachments: boolean
  webSearchToggle: boolean
  modeToggle: boolean
}

export type ChatStreamEvent =
  | {
      type: "assistant_delta"
      delta: string
    }
  | {
      type: "assistant_message"
      message: ThreadMessage
    }
  | {
      type: "run_completed"
      payload?: {
        id?: string
        status?: string
        model?: string
        totalTokens?: number
        costUsd?: number
      }
    }
  | {
      type: "error"
      message: string
    }

export type SendMessageRequest = {
  threadId: string
  content: string
}

export type SendMessageStart = {
  runId: string
  userMessage: ThreadMessage
}

export type SendMessageHandlers = {
  onEvent: (event: ChatStreamEvent) => void
  signal?: AbortSignal
}

export interface ConversationStore {
  listThreads: () => Promise<{ items: Thread[] }>
  createThread: (body?: CreateThreadRequest) => Promise<Thread>
  deleteThread: (threadId: string) => Promise<void>
  getThreadHistory: (threadId: string) => Promise<ThreadHistory>
  appendMessage: (threadId: string, message: ThreadMessage) => Promise<void>
}

export interface ChatTransport {
  sendMessage: (
    input: {
      content: string
      runId: string
      signal?: AbortSignal
    },
    handlers: {
      onEvent: (event: ChatStreamEvent) => Promise<void> | void
    }
  ) => Promise<{ runId: string }>
}

export interface ChatService {
  readonly capabilities: ChatCapabilities
  listThreads: () => Promise<{ items: Thread[] }>
  createThread: (body?: CreateThreadRequest) => Promise<Thread>
  deleteThread: (threadId: string) => Promise<void>
  getThreadHistory: (threadId: string) => Promise<ThreadHistory>
  sendMessage: (
    body: SendMessageRequest,
    handlers: SendMessageHandlers
  ) => Promise<SendMessageStart>
}
