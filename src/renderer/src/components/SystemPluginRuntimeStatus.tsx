import type { SystemPluginSummary } from '@shared/contracts'
import { getSystemPluginFailureStages } from '@shared/system-plugin-state'

export function SystemPluginRuntimeStatus({ plugin, isZh }: {
  plugin: Pick<SystemPluginSummary, 'recentRuns' | 'availablePackages'>; isZh: boolean
}) {
  const failed = plugin.recentRuns.filter((run) => run.status === 'failed').sort((left, right) => (
    (right.stoppedAt ?? right.updatedAt).localeCompare(left.stoppedAt ?? left.updatedAt)
  ))[0]
  const failedPackage = plugin.availablePackages.find((candidate) => candidate.packageId === failed?.packageId)
  const failedStages = getSystemPluginFailureStages(failed?.error)
  const failureMessage = failed?.error && typeof failed.error === 'object' && !Array.isArray(failed.error)
    && typeof failed.error.message === 'string' ? failed.error.message.slice(0, 4_000) : ''
  return <>{(['main', 'renderer'] as const).map((component) => {
    const run = plugin.recentRuns.find((candidate) => candidate.component === component)
    if (!run) return null
    const packageRecord = plugin.availablePackages.find((candidate) => candidate.packageId === run.packageId)
    const stages = getSystemPluginFailureStages(run.error)
    return (
      <div className="plugin-inspector-note" data-testid="system-plugin-runtime-component"
        data-component={component} data-run-status={run.status} key={component}>
        <strong>{component === 'main' ? 'Main' : 'Renderer'} · {run.status}</strong>
        <code>{isZh ? '运行所属修订' : 'Run revision'}: {packageRecord ? `sha256:${packageRecord.artifactSha256}` : run.packageId}</code>
        <code>PID {run.pid ?? '—'}</code>
        {stages.length > 0 ? <code>{isZh ? '失败阶段' : 'Failure stage'}: {stages.join(' · ')}</code> : null}
      </div>
    )
  })}
    {failed ? (
      <div className="plugin-inspector-note" data-testid="system-plugin-last-failure">
        <strong>{isZh ? '最近失败' : 'Most recent failure'} · {failed.component}</strong>
        <code>{isZh ? '失败修订' : 'Failed revision'}: {failedPackage ? `sha256:${failedPackage.artifactSha256}` : failed.packageId}</code>
        {failedStages.length > 0 ? <code>{isZh ? '失败阶段' : 'Failure stage'}: {failedStages.join(' · ')}</code> : null}
        {failureMessage ? <p className="plugin-error">{failureMessage}</p> : null}
      </div>
    ) : null}
  </>
}
