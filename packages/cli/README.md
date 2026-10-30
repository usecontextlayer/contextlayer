# @usecontextlayer/cli

Create and deploy ContextLayer slates, and connect accounts with the `ctx` CLI.

The [domain model](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#domain-model) defines slates, declarations, resources, Owners, and assignments.

Use a Node.js release supported by this package’s `engines` field, pnpm, and Git. Git author identity must be configured; initialization displays Git's configuration instructions when it is missing.

Start with login, then create and run your slate:

```sh
npx @usecontextlayer/cli login
npx @usecontextlayer/cli init my-slate --scaffold-app
cd my-slate
pnpm dev
```

Approve login in your browser. This quickstart selects the bundled app starter, installs its dependencies, and commits it with its lockfile on `main`, with local state already ignored. Plain initialization creates an empty Git checkout with a short `AGENTS.md`; app, public files, agents, and MCP source are optional. Open the local URL printed by the development server. Initialization prints your slate's dashboard link and hosted URL; the hosted URL becomes usable after a successful Git push deployment.

The app starter's README explains local development, connections, and deployment. Use `npx @usecontextlayer/cli scaffold --help` to add source later. Integrate any printed conflict proposal with your authoring agent. When dependencies change, run `pnpm install` and commit `pnpm-lock.yaml` with the integrated source. The [scaffolding contract](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#slate-source-scaffolding) explains source ownership and conflict handling. The [SDK guide](https://www.npmjs.com/package/@usecontextlayer/sdk) describes loaders, tools, and the shared app layout.

Connect an account to ContextLayer in your browser, then assign the connected account to a connection declared by your slate. Already connected accounts can go directly to assignment.

The generic API command discovers operations from the configured platform's live OpenAPI document. Its help describes saved-login behavior. Command syntax and options live in the CLI's help:

```sh
npx @usecontextlayer/cli --help
```

Initialization has already committed the checkout. Deploy it from `main` with `git push -u origin main`. After making changes, commit them before pushing:

```sh
git add .
git commit
git push -u origin main
```

The native Git remote starts ContextLayer's build and deployment pipeline.

After pushing, follow the [deployment guide](https://docs.usecontextlayer.com/how-to/deploy) to inspect the build and published revision. Use CLI help for the CI and Worker entry points.
