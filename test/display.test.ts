import assert from 'node:assert/strict'
import test from 'node:test'

import {
  escapeMarkdown,
  firstLine,
  formatDate,
  formatOwnershipRange,
  formatTemplate,
  type DisplaySettings,
  type TemplateContext,
} from '../src/display.js'

const settings: DisplaySettings = {
  authorFormat: 'full',
  dateFormat: 'relative',
  locale: '',
  summaryMaxLength: 50,
  inlineMaxLength: 80,
}

const context: TemplateContext = {
  info: {
    sha: 'a'.repeat(40),
    author: 'Ada Lovelace',
    authorEmail: 'ada@example.invalid',
    date: new Date(),
    summary: 'Tighten hover rendering',
  },
  range: { start: 3, end: 5 },
}

test('formatTemplate normalizes repo-controlled display text', () => {
  const formatted = formatTemplate('${summary}, ${author}', {
    ...context,
    info: {
      ...context.info,
      author: 'Ada\nLovelace\u202E',
      summary: 'Fix\tannotation\u0007spacing\nignored body',
    },
  }, settings)

  assert.equal(formatted, 'Fix annotation spacing, Ada Lovelace')
})

test('formatTemplate keeps inline annotations bounded', () => {
  const formatted = formatTemplate('${summary}, ${author}', {
    ...context,
    info: {
      ...context.info,
      author: 'A'.repeat(80),
      summary: 'S'.repeat(80),
    },
  }, { ...settings, summaryMaxLength: 200, inlineMaxLength: 30 })

  assert.equal(formatted.length, 30)
  assert.match(formatted, /\.\.\.$/)
})

test('formatTemplate tidies missing author output', () => {
  const formatted = formatTemplate('${summary}, ${author} (${date})', context, {
    ...settings,
    authorFormat: 'hidden',
  })

  assert.match(formatted, /^Tighten hover rendering \(.+\)$/)
  assert.doesNotMatch(formatted, /,\s+\(/)
})

test('formatDate falls back when an absolute locale is invalid', () => {
  const formatted = formatDate(new Date('2024-01-02T03:04:05Z'), {
    dateFormat: 'absolute',
    locale: 'bad_locale',
  })

  assert.equal(typeof formatted, 'string')
  assert.ok(formatted.length > 0)
})

test('small display helpers produce readable hover text', () => {
  assert.equal(firstLine('First line\nSecond line', 80), 'First line')
  assert.equal(formatOwnershipRange({ start: 7, end: 7 }), 'This commit owns line 7')
  assert.equal(formatOwnershipRange({ start: 7, end: 9 }), 'This commit owns lines 7-9')
  assert.equal(escapeMarkdown('fix <thing> (again)'), 'fix &lt;thing\\> \\(again\\)')
})
