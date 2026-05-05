// Tests for windlint lint: creates real Tailwind v4 projects in tmp and snapshots diagnostics/fixes.

import { describe, expect, test } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { formatLintResult, lint } from './lint.ts'

const TMP_DIR = path.join(os.tmpdir(), 'windlint-lint-tests')

async function createProject(name: string): Promise<string> {
  let dir = path.join(TMP_DIR, `${name}-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'globals.css'), `@import "tailwindcss";\n@theme { --color-brand: #000; }\n`)
  return dir
}

describe('lint', () => {
  test('reports canonical class suggestions and class conflicts', async () => {
    let dir = await createProject('template-diagnostics')
    await fs.writeFile(
      path.join(dir, 'button.tsx'),
      `<button className="font-[700] hover:bg-red-500 hover:bg-blue-500 text-brand">Save</button>\n`,
    )

    let result = await lint({ base: dir })

    expect(result.diagnostics.map(({ relativePath, line, column, severity, rule, message }) => ({
      relativePath,
      line,
      column,
      severity,
      rule,
      message,
    }))).toMatchInlineSnapshot(`
      [
        {
          "column": 31,
          "line": 1,
          "message": "hover:bg-red-500 conflicts with hover:bg-blue-500",
          "relativePath": "button.tsx",
          "rule": "css-conflict",
          "severity": "warning",
        },
        {
          "column": 20,
          "line": 1,
          "message": "font-[700] can be written as font-bold",
          "relativePath": "button.tsx",
          "rule": "suggest-canonical",
          "severity": "warning",
        },
        {
          "column": 48,
          "line": 1,
          "message": "hover:bg-blue-500 should use a project theme color. Closest: bg-brand",
          "relativePath": "button.tsx",
          "rule": "prefer-theme-color",
          "severity": "warning",
        },
      ]
    `)
  })

  test('fixes canonical class suggestions and class conflicts', async () => {
    let dir = await createProject('template-fixes')
    let file = path.join(dir, 'button.tsx')
    await fs.writeFile(
      file,
      `<button className="font-[700] hover:bg-red-500 hover:bg-blue-500 text-brand">Save</button>\n`,
    )

    let result = await lint({ base: dir, fix: true })

    expect({ fixedCount: result.fixedCount, fixedFiles: result.fixedFiles }).toMatchInlineSnapshot(`
      {
        "fixedCount": 2,
        "fixedFiles": 1,
      }
    `)
    await expect(fs.readFile(file, 'utf-8')).resolves.toMatchInlineSnapshot(`
      "<button className="font-bold hover:bg-blue-500 text-brand">Save</button>
      "
    `)
  })

  test('reports invalid CSS theme variable paths with suggestions', async () => {
    let dir = await createProject('css-diagnostics')
    await fs.writeFile(
      path.join(dir, 'globals.css'),
      `@import "tailwindcss";\n@theme { --color-brand: #000; }\n.card { color: var(--color-brnad); }\n`,
    )

    let result = await lint({ base: dir })

    expect(result.diagnostics.map(({ relativePath, line, column, severity, rule, message }) => ({
      relativePath,
      line,
      column,
      severity,
      rule,
      message,
    }))).toMatchInlineSnapshot(`
      [
        {
          "column": 20,
          "line": 3,
          "message": "--color-brnad does not exist. Did you mean --color-brand?",
          "relativePath": "globals.css",
          "rule": "invalid-config-path",
          "severity": "error",
        },
      ]
    `)
  })

  test('loads project CSS theme when linting explicit template files', async () => {
    let dir = await createProject('explicit-files')
    await fs.writeFile(path.join(dir, 'button.tsx'), `<button className="bg-brand bg-red-500">Save</button>\n`)

    let result = await lint({ base: dir, files: ['button.tsx'] })

    expect(result.diagnostics.map(({ relativePath, severity, rule, message }) => ({
      relativePath,
      severity,
      rule,
      message,
    }))).toMatchInlineSnapshot(`
      [
        {
          "message": "bg-brand conflicts with bg-red-500",
          "relativePath": "button.tsx",
          "rule": "css-conflict",
          "severity": "warning",
        },
        {
          "message": "bg-red-500 should use a project theme color. Closest: bg-brand",
          "relativePath": "button.tsx",
          "rule": "prefer-theme-color",
          "severity": "warning",
        },
      ]
    `)
  })

  test('does not report local CSS variables as missing theme variables', async () => {
    let dir = await createProject('local-css-vars')
    await fs.writeFile(
      path.join(dir, 'globals.css'),
      `.button { --button-bg: red; color: var(--button-bg); }\n`,
    )

    let result = await lint({ base: dir })

    expect(result.diagnostics).toMatchInlineSnapshot(`[]`)
  })

  test('does not autofix conflicts across important and non-important utilities', async () => {
    let dir = await createProject('important-conflict')
    let file = path.join(dir, 'button.tsx')
    await fs.writeFile(file, `<button className="bg-red-500! bg-blue-500">Save</button>\n`)

    let result = await lint({ base: dir, fix: true })

    expect(result.fixedCount).toMatchInlineSnapshot(`0`)
    await expect(fs.readFile(file, 'utf-8')).resolves.toMatchInlineSnapshot(`
      "<button className="bg-red-500! bg-blue-500">Save</button>
      "
    `)
  })

  test('prints remaining errors after applying fixes', async () => {
    let dir = await createProject('fix-and-error')
    await fs.writeFile(path.join(dir, 'button.tsx'), `<button className="font-[700]">Save</button>\n`)
    await fs.writeFile(path.join(dir, 'globals.css'), `@theme { --color-brand: #000; }\n.card { color: var(--color-brnad); }\n`)

    let result = await lint({ base: dir, fix: true })

    expect(formatLintResult(result)).toMatchInlineSnapshot(`
      "button.tsx:1:20 fixed font-[700] → font-bold
      Fixed 1 issue in 1 file

      globals.css:2:20 error --color-brnad does not exist. Did you mean --color-brand? (invalid-config-path)
      Found 1 issue (1 error, 0 warnings)"
    `)
  })

  test('suggests nearest project theme colors for literal and built-in colors', async () => {
    let dir = await createProject('nearest-theme-colors')
    await fs.writeFile(
      path.join(dir, 'globals.css'),
      `@import "tailwindcss";
@theme {
  --color-background: oklch(1 0 0);
  --color-card: oklch(0.98 0 0);
  --color-muted: oklch(96.7% 0.003 264.542);
  --color-border: #e5e7eb;
  --color-primary: #123456;
  --color-secondary: #223456;
  --color-accent: #334455;
}
`,
    )
    await fs.writeFile(
      path.join(dir, 'button.tsx'),
      `<div className="bg-gray-100"></div>\n<div className="text-[#123456]"></div>\n`,
    )

    let result = await lint({ base: dir })

    expect(result.diagnostics.map(({ relativePath, line, column, severity, rule, message }) => ({
      relativePath,
      line,
      column,
      severity,
      rule,
      message,
    }))).toMatchInlineSnapshot(`
      [
        {
          "column": 17,
          "line": 1,
          "message": "bg-gray-100 should use a project theme color. Closest: bg-muted, bg-card, bg-background, bg-border, bg-accent",
          "relativePath": "button.tsx",
          "rule": "prefer-theme-color",
          "severity": "warning",
        },
        {
          "column": 17,
          "line": 2,
          "message": "text-[#123456] should use a project theme color. Closest: text-primary, text-secondary, text-accent, text-border, text-muted",
          "relativePath": "button.tsx",
          "rule": "prefer-theme-color",
          "severity": "warning",
        },
      ]
    `)
  })

  test('does not suggest a theme color when the candidate already uses a project token', async () => {
    let dir = await createProject('theme-color-already-token')
    await fs.writeFile(
      path.join(dir, 'globals.css'),
      `@import "tailwindcss";\n@theme { --color-muted: oklch(96.7% 0.003 264.542); }\n`,
    )
    await fs.writeFile(path.join(dir, 'button.tsx'), `<div className="bg-muted text-muted"></div>\n`)

    let result = await lint({ base: dir })

    expect(result.diagnostics).toMatchInlineSnapshot(`[]`)
  })

  test('errors when two theme color variables are almost identical', async () => {
    let dir = await createProject('duplicate-theme-colors')
    await fs.writeFile(
      path.join(dir, 'globals.css'),
      `@import "tailwindcss";
@theme {
  --color-primary: #123456;
  --color-accent: #123457;
  --color-primary-alias: var(--color-primary);
}
`,
    )

    let result = await lint({ base: dir })

    expect(result.diagnostics.map(({ relativePath, line, column, severity, rule, message }) => ({
      relativePath,
      line,
      column,
      severity,
      rule,
      message,
    }))).toMatchInlineSnapshot(`
      [
        {
          "column": 3,
          "line": 4,
          "message": "--color-accent is too close to --color-primary. Deduplicate with --color-accent: var(--color-primary) or merge both variables into one color token.",
          "relativePath": "globals.css",
          "rule": "duplicate-theme-color",
          "severity": "error",
        },
      ]
    `)
  })
})
