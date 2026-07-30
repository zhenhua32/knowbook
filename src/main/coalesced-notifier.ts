export class CoalescedNotifier {
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly listener: () => void,
    private readonly delayMs: number
  ) {}

  notify(): void {
    if (this.disposed || this.timer) {
      return
    }

    this.timer = setTimeout(() => {
      this.timer = null
      this.listener()
    }, this.delayMs)
    this.timer.unref()
  }

  flush(): void {
    if (this.disposed || !this.timer) {
      return
    }

    clearTimeout(this.timer)
    this.timer = null
    this.listener()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
  }
}
