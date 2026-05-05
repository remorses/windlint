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

    expect(result.diagnostics).toMatchInlineSnapshot(`[]`)
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
})
