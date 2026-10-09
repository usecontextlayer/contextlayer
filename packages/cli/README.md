# @usecontextlayer/cli

Create, connect, and publish ContextLayer apps with the `ctx` CLI.

Use Node.js 24 or newer, pnpm, and Git. Git author identity must be configured; initialization displays Git's configuration instructions when it is missing.

Start with login, then create and run your app:

```sh
npx @usecontextlayer/cli login
npx @usecontextlayer/cli init my-app
cd my-app
pnpm dev
```

Approve login in your browser. Open the local URL printed by the development server. Initialization prints your app's dashboard link and hosted URL; the hosted URL becomes usable after a successful Git push deployment.

The generated app's README explains local development, connections, and publication. The [SDK guide](https://www.npmjs.com/package/@usecontextlayer/sdk) describes loaders, tools, and the shared app layout.

Authorization connects a service account to ContextLayer; assignment binds it to a connection slug declared by your app. After approving authorization in your browser, use the assignment command to choose the account. Already connected accounts can go directly to assignment. The SDK's Gmail recipe includes this full sequence.

Command syntax and options live in the CLI's help:

```sh
npx @usecontextlayer/cli --help
```

Publish from the generated app's `main` branch:

```sh
git add .
git commit
git push -u origin main
```

The native Git remote starts ContextLayer's build and deployment pipeline.
