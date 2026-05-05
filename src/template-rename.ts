// Template/markup renaming: uses @tailwindcss/oxide Scanner to find Tailwind utility
// candidates in source files, then replaces the token suffix in matching candidates.
//
// For example, given rename from "social-apple" to "primary":
//   text-social-apple      → text-primary
//   bg-social-apple        → bg-primary
//   hover:text-social-apple → hover:text-primary
//   border-social-apple/50 → border-primary/50
//
// The oxide Scanner finds candidates with their byte positions, so we can do
// precise string replacements without breaking anything else in the file.

import { Scanner } from '@tailwindcss/oxide'
import { spliceChangesIntoString, type StringChange } from './splice.ts'
import type { TokenPair } from './token.ts'

/**
 * Rename utility class suffixes in a template file's content.
 * Uses oxide Scanner to find all Tailwind candidates with positions,
 * then replaces the old suffix with the new one.
 */
export function renameTemplateTokens(
  content: string,
  extension: string,
  from: TokenPair,
  to: TokenPair,
): string {
  let scanner = new Scanner({})
  let candidates = scanner.getCandidatesWithPositions({ content, extension })

  let changes: StringChange[] = []

  let fromSuffix = from.utilitySuffix // e.g. "social-apple"
  let toSuffix = to.utilitySuffix // e.g. "primary"

  // Also handle var() references in template files (inline styles, arbitrary values)
  let fromVar = from.cssVar // e.g. "--color-social-apple"
  let toVar = to.cssVar // e.g. "--color-primary"

  for (let { candidate, position } of candidates) {
    let replaced = replaceTokenInCandidate(candidate, fromSuffix, toSuffix, fromVar, toVar)
    if (replaced !== candidate) {
      changes.push({
        start: position,
        end: position + candidate.length,
        replacement: replaced,
      })
    }
  }

  // Also do a regex pass for var() references that might not be picked up
  // by the oxide Scanner (e.g., in inline style attributes, JS strings outside
  // of class contexts)
  let varRegex = new RegExp(escapeRegex(fromVar) + '(?![a-zA-Z0-9_-])', 'g')
  let match: RegExpExecArray | null
  while ((match = varRegex.exec(content)) !== null) {
    let start = match.index
    let end = start + fromVar.length

    // Skip if this position is already covered by a candidate replacement
    let alreadyCovered = changes.some((c) => start >= c.start && end <= c.end)
    if (alreadyCovered) continue

    changes.push({ start, end, replacement: toVar })
  }

  if (changes.length === 0) return content
  return spliceChangesIntoString(content, changes)
}

/**
 * Replace the token suffix within a single Tailwind candidate string.
 * Handles various candidate forms:
 *   text-social-apple           → text-primary
 *   hover:text-social-apple     → hover:text-primary
 *   text-social-apple/50        → text-primary/50
 *   ![text-social-apple]        → not changed (unlikely but safe)
 *   bg-[var(--color-social-apple)] → bg-[var(--color-primary)]
 */
function replaceTokenInCandidate(
  candidate: string,
  fromSuffix: string,
  toSuffix: string,
  fromVar: string,
  toVar: string,
): string {
  let result = candidate

  // Handle arbitrary values containing var() references
  if (result.includes(fromVar)) {
    result = result.replaceAll(fromVar, toVar)
  }

  // Handle utility class suffix replacement.
  // The suffix appears after a dash at a "word boundary" within the candidate.
  // We need to be careful to match the whole suffix and not partial matches.
  // For example, "social-apple" should not match in "social-apple-pie".
  let suffixRegex = new RegExp(
    '(?<=[-:!])' + escapeRegex(fromSuffix) + '(?=[/!\\s]|$)',
    'g',
  )
  result = result.replace(suffixRegex, toSuffix)

  return result
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
