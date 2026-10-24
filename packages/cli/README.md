# @usecontextlayer/cli

Create and deploy ContextLayer slates, and connect accounts with the `ctx` CLI.

The [domain model](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#domain-model) defines slates, declarations, resources, Owners, and assignments.

Use Node.js 24 or newer, pnpm, and Git. Git author identity must be configured; initialization displays Git's configuration instructions when it is missing.

Start with login, then create and run your slate:

```sh
npx @usecontextlayer/cli login
npx @usecontextlayer/cli init my-slate
cd my-slate
pnpm dev
```

Approve login in your browser. Initialization uses the complete starter bundled with the CLI and commits it on `main`, with local state already ignored. Open the local URL printed by the development server. Initialization prints your slate's dashboard link and hosted URL; the hosted URL becomes usable after a successful Git push deployment.

The checkout's README explains local development, connections, and deployment. The [SDK guide](https://www.npmjs.com/package/@usecontextlayer/sdk) describes loaders, tools, and the shared app layout.

Connect an account to ContextLayer in your browser, then assign the connected account to a connection declared by your slate. Already connected accounts can go directly to assignment. The SDK's Gmail recipe includes this full sequence.

Command syntax and options live in the CLI's help:

```sh
npx @usecontextlayer/cli --help
```

The starter is already committed. Deploy it from the checkout’s `main` branch with `git push -u origin main`. After making changes, commit them before pushing:

```sh
git add .
git commit
git push -u origin main
```

The native Git remote starts ContextLayer's build and deployment pipeline.
