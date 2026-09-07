type Subscriber<T> = {
  resolve: (value: T) => void
  reject: (error: unknown) => void
  cleanup: () => void
}

type RequestTask<T> = {
  key: string
  load: (signal: AbortSignal) => Promise<T>
  controller: AbortController
  subscribers: Set<Subscriber<T>>
  background: boolean
  started: boolean
}

export function abortError() {
  return new DOMException('The request was aborted.', 'AbortError')
}

/** Conservative retained-size estimate; avoids allocating a second JSON string. */
function estimateBytes(value: unknown, ceiling: number): number {
  const stack: unknown[] = [value]
  const seen = new Set<object>()
  let bytes = 0
  while (stack.length && bytes <= ceiling) {
    const item = stack.pop()
    if (typeof item === 'string') bytes += 24 + item.length * 2
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item)
      bytes += 64
      for (const [key, child] of Object.entries(item)) {
        bytes += 24 + key.length * 2
        stack.push(child)
      }
    } else bytes += 8
  }
  return bytes
}

/** Both entry count and estimated retained bytes are bounded. */
export class MemoryCache<K, V> extends Map<K, V> {
  private readonly weights = new Map<K, number>()
  bytes = 0

  constructor(private readonly limit: number, private readonly maxBytes: number) { super() }

  override get(key: K): V | undefined {
    const value = super.get(key)
    if (value === undefined) return undefined
    super.delete(key)
    super.set(key, value)
    return value
  }

  override set(key: K, value: V): this {
    this.delete(key)
    const weight = estimateBytes(value, this.maxBytes)
    if (weight > this.maxBytes) return this
    this.weights.set(key, weight)
    this.bytes += weight
    super.set(key, value)
    while (this.size > this.limit || this.bytes > this.maxBytes) this.delete(this.keys().next().value!)
    return this
  }

  override delete(key: K): boolean {
    this.bytes -= this.weights.get(key) ?? 0
    this.weights.delete(key)
    return super.delete(key)
  }

  override clear(): void {
    this.bytes = 0
    this.weights.clear()
    super.clear()
  }
}

/** Bounded LRU with shared, cancellable requests and one reserved foreground slot. */
export class RequestCache<T> {
  private readonly cache: MemoryCache<string, T>
  private readonly pending = new Map<string, RequestTask<T>>()
  private readonly queue: RequestTask<T>[] = []
  private active = 0
  private backgroundActive = 0

  constructor(
    limit: number,
    private readonly concurrency = 3,
    private readonly backgroundConcurrency = 2,
    byteLimit = 16 * 1024 * 1024,
  ) { this.cache = new MemoryCache(limit, byteLimit) }

  read(key: string): T | undefined {
    return this.cache.get(key)
  }

  write(key: string, value: T) {
    this.cache.set(key, value)
  }

  values() {
    return this.cache.values()
  }

  delete(key: string) {
    this.cache.delete(key)
  }

  clear() {
    this.cache.clear()
    for (const task of this.pending.values()) {
      task.controller.abort()
      this.settle(task, undefined, abortError())
    }
    this.pending.clear()
    this.queue.length = 0
  }

  request(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
    background = false,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError())
    const cached = this.read(key)
    if (cached !== undefined) return Promise.resolve(cached)
    let task = this.pending.get(key)
    if (!task) {
      if (this.pending.size >= 32) return Promise.reject(new Error('The request queue is full. Please retry.'))
      task = { key, load, controller: new AbortController(), subscribers: new Set(), background, started: false }
      this.pending.set(key, task)
      this.queue.push(task)
    } else if (!background && !task.started) {
      task.background = false
    }
    const shared = task
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        shared.subscribers.delete(subscriber)
        subscriber.cleanup()
        reject(abortError())
        if (shared.subscribers.size === 0) {
          shared.controller.abort()
          if (this.pending.get(key) === shared) this.pending.delete(key)
          const index = this.queue.indexOf(shared)
          if (index >= 0) this.queue.splice(index, 1)
        }
      }
      const subscriber: Subscriber<T> = {
        resolve, reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      }
      shared.subscribers.add(subscriber)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pump()
    })
  }

  private settle(task: RequestTask<T>, value?: T, error?: unknown) {
    for (const subscriber of task.subscribers) {
      subscriber.cleanup()
      if (error !== undefined) subscriber.reject(error)
      else subscriber.resolve(value as T)
    }
    task.subscribers.clear()
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      let index = this.queue.findIndex((task) => !task.background)
      if (index < 0) {
        if (this.backgroundActive >= this.backgroundConcurrency) return
        index = 0
      }
      const task = this.queue.splice(index, 1)[0]
      task.started = true
      this.active += 1
      if (task.background) this.backgroundActive += 1
      void Promise.resolve().then(() => {
        if (task.controller.signal.aborted) throw abortError()
        return task.load(task.controller.signal)
      }).then((value) => {
        if (!task.controller.signal.aborted && this.pending.get(task.key) === task) {
          this.write(task.key, value)
          this.settle(task, value)
        }
      }, (error: unknown) => this.settle(task, undefined, error)).finally(() => {
        if (this.pending.get(task.key) === task) this.pending.delete(task.key)
        this.active -= 1
        if (task.background) this.backgroundActive -= 1
        this.pump()
      })
    }
  }
}
