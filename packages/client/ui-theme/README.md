---
description: "Design token foundation for Matter's client packages: a two-layer CSS variable set (static atoms referenced by alias semantics), a typed token registry kept in 1:1 correspondence with the CSS, and an installThemeStyles injection hook (ctx.effect + disposer). First client package; brings the dual-plane tsconfig and the jsdom test stack."
kind: "package-reference"
---

# @matter/client-ui-theme

English | [中文](README.zh.md)

## Summary

`@matter/client-ui-theme` is the design-token foundation of Matter's client group and the new tree's first client package (P3-U1). It ships three things: a two-layer CSS variable set — `--matter-static-*` atoms (colors, radii) referenced by `--matter-alias-*` semantics (surface, text, border, accent, danger, radii) — that components consume as `var(--matter-alias-…)`; a typed token registry (`THEME_TOKENS`, one entry per variable with name / description / valueType / cssVariable); and `installThemeStyles(ctx)`, which injects the stylesheet into `document.head` through `ctx.effect()` and returns a disposer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Components consume only the alias layer. The static layer is an implementation detail of the token file: when visuals change, only the `var()` targets inside `theme.css` move, consuming CSS stays untouched.

### Consume tokens in component CSS

```css
.card {
  background: var(--matter-alias-surface-raised);
  color: var(--matter-alias-text-primary);
  border: 1px solid var(--matter-alias-border-subtle);
  border-radius: var(--matter-alias-radius-panel);
}
```

### Inject the stylesheet

The token CSS is not linked from any HTML entry; whoever owns the DOM installs it. In P3 that is a test, in P4 it will be the web shell's mount point. The host `apply` is an empty registration on purpose: loading the package has no side effects, the injection timing belongs to the caller.

```ts
import type { Context } from "@deepseek-ai/cordis"
import { installThemeStyles } from "@matter/client-ui-theme/client"

const dispose = installThemeStyles(ctx) // <style> is now in document.head
// …later, or automatically when ctx's fiber unloads:
await dispose()
```

### Read the token registry

The registry is host-side data (no DOM dependency), exported from the package root. It exists for docs, validation tooling and a future theme-settings surface; runtime styles never read it.

```ts
import { THEME_TOKENS } from "@matter/client-ui-theme"

for (const token of THEME_TOKENS) {
  console.log(token.name, token.valueType, token.cssVariable)
}
```

<a id="understand-the-implementation"></a>
## Understand the implementation

### Dual-plane tsconfig

This package compiles through two projects, both registered in `tsconfig.next.json` via the package-root solution file (`tsconfig.json`, files empty, two references):

- `tsconfig.host.json` extends `tsconfig.base.emit.json` (node types) and compiles the host entry `src/index.ts` plus `src/tokens.ts`.
- `tsconfig.client.json` extends the new `tsconfig.base.client.emit.json` (adds `jsx: "react-jsx"` and DOM / DOM.Iterable libs, drops node types; no decorators, following DSH) and compiles `src/client/**` with its own tsbuildinfo.

Both planes emit into `lib/types/` without overlap; tsdown bundles only the host entry into `lib/index.js`, the client half stays raw tsc emit for Vite / vitest consumption.

### Why the registry lives in the host half

DSH keeps its token registry in the client half because it feeds a client-side theme-settings UI. This package has no settings surface in P3, and the registry is pure data, so it is exported from the host entry where any tooling can read it. The client half stays DOM-only (`installThemeStyles`), which is also why the `*.css?inline` ambient declaration (`src/client/assets.d.ts`) lives inside the client plane.

### Test stack and coverage domain

Root devDependencies pin the DSH client test stack: `jsdom 29.1.1`, `@testing-library/react ^16.3.3`, `@testing-library/dom ^10.4.1`, plus `react` / `react-dom` / `@types/react` (browser-only third-party belongs in devDependencies; @types/react only at the root). The jsdom spec opts in per file with a `// @vitest-environment jsdom` pragma — the shared config stays node. Coverage thresholds are domain-split in `verify-coverage-threshold`: `packages/client/` is judged perFile 80 (DOC-520 §4.3), every other package keeps perFile 100.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Vitest's default `css: false` stubs every `.css` import — including `?inline` and `?raw` — into an empty string (the `vitest:css-disable` plugin runs `enforce: pre`). The jsdom spec therefore pins the injection contract (tag presence, verbatim passthrough of the `?inline` import, disposer) while content assertions live in `tests/tokens.test.ts`, which reads `theme.css` from disk. Enabling CSS processing scoped to `packages/client/` (one `test.css` entry in `vitest.config.ts`) is deferred: that file is outside this ticket's write scope.
- Light theme only. No dark theme, no `requiresLightAndDark` registry metadata (DSH has both); both arrive with a theme-switch surface, not before a consumer exists.
- Values are a first-pass eyeballed minimal set, not a reviewed visual pass; they will follow the visuals when one happens (per ticket: minimal set first, do not copy DSH's scale).
- The host `apply` is an empty registration: no service key, no volatile `Config` fields, no `boot-theme` (DSH has those with its shell). They come with the settings / shell surface in P4+.
- No client bundling plane: the client half ships as raw tsc emit consumed by Vite / vitest. DSH's `clientBundle` preset is private to DSH and P3 has no web shell; bundling lands with P4's shell ticket.
- `react` and the testing-library stack are installed at root for the whole client group; this package itself contains no React component, so nothing imports them yet.
