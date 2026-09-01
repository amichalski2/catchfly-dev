/**
 * Which manifest this page serves.
 *
 * The eval runner points a browser at one URL for a whole suite, so the only
 * way to evaluate three versions of the tool surface is to let the URL choose
 * one: `?version=console-v2` serves the manifest that shipped with the docs
 * cleanup. Default is the newest, which is what a visitor should see.
 *
 * The chosen version changes the *descriptions and schemas* agents read. It
 * never changes what the backend accepts — that asymmetry is the point of the
 * whole demo, and it lives in the world package, not here.
 */

import { APP_VERSIONS } from '@catchfly/devpost-world/tools.ts'

export const DEFAULT_VERSION = 'console-v3'

export function versionFromUrl(search: string = window.location.search): string {
  const asked = new URLSearchParams(search).get('version')
  if (!asked) return DEFAULT_VERSION
  const known = APP_VERSIONS.some((version) => version.id === asked)
  if (!known) {
    console.warn(`No manifest "${asked}" — serving ${DEFAULT_VERSION}.`)
    return DEFAULT_VERSION
  }
  return asked
}

export const labelFor = (versionId: string): string =>
  APP_VERSIONS.find((version) => version.id === versionId)?.label ?? versionId
