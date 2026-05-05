// Inline command implementation: replaces project token utilities with direct Tailwind utilities.

import fs from 'node:fs/promises'
import path from 'node:path'
import pc from 'picocolors'
import { converter, parse as parseColor, type Oklch } from 'culori'
import {
  collectCustomPropertySources,
  getThemeValueMap,
  loadProjectDesignSystem,
  type CssVariableSource,
  type DesignSystem,
} from './design-system.ts'
import { discoverFiles, getExtension } from './discover.ts'
import { spliceChangesIntoString } from './splice.ts'
import { candidateUsesCssVar, findTemplateCandidateRenameChanges } from './template-rename.ts'
import { parseToken, type TokenPair } from './token.ts'

export interface InlineOptions {
  /** Token name to inline, e.g. "text-title-h1", "color-brand", or "radius-card". */
  token: string
  /** Project directory to process. */
  base: string
  /** Preview changes without writing files. */
  dryRun?: boolean
  /** Show every file and replacement. */
  verbose?: boolean
  /** Use arbitrary values like text-[3.5rem] instead of nearest Tailwind defaults. */
  disableApproximation?: boolean
  /** Include --text-token--line-height as a leading-* utility when present. */
  withLeading?: boolean
  /** Include --text-token--letter-spacing as a tracking-* utility when present. */
  withTracking?: boolean
}

export interface InlineResult {
  filesChanged: number
  totalReplacements: number
  changes: InlineFileChange[]
}

export interface InlineFileChange {
  file: string
  relativePath: string
  replacements: number
}

interface InlineUtilities {
  targetToken: string
  fontWeight?: string
  lineHeight?: string
  letterSpacing?: string
}

const REM_IN_PX = 16
const toOklch = converter('oklch')

export async function inlineToken(options: InlineOptions): Promise<InlineResult> {
  let { base, dryRun = false, verbose = false } = options
  let token = parseToken(options.token)

  let { cssFiles, templateFiles } = await discoverFiles(base)
  let designSystem = await loadProjectDesignSystem(cssFiles)
  let customPropertySources = await collectCustomPropertySources(cssFiles)
  let utilities = getInlineUtilities({
    designSystem,
    customPropertySources,
    token,
    disableApproximation: options.disableApproximation,
  })

  if (verbose) {
    console.error(pc.dim(`  Token: ${token.cssVar}`))
    console.error(pc.dim(`  Replacement: ${formatReplacementUtilities({ utilities, options })}`))
    console.error(pc.dim(`  Found ${templateFiles.length} template files`))
  }

  let changes: InlineFileChange[] = []

  for (let file of templateFiles) {
    let content = await fs.readFile(file, 'utf-8')
    if (!content.includes(token.cssVar) && !content.includes(token.utilitySuffix)) continue

    let extension = getExtension(file)
    let { content: inlined, replacements } = await inlineTemplateTextToken({
      content,
      extension,
      token,
      designSystem,
      utilities,
      withLeading: options.withLeading,
      withTracking: options.withTracking,
    })

    if (inlined === content) continue

    let relativePath = path.relative(base, file)
    changes.push({ file, relativePath, replacements })

    if (!dryRun) await atomicWriteFile(file, inlined)

    if (verbose) {
      console.error(
        `  ${pc.green('✓')} ${relativePath} (${replacements} replacement${replacements === 1 ? '' : 's'})`,
      )
    }
  }

  return {
    filesChanged: changes.length,
    totalReplacements: changes.reduce((sum, change) => sum + change.replacements, 0),
    changes,
  }
}

async function inlineTemplateTextToken(options: {
  content: string
  extension: string
  token: TokenPair
  designSystem: DesignSystem
  utilities: InlineUtilities
  withLeading?: boolean
  withTracking?: boolean
}): Promise<{ content: string; replacements: number }> {
  let changes = (await findTemplateCandidateRenameChanges({
    content: options.content,
    extension: options.extension,
    from: options.token,
    to: parseToken(options.utilities.targetToken),
  })).filter((change) =>
    isNamedTokenCandidate({ candidate: change.candidate, designSystem: options.designSystem, token: options.token }) ||
    getCustomPropertyInlineUtility({
      candidate: change.candidate,
      designSystem: options.designSystem,
      token: options.token,
    }) !== undefined,
  )

  for (let change of changes) {
    let customPropertyUtility = getCustomPropertyInlineUtility({
      candidate: change.candidate,
      designSystem: options.designSystem,
      token: options.token,
    })
    if (customPropertyUtility) {
      change.replacement = getVariantPrefix(change.candidate) + customPropertyUtility
      continue
    }

    change.replacement = buildReplacementCandidate({
      rawCandidate: change.candidate,
      fontSizeReplacement: change.replacement,
      utilities: options.utilities,
      withLeading: options.withLeading,
      withTracking: options.withTracking,
    })
  }

  if (changes.length === 0) return { content: options.content, replacements: 0 }
  return { content: spliceChangesIntoString(options.content, changes), replacements: changes.length }
}

function isNamedTokenCandidate(options: {
  candidate: string
  designSystem: DesignSystem
  token: TokenPair
}): boolean {
  for (let parsed of options.designSystem.parseCandidate(options.candidate)) {
    if (parsed.kind !== 'functional') continue
    if (parsed.value?.kind !== 'named') continue
    if (parsed.value.value !== options.token.utilitySuffix) continue
    if (!candidateUsesCssVar({ designSystem: options.designSystem, candidate: parsed, cssVar: options.token.cssVar })) continue
    return true
  }

  return false
}

function getCustomPropertyInlineUtility(options: {
  candidate: string
  designSystem: DesignSystem
  token: TokenPair
}): string | undefined {
  for (let parsed of options.designSystem.parseCandidate(options.candidate)) {
    if (parsed.kind !== 'arbitrary') continue
    if (parsed.property !== options.token.cssVar) continue
    let root = getCustomPropertyInlineRoot(options.token.namespace)
    if (!root) return undefined
    return `${root}-${toArbitraryValue(parsed.value)}`
  }

  return undefined
}

function getCustomPropertyInlineRoot(namespace: string): string | undefined {
  if (namespace === 'text') return 'text'
  if (namespace === 'radius') return 'rounded'
}

function getInlineUtilities(options: {
  designSystem: DesignSystem
  customPropertySources: Map<string, CssVariableSource>
  token: TokenPair
  disableApproximation?: boolean
}): InlineUtilities {
  let { designSystem, token, disableApproximation } = options
  let declarations = getResolvedDeclarations({ designSystem, customPropertySources: options.customPropertySources })
  let value = resolveCssValue({ variable: token.cssVar, declarations }) ?? designSystem.resolveThemeValue(token.cssVar)
  if (!value) throw new Error(`${token.cssVar} does not exist in the project Tailwind theme.`)

  if (token.namespace === 'text') {
    return {
      targetToken: disableApproximation
        ? `text-${toArbitraryValue(value)}`
        : `text-${getClosestDefaultLengthSuffix({ designSystem, prefix: '--text-', value })}`,
      fontWeight: designSystem.resolveThemeValue(`${token.cssVar}--font-weight`)
        ? `font-${getFontWeightSuffix({ designSystem, value: designSystem.resolveThemeValue(`${token.cssVar}--font-weight`)!, disableApproximation })}`
        : undefined,
      lineHeight: designSystem.resolveThemeValue(`${token.cssVar}--line-height`)
        ? `leading-${getNamedThemeSuffix({ designSystem, prefix: '--leading-', value: designSystem.resolveThemeValue(`${token.cssVar}--line-height`)! }) ?? toArbitraryValue(designSystem.resolveThemeValue(`${token.cssVar}--line-height`)!)}`
        : undefined,
      letterSpacing: designSystem.resolveThemeValue(`${token.cssVar}--letter-spacing`)
        ? `tracking-${getNamedThemeSuffix({ designSystem, prefix: '--tracking-', value: designSystem.resolveThemeValue(`${token.cssVar}--letter-spacing`)! }) ?? toArbitraryValue(designSystem.resolveThemeValue(`${token.cssVar}--letter-spacing`)!)}`
        : undefined,
    }
  }

  let targetSuffix = getInlineTargetSuffix({ designSystem, namespace: token.namespace, value, disableApproximation })
  return { targetToken: `${token.namespace}-${targetSuffix}` }
}

function getInlineTargetSuffix(options: {
  designSystem: DesignSystem
  namespace: string
  value: string
  disableApproximation?: boolean
}): string {
  if (options.disableApproximation) return toArbitraryValue(options.value)

  if (options.namespace === 'color') {
    return getClosestDefaultColorSuffix({ designSystem: options.designSystem, value: options.value }) ??
      toArbitraryValue(options.value)
  }

  if (options.namespace === 'spacing') return getClosestSpacingSuffix({ designSystem: options.designSystem, value: options.value })

  let prefix = `--${options.namespace}-`
  return getClosestDefaultLengthSuffix({ designSystem: options.designSystem, prefix, value: options.value })
}

function getClosestDefaultLengthSuffix(options: { designSystem: DesignSystem; prefix: string; value: string }): string {
  let target = parseCssLength(options.value)
  if (target === undefined) return toArbitraryValue(options.value)

  let closest: { suffix: string; distance: number } | undefined
  for (let [variable, entry] of options.designSystem.theme.entries()) {
    if (!options.designSystem.theme.hasDefault(variable)) continue
    if (!variable.startsWith(options.prefix)) continue
    if (variable.slice(options.prefix.length).includes('--')) continue

    let value = parseCssLength(entry.value)
    if (value === undefined) continue

    let distance = Math.abs(value - target)
    if (!closest || distance < closest.distance) closest = { suffix: variable.slice(options.prefix.length), distance }
  }

  return closest?.suffix ?? toArbitraryValue(options.value)
}

function getClosestSpacingSuffix(options: { designSystem: DesignSystem; value: string }): string {
  let target = parseCssLength(options.value)
  let spacing = parseCssLength(options.designSystem.resolveThemeValue('--spacing') ?? '0.25rem')
  if (target === undefined || spacing === undefined || spacing === 0) return toArbitraryValue(options.value)
  let multiple = Math.round((target / spacing) * 2) / 2
  return Number.isInteger(multiple) ? String(multiple) : String(multiple).replace(/0+$/, '').replace(/\.$/, '')
}

function getClosestDefaultColorSuffix(options: { designSystem: DesignSystem; value: string }): string | undefined {
  let target = parseOklch(options.value)
  if (!target) return undefined

  let closest: { suffix: string; distance: number } | undefined
  for (let [variable, entry] of options.designSystem.theme.entries()) {
    if (!options.designSystem.theme.hasDefault(variable)) continue
    if (!variable.startsWith('--color-')) continue
    if (variable.slice('--color-'.length).includes('--')) continue

    let color = parseOklch(entry.value)
    if (!color) continue
    let distance = oklchDistance(target, color)
    if (!closest || distance < closest.distance) closest = { suffix: variable.slice('--color-'.length), distance }
  }

  return closest?.suffix
}

function getFontWeightSuffix(options: {
  designSystem: DesignSystem
  value: string
  disableApproximation?: boolean
}): string {
  if (options.disableApproximation) return toArbitraryValue(options.value)
  return getNamedThemeSuffix({ designSystem: options.designSystem, prefix: '--font-weight-', value: options.value }) ??
    toArbitraryValue(options.value)
}

function getNamedThemeSuffix(options: { designSystem: DesignSystem; prefix: string; value: string }): string | undefined {
  let target = normalizeCssValue(options.value)
  for (let [variable, entry] of options.designSystem.theme.entries()) {
    if (!options.designSystem.theme.hasDefault(variable)) continue
    if (!variable.startsWith(options.prefix)) continue
    if (normalizeCssValue(entry.value) === target) return variable.slice(options.prefix.length)
  }
  return undefined
}

function buildReplacementCandidate(options: {
  rawCandidate: string
  fontSizeReplacement: string
  utilities: InlineUtilities
  withLeading?: boolean
  withTracking?: boolean
}): string {
  let prefix = getVariantPrefix(options.rawCandidate)
  let utilities = [options.fontSizeReplacement]
  if (options.utilities.fontWeight) utilities.push(prefix + options.utilities.fontWeight)
  if (options.withTracking && options.utilities.letterSpacing) utilities.push(prefix + options.utilities.letterSpacing)
  if (options.withLeading && options.utilities.lineHeight) utilities.push(prefix + options.utilities.lineHeight)
  return utilities.join(' ')
}

function getVariantPrefix(candidate: string): string {
  let variants = splitCandidate(candidate).slice(0, -1)
  return variants.length === 0 ? '' : variants.join(':') + ':'
}

function formatReplacementUtilities(options: { utilities: InlineUtilities; options: InlineOptions }): string {
  let values = [options.utilities.targetToken]
  if (options.utilities.fontWeight) values.push(options.utilities.fontWeight)
  if (options.options.withTracking && options.utilities.letterSpacing) values.push(options.utilities.letterSpacing)
  if (options.options.withLeading && options.utilities.lineHeight) values.push(options.utilities.lineHeight)
  return values.join(' ')
}

function parseCssLength(value: string): number | undefined {
  let match = value.trim().match(/^(-?\d*\.?\d+)(px|rem)$/)
  if (!match) return undefined
  let number = Number(match[1])
  if (!Number.isFinite(number)) return undefined
  return match[2] === 'rem' ? number * REM_IN_PX : number
}

function parseOklch(value: string): Oklch | undefined {
  let color = parseColor(value)
  if (!color) return undefined
  return toOklch(color)
}

function oklchDistance(a: Oklch, b: Oklch): number {
  let hueDistance = circularHueDistance(a.h, b.h) / 180
  let averageChroma = ((a.c ?? 0) + (b.c ?? 0)) / 2
  return Math.sqrt(
    (a.l - b.l) ** 2 +
      ((a.c ?? 0) - (b.c ?? 0)) ** 2 +
      (averageChroma * hueDistance) ** 2,
  )
}

function circularHueDistance(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return 0
  let distance = Math.abs(a - b) % 360
  return distance > 180 ? 360 - distance : distance
}

function getResolvedDeclarations(options: {
  designSystem: DesignSystem
  customPropertySources: Map<string, CssVariableSource>
}): Map<string, string> {
  let declarations = new Map<string, string>()
  for (let [variable, entry] of getThemeValueMap(options.designSystem)) declarations.set(variable, entry)
  for (let [variable, source] of options.customPropertySources) declarations.set(variable, source.value)
  return declarations
}

function resolveCssValue(options: {
  variable: string
  declarations: Map<string, string>
  seen?: Set<string>
}): string | undefined {
  let seen = options.seen ?? new Set<string>()
  if (seen.has(options.variable)) return undefined
  seen.add(options.variable)

  let value = options.declarations.get(options.variable)
  if (!value) return undefined

  let reference = getExactVarReference(value)
  if (reference) return resolveCssValue({ variable: reference, declarations: options.declarations, seen })
  return value
}

function getExactVarReference(value: string): string | undefined {
  let match = value.trim().match(/^var\(\s*(--[\w-]+)\s*\)$/)
  return match?.[1]
}

function normalizeCssValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function toArbitraryValue(value: string): string {
  return `[${value.trim().replace(/\s+/g, '_')}]`
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  let tmpPath = filePath + '.windlint-tmp'
  await fs.writeFile(tmpPath, content, 'utf-8')
  await fs.rename(tmpPath, filePath)
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
