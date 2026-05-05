// Tailwind design-system helpers: load project CSS once, then use Tailwind's
// native Theme entries as the source of truth for project theme variables.

import { __unstable__loadDesignSystem } from 'tailwindcss'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import { parse } from 'postcss'

const require = createRequire(import.meta.url)

export const defaultThemeCss = fs.readFileSync(require.resolve('tailwindcss/theme.css'), 'utf-8')

export type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>

export interface ThemeEntry {
  variable: string
  value: string
}

export interface CssVariableSource {
  file: string
  content: string
  value: string
  start: number
}

export async function loadProjectDesignSystem(cssFiles: string[]): Promise<DesignSystem> {
  let css = defaultThemeCss

  for (let file of cssFiles) {
    let content = await fsp.readFile(file, 'utf-8')
    css += '\n' + stripCssImports(content)
  }

  return __unstable__loadDesignSystem(css)
}

export function getProjectThemeEntries(designSystem: DesignSystem): ThemeEntry[] {
  let entries: ThemeEntry[] = []

  for (let [variable, entry] of designSystem.theme.entries()) {
    if (designSystem.theme.hasDefault(variable)) continue
    entries.push({ variable, value: entry.value })
  }

  return entries
}

export function getThemeValueMap(designSystem: DesignSystem): Map<string, string> {
  let values = new Map<string, string>()

  for (let [variable, entry] of designSystem.theme.entries()) {
    values.set(variable, entry.value)
  }

  return values
}

export function getThemeKeys(designSystem: DesignSystem): string[] {
  return [...designSystem.theme.entries()].map(([key]) => key)
}

export function getProjectThemeVariables(designSystem: DesignSystem): string[] {
  return getProjectThemeEntries(designSystem)
    .map((entry) => entry.variable)
    .sort()
}

export function getThemePrefixes(designSystem: DesignSystem): string[] {
  let prefixes = new Set<string>()

  for (let key of getThemeKeys(designSystem)) {
    let secondDash = key.indexOf('-', 2)
    if (secondDash !== -1) prefixes.add(key.slice(0, secondDash + 1))
  }

  return [...prefixes]
}

export function isProjectThemeVariable(designSystem: DesignSystem, variable: string): boolean {
  return designSystem.resolveThemeValue(variable) !== undefined && !designSystem.theme.hasDefault(variable)
}

export async function collectCustomPropertySources(cssFiles: string[]): Promise<Map<string, CssVariableSource>> {
  let sources = new Map<string, CssVariableSource>()

  for (let file of cssFiles) {
    let content = await fsp.readFile(file, 'utf-8')
    let root = parse(content, { from: undefined })

    root.walkDecls((declaration) => {
      if (!declaration.prop.startsWith('--')) return
      if (sources.has(declaration.prop)) return

      sources.set(declaration.prop, {
        file,
        content,
        value: declaration.value.trim(),
        start: declaration.source?.start?.offset ?? 0,
      })
    })

    root.walkAtRules('property', (atRule) => {
      let variable = atRule.params.trim()
      if (!variable.startsWith('--')) return
      if (sources.has(variable)) return

      sources.set(variable, {
        file,
        content,
        value: '',
        start: atRule.source?.start?.offset ?? 0,
      })
    })
  }

  return sources
}

function stripCssImports(content: string): string {
  let root = parse(content, { from: undefined })
  root.walkAtRules('import', (atRule) => {
    atRule.remove()
  })
  root.walkAtRules('apply', (atRule) => {
    atRule.remove()
  })
  root.walkAtRules('utility', (atRule) => {
    atRule.remove()
  })
  return root.toString()
}
