# Brokkr docs content

Every `.mdx` file under `content/` becomes a page at `/docs/<slug>` in the web
app. There is nothing to register: the docs manifest
(`apps/web/src/lib/docs-manifest.ts`) globs this directory and derives the
sidebar, ordering, landing-page cards, and previous/next navigation from
frontmatter.

## Adding a page

Create `content/<section>/<name>.mdx`:

```mdx
---
title: Deploy the hub
description: One-line summary, shown on the landing page and cards.
section: self-host
order: 2
---

## First heading

Prose. Standard markdown (GFM tables included) plus JSX where needed.
```

- `section` must be a key from `SECTIONS` in the docs manifest (adding a new
  section = one line there).
- `order` positions the page within its section.
- `slug` (optional) overrides the URL path; it defaults to the file's
  content-relative path (`self-host/hub` → `/docs/self-host/hub`). Existing
  pages keep their historical URLs this way — don't change a published slug.

## Branding tokens

Use the brand tokens instead of hardcoding the product name — the app is
white-labeled (`VITE_BRAND_NAME`):

```mdx
import { BRAND_NAME } from '~/lib/branding';

{BRAND_NAME} provisions bare metal…
```

In **frontmatter** (plain YAML, not JSX), write the literal token
`{BRAND_NAME}` inside a quoted string — the manifest substitutes it at load
time.

## Voice

These docs are also the product's shop window. Every page runs two registers:

1. **The opener sells** — one or two sentences on what the feature _enables_,
   written for an evaluator ("Reinstall the OS, keep your data — spare disks
   survive reprovisions intact."). Confident, concrete, never vague.
2. **The body instructs** — plain-language discipline borrowed from controlled
   language standards, without their vocabulary straitjacket:
   - One term, one meaning. Use the glossary's word for a concept and never a
     synonym ("bridge", not sometimes "spoke agent"; "layer", never "image").
   - Procedures: active voice, present tense, one instruction per sentence.
   - Warnings and prerequisites come _before_ the step they protect, not after.
   - Short sentences in procedural content; the leash loosens in conceptual
     openers, never in steps.

Ground every claim in the actual behavior of the code — no aspirational
features. Anything half-built is marked "(in development)" or omitted. A
false or unverifiable claim is a defect, same severity as a broken build.
