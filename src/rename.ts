// Main rename orchestration: coordinates CSS and template renaming across a project.

import fs from 'node:fs/promises'
import path from 'node:path'
import pc from 'picocolors'
import { renameCssVariables } from './css-rename.ts'
import { discoverFiles, getExtension } from './discover.ts'
import { renameTemplateTokens } from './template-rename.ts'
import { computeReplacements, parseToken, type TokenPair } from './token.ts'

export interface RenameOptions {
  /** Source token name (e.g. "color-social-apple" or "--color-social-apple") */
  from: string
  /** Target token name (e.g. "color-primary" or "--color-primary") */
  to: string
  /** Project directory to process */
  base: string
  /** Preview changes without writing */
  dryRun?: boolean
  /** Show every file and replacement */
  verbose?: boolean
}

export interface RenameResult {
  filesChanged: number
  totalReplacements: number
  changes: FileChange[]
}

export interface FileChange {
  file: string
  relativePath: string
  replacements: number
}

export async function rename(options: RenameOptions): Promise<RenameResult> {
  let { from, to, base, dryRun = false, verbose = false } = options

  let fromToken = parseToken(from)
  let toToken = parseToken(to)

  // Validate that both tokens have the same namespace
  if (fromToken.namespace && toToken.namespace && fromToken.namespace !== toToken.namespace) {
    // Different namespaces is fine, just means the utility prefix changes
  }

  let replacements = computeReplacements(fromToken, toToken)

  if (verbose) {
    console.error(pc.dim(`  CSS variable: ${replacements.cssVar.from} → ${replacements.cssVar.to}`))
    console.error(
      pc.dim(
        `  Utility suffix: ${replacements.utilitySuffix.from} → ${replacements.utilitySuffix.to}`,
      ),
    )
  }

  // Discover files
  let { cssFiles, templateFiles } = await discoverFiles(base)

  if (verbose) {
    console.error(pc.dim(`  Found ${cssFiles.length} CSS files, ${templateFiles.length} template files`))
  }

  let changes: FileChange[] = []

  // Process CSS files. Slash targets like `color-primary/10` are Tailwind
  // utility modifiers, not valid CSS variable names, so they are markup-only.
  if (!toToken.utilityModifier) {
    for (let file of cssFiles) {
      let content = await fs.readFile(file, 'utf-8')
      let renamed = renameCssVariables({ content, from: fromToken, to: toToken })

      if (renamed !== content) {
        let replacementCount = countDifferences({
          original: content,
          modified: renamed,
          searchTerm: fromToken.cssVar,
        })
        let relativePath = path.relative(base, file)
        changes.push({ file, relativePath, replacements: replacementCount })

        if (!dryRun) {
          await fs.writeFile(file, renamed, 'utf-8')
        }

        if (verbose) {
          console.error(
            `  ${pc.green('✓')} ${relativePath} (${replacementCount} replacement${replacementCount === 1 ? '' : 's'})`,
          )
        }
      }
    }
  }

  // Process template files
  for (let file of templateFiles) {
    let content = await fs.readFile(file, 'utf-8')
    let extension = getExtension(file)
    let renamed = await renameTemplateTokens({ content, extension, from: fromToken, to: toToken })

    if (renamed !== content) {
      let replacementCount = countStringOccurrences(renamed, toToken.utilitySuffix) -
        countStringOccurrences(content, toToken.utilitySuffix) +
        countStringOccurrences(content, fromToken.utilitySuffix) -
        countStringOccurrences(renamed, fromToken.utilitySuffix)

      // Fallback: just count how many chars differ
      if (replacementCount <= 0) {
        replacementCount = 1
      }

      let relativePath = path.relative(base, file)
      changes.push({ file, relativePath, replacements: replacementCount })

      if (!dryRun) {
        await fs.writeFile(file, renamed, 'utf-8')
      }

      if (verbose) {
        console.error(
          `  ${pc.green('✓')} ${relativePath} (${replacementCount} replacement${replacementCount === 1 ? '' : 's'})`,
        )
      }
    }
  }

  let totalReplacements = changes.reduce((sum, c) => sum + c.replacements, 0)

  return {
    filesChanged: changes.length,
    totalReplacements,
    changes,
  }
}

function countDifferences(options: {
  original: string
  modified: string
  searchTerm: string
}): number {
  let { original, modified, searchTerm } = options
  let originalCount = countStringOccurrences(original, searchTerm)
  let modifiedCount = countStringOccurrences(modified, searchTerm)
  return originalCount - modifiedCount
}

function countStringOccurrences(str: string, search: string): number {
  let count = 0
  let pos = 0
  while ((pos = str.indexOf(search, pos)) !== -1) {
    count++
    pos += search.length
  }
  return count
}
