// Bundles a TypeScript entry for Node: workspace packages (@mec/*) are inlined, npm packages stay
// external and resolve from the app's node_modules at runtime.
import { build } from 'esbuild'

const [entry, outfile] = process.argv.slice(2)
if (!entry || !outfile) {
  console.error('usage: node scripts/bundle.mjs <entry.ts> <out.js>')
  process.exit(1)
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  logLevel: 'warning',
  plugins: [
    {
      name: 'external-npm',
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith('@mec/') ? undefined : { path: args.path, external: true },
        )
      },
    },
  ],
})
