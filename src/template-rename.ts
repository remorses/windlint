// Template/markup renaming: use oxide to find candidates, then Tailwind's own
// candidate parser/printer to update matching utility AST nodes.

import { Scanner } from '@tailwindcss/oxide'
import { __unstable__loadDesignSystem } from 'tailwindcss'
import { findCssVariableNameChanges } from './css-rename.ts'
import { defaultThemeCss, type DesignSystem } from './design-system.ts'
import { spliceChangesIntoString, type StringChange } from './splice.ts'
import type { TokenPair } from './token.ts'

type Candidate = Parameters<DesignSystem['printCandidate']>[0]

export interface TemplateCandidateRenameChange extends StringChange {
  candidate: string
}

let cachedDesignSystemKey: string | undefined
let cachedDesignSystemPromise: Promise<DesignSystem> | undefined

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
  let changes: StringChange[] = await findTemplateCandidateRenameChanges({ content, extension, from, to })

  if (!to.utilityModifier) {
    changes.push(
      ...findCssVariableNameChanges({
        content,
        fromVar: from.cssVar,
        toVar: to.cssVar,
        blockedRanges: changes,
        skipCssStringsAndComments: false,
      }),
    )
  } else {
    // For opacity targets, replace var(--old) with color-mix() in non-candidate contexts
    // (inline styles, SVG props, etc). Utility classes are already handled above.
    changes.push(
      ...findVarCallChangesForOpacityTarget({
        content,
        from,
        to,
        blockedRanges: changes,
      }),
    )
  }

  if (changes.length === 0) return content
  return spliceChangesIntoString(content, changes)
}

export async function findTemplateCandidateRenameChanges(options: {
  content: string
  extension: string
  from: TokenPair
  to: TokenPair
}): Promise<TemplateCandidateRenameChange[]> {
  let { content, extension, from, to } = options
  let scanner = new Scanner({})
  let candidates = scanner.getCandidatesWithPositions({ content, extension })
  let matchingCandidates = candidates.filter(({ candidate }) => mightContainToken({ candidate, token: from }))
  let changes: TemplateCandidateRenameChange[] = []

  if (matchingCandidates.length === 0) return changes

  let designSystem = await getDesignSystem({
    tokens: [from, to],
    candidates: matchingCandidates.map(({ candidate }) => candidate),
  })

  for (let { candidate, position } of matchingCandidates) {
    let replaced = renameCandidate({ rawCandidate: candidate, designSystem, from, to })
    if (replaced === candidate) continue

    // Only canonicalize when the replacement still contains the target CSS variable.
    // This collapses e.g. text-[var(--color-pink-500)] → text-pink-500 without
    // rewriting unrelated syntax (like [display:flex] → flex) in variant-only renames.
    let shouldCanonicalize = replaced.includes(to.cssVar)
    let replacement = shouldCanonicalize
      ? designSystem.canonicalizeCandidates([replaced])[0] ?? replaced
      : replaced

    changes.push({
      candidate,
      start: position,
      end: position + candidate.length,
      replacement,
    })
  }

  return changes
}

function mightContainToken(options: { candidate: string; token: TokenPair }): boolean {
  let { candidate, token } = options
  return candidate.includes(token.cssVar) ||
    (token.utilitySuffix !== '' && candidate.includes(token.utilitySuffix))
}

function renameCandidate(options: {
  rawCandidate: string
  designSystem: DesignSystem
  from: TokenPair
  to: TokenPair
}): string {
  let { rawCandidate, designSystem, from, to } = options

  for (let readonlyCandidate of designSystem.parseCandidate(rawCandidate)) {
    let candidate: Candidate = structuredClone(readonlyCandidate)

    if (
      rawCandidate.includes(from.cssVar) &&
      candidateUsesCssVar({ designSystem, candidate: readonlyCandidate, cssVar: from.cssVar })
    ) {
      if (renameExactArbitraryVarValue({ candidate, from, to })) {
        return designSystem.printCandidate(candidate)
      }

      let arbitraryPropertyReplacement = renameExactArbitraryPropertyVarValue({ rawCandidate, candidate, from, to })
      if (arbitraryPropertyReplacement) return arbitraryPropertyReplacement

      if (to.utilityModifier) return rawCandidate

      return rawCandidate.replaceAll(from.cssVar, to.cssVar)
    }

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
      applyTargetModifier({ candidate, to })
      changed = true
    }

    if (candidate.value?.kind === 'arbitrary' && candidate.value.value.includes(from.cssVar)) {
      if (to.utilityModifier && renameExactArbitraryVarValue({ candidate, from, to })) return true
      if (to.utilityModifier) return false

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
      if (to.utilityModifier) return false

      candidate.value = candidate.value.replaceAll(from.cssVar, to.cssVar)
      changed = true
    }
  }

  return changed
}

function renameExactArbitraryVarValue(options: { candidate: Candidate; from: TokenPair; to: TokenPair }): boolean {
  let { candidate, from, to } = options
  if (candidate.kind !== 'functional') return false
  if (candidate.value?.kind !== 'arbitrary') return false
  if (candidate.value.value !== `var(${from.cssVar})`) return false

  candidate.value = { kind: 'named', value: to.utilitySuffix, fraction: null }
  applyTargetModifier({ candidate, to })
  return true
}

function renameExactArbitraryPropertyVarValue(options: {
  rawCandidate: string
  candidate: Candidate
  from: TokenPair
  to: TokenPair
}): string | undefined {
  let { rawCandidate, candidate, from, to } = options
  if (candidate.kind !== 'arbitrary') return undefined

  let prefix = getVariantPrefix(rawCandidate)

  if (candidate.property === from.cssVar) {
    let root = getCustomPropertyInlineRoot(from.namespace)
    return root ? `${prefix}${root}-[${candidate.value.trim().replace(/\s+/g, '_')}]` : undefined
  }

  if (candidate.value !== `var(${from.cssVar})`) return undefined

  let root = getArbitraryPropertyUtilityRoot({ property: candidate.property, namespace: from.namespace })
  return root ? `${prefix}${root}-${to.utilitySuffix}${to.utilityModifier ? `/${to.utilityModifier}` : ''}` : undefined
}

function getCustomPropertyInlineRoot(namespace: string): string | undefined {
  if (namespace === 'text') return 'text'
  if (namespace === 'radius') return 'rounded'
}

function getArbitraryPropertyUtilityRoot(options: { property: string; namespace: string }): string | undefined {
  if (options.namespace === 'text' && options.property === 'font-size') return 'text'
  if (options.namespace === 'color') {
    if (options.property === 'color') return 'text'
    if (options.property === 'background-color') return 'bg'
    if (options.property === 'border-color') return 'border'
  }
  if (options.namespace === 'radius' && options.property === 'border-radius') return 'rounded'
}

function applyTargetModifier(options: { candidate: Candidate; to: TokenPair }) {
  let { candidate, to } = options
  if (candidate.kind !== 'functional' || !to.utilityModifier) return

  let modifier = to.utilityModifier
  if (modifier.startsWith('[') && modifier.endsWith(']')) {
    candidate.modifier = { kind: 'arbitrary', value: modifier.slice(1, -1) }
    return
  }

  if (modifier.startsWith('(') && modifier.endsWith(')')) {
    candidate.modifier = { kind: 'arbitrary', value: `var(${modifier.slice(1, -1)})` }
    return
  }

  candidate.modifier = { kind: 'named', value: modifier }
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

// Lazy-loaded base design system used to detect which tokens already exist in the default theme.
let baseDesignSystemPromise: Promise<DesignSystem> | undefined

function getBaseDesignSystem(): Promise<DesignSystem> {
  if (!baseDesignSystemPromise) {
    baseDesignSystemPromise = __unstable__loadDesignSystem(defaultThemeCss)
  }
  return baseDesignSystemPromise
}

export async function getDesignSystem(options: {
  tokens: TokenPair[]
  candidates: string[]
}): Promise<DesignSystem> {
  let { tokens, candidates } = options
  let baseDs = await getBaseDesignSystem()

  let extraThemeVars = collectVariantThemeVars(candidates)
  // Only register tokens that don't already exist in the default Tailwind theme,
  // so canonicalizeCandidates can collapse e.g. text-[var(--color-pink-500)] → text-pink-500.
  for (let token of tokens) {
    if (!baseDs.resolveThemeValue(token.cssVar)) {
      extraThemeVars.push(`  ${token.cssVar}: ${themeValueForNamespace(token.namespace)};`)
    }
  }

  let key = extraThemeVars.sort().join('\n')
  if (cachedDesignSystemKey === key && cachedDesignSystemPromise) return cachedDesignSystemPromise

  let promise = __unstable__loadDesignSystem(`${defaultThemeCss}\n@theme {\n${key}\n}`)
  cachedDesignSystemKey = key
  cachedDesignSystemPromise = promise
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

function getVariantPrefix(candidate: string): string {
  let variants = splitCandidate(candidate).slice(0, -1)
  return variants.length === 0 ? '' : variants.join(':') + ':'
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

/**
 * Find var(--from-css-var) calls in non-candidate contexts and replace them with
 * color-mix() for opacity/modifier targets. For example:
 *   var(--color-primary-alpha-10) → color-mix(in srgb, var(--color-primary) 10%, transparent)
 */
export function findVarCallChangesForOpacityTarget(options: {
  content: string
  from: TokenPair
  to: TokenPair
  blockedRanges: StringChange[]
}): StringChange[] {
  let { content, from, to, blockedRanges } = options
  let changes: StringChange[] = []
  let searchPattern = `var(${from.cssVar})`
  let index = 0

  while (index < content.length) {
    let pos = content.indexOf(searchPattern, index)
    if (pos === -1) break

    let start = pos
    let end = pos + searchPattern.length

    // Check if this position is inside a range already handled by candidate renaming
    let blocked = blockedRanges.some((range) => start >= range.start && end <= range.end)

    if (!blocked) {
      let percentage = modifierToPercentage(to.utilityModifier!)
      let replacement = `color-mix(in srgb, var(${to.cssVar}) ${percentage}%, transparent)`
      changes.push({ start, end, replacement })
    }

    index = end
  }

  return changes
}

/**
 * Convert a Tailwind modifier to a percentage number.
 * Examples: "10" → 10, "[.16]" → 16, "[16%]" → 16, "50" → 50
 */
export function modifierToPercentage(modifier: string): number {
  // Bracket modifier like [.16] or [16%]
  if (modifier.startsWith('[') && modifier.endsWith(']')) {
    let inner = modifier.slice(1, -1)
    // Handle percentage like "16%"
    if (inner.endsWith('%')) return parseFloat(inner.slice(0, -1))
    // Handle decimal like ".16" (means 16%)
    let num = parseFloat(inner)
    if (num < 1) return Math.round(num * 100)
    return num
  }

  // Plain number modifier like "10" means 10%
  return parseFloat(modifier)
}
