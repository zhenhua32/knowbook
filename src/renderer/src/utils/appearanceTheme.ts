import type { AppearanceTheme } from '@shared/contracts'

export function applyAppearanceTheme(
  root: Pick<HTMLElement, 'dataset'>,
  theme: AppearanceTheme
): void {
  root.dataset.theme = theme
}
