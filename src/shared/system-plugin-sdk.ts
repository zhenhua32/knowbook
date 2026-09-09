/** Type-only authoring entry point. Plugins receive these APIs at runtime. */
export type { SystemPluginV3Manifest, SystemPluginDependencyPlan } from './system-plugin'
export type {
  FullTrustPluginIdentity, SystemPluginDisposable, SystemPluginLifecycle,
  SystemPluginHealthCheckResult
} from '../main/system-plugin/types'
export type { KnowbookFullTrustServices } from '../main/system-plugin/knowbook-services'
export type FullTrustPluginContext = import('../main/system-plugin/types').FullTrustPluginContext<
  import('../main/system-plugin/knowbook-services').KnowbookFullTrustServices
>
export type {
  SystemPluginServiceRpcGlobalApi, SystemPluginServiceRpcJson
} from '../main/system-plugin/service-rpc'
export type {
  FullTrustRendererPluginApi, FullTrustRendererPluginInitializer,
  FullTrustPluginSlotProps, FullTrustFrameOptions
} from '../renderer/src/full-trust-plugin-registry'
