# Changelog

## 0.1.0

1. **Tailwind AST-based token renames** — renames use Tailwind's candidate parser and `designSystem.parseCandidate()` instead of regex, so namespace-aware replacements are precise:

   ```bash
   windlint rename color-social-apple color-brand-apple
   ```

   Only color utilities (`text-`, `bg-`, `border-`, etc.) are touched; spacing and radius utilities with the same suffix are left alone.

2. **New `inline` command** — collapse a theme token into direct Tailwind utilities. Supports text, color, and radius namespaces with automatic approximation to the closest built-in Tailwind value:

   ```bash
   windlint inline text-title-h1
   # text-title-h1 → text-6xl font-medium
   ```

   Pass `--disable-approximation` to keep raw arbitrary values like `text-[3.5rem]`.

3. **New `lint` command** — find non-canonical utilities, CSS conflicts, invalid `var()` theme references, near-duplicate theme colors, and suggest project theme colors for literal color usage:

   ```bash
   windlint lint --fix
   ```

   With `--fix`, canonical classes are rewritten and conflicting utilities are removed. Conflicts follow Tailwind IntelliSense semantics: only full compiled-shape matches count.

4. **New `count` command** — report which declared CSS variables are used in markup, sorted by usage. Zero-use tokens reveal dead code:

   ```bash
   windlint count
   ```

5. **Slash opacity modifier renames** — rename alpha tokens into Tailwind `/opacity` syntax. CSS declarations are left alone since `--color-primary/10` is not a valid CSS variable name:

   ```bash
   windlint rename color-primary-alpha-10 color-primary/10
   # bg-primary-alpha-10 → bg-primary/10
   ```

6. **Tailwind DesignSystem integration** — theme variables come from `loadProjectDesignSystem()` instead of manually scanning `@theme` blocks. Built-in Tailwind defaults are filtered out automatically.

7. **Arbitrary `var()` candidates inlined through rename** — `text-[var(--color-primary-alpha-10)]` is rewritten to `text-primary/10` when the target uses a slash modifier, instead of leaving a stale `var()` reference.

8. **Fixed css-conflict false positives** — partial property overlaps (e.g. `text-sm font-normal`, `ring-1 ring-inset`) are no longer flagged. Different arbitrary variant contexts (`[.foo_&]` vs `[.bar_&]`) are no longer treated as conflicts.

9. **Atomic file writes** — CSS and template files are written atomically to prevent corruption on concurrent runs.

10. **`@apply` renaming** — `@apply text-social-apple` in CSS files is renamed alongside regular utilities.

11. **Canonical candidate output** — renamed candidates pass through `designSystem.canonicalizeCandidates()` so the output always matches Tailwind's preferred form.

12. **Programmatic API** — all commands are available as named exports:

    ```ts
    import { rename, inlineToken, lint, countTokenUsage } from 'windlint'
    ```
