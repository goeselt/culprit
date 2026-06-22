import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { fileExistsInParent, fileHistory, isValidCommitSha } from '../src/git.js'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createRepo(): { dir: string; file: string; first: string; second: string } {
  const dir = mkdtempSync(join(tmpdir(), 'culprit-git-'))
  const file = join(dir, 'tracked.txt')

  git(dir, ['init', '--quiet'])
  git(dir, ['config', 'user.name', 'Culprit Test'])
  git(dir, ['config', 'user.email', 'culprit@example.invalid'])

  writeFileSync(file, 'one\n')
  git(dir, ['add', 'tracked.txt'])
  git(dir, ['commit', '--quiet', '-m', 'first'])
  const first = git(dir, ['rev-parse', 'HEAD'])

  writeFileSync(file, 'two\n')
  git(dir, ['commit', '--quiet', '-am', 'second'])
  const second = git(dir, ['rev-parse', 'HEAD'])

  return { dir, file, first, second }
}

test('commit SHA validation accepts only full non-zero hex object IDs', () => {
  assert.equal(isValidCommitSha('a'.repeat(40)), true)
  assert.equal(isValidCommitSha('a'.repeat(64)), true)
  assert.equal(isValidCommitSha('0'.repeat(40)), false)
  assert.equal(isValidCommitSha('HEAD'), false)
  assert.equal(isValidCommitSha('a'.repeat(39)), false)
  assert.equal(isValidCommitSha('g'.repeat(40)), false)
})

test('fileExistsInParent rejects invalid rev input before building a git object spec', async () => {
  const repo = createRepo()
  try {
    assert.equal(await fileExistsInParent('HEAD', repo.file), false)
    assert.equal(await fileExistsInParent(`${repo.second}:tracked.txt`, repo.file), false)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
  }
})

test('fileExistsInParent uses a repo-relative path for valid commits', async () => {
  const repo = createRepo()
  try {
    assert.equal(await fileExistsInParent(repo.second, repo.file), true)
    assert.equal(await fileExistsInParent(repo.first, repo.file), false)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
  }
})

test('fileHistory clamps unsafe max-count values', async () => {
  const repo = createRepo()
  try {
    const entries = await fileHistory(repo.file, Number.POSITIVE_INFINITY)
    assert.equal(entries.length, 2)
    assert.equal(entries[0].sha, repo.second)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
  }
})
