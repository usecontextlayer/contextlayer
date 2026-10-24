<div align="center">

# contextlayer

The platform for bespoke software.

[![CI](https://github.com/usecontextlayer/contextlayer/actions/workflows/check.yml/badge.svg)](https://github.com/usecontextlayer/contextlayer/actions/workflows/check.yml) [![CLI version](https://img.shields.io/npm/v/@usecontextlayer/cli)](https://www.npmjs.com/package/@usecontextlayer/cli) [![License](https://img.shields.io/badge/license-BUSL--1.1-blue)](LICENSE)

</div>

Build software around the way you work—with interfaces for people, agents that get things done, and connections to the tools you already use.

We call these **slates**. A slate brings your app, agents, and resources together in one Git repo. It can be a tool for one person or a shared workspace for a team.

Think [Heroku](https://www.heroku.com/) for bespoke software: write React and TypeScript, define your agents, and deploy with Git. ContextLayer provides sign-in, connected accounts, databases, and scheduled execution.

## Build your first slate

You'll need Node.js 24+, [pnpm](https://pnpm.io/), and Git with your author identity configured.

```sh
# Sign in, create a slate, and run it locally
npx @usecontextlayer/cli login
npx @usecontextlayer/cli init my-slate
cd my-slate
pnpm dev
```

Approve login in your browser, then open the local URL printed by the development server. Edit `app/routes/home.tsx` to build your first screen. When you're ready, stop the server and deploy:

```sh
# Commit and push to build and deploy
git add .
git commit
git push -u origin main
```

Initialization prints your dashboard link and hosted URL. The hosted URL becomes available after deployment succeeds. New slates are private; sign in to open yours.

- **Your existing tools** — read and write connected services such as Gmail and Slack without implementing provider OAuth in your app.
- **Apps and agents together** — put agent instructions alongside your app and let both use the same connections and databases.
- **Personal or shared data** — use each member's accounts and database, the slate owner's resources, or a mix of both.
- **Ordinary code** — build with [React Router](https://reactrouter.com/), TypeScript, and SQL. Use your editor and coding agent. Push to deploy on [Cloudflare Workers](https://developers.cloudflare.com/workers/).

## A slate for follow-ups

You could build a slate where a scheduled agent reads each team member's Gmail, finds messages needing attention, and saves them to a database. A React app presents the follow-ups for that person to review and act on. The agent does the background work; the person gets an interface built for the job.

The app and agent declare the same database and use the same stored records. Each member can have their own inbox and follow-ups, while the organization supplies the agent's model credential. Database records persist across agent jobs.

The pieces live together:

```text
app/                                  # Screens, loaders, and actions
public/slate.json                     # Resources the app uses
agents/follow-ups/instructions.md     # What the agent does
agents/follow-ups/slate.json          # Resources the agent uses
agents/follow-ups/schedules/daily.md  # Cron schedule and task prompt
databases/follow-ups/                 # Kysely config, migrations, and query types
```

Declare a resource with `viewer` mode to select the person using the slate, or `owner` mode to select the slate's owning person or organization. Apps and agents that declare the same database slug and mode share its data. ContextLayer provisions the databases and applies your committed Kysely migrations.

## Connect it to your tools

A Gmail connection in `public/slate.json` looks like this:

```json
{
  "connections": {
    "work-email": { "mode": "viewer", "toolkit": "gmail" }
  },
  "secrets": {}
}
```

Once an account is connected and assigned, a React Router loader can read its inbox:

```ts
import { toolsContext } from "@usecontextlayer/sdk"
import type { LoaderFunctionArgs } from "react-router"

export async function loader({ context }: LoaderFunctionArgs) {
  return context.get(toolsContext).call("work-email", "GMAIL_FETCH_EMAILS", {
    max_results: 5,
    label_ids: ["INBOX"],
    include_payload: false,
    verbose: false,
  })
}
```

The [Gmail walkthrough](packages/sdk/README.md#a-loader-that-reads-gmail) includes account setup, response validation, and a working inbox screen. The [database example](packages/sdk/README.md#a-loader-that-queries-cached-data) shows how to query stored records with Kysely. Locally, you use your own connected accounts and local database state; hosted assignments are configured separately.

## What else can a slate do?

Agents can run on a schedule or through an HTTP API, with instructions and resource requirements committed alongside the app. See [authored agents](ARCHITECTURE.md#authored-agents) and [agent setup](DEVELOPING.md#deploying-and-inspecting-an-agent).

Slates can also expose MCP tools and interactive views to MCP clients. Shared connections, databases, and secrets currently work in apps and agents; authored MCP handlers do not yet support them. See [MCP tools and views](ARCHITECTURE.md#authored-mcp-tools-and-views).

Private slates belong to a person or organization; private organization slates are available to that organization's members. Public slates support viewing by anyone, but cannot use viewer-mode resources. See [access and ownership](ARCHITECTURE.md#platform-storage-and-request-flow).

For more, start with the [CLI guide](packages/cli/README.md) or [SDK guide](packages/sdk/README.md). To work on ContextLayer itself, see [development setup](DEVELOPING.md) and [architecture](ARCHITECTURE.md).

[Business Source License 1.1](LICENSE). The [CLI](packages/cli/LICENSE) and [SDK](packages/sdk/LICENSE) are MIT licensed.
