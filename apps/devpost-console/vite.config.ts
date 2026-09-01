import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * The console is a standalone app with no backend of its own — everything it
 * answers comes from the world package, in the browser. So no API middleware
 * here, unlike apps/web.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    // A fixed port, because apps/web already owns 5173 and a second app that
    // silently picks 5174-or-whatever makes `dev` output that has to be read
    // rather than assumed.
    port: 5174,
    strictPort: true,
    // Same reason as apps/web: the repo lives on /mnt/c, where inotify never
    // fires and edits behind an @import are served stale without polling.
    watch: { usePolling: true, interval: 300 },
  },
})
