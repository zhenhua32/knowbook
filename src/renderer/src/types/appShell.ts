import type { useAppShellState } from '../hooks/useAppShellState'

export type AppShellState = ReturnType<typeof useAppShellState>

export type ShellPageState = Pick<AppShellState,
  'activePage'
  | 'setActivePage'
>