// CSS file renaming: PostCSS handles CSS structure, while the small raw scanner
// is kept for markup strings and CSS declaration values.

import { parse, type AtRule, type Declaration } from 'postcss'
import { spliceChangesIntoString, type StringChange } from './splice.ts'
import type { TokenPair } from './token.ts'

/**
 * Rename utility class suffixes inside @apply directives in a CSS file.
 * Uses PostCSS to find @apply at-rules and replaces matching utility suffixes
 * in their params. This is needed because the oxide Scanner does not extract
 * individual utility classes from @apply — it treats @apply as a single token.
 */
export function renameApplyDirectives(options: {
  content: string
  from: TokenPair
  to: TokenPair
}): string {
  let { content, from, to } = options
  if (from.utilitySuffix === '') return content

  let changes: StringChange[] = []
  let root = parse(content, { from: undefined })

  root.walkAtRules('apply', (atRule) => {
    let paramsStart = getAtRuleParamsStart({ content, atRule })
    if (paramsStart === undefined) return

    let params = atRule.params
    // Split by whitespace to get individual utility classes, tracking position
    let offset = 0
    for (let match of params.matchAll(/\S+/g)) {
      let utility = match[0]
      let utilityStart = paramsStart + match.index!

      // Replace the utility suffix within the class name.
      // A utility like "text-text-strong-950" contains suffix "text-strong-950".
      // A utility like "hover:text-text-strong-950" has variant prefix.
      // We also handle modifiers like "text-text-strong-950/50".
      let suffixIndex = utility.indexOf(from.utilitySuffix)
      if (suffixIndex === -1) continue

      // Verify the suffix is at a proper boundary (preceded by - and followed by end/modifier)
      let charBefore = suffixIndex > 0 ? utility[suffixIndex - 1] : undefined
      let charAfter = utility[suffixIndex + from.utilitySuffix.length]
      let validBefore = charBefore === '-' || charBefore === ':' || charBefore === undefined
      let validAfter = charAfter === undefined || charAfter === '/' || charAfter === '!'

      if (!validBefore || !validAfter) continue

      let replacement = to.utilityModifier
        ? to.utilitySuffix + '/' + to.utilityModifier
        : to.utilitySuffix

      changes.push({
        start: utilityStart + suffixIndex,
        end: utilityStart + suffixIndex + from.utilitySuffix.length,
        replacement,
      })
    }
  })

  if (changes.length === 0) return content
  return spliceChangesIntoString(content, changes)
}

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
  let changes = findCssVariableChangesInCss({ content, fromVar: from.cssVar, toVar: to.cssVar })

  if (changes.length === 0) return content
  return spliceChangesIntoString(content, changes)
}

export interface CssRenameWarning {
  type: 'circular-reference' | 'duplicate-declaration'
  message: string
}

export function findCssVariableChangesInCss(options: {
  content: string
  fromVar: string
  toVar: string
}): StringChange[] {
  let { content, fromVar, toVar } = options
  let changes: StringChange[] = []
  let root = parse(content, { from: undefined })

  // Track declarations that will be renamed and existing declarations with the target name.
  // Used for circular reference detection (#6) and duplicate deduplication (#7).
  let renamedDeclarations: Array<{ declaration: Declaration; propStart: number; removed: boolean }> = []
  let existingTargetDeclarations: Array<{ declaration: Declaration }> = []

  root.walkDecls((declaration) => {
    // Track declarations that already have the target variable name (for duplicate detection)
    if (declaration.prop === toVar) {
      existingTargetDeclarations.push({ declaration })
    }

    if (declaration.prop === fromVar) {
      let start = declaration.source?.start?.offset
      if (start !== undefined) {
        // Check for circular reference: would renaming create --X: var(--X)?
        if (declaration.value.includes(`var(${toVar}`)) {
          // Remove the entire declaration to avoid circular self-reference.
          let { start: removeStart, end: removeEnd } = getDeclarationRemoveRange(content, declaration)
          changes.push({ start: removeStart, end: removeEnd, replacement: '' })
          renamedDeclarations.push({ declaration, propStart: start, removed: true })
          return
        }

        changes.push({ start, end: start + fromVar.length, replacement: toVar })
        renamedDeclarations.push({ declaration, propStart: start, removed: false })
      }
    }

    let valueStart = getDeclarationValueStart({ content, declaration })
    if (valueStart === undefined) return

    for (let change of findCssVariableNameChanges({
      content: declaration.value,
      fromVar,
      toVar,
      skipCssStringsAndComments: true,
    })) {
      changes.push({
        start: valueStart + change.start,
        end: valueStart + change.end,
        replacement: change.replacement,
      })
    }
  })

  // Deduplicate: if target variable already exists and we're creating another one,
  // remove the earlier (existing) duplicate. CSS cascade keeps the last declaration.
  // Only dedup when at least one renamed declaration is actually kept (not removed as circular).
  let hasKeptRename = renamedDeclarations.some((d) => !d.removed)
  if (hasKeptRename && existingTargetDeclarations.length > 0) {
    for (let { declaration } of existingTargetDeclarations) {
      let declStart = declaration.source?.start?.offset
      let declEnd = declaration.source?.end?.offset
      if (declStart === undefined || declEnd === undefined) continue

      // Check that this declaration isn't one being removed already (circular ref)
      let alreadyRemoved = changes.some(
        (c) => c.start <= declStart && c.end >= declEnd + 1 && c.replacement === '',
      )
      if (alreadyRemoved) continue

      let { start: removeStart, end: removeEnd } = getDeclarationRemoveRange(content, declaration)
      changes.push({ start: removeStart, end: removeEnd, replacement: '' })
    }
  }

  root.walkAtRules('property', (atRule) => {
    if (atRule.params.trim() !== fromVar) return
    let paramsStart = getAtRuleParamsStart({ content, atRule })
    if (paramsStart === undefined) return
    changes.push({ start: paramsStart, end: paramsStart + fromVar.length, replacement: toVar })
  })

  return changes.sort((a, b) => a.start - b.start)
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

export function findDeclaredCssVariables(content: string): string[] {
  let declarations = new Set<string>()
  let root = parse(content, { from: undefined })

  root.walkDecls((declaration) => {
    if (declaration.prop.startsWith('--')) {
      declarations.add(declaration.prop)
    }
  })

  root.walkAtRules('property', (atRule) => {
    let variable = atRule.params.trim()
    if (variable.startsWith('--')) declarations.add(variable)
  })

  return [...declarations]
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

function getDeclarationValueStart(options: {
  content: string
  declaration: Declaration
}): number | undefined {
  let { content, declaration } = options
  let declarationStart = declaration.source?.start?.offset
  if (declarationStart === undefined) return undefined
  let searchStart = declarationStart + declaration.prop.length
  let valueStart = content.indexOf(declaration.value, searchStart)
  return valueStart === -1 ? undefined : valueStart
}

function getAtRuleParamsStart(options: { content: string; atRule: AtRule }): number | undefined {
  let { content, atRule } = options
  let atRuleStart = atRule.source?.start?.offset
  if (atRuleStart === undefined) return undefined
  let paramsStart = content.indexOf(atRule.params, atRuleStart)
  return paramsStart === -1 ? undefined : paramsStart
}

/**
 * Compute the range to remove for an entire declaration line, including the
 * leading indentation and trailing newline. Produces clean output without
 * leftover blank lines.
 */
function getDeclarationRemoveRange(
  content: string,
  declaration: Declaration,
): { start: number; end: number } {
  let declStart = declaration.source!.start!.offset
  let declEnd = declaration.source!.end!.offset + 1

  // Walk backwards from declStart to consume leading whitespace on the same line
  let removeStart = declStart
  while (removeStart > 0 && (content[removeStart - 1] === ' ' || content[removeStart - 1] === '\t')) {
    removeStart--
  }

  // Consume trailing newline(s) so we don't leave a blank line
  let removeEnd = declEnd
  while (removeEnd < content.length && (content[removeEnd] === '\n' || content[removeEnd] === '\r')) {
    removeEnd++
  }

  return { start: removeStart, end: removeEnd }
}
