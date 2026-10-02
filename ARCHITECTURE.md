# Architecture

The repository contains three private packages:

- `db-infra` — Postgres/Kysely connections, migrations, and ephemeral database helpers.
- `shared` — Authentication, token handling, test helpers, and Sentry event capping.
- `twilio` — Twilio Functions for founder call routing and answer screening.
