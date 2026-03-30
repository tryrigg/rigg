import type { RunStatus } from "../session/schema"
import { compactJson } from "../util/json"

export const ServerEventKind = {
  Barrier: "barrier",
  Done: "done",
  Interaction: "interaction",
  Run: "run",
  Snapshot: "snapshot",
} as const

export type ServerDoneStatus = Extract<RunStatus, "aborted" | "failed" | "succeeded">

export type ServerEvent =
  | { kind: "snapshot"; run: unknown }
  | { kind: "run"; event: unknown }
  | { kind: "barrier"; event: unknown }
  | { kind: "interaction"; event: unknown }
  | { kind: "done"; status: ServerDoneStatus }

type ActiveSource = {
  subscribe: (send: (event: ServerEvent) => void) => () => void
}

function chunk(event: ServerEvent): Uint8Array {
  return new TextEncoder().encode(`event: ${event.kind}\ndata: ${compactJson(event)}\n\n`)
}

function terminal(status: RunStatus | null | undefined): ServerDoneStatus | null {
  if (status === "succeeded" || status === "failed" || status === "aborted") {
    return status
  }

  return null
}

export function createEventStream(input: {
  active?: ActiveSource
  run: unknown
  signal?: AbortSignal
  status?: RunStatus | null
}): Response {
  const done = terminal(input.status ?? null)

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false
        let release = () => {}

        const close = () => {
          if (closed) {
            return
          }
          closed = true
          release()
          controller.close()
        }

        const send = (event: ServerEvent) => {
          if (closed) {
            return
          }
          controller.enqueue(chunk(event))
          if (event.kind === "done") {
            close()
          }
        }

        send({ kind: "snapshot", run: input.run })

        if (done !== null) {
          send({ kind: "done", status: done })
          return
        }

        if (input.active === undefined) {
          close()
          return
        }

        release = input.active.subscribe(send)
        if (input.signal !== undefined) {
          input.signal.addEventListener("abort", close, { once: true })
        }
      },
      cancel() {},
    }),
    {
      headers: {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      },
    },
  )
}
