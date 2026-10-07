# Your ContextLayer app

This React Router app uses ContextLayer for connected services and is published through its Git remote.

## Develop locally

From this directory, run:

```sh
pnpm dev
```

Open the local URL printed by the development server. Edit `app/routes/home.tsx` to build your first page. Use `pnpm typecheck` and `pnpm build` for the app's normal TypeScript and production-build commands.

## Use connected services

Declare the services your app needs in `public/slate.json`. Authorization connects your account to ContextLayer; assignment binds that account to one of your app's declared connection slugs. Approve authorization in your browser, then use the local assignment chooser to select the account. An already connected account can go directly to assignment. Command help supplies the supported operations:

```sh
npx @usecontextlayer/cli connections --help
npx @usecontextlayer/cli connection --help
```

The installed SDK guide at `node_modules/@usecontextlayer/sdk/README.md` gives the complete Gmail sequence: copy its route and declaration, authorize Gmail when needed, assign `work-email`, and start development. Local account choices are saved in ignored `.contextlayer/connections.json`. Restart `pnpm dev` after changing declarations or local assignments.

## Publish

Commit your changes and push the generated `main` branch:

```sh
git add .
git commit
git push -u origin main
```

ContextLayer builds and deploys the app through its native Git remote. Your dashboard and hosted URL were printed by initialization. The hosted URL becomes usable after deployment succeeds. The app starts private; sign in with your ContextLayer account to open it. Hosted account selection uses the app's ContextLayer header.
