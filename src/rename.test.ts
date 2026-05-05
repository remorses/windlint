// Tests for windlint rename: copies fixture projects to tmp, runs rename, snapshots the diff.

import { describe, test, expect, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { rename } from './rename.ts'
import { renameCssVariables, renameApplyDirectives } from './css-rename.ts'
import { renameTemplateTokens } from './template-rename.ts'
import { parseToken } from './token.ts'
import { countTokenUsage, formatTokenUsageTable } from './count.ts'
import { execSync } from 'node:child_process'

const FIXTURES_DIR = path.resolve(import.meta.dirname, 'fixtures')
const TMP_DIR = path.join(os.tmpdir(), 'windlint-tests')

async function copyFixture(fixtureName: string): Promise<string> {
  let src = path.join(FIXTURES_DIR, fixtureName)
  let dest = path.join(TMP_DIR, `${fixtureName}-${Date.now()}`)
  await fs.cp(src, dest, { recursive: true })
  return dest
}

async function getDiff(dir: string): Promise<string> {
  // Initialize git, commit original, then show working tree diff
  execSync('git init && git add -A && git commit -m "initial" --allow-empty', {
    cwd: dir,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test.com' },
  })
  return '' // We'll get the diff after rename
}

async function getDiffAfterRename(dir: string): Promise<string> {
  try {
    let diff = execSync('git diff --no-color', {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    return diff
  } catch {
    return ''
  }
}

describe('parseToken', () => {
  test('parses color token with namespace', () => {
    let token = parseToken('color-social-apple')
    expect(token).toMatchInlineSnapshot(`
      {
        "cssVar": "--color-social-apple",
        "cssVarName": "color-social-apple",
        "namespace": "color",
        "utilitySuffix": "social-apple",
      }
    `)
  })

  test('parses token with -- prefix', () => {
    let token = parseToken('--color-primary')
    expect(token).toMatchInlineSnapshot(`
      {
        "cssVar": "--color-primary",
        "cssVarName": "color-primary",
        "namespace": "color",
        "utilitySuffix": "primary",
      }
    `)
  })

  test('parses shadow namespace', () => {
    let token = parseToken('shadow-button-focus')
    expect(token).toMatchInlineSnapshot(`
      {
        "cssVar": "--shadow-button-focus",
        "cssVarName": "shadow-button-focus",
        "namespace": "shadow",
        "utilitySuffix": "button-focus",
      }
    `)
  })

  test('parses slash utility modifier target', () => {
    let token = parseToken('color-primary/10')
    expect(token).toMatchInlineSnapshot(`
      {
        "cssVar": "--color-primary",
        "cssVarName": "color-primary",
        "namespace": "color",
        "utilityModifier": "10",
        "utilitySuffix": "primary",
      }
    `)
  })

  test('parses arbitrary bracket modifier target like color-white/[.16]', () => {
    let token = parseToken('color-white/[.16]')
    expect(token).toMatchInlineSnapshot(`
      {
        "cssVar": "--color-white",
        "cssVarName": "color-white",
        "namespace": "color",
        "utilityModifier": "[.16]",
        "utilitySuffix": "white",
      }
    `)
  })
})

describe('renameCssVariables', () => {
  let from = parseToken('color-social-apple')
  let to = parseToken('color-brand-apple')

  test('renames declarations', () => {
    let input = `@theme {\n  --color-social-apple: #000000;\n}`
    let result = renameCssVariables({ content: input, from, to })
    expect(result).toMatchInlineSnapshot(`
      "@theme {
        --color-brand-apple: #000000;
      }"
    `)
  })

  test('renames var() references', () => {
    let input = `color: var(--color-social-apple);`
    let result = renameCssVariables({ content: input, from, to })
    expect(result).toMatchInlineSnapshot(`"color: var(--color-brand-apple);"`)
  })

  test('renames var() with fallback', () => {
    let input = `color: var(--color-social-apple, #000);`
    let result = renameCssVariables({ content: input, from, to })
    expect(result).toMatchInlineSnapshot(`"color: var(--color-brand-apple, #000);"`)
  })

  test('does not rename partial matches', () => {
    let input = `--color-social-apple-pie: #000;\n--color-social-apple: #111;`
    let result = renameCssVariables({ content: input, from, to })
    expect(result).toMatchInlineSnapshot(`
      "--color-social-apple-pie: #000;
      --color-brand-apple: #111;"
    `)
  })

  test('renames multiple occurrences', () => {
    let input = `--color-social-apple: #000;\nbox-shadow: 0 0 0 2px var(--color-social-apple);`
    let result = renameCssVariables({ content: input, from, to })
    expect(result).toMatchInlineSnapshot(`
      "--color-brand-apple: #000;
      box-shadow: 0 0 0 2px var(--color-brand-apple);"
    `)
  })

  test('does not rename CSS comments or strings', () => {
    let input = `/* var(--color-social-apple) */\n.demo::before { content: "--color-social-apple"; color: var(--color-social-apple); }`
    let result = renameCssVariables({ content: input, from, to })
    expect(result).toMatchInlineSnapshot(
      `"/* var(--color-social-apple) */\n.demo::before { content: \"--color-social-apple\"; color: var(--color-brand-apple); }"`,
    )
  })
})

describe('renameTemplateTokens', () => {
  let from = parseToken('color-social-apple')
  let to = parseToken('color-brand-apple')

  test('renames utility classes in HTML', async () => {
    let input = `<div class="text-social-apple bg-social-apple">`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(`"<div class="text-brand-apple bg-brand-apple">"`)
  })

  test('renames with variant prefixes', async () => {
    let input = `<div class="hover:text-social-apple dark:bg-social-apple">`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(
      `"<div class="hover:text-brand-apple dark:bg-brand-apple">"`,
    )
  })

  test('renames with opacity modifier', async () => {
    let input = `<div class="text-social-apple/50 bg-social-apple/80">`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(
      `"<div class="text-brand-apple/50 bg-brand-apple/80">"`,
    )
  })

  test('renames to slash opacity modifier when target includes /n', async () => {
    let input = `<div class="text-primary-alpha-10 hover:bg-primary-alpha-10 border-primary-alpha-10">`
    let result = await renameTemplateTokens({
      content: input,
      extension: 'html',
      from: parseToken('color-primary-alpha-10'),
      to: parseToken('color-primary/10'),
    })
    expect(result).toMatchInlineSnapshot(
      `"<div class="text-primary/10 hover:bg-primary/10 border-primary/10">"`,
    )
  })

  test('renames arbitrary var candidates to slash opacity utilities', async () => {
    let input = `<div class="bg-[var(--color-primary-alpha-10)] text-[var(--color-primary-alpha-10)]">`
    let result = await renameTemplateTokens({
      content: input,
      extension: 'html',
      from: parseToken('color-primary-alpha-10'),
      to: parseToken('color-primary/10'),
    })
    expect(result).toMatchInlineSnapshot(
      `"<div class="bg-primary/10 text-primary/10">"`,
    )
  })

  test('renames alpha token to arbitrary bracket modifier like color-white/[.16]', async () => {
    let input = `<div class="text-white-alpha-16 hover:bg-white-alpha-16 border-white-alpha-16">`
    let result = await renameTemplateTokens({
      content: input,
      extension: 'html',
      from: parseToken('color-white-alpha-16'),
      to: parseToken('color-white/[.16]'),
    })
    expect(result).toMatchInlineSnapshot(
      `"<div class="text-white/[.16] hover:bg-white/[.16] border-white/[.16]">"`,
    )
  })

  test('renames arbitrary var() to bracket modifier like color-white/[.16]', async () => {
    let input = `<div class="bg-[var(--color-white-alpha-16)] text-[var(--color-white-alpha-16)]">`
    let result = await renameTemplateTokens({
      content: input,
      extension: 'html',
      from: parseToken('color-white-alpha-16'),
      to: parseToken('color-white/[.16]'),
    })
    expect(result).toMatchInlineSnapshot(
      `"<div class="bg-white/[.16] text-white/[.16]">"`,
    )
  })

  test('renames in JSX className', async () => {
    let input = `<button className='text-social-apple hover:bg-social-apple/5'>`
    let result = await renameTemplateTokens({ content: input, extension: 'tsx', from, to })
    expect(result).toMatchInlineSnapshot(
      `"<button className='text-brand-apple hover:bg-brand-apple/5'>"`,
    )
  })

  test('renames var() in arbitrary values', async () => {
    let input = `<div class="text-[var(--color-social-apple)]">`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(`"<div class="text-(--color-brand-apple)">"`)
  })

  test('does not rename other brands', async () => {
    let input = `<div class="text-social-apple text-social-twitter">`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(`"<div class="text-brand-apple text-social-twitter">"`)
  })

  test('does not rename unrelated utilities with the same suffix', async () => {
    let input = `<div class="text-social-apple bg-social-apple rounded-social-apple font-social-apple animate-social-apple">`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(
      `"<div class="text-brand-apple bg-brand-apple rounded-social-apple font-social-apple animate-social-apple">"`,
    )
  })

  test('renames spacing utilities without touching color utilities', async () => {
    let result = await renameTemplateTokens({
      content: `<div class="p-card -mt-card gap-card text-card rounded-card">`,
      extension: 'html',
      from: parseToken('spacing-card'),
      to: parseToken('spacing-panel'),
    })
    expect(result).toMatchInlineSnapshot(
      `"<div class="p-panel -mt-panel gap-panel text-card rounded-card">"`,
    )
  })

  test('renames breakpoint variants', async () => {
    let result = await renameTemplateTokens({
      content: `<div class="md:text-social-apple max-md:bg-social-apple min-md:border-social-apple hover:text-social-apple bg-[url(foo:md:bar)]">`,
      extension: 'html',
      from: parseToken('breakpoint-md'),
      to: parseToken('breakpoint-tablet'),
    })
    expect(result).toMatchInlineSnapshot(
      `"<div class="tablet:text-social-apple max-tablet:bg-social-apple min-tablet:border-social-apple hover:text-social-apple bg-[url(foo:md:bar)]">"`,
    )
  })

  test('renames container variants', async () => {
    let result = await renameTemplateTokens({
      content: `<div class="@sidebar:grid @max-sidebar:flex @min-sidebar:block">`,
      extension: 'html',
      from: parseToken('container-sidebar'),
      to: parseToken('container-panel'),
    })
    expect(result).toMatchInlineSnapshot(
      `"<div class="@panel:grid @max-panel:flex @min-panel:block">"`,
    )
  })

  test('variant-only rename does not canonicalize unrelated arbitrary utilities', async () => {
    let result = await renameTemplateTokens({
      content: `<div class="md:[display:flex] md:[color:var(--color-red-500)]">`,
      extension: 'html',
      from: parseToken('breakpoint-md'),
      to: parseToken('breakpoint-tablet'),
    })
    expect(result).toMatchInlineSnapshot(
      `"<div class="tablet:[display:flex] tablet:[color:var(--color-red-500)]">"`,
    )
  })

  test('renames custom token to a built-in Tailwind color (no leftover var/--)', async () => {
    // When the target is a built-in like pink-500, utility classes should just use the
    // built-in utility suffix directly, no var() or -- should remain in the class name.
    let from = parseToken('color-highlighted-base')
    let to = parseToken('color-pink-500')

    let input = `<div class="text-highlighted-base bg-highlighted-base hover:text-highlighted-base/50 border-highlighted-base">`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(`"<div class="text-pink-500 bg-pink-500 hover:text-pink-500/50 border-pink-500">"`)
  })

  test('renames arbitrary var() to built-in Tailwind color utility', async () => {
    let from = parseToken('color-highlighted-base')
    let to = parseToken('color-pink-500')

    let input = `<div class="text-[var(--color-highlighted-base)] bg-[var(--color-highlighted-base)]">`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(`"<div class="text-pink-500 bg-pink-500">"`)
  })

  test('renames custom token to built-in in CSS (declaration + var refs)', async () => {
    let from = parseToken('color-highlighted-base')
    let to = parseToken('color-pink-500')

    let input = `@theme {\n  --color-highlighted-base: #ff69b4;\n}\n\n.card {\n  color: var(--color-highlighted-base);\n  border-color: var(--color-highlighted-base, #000);\n}`
    let result = renameCssVariables({ content: input, from, to })
    expect(result).toMatchInlineSnapshot(`
      "@theme {
        --color-pink-500: #ff69b4;
      }

      .card {
        color: var(--color-pink-500);
        border-color: var(--color-pink-500, #000);
      }"
    `)
  })
})

describe('full project rename', () => {
  test('renames color-social-apple to color-brand-apple across project', async () => {
    let dir = await copyFixture('basic-project')
    await getDiff(dir) // init git for diffing

    let result = await rename({
      from: 'color-social-apple',
      to: 'color-brand-apple',
      base: dir,
      verbose: false,
    })

    expect(result.filesChanged).toBeGreaterThan(0)
    expect(result.totalReplacements).toBeGreaterThan(0)

    let diff = await getDiffAfterRename(dir)
    expect(diff).toMatchInlineSnapshot(`
      "diff --git a/button.tsx b/button.tsx
      index e4fbc1f..cbeb3d0 100644
      --- a/button.tsx
      +++ b/button.tsx
      @@ -3,7 +3,7 @@ import React from 'react'
       export function SocialButton({ brand }: { brand: string }) {
         return (
           <button
      -      className='flex items-center gap-2 rounded-lg px-4 py-2 text-social-apple bg-bg-white-0 hover:bg-bg-weak-50'
      +      className='flex items-center gap-2 rounded-lg px-4 py-2 text-brand-apple bg-bg-white-0 hover:bg-bg-weak-50'
           >
             <span className='text-sm font-medium'>Continue with Apple</span>
           </button>
      @@ -13,7 +13,7 @@ export function SocialButton({ brand }: { brand: string }) {
       export function SocialButtonFilled() {
         return (
           <button
      -      className='flex items-center gap-2 rounded-lg px-4 py-2 bg-social-apple text-white hover:bg-social-apple/90'
      +      className='flex items-center gap-2 rounded-lg px-4 py-2 bg-brand-apple text-white hover:bg-brand-apple/90'
           >
             <span className='text-sm font-medium'>Sign in with Apple</span>
           </button>
      @@ -23,7 +23,7 @@ export function SocialButtonFilled() {
       export function SocialButtonWithVariants() {
         return (
           <div>
      -      <button className='dark:text-social-apple focus:ring-social-apple border-social-apple'>
      +      <button className='dark:text-brand-apple focus:ring-brand-apple border-brand-apple'>
               Apple Button
             </button>
             <button className='text-social-twitter bg-social-twitter'>
      diff --git a/globals.css b/globals.css
      index 0316114..092e940 100644
      --- a/globals.css
      +++ b/globals.css
      @@ -8,7 +8,7 @@
         --color-orange-700: #c2410c;
       
         /* Social Colors */
      -  --color-social-apple: #000000;
      +  --color-brand-apple: #000000;
         --color-social-twitter: #010101;
         --color-social-github: #24292f;
       
      @@ -22,11 +22,11 @@
         --color-primary-darker: var(--color-orange-700);
       
         /* Shadows using tokens */
      -  --shadow-button-focus: 0 0 0 2px var(--color-bg-white-0), 0 0 0 4px var(--color-social-apple);
      +  --shadow-button-focus: 0 0 0 2px var(--color-bg-white-0), 0 0 0 4px var(--color-brand-apple);
       }
       
       .dark {
      -  --color-social-apple: #ffffff;
      +  --color-brand-apple: #ffffff;
         --color-social-twitter: #ffffff;
         --color-bg-strong-950: var(--color-neutral-0);
       }
      diff --git a/page.html b/page.html
      index 2739088..2c5b5d9 100644
      --- a/page.html
      +++ b/page.html
      @@ -5,15 +5,15 @@
       </head>
       <body>
         <div class="flex flex-col gap-4 p-8">
      -    <button class="text-social-apple bg-white hover:text-social-apple/80 rounded-lg px-4 py-2">
      +    <button class="text-brand-apple bg-white hover:text-brand-apple/80 rounded-lg px-4 py-2">
             Apple Login
           </button>
       
      -    <button class="bg-social-apple text-white rounded-lg px-4 py-2">
      +    <button class="bg-brand-apple text-white rounded-lg px-4 py-2">
             Apple Login Filled
           </button>
       
      -    <div class="border-social-apple ring-social-apple shadow-button-focus">
      +    <div class="border-brand-apple ring-brand-apple shadow-button-focus">
             Outlined section
           </div>
       
      @@ -23,7 +23,7 @@
           </button>
       
           <!-- Arbitrary value with var -->
      -    <div class="text-[var(--color-social-apple)] bg-[var(--color-social-apple)]">
      +    <div class="text-(--color-brand-apple) bg-(--color-brand-apple)">
             Arbitrary values
           </div>
         </div>
      diff --git a/variants.tsx b/variants.tsx
      index af5be39..2e0cbd0 100644
      --- a/variants.tsx
      +++ b/variants.tsx
      @@ -12,12 +12,12 @@ export const socialButtonVariants = tv({
           {
             brand: 'apple',
             mode: 'stroke',
      -      class: 'text-social-apple hover:bg-social-apple/5',
      +      class: 'text-brand-apple hover:bg-brand-apple/5',
           },
           {
             brand: 'apple',
             mode: 'filled',
      -      class: 'bg-social-apple hover:bg-social-apple/90',
      +      class: 'bg-brand-apple hover:bg-brand-apple/90',
           },
           {
             brand: 'twitter',
      @@ -29,7 +29,7 @@ export const socialButtonVariants = tv({
       
       export function InlineStyleExample() {
         return (
      -    <div style={{ color: 'var(--color-social-apple)' }}>
      +    <div style={{ color: 'var(--color-brand-apple)' }}>
             Inline style with var reference
           </div>
         )
      "
    `)

    // Verify no instances of the old token remain
    for (let change of result.changes) {
      let content = await fs.readFile(change.file, 'utf-8')
      expect(content).not.toContain('--color-social-apple')
      expect(content).not.toContain('text-social-apple')
      expect(content).not.toContain('bg-social-apple')
    }
  })

  test('dry run does not modify files', async () => {
    let dir = await copyFixture('basic-project')

    let globalsCssBefore = await fs.readFile(path.join(dir, 'globals.css'), 'utf-8')

    let result = await rename({
      from: 'color-social-apple',
      to: 'color-brand-apple',
      base: dir,
      dryRun: true,
    })

    expect(result.filesChanged).toBeGreaterThan(0)

    let globalsCssAfter = await fs.readFile(path.join(dir, 'globals.css'), 'utf-8')
    expect(globalsCssAfter).toBe(globalsCssBefore)
  })

  test('ignores generated and internal folders', async () => {
    let dir = path.join(TMP_DIR, `ignored-folders-project-${Date.now()}`)
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true })
    await fs.mkdir(path.join(dir, '.git'), { recursive: true })
    await fs.mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(dir, 'globals.css'), `@theme { --color-social-apple: #000; }`)
    await fs.writeFile(path.join(dir, 'index.html'), `<div class="text-social-apple"></div>`)

    let ignoredCss = `@theme { --color-social-apple: #fff; }`
    let ignoredHtml = `<div class="text-social-apple"></div>`
    await fs.writeFile(path.join(dir, 'dist', 'bundle.css'), ignoredCss)
    await fs.writeFile(path.join(dir, '.git', 'snapshot.html'), ignoredHtml)
    await fs.writeFile(path.join(dir, 'node_modules', 'pkg', 'index.html'), ignoredHtml)

    await rename({
      from: 'color-social-apple',
      to: 'color-brand-apple',
      base: dir,
    })

    await expect(fs.readFile(path.join(dir, 'globals.css'), 'utf-8')).resolves.toMatchInlineSnapshot(
      `"@theme { --color-brand-apple: #000; }"`,
    )
    await expect(fs.readFile(path.join(dir, 'index.html'), 'utf-8')).resolves.toMatchInlineSnapshot(
      `"<div class=\"text-brand-apple\"></div>"`,
    )
    await expect(fs.readFile(path.join(dir, 'dist', 'bundle.css'), 'utf-8')).resolves.toBe(ignoredCss)
    await expect(fs.readFile(path.join(dir, '.git', 'snapshot.html'), 'utf-8')).resolves.toBe(ignoredHtml)
    await expect(fs.readFile(path.join(dir, 'node_modules', 'pkg', 'index.html'), 'utf-8')).resolves.toBe(ignoredHtml)
  })

  test('slash opacity targets only rewrite markup', async () => {
    let dir = path.join(TMP_DIR, `opacity-target-project-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'globals.css'), `@theme {\n  --color-primary-alpha-10: #000;\n}`)
    await fs.writeFile(
      path.join(dir, 'index.html'),
      `<div class="bg-primary-alpha-10 text-[var(--color-primary-alpha-10)]" style="color: var(--color-primary-alpha-10)"></div>`,
    )

    await rename({
      from: 'color-primary-alpha-10',
      to: 'color-primary/10',
      base: dir,
    })

    await expect(fs.readFile(path.join(dir, 'globals.css'), 'utf-8')).resolves.toMatchInlineSnapshot(`
      "@theme {
        --color-primary-alpha-10: #000;
      }"
    `)
    await expect(fs.readFile(path.join(dir, 'index.html'), 'utf-8')).resolves.toMatchInlineSnapshot(
      `"<div class="bg-primary/10 text-primary/10" style="color: color-mix(in srgb, var(--color-primary) 10%, transparent)"></div>"`,
    )
  })

  test('bracket arbitrary modifier targets like color-white/[.16] rewrite markup', async () => {
    let dir = path.join(TMP_DIR, `bracket-modifier-project-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'globals.css'), `@theme {\n  --color-white-alpha-16: rgba(255,255,255,.16);\n}`)
    await fs.writeFile(
      path.join(dir, 'index.html'),
      `<div class="bg-white-alpha-16 text-[var(--color-white-alpha-16)] hover:border-white-alpha-16" style="color: var(--color-white-alpha-16)"></div>`,
    )

    await rename({
      from: 'color-white-alpha-16',
      to: 'color-white/[.16]',
      base: dir,
    })

    // CSS should NOT be modified (slash targets are markup-only)
    await expect(fs.readFile(path.join(dir, 'globals.css'), 'utf-8')).resolves.toMatchInlineSnapshot(`
      "@theme {
        --color-white-alpha-16: rgba(255,255,255,.16);
      }"
    `)
    // Markup should be rewritten to use the bracket modifier, and var() in inline
    // styles should become color-mix() since the variable is an opacity target
    await expect(fs.readFile(path.join(dir, 'index.html'), 'utf-8')).resolves.toMatchInlineSnapshot(
      `"<div class="bg-white/[.16] text-white/[.16] hover:border-white/[.16]" style="color: color-mix(in srgb, var(--color-white) 16%, transparent)"></div>"`,
    )
  })
})

describe('renameApplyDirectives — @apply directives (#3)', () => {
  test('renames utility classes inside @apply in CSS', () => {
    let from = parseToken('color-text-strong-950')
    let to = parseToken('color-foreground')
    let input = `.card {\n  @apply text-text-strong-950 bg-white;\n}`
    let result = renameApplyDirectives({ content: input, from, to })
    expect(result).toMatchInlineSnapshot(`
      ".card {
        @apply text-foreground bg-white;
      }"
    `)
  })

  test('renames @apply with variants in CSS', () => {
    let from = parseToken('color-text-strong-950')
    let to = parseToken('color-foreground')
    let input = `.card {\n  @apply hover:text-text-strong-950 dark:text-text-strong-950;\n}`
    let result = renameApplyDirectives({ content: input, from, to })
    expect(result).toMatchInlineSnapshot(`
      ".card {
        @apply hover:text-foreground dark:text-foreground;
      }"
    `)
  })

  test('full project rename catches @apply in CSS files', async () => {
    let dir = path.join(TMP_DIR, `apply-project-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'globals.css'),
      `@theme {\n  --color-text-strong-950: #000;\n}\n\n.heading {\n  @apply text-text-strong-950;\n}`,
    )
    await fs.writeFile(
      path.join(dir, 'index.html'),
      `<div class="text-text-strong-950">hello</div>`,
    )

    await rename({ from: 'color-text-strong-950', to: 'color-foreground', base: dir })

    await expect(fs.readFile(path.join(dir, 'globals.css'), 'utf-8')).resolves.toMatchInlineSnapshot(`
      "@theme {
        --color-foreground: #000;
      }

      .heading {
        @apply text-foreground;
      }"
    `)
    await expect(fs.readFile(path.join(dir, 'index.html'), 'utf-8')).resolves.toMatchInlineSnapshot(
      `"<div class="text-foreground">hello</div>"`,
    )
  })
})

describe('var() in inline styles with opacity targets (#4, #5)', () => {
  test('opacity target converts var() in inline styles to color-mix()', async () => {
    let from = parseToken('color-primary-alpha-10')
    let to = parseToken('color-primary/10')
    let input = `<div style="color: var(--color-primary-alpha-10)">hello</div>`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(
      `"<div style="color: color-mix(in srgb, var(--color-primary) 10%, transparent)">hello</div>"`,
    )
  })

  test('bracket modifier converts var() to color-mix() with correct percentage', async () => {
    let from = parseToken('color-white-alpha-16')
    let to = parseToken('color-white/[.16]')
    let input = `<svg fill="var(--color-white-alpha-16)"></svg>`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(
      `"<svg fill="color-mix(in srgb, var(--color-white) 16%, transparent)"></svg>"`,
    )
  })

  test('opacity target converts var() in JSX props to color-mix()', async () => {
    let from = parseToken('color-orange-alpha-10')
    let to = parseToken('color-orange/10')
    let input = `<Icon fill="var(--color-orange-alpha-10)" stroke="var(--color-orange-alpha-10)" />`
    let result = await renameTemplateTokens({ content: input, extension: 'tsx', from, to })
    expect(result).toMatchInlineSnapshot(
      `"<Icon fill="color-mix(in srgb, var(--color-orange) 10%, transparent)" stroke="color-mix(in srgb, var(--color-orange) 10%, transparent)" />"`,
    )
  })

  test('opacity target does not touch var() refs that are already inside candidate ranges', async () => {
    // var() inside a Tailwind arbitrary value is handled by the candidate logic, not the fallback
    let from = parseToken('color-primary-alpha-10')
    let to = parseToken('color-primary/10')
    let input = `<div class="bg-[var(--color-primary-alpha-10)]">hello</div>`
    let result = await renameTemplateTokens({ content: input, extension: 'html', from, to })
    expect(result).toMatchInlineSnapshot(`"<div class="bg-primary/10">hello</div>"`)
  })
})

describe('self-referencing variable definitions (#6)', () => {
  test('removes declaration that would become circular', () => {
    let input = `@theme {\n  --color-yellow-500: #eab308;\n  --color-away-base: var(--color-yellow-500);\n}`
    let result = renameCssVariables({
      content: input,
      from: parseToken('color-away-base'),
      to: parseToken('color-yellow-500'),
    })
    // --color-away-base: var(--color-yellow-500) would become --color-yellow-500: var(--color-yellow-500)
    // which is circular, so the declaration is removed entirely
    expect(result).toMatchInlineSnapshot(`
      "@theme {
        --color-yellow-500: #eab308;
      }"
    `)
  })

  test('removes circular declaration but keeps other var() refs intact', () => {
    let input = `@theme {\n  --color-yellow-500: #eab308;\n  --color-away-base: var(--color-yellow-500);\n}\n\n.card {\n  color: var(--color-away-base);\n}`
    let result = renameCssVariables({
      content: input,
      from: parseToken('color-away-base'),
      to: parseToken('color-yellow-500'),
    })
    expect(result).toMatchInlineSnapshot(`
      "@theme {
        --color-yellow-500: #eab308;
      }

      .card {
        color: var(--color-yellow-500);
      }"
    `)
  })
})

describe('duplicate variable deduplication (#7)', () => {
  test('removes existing target declaration when rename creates a duplicate', () => {
    // After a prior rename, --color-foreground already exists. Now renaming
    // --color-text-strong-950 to --color-foreground would create a duplicate.
    let input = `@theme {\n  --color-foreground: var(--color-neutral-950);\n  --color-text-strong-950: var(--color-neutral-950);\n}`
    let result = renameCssVariables({
      content: input,
      from: parseToken('color-text-strong-950'),
      to: parseToken('color-foreground'),
    })
    expect(result).toMatchInlineSnapshot(`
      "@theme {
        --color-foreground: var(--color-neutral-950);
      }"
    `)
  })

  test('deduplicates in .dark scope too', () => {
    let input = `.dark {\n  --color-foreground: var(--color-neutral-0);\n  --color-text-strong-950: var(--color-neutral-0);\n}`
    let result = renameCssVariables({
      content: input,
      from: parseToken('color-text-strong-950'),
      to: parseToken('color-foreground'),
    })
    expect(result).toMatchInlineSnapshot(`
      ".dark {
        --color-foreground: var(--color-neutral-0);
      }"
    `)
  })
})

describe('countTokenUsage', () => {
  test('counts declared project variables used by Tailwind markup candidates and var() references', async () => {
    let dir = path.join(TMP_DIR, `count-project-${Date.now()}`)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, 'globals.css'),
      `@import "tailwindcss";

@theme {
  --color-social-apple: #000;
  --color-social-twitter: #1da1f2;
  --color-red-500: #f00;
  --spacing-card: 1rem;
  --radius-card: 0.75rem;
  --font-brand: ui-sans-serif;
  --shadow-button: 0 0 #000;
  --breakpoint-wide: 90rem;
  --container-sidebar: 40rem;
}

@theme inline {
  --color-brand-accent: var(--brand-accent);
}

:root {
  --brand-accent: var(--color-social-apple);
  --semantic-surface: #fff;
}

.dark,
[data-theme='dark'] {
  --color-social-apple: #fff;
  --semantic-surface: #000;
}

.button {
  --local-gap: 2rem;
  color: var(--semantic-surface);
  content: "--not-a-declaration";
}

@property --motion-duration {
  syntax: "<time>";
  inherits: false;
  initial-value: 150ms;
}

/* --commented-token: red; */
`,
    )
    await fs.writeFile(
      path.join(dir, 'index.html'),
      `<div class="text-social-apple bg-social-apple hover:border-social-apple wide:p-card max-wide:text-social-twitter @sidebar:flex @max-sidebar:grid ring-[var(--color-social-apple)] text-[var(--semantic-surface)] p-card gap-card rounded-card shadow-button font-brand text-red-500">
  <span style="color: var(--brand-accent); --inline: var(--semantic-surface); transition-duration: var(--motion-duration)">Apple</span>
</div>
`,
    )

    let result = await countTokenUsage({ base: dir })

    expect(formatTokenUsageTable(result)).toMatchInlineSnapshot(`
      "| Variable | Uses | Utility suffix |
      | --- | ---: | --- |
      | \`--color-social-apple\` | 4 | \`social-apple\` |
      | \`--spacing-card\` | 3 | \`card\` |
      | \`--breakpoint-wide\` | 2 | \`wide\` |
      | \`--container-sidebar\` | 2 | \`sidebar\` |
      | \`--semantic-surface\` | 2 |  |
      | \`--brand-accent\` | 1 |  |
      | \`--color-social-twitter\` | 1 | \`social-twitter\` |
      | \`--font-brand\` | 1 | \`brand\` |
      | \`--motion-duration\` | 1 |  |
      | \`--radius-card\` | 1 | \`card\` |
      | \`--shadow-button\` | 1 | \`button\` |
      | \`--color-brand-accent\` | 0 | \`brand-accent\` |
      | \`--local-gap\` | 0 |  |"
    `)
  })
})
