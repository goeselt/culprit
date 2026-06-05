import * as vscode from 'vscode'
import { basename } from 'node:path'
import { blameFile, fileExistsInParent, fileHistory, relativeDate, type BlameInfo, type HistoryEntry } from './git.js'

const EMPTY_SCHEME = 'culprit-empty'
const CACHE_TTL = 10 * 60_000
// Negative results from a failed git call (timeout, transient lock, untracked
// file) expire quickly so a one-off failure does not suppress blame for the
// full CACHE_TTL.
const ERROR_CACHE_TTL = 5_000
const MAX_BLAME_FILES = 200
const MAX_HISTORY_CACHE_ENTRIES = 100

type CacheEntry<T> = { data: T; expires: number }
type FileBlame = Map<number, BlameInfo>

const blameCache = new Map<string, CacheEntry<FileBlame>>()
const historyCache = new Map<string, CacheEntry<HistoryEntry[]>>()
const refreshInFlight = new Map<string, Promise<FileBlame>>()
const gitWatchers: vscode.Disposable[] = []

let enabled = true
let decorationType: vscode.TextEditorDecorationType
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let gitInvalidationTimer: ReturnType<typeof setTimeout> | undefined
let cacheGeneration = 0
let lastActiveLine = -1
let lastActiveFile = ''

export function activate(ctx: vscode.ExtensionContext) {
  enabled = vscode.workspace.getConfiguration('culprit').get<boolean>('enabled', true)

  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => '',
    }),
  )

  decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      margin: '0 0 0 3em',
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  })

  registerGitWatchers()

  ctx.subscriptions.push(
    decorationType,
    vscode.window.onDidChangeTextEditorSelection((e) => scheduleUpdate(e.textEditor)),
    vscode.window.onDidChangeActiveTextEditor((e) => e && scheduleUpdate(e)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor
      if (ed?.document !== e.document) return
      lastActiveLine = -1
      lastActiveFile = ''
      if (e.document.isDirty) ed.setDecorations(decorationType, [])
      else scheduleUpdate(ed)
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      invalidateFile(doc.uri.fsPath)
      const ed = vscode.window.activeTextEditor
      if (ed?.document === doc) {
        lastActiveLine = -1
        scheduleUpdate(ed)
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('culprit.enabled')) return
      enabled = vscode.workspace.getConfiguration('culprit').get<boolean>('enabled', true)
      const ed = vscode.window.activeTextEditor
      if (!ed) return
      lastActiveLine = -1
      if (enabled) scheduleUpdate(ed)
      else ed.setDecorations(decorationType, [])
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => registerGitWatchers()),
    vscode.commands.registerCommand('culprit.toggle', toggleEnabled),
    vscode.commands.registerCommand('culprit.showDiff', showDiff),
    { dispose: disposeGitWatchers },
  )

  if (vscode.window.activeTextEditor) scheduleUpdate(vscode.window.activeTextEditor)
}

export function deactivate() {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (gitInvalidationTimer) clearTimeout(gitInvalidationTimer)
  disposeGitWatchers()
  clearCaches()
}

function toggleEnabled() {
  enabled = !enabled
  vscode.window.showInformationMessage(`Culprit: ${enabled ? 'enabled' : 'disabled'}`)
  void vscode.workspace.getConfiguration('culprit').update('enabled', enabled, vscode.ConfigurationTarget.Global)
  const ed = vscode.window.activeTextEditor
  if (!ed) return
  lastActiveLine = -1
  if (enabled) scheduleUpdate(ed)
  else ed.setDecorations(decorationType, [])
}

function scheduleUpdate(editor: vscode.TextEditor) {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    void updateDecoration(editor)
  }, 150)
}

async function updateDecoration(editor: vscode.TextEditor) {
  if (!enabled || editor.document.uri.scheme !== 'file' || editor.document.isDirty) {
    editor.setDecorations(decorationType, [])
    lastActiveLine = -1
    lastActiveFile = ''
    return
  }

  const path = editor.document.uri.fsPath
  const activeLine = editor.selection.active.line + 1

  if (path === lastActiveFile && activeLine === lastActiveLine) return

  editor.setDecorations(decorationType, [])

  const info = await getLineBlame(path, activeLine)
  const current = vscode.window.activeTextEditor
  if (current !== editor || editor.selection.active.line + 1 !== activeLine) return

  lastActiveLine = activeLine
  lastActiveFile = path

  if (!info || info.isUncommitted) {
    editor.setDecorations(decorationType, [])
    return
  }

  const lineIdx = activeLine - 1
  const lineEnd = editor.document.lineAt(lineIdx).range.end
  const fileEntries = getCachedEntry(historyCache, path)?.data ?? []

  setLineDecoration(editor, lineIdx, lineEnd.character, info, fileEntries, path)
  if (fileEntries.length === 0) void refreshDecorationHover(editor, activeLine, info, path)
}

async function getLineBlame(path: string, lineNumber: number): Promise<BlameInfo | undefined> {
  const blame = await getFileBlame(path)
  return blame.get(lineNumber)
}

function getFileBlame(path: string): Promise<FileBlame> {
  const cached = getCachedEntry(blameCache, path)
  if (cached) return Promise.resolve(cached.data)

  const inFlight = refreshInFlight.get(path)
  if (inFlight) return inFlight

  const generation = cacheGeneration
  const promise = blameFile(path)
    .then((data) => {
      if (generation === cacheGeneration) setCached(blameCache, path, data, MAX_BLAME_FILES, CACHE_TTL)
      return data
    })
    .catch(() => {
      const empty: FileBlame = new Map()
      if (generation === cacheGeneration) setCached(blameCache, path, empty, MAX_BLAME_FILES, ERROR_CACHE_TTL)
      return empty
    })
    .finally(() => {
      if (refreshInFlight.get(path) === promise) refreshInFlight.delete(path)
    })

  refreshInFlight.set(path, promise)
  return promise
}

function getFileHistory(path: string): Promise<HistoryEntry[]> {
  const cached = getCachedEntry(historyCache, path)
  if (cached) return Promise.resolve(cached.data)

  const generation = cacheGeneration
  return fileHistory(path, 5)
    .then((data) => {
      if (generation !== cacheGeneration) return []
      setCached(historyCache, path, data, MAX_HISTORY_CACHE_ENTRIES, CACHE_TTL)
      return data
    })
    .catch(() => {
      if (generation === cacheGeneration) setCached(historyCache, path, [], MAX_HISTORY_CACHE_ENTRIES, ERROR_CACHE_TTL)
      return []
    })
}

function buildHover(info: BlameInfo, fileEntries: HistoryEntry[], filePath: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true)
  md.isTrusted = { enabledCommands: ['culprit.showDiff'] }

  const short = info.sha.slice(0, 7)
  const args = encodeURIComponent(JSON.stringify([info.sha, filePath]))
  md.appendMarkdown('**Recent Line Commit**\n\n')
  md.appendMarkdown(
    `[\`${short}\`](command:culprit.showDiff?${args}) ${esc(firstLine(info.summary))} (${esc(info.author)} - ${relativeDate(info.date)})\n\n`,
  )

  // Skip the file-history section when it would just repeat the line commit:
  // a single entry that is the same commit as the line blame.
  const redundant = fileEntries.length === 1 && fileEntries[0].sha === info.sha
  if (fileEntries.length > 0 && !redundant) {
    md.appendMarkdown('---\n\n')
    md.appendMarkdown('**Recent File Commits**\n\n')
    for (const e of fileEntries) {
      const s = e.sha.slice(0, 7)
      const a = encodeURIComponent(JSON.stringify([e.sha, filePath]))
      md.appendMarkdown(
        `[\`${s}\`](command:culprit.showDiff?${a}) ${esc(firstLine(e.summary))} (${esc(e.author)} - ${relativeDate(e.date)})\n\n`,
      )
    }
  }

  return md
}

async function refreshDecorationHover(editor: vscode.TextEditor, activeLine: number, info: BlameInfo, path: string) {
  const fileEntries = await getFileHistory(path)
  const current = vscode.window.activeTextEditor
  if (current !== editor || editor.document.uri.fsPath !== path || editor.selection.active.line + 1 !== activeLine) {
    return
  }

  const lineIdx = activeLine - 1
  const lineEnd = editor.document.lineAt(lineIdx).range.end
  setLineDecoration(editor, lineIdx, lineEnd.character, info, fileEntries, path)
}

function setLineDecoration(
  editor: vscode.TextEditor,
  lineIdx: number,
  lineEndCharacter: number,
  info: BlameInfo,
  fileEntries: HistoryEntry[],
  path: string,
) {
  editor.setDecorations(decorationType, [
    {
      range: new vscode.Range(lineIdx, lineEndCharacter, lineIdx, lineEndCharacter),
      hoverMessage: buildHover(info, fileEntries, path),
      renderOptions: {
        after: {
          contentText: `${info.sha.slice(0, 7)}: ${firstLine(info.summary, 50)}`,
        },
      },
    },
  ])
}

async function showDiff(sha: string, filePath: string) {
  if (!sha || /^0+$/.test(sha)) return

  const short = sha.slice(0, 7)
  const name = basename(filePath)
  const gitUri = (ref: string) =>
    vscode.Uri.from({
      scheme: 'git',
      path: filePath,
      query: JSON.stringify({ path: filePath, ref }),
    })

  if (await fileExistsInParent(sha, filePath)) {
    await vscode.commands.executeCommand('vscode.diff', gitUri(`${sha}~1`), gitUri(sha), `${short}: ${name}`)
  } else {
    const emptyUri = vscode.Uri.from({ scheme: EMPTY_SCHEME, path: filePath })
    await vscode.commands.executeCommand('vscode.diff', emptyUri, gitUri(sha), `${short} (new file): ${name}`)
  }
}

function registerGitWatchers() {
  disposeGitWatchers()

  // Watches the conventional in-tree .git directory. For worktrees/submodules
  // (where .git is a pointer file to an external gitdir) ref changes are not
  // observed here; the CACHE_TTL backstop covers those cases.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const pattern of ['.git/HEAD', '.git/index', '.git/packed-refs', '.git/refs/heads/**']) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern))
      gitWatchers.push(
        watcher,
        watcher.onDidChange(scheduleGitInvalidation),
        watcher.onDidCreate(scheduleGitInvalidation),
        watcher.onDidDelete(scheduleGitInvalidation),
      )
    }
  }
}

function disposeGitWatchers() {
  for (const watcher of gitWatchers.splice(0)) {
    watcher.dispose()
  }
}

function scheduleGitInvalidation() {
  if (gitInvalidationTimer) clearTimeout(gitInvalidationTimer)
  gitInvalidationTimer = setTimeout(() => {
    clearCaches()
    const ed = vscode.window.activeTextEditor
    if (ed) {
      lastActiveLine = -1
      scheduleUpdate(ed)
    }
  }, 100)
}

function clearCaches() {
  cacheGeneration++
  blameCache.clear()
  historyCache.clear()
  refreshInFlight.clear()
}

function invalidateFile(path: string) {
  blameCache.delete(path)
  historyCache.delete(path)
}

function getCachedEntry<T>(cache: Map<string, CacheEntry<T>>, key: string): CacheEntry<T> | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() >= entry.expires) {
    cache.delete(key)
    return undefined
  }

  cache.delete(key)
  cache.set(key, entry)
  return entry
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T, maxEntries: number, ttl: number) {
  const now = Date.now()

  for (const [cacheKey, entry] of cache) {
    if (now >= entry.expires) cache.delete(cacheKey)
  }

  cache.delete(key)
  cache.set(key, { data, expires: now + ttl })

  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/([\\`*_[\]{}()#+\-!|>~])/g, '\\$1')
}

function firstLine(text: string, maxLen = 72): string {
  const line = text.split('\n')[0]
  return line.length > maxLen ? `${line.slice(0, maxLen)}...` : line
}
