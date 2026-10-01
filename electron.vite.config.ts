import { resolve } from 'node:path'
import { createServer } from 'node:net'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin, type ElectronViteConfig } from 'electron-vite'

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

async function availableDevPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close()
        reject(new Error('无法分配开发服务器端口。'))
        return
      }
      probe.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
}

export default defineConfig(async ({ command }): Promise<ElectronViteConfig> => ({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/bootstrap.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: 'chunks/[name]-[hash].cjs'
        }
      }
    },
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
    server: {
      host: '127.0.0.1',
      // Vite treats port 0 as its default, so pass an OS-allocated positive port.
      port: command === 'serve' ? await availableDevPort() : undefined,
      strictPort: true
    },
    build: {
      minify: 'esbuild',
      rollupOptions: {
        output: {
          // Share and cache the parser independently of the app entry and pages.
          manualChunks: { 'markdown-engine': ['markdown-it', 'parse5', resolve(__dirname, 'src/shared/markdownHtml.ts'), resolve(__dirname, 'src/shared/markdownFrontmatter.ts')] }
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    }
  }
}))
