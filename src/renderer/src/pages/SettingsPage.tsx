import type { ComponentProps } from 'react'
import { useSettingsDomain, type UseSettingsDomainParams } from '../hooks/useSettingsDomain'
import { DashboardSettingsSection } from '../sections/DashboardSettingsSection'

type SectionPresentation = Pick<ComponentProps<typeof DashboardSettingsSection>,
  'requestedCategory' | 'onCategoryRequestHandled' | 'appearanceContent' | 'recoveryContent'>

export type SettingsPageProps = SectionPresentation & { settings: UseSettingsDomainParams }

/** Mount on the first settings visit and retain the state while other pages
 * are active. The parent supplies isSettingsPage=false to suspend polling. */
export default function SettingsPage({ settings, ...presentation }: SettingsPageProps) {
  const { sectionProps } = useSettingsDomain(settings)
  return <DashboardSettingsSection {...sectionProps} {...presentation} />
}
