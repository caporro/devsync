import { useEffect, useRef, useState } from "react"
import type { RefObject } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Mic01Icon } from "@hugeicons/core-free-icons"

import { cn } from "@/lib/utils"

type SpeechRecognitionAlternativeLike = {
  transcript: string
}

type SpeechRecognitionResultLike = {
  isFinal: boolean
  [index: number]: SpeechRecognitionAlternativeLike | undefined
}

type SpeechRecognitionResultListLike = {
  length: number
  [index: number]: SpeechRecognitionResultLike | undefined
}

type SpeechRecognitionEventLike = Event & {
  results: SpeechRecognitionResultListLike
}

type SpeechRecognitionErrorEventLike = Event & {
  error?: string
}

type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  abort: () => void
  start: () => void
  stop: () => void
  onend: (() => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
}

type SpeechRecognitionConstructorLike = new () => SpeechRecognitionLike

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructorLike
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike
  }
}

type VoiceInsertion = {
  after: string
  before: string
  original: string
}

type VoiceInputButtonProps = {
  className?: string
  disabled?: boolean
  lang?: string
  targetRef: RefObject<HTMLTextAreaElement | null>
  value: string
  wrapperClassName?: string
  onAfterChange?: (element: HTMLTextAreaElement, value: string) => void
  onValueChange: (value: string) => void
}

const LISTENING_MESSAGE = "Listening..."

function getRecognitionConstructor() {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null
}

function speechErrorMessage(error?: string) {
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "Microphone denied"
  }

  if (error === "audio-capture") {
    return "Microphone unavailable"
  }

  if (error === "network") {
    return "Voice service unavailable"
  }

  if (error === "no-speech") {
    return "No speech detected"
  }

  return "Voice input failed"
}

function applyTranscript(insert: VoiceInsertion, transcript: string) {
  const text = transcript.trim()

  if (!text) {
    return {
      cursor: insert.before.length,
      value: insert.original,
    }
  }

  const beforeSeparator =
    insert.before.length > 0 && !/\s$/.test(insert.before) ? " " : ""
  const afterSeparator =
    insert.after.length > 0 &&
    !/^\s/.test(insert.after) &&
    !/^[.,!?;:)\]}]/.test(insert.after)
      ? " "
      : ""
  const nextValue = `${insert.before}${beforeSeparator}${text}${afterSeparator}${insert.after}`

  return {
    cursor: insert.before.length + beforeSeparator.length + text.length,
    value: nextValue,
  }
}

function eventTranscript(event: SpeechRecognitionEventLike) {
  const parts: string[] = []

  for (let index = 0; index < event.results.length; index += 1) {
    const transcript = event.results[index]?.[0]?.transcript.trim()

    if (transcript) {
      parts.push(transcript)
    }
  }

  return parts.join(" ")
}

export function VoiceInputButton({
  className,
  disabled = false,
  lang,
  targetRef,
  value,
  wrapperClassName,
  onAfterChange,
  onValueChange,
}: VoiceInputButtonProps) {
  const insertionRef = useRef<VoiceInsertion | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const [isListening, setIsListening] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
      recognitionRef.current = null
    }
  }, [])

  useEffect(() => {
    if (disabled && isListening) {
      recognitionRef.current?.stop()
    }
  }, [disabled, isListening])

  function stopListening() {
    recognitionRef.current?.stop()
    setIsListening(false)
  }

  function startListening() {
    const Recognition = getRecognitionConstructor()

    if (!Recognition) {
      setMessage("Voice not supported")
      return
    }

    const element = targetRef.current
    const start = element?.selectionStart ?? value.length
    const end = element?.selectionEnd ?? start
    insertionRef.current = {
      after: value.slice(end),
      before: value.slice(0, start),
      original: value,
    }

    const recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = lang ?? navigator.language ?? "it-IT"
    recognition.onresult = (event) => {
      const next = applyTranscript(insertionRef.current ?? {
        after: "",
        before: "",
        original: value,
      }, eventTranscript(event))

      onValueChange(next.value)
      setMessage(LISTENING_MESSAGE)
      window.requestAnimationFrame(() => {
        const nextElement = targetRef.current
        if (!nextElement) return

        nextElement.focus()
        nextElement.setSelectionRange(next.cursor, next.cursor)
        onAfterChange?.(nextElement, next.value)
      })
    }
    recognition.onerror = (event) => {
      setMessage(speechErrorMessage(event.error))
      setIsListening(false)
    }
    recognition.onend = () => {
      recognitionRef.current = null
      setIsListening(false)
      setMessage((current) => current === LISTENING_MESSAGE ? null : current)
    }

    try {
      recognitionRef.current = recognition
      recognition.start()
      setIsListening(true)
      setMessage(LISTENING_MESSAGE)
    } catch {
      recognitionRef.current = null
      setIsListening(false)
      setMessage("Voice input failed")
    }
  }

  function handleClick() {
    if (disabled) {
      return
    }

    if (isListening) {
      stopListening()
      return
    }

    startListening()
  }

  return (
    <div className={cn("inline-flex min-w-0 items-center gap-2", wrapperClassName)}>
      <button
        aria-label={isListening ? "Stop voice input" : "Voice input"}
        aria-pressed={isListening}
        className={cn(
          "inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
          isListening && "bg-primary text-primary-foreground hover:bg-primary/90",
          className
        )}
        disabled={disabled}
        onClick={handleClick}
        title={isListening ? "Stop voice input" : "Voice input"}
        type="button"
      >
        <HugeiconsIcon className="size-4.5" icon={Mic01Icon} strokeWidth={2} />
      </button>
      {message ? (
        <span className="max-w-44 truncate text-xs text-muted-foreground">{message}</span>
      ) : null}
    </div>
  )
}
