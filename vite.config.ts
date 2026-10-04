import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const ollamaUrl = env.OLLAMA_URL || 'http://127.0.0.1:11434'
  return {
    plugins: [react()],
    server: {
      // Bind to localhost only: prescriptions should not be reachable from the network.
      host: '127.0.0.1',
      proxy: {
        '/ollama': {
          target: ollamaUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/ollama/, ''),
        },
      },
    },
    preview: { host: '127.0.0.1' },
    test: { environment: 'node' },
  }
})
