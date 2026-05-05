// Tests for css-rename: copies fixture projects to tmp, runs rename, snapshots the diff.

import { describe, test, expect, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { rename } from './rename.ts'
import { renameCssVariables } from './css-rename.ts'
import { renameTemplateTokens } from './template-rename.ts'
import { parseToken } from './token.ts'
import { execSync } from 'node:child_process'

const FIXTURES_DIR = path.resolve(import.meta.dirname, 'fixtures')
const TMP_DIR = '/var/folders/8w/wvmrpgms5hngywvs8s99xnmm0000gn/T/opencode/css-rename-tests'

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
    expect(result).toMatchInlineSnapshot(`"<div class="text-[var(--color-brand-apple)]">"`)
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
      index 2739088..7b67bd1 100644
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
      +    <div class="text-[var(--color-brand-apple)] bg-[var(--color-brand-apple)]">
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
})
