# Documentation style guide

The target voice is the one used by HashiCorp, Stripe, and the Google developer
documentation style guide: plain, declarative, and skimmable. The reader is a
practitioner evaluating or operating the platform. They are already here; the
docs describe, they do not sell.

Run `node apps/docs/scripts/prose-lint.mjs` to check content against the
mechanical rules below.

## Voice

- Second person for the reader ("you"), present tense, active voice.
- Open every page and every section with a plain topic sentence that states
  what the thing is or what the reader will do. No scene-setting, no hook.
- One idea per sentence. Aim for an average under 20 words. When a sentence
  needs a hinge to work, split it into two sentences.
- Say it once. If a fact is stated in a table, do not restate it in prose.

## Punctuation budget

- **Em-dashes: at most one per page, and prefer zero.** Replace with a comma,
  a period, or parentheses. If the aside matters, it deserves its own sentence.
- No "X — not Y" reversals. State the fact, then state the contrast as its own
  sentence if the contrast is load-bearing.
- Colons are fine before lists and definitions. Avoid the setup-colon-payoff
  sentence as a recurring rhythm.
- Semicolons sparingly; two short sentences are almost always better.

## Patterns to delete on sight

These are the tells that make prose read as machine-written. The linter flags
most of them.

| Pattern                 | Example (from our own docs)                                     | Fix                                                                                                       |
| ----------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Em-dash aside           | "pulls jobs from the hub — outbound only — over Redis"          | Own sentence: "The bridge pulls jobs from the hub over Redis. It makes only outbound connections."        |
| Contrastive punchline   | "phone-home proves it booted — not the saga claiming success"   | "The phone-home call is the proof of success. A completed saga alone does not change the status."         |
| Padded triplet          | "rentable, API-driven, multi-tenant platform"                   | Only enumerate real, complete lists. Two items are fine. Attributes usually belong in separate sentences. |
| Negative litany         | "no key escrow, no recovery backdoor, and nothing to hand over" | "There is no key escrow and no recovery mechanism." Stop at what is true and necessary.                   |
| Counting headings       | "Five product surfaces", "Three ways to start"                  | "Product surfaces", "Where to start". The count is trivia.                                                |
| Decoder-ring cleverness | "or nothing at all — rent from an operator who already runs it" | "If you prefer not to operate the platform, rent servers from an operator who does."                      |
| Benefit-selling         | "your hardware becomes a rentable platform you own"             | Describe the mechanism, not the aspiration.                                                               |
| Uniform emphasis        | every sentence lands a punchline                                | Write flat sentences by default. One deliberate emphasis per page is worth more than thirty.              |

Banned words and phrases: "seamless", "seamlessly", "robust", "powerful",
"simply", "just works", "under the hood", "think of it as", "isn't just",
"not just", "that's it", "real steel".

## Terminology

### Product names vs architectural names

Each component has a product name and an architectural name. They are not
interchangeable.

| Component             | Product name          | Architectural name |
| --------------------- | --------------------- | ------------------ |
| Central control plane | **Brokkr**            | hub                |
| Zone service          | **the Bridge**        | spoke              |
| Device-side service   | **Brokkr Live Agent** | agent              |

- Use the product name when naming the component as an actor: "Brokkr
  publishes the DHCP configuration", "the Bridge serves TFTP", "the Brokkr
  Live Agent wipes the disks".
- Use the architectural name when describing topology or roles: "a
  hub-and-spoke architecture", "the Bridge is the zone's spoke", "one hub,
  many spokes".
- Pair them once per page at first mention when the page discusses
  architecture: "Brokkr (the hub)", "the Bridge (the spoke)".
- Product names are capitalized. Architectural names are lowercase.
- Code identifiers, image names, and env vars stay as written in code
  (`hydrahost/brokkr-hub`, `BRIDGE_HOSTNAME`).

### General rules

- One name per concept, everywhere: **zone** (not datacenter or site),
  **server**, **device**, **deployment** as defined in the glossary. Never
  rotate synonyms for variety.
- Bold a term at its first definition on a page. After that, plain text.
- Code font for literals only: commands, paths, env vars, states like
  `PROVISIONING`.

## Page titles

Titles are short noun phrases, roughly 35 characters or less: "Disk layouts",
"Network boot", "The sim lab". No colon subtitles ("The Sim Lab: Scenarios,
Fleet Builder, and Bare-Metal Mode") — the enumeration belongs in the
`description`, which cards and search already display. The title is also the
sidebar label and inbound link text, so it must scan as a single line.

## Frontmatter

Every page declares YAML frontmatter, compiled to a `frontmatter` export by
remark-mdx-frontmatter and read by the docs manifest
(`apps/web/src/lib/docs-manifest.ts`):

```yaml
---
title: Deploy the hub
description: One-line summary shown on cards and under search
section: self-host # key from SECTIONS in the manifest
order: 2 # position within the section
slug: deploy-hub # optional; defaults to the content-relative path
---
```

Adding a page is adding an `.mdx` file: no route, sidebar, or manifest change.
A new section must be added to `SECTIONS` in the manifest.

## Structure

- Each page answers one question. Lead with what the reader can do or needs to
  know; put rationale after mechanics.
- Use the `<Note>` and `<Warning>` callout components for caveats. They are in
  scope on every docs page with no import. Never write `**Warning:**` prefix
  paragraphs or dramatize caveats inline. Both accept an optional `title` prop.
- Callout bodies are prose paragraphs only. A markdown list inside a callout
  breaks the MDX compiler after Prettier reformats it; write the items as
  sentences instead.
- Link at the point of need. End-of-section "Read [X] and [Y]." lines are fine.
- Tables for enumerable facts. Fragments are acceptable in table cells, never
  in body prose.

## The read-aloud test

Read the paragraph to a colleague. If any sentence would sound rehearsed or
performative said out loud, flatten it. Documentation succeeds when nobody
notices the writing.
