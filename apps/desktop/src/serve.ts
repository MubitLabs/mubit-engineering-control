/**
 * The guarded server entry (plan §21): start the composition, announce the URL, stay alive
 * until SIGINT/SIGTERM, then close in order. Stop-marker aware on both ends: it refuses to
 * start while an intentional stop stands, and its shutdown leaves no marker behind (a stop
 * is written by `mec stop`, never by a signal).
 *
 * TODO(B0 wiring): `mec.ts`'s `main` still calls a no-op `startServer`; pointing its
 * `CliIo.startServer` at `serveMain(home)` is the wiring step this module exists for.
 */
import { startServer } from './composition'
import { readStopMarker } from './stop-marker'

export async function serveMain(dataDir: string): Promise<void> {
  if (readStopMarker(dataDir).present) {
    console.log('intentional stop marker present; not starting (run: mec restart)')
    return
  }

  const handle = await startServer({ dataDir })
  console.log(`mec server listening on ${handle.url}`)

  await new Promise<void>((resolve) => {
    let stopped = false
    const shutdown = (signal: string): void => {
      if (stopped) return
      stopped = true
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
      console.log(`mec server stopping on ${signal}`)
      handle
        .close()
        .catch((error: unknown) => {
          console.log(`mec server shutdown error: ${error instanceof Error ? error.message : String(error)}`)
        })
        .then(() => resolve())
    }
    const onSigint = (): void => shutdown('SIGINT')
    const onSigterm = (): void => shutdown('SIGTERM')
    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)
  })
}
