import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { isWorkspaceFilePath } from '../src/paths.js'

test('isWorkspaceFilePath accepts absolute paths inside a workspace root', () => {
  const root = resolve('/tmp/culprit-workspace')

  assert.equal(isWorkspaceFilePath(join(root, 'src', 'file.ts'), [root]), true)
  assert.equal(isWorkspaceFilePath(root, [root]), true)
})

test('isWorkspaceFilePath rejects paths outside workspace roots', () => {
  const root = resolve('/tmp/culprit-workspace')

  assert.equal(isWorkspaceFilePath(resolve('/tmp/culprit-workspace-evil/file.ts'), [root]), false)
  assert.equal(isWorkspaceFilePath(resolve('/tmp/other/file.ts'), [root]), false)
  assert.equal(isWorkspaceFilePath('relative/file.ts', [root]), false)
  assert.equal(isWorkspaceFilePath('', [root]), false)
  assert.equal(isWorkspaceFilePath(`${join(root, 'file.ts')}\0ignored`, [root]), false)
})
