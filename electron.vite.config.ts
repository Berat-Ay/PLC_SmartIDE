import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Added to production builds only: the dev server needs inline scripts for hot reload.
// Simulation scenarios run in an isolated rungline-sim:// sandboxed iframe/worker, keeping
// dynamic code evaluation and blanket external connect-src out of the main renderer CSP.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "frame-src rungline-sim:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`)
  }
}

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        // A sandboxed preload script has to be CommonJS
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react(), contentSecurityPolicy()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            const normalized = id.replace(/\\/g, '/')
            if (
              normalized.includes('/node_modules/react/') ||
              normalized.includes('/node_modules/react-dom/') ||
              normalized.includes('/node_modules/scheduler/')
            ) {
              return 'vendor-react'
            }
            if (
              normalized.includes('/node_modules/lucide-react/') ||
              normalized.includes('/node_modules/zustand/')
            ) {
              return 'vendor-ui'
            }
            if (
              normalized.includes('/src/renderer/src/runtime/') ||
              normalized.includes('/src/shared/scl/') ||
              normalized.includes('/src/shared/tia/') ||
              normalized.includes('/src/shared/s7/') ||
              normalized.includes('/src/renderer/src/services/compiler/')
            ) {
              return 'plc-core'
            }
            if (
              normalized.includes('/src/renderer/src/services/ai/') ||
              normalized.includes('/src/renderer/src/services/scenarios/')
            ) {
              return 'plc-ai'
            }
            return undefined
          }
        }
      }
    }
  }
})
