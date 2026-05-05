// CSS file renaming: PostCSS handles CSS structure, while the small raw scanner
// is kept for markup strings and CSS declaration values.

import { parse, type AtRule, type Declaration } from 'postcss'
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
  let changes = findCssVariableChangesInCss({ content, fromVar: from.cssVar, toVar: to.cssVar })

  if (changes.length === 0) return content
  return spliceChangesIntoString(content, changes)
}

export function findCssVariableChangesInCss(options: {
  content: string
  fromVar: string
  toVar: string
}): StringChange[] {
  let { content, fromVar, toVar } = options
  let changes: StringChange[] = []
  let root = parse(content, { from: undefined })

  root.walkDecls((declaration) => {
    if (declaration.prop === fromVar) {
      let start = declaration.source?.start?.offset
      if (start !== undefined) {
        changes.push({ start, end: start + fromVar.length, replacement: toVar })
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
