import * as vscode from 'vscode'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  blameFile,
  defaultIgnoreRevsFile,
  fileExistsInParent,
  fileHistory,
  isValidCommitSha,
  remoteCommitUrl,
  relativeDate,
  type BlameInfo,
  type HistoryEntry,
} from './git.js'

const EMPTY_SCHEME = 'culprit-empty'
const CACHE_TTL = 10 * 60_000
// Negative results from a failed git call (timeout, transient lock, untracked
// file) expire quickly so a one-off failure does not suppress blame for the
// full CACHE_TTL.
const ERROR_CACHE_TTL = 5_000
const MAX_BLAME_FILES = 200
const MAX_HISTORY_CACHE_ENTRIES = 100
const UPDATE_DEBOUNCE_MS = 150
const GIT_INVALIDATION_DEBOUNCE_MS = 100
const RECENT_FILE_COMMITS = 5
const COPY_STATUS_TTL = 1_500
const REMOTE_STATUS_TTL = 3_000

type CacheEntry<T> = { data: T; expires: number }
type FileBlame = Map<number, BlameInfo>
type DateFormat = 'relative' | 'absolute'
type AuthorFormat = 'full' | 'first' | 'email' | 'hidden'
type OwnershipRange = { start: number; end: number }
type BlameContext = { info: BlameInfo; filePath: string; fileEntries: HistoryEntry[]; range: OwnershipRange }
type Settings = {
  ignoreRevsEnabled: boolean
  ignoreRevsFile: string
  authorFormat: AuthorFormat
  dateFormat: DateFormat
  locale: string
  summaryMaxLength: number
  inlineFormat: string
}

const blameCache = new Map<string, CacheEntry<FileBlame>>()
const historyCache = new Map<string, CacheEntry<HistoryEntry[]>>()
const refreshInFlight = new Map<string, Promise<FileBlame>>()
const gitWatchers: vscode.Disposable[] = []

let enabled = true
let decorationType: vscode.TextEditorDecorationType
let debounceTimer: ReturnType<typeof setTimeout> | undefined
let gitInvalidationTimer: ReturnType<typeof setTimeout> | undefined
let cacheGeneration = 0
let watcherGeneration = 0
let lastActiveLine = -1
let lastActiveFile = ''

// Extension lifecycle -------------------------------------------------------

export function activate(ctx: vscode.ExtensionContext) {
  enabled = vscode.workspace.getConfiguration('culprit').get<boolean>('enabled', true)

  ctx.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, {
      provideTextDocumentContent: () => '',
    }),
  )

  decorationType = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('git.blame.editorDecorationForeground'),
      margin: '0 0 0 50px',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  })

  registerGitWatchers()

  ctx.subscriptions.push(
    decorationType,
    vscode.window.onDidChangeTextEditorSelection((e) => {
      scheduleUpdate(e.textEditor)
    }),
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (e) scheduleUpdate(e)
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor
      if (ed?.document !== e.document) return
      resetActivePosition()
      if (e.document.isDirty) clearEditorDecorations(ed)
      else scheduleUpdate(ed)
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      invalidateFile(doc.uri.fsPath)
      const ed = vscode.window.activeTextEditor
      if (ed?.document === doc) {
        resetActivePosition()
        scheduleUpdate(ed)
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('culprit')) return
      enabled = vscode.workspace.getConfiguration('culprit').get<boolean>('enabled', true)
      const ed = vscode.window.activeTextEditor
      clearCaches()
      if (!ed) return
      resetActivePosition()
      if (enabled) scheduleUpdate(ed)
      else clearEditorDecorations(ed)
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => registerGitWatchers()),
    vscode.commands.registerCommand('culprit.toggle', toggleEnabled),
    vscode.commands.registerCommand('culprit.showDiff', showDiff),
    vscode.commands.registerCommand('culprit.copySha', copySha),
    vscode.commands.registerCommand('culprit.openRemoteCommit', openRemoteCommit),
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

// Active-line decoration lifecycle -----------------------------------------

function toggleEnabled() {
  enabled = !enabled
  vscode.window.showInformationMessage(`Culprit: ${enabled ? 'enabled' : 'disabled'}`)
  void vscode.workspace.getConfiguration('culprit').update('enabled', enabled, vscode.ConfigurationTarget.Global)
  const ed = vscode.window.activeTextEditor
  if (!ed) return
  resetActivePosition()
  if (enabled) scheduleUpdate(ed)
  else clearEditorDecorations(ed)
}

function scheduleUpdate(editor: vscode.TextEditor) {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    void updateDecoration(editor)
  }, UPDATE_DEBOUNCE_MS)
}

async function updateDecoration(editor: vscode.TextEditor) {
  if (!enabled || editor.document.uri.scheme !== 'file' || editor.document.isDirty) {
    clearEditorDecorations(editor)
    resetActivePosition()
    return
  }

  const path = editor.document.uri.fsPath
  const activeLine = editor.selection.active.line + 1

  if (path === lastActiveFile && activeLine === lastActiveLine) return

  clearInactiveEditorDecorations(editor)
  clearEditorDecorations(editor)

  const blame = await getFileBlame(path)
  const info = blame.get(activeLine)
  const current = vscode.window.activeTextEditor
  if (current !== editor || editor.selection.active.line + 1 !== activeLine) return

  lastActiveLine = activeLine
  lastActiveFile = path

  if (!info || info.isUncommitted) {
    clearEditorDecorations(editor)
    return
  }

  const lineIdx = activeLine - 1
  const lineEnd = editor.document.lineAt(lineIdx).range.end
  const fileEntries = getCachedEntry(historyCache, path)?.data ?? []
  const range = ownershipRange(blame, activeLine)
  const context = { info, filePath: path, fileEntries, range }

  setLineDecoration(editor, lineIdx, lineEnd.character, context)
  if (fileEntries.length === 0) void refreshDecorationHover(editor, activeLine, context)
}

// Git data access -----------------------------------------------------------

function getFileBlame(path: string): Promise<FileBlame> {
  const cached = getCachedEntry(blameCache, path)
  if (cached) return Promise.resolve(cached.data)

  const inFlight = refreshInFlight.get(path)
  if (inFlight) return inFlight

  const generation = cacheGeneration
  const settings = readSettings()
  const promise = blameOptions(path, settings)
    .then((options) => blameFile(path, options))
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
  return fileHistory(path, RECENT_FILE_COMMITS)
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

// Hover and inline rendering ------------------------------------------------

function buildHover(context: BlameContext): vscode.MarkdownString {
  const { info, fileEntries, filePath, range } = context
  const settings = readSettings()
  const md = new vscode.MarkdownString(undefined, true)
  md.isTrusted = { enabledCommands: ['culprit.copySha', 'culprit.openRemoteCommit', 'culprit.showDiff'] }
  md.supportThemeIcons = true

  md.appendMarkdown('**Line Commit**\n\n')
  appendCommitHoverLine(md, info, filePath, settings)
  md.appendMarkdown(`${formatOwnershipRange(range)}\n\n`)

  // Skip the file-history section when it would just repeat the line commit:
  // a single entry that is the same commit as the line blame.
  const redundant = fileEntries.length === 1 && fileEntries[0].sha === info.sha
  if (fileEntries.length > 0 && !redundant) {
    md.appendMarkdown('---\n\n')
    md.appendMarkdown('**Recent File Commits**\n\n')
    for (const e of fileEntries) {
      appendCommitHoverLine(md, e, filePath, settings)
    }
  }

  return md
}

function appendCommitHoverLine(
  md: vscode.MarkdownString,
  entry: Pick<BlameInfo, 'sha' | 'summary' | 'author' | 'authorEmail' | 'date'>,
  filePath: string,
  settings: Settings,
) {
  md.appendMarkdown(
    `${commitCompareAction(entry.sha, filePath)} ${esc(firstLine(entry.summary, settings.summaryMaxLength))} (${esc(formatAttribution(entry, settings))} ${commitUtilityActions(entry.sha, filePath)})\n\n`,
  )
}

function commitCompareAction(sha: string, filePath: string): string {
  const args = encodeURIComponent(JSON.stringify([sha, filePath]))
  const short = sha.slice(0, 7)
  return `[$(git-commit) \`${short}\`](command:culprit.showDiff?${args})`
}

function commitUtilityActions(sha: string, filePath: string): string {
  const args = encodeURIComponent(JSON.stringify([sha, filePath]))
  return `[$(copy)](command:culprit.copySha?${args}) [$(github)](command:culprit.openRemoteCommit?${args})`
}

async function refreshDecorationHover(editor: vscode.TextEditor, activeLine: number, context: BlameContext) {
  const fileEntries = await getFileHistory(context.filePath)
  const current = vscode.window.activeTextEditor
  if (
    current !== editor ||
    editor.document.uri.fsPath !== context.filePath ||
    editor.selection.active.line + 1 !== activeLine
  ) {
    return
  }

  const lineIdx = activeLine - 1
  const lineEnd = editor.document.lineAt(lineIdx).range.end
  const updated = { ...context, fileEntries }
  setLineDecoration(editor, lineIdx, lineEnd.character, updated)
}

function setLineDecoration(editor: vscode.TextEditor, lineIdx: number, lineEndCharacter: number, context: BlameContext) {
  const settings = readSettings()
  editor.setDecorations(decorationType, [
    {
      range: new vscode.Range(lineIdx, lineEndCharacter, lineIdx, lineEndCharacter),
      renderOptions: {
        after: {
          contentText: formatTemplate(settings.inlineFormat, context, settings),
        },
      },
      hoverMessage: buildHover(context),
    },
  ])
}

function clearEditorDecorations(editor: vscode.TextEditor) {
  editor.setDecorations(decorationType, [])
}

function clearInactiveEditorDecorations(activeEditor: vscode.TextEditor) {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor !== activeEditor) clearEditorDecorations(editor)
  }
}

// Commands ------------------------------------------------------------------

async function showDiff(sha: string, filePath: string) {
  if (!isValidCommitSha(sha) || !filePath) return

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

async function copySha(sha: string) {
  if (!isValidCommitSha(sha)) return
  await vscode.env.clipboard.writeText(sha)
  vscode.window.setStatusBarMessage(`Culprit: copied ${sha.slice(0, 7)}`, COPY_STATUS_TTL)
}

async function openRemoteCommit(sha: string, filePath: string) {
  if (!isValidCommitSha(sha) || !filePath) return
  const url = await remoteCommitUrl(sha, filePath)
  if (!url) {
    vscode.window.setStatusBarMessage('Culprit: no supported remote commit URL found.', REMOTE_STATUS_TTL)
    return
  }
  await vscode.env.openExternal(vscode.Uri.parse(url))
}

// Settings and formatting ---------------------------------------------------

function ownershipRange(blame: FileBlame, line: number): OwnershipRange {
  const info = blame.get(line)
  if (!info) return { start: line, end: line }

  let start = line
  let end = line
  while (blame.get(start - 1)?.sha === info.sha) start--
  while (blame.get(end + 1)?.sha === info.sha) end++
  return { start, end }
}

function formatOwnershipRange(range: OwnershipRange): string {
  if (range.start === range.end) return `Same commit: line ${range.start}`
  return `Same commit: lines ${range.start}-${range.end}`
}

async function blameOptions(path: string, settings: Settings) {
  if (!settings.ignoreRevsEnabled) return {}
  const ignoreRevsFile = await defaultIgnoreRevsFile(path, settings.ignoreRevsFile)
  return ignoreRevsFile ? { ignoreRevsFile } : {}
}

function readSettings(): Settings {
  const cfg = vscode.workspace.getConfiguration('culprit')
  return {
    ignoreRevsEnabled: cfg.get<boolean>('ignoreRevs.enabled', true),
    ignoreRevsFile: cfg.get<string>('ignoreRevs.file', '.git-blame-ignore-revs'),
    authorFormat: cfg.get<AuthorFormat>('authorFormat', 'full'),
    dateFormat: cfg.get<DateFormat>('dateFormat', 'relative'),
    locale: cfg.get<string>('locale', ''),
    summaryMaxLength: Math.max(20, Math.min(200, cfg.get<number>('summaryMaxLength', 50))),
    inlineFormat: cfg.get<string>('inlineFormat', '${summary}, ${author} (${date})'),
  }
}

function formatTemplate(template: string, context: BlameContext, settings: Settings): string {
  const values: Record<string, string> = {
    sha: context.info.sha.slice(0, 7),
    fullSha: context.info.sha,
    author: formatAuthor(context.info, settings),
    date: formatDate(context.info.date, settings),
    summary: firstLine(context.info.summary, settings.summaryMaxLength),
    range: context.range.start === context.range.end ? `${context.range.start}` : `${context.range.start}-${context.range.end}`,
  }

  return tidyFormattedText(template.replace(/\$\{(sha|fullSha|author|date|summary|range)\}/g, (_, key: string) => values[key] ?? ''))
}

function formatAuthor(entry: Pick<BlameInfo, 'author' | 'authorEmail'>, settings: Settings): string {
  if (settings.authorFormat === 'hidden') return ''
  if (settings.authorFormat === 'email') return entry.authorEmail || entry.author
  if (settings.authorFormat === 'first') return entry.author.split(/\s+/)[0] || entry.authorEmail
  return entry.author
}

function formatAttribution(entry: Pick<BlameInfo, 'author' | 'authorEmail' | 'date'>, settings: Settings): string {
  const author = formatAuthor(entry, settings)
  const date = formatDate(entry.date, settings)
  return author ? `${author} - ${date}` : date
}

function tidyFormattedText(text: string): string {
  return text.replace(/,\s+\(/g, ' (').replace(/\s{2,}/g, ' ').trim()
}

function formatDate(date: Date, settings: Settings): string {
  if (settings.dateFormat === 'absolute') return date.toLocaleString(settings.locale || undefined)
  return relativeDate(date)
}

// Git watcher invalidation --------------------------------------------------

function registerGitWatchers() {
  const generation = ++watcherGeneration
  disposeGitWatchers()

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const gitFileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git'))
    gitWatchers.push(
      gitFileWatcher,
      gitFileWatcher.onDidChange(() => {
        scheduleGitInvalidation()
        void registerGitWatchers()
      }),
      gitFileWatcher.onDidCreate(() => {
        scheduleGitInvalidation()
        void registerGitWatchers()
      }),
      gitFileWatcher.onDidDelete(() => {
        scheduleGitInvalidation()
        void registerGitWatchers()
      }),
    )

    for (const pattern of ['.git/HEAD', '.git/index', '.git/packed-refs', '.git/refs/heads/**']) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern))
      gitWatchers.push(
        watcher,
        watcher.onDidChange(scheduleGitInvalidation),
        watcher.onDidCreate(scheduleGitInvalidation),
        watcher.onDidDelete(scheduleGitInvalidation),
      )
    }

    void registerExternalGitDirWatchers(folder, generation)
  }
}

async function registerExternalGitDirWatchers(folder: vscode.WorkspaceFolder, generation: number) {
  const gitDir = await externalGitDir(folder)
  if (!gitDir || generation !== watcherGeneration) return

  for (const pattern of ['HEAD', 'index', 'packed-refs', 'refs/heads/**']) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(gitDir), pattern))
    if (generation !== watcherGeneration) {
      watcher.dispose()
      continue
    }
    gitWatchers.push(
      watcher,
      watcher.onDidChange(scheduleGitInvalidation),
      watcher.onDidCreate(scheduleGitInvalidation),
      watcher.onDidDelete(scheduleGitInvalidation),
    )
  }
}

async function externalGitDir(folder: vscode.WorkspaceFolder): Promise<string | undefined> {
  try {
    const gitFile = join(folder.uri.fsPath, '.git')
    const raw = await readFile(gitFile, 'utf8')
    const match = raw.match(/^gitdir:\s*(.+)\s*$/m)
    if (!match) return undefined

    const gitDir = match[1].trim()
    const resolved = isAbsolute(gitDir) ? gitDir : resolve(dirname(gitFile), gitDir)
    return isPlausibleGitDir(resolved) ? resolved : undefined
  } catch {
    return undefined
  }
}

function isPlausibleGitDir(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.includes('/.git/') || normalized.endsWith('/.git') || normalized.endsWith('.git')
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
      resetActivePosition()
      scheduleUpdate(ed)
    }
  }, GIT_INVALIDATION_DEBOUNCE_MS)
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

// Small utilities -----------------------------------------------------------

function resetActivePosition() {
  lastActiveLine = -1
  lastActiveFile = ''
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
