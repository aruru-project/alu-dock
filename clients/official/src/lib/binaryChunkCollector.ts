const CHANNEL_COMPLETION_TIMEOUT_MS = 30_000

/** Reassembles ordered Tauri Channel payloads after the command reports their exact total size. */
export class BinaryChunkCollector {
  private readonly chunks: Uint8Array[] = []
  private receivedBytes = 0
  private expectedBytes: number | undefined
  private failure: Error | undefined
  private settled = false
  private resolve: ((bytes: Uint8Array) => void) | undefined
  private reject: ((cause: Error) => void) | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  push(chunk: Uint8Array): void {
    if (this.settled || this.failure) return
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
      this.abort(new Error('图片内容传输不完整，请重新读取。'))
      return
    }
    if (this.expectedBytes !== undefined && this.receivedBytes + chunk.byteLength > this.expectedBytes) {
      this.abort(new Error('图片内容传输超出预期大小，请重新读取。'))
      return
    }
    this.chunks.push(chunk)
    this.receivedBytes += chunk.byteLength
    this.completeIfReady()
  }

  finish(expectedBytes: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || this.expectedBytes !== undefined) {
      return Promise.reject(new Error('图片内容传输大小无效，请重新读取。'))
    }
    this.expectedBytes = expectedBytes
    if (this.receivedBytes > expectedBytes) {
      this.abort(new Error('图片内容传输超出预期大小，请重新读取。'))
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
      if (this.failure) {
        this.rejectFailure()
        return
      }
      this.timer = setTimeout(() => {
        this.abort(new Error('图片内容传输未能完成，请重试。'))
      }, CHANNEL_COMPLETION_TIMEOUT_MS)
      this.completeIfReady()
    })
  }

  abort(cause: unknown): void {
    if (this.settled || this.failure) return
    this.failure = cause instanceof Error ? cause : new Error('图片内容传输失败，请重试。')
    this.rejectFailure()
  }

  private completeIfReady(): void {
    if (this.settled || this.failure || this.expectedBytes === undefined || !this.resolve) return
    if (this.receivedBytes !== this.expectedBytes) return
    const bytes = new Uint8Array(this.expectedBytes)
    let offset = 0
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    this.settled = true
    this.clearTimer()
    this.resolve(bytes)
  }

  private rejectFailure(): void {
    if (this.settled || !this.failure || !this.reject) return
    this.settled = true
    this.clearTimer()
    this.reject(this.failure)
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}
