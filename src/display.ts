import { relativeDate } from './git.js'

export type DateFormat = 'relative' | 'absolute'
export type AuthorFormat = 'full' | 'first' | 'email' | 'hidden'
export type OwnershipRange = { start: number; end: number }

export interface DisplayEntry {
  sha: string
  author: string
  authorEmail: string
  date: Date
  summary: string
}

export interface DisplaySettings {
  authorFormat: AuthorFormat
  dateFormat: DateFormat
  locale: string
  summaryMaxLength: number
  inlineMaxLength: number
}

export interface TemplateContext {
  info: DisplayEntry
  range: OwnershipRange
}

export interface AuthorIdentity {
  author: string
  authorEmail: string
}

export type AuthorTone = 'self' | 'bot' | 'default'

const ELLIPSIS = '...'
const NO_COMMIT_SUMMARY = 'No commit summary'
const UNKNOWN_AUTHOR = 'Unknown author'
const SELF_AUTHOR_LABEL = 'You'
const SELF_AUTHOR_COLOR = 'var(--vscode-terminal-ansiGreen)'
const BOT_AUTHOR_COLOR = 'var(--vscode-terminal-ansiBlue)'
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/g

// Inline annotation formatting ---------------------------------------------

export function formatTemplate(template: string, context: TemplateContext, settings: DisplaySettings): string {
  const values: Record<string, string> = {
    sha: context.info.sha.slice(0, 7),
    fullSha: context.info.sha,
    author: formatAuthor(context.info, settings),
    date: formatDate(context.info.date, settings),
    summary: firstLine(context.info.summary, settings.summaryMaxLength, NO_COMMIT_SUMMARY),
    range:
      context.range.start === context.range.end
        ? `${context.range.start}`
        : `${context.range.start}-${context.range.end}`,
  }

  const formatted = template.replace(
    /\$\{(sha|fullSha|author|date|summary|range)\}/g,
    (_, key: string) => values[key] ?? '',
  )
  return truncateText(tidyFormattedText(normalizeDisplayText(formatted)), settings.inlineMaxLength)
}

// Commit metadata formatting ------------------------------------------------

export function formatAuthor(
  entry: Pick<DisplayEntry, 'author' | 'authorEmail'>,
  settings: Pick<DisplaySettings, 'authorFormat'>,
): string {
  if (settings.authorFormat === 'hidden') return ''

  const author = normalizeDisplayText(entry.author)
  const email = normalizeDisplayText(entry.authorEmail)

  if (settings.authorFormat === 'email') return email || author || UNKNOWN_AUTHOR
  if (settings.authorFormat === 'first') return author.split(/\s+/)[0] || email || UNKNOWN_AUTHOR
  return author || email || UNKNOWN_AUTHOR
}

export function formatHoverAuthor(
  entry: Pick<DisplayEntry, 'author' | 'authorEmail'>,
  settings: Pick<DisplaySettings, 'authorFormat'>,
  identity?: AuthorIdentity,
): string {
  const author = formatAuthor(entry, settings)
  if (!author) return ''

  const tone = authorTone(entry, identity)
  if (tone === 'default') return escapeMarkdown(author)

  const color = tone === 'self' ? SELF_AUTHOR_COLOR : BOT_AUTHOR_COLOR
  const label = tone === 'self' ? SELF_AUTHOR_LABEL : author
  return `<span style="color:${color};">${escapeHtml(label)}</span>`
}

export function authorTone(entry: Pick<DisplayEntry, 'author' | 'authorEmail'>, identity?: AuthorIdentity): AuthorTone {
  const author = normalizeDisplayText(entry.author).toLowerCase()
  const email = normalizeDisplayText(entry.authorEmail).toLowerCase()

  if (isBotAuthor(author, email)) return 'bot'
  if (!identity) return 'default'

  const identityAuthor = normalizeDisplayText(identity.author).toLowerCase()
  const identityEmail = normalizeDisplayText(identity.authorEmail).toLowerCase()
  if (identityEmail && email && identityEmail === email) return 'self'
  if (identityAuthor && author && identityAuthor === author) return 'self'
  return 'default'
}

export function formatDate(date: Date, settings: Pick<DisplaySettings, 'dateFormat' | 'locale'>): string {
  if (Number.isNaN(date.getTime())) return 'unknown date'
  if (settings.dateFormat !== 'absolute') return relativeDate(date)

  try {
    return date.toLocaleString(settings.locale || undefined)
  } catch {
    return date.toLocaleString(undefined)
  }
}

export function formatOwnershipRange(range: OwnershipRange): string {
  if (range.start === range.end) return `This commit owns line ${range.start}`
  return `This commit owns lines ${range.start}-${range.end}`
}

// String hygiene ------------------------------------------------------------

export function firstLine(text: string, maxLen = 72, fallback = ''): string {
  const [line = ''] = text.split(/\r?\n/, 1)
  return truncateText(normalizeDisplayText(line, fallback), maxLen)
}

export function normalizeDisplayText(text: string, fallback = ''): string {
  const normalized = stripControlCharacters(text).replace(BIDI_CONTROL_RE, '').replace(/\s+/g, ' ').trim()
  return normalized || fallback
}

export function truncateText(text: string, maxLen: number): string {
  const limit = Math.max(1, Math.floor(maxLen))
  if (text.length <= limit) return text
  if (limit <= ELLIPSIS.length) return ELLIPSIS.slice(0, limit)
  return `${text.slice(0, limit - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`
}

export function escapeMarkdown(text: string): string {
  return normalizeDisplayText(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/([\\`*_[\]{}()#+\-!|>~])/g, '\\$1')
}

function escapeHtml(text: string): string {
  return normalizeDisplayText(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function isBotAuthor(author: string, email: string): boolean {
  return /\bbot\b|\[bot\]|bot@/.test(author) || /\bbot\b|\[bot\]|bot@/.test(email)
}

function stripControlCharacters(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.charCodeAt(0)
      return code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20 ? char : ' '
    })
    .join('')
}

function tidyFormattedText(text: string): string {
  return text
    .replace(/,\s+\(/g, ' (')
    .replace(/\(\s*\)/g, '')
    .replace(/,\s*(?=$|\))/g, '')
    .replace(/\s+-\s*(?=$|\))/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
