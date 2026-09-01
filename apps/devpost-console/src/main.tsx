import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App.tsx'
import { useConsoleStore } from './state/store.ts'
import { versionFromUrl } from './version.ts'
import { initWebMcp, type WebMcpStatus } from './webmcp/register.ts'
import './styles/base.css'

/**
 * The version is resolved before the first render and before the tools are
 * registered: a browser that reads the tool list at load must find the manifest
 * this URL asked for, not the default one swapped out a moment later.
 */
const version = versionFromUrl()
useConsoleStore.getState().setVersion(version)

function Root() {
  const [status, setStatus] = useState<WebMcpStatus>('unsupported')

  useEffect(() => {
    initWebMcp(version, (next) => {
      setStatus(next)
      console.info(
        next === 'active'
          ? `WebMCP: ${version} tools registered.`
          : 'WebMCP is not available in this browser; the console works without it.',
      )
    })
  }, [])

  return <App status={status} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
