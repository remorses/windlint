#!/usr/bin/env node
// windlint CLI: lint and rename CSS variables and design tokens across Tailwind CSS projects.

import { goke } from 'goke'
import pc from 'picocolors'
import { createRequire } from 'node:module'
import { countTokenUsage, formatTokenUsageTable } from './count.ts'
import { inlineToken } from './inline.ts'
import { formatLintResult, lint } from './lint.ts'
import { rename } from './rename.ts'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

const cli = goke('windlint')

cli
  .command('count', 'Count declared project CSS variables used in markup')
  .example('windlint count')
  .action(async (_options, { console, process }) => {
    let result = await countTokenUsage({ base: process.cwd })
    console.log(formatTokenUsageTable(result))
  })

cli
  .command('inline <token>', 'Inline a project token into direct Tailwind utilities')
  .option('--dry-run', 'Preview changes without writing files')
  .option('--verbose', 'Show every file and replacement')
  .option('--disable-approximation', 'Use arbitrary values like text-[3.5rem] instead of nearest Tailwind defaults')
  .example('windlint inline text-title-h1')
  .example('windlint inline color-brand')
  .example('windlint inline radius-card')
  .example('windlint inline text-title-h1 --disable-approximation')
  .action(async (token, options, { console, process }) => {
    console.error(pc.bold('windlint inline'))
    console.error()
    console.error(`  Inlining: ${pc.green(token)}`)
    console.error(`  Directory: ${pc.dim(process.cwd)}`)
    console.error()

    if (options.dryRun) {
      console.error(pc.yellow('  Dry run mode — no files will be modified'))
      console.error()
    }

    let result = await inlineToken({
      token,
      base: process.cwd,
      dryRun: options.dryRun,
      verbose: options.verbose,
      disableApproximation: options.disableApproximation,
    })

    console.error()
    if (result.filesChanged === 0) {
      console.error(pc.yellow('  No matches found.'))
    } else {
      console.error(
        pc.green(
          `  ✓ ${result.totalReplacements} replacement${result.totalReplacements === 1 ? '' : 's'} in ${result.filesChanged} file${result.filesChanged === 1 ? '' : 's'}`,
        ),
      )
    }

    if (options.dryRun && result.filesChanged > 0) {
      console.error()
      console.error(pc.dim('  Run without --dry-run to apply changes.'))
    }
  })

cli
  .command(
    'rename <from> <to>',
    'Rename a CSS variable/token across a Tailwind project. Use targets like color-primary/10 or color-white/[.16] to encode opacity in markup. Run commands sequentially, not in parallel, to prevent concurrent file writes.',
  )
  .option('--dry-run', 'Preview changes without writing files')
  .option('--verbose', 'Show every file and replacement')
  .example('windlint rename color-social-apple color-primary')
  .example('windlint rename --color-social-apple --color-primary')
  .example('windlint rename color-bg-strong-950 color-bg-strong')
  .example('windlint rename color-primary-alpha-10 color-primary/10')
  .example('windlint rename color-white-alpha-16 color-white/[.16]')
  .action(async (from, to, options, { console, process }) => {
    console.error(pc.bold('windlint rename'))
    console.error()
    console.error(`  Renaming: ${pc.red(from)} → ${pc.green(to)}`)
    console.error(`  Directory: ${pc.dim(process.cwd)}`)
    console.error()

    if (options.dryRun) {
      console.error(pc.yellow('  Dry run mode — no files will be modified'))
      console.error()
    }

    let result = await rename({
      from,
      to,
      base: process.cwd,
      dryRun: options.dryRun,
      verbose: options.verbose,
    })

    console.error()
    if (result.filesChanged === 0) {
      console.error(pc.yellow('  No matches found.'))
    } else {
      console.error(
        pc.green(
          `  ✓ ${result.totalReplacements} replacement${result.totalReplacements === 1 ? '' : 's'} in ${result.filesChanged} file${result.filesChanged === 1 ? '' : 's'}`,
        ),
      )
    }

    if (options.dryRun && result.filesChanged > 0) {
      console.error()
      console.error(pc.dim('  Run without --dry-run to apply changes.'))
    }
  })

cli
  .command('lint [...files]', 'Lint Tailwind CSS v4 classes and config variable references')
  .option('--fix', 'Apply auto-fixes')
  .option('--quiet', 'Only show errors, not warnings')
  .example('windlint lint')
  .example('windlint lint src/button.tsx globals.css --fix')
  .action(async (files, options, { console, process }) => {
    let result = await lint({
      base: process.cwd,
      files,
      fix: options.fix,
      quiet: options.quiet,
    })

    let output = formatLintResult(result)
    if (output) console.log(output)

    if (result.errorCount > 0) process.exit(1)
  })

cli.help()
cli.version(pkg.version)
cli.parse()
