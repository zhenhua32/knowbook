import { createContext, createElement, lazy, useContext, type ComponentType, type LazyExoticComponent } from 'react'

export const ViewRecoveryContext = createContext<object>({})

/** Keep suspended loads stable until their boundary starts a new recovery attempt. */
export function lazyWithRetry<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): ComponentType<P> {
  const versions = new WeakMap<object, LazyExoticComponent<ComponentType<P>>>()
  return function RetryableView(props: P) {
    const attempt = useContext(ViewRecoveryContext)
    let View = versions.get(attempt)
    if (!View) { View = lazy(load); versions.set(attempt, View) }
    return createElement(View as ComponentType<P>, props)
  }
}
