export function onAbort(signal: AbortSignal | undefined, listener: () => void): () => void {
  if (signal === undefined) {
    return () => {}
  }

  let disposed = false
  const abortListener = () => {
    if (disposed) {
      return
    }
    disposed = true
    signal.removeEventListener("abort", abortListener)
    listener()
  }

  if (signal.aborted) {
    abortListener()
    return () => {}
  }

  signal.addEventListener("abort", abortListener, { once: true })

  if (signal.aborted) {
    abortListener()
  }

  return () => {
    if (disposed) {
      return
    }
    disposed = true
    signal.removeEventListener("abort", abortListener)
  }
}
