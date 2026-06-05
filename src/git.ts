import { execFile } from 'node:child_process'
import { dirname } from 'node:path'

const GIT_TIMEOUT_MS = 5_000
const SHA_RE = /^[0-9a-f]{40,64}$/

// Repo root per directory. The toplevel is effectively immutable for a given
// directory, so caching it avoids a `git rev-parse` spawn on every diff click.
const toplevelCache = new Map<string, string>()

export interface BlameInfo {
  sha: string
  author: string
  date: Date
  summary: string
  isUncommitted: boolean
}

export interface HistoryEntry {
  sha: string
  author: string
  date: Date
  summary: string
}

function run(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: GIT_TIMEOUT_MS },
      (err: Error | null, stdout: string) => {
        if (err) reject(err)
        else resolve(stdout)
      },
    )
  })
}

/**
 * git blame --porcelain parser for the whole file. Returns a map from 1-based
 * line number to blame info. Blaming the whole file in one git invocation lets
 * callers serve every line lookup from the result, instead of spawning one git
 * process per line.
 */
export async function blameFile(filePath: string): Promise<Map<number, BlameInfo>> {
  const cwd = dirname(filePath)
  const out = await run(['blame', '--porcelain', '--', filePath], cwd)
  const result = new Map<number, BlameInfo>()

  // Porcelain emits a commit's header fields (author, time, summary) only on its
  // first occurrence; later lines for the same commit repeat just the SHA line.
  // Cache the fields by SHA so repeated commits reuse them.
  const seen = new Map<string, { author: string; date: Date; summary: string }>()

  let sha = ''
  let lineNumber = 0
  let author = ''
  let date = new Date(0)
  let summary = ''

  for (const raw of out.split('\n')) {
    // Header: "<sha> <orig-line> <final-line> [<group-size>]"; group 2 is the
    // 1-based final line number.
    const hdr = raw.match(/^([0-9a-f]{40,64}) \d+ (\d+)/)
    if (hdr) {
      sha = hdr[1]
      lineNumber = Number.parseInt(hdr[2], 10)
      const cached = seen.get(sha)
      if (cached) {
        ;({ author, date, summary } = cached)
      }
      continue
    }

    if (raw.startsWith('author ')) {
      author = raw.slice(7)
      continue
    }
    if (raw.startsWith('author-time ')) {
      date = new Date(Number.parseInt(raw.slice(12), 10) * 1000)
      continue
    }
    if (raw.startsWith('summary ')) {
      summary = raw.slice(8)
      continue
    }

    if (raw.startsWith('\t')) {
      if (!seen.has(sha)) seen.set(sha, { author, date, summary })
      result.set(lineNumber, { sha, author, date, summary, isUncommitted: /^0+$/.test(sha) })
    }
  }

  return result
}

/**
 * git log (file history)
 */
export async function fileHistory(filePath: string, count = 3): Promise<HistoryEntry[]> {
  const cwd = dirname(filePath)

  const out = await run(['log', `--max-count=${count}`, '--pretty=format:%H%x00%an%x00%aI%x00%s', '--', filePath], cwd)

  const entries: HistoryEntry[] = []

  for (const line of out.split('\n')) {
    const parts = line.split('\x00')
    if (parts.length >= 4 && SHA_RE.test(parts[0])) {
      entries.push({
        sha: parts[0],
        author: parts[1],
        date: new Date(parts[2]),
        summary: parts[3],
      })
    }
  }

  return entries
}

/**
 * Check if a file existed in the parent of the given commit.
 */
export async function fileExistsInParent(sha: string, filePath: string): Promise<boolean> {
  try {
    // Resolve relative path from repo root
    const cwd = dirname(filePath)
    const root = await repoToplevel(cwd)
    const rel = filePath.slice(root.length + 1).replace(/\\/g, '/')
    // Check if the file exists at sha~1
    await run(['cat-file', '-e', `${sha}~1:${rel}`], cwd)
    return true
  } catch {
    return false
  }
}

async function repoToplevel(cwd: string): Promise<string> {
  const cached = toplevelCache.get(cwd)
  if (cached !== undefined) return cached
  const root = (await run(['rev-parse', '--show-toplevel'], cwd)).trim()
  toplevelCache.set(cwd, root)
  return root
}

/**
 * Relative date formatting
 */
export function relativeDate(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return min === 1 ? '1 minute ago' : `${min} minutes ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`
  const months = Math.floor(days / 30)
  if (months < 12) return months === 1 ? '1 month ago' : `${months} months ago`
  const years = Math.floor(days / 365)
  return years === 1 ? '1 year ago' : `${years} years ago`
}
