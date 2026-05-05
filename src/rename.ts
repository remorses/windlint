// Main rename orchestration: coordinates CSS and template renaming across a project.

import fs from 'node:fs/promises'
import path from 'node:path'
import pc from 'picocolors'
import { renameApplyDirectives, renameCssVariables } from './css-rename.ts'
import { discoverFiles, getExtension } from './discover.ts'
import { inlineToken } from './inline.ts'
import { renameTemplateTokens } from './template-rename.ts'
import { computeReplacements, parseToken, type TokenPair } from './token.ts'

/**
 * Write file atomically: write to a temp file in the same directory, then rename.
 * This prevents data loss if the process crashes mid-write (OOM, SIGKILL, disk full).
 * rename(2) on the same filesystem is atomic on POSIX.
 */
async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  let tmpPath = filePath + '.windlint-tmp'
  await fs.writeFile(tmpPath, content, 'utf-8')
  await fs.rename(tmpPath, filePath)
}

export interface RenameOptions {
  /** Source token name (e.g. "color-social-apple" or "--color-social-apple") */
  from: string
  /** Target token name (e.g. "color-primary" or "--color-primary") */
  to?: string
  /** Project directory to process */
  base: string
  /** Preview changes without writing */
  dryRun?: boolean
  /** Show every file and replacement */
  verbose?: boolean
  /** Inline the source token into direct Tailwind utilities instead of renaming to another token. */
  inline?: boolean
  /** Use arbitrary values like text-[3.5rem] instead of nearest Tailwind defaults in inline mode. */
  disableApproximation?: boolean
  /** Include --text-token--line-height as a leading-* utility in inline mode. */
  withLeading?: boolean
  /** Include --text-token--letter-spacing as a tracking-* utility in inline mode. */
  withTracking?: boolean
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

  if (options.inline) {
    if (to) throw new Error('Do not pass a target token when using --inline.')
    return inlineToken({
      token: from,
      base,
      dryRun,
      verbose,
      disableApproximation: options.disableApproximation,
      withLeading: options.withLeading,
      withTracking: options.withTracking,
    })
  }

  if (!to) throw new Error('Missing target token. Pass <to> or use --inline.')

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

  // Process CSS files: rename variable declarations/references AND utility
  // classes inside @apply directives. Slash targets like `color-primary/10` are
  // Tailwind utility modifiers, not valid CSS variable names, so CSS variable
  // renaming is skipped for them — but @apply still needs processing.
  for (let file of cssFiles) {
    let content = await fs.readFile(file, 'utf-8')
    if (!mightContainCssToken({ content, token: fromToken, to: toToken })) continue

    let renamed = content

    // Rename CSS variable declarations and var() references (skip for slash targets)
    if (!toToken.utilityModifier) {
      renamed = renameCssVariables({ content: renamed, from: fromToken, to: toToken })
    }

    // Rename utility classes inside @apply directives
    renamed = renameApplyDirectives({ content: renamed, from: fromToken, to: toToken })

    if (renamed !== content) {
      let replacementCount = countDifferences({
        original: content,
        modified: renamed,
        searchTerm: fromToken.cssVar,
      })
      // Also count utility suffix changes (for @apply renames)
      if (replacementCount <= 0 && fromToken.utilitySuffix) {
        replacementCount = countDifferences({
          original: content,
          modified: renamed,
          searchTerm: fromToken.utilitySuffix,
        })
      }
      if (replacementCount <= 0) replacementCount = 1

      let relativePath = path.relative(base, file)
      changes.push({ file, relativePath, replacements: replacementCount })

      if (!dryRun) {
        await atomicWriteFile(file, renamed)
      }

      if (verbose) {
        console.error(
          `  ${pc.green('✓')} ${relativePath} (${replacementCount} replacement${replacementCount === 1 ? '' : 's'})`,
        )
      }
    }
  }

  // Process template files
  for (let file of templateFiles) {
    let content = await fs.readFile(file, 'utf-8')
    if (!mightContainTemplateToken({ content, token: fromToken })) continue

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
        await atomicWriteFile(file, renamed)
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

function mightContainTemplateToken(options: { content: string; token: TokenPair }): boolean {
  let { content, token } = options
  return content.includes(token.cssVar) ||
    (token.utilitySuffix !== '' && content.includes(token.utilitySuffix))
}

function mightContainCssToken(options: { content: string; token: TokenPair; to: TokenPair }): boolean {
  let { content, token, to } = options
  // Check for CSS variable references
  if (content.includes(token.cssVar)) return true
  // Check for utility suffix (for @apply directives)
  if (token.utilitySuffix !== '' && content.includes(token.utilitySuffix)) return true
  // For duplicate detection: check if target already exists
  if (content.includes(to.cssVar)) return true
  return false
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
