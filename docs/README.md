# ContextLayer docs

This directory contains the ContextLayer documentation site, built with Mintlify and published at [docs.usecontextlayer.com](https://docs.usecontextlayer.com) from `main`.

For contribution rules, read [AGENTS.md](AGENTS.md) together with the repository's [documentation guidance](../DOCS.md).

## Find the source

| File or directory | Purpose |
| --- | --- |
| `index.mdx` | The site's overview page. This README is not a site page. |
| `installation.mdx` and `quickstart.mdx` | Initial setup and the first deployed slate. |
| `core-concepts/` | The product model: slates, ownership, accounts, and resources. |
| `how-to/` | Task-oriented walkthroughs. |
| `reference/` | SDK contracts and integration details. |
| `docs.json` | Site configuration, navigation, and the generated OpenAPI reference source. |
| `logo/` and `favicon.png` | Shared site branding assets. |

A page's path relative to this directory determines its URL. Its `title` and `description` live in YAML front matter. Add the page to `docs.json` when it should appear in the sidebar.

## Preview changes

Run the preview from this directory:

```sh
npx mint@latest dev
```

Open the local URL printed by Mintlify. Check the edited page's prose, code blocks, tables, and components in the rendered view, along with its sidebar and on-page navigation.

## Validate changes

From this directory, run both checks:

```sh
npx mint@latest validate
npx mint@latest broken-links
```

The first validates the documentation build; the second checks links. Both should pass before publishing changes. For page components, use [Mintlify's component documentation](https://www.mintlify.com/docs/components/index).
