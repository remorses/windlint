// Template/markup renaming: use oxide to find candidates, then Tailwind's own
// candidate parser/printer to update matching utility AST nodes.

import { Scanner } from '@tailwindcss/oxide'
import { __unstable__loadDesignSystem } from 'tailwindcss'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { findCssVariableNameChanges } from './css-rename.ts'
import { spliceChangesIntoString, type StringChange } from './splice.ts'
import type { TokenPair } from './token.ts'

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>
type Candidate = Parameters<DesignSystem['printCandidate']>[0]

const require = createRequire(import.meta.url)
export const defaultThemeCss = fs.readFileSync(require.resolve('tailwindcss/theme.css'), 'utf-8')
const designSystemCache = new Map<string, Promise<DesignSystem>>()

/**
 * Rename utility class suffixes in a template file's content.
 * Uses oxide for exact candidate positions and Tailwind's candidate AST for
 * namespace-aware edits, so `color-card` does not accidentally rewrite
 * spacing/radius utilities like `p-card` or `rounded-card`.
 */
export async function renameTemplateTokens(options: {
  content: string
  extension: string
  from: TokenPair
  to: TokenPair
}): Promise<string> {
  let { content, extension, from, to } = options
  let scanner = new Scanner({})
  let candidates = scanner.getCandidatesWithPositions({ content, extension })
  let designSystem = await getDesignSystem({
    tokens: [from, to],
    candidates: candidates.map(({ candidate }) => candidate),
  })
  let changes: StringChange[] = []

  for (let { candidate, position } of candidates) {
    let replaced = renameCandidate({ rawCandidate: candidate, designSystem, from, to })
    if (replaced === candidate) continue

    changes.push({
      start: position,
      end: position + candidate.length,
      replacement: replaced,
    })
  }

  changes.push(
    ...findCssVariableNameChanges({
      content,
      fromVar: from.cssVar,
      toVar: to.cssVar,
      blockedRanges: changes,
      skipCssStringsAndComments: false,
    }),
  )

  if (changes.length === 0) return content
  return spliceChangesIntoString(content, changes)
}

function renameCandidate(options: {
  rawCandidate: string
  designSystem: DesignSystem
  from: TokenPair
  to: TokenPair
}): string {
  let { rawCandidate, designSystem, from, to } = options

  for (let readonlyCandidate of designSystem.parseCandidate(rawCandidate)) {
    if (
      rawCandidate.includes(from.cssVar) &&
      candidateUsesCssVar({ designSystem, candidate: readonlyCandidate, cssVar: from.cssVar })
    ) {
      return rawCandidate.replaceAll(from.cssVar, to.cssVar)
    }

    let candidate: Candidate = structuredClone(readonlyCandidate)
    let changed = renameVariants({ variants: candidate.variants, from, to })

    if (candidateUsesCssVar({ designSystem, candidate: readonlyCandidate, cssVar: from.cssVar })) {
      changed = renameUtilityValue({ candidate, from, to }) || changed
    }

    if (changed) return designSystem.printCandidate(candidate)
  }

  return rawCandidate
}

function renameUtilityValue(options: { candidate: Candidate; from: TokenPair; to: TokenPair }): boolean {
  let { candidate, from, to } = options
  let changed = false

  if (candidate.kind === 'functional') {
    if (candidate.value?.kind === 'named' && candidate.value.value === from.utilitySuffix) {
      candidate.value.value = to.utilitySuffix
      changed = true
    }

    if (candidate.value?.kind === 'arbitrary' && candidate.value.value.includes(from.cssVar)) {
      candidate.value.value = candidate.value.value.replaceAll(from.cssVar, to.cssVar)
      changed = true
    }
  }

  if (candidate.kind === 'arbitrary') {
    if (candidate.property === from.cssVar) {
      candidate.property = to.cssVar
      changed = true
    }

    if (candidate.value.includes(from.cssVar)) {
      candidate.value = candidate.value.replaceAll(from.cssVar, to.cssVar)
      changed = true
    }
  }

  return changed
}

function renameVariants(options: {
  variants: Candidate['variants']
  from: TokenPair
  to: TokenPair
}): boolean {
  let { variants, from, to } = options
  let changed = false

  for (let variant of variants) {
    if (from.namespace === 'breakpoint') {
      if (variant.kind === 'static' && variant.root === from.utilitySuffix) {
        variant.root = to.utilitySuffix
        changed = true
      }

      if (
        variant.kind === 'functional' &&
        (variant.root === 'min' || variant.root === 'max') &&
        variant.value?.kind === 'named' &&
        variant.value.value === from.utilitySuffix
      ) {
        variant.value.value = to.utilitySuffix
        changed = true
      }
    }

    if (
      from.namespace === 'container' &&
      variant.kind === 'functional' &&
      (variant.root === '@' || variant.root === '@min' || variant.root === '@max') &&
      variant.value?.kind === 'named' &&
      variant.value.value === from.utilitySuffix
    ) {
      variant.value.value = to.utilitySuffix
      changed = true
    }

    if (variant.kind === 'compound') {
      changed = renameVariants({ variants: [variant.variant], from, to }) || changed
    }
  }

  return changed
}

export function candidateUsesCssVar(options: {
  designSystem: DesignSystem
  candidate: ReturnType<DesignSystem['parseCandidate']>[number]
  cssVar: string
}): boolean {
  let { designSystem, candidate, cssVar } = options
  return includesString(designSystem.compileAstNodes(candidate), cssVar)
}

function includesString(value: object | string | null | undefined, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle)
  if (!value || typeof value !== 'object') return false

  if (Array.isArray(value)) return value.some((item) => includesString(item, needle))

  return Object.values(value).some((item) => includesString(item, needle))
}

export function getDesignSystem(options: {
  tokens: TokenPair[]
  candidates: string[]
}): Promise<DesignSystem> {
  let { tokens, candidates } = options
  let extraThemeVars = collectVariantThemeVars(candidates)
  extraThemeVars.push(...tokens.map(themeDeclaration))

  let key = extraThemeVars.sort().join('\n')
  let cached = designSystemCache.get(key)
  if (cached) return cached

  let promise = __unstable__loadDesignSystem(`${defaultThemeCss}\n@theme {\n${key}\n}`)
  designSystemCache.set(key, promise)
  return promise
}

function collectVariantThemeVars(candidates: string[]): string[] {
  let declarations = new Set<string>()

  for (let candidate of candidates) {
    let parts = splitCandidate(candidate)
    for (let variant of parts.slice(0, -1)) {
      addVariantThemeVar(declarations, variant)
    }
  }

  return [...declarations]
}

function addVariantThemeVar(declarations: Set<string>, variant: string) {
  if (!isSimpleVariant(variant)) return

  if (variant.startsWith('@max-')) {
    declarations.add(`  --container-${variant.slice(5)}: 1rem;`)
    return
  }

  if (variant.startsWith('@min-')) {
    declarations.add(`  --container-${variant.slice(5)}: 1rem;`)
    return
  }

  if (variant.startsWith('@')) {
    declarations.add(`  --container-${variant.slice(1)}: 1rem;`)
    return
  }

  if (variant.startsWith('max-') || variant.startsWith('min-')) {
    declarations.add(`  --breakpoint-${variant.slice(4)}: 1rem;`)
    return
  }

  declarations.add(`  --breakpoint-${variant}: 1rem;`)
}

function splitCandidate(candidate: string): string[] {
  let parts: string[] = []
  let start = 0
  let bracketDepth = 0
  let parenDepth = 0

  for (let index = 0; index < candidate.length; index++) {
    let char = candidate[index]
    if (char === '\\') {
      index++
      continue
    }
    if (char === '[') bracketDepth++
    if (char === ']') bracketDepth--
    if (char === '(') parenDepth++
    if (char === ')') parenDepth--

    if (char === ':' && bracketDepth === 0 && parenDepth === 0) {
      parts.push(candidate.slice(start, index))
      start = index + 1
    }
  }

  parts.push(candidate.slice(start))
  return parts
}

function isSimpleVariant(variant: string): boolean {
  if (!variant) return false

  let start = variant.startsWith('@') ? 1 : 0
  if (start === variant.length) return false

  for (let index = start; index < variant.length; index++) {
    let code = variant.charCodeAt(index)
    let isLetter = (code >= 97 && code <= 122) || (code >= 65 && code <= 90)
    let isNumber = code >= 48 && code <= 57
    let isAllowed = isLetter || isNumber || code === 45 || code === 95
    if (!isAllowed) return false
  }
  return true
}

function themeDeclaration(token: TokenPair): string {
  return `  ${token.cssVar}: ${themeValueForNamespace(token.namespace)};`
}

function themeValueForNamespace(namespace: string): string {
  switch (namespace) {
    case 'animate':
      return 'spin 1s linear infinite'
    case 'color':
      return '#000'
    case 'ease':
      return 'ease'
    case 'font':
      return 'serif'
    case 'shadow':
    case 'inset-shadow':
    case 'drop-shadow':
      return '0 0 #000'
    case 'leading':
    case 'tracking':
      return '1'
    default:
      return '1rem'
  }
}
