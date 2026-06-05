#!/usr/bin/env node

import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

/** @type {import('esbuild').BuildOptions} */
const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  minify: true,
}

await build(opts)
await rm('out/extension.js.map', { force: true })
