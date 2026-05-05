// Token usage counting: discovers project CSS variables, then counts their Tailwind
// utility and explicit var() usage across markup files.

import { Scanner } from '@tailwindcss/oxide'
import fs from 'node:fs/promises'
import { findCssVariableNameChanges } from './css-rename.ts'
import {
  collectCustomPropertySources,
  getProjectThemeVariables,
  isProjectThemeVariable,
  loadProjectDesignSystem,
  type DesignSystem,
} from './design-system.ts'
import { discoverFiles, getExtension } from './discover.ts'
import {
  candidateUsesCssVar,
  getDesignSystem,
} from './template-rename.ts'
import { parseToken, type TokenPair } from './token.ts'
import type { StringChange } from './splice.ts'

export interface CountOptions {
  /** Project directory to inspect. */
  base: string
}

export interface TokenUsageRow {
  variable: string
  namespace: string
  utilitySuffix: string
  uses: number
}

export interface TokenUsageResult {
  rows: TokenUsageRow[]
}

export async function countTokenUsage(options: CountOptions): Promise<TokenUsageResult> {
  let { cssFiles, templateFiles } = await discoverFiles(options.base)
  let projectDesignSystem = await loadProjectDesignSystem(cssFiles)
  let declaredVariables = await collectProjectCssVariables({ cssFiles, designSystem: projectDesignSystem })
  let tokens = declaredVariables.map((variable) => parseToken(variable))
  let counts = new Map(tokens.map((token) => [token.cssVar, 0]))
  let templateContents = await readTemplateContents(templateFiles)
  let designSystem = await getDesignSystem({
    tokens,
    candidates: templateContents.flatMap((template) => template.candidates.map(({ candidate }) => candidate)),
  })

  for (let template of templateContents) {
    let candidateRanges: StringChange[] = []

    for (let { candidate, position } of template.candidates) {
      candidateRanges.push({ start: position, end: position + candidate.length, replacement: candidate })
      countCandidateUses({ candidate, designSystem, tokens, counts })
    }

    countExplicitVariableUses({ content: template.content, rangesToSkip: candidateRanges, tokens, counts })
  }

  return {
    rows: tokens
      .map((token) => ({
        variable: token.cssVar,
        namespace: token.namespace,
        utilitySuffix: token.namespace ? token.utilitySuffix : '',
        uses: counts.get(token.cssVar) ?? 0,
      }))
      .sort((a, b) => b.uses - a.uses || a.variable.localeCompare(b.variable)),
  }
}

export function formatTokenUsageTable(result: TokenUsageResult): string {
  if (result.rows.length === 0) return 'No project CSS variables found.'

  let lines = ['| Variable | Uses | Utility suffix |', '| --- | ---: | --- |']
  for (let row of result.rows) {
    let suffix = row.utilitySuffix ? `\`${row.utilitySuffix}\`` : ''
    lines.push(`| \`${row.variable}\` | ${row.uses} | ${suffix} |`)
  }
  return lines.join('\n')
}

async function collectProjectCssVariables(options: {
  cssFiles: string[]
  designSystem: DesignSystem
}): Promise<string[]> {
  let declared = new Set(getProjectThemeVariables(options.designSystem))
  let sources = await collectCustomPropertySources(options.cssFiles)

  for (let variable of sources.keys()) {
    if (isProjectThemeVariable(options.designSystem, variable)) continue
    if (options.designSystem.theme.hasDefault(variable)) continue
    declared.add(variable)
  }

  return [...declared].sort()
}

async function readTemplateContents(templateFiles: string[]) {
  let scanner = new Scanner({})
  let templates: Array<{
    content: string
    candidates: ReturnType<Scanner['getCandidatesWithPositions']>
  }> = []

  for (let file of templateFiles) {
    let content = await fs.readFile(file, 'utf-8')
    templates.push({
      content,
      candidates: scanner.getCandidatesWithPositions({ content, extension: getExtension(file) }),
    })
  }

  return templates
}

function countCandidateUses(options: {
  candidate: string
  designSystem: Awaited<ReturnType<typeof getDesignSystem>>
  tokens: TokenPair[]
  counts: Map<string, number>
}) {
  let { candidate, designSystem, tokens, counts } = options
  let parsedCandidates = [...designSystem.parseCandidate(candidate)]

  for (let token of tokens) {
    let explicitUses = findCssVariableNameChanges({
      content: candidate,
      fromVar: token.cssVar,
      toVar: token.cssVar,
      skipCssStringsAndComments: false,
    }).length
    if (explicitUses > 0) {
      increment({ counts, variable: token.cssVar, amount: explicitUses })
      continue
    }

    let usesToken = parsedCandidates.some((parsedCandidate) => {
      if (candidateUsesCssVar({ designSystem, candidate: parsedCandidate, cssVar: token.cssVar })) {
        return true
      }

      return candidateUsesTokenByName({ candidate: parsedCandidate, token })
    })

    if (usesToken) {
      increment({ counts, variable: token.cssVar, amount: 1 })
    }
  }
}

function candidateUsesTokenByName(options: {
  candidate: ReturnType<Awaited<ReturnType<typeof getDesignSystem>>['parseCandidate']>[number]
  token: TokenPair
}): boolean {
  let { candidate, token } = options

  if (token.namespace === 'breakpoint' && variantsUseToken(candidate.variants, token)) return true
  if (token.namespace === 'container' && variantsUseToken(candidate.variants, token)) return true

  if (candidate.kind !== 'functional') return false
  if (candidate.value?.kind !== 'named' || candidate.value.value !== token.utilitySuffix) return false

  return candidate.root === token.namespace
}

function variantsUseToken(
  variants: ReturnType<Awaited<ReturnType<typeof getDesignSystem>>['parseCandidate']>[number]['variants'],
  token: TokenPair,
): boolean {
  for (let variant of variants) {
    if (token.namespace === 'breakpoint') {
      if (variant.kind === 'static' && variant.root === token.utilitySuffix) return true
      if (
        variant.kind === 'functional' &&
        (variant.root === 'min' || variant.root === 'max') &&
        variant.value?.kind === 'named' &&
        variant.value.value === token.utilitySuffix
      ) {
        return true
      }
    }

    if (
      token.namespace === 'container' &&
      variant.kind === 'functional' &&
      (variant.root === '@' || variant.root === '@min' || variant.root === '@max') &&
      variant.value?.kind === 'named' &&
      variant.value.value === token.utilitySuffix
    ) {
      return true
    }

    if (variant.kind === 'compound' && variantsUseToken([variant.variant], token)) return true
  }

  return false
}

function countExplicitVariableUses(options: {
  content: string
  rangesToSkip: StringChange[]
  tokens: TokenPair[]
  counts: Map<string, number>
}) {
  let { content, rangesToSkip, tokens, counts } = options

  for (let token of tokens) {
    let uses = findCssVariableNameChanges({
      content,
      fromVar: token.cssVar,
      toVar: token.cssVar,
      blockedRanges: rangesToSkip,
      skipCssStringsAndComments: false,
    })
    increment({ counts, variable: token.cssVar, amount: uses.length })
  }
}

function increment(options: { counts: Map<string, number>; variable: string; amount: number }) {
  let { counts, variable, amount } = options
  counts.set(variable, (counts.get(variable) ?? 0) + amount)
}
