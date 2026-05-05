// File discovery: finds all CSS and template files in a project directory.
// Respects .gitignore and skips node_modules.

import { globby } from 'globby'
import path from 'node:path'

export interface DiscoveredFiles {
  cssFiles: string[]
  templateFiles: string[]
}

const CSS_EXTENSIONS = ['css', 'scss', 'sass', 'less', 'pcss', 'postcss']
const TEMPLATE_EXTENSIONS = [
  'html',
  'htm',
  'jsx',
  'tsx',
  'js',
  'ts',
  'vue',
  'svelte',
  'astro',
  'mdx',
  'md',
  'php',
  'erb',
  'hbs',
  'ejs',
  'twig',
  'blade.php',
]

/**
 * Discover all relevant files in the project directory.
 */
export async function discoverFiles(base: string): Promise<DiscoveredFiles> {
  let cssGlobs = CSS_EXTENSIONS.map((ext) => `**/*.${ext}`)
  let templateGlobs = TEMPLATE_EXTENSIONS.map((ext) => `**/*.${ext}`)

  let [cssFiles, templateFiles] = await Promise.all([
    globby(cssGlobs, {
      cwd: base,
      absolute: true,
      gitignore: true,
      ignore: ['**/node_modules/**'],
    }),
    globby(templateGlobs, {
      cwd: base,
      absolute: true,
      gitignore: true,
      ignore: ['**/node_modules/**'],
    }),
  ])

  return { cssFiles, templateFiles }
}

/**
 * Get the file extension without the dot, handling compound extensions like .blade.php
 */
export function getExtension(filePath: string): string {
  let base = path.basename(filePath)
  // Handle compound extensions
  if (base.endsWith('.blade.php')) return 'blade.php'
  let ext = path.extname(filePath)
  return ext ? ext.slice(1) : ''
}
