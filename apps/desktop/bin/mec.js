#!/usr/bin/env node
// Dev bin: Node >= 23 strips types natively, so the .ts entry runs without a build step.
// Packaged builds replace this with a bundled dist entry (B0 packaging milestone).
import('../src/mec.ts')
