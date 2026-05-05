# windlint

CLI tool that lints and renames CSS variables and design tokens across Tailwind CSS v4 projects. Uses PostCSS for CSS structure and `@tailwindcss/oxide` Scanner for Tailwind utility candidates with byte positions, then replaces token suffixes precisely.

## How it works

Given `windlint rename color-social-apple color-brand-apple` from a project directory:

1. Parses token names to derive CSS variable form (`--color-social-apple`) and utility suffix (`social-apple`)
2. Discovers all CSS and template files via globby
3. Uses PostCSS to rename CSS variable declarations, `@property` params, and `var()` references in CSS files
4. Uses oxide Scanner to find Tailwind candidates in templates with exact positions, renames matching suffixes
5. Splices changes into strings by position so offsets don't drift

## Inline command rule

`windlint inline <token>` is a specialized rename. It must reuse the same template candidate parsing and replacement logic as `windlint rename` instead of having a separate scanner or separate utility parser.

The only extra step inline adds is computing a replacement token from the source token value:

- For colors, lengths, spacing, and radius aliases, choose the closest Tailwind built-in approximation when approximation is enabled.
- For shadows and exact values that do not have a useful built-in equivalent, use an arbitrary utility like `shadow-[0_1px_2px_0_#0a0d1408]`.
- For default Tailwind token names that the project overrides, such as `radius-sm`, do not rename them to a different default name. Inline custom aliases like `radius-10`, not canonical default names.

After computing the target token, inline should flow through `findTemplateCandidateRenameChanges()` / `renameTemplateTokens()` style logic so namespace handling, variants, arbitrary values, and splicing stay consistent with rename.

## Architecture inspiration

This tool is modeled after the **Tailwind CSS v4 upgrade CLI** (`@tailwindcss/upgrade`). Study these files for patterns on how to build robust template migration tools:

- **Upgrade CLI entry point** (orchestration, file discovery, migration pipeline):
  https://github.com/tailwindlabs/tailwindcss/blob/main/packages/%40tailwindcss-upgrade/src/index.ts

- **Template migration** (how candidates are extracted, migrated, and spliced back):
  https://github.com/tailwindlabs/tailwindcss/blob/main/packages/%40tailwindcss-upgrade/src/codemods/template/migrate.ts

- **Candidate extraction with positions** (oxide Scanner usage):
  https://github.com/tailwindlabs/tailwindcss/blob/main/packages/%40tailwindcss-upgrade/src/codemods/template/candidates.ts

- **Safe migration heuristics** (avoiding false positives in non-class contexts):
  https://github.com/tailwindlabs/tailwindcss/blob/main/packages/%40tailwindcss-upgrade/src/codemods/template/is-safe-migration.ts

- **String splicing utility** (applying positional changes without offset drift):
  https://github.com/tailwindlabs/tailwindcss/blob/main/packages/%40tailwindcss-upgrade/src/utils/splice-changes-into-string.ts

- **Oxide Scanner NAPI bindings** (Rust scanner exposed to JS):
  https://github.com/tailwindlabs/tailwindcss/blob/main/crates/node/src/lib.rs

- **Tailwind CSS IntelliSense conflict diagnostics** (source for `css-conflict` semantics):
  https://github.com/tailwindlabs/tailwindcss-intellisense/blob/main/packages/tailwindcss-language-service/src/diagnostics/getCssConflictDiagnostics.ts

## CSS parsing rule

Always use **PostCSS** when changing behavior that reads or edits CSS files.

- For CSS declarations, walk PostCSS `Declaration` nodes. Read `declaration.prop` for custom property names and `declaration.value` for `var()` references.

- For `@property --token { ... }`, walk PostCSS `AtRule` nodes with `name === 'property'` and inspect `atRule.params`.

- For source edits, collect byte offsets from PostCSS source locations and use `spliceChangesIntoString()`. Do not mutate and stringify the whole PostCSS tree unless the goal is to reformat the file.

- Do not add new regex or hand-rolled scanners for CSS syntax. A tiny raw string scanner is acceptable only inside already-isolated declaration values or non-CSS markup strings where PostCSS cannot parse the surrounding language.

## Improving robustness

When extending this tool, prefer AST-based parsing over raw text matching:

- For template files, the oxide Scanner already handles robust candidate extraction. It understands HTML attributes, JSX props, Vue/Svelte templates, and template literals. Always prefer `getCandidatesWithPositions()` over regex for finding Tailwind classes.

- For `var()` references inside arbitrary values, the oxide Scanner catches these as part of candidates (e.g., `text-[var(--color-social-apple)]`). The candidate string itself can then be manipulated.

- For inline styles and JS string contexts, consider using a proper JS/TS parser (like the approach in Tailwind's `is-safe-migration.ts`) to verify context before replacing.

The Tailwind upgrade tool demonstrates the gold standard: it parses candidates into an AST (`designSystem.parseCandidate`), manipulates the candidate AST, then prints it back (`designSystem.printCandidate`). This avoids all regex pitfalls. For windlint, the equivalent would be parsing the candidate, checking if its root or value contains the old token, replacing at the AST level, and printing back.

## CSS conflict rule

`css-conflict` follows Tailwind CSS IntelliSense, not a generic CSS cascade overlap check.

- A conflict exists only when two utilities compile to the same number of CSS rule entries.
- Each matching rule entry must have the same context, such as the same media query or pseudo selector.
- Each matching rule entry must write the same full property set.
- A partial overlap is not a safe conflict. For example, `text-sm font-normal`, `transition-all duration-200`, and `ring-1 ring-inset` overlap on one declaration but are not equivalent utilities.

Only auto-fix conflicts when this full compiled shape matches. Never delete a utility just because one generated declaration overlaps with a later utility.

## Tailwind design-system rule

Use Tailwind's **DesignSystem** as the source of truth for theme variables. Prefer helpers in `src/design-system.ts` over manually scanning `@theme` blocks with PostCSS.

- Use `loadProjectDesignSystem()` to load project CSS with Tailwind defaults.
- Use `designSystem.theme.entries()` / `getProjectThemeEntries()` to enumerate project theme variables.
- Use `designSystem.theme.hasDefault(key)` to skip Tailwind built-in tokens.
- Use `designSystem.resolveThemeValue(key)` for existence checks and default values.
- Use PostCSS only for CSS source locations and non-theme custom properties that Tailwind does not track.

Tailwind returns raw values from theme entries. If a token is `--color-primary: var(--brand)`, keep a small custom-property map for recursive `var()` resolution instead of treating PostCSS as the primary theme scanner.

## Running

```bash
# Rename a token
windlint rename color-social-apple color-brand-apple

# Dry run (preview only)
windlint rename color-social-apple color-brand-apple --dry-run --verbose
```

## Testing

```bash
pnpm test
```

Tests copy fixture projects to tmp, run the rename, then inline snapshot the git diff to verify all instances are replaced and nothing else is touched.
