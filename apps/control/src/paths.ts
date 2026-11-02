import { fileURLToPath } from 'node:url'

// Resolved relative to this module; src/ and dist/ both sit one level below apps/control.
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))
export const WEB_DIST_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url))
