import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const KATEX_LEGACY_FONT_SOURCES = /src:(url\([^)]*\.woff2\) format\(["']woff2["']\)),url\([^)]*\.woff\) format\(["']woff["']\),url\([^)]*\.ttf\) format\(["']truetype["']\)/g

function katexWoff2OnlyPlugin() {
  return {
    name: 'knowbook:katex-woff2-only',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const normalizedId = id.replace(/\\/g, '/').split('?')[0]
      if (!normalizedId.endsWith('/katex/dist/katex.min.css')) {
        return null
      }

      const transformed = code.replace(KATEX_LEGACY_FONT_SOURCES, 'src:$1')
      if (transformed === code) {
        throw new Error('KaTeX font source layout changed; update the WOFF2-only build transform.')
      }

      return { code: transformed, map: null }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [katexWoff2OnlyPlugin(), react()],
    build: {
      minify: 'esbuild'
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
})
