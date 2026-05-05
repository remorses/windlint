#!/usr/bin/env node
// css-rename CLI: rename CSS variables and design tokens across Tailwind CSS projects.

import { goke } from 'goke'
import pc from 'picocolors'
import { createRequire } from 'node:module'
import path from 'node:path'
import { rename } from './rename.ts'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }

const cli = goke('css-rename')

cli
  .command('<from> <to> [path]', 'Rename a CSS variable/token across a Tailwind project')
  .option('--dry-run', 'Preview changes without writing files')
  .option('--verbose', 'Show every file and replacement')
  .example('css-rename color-social-apple color-primary ./my-project')
  .example('css-rename --color-social-apple --color-primary')
  .example('css-rename color-bg-strong-950 color-bg-strong .')
  .action(async (from, to, targetPath, options, { console, process }) => {
    let base = targetPath ? path.resolve(process.cwd, targetPath) : process.cwd

    console.error(pc.bold('css-rename'))
    console.error()
    console.error(`  Renaming: ${pc.red(from)} → ${pc.green(to)}`)
    console.error(`  Directory: ${pc.dim(base)}`)
    console.error()

    if (options.dryRun) {
      console.error(pc.yellow('  Dry run mode — no files will be modified'))
      console.error()
    }

    let result = await rename({
      from,
      to,
      base,
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
