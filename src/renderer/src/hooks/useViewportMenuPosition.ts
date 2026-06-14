import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { constrainViewportMenuPosition } from '../utils/menuPosition'

const useBrowserLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

type MenuPosition = {
  x: number
  y: number
}

export function useViewportMenuPosition<T extends HTMLElement>(x: number, y: number) {
  const menuRef = useRef<T | null>(null)
  const [position, setPosition] = useState<MenuPosition>({ x, y })

  useBrowserLayoutEffect(() => {
    const menuElement = menuRef.current
    if (!menuElement || typeof window === 'undefined') {
      setPosition({ x, y })
      return
    }

    const updatePosition = () => {
      const nextPosition = constrainViewportMenuPosition(
        { x, y },
        { width: menuElement.offsetWidth, height: menuElement.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight }
      )

      setPosition((current) => (
        current.x === nextPosition.x && current.y === nextPosition.y
          ? current
          : nextPosition
      ))
    }

    updatePosition()

    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => updatePosition())

    resizeObserver?.observe(menuElement)
    window.addEventListener('resize', updatePosition)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updatePosition)
    }
  }, [x, y])

  return {
    menuRef,
    menuStyle: {
      position: 'fixed' as const,
      top: `${position.y}px`,
      left: `${position.x}px`,
      zIndex: 1000
    }
  }
}