import type { SystemPluginManagedResourceSummary } from '@shared/contracts'

export function SystemPluginResources({
  resources,
  isZh
}: {
  resources: SystemPluginManagedResourceSummary[]
  isZh: boolean
}): React.JSX.Element {
  const kinds = ['window', 'menu', 'tray', 'frame'] as const
  const labels = isZh
    ? { window: '窗口', menu: '菜单', tray: '托盘', frame: 'Frame' }
    : { window: 'Windows', menu: 'Menus', tray: 'Trays', frame: 'Frames' }
  return (
    <div className="plugin-inspector-note" data-testid="system-plugin-managed-resources">
      <strong>{isZh ? '已登记资源' : 'Registered resources'} · {resources.length}</strong>
      <code>{kinds.map((kind) => `${labels[kind]} ${resources.filter((resource) => resource.kind === kind).length}`).join(' · ')}</code>
      {resources.map((resource) => (
        <div key={resource.id} data-resource-kind={resource.kind} data-resource-source={resource.source}>
          <code>{resource.source === 'renderer-frame' && resource.kind === 'window'
            ? (isZh ? 'Frame 特权窗口' : 'Privileged frame window')
            : labels[resource.kind]}: {resource.label}</code>
          {resource.allowedOrigins ? <code>{isZh ? '已登记来源' : 'Registered origins'}: {resource.allowedOrigins.join(' · ')}</code> : null}
          {resource.framePolicy ? <code>{[
            resource.framePolicy.allowPopups ? (isZh ? '允许弹窗' : 'Popups allowed') : null,
            resource.framePolicy.allowNavigation ? (isZh ? '允许导航' : 'Navigation allowed') : null,
            resource.framePolicy.allowDownloads ? (isZh ? '允许下载' : 'Downloads allowed') : null,
            resource.framePolicy.allowPermissions ? (isZh ? '允许权限请求' : 'Permission requests allowed') : null
          ].filter(Boolean).join(' · ') || (isZh ? '未开放额外能力' : 'No additional capabilities')}</code> : null}
        </div>
      ))}
      <p>{isZh
        ? '显示宿主 SDK 创建的存活窗口、托盘与已登记菜单，以及 frame 策略；菜单和 frame 计数不代表当前可见数量。'
        : 'Shows live host SDK windows and trays, registered menus, and frame policies. Menu and frame counts do not indicate current visibility.'}</p>
    </div>
  )
}
