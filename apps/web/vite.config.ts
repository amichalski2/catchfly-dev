import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

import { handleApi } from '../../netlify/functions/lib/router.ts'

// Vite runs from apps/web, but the environment — database URL, ingest key —
// belongs to the repo, so it is read from the root rather than duplicated here.
const rootEnv = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env')
if (existsSync(rootEnv)) process.loadEnvFile?.(rootEnv)

/**
 * Serves the API from the dev server.
 *
 * The dashboard reads its data over HTTP now, and Vite knows nothing about
 * Netlify functions — without this, `/api/projects` falls through to the SPA
 * fallback and the app receives index.html where it expected JSON. Mounting the
 * real handlers keeps `npm run dev` a single command, and keeps dev and
 * production on exactly the same code.
 */
function catchflyApi(): Plugin {
  return {
    name: 'catchfly-api',
    apply: 'serve',
    configureServer(server) {
      // Before Vite's own middleware, so the SPA fallback never sees /api/*.
      server.middlewares.use((req, res, next) => {
        void handleApi(req, res).then((handled) => {
          if (!handled) next()
        })
      })
    },
  }
}

const WATCH_INTERVAL_MS = Number(process.env.CATCHFLY_WATCH_INTERVAL_MS) || 2000

// https://vite.dev/config/
export default defineConfig({
  envDir: dirname(rootEnv),
  plugins: [react(), catchflyApi()],
  server: {
    // The repo lives on a Windows drive mounted into WSL (/mnt/c), where
    // inotify never fires. Without polling, edits to a file reached through
    // an @import — every token and layout file behind styles/base.css — are
    // served from the previous transform and the browser shows stale CSS
    // until the dev server is restarted.
    //
    // Polling that mount is not free: measured here it costs about one core per
    // second of interval, and at the 300 ms this used to run at it took two —
    // enough to starve the event loop this same process answers the API from,
    // which turned a 60 ms query into nine seconds. Narrowing what is watched
    // changed nothing measurable; the interval is the only lever. From a
    // Linux-filesystem checkout inotify does fire: CATCHFLY_WATCH_POLL=off then
    // pays none of this.
    watch:
      process.env.CATCHFLY_WATCH_POLL === 'off'
        ? undefined
        : { usePolling: true, interval: WATCH_INTERVAL_MS, binaryInterval: WATCH_INTERVAL_MS * 2 },
  },
})
