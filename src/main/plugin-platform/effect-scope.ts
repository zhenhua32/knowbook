export type EffectDisposer = () => void | Promise<void>

type OwnedEffect = {
  active: boolean
  label: string
  dispose: EffectDisposer
}

export type EffectScopeState = 'active' | 'disposing' | 'disposed'

/**
 * Owns plugin registrations and resources. Effects are disposed exactly once in
 * reverse registration order so dependants unwind before their providers.
 */
export class EffectScope {
  private readonly effects: OwnedEffect[] = []
  private currentState: EffectScopeState = 'active'
  private disposal: Promise<void> | null = null

  constructor(readonly label: string) {}

  get state(): EffectScopeState {
    return this.currentState
  }

  get size(): number {
    return this.effects.reduce((count, effect) => count + (effect.active ? 1 : 0), 0)
  }

  own(dispose: EffectDisposer, label = 'effect'): EffectDisposer {
    if (this.currentState !== 'active') {
      throw new Error(`Effect scope "${this.label}" is ${this.currentState}.`)
    }
    if (typeof dispose !== 'function') {
      throw new TypeError('Effect disposer must be a function.')
    }

    const effect: OwnedEffect = {
      active: true,
      label: label.trim() || 'effect',
      dispose
    }
    this.effects.push(effect)

    let releasePromise: Promise<void> | null = null
    return () => {
      if (!effect.active) {
        return releasePromise ?? Promise.resolve()
      }
      effect.active = false
      releasePromise = this.runDisposer(effect)
      return releasePromise
    }
  }

  child(label: string): EffectScope {
    const child = new EffectScope(`${this.label}/${label.trim() || 'child'}`)
    this.own(() => child.dispose(), `child:${child.label}`)
    return child
  }

  dispose(): Promise<void> {
    if (this.disposal) {
      return this.disposal
    }

    this.currentState = 'disposing'
    this.disposal = this.disposeAll()
    return this.disposal
  }

  private async disposeAll(): Promise<void> {
    const errors: Error[] = []

    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index]
      if (!effect.active) {
        continue
      }
      effect.active = false
      try {
        await this.runDisposer(effect)
      } catch (error) {
        errors.push(error instanceof Error ? error : normalizeEffectError(error, effect.label))
      }
    }

    this.currentState = 'disposed'
    if (errors.length > 0) {
      throw new AggregateError(errors, `Effect scope "${this.label}" failed to dispose cleanly.`)
    }
  }

  private async runDisposer(effect: OwnedEffect): Promise<void> {
    try {
      await effect.dispose()
    } catch (error) {
      throw normalizeEffectError(error, effect.label)
    }
  }
}

function normalizeEffectError(error: unknown, label: string): Error {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string' && error.trim()
      ? error.trim()
      : 'Unknown disposal failure.'
  return new Error(`Effect "${label}" failed: ${message}`, {
    cause: error
  })
}
