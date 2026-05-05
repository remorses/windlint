// CSS file renaming: finds and replaces CSS variable declarations and var() references.
// Uses regex-based replacement since CSS variable names are simple identifier patterns
// that don't require full AST parsing for safe replacement.

import { spliceChangesIntoString, type StringChange } from './splice.ts'
import type { TokenPair } from './token.ts'

/**
 * Rename CSS variable declarations and var() references in a CSS file's content.
 * Handles:
 *   1. Declarations: --color-social-apple: #000  →  --color-primary: #000
 *   2. var() references: var(--color-social-apple)  →  var(--color-primary)
 *   3. var() with fallback: var(--color-social-apple, red)  →  var(--color-primary, red)
 */
export function renameCssVariables(
  content: string,
  from: TokenPair,
  to: TokenPair,
): string {
  let changes: StringChange[] = []

  // Match the CSS variable name (with --) as a whole word.
  // We need word boundary behavior, but CSS vars use dashes so we match
  // the exact variable name followed by a non-identifier char or end of string.
  let fromVar = from.cssVar // e.g. "--color-social-apple"
  let toVar = to.cssVar // e.g. "--color-primary"

  // Find all occurrences of the CSS variable name.
  // This catches both declarations and var() references.
  // We use a regex that matches the exact variable name bounded by non-identifier chars.
  let regex = new RegExp(escapeRegex(fromVar) + '(?![a-zA-Z0-9_-])', 'g')

  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    changes.push({
      start: match.index,
      end: match.index + fromVar.length,
      replacement: toVar,
    })
  }

  if (changes.length === 0) return content
  return spliceChangesIntoString(content, changes)
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
