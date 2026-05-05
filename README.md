<div align='center'>
    <br/>
    <br/>
    <h3>windlint</h3>
    <p>Lint, rename, and audit Tailwind v4 design tokens without regex migrations.</p>
    <br/>
    <br/>
</div>

`windlint` is a small CLI for **Tailwind CSS v4 token migrations**. It renames CSS variables in
CSS files, updates matching utility classes in markup, inlines text tokens into direct utilities,
encodes alpha tokens as slash opacity modifiers, lints non-canonical utilities and conflicts, and can
count which declared tokens are used the most.

```txt
old token                          windlint                          new token
--color-social-apple       ───────────►────────────        --color-brand-apple
text-social-apple          ───────────►────────────        text-brand-apple
bg-[var(--color-social)]   ───────────►────────────        bg-[var(--color-brand)]
```

## Why this exists

Tailwind v4 maps `@theme` variables to utility classes. A token rename is not just a text rename:
`--color-social-apple` becomes `text-social-apple`, `bg-social-apple`, `border-social-apple`, and
also appears inside arbitrary values like `text-[var(--color-social-apple)]`.

```txt
┌───────────────────────────────┐
│ @theme                        │
│ --color-social-apple: #000;   │
└───────────────┬───────────────┘
                ▼
        Tailwind utility space
                │
       ┌────────┼──────────────┬──────────────────┐
       ▼        ▼              ▼                  ▼
 text-social  bg-social   border-social   var(--color-social)
       │        │              │                  │
       └────────┴──────► windlint ◄───────────────┘
```

`windlint` uses the same kind of primitives Tailwind migration tools use:

| Area      | Tooling                        | Why it matters                                                       |
| --------- | ------------------------------ | -------------------------------------------------------------------- |
| CSS       | **PostCSS**                    | Parses declarations, comments, strings, and `@property` rules as CSS |
| Markup    | **@tailwindcss/oxide Scanner** | Finds class candidates with byte positions                           |
| Utilities | **Tailwind candidate parser**  | Knows that `rounded-card` is not a color token                       |

## Install

Run it directly with your package manager:

```bash
pnpm dlx windlint rename color-social-apple color-brand-apple
```

Or install it in a project:

```bash
pnpm add -D windlint
pnpm windlint count
```

## Rename a token

Run the command from the project directory and pass the old token and the new token.
**Run renames sequentially**, not in parallel, to prevent concurrent file writes from corrupting each other.

```bash
windlint rename color-social-apple color-brand-apple
windlint rename color-primary-alpha-10 color-primary/10
windlint rename color-white-alpha-16 color-white/[.16]
```

The input may include the leading `--`:

```bash
windlint rename --color-social-apple --color-brand-apple
```

Use `--dry-run` to preview the files that would change:

```bash
windlint rename color-social-apple color-brand-apple --dry-run --verbose
```

To collapse an alpha token into a Tailwind **slash opacity** modifier, put the modifier in the target:

```bash
windlint rename color-primary-alpha-10 color-primary/10
```

That rewrites markup utilities, but leaves CSS declarations and inline style `var()` references alone
because `--color-primary/10` is not a CSS variable name:

```diff
-bg-primary-alpha-10 hover:text-primary-alpha-10 text-[var(--color-primary-alpha-10)]
+bg-primary/10 hover:text-primary/10 text-primary/10
```

```txt
before                                              after
┌────────────────────────────────────┐              ┌────────────────────────────────────┐
│ --color-social-apple: #000;        │    rename    │ --color-brand-apple: #000;         │
│ color: var(--color-social-apple);  │ ───────────► │ color: var(--color-brand-apple);   │
│ class="text-social-apple"          │              │ class="text-brand-apple"           │
└────────────────────────────────────┘              └────────────────────────────────────┘
```

## Inline a token

Use `inline` when a project token should become direct Tailwind utilities instead of another token.
It supports **text**, **color**, **radius**, and other scalar Tailwind token namespaces.

```bash
windlint inline text-title-h1
```

Given this token definition:

```css
@theme {
  --text-title-h1: 3.5rem;
  /* --text-title-h1--line-height: 4rem; */
  /* --text-title-h1--letter-spacing: -0.01em; */
  --text-title-h1--font-weight: 500;
}
```

`windlint` rounds the font size to the closest default Tailwind size and uses named utilities when
they match Tailwind defaults:

```diff
-<h1 class="text-title-h1 hover:text-title-h1">
+<h1 class="text-6xl font-medium hover:text-6xl hover:font-medium">
```

Pass `--disable-approximation` to keep the raw values as arbitrary utilities:

```bash
windlint inline text-title-h1 --disable-approximation
```

```diff
-<h1 class="text-title-h1">
+<h1 class="text-[3.5rem] font-[500]">
```

If the CSS token includes real `--text-token--line-height` or `--text-token--letter-spacing`
metadata, `inline` includes `leading-*` and `tracking-*` utilities automatically. Remove those
metadata declarations first when they should not be inlined.

`inline` currently rewrites template candidates only. CSS `@apply text-title-h1` is intentionally
left alone for now to keep the first implementation focused and safe.

Color and radius tokens inline to the closest built-in Tailwind token by default:

```bash
windlint inline color-brand
windlint inline radius-card
```

```diff
-<div class="bg-brand text-brand rounded-card">
+<div class="bg-red-500 text-red-500 rounded-xl">
```

## Lint Tailwind classes

Use `lint` to find **non-canonical utilities**, **conflicting utilities** in the same class list,
and CSS `var(--token)` references that do not exist in the Tailwind v4 design system.

```bash
windlint lint src/button.tsx globals.css
windlint lint --fix
```

Example output:

```txt
src/button.tsx:5:42 warning font-[700] can be written as font-bold (suggest-canonical)
src/button.tsx:8:12 warning hover:bg-red-500 conflicts with hover:bg-blue-500 (css-conflict)
globals.css:14:8 error --color-brnad does not exist. Did you mean --color-brand? (invalid-config-path)

Found 3 issues (1 error, 2 warnings)
```

With `--fix`, windlint rewrites canonical classes and deletes all but the last conflicting class.

## Count token usage

Use `count` to see which declared CSS variables are used in markup. The most used variables appear
first.

```bash
windlint count
```

Example output:

```md
| Variable                 | Uses | Utility suffix   |
| ------------------------ | ---: | ---------------- |
| `--color-social-apple`   |   18 | `social-apple`   |
| `--color-social-twitter` |    5 | `social-twitter` |
| `--shadow-button-focus`  |    1 | `button-focus`   |
| `--color-primary-base`   |    0 | `primary-base`   |
```

```txt
CSS declarations                     markup candidates                     usage table
┌──────────────────────┐             ┌─────────────────────────────┐       ┌───────────┐
│ --color-apple        │ ──────────► │ text-apple                  │ ────► │ apple: 18 │
│ --spacing-card       │ ──────────► │ p-card gap-card             │ ────► │ card: 3   │
│ --shadow-button      │ ──────────► │ shadow-button               │ ────► │ button: 1 │
│ --radius-unused      │ ──────────► │ no matching candidate       │ ────► │ unused: 0 │
└──────────────────────┘             └─────────────────────────────┘       └───────────┘
```

The count command is useful before a cleanup. Zero-use tokens tell you what is probably dead.

## What gets renamed

### CSS variables

PostCSS walks CSS declarations and `@property` rules. Comments and string literals are left alone.

```css
@theme {
  --color-social-apple: #000;
  --shadow-button-focus: 0 0 0 2px var(--color-social-apple);
}

@property --color-social-apple {
  syntax: "<color>";
  inherits: false;
  initial-value: #000;
}

.demo::before {
  content: "--color-social-apple"; /* not renamed */
}
```

### Tailwind utility classes

The markup path uses oxide positions and Tailwind's candidate parser. This keeps namespace changes
precise.

```txt
--color-card      ─────► text-card bg-card border-card ring-card
--spacing-card    ─────► p-card m-card gap-card size-card
--radius-card     ─────► rounded-card
--breakpoint-md   ─────► md: max-md: min-md:
--container-side  ─────► @side: @max-side: @min-side:
```

The namespace matters:

```html
<!-- color-card rename touches text/bg/border color utilities -->
<div class="text-card bg-card rounded-card p-card"></div>
```

```txt
color-card rename
text-card  ─────────► text-panel
bg-card    ─────────► bg-panel
rounded-card ──────► unchanged, radius namespace
p-card       ──────► unchanged, spacing namespace
```

### Arbitrary values and inline CSS references

Explicit variable references are updated too:

```html
<div class="text-[var(--color-social-apple)]">
  <div style="color: var(--color-social-apple)"></div>
</div>
```

## How it works

The rename command has two independent passes: one for CSS, one for templates.

```txt
project files
     │
     ├──────────────► CSS files ─────► PostCSS AST ─────► splice exact variable changes
     │
     └──────────────► markup files ──► oxide Scanner ───► Tailwind candidate parser
                                             │
                                             └──────────► splice exact candidate changes
```

The count command reuses the same scanners, but reports usage instead of writing files.

```txt
count
  │
  ├────► collect project variables from CSS
  │        │
  │        └────► remove Tailwind default variables
  │
  ├────► scan markup candidates
  │        │
  │        ├────► count utilities compiled from each token
  │        └────► count explicit var(--token) references
  │
  └────► sort rows by uses, descending
```

## Programmatic API

```ts
import { countTokenUsage, formatTokenUsageTable, inlineToken, lint, rename } from "windlint";

await rename({
  from: "color-social-apple",
  to: "color-brand-apple",
  base: "./app",
  dryRun: true,
});

await inlineToken({
  token: "text-title-h1",
  base: "./app",
  disableApproximation: true,
});

let diagnostics = await lint({ base: "./app", fix: true });
console.log(diagnostics.issueCount);

let usage = await countTokenUsage({ base: "./app" });
console.log(formatTokenUsageTable(usage));
```

## Development

```bash
pnpm install
pnpm test -- --run
pnpm build
lintcn lint
```

Tests copy fixture projects to a temporary directory, run the migration, then snapshot the git diff.
This makes it easy to see every real edit the CLI would make.

```txt
fixture project ─────► temporary copy ─────► windlint ─────► git diff snapshot
```
