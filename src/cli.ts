#!/usr/bin/env node
// css-rename CLI: rename CSS variables and design tokens across Tailwind CSS projects.

import { goke } from 'goke'
import pc from 'picocolors'
import { createRequire } from 'node:module'
import { countTokenUsage, formatTokenUsageTable } from './count.ts'
import { rename } from './rename.ts'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

const cli = goke('css-rename')

cli
  .command('count', 'Count declared project CSS variables used in markup')
  .example('css-rename count')
  .action(async (_options, { console, process }) => {
    let result = await countTokenUsage({ base: process.cwd })
    console.log(formatTokenUsageTable(result))
  })

cli
  .command(
    '<from> <to>',
    'Rename a CSS variable/token across a Tailwind project. Use targets like color-primary/10 to encode opacity in markup.',
  )
  .option('--dry-run', 'Preview changes without writing files')
  .option('--verbose', 'Show every file and replacement')
  .example('css-rename color-social-apple color-primary')
  .example('css-rename --color-social-apple --color-primary')
  .example('css-rename color-bg-strong-950 color-bg-strong')
  .example('css-rename color-primary-alpha-10 color-primary/10')
  .action(async (from, to, options, { console, process }) => {
    console.error(pc.bold('css-rename'))
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

cli.help()
cli.version(pkg.version)
cli.parse()
