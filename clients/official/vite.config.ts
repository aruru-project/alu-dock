import { execFileSync } from 'node:child_process'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const host = process.env.TAURI_DEV_HOST

function gitOutput(args: string[]) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

const releaseVersion = process.env.ALUDOCK_RELEASE_VERSION?.trim()
const releaseTag = gitOutput(['describe', '--tags', '--exact-match', '--match', 'v[0-9]*'])
const commitHash = gitOutput(['rev-parse', '--short=7', 'HEAD'])
const buildIdentity = releaseVersion ? `v${releaseVersion.replace(/^v/, '')}` : releaseTag || commitHash
if (!buildIdentity) throw new Error('Unable to determine the AluDock build identity from Git.')

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  define: {
    'import.meta.env.VITE_ALUDOCK_BUILD_IDENTITY': JSON.stringify(buildIdentity),
  },
  build: {
    // Keep production CSS within the oldest WebView syntax in the Android support matrix.
    // Newer minifiers otherwise rewrite max-width queries to unsupported range syntax.
    cssTarget: 'chrome99',
  },
  server: {
    host: host || '127.0.0.1',
    port: 1420,
    strictPort: true,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/target/**'] },
  },
})
