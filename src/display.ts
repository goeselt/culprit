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

const ELLIPSIS = '...'
const NO_COMMIT_SUMMARY = 'No commit summary'
const UNKNOWN_AUTHOR = 'Unknown author'
const BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/g
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

// Inline annotation formatting ---------------------------------------------

export function formatTemplate(template: string, context: TemplateContext, settings: DisplaySettings): string {
  const values: Record<string, string> = {
    sha: context.info.sha.slice(0, 7),
    fullSha: context.info.sha,
    author: formatAuthor(context.info, settings),
    date: formatDate(context.info.date, settings),
    summary: firstLine(context.info.summary, settings.summaryMaxLength, NO_COMMIT_SUMMARY),
    range: context.range.start === context.range.end ? `${context.range.start}` : `${context.range.start}-${context.range.end}`,
  }

  const formatted = template.replace(/\$\{(sha|fullSha|author|date|summary|range)\}/g, (_, key: string) => values[key] ?? '')
  return truncateText(tidyFormattedText(normalizeDisplayText(formatted)), settings.inlineMaxLength)
}

// Commit metadata formatting ------------------------------------------------

export function formatAuthor(entry: Pick<DisplayEntry, 'author' | 'authorEmail'>, settings: Pick<DisplaySettings, 'authorFormat'>): string {
  if (settings.authorFormat === 'hidden') return ''

  const author = normalizeDisplayText(entry.author)
  const email = normalizeDisplayText(entry.authorEmail)

  if (settings.authorFormat === 'email') return email || author || UNKNOWN_AUTHOR
  if (settings.authorFormat === 'first') return author.split(/\s+/)[0] || email || UNKNOWN_AUTHOR
  return author || email || UNKNOWN_AUTHOR
}

export function formatAttribution(entry: Pick<DisplayEntry, 'author' | 'authorEmail' | 'date'>, settings: DisplaySettings): string {
  const author = formatAuthor(entry, settings)
  const date = formatDate(entry.date, settings)
  return author ? `${author} - ${date}` : date
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
  const normalized = text.replace(BIDI_CONTROL_RE, '').replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim()
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

function tidyFormattedText(text: string): string {
  return text
    .replace(/,\s+\(/g, ' (')
    .replace(/\(\s*\)/g, '')
    .replace(/,\s*(?=$|\))/g, '')
    .replace(/\s+-\s*(?=$|\))/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
