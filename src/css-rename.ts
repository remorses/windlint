// CSS file renaming: finds and replaces CSS variable declarations and var() references.
// Scans CSS variable identifiers directly so partial names, strings, and comments
// do not get rewritten accidentally.

import { spliceChangesIntoString, type StringChange } from './splice.ts'
import type { TokenPair } from './token.ts'

/**
 * Rename CSS variable declarations and var() references in a CSS file's content.
 * Handles:
 *   1. Declarations: --color-social-apple: #000  →  --color-primary: #000
 *   2. var() references: var(--color-social-apple)  →  var(--color-primary)
 *   3. var() with fallback: var(--color-social-apple, red)  →  var(--color-primary, red)
 */
export function renameCssVariables(options: {
  content: string
  from: TokenPair
  to: TokenPair
}): string {
  let { content, from, to } = options
  let changes = findCssVariableNameChanges({
    content,
    fromVar: from.cssVar,
    toVar: to.cssVar,
    skipCssStringsAndComments: true,
  })

  if (changes.length === 0) return content
  return spliceChangesIntoString(content, changes)
}

export function findCssVariableNameChanges(options: {
  content: string
  fromVar: string
  toVar: string
  blockedRanges?: StringChange[]
  skipCssStringsAndComments?: boolean
}): StringChange[] {
  let { content, fromVar, toVar } = options
  let changes: StringChange[] = []
  let index = 0

  while (index < content.length) {
    if (options.skipCssStringsAndComments && content.startsWith('/*', index)) {
      let end = content.indexOf('*/', index + 2)
      index = end === -1 ? content.length : end + 2
      continue
    }

    if (options.skipCssStringsAndComments && (content[index] === '"' || content[index] === "'")) {
      index = skipQuotedString(content, index)
      continue
    }

    if (
      content.startsWith(fromVar, index) &&
      isBoundary(content[index - 1]) &&
      isBoundary(content[index + fromVar.length])
    ) {
      let start = index
      let end = index + fromVar.length
      let blocked = options.blockedRanges?.some((range) => start >= range.start && end <= range.end)

      if (!blocked) changes.push({ start, end, replacement: toVar })

      index = end
      continue
    }

    index++
  }

  return changes
}

function skipQuotedString(content: string, start: number): number {
  let quote = content[start]

  for (let index = start + 1; index < content.length; index++) {
    if (content[index] === '\\') {
      index++
      continue
    }

    if (content[index] === quote) return index + 1
  }

  return content.length
}

function isBoundary(char: string | undefined): boolean {
  if (!char) return true
  let code = char.charCodeAt(0)
  let isLetter = (code >= 97 && code <= 122) || (code >= 65 && code <= 90)
  let isNumber = code >= 48 && code <= 57
  return !isLetter && !isNumber && char !== '_' && char !== '-'
}
