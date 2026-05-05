// Linting orchestration: checks Tailwind v4 candidates and CSS theme references, with optional fixes.

import { Scanner } from '@tailwindcss/oxide'
import { __unstable__loadDesignSystem } from 'tailwindcss'
import fs from 'node:fs/promises'
import path from 'node:path'
import { parse, type Declaration } from 'postcss'
import { discoverFiles, getExtension } from './discover.ts'
import { defaultThemeCss } from './template-rename.ts'
import { spliceChangesIntoString, type StringChange } from './splice.ts'

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>
type AstNode = ReturnType<DesignSystem['compileAstNodes']>[number]['node']

export interface LintOptions {
  /** Project directory to lint. */
  base: string
  /** Optional file list relative to base. Defaults to discovered CSS and template files. */
  files?: string[]
  /** Apply safe text fixes. */
  fix?: boolean
  /** Only report errors. */
  quiet?: boolean
}

export interface LintDiagnostic {
  file: string
  relativePath: string
  line: number
  column: number
  severity: 'error' | 'warning'
  rule: 'suggest-canonical' | 'css-conflict' | 'invalid-config-path'
  message: string
  candidate?: string
  replacement?: string
  fixed?: boolean
}

export interface LintResult {
  diagnostics: LintDiagnostic[]
  issueCount: number
  errorCount: number
  warningCount: number
  fixedCount: number
  fixedFiles: number
}

const CSS_EXTENSIONS = new Set(['css', 'scss', 'sass', 'less', 'pcss', 'postcss'])

export async function lint(options: LintOptions): Promise<LintResult> {
  let { cssFiles, templateFiles, designCssFiles } = await resolveLintFiles(options)
  let designSystem = await loadProjectDesignSystem(designCssFiles)
  let diagnostics: LintDiagnostic[] = []
  let fixedFiles = 0

  for (let file of templateFiles) {
    let result = await lintTemplateFile({ file, base: options.base, designSystem, fix: options.fix })
    diagnostics.push(...result.diagnostics)
    if (result.fixed) fixedFiles++
  }

  for (let file of cssFiles) {
    diagnostics.push(...await lintCssFile({ file, base: options.base, designSystem }))
  }

  if (options.quiet) diagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === 'error')

  let errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
  let warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length
  let fixedCount = diagnostics.filter((diagnostic) => diagnostic.fixed).length

  return {
    diagnostics,
    issueCount: diagnostics.length,
    errorCount,
    warningCount,
    fixedCount,
    fixedFiles,
  }
}

export function formatLintResult(result: LintResult): string {
  let fixedDiagnostics = result.diagnostics.filter((diagnostic) => diagnostic.fixed)
  let remainingDiagnostics = result.diagnostics.filter((diagnostic) => !diagnostic.fixed)

  if (result.fixedCount > 0) {
    let lines = fixedDiagnostics
      .map((diagnostic) => {
        let replacement = diagnostic.replacement ? ` → ${diagnostic.replacement}` : ''
        return `${diagnostic.relativePath}:${diagnostic.line}:${diagnostic.column} fixed ${diagnostic.candidate}${replacement}`
      })
    lines.push(
      `Fixed ${result.fixedCount} issue${result.fixedCount === 1 ? '' : 's'} in ${result.fixedFiles} file${result.fixedFiles === 1 ? '' : 's'}`,
    )

    if (remainingDiagnostics.length > 0) {
      lines.push('', ...formatDiagnosticLines(remainingDiagnostics), formatFoundLine(remainingDiagnostics))
    }

    return lines.join('\n')
  }

  return [...formatDiagnosticLines(result.diagnostics), formatFoundLine(result.diagnostics)].join('\n')
}

function formatDiagnosticLines(diagnostics: LintDiagnostic[]): string[] {
  return diagnostics.map((diagnostic) => {
    return `${diagnostic.relativePath}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity} ${diagnostic.message} (${diagnostic.rule})`
  })
}

function formatFoundLine(diagnostics: LintDiagnostic[]): string {
  let errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
  let warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length
  return `Found ${diagnostics.length} issue${diagnostics.length === 1 ? '' : 's'} (${errorCount} error${errorCount === 1 ? '' : 's'}, ${warningCount} warning${warningCount === 1 ? '' : 's'})`
}

async function resolveLintFiles(options: LintOptions): Promise<{
  cssFiles: string[]
  templateFiles: string[]
  designCssFiles: string[]
}> {
  let discovered = await discoverFiles(options.base)
  if (!options.files || options.files.length === 0) return { ...discovered, designCssFiles: discovered.cssFiles }

  let cssFiles: string[] = []
  let templateFiles: string[] = []

  for (let file of options.files) {
    let absolute = path.isAbsolute(file) ? file : path.resolve(options.base, file)
    if (CSS_EXTENSIONS.has(getExtension(absolute))) {
      cssFiles.push(absolute)
    } else {
      templateFiles.push(absolute)
    }
  }

  return { cssFiles, templateFiles, designCssFiles: [...new Set([...discovered.cssFiles, ...cssFiles])] }
}

async function loadProjectDesignSystem(cssFiles: string[]): Promise<DesignSystem> {
  let css = defaultThemeCss

  for (let file of cssFiles) {
    let content = await fs.readFile(file, 'utf-8')
    css += '\n' + stripCssImports(content)
  }

  return __unstable__loadDesignSystem(css)
}

function stripCssImports(content: string): string {
  let root = parse(content, { from: undefined })
  root.walkAtRules('import', (atRule) => {
    atRule.remove()
  })
  return root.toString()
}

async function lintTemplateFile(options: {
  file: string
  base: string
  designSystem: DesignSystem
  fix?: boolean
}): Promise<{ diagnostics: LintDiagnostic[]; fixed: boolean }> {
  let { file, base, designSystem, fix } = options
  let content = await fs.readFile(file, 'utf-8')
  let scanner = new Scanner({})
  let candidates = scanner.getCandidatesWithPositions({ content, extension: getExtension(file) })
  let diagnostics: LintDiagnostic[] = []
  let changes: StringChange[] = []
  let deletedStarts = new Set<number>()
  let relativePath = path.relative(base, file)

  for (let group of groupCandidatesByClassList({ content, candidates })) {
    let conflicts = findCssConflicts({ content, group, designSystem })
    for (let conflict of conflicts) {
      deletedStarts.add(conflict.deleted.position)
      diagnostics.push(createDiagnostic({
        content,
        file,
        relativePath,
        start: conflict.deleted.position,
        severity: 'warning',
        rule: 'css-conflict',
        message: `${conflict.deleted.candidate} conflicts with ${conflict.winner.candidate}`,
        candidate: conflict.deleted.candidate,
        replacement: 'removed',
        fixed: Boolean(fix),
      }))
      if (fix) changes.push(deletionChange({ content, group, candidate: conflict.deleted }))
    }
  }

  for (let { candidate, position } of candidates) {
    if (deletedStarts.has(position)) continue
    let canonical = designSystem.canonicalizeCandidates([candidate])[0]
    if (!canonical || canonical === candidate) continue

    diagnostics.push(createDiagnostic({
      content,
      file,
      relativePath,
      start: position,
      severity: 'warning',
      rule: 'suggest-canonical',
      message: `${candidate} can be written as ${canonical}`,
      candidate,
      replacement: canonical,
      fixed: Boolean(fix),
    }))

    if (fix) changes.push({ start: position, end: position + candidate.length, replacement: canonical })
  }

  if (fix && changes.length > 0) {
    await fs.writeFile(file, spliceChangesIntoString(content, changes), 'utf-8')
  }

  return { diagnostics, fixed: fix === true && changes.length > 0 }
}

function groupCandidatesByClassList(options: {
  content: string
  candidates: ReturnType<Scanner['getCandidatesWithPositions']>
}) {
  let groups = new Map<string, {
    start: number
    end: number
    candidates: Array<{ candidate: string; position: number }>
  }>()

  for (let item of options.candidates) {
    let bounds = getEnclosingStringBounds({ content: options.content, position: item.position })
    let key = `${bounds.start}:${bounds.end}`
    let group = groups.get(key)
    if (!group) {
      group = { ...bounds, candidates: [] }
      groups.set(key, group)
    }
    group.candidates.push(item)
  }

  return [...groups.values()]
}

function getEnclosingStringBounds(options: { content: string; position: number }): { start: number; end: number } {
  let quoteStart = options.position
  while (quoteStart > 0 && !isQuote(options.content[quoteStart])) quoteStart--

  if (!isQuote(options.content[quoteStart])) {
    let lineStart = options.content.lastIndexOf('\n', options.position - 1) + 1
    let lineEnd = options.content.indexOf('\n', options.position)
    return { start: lineStart, end: lineEnd === -1 ? options.content.length : lineEnd }
  }

  let quote = options.content[quoteStart]
  let quoteEnd = quoteStart + 1
  while (quoteEnd < options.content.length) {
    if (options.content[quoteEnd] === '\\') {
      quoteEnd += 2
      continue
    }
    if (options.content[quoteEnd] === quote) break
    quoteEnd++
  }

  return { start: quoteStart + 1, end: quoteEnd }
}

function isQuote(char: string | undefined): boolean {
  return char === '"' || char === "'" || char === '`'
}

function findCssConflicts(options: {
  content: string
  group: { start: number; end: number; candidates: Array<{ candidate: string; position: number }> }
  designSystem: DesignSystem
}) {
  let seen = new Map<string, { candidate: string; position: number }>()
  let conflicts: Array<{
    deleted: { candidate: string; position: number }
    winner: { candidate: string; position: number }
  }> = []
  let deleted = new Set<number>()

  for (let item of options.group.candidates) {
    for (let property of getCompiledPropertyKeys({ candidate: item.candidate, designSystem: options.designSystem })) {
      let previous = seen.get(property)
      if (previous && !deleted.has(previous.position)) {
        conflicts.push({ deleted: previous, winner: item })
        deleted.add(previous.position)
      }
      seen.set(property, item)
    }
  }

  return conflicts
}

function getCompiledPropertyKeys(options: { candidate: string; designSystem: DesignSystem }): string[] {
  let keys = new Set<string>()
  for (let parsedCandidate of options.designSystem.parseCandidate(options.candidate)) {
    for (let { node } of options.designSystem.compileAstNodes(parsedCandidate)) {
      collectDeclarationKeys({ node, context: [], keys })
    }
  }
  return [...keys]
}

function collectDeclarationKeys(options: { node: AstNode; context: string[]; keys: Set<string> }) {
  let { node, context, keys } = options
  if (node.kind === 'declaration') {
    if (!node.property.startsWith('--')) keys.add(`${context.join('|')}::${node.property}::${node.important}`)
    return
  }

  let nextContext = context

  switch (node.kind) {
    case 'rule':
      if (!node.selector.startsWith('.')) nextContext = [...context, `rule:${node.selector}`]
      break
    case 'at-rule':
      if (node.name !== '@property') nextContext = [...context, `at:${node.name} ${node.params}`]
      break
    case 'context':
    case 'at-root':
      break
    default:
      return
  }

  for (let child of node.nodes) collectDeclarationKeys({ node: child, context: nextContext, keys })
}

function deletionChange(options: {
  content: string
  group: { start: number; end: number }
  candidate: { candidate: string; position: number }
}): StringChange {
  let start = options.candidate.position
  let end = start + options.candidate.candidate.length

  if (end < options.group.end && isWhitespace(options.content[end])) {
    while (end < options.group.end && isWhitespace(options.content[end])) end++
    return { start, end, replacement: '' }
  }

  while (start > options.group.start && isWhitespace(options.content[start - 1])) start--
  return { start, end, replacement: '' }
}

async function lintCssFile(options: {
  file: string
  base: string
  designSystem: DesignSystem
}): Promise<LintDiagnostic[]> {
  let content = await fs.readFile(options.file, 'utf-8')
  let relativePath = path.relative(options.base, options.file)
  let themeKeys = [...options.designSystem.theme.entries()].map(([key]) => key)
  let themePrefixes = getThemePrefixes(themeKeys)
  let diagnostics: LintDiagnostic[] = []
  let root = parse(content, { from: undefined })

  root.walkDecls((declaration) => {
    let valueStart = getDeclarationValueStart({ content, declaration })
    if (valueStart === undefined) return

    for (let reference of findThemeReferences(declaration.value)) {
      if (!themePrefixes.some((prefix) => reference.variable.startsWith(prefix))) continue
      if (options.designSystem.resolveThemeValue(reference.variable)) continue
      let suggestion = closest(reference.variable, themeKeys)
      let suggestionMessage = suggestion ? ` Did you mean ${suggestion}?` : ''
      diagnostics.push(createDiagnostic({
        content,
        file: options.file,
        relativePath,
        start: valueStart + reference.start,
        severity: 'error',
        rule: 'invalid-config-path',
        message: `${reference.variable} does not exist.${suggestionMessage}`,
        candidate: reference.variable,
      }))
    }
  })

  return diagnostics
}

function getThemePrefixes(themeKeys: string[]): string[] {
  let prefixes = new Set<string>()
  for (let key of themeKeys) {
    let secondDash = key.indexOf('-', 2)
    if (secondDash !== -1) prefixes.add(key.slice(0, secondDash + 1))
  }
  return [...prefixes]
}

function findThemeReferences(value: string): Array<{ variable: string; start: number }> {
  let references: Array<{ variable: string; start: number }> = []
  let index = 0

  while (index < value.length) {
    if (value[index] === '"' || value[index] === "'") {
      index = skipQuotedString(value, index)
      continue
    }

    if (value.startsWith('var(', index)) {
      let reference = readFunctionArgument({ value, functionStart: index, name: 'var' })
      if (reference?.argument.startsWith('--')) references.push(reference)
      index = reference?.end ?? index + 1
      continue
    }

    if (value.startsWith('theme(', index)) {
      let reference = readFunctionArgument({ value, functionStart: index, name: 'theme' })
      if (reference) references.push({ ...reference, variable: normalizeThemePath(reference.argument) })
      index = reference?.end ?? index + 1
      continue
    }

    index++
  }

  return references
}

function readFunctionArgument(options: { value: string; functionStart: number; name: string }) {
  let argumentStart = options.functionStart + options.name.length + 1
  let index = argumentStart
  let depth = 0

  while (index < options.value.length) {
    let char = options.value[index]
    if (char === '(') depth++
    if (char === ')') {
      if (depth === 0) break
      depth--
    }
    if (char === ',' && depth === 0) break
    index++
  }

  let rawArgument = options.value.slice(argumentStart, index)
  let argument = rawArgument.trim().replace(/^['"]|['"]$/g, '')
  let leadingWhitespace = rawArgument.length - rawArgument.trimStart().length
  return {
    variable: argument,
    argument,
    start: argumentStart + leadingWhitespace,
    end: index + 1,
  }
}

function normalizeThemePath(path: string): string {
  if (path.startsWith('--')) return path
  return `--${path.replaceAll('.', '-')}`
}

function getDeclarationValueStart(options: { content: string; declaration: Declaration }): number | undefined {
  let declarationStart = options.declaration.source?.start?.offset
  if (declarationStart === undefined) return undefined
  let searchStart = declarationStart + options.declaration.prop.length
  let valueStart = options.content.indexOf(options.declaration.value, searchStart)
  return valueStart === -1 ? undefined : valueStart
}

function createDiagnostic(options: {
  content: string
  file: string
  relativePath: string
  start: number
  severity: LintDiagnostic['severity']
  rule: LintDiagnostic['rule']
  message: string
  candidate?: string
  replacement?: string
  fixed?: boolean
}): LintDiagnostic {
  let position = getLineColumn(options.content, options.start)
  return { ...options, ...position }
}

function getLineColumn(content: string, offset: number): { line: number; column: number } {
  let line = 1
  let lineStart = 0
  for (let index = 0; index < offset; index++) {
    if (content[index] === '\n') {
      line++
      lineStart = index + 1
    }
  }
  return { line, column: offset - lineStart + 1 }
}

function closest(value: string, candidates: string[]): string | undefined {
  let best: { candidate: string; distance: number } | undefined
  for (let candidate of candidates) {
    let distance = levenshtein(value, candidate)
    if (!best || distance < best.distance) best = { candidate, distance }
  }
  return best?.distance !== undefined && best.distance <= Math.max(3, Math.floor(value.length / 3))
    ? best.candidate
    : undefined
}

function levenshtein(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let aIndex = 0; aIndex < a.length; aIndex++) {
    let current = [aIndex + 1]
    for (let bIndex = 0; bIndex < b.length; bIndex++) {
      current[bIndex + 1] = Math.min(
        current[bIndex]! + 1,
        previous[bIndex + 1]! + 1,
        previous[bIndex]! + (a[aIndex] === b[bIndex] ? 0 : 1),
      )
    }
    previous = current
  }

  return previous[b.length]!
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

function isWhitespace(char: string | undefined): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r'
}
