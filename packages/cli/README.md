# @usecontextlayer/cli

Create and deploy ContextLayer slates, and connect accounts with the `ctx` CLI.

The [domain model](https://github.com/usecontextlayer/contextlayer/blob/main/ARCHITECTURE.md#domain-model) defines slates, declarations, resources, Owners, and assignments.

Use a Node.js release supported by this package’s `engines` field, pnpm, and Git. The bundled Cloudflare client shares that Node requirement. Git author identity must be configured; initialization displays Git's configuration instructions when it is missing.

Start with login, then create and run your slate:

```sh
npx @usecontextlayer/cli login
npx @usecontextlayer/cli init my-slate
cd my-slate
pnpm dev
```

Approve login in your browser. Initialization uses the complete starter bundled with the CLI and commits it on `main`, with local state already ignored. Open the local URL printed by the development server. Initialization prints your slate's dashboard link and hosted URL; the hosted URL becomes usable after a successful Git push deployment.

The checkout's README explains local development, connections, and deployment. The [SDK guide](https://www.npmjs.com/package/@usecontextlayer/sdk) describes loaders, tools, and the shared app layout.

Connect an account to ContextLayer in your browser, then assign the connected account to a connection declared by your slate. Already connected accounts can go directly to assignment.

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

After a push, inspect CI through the CLI’s CI entry point and compare its source revision with the commit tag on the published Worker. Native Workflow status describes pipeline execution; Worker metadata describes the published script. Neither identifies the revision that answered an individual HTTP request. Use the CI and Worker help for native inspection commands; Cloudflare credentials and a separate Cloudflare installation are unnecessary.
