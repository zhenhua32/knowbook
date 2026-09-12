import manifest from '../../../plugins/theme-switcher/plugin.json?raw'
import packageJson from '../../../plugins/theme-switcher/package.json?raw'
import main from '../../../plugins/theme-switcher/main.cjs?raw'
import renderer from '../../../plugins/theme-switcher/renderer.cjs?raw'
import themes from '../../../plugins/theme-switcher/themes.cjs?raw'
import themeCss from '../../../plugins/theme-switcher/theme-css.cjs?raw'
import type { BuiltinSystemPlugin } from './builtin'

// Vite embeds these sources in the application bundle, including packaged builds.
export const BUILTIN_SYSTEM_PLUGINS: readonly BuiltinSystemPlugin[] = [{
  id: 'theme-switcher',
  files: {
    'plugin.json': manifest,
    'package.json': packageJson,
    'main.cjs': main,
    'renderer.cjs': renderer,
    'themes.cjs': themes,
    'theme-css.cjs': themeCss
  }
}]
