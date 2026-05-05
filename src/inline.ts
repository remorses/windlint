// Inline rename mode: replaces project text token utilities with direct Tailwind utilities.

import { Scanner } from '@tailwindcss/oxide'
import fs from 'node:fs/promises'
import path from 'node:path'
import pc from 'picocolors'
import { loadProjectDesignSystem, type DesignSystem } from './design-system.ts'
import { discoverFiles, getExtension } from './discover.ts'
import { spliceChangesIntoString, type StringChange } from './splice.ts'
import { candidateUsesCssVar } from './template-rename.ts'
import { parseToken, type TokenPair } from './token.ts'

export interface InlineOptions {
  /** Text token name to inline, e.g. "text-title-h1" or "--text-title-h1". */
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

interface TextTokenDefinition {
  token: TokenPair
  fontSize: string
  fontWeight?: string
  lineHeight?: string
  letterSpacing?: string
}

interface TextUtilities {
  fontSize: string
  fontWeight?: string
  lineHeight?: string
  letterSpacing?: string
}

const REM_IN_PX = 16

export async function inlineToken(options: InlineOptions): Promise<InlineResult> {
  let { base, dryRun = false, verbose = false } = options
  let token = parseToken(options.token)
  if (token.namespace !== 'text') {
    throw new Error(`Only text tokens are supported for inline right now. Received ${token.cssVar}.`)
  }

  let { cssFiles, templateFiles } = await discoverFiles(base)
  let designSystem = await loadProjectDesignSystem(cssFiles)
  let definition = getTextTokenDefinition({ designSystem, token })
  let utilities = getTextUtilities({ designSystem, definition, disableApproximation: options.disableApproximation })

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
    let { content: inlined, replacements } = inlineTemplateTextToken({
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

function inlineTemplateTextToken(options: {
  content: string
  extension: string
  token: TokenPair
  designSystem: DesignSystem
  utilities: TextUtilities
  withLeading?: boolean
  withTracking?: boolean
}): { content: string; replacements: number } {
  let scanner = new Scanner({})
  let candidates = scanner.getCandidatesWithPositions({ content: options.content, extension: options.extension })
  let changes: StringChange[] = []

  for (let { candidate, position } of candidates) {
    if (!candidate.includes(options.token.utilitySuffix)) continue
    if (!isTextTokenCandidate({ candidate, designSystem: options.designSystem, token: options.token })) continue

    changes.push({
      start: position,
      end: position + candidate.length,
      replacement: buildReplacementCandidate({
        rawCandidate: candidate,
        utilities: options.utilities,
        withLeading: options.withLeading,
        withTracking: options.withTracking,
      }),
    })
  }

  if (changes.length === 0) return { content: options.content, replacements: 0 }
  return { content: spliceChangesIntoString(options.content, changes), replacements: changes.length }
}

function isTextTokenCandidate(options: {
  candidate: string
  designSystem: DesignSystem
  token: TokenPair
}): boolean {
  for (let parsed of options.designSystem.parseCandidate(options.candidate)) {
    if (parsed.kind !== 'functional') continue
    if (parsed.root !== 'text') continue
    if (parsed.value?.kind !== 'named') continue
    if (parsed.value.value !== options.token.utilitySuffix) continue
    if (!candidateUsesCssVar({ designSystem: options.designSystem, candidate: parsed, cssVar: options.token.cssVar })) continue
    return true
  }

  return false
}

function getTextTokenDefinition(options: { designSystem: DesignSystem; token: TokenPair }): TextTokenDefinition {
  let { designSystem, token } = options
  let fontSize = designSystem.resolveThemeValue(token.cssVar)
  if (!fontSize) throw new Error(`${token.cssVar} does not exist in the project Tailwind theme.`)

  return {
    token,
    fontSize,
    fontWeight: designSystem.resolveThemeValue(`${token.cssVar}--font-weight`),
    lineHeight: designSystem.resolveThemeValue(`${token.cssVar}--line-height`),
    letterSpacing: designSystem.resolveThemeValue(`${token.cssVar}--letter-spacing`),
  }
}

function getTextUtilities(options: {
  designSystem: DesignSystem
  definition: TextTokenDefinition
  disableApproximation?: boolean
}): TextUtilities {
  let { designSystem, definition, disableApproximation } = options
  return {
    fontSize: disableApproximation
      ? `text-${toArbitraryValue(definition.fontSize)}`
      : `text-${getClosestDefaultTextSize({ designSystem, value: definition.fontSize })}`,
    fontWeight: definition.fontWeight
      ? `font-${getFontWeightSuffix({ designSystem, value: definition.fontWeight, disableApproximation })}`
      : undefined,
    lineHeight: definition.lineHeight
      ? `leading-${getNamedThemeSuffix({ designSystem, prefix: '--leading-', value: definition.lineHeight }) ?? toArbitraryValue(definition.lineHeight)}`
      : undefined,
    letterSpacing: definition.letterSpacing
      ? `tracking-${getNamedThemeSuffix({ designSystem, prefix: '--tracking-', value: definition.letterSpacing }) ?? toArbitraryValue(definition.letterSpacing)}`
      : undefined,
  }
}

function getClosestDefaultTextSize(options: { designSystem: DesignSystem; value: string }): string {
  let target = parseCssLength(options.value)
  if (target === undefined) return toArbitraryValue(options.value)

  let closest: { suffix: string; distance: number } | undefined
  for (let [variable, entry] of options.designSystem.theme.entries()) {
    if (!options.designSystem.theme.hasDefault(variable)) continue
    if (!variable.startsWith('--text-')) continue
    if (variable.slice('--text-'.length).includes('--')) continue

    let value = parseCssLength(entry.value)
    if (value === undefined) continue

    let distance = Math.abs(value - target)
    if (!closest || distance < closest.distance) closest = { suffix: variable.slice('--text-'.length), distance }
  }

  return closest?.suffix ?? toArbitraryValue(options.value)
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
  utilities: TextUtilities
  withLeading?: boolean
  withTracking?: boolean
}): string {
  let utilities = [options.utilities.fontSize]
  if (options.utilities.fontWeight) utilities.push(options.utilities.fontWeight)
  if (options.withTracking && options.utilities.letterSpacing) utilities.push(options.utilities.letterSpacing)
  if (options.withLeading && options.utilities.lineHeight) utilities.push(options.utilities.lineHeight)

  let variants = splitCandidate(options.rawCandidate).slice(0, -1)
  let prefix = variants.length === 0 ? '' : variants.join(':') + ':'
  return utilities.map((utility) => prefix + utility).join(' ')
}

function formatReplacementUtilities(options: { utilities: TextUtilities; options: InlineOptions }): string {
  let values = [options.utilities.fontSize]
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
