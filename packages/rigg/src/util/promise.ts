export function createPromiseKit<T>(): {
  promise: Promise<T>
  reject: (error: Error) => void
  resolve: (value: T) => void
} {
  let reject: ((error: Error) => void) | undefined
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = (error) => innerReject(error)
  })

  if (reject === undefined || resolve === undefined) {
    throw new Error("failed to initialize promise kit")
  }

  return { promise, reject, resolve }
}
