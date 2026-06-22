import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  blameFile,
  defaultIgnoreRevsFile,
  fileExistsInParent,
  fileHistory,
  isValidCommitSha,
  remoteCommitWebUrl,
} from '../src/git.js'

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

test('blameFile accepts a configured ignore-revs file when present', async () => {
  const repo = createRepo()
  const ignoreRevs = join(repo.dir, '.git-blame-ignore-revs')
  try {
    writeFileSync(ignoreRevs, `${repo.second}\n`)
    const blame = await blameFile(repo.file, { ignoreRevsFile: ignoreRevs })
    assert.equal(blame.size, 1)
    assert.equal(await defaultIgnoreRevsFile(repo.file, '.git-blame-ignore-revs'), ignoreRevs)
    assert.equal(await defaultIgnoreRevsFile(repo.file, '../outside'), undefined)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
  }
})

test('defaultIgnoreRevsFile rejects symlinks before passing paths to git', async () => {
  const repo = createRepo()
  const outside = join(repo.dir, '..', 'outside-ignore-revs')
  const ignoreRevs = join(repo.dir, '.git-blame-ignore-revs')

  try {
    writeFileSync(outside, `${repo.second}\n`)
    symlinkSync(outside, ignoreRevs)

    assert.equal(await defaultIgnoreRevsFile(repo.file, '.git-blame-ignore-revs'), undefined)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(outside, { force: true })
  }
})

test('blameFile does not execute configured textconv commands', async () => {
  const repo = createRepo()
  const marker = join(repo.dir, 'textconv-ran')
  const textconv = join(repo.dir, 'textconv.js')

  try {
    writeFileSync(join(repo.dir, '.gitattributes'), '*.txt diff=evil\n')
    writeFileSync(
      textconv,
      [
        "const { readFileSync, writeFileSync } = require('node:fs')",
        `writeFileSync(${JSON.stringify(marker)}, 'executed')`,
        "process.stdout.write(readFileSync(process.argv[2], 'utf8'))",
        '',
      ].join('\n'),
    )
    git(repo.dir, ['add', '.gitattributes'])
    git(repo.dir, ['commit', '--quiet', '-m', 'configure textconv'])
    git(repo.dir, ['config', 'diff.evil.textconv', `node ${JSON.stringify(textconv)}`])

    const blame = await blameFile(repo.file)

    assert.equal(blame.size, 1)
    assert.equal(existsSync(marker), false)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
  }
})

test('remoteCommitWebUrl supports common Git remote formats without executing remote data', () => {
  const sha = 'a'.repeat(40)
  assert.equal(remoteCommitWebUrl('git@github.com:goeselt/culprit.git', sha), `https://github.com/goeselt/culprit/commit/${sha}`)
  assert.equal(remoteCommitWebUrl('https://gitlab.com/goeselt/culprit.git', sha), `https://gitlab.com/goeselt/culprit/commit/${sha}`)
  assert.equal(remoteCommitWebUrl('ssh://git@bitbucket.org/goeselt/culprit.git', sha), `https://bitbucket.org/goeselt/culprit/commits/${sha}`)
  assert.equal(remoteCommitWebUrl('javascript:alert(1)', sha), undefined)
  assert.equal(remoteCommitWebUrl('git@github.com/evil:goeselt/culprit.git', sha), undefined)
  assert.equal(remoteCommitWebUrl('git@github.com:goeselt/../culprit.git', sha), undefined)
})
