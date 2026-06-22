import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

type PackageJson = {
  extensionKind?: string[]
  capabilities?: {
    untrustedWorkspaces?: { supported?: unknown; description?: unknown }
    virtualWorkspaces?: { supported?: unknown; description?: unknown } | boolean
  }
  contributes?: {
    configuration?: {
      properties?: Record<string, { default?: unknown; minimum?: unknown; maximum?: unknown }>
    }
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as PackageJson

test('manifest declares the workspace and trust boundaries for Git execution', () => {
  assert.deepEqual(pkg.extensionKind, ['workspace'])
  assert.equal(pkg.capabilities?.untrustedWorkspaces?.supported, false)

  const virtualWorkspaces = pkg.capabilities?.virtualWorkspaces
  assert.equal(typeof virtualWorkspaces, 'object')
  assert.equal(typeof virtualWorkspaces === 'object' ? virtualWorkspaces.supported : undefined, false)
})

test('manifest bounds automatic blame for large files', () => {
  const maxFileLines = pkg.contributes?.configuration?.properties?.['culprit.maxFileLines']

  assert.equal(maxFileLines?.default, 10_000)
  assert.equal(maxFileLines?.minimum, 1_000)
  assert.equal(maxFileLines?.maximum, 100_000)
})
