# ContextLayer docs

This directory is the ContextLayer documentation site, built on [Mintlify](https://mintlify.com) and published at https://docs.usecontextlayer.com from `main`. The repository's root `AGENTS.md` and `DOCS.md` still apply here; this file adds what is specific to the docs site.

- Pages are MDX files with YAML front matter (`title`, `description`); a page's URL is its path under this directory. `README.md` is ignored by Mintlify; the landing page is `index.mdx`.
- `docs.json` holds the site settings and the whole navigation. A page that is not listed there does not appear in the sidebar.
- Command syntax belongs in the CLI's `--help` and endpoint shapes belong in the OpenAPI document that generates the API reference; a docs page explains and walks through, it does not duplicate either.
- Preview with `npx mint@latest dev` from this directory; run `npx mint@latest validate` and `npx mint@latest broken-links` before committing. `docs.json` is formatted by the repository's biome configuration.
- For Mintlify's components, configuration and writing standards, install its skill: `npx skills add https://mintlify.com/docs`. Its MCP server for editing is `https://mcp.mintlify.com`.
