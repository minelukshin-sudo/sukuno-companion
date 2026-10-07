import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // Bind to IPv4: Electron may resolve "localhost" to ::1 and miss the dev server.
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: {
      rollupOptions: {
        input: {
          avatar: resolve(__dirname, 'src/renderer/index.html'),
          chat: resolve(__dirname, 'src/renderer/chat.html'),
          settings: resolve(__dirname, 'src/renderer/settings.html')
        }
      }
    }
  }
})
