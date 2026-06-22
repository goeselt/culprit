#!/usr/bin/env node
// Verifies that engines.vscode and @types/vscode share the same version.
// Run locally: node .github/workflows/ci-check-vscode.js
'use strict'

const pkg = require('../../package.json')
const types = pkg.devDependencies['@types/vscode'].replace(/^[\^~]/, '')
const engine = pkg.engines.vscode.replace(/^[\^~]/, '')

if (types !== engine) {
  console.error(`engines.vscode (${engine}) does not match @types/vscode (${types})`)
  console.error('Run "npm run update" to align both, then commit the result.')
  process.exit(1)
}

console.log(`OK: engines.vscode matches @types/vscode (${engine})`)
