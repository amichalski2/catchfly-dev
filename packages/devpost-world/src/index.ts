/**
 * The Devpost Review Console demo world.
 *
 * Note what this barrel does NOT re-export: judging.ts. Anything that needs the
 * answers imports that file by name, which makes every such import visible in a
 * grep and keeps a careless `import { x } from '@catchfly/devpost-world'` from
 * pulling the judging verdicts into a browser bundle.
 */

export * from './catalog.ts';
export * from './app-data.ts';
export * from './tools.ts';
