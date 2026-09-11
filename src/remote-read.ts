/** Shares catalog reads and discards responses invalidated by a newer Host notification. */
export class RemoteRead<T> {
  private revision = 0
  private cached: { revision: number; value: T } | undefined
  private pending: Promise<void> | undefined

  constructor(private readonly fetch: () => Promise<T>, private readonly signal: AbortSignal) {}

  get current(): T | undefined { return this.cached?.value }

  invalidate(): void { this.revision++ }

  async read(): Promise<T> {
    for (;;) {
      this.signal.throwIfAborted()
      if (this.cached?.revision === this.revision) return this.cached.value
      if (this.pending === undefined) {
        const revision = this.revision
        const request = this.fetch().then(value => {
          if (!this.signal.aborted && revision === this.revision) this.cached = { revision, value }
        }, error => {
          // A superseded request cannot fail a read of the replacement directory.
          if (revision === this.revision) throw error
        }).finally(() => { if (this.pending === request) this.pending = undefined })
        this.pending = request
      }
      await this.pending
    }
  }
}
