/** Bound one stage, including APIs that do not honor AbortSignal themselves.
 * A late result cannot advance the caller's pipeline after cancellation. */
export async function mediaStage<T>(
  label: string,
  parent: AbortSignal | undefined,
  work: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs = 30_000,
): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent?.reason ?? new DOMException('Cancelled', 'AbortError'));
  if (parent?.aborted) cancel();
  else parent?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out. Keep this tab open and retry the same original.`)), timeoutMs);
  let aborted: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      aborted = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', aborted, { once: true });
      if (controller.signal.aborted) return aborted();
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      }).then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', aborted);
  }
}
