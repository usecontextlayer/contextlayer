# Architecture

## Domain model

### Slates, consumers, and checkouts

A slate has an app (its interactive part), agents, mcps, workflows (planned), and resources; resources are connections, databases, and secrets.

Apps, agents, and mcps are the consumers of resources.

The local copy of a slate is its checkout.

A slate's name is its hostname label, with no separate display-name column.

### Declarations, resources, and configuration

A declaration is the file (`slate.json`) in which a consumer names the resources it requires.

`Resources` is the slate-wide collection of requirements with consumer metadata.

`SlateResourceConfiguration` adds canonical Owners, saved account references, database references and viewer-mode secret presence to those requirements; a configuration can still have missing inputs.

A connection is declared by slug, toolkit, and mode; an account is a Composio connected account holding provider credentials.

An assignment maps a connection slug to an account ID, hosted or local; the actions are connect an account and assign it to a connection.

### Owners, run actors, and membership

`Owner` is the canonical organization-or-personal identity that owns a slate or resource, with `organization` and `personal` as its type values; `owner` and `viewer` are declaration modes for selecting a resource Owner in hosted execution.

A run actor is the app or a person a job acts for, independently of resource ownership.

A slate member is the stored slate-to-person relationship established after complete resource setup, independently of background database and schedule provisioning; an organization member has a separate web-owned organization membership.

### Revisions and declaration snapshots

A revision is one commit of the slate's repository; the trusted boundary that initiates an operation selects exactly one, and every source-derived input the operation prepares or applies comes from it.

A declaration snapshot is the coherent read of a revision's app and agent declarations and agent trees, and it carries that revision.

Keep these concepts distinct in configuration and execution.

## Slate forking, membership, and resource ownership

Git-powered forking must be a core capability of the slate model. Users must be able to take an existing slate as a starting point and independently adapt its code and behavior while preserving its source lineage. The platform must support forking, slate membership, and resource ownership as orthogonal concepts that compose. Shared slates and independently customized slates must both fit the same domain model.

Forking combined with AI must enable customized slates to continue receiving upstream improvements. Git must preserve the upstream relationship and shared history so changes can be identified and merged; AI should help resolve conflicts and adapt upstream changes to the fork's customized code while preserving the intent of its customizations. This is why forking is central to the slate model: users should be able to make a slate their own and continue benefiting from fixes, features, and improvements to the slate they started from. Independent customization and continued upstream evolution must be supported together.

| Concept | Responsibility |
| --- | --- |
| Forking | Independent control over a slate's code and behavior, with Git lineage and AI-assisted integration of upstream improvements. |
| Slate membership | The relationship between a slate and the people who use it. |
| Resource ownership | Ownership of credentials, connected accounts, and documents, with access governed by resource authorization and connection assignments. |

Forking must use Git to create an independently customizable slate while preserving source ancestry. A fork must have its own slate identity and repository, with its own ownership and membership context. Its Owner may be the same as the source slate's Owner or a different personal or organization Owner. A fork must support one or many slate members, just as any other slate does. Git lineage must describe the relationship between codebases; it must not determine slate membership or resource access.

Slate membership must allow multiple people to use the same slate without requiring separate code forks. Member-specific resources should support personal state within a shared slate. Independent changes to slate code should be expressed through forking rather than through membership. Forking must not replace membership, and membership must not prevent forking.

Credentials and connected accounts must belong to their personal or organization Owner independently of any slate, code lineage or slate membership. Slates may share authorized connected accounts without sharing control of their code. A code fork must not copy credentials, transfer stored data or grant access to the source slate's resources; its [databases](#slate-databases-and-authored-migrations) have their own slate identity even when Owner and slugs are unchanged.

Forks and shared slates must use the same resource-selection and execution semantics. An agent's unattended scope must continue to derive from its own actor-dependent requirements, independently of whether its slate is a fork or how many members use it. Forking, membership, and resource sharing should let people choose independent code customization, shared slate use, and shared resources without making any one choice determine the others.

## System ownership

### Package responsibilities

The packages have these responsibilities:

- `cli` — Public `@usecontextlayer/cli` package providing the `ctx` executable. It ships a complete slate starter and uses `create-react-router` to instantiate it. The starter’s SDK and CLI dependencies move with the release; ContextLayer owns starter content and platform provisioning, while React Router owns template copying, installation and the initial Git commit.
- `sdk` — Public `@usecontextlayer/sdk` integration: shared React Router document Layout, reusable HTML page shells for standalone MCP servers, Tools and Databases interfaces and React Router contexts, slate request handling, local auxiliary Worker, and authored MCP tool/View builds through Vite. Subpath exports keep React UI, Vite/Node imports, and Worker runtime imports separate.
- `db-infra` — Postgres/Kysely connections and migration infrastructure.
- `dev-env` — Private implementation of the DevEnv: the checkout-local ContextLayer runtime and setup shared with web. Use DevEnv in prose and PascalCase identifiers, devEnv in camelCase identifiers, DEV_ENV in uppercase constants, and dev-env in paths and package names. It owns database initialization, native service startup, DevEnv configuration composition and slate checkout preparation with workspace packages; callers supply application-owned migrations and compose returned connection facts. Runtime applications do not depend on it. Root `pnpm dev:seed`, `pnpm dev`, `pnpm dev:ctx`, `pnpm dev:env` and Vitest are its consumers. Web owns the SQL template for its development records; DevEnv applies it using checked-in fixture data shared with CLI and test configuration. The existing `@usecontextlayer/cli/auth` operations own saved credentials, issuer/client matching, refresh and authenticated identity/membership reads; production CLI and DevEnv callers pass explicit issuer/client and credential-directory settings into them. Interactive login remains a CLI command.
- `shared` — Shared resource contracts, Worker capabilities, and usage metering.
- `twilio` — Twilio Functions for founder call routing and answer screening.
- `platform` — Cloudflare Workers application: an Artifacts Git proxy under `/git`, OpenAPI endpoints under `/api`, and the React Router dashboard under `/dashboard`.

- `build` — Cloudflare Worker using `@cloudflare/ci` and Workflows to build, migrate and deploy commits pushed to Artifacts in isolated Sandbox runners.

- `dispatcher` — Cloudflare Worker that resolves public hostnames through the platform API and invokes the WfP Worker named by SlateID.

- `auth` — Worker that owns viewer sign-in on the user-code domain.

- `mcp-microsoft-planner-premium` — Standalone Planner Premium MCP Worker using Dataverse queries for reads and the Schedule API for writes. Microsoft owns consent, token issuance and data semantics; Composio owns credential storage and refresh. Its Microsoft-issued Dataverse tokens are outside the Better Auth resource model in [OAuth resources and scopes](#oauth-resources-and-scopes); no ContextLayer slate is involved. [Planner's package guidance](packages/mcp-microsoft-planner-premium/AGENTS.md#authentication-and-connection-ownership) owns native data contracts, connection isolation and credential-forwarding rules.

### Multiple consumers

Almost every user-facing platform capability is exposed through OpenAPI so the web dashboard, CLI, and a future MCP consumer share the same product operations. Zod owns their input and output contracts. A shared domain function owns each operation’s business logic, authorization, and database calls; API handlers adapt it to HTTP and React Router loaders/actions invoke it directly in-process. UI components own presentation and interaction. This is a standing design rule, not a claim that every future CLI command or MCP surface exists today. Better Auth owns its native authentication protocols; product APIs consume the resulting verified identity.

The CLI's `ctx api` consumer must use the selected platform's live OpenAPI document, preserving its operation identifiers and contracts. Interpretation of domain outcomes belongs to the caller. Publishing an operation must not require a per-operation CLI definition or a separate command catalog.

## Trust and authority

### Security boundary: trusted services and authored slates — principles

These principles define the security boundary the system must uphold; they are requirements, not assertions that every protection is implemented today.

Treat web, platform, auth, dispatcher, and the build Worker's Workflow orchestration as trusted ContextLayer services, and authored browser code, user Workers and everything running inside a build sandbox as untrusted. The same boundary must apply in hosted slates and local development. Serving ContextLayer UI inside an authored app must not grant that app trusted authority.

Build sandboxes are intended to execute untrusted slate code, including dependencies, build scripts, and migrations. Treat all code inside a sandbox as able to use everything supplied to it; trusted platform code must scope its access to the resources and operations needed for that job.

Credential classes must remain separate across trusted services. The [identity and access contracts](#identity-and-access) define management and viewer authority; a shared user identity must not erase the boundary between them.

Hosted authored slates should receive only explicitly delegated runtime capabilities bound to the canonical slate and viewer. Local authored slates should receive only runtime capabilities bound to their selected local resources, with personal-account authority derived from the verified developer. A tool-execution capability must authorize only its permitted runtime operation, without granting permission to connect or assign accounts, access general organization operations, or forward arbitrary authenticated API requests. Trusted services must hold credentials and enforce authorization; user code should receive only the capability and its permitted result.

Untrusted browser code and user Workers must never receive reusable ContextLayer management credentials. Fetching authored content, including `/slate.json`, must not carry web session cookies or CLI access tokens, including across redirects. Private content must still require viewing authorization without disclosing the caller's management credential. Trusted auth must own viewer-session changes; authored responses must not create, replace, or clear ContextLayer authentication cookies.

### Authority model — principles

Authority means the operations and resources a verified caller or delegated runtime capability is permitted to use. The system must establish that authority at a trusted preparation boundary and carry its scoped result into execution. Interfaces and domain signatures must exclude inputs that would let a caller substitute a different credential Owner, declaration source, or assignment. Source revision selection follows its own [trusted boundary](#source-revision-and-declaration-authority). Reshape existing platform interfaces when necessary to remove those choices; do not preserve an ambiguous local-or-hosted execution operation and compensate with provenance flags or permission branches.

Personal-account discovery and execution must derive their resource Owner from the verified caller's user identity. Neither HTTP requests nor execution-facing domain callers may supply an Owner, organization, or declaration that changes this derivation. A requested account ID selects an account within that personal scope; it must never select the identity or confer account authority. Slate access, subscription, and usage context must remain separate from credential ownership.

Hosted preparation must own coherent pushed declaration selection, consumer selection, resource Owner derivation, and hosted assignment resolution under the canonical authorized slate and run actor. A caller may request an operation through the delegated runtime interface, but must not replace its declaration, selected Owner, or resolved assignment. Pure collection and consumer selection remain shared functions; trusted preparation owns the I/O and authorization rather than making each downstream consumer reread declarations or decide authority independently.

Common provider execution should receive an already scoped native Composio session plus the tool and arguments. Session creation belongs to the trusted personal or hosted preparation path, which fixes identity, declared toolkit, and account pinning before execution. Provider execution has no responsibility for choosing slate, viewer, developer, or resource Owner. It must preserve native action arguments and Composio response semantics. Account ownership enforcement remains at the provider boundary. A low-level session helper must not become a public execution operation accepting an arbitrary Owner.

Native authentication route composition must keep personal-account operations under native web or authorized CLI authentication and exclude viewer cookies. Hosted runtime delegation retains its limited slate/viewer authority; it must not authenticate personal-account management operations. Explicit Owner-management operations are separate: a personal Owner must match the verified caller, and an organization Owner requires membership supplied by web through that caller's existing credential. This authorization must precede provider I/O.

## Identity and access

### Platform and web: ownership and dataflow

Web owns Better Auth users, sessions, organizations, and organization memberships. Platform owns slate membership as the separate slate-to-user relationship. Platform owns slates and their authorization. Platform stores the owning user or organization ID, without copying web's identity or membership records. A browser session cookie is a signed opaque session identifier; platform does not extract identity from it or verify it with another session secret.

Platform must preserve the verified credential's authority in `AuthIdentity`, the closed union of `OwnerIdentity` and `ViewerIdentity`. Native web sessions and OAuth tokens verified for the platform resource with `platform:access` produce owner identities; viewer sessions and OAuth tokens verified for a canonical slate MCP resource with `mcp:access` produce viewer identities. OAuth identities retain their opaque credential, verified claims, and verified resource. Management domain operations must require owner identity; viewing operations may accept either. Owner identity establishes the credential's management authority, not ownership of an arbitrary slate or resource: the existing ownership and membership predicates still decide access. A shared user ID must never promote viewer authority into owner authority.

Verified identity and its opaque credential must travel together into domain operations. Management APIs require native web sessions or authorized CLI credentials and reject viewer cookies. Viewer-cookie acceptance is limited to slate resolution and the narrow [organization membership read](#viewer-organization-membership); general profile and organization reads require native web or CLI credentials. Viewer credentials must not contain reusable management credentials or be replayable as native web sessions; rejecting a cookie name alone does not establish that separation. Profile reads follow the [web-owned profile contract](#chrome-profile-reads).

Unauthenticated API and Git requests receive an authentication failure. Dashboard sign-in redirects apply only to GET requests that prefer HTML; other requests retain the authentication failure. Negotiate this through `Accept`, not the request body's `Content-Type`. Web's native sign-in and trusted-origin validation own the return to platform; platform must not introduce another callback protocol. Production reuses web's native Better Auth cross-subdomain cookie on `usecontextlayer.com` and trusts the platform sign-in return origin.

CSRF protection follows identity verification and uses the verified credential kind. Cookie and viewer-session authenticated form mutations must pass Hono's native Origin or Sec-Fetch-Site checks. Verified bearer requests do not require browser origin metadata. Requests without verified identity reach the existing authentication boundary and its sign-in response or 401 challenge.

For management requests, when platform needs user-scoped web facts such as organization memberships, it forwards the same user's authorized native web cookie or CLI access token. Web authenticates the caller and returns authoritative facts through its authenticated endpoint; platform applies its own slate rules to those facts. These requests do not use a machine-to-machine credential. Better Auth owns credential verification and session revocation; platform owns the resulting slate-access decision.

### OAuth resources and scopes

An OAuth **resource** identifies the API a token is intended for. A **scope** names a permission within that API. The resource answers “where may this token be used?”; the scope answers “what access was granted?” Better Auth owns these concepts: a resource's `identifier` is requested through the OAuth `resource` parameter and becomes the token's `aud` claim; its `allowedScopes` lists the permissions it permits.

| API | Canonical resource identifier / token audience | Access scope |
| --- | --- | --- |
| Platform | `https://platform.usecontextlayer.com` in every environment | `platform:access` |
| A slate's MCP server | Its canonical `https://<slate-hostname>/mcp` URL | `mcp:access` |

Use one canonical URI spelling consistently in registration, authorization requests, discovery and verification. Platform has one logical resource identifier across development, tests and production, independent of its network address. Local environments use their own web issuer and signing keys; signature and issuer verification keep their tokens separate from production. Scope names stay the same across environments and slates; the audience identifies the intended API. `offline_access` keeps its standard meaning for refresh-token issuance. These two access scopes express the existing permissions; finer-grained permissions require a product requirement.

The issuer identifies web's authorization server; the resource identifies the protected API; the client ID identifies the requesting application. Keep those facts distinct. Web's platform profile and membership reads participate in the same logical platform resource even though web serves those endpoints. Resource identity does not change to the address of whichever process performs verification. Service URLs, bound ports and Worker bindings are connection facts. `CTX_PLATFORM_URL` selects where to send platform requests; it never defines the OAuth resource. Keep the platform resource constant in the protocol configuration. Derive each MCP resource from the stored slate hostname according to MCP’s canonical-server-URI rules. Request Host and forwarded headers do not define token authority.

Verify signature, issuer, expiry, subject, audience and required scope before applying existing ownership, membership and billing policy. A slate token cannot gain platform authority from a shared user ID or the generic word “access.” A common `mcp:access` scope works across slates because their audiences differ. Preserve verified authority in the identity passed to authorization. This OAuth use of “resource” names a protected API; it is distinct from an MCP content resource or a declared connection, database, or secret.

These conventions follow [OAuth resource indicators](https://www.rfc-editor.org/rfc/rfc8707.html#section-2), [OAuth scope semantics](https://www.rfc-editor.org/rfc/rfc6749.html#section-3.3), [Better Auth's resource model](https://better-auth.com/docs/plugins/oauth-provider#resources), and [MCP's canonical server URI](https://modelcontextprotocol.io/specification/latest/basic/authorization#canonical-server-uri). Registration and migration procedure belongs in [DEVELOPING.md](DEVELOPING.md#oauth-registration-and-migration).

### Viewer organization membership

Private organization viewing must select the membership read by verified identity authority. Owner identities use web's platform organization records. Viewer identities can obtain only `{isMember}` about the canonical slate's owning organization, not general organization access or management authority. An MCP viewer's membership read must preserve its slate-bound bearer credential and verified resource so web verifies the same audience and scope; viewer sessions use their native cookie path. Web verifies the caller, remains the membership authority, and returns the fact without response caching. Slate resolution and delegated execution share this read and apply the same pure viewing rule. No memberships are copied into platform or the viewer cookie, and the native session/logout lifecycle remains authoritative.

### Viewer sign-in boundary — principles

Web's Better Auth should own the user's identity and web session, and auth should own viewer sign-in on the user-code domain. Viewer sign-in must identify the same user without copying a reusable web session credential into the authored-slate domain. Viewer authority must be limited to viewing and explicitly delegated slate runtime operations and must not authenticate web/platform management requests.

Viewer sign-in must preserve the [trusted-service boundary](#security-boundary-trusted-services-and-authored-slates--principles). The resulting identity is used by the [shared viewing rule](#platform-storage-and-request-flow), including for declaration retrieval.

### CLI authentication

CLI login must use OAuth device authorization through web’s existing Better Auth OAuth provider. The browser identity approving the code determines whose credentials are saved; web owns impersonation. `openid-client` owns device requests, polling and refresh. Tokens target the canonical platform resource with `platform:access`, as defined above.

Each process independently selects its server through the issuer/client/platform settings and one saved login through `CTX_CONFIG_DIR`. The selected directory contains one `auth.json`, defaulting to `~/.contextlayer/auth.json`; it must not introduce another account registry or per-server hierarchy inside that directory. Login, credential reads and refresh must use the same explicitly supplied directory. DevEnv commands and fixtures must select the checkout-local CLI directory, overriding an inherited personal selection. Selecting a login directory must not relocate authored-slate connection assignments or database state. The saved issuer and client must match the selected registration before a token is used or refreshed.

Protected CLI commands must share authentication and login guidance at the CLI boundary. Mismatch guidance must identify the saved and expected registration and preserve the selected issuer, client, credential directory and platform URL in its repair command. The selected CLI invocation must execute both Git authentication and login repair: public use retains its pinned package release, while the DevEnv retains the checkout runner. Repair must preserve a non-default account directory after the DevEnv runner composes its defaults. Shell syntax belongs at that output boundary. Local declaration listing remains independent of login; authenticated operations use the [shared authority and access rules](#identity-and-access).

After successful login, the CLI configures Git authentication globally for the OS user, scoped to that platform's Git URLs. Public registrations retain the login release independently of the slate's installed dependencies, with npm owning package resolution and cache recovery. DevEnv registrations retain the checkout runner and its shared settings composer. Both must record explicit issuer, client, absolute login directory and platform URL so later pushes do not depend on the invoking shell or runner defaults. Configuration stores the invocation and settings, never tokens or versioned Node installation paths. Git owns URL matching and HTTP authentication; the helper uses the CLI's existing token loading and refresh, with no second credential store. Registration belongs to login so cloning works before a checkout exists; init only sets the repository's immutable remote. Logging in again replaces that platform's helper while retaining Git's empty inherited-helper reset.

## Resources and source coherence

### Resource configuration and execution — principles

One shared declaration model must feed all consumers. The [resource contract](#key-contract-slate-resource-requirements) owns schema, namespace and consumer selection. One pure resolution rule must report missing inputs from the configuration it receives; [membership](#membership-creation-and-provisioning) applies it to whole-slate completeness, while execution applies it only to the selected consumer.

Local inputs must be applied at the local construction boundary before consumer selection. Resources must reflect the current checkout's validated declarations; local connection assignments, environment-supplied secrets and developer-local database references are assembled there before consumers receive them. Resources remains the collected requirements value; resolved assignments, database references and secret values are execution inputs, not authored requirements. Consumers must not reread local files or environment variables, apply local overrides, or look up hosted assignments after selection. Shared schemas, collection, selection and provider primitives serve both environments; environment-specific I/O and authority belong at their respective boundaries.

Local connections must always use the signed-in developer's personal accounts, regardless of slate ownership or the declaration's viewer/owner mode. Platform must derive that personal Owner from verified authentication and independently authorize the narrowly requested toolkit/account before provider work. Neither a local declaration nor an account ID grants access to another user or organization's accounts. Save development assignments from connection slug to account ID in an ignored checkout-local map; do not read or write hosted assignments to resolve or save local assignments. Composio retains provider credentials.

Local secret values must come exclusively from developer-local environment variables. Local databases must use the same SQLite-backed Durable Object class and authored Kysely migrations as hosted execution, with persisted state in ignored checkout-local storage. Native Kysely migration execution follows the [database contract](#slate-databases-and-authored-migrations) against local storage. Local resolution must never use platform vault values, hosted databases or hosted configuration as a fallback. Pushing authored declarations and migrations does not deploy development state or environment values.

Hosted resource resolution must derive the canonical Owner from the pushed declaration and authorized actor: viewer selects the acting user's personal Owner, and owner selects the slate's owning user or organization. An app actor has no personal Owner; app actors and public viewers must be refused viewer-mode resources independently of stored membership. Platform owns hosted connection assignments; hosted secrets reference the existing Owner/name vault model, and databases follow the same ownership selection. Hosted runtime delegation may permit an authorized viewer to execute a slate's owner-mode requirement without granting general Owner account or vault management. Local personal-account execution retains the separate [authority path](#authority-model--principles).

### Key contract: slate resource requirements

The author owns the app's declaration in `public/slate.json` and each agent's declaration in `agents/{name}/slate.json`, all using the same shared schema. The framework serves the app declaration at `/slate.json`. Do not add a custom resource route, copied root declaration or separate requirements store.

The shared declaration schema describes connections by slug, toolkit and mode, databases by slug and mode, and secrets by name and mode. The same schema and mode vocabulary must serve CLI, SDK and platform. Database slugs must identify one migration-directory segment; local and hosted validation must agree. A declaration names requirements, never physical database instances or provider credentials.

Resource keys form one slate-wide namespace per resource kind across consumer declarations. Repeated connection requirements must agree on mode and toolkit; repeated database and secret requirements must agree on mode. Conflicts are validation errors, with no file precedence or inheritance. Collection must retain which consumers require each resource. Inventory and initial membership use the full collection; execution selects only the app or named agent being run. Consumer selection is pure: it preserves requirement metadata and already-configured inputs without rereading sources, applying overrides or mutating authored declarations.

A running slate's static `/slate.json` is a deployed asset available under viewing authorization; it must not become a second authoritative hosted declaration source. Hosted operations use the [repository revision contract](#source-revision-and-declaration-authority).

### Source revision and declaration authority

Every hosted operation must select its source revision once, at the trusted boundary that initiates it, and every source-derived input it prepares or applies must come from that revision. The revision names a commit of that slate's own repository; no HTTP caller or authored code supplies it. Latest-state operations, including resource configuration, interactive tool and database execution, API and scheduled agent preparation, and membership, resolve the latest commit on `main` at their preparation boundary; a push-triggered build uses the commit the push delivered. Selecting the revision and reading it are separate steps. Platform authorization precedes the read; the reader resolves no branch of its own. The guarantee is consistency within one operation, not agreement between operations: the deployed Worker and a later latest-state operation can be at different revisions. Repository declaration reads must bypass authored Workers, public dispatch and clips metering, keeping credentials inside trusted services. A repository without a commit on `main` is the typed `no-commit` setup condition, distinct from a committed slate with no resource requirements. Configuration consumers must report that setup condition rather than treating it as empty requirements. Platform must never accept caller-supplied local declarations or Resources as hosted authority, including from slate Owners. API and scheduled agent runs are hosted executions even when their caller is a developer; neither may use that developer's local declarations, assignments or environment.

Platform owns a shared repository declaration reader that accepts the selected immutable revision. It accepts no caller credentials and validates and collects declarations without resolving resource values, provisioning instances or starting jobs. The snapshot retains revision and agent-tree information needed for instruction and schedule reads. Migration files follow a separate read path: the isolated migration runner checks out the same revision and Kysely loads them there. Resource configuration consumers receive the collected requirements without needing a source or commit flag.

### Hosted resource configuration

Hosted inventory must expose the full configuration under slate-viewing authorization, from the selected declaration snapshot. Shared assembly owns canonical Owners, saved account references, database references and viewer-secret presence, preserving consumer metadata. Inventory, connection listing, the missing-input resolver and chrome consume projections of that same configuration. A names-only vault read is required only when the configuration includes viewer-mode secrets; owner-mode secrets carry no presence field. Presence neither validates nor loads a value, and a database reference does not claim provisioning or readiness. Connected-account catalogs remain separate Owner-authorized operations.

Configuration contracts must derive from the shared declaration and resource model. Connection-only views are projections of that configuration, not another model, and must not cause unrelated secret reads. Local configuration can contain environment values and developer-local database references, so it must remain in trusted tooling and never become a browser or platform request payload.

### Composio Platform connected accounts

Connected-account management follows the shared [Owner-management authority](#authority-model--principles) and uses that same Owner for connecting, listing and declaration-selected execution, with no separate Composio user mapping. Catalogs expose only eligible ACTIVE accounts, consistently across all pages; consumers must not reinterpret unfinished provider lifecycle states. The person completing OAuth for an organization manages the account for that organization, not as its personal Owner. Composio owns credentials, refresh and the private account's OAuth lifecycle. The project key stays on platform and never becomes a CLI credential. This supports Composio Platform only; existing For You accounts are not imported. Local discovery and execution retain the developer's personal scope under the [authority model](#authority-model--principles), even when that developer is an organization member.

**Load-bearing security invariant:** platform must derive Composio's session `user_id` from the authorized canonical credential Owner, never from a caller-supplied connected-account ID. Tool execution must stay inside that Owner-scoped session. We rely on Composio enforcing that an explicitly pinned private account belongs to the session user; saving an account ID must not grant authority over another user's private account. Any change to the execution path must preserve this ownership enforcement. See [Composio's session creation contract](https://docs.composio.dev/reference/api-reference/tool-router/postToolRouterSession).

### Owner-owned shared secrets

Shared secrets must belong to the canonical personal or organization `Owner`, independently of slate ownership. Secret management follows the shared [Owner-management authority](#authority-model--principles). Managing an Owner's secrets must remain independent of any slate lookup, slate membership or subscription.

Doppler must own hosted vault storage; see [Owner vault configuration](packages/platform/AGENTS.md#owner-vault-configuration) for development and production setup. Platform alone constructs provider keys and selects the vault; clients must never select keys or configs or receive the vault token. Vault configuration is required for viewer-secret presence reads, trusted value loading and mutations. Owner-only configuration must not list vault names; unrelated platform operations remain independent of vault configuration. The config-scoped token covers the vault, so platform authorization must enforce Owner isolation. Stored values must enter only trusted execution, never an HTTP read operation or logs; provider failures expose only the operation and status. Local development uses the separate [input sources](#resource-configuration-and-execution--principles).

Slate-aware secret supply must select its canonical Owner from the coherent pushed declaration and reuse Owner-scoped authorization and storage. It follows the [shared membership and partial-save rule](#membership-creation-and-provisioning). Owner-scoped set/drop remains independent of slate enrollment. Chrome consumes shared presence metadata without loading stored values.

CLI secret management must use the same verified Owner and authorization as other trusted consumers. Secret entry must be masked when interactive, and values and provider credentials must stay out of CLI output. The CLI must never receive the vault token; command help owns input and Owner-selection syntax.

### Owner-scoped connection assignment storage

Hosted assignment must use the coherent pushed requirement and its canonical credential Owner. Viewer assignment requires slate viewing; owner assignment requires management by the owning user or an owning-organization member. After persistence, API and chrome follow the same [membership and partial-save rule](#membership-creation-and-provisioning). Connecting a provider account remains independent of assigning its account ID.

The hosted assignment key identifies slate, Owner and resource. Toolkit and mode remain in the declaration. Local development uses separate local assignment storage under the [resource input rules](#resource-configuration-and-execution--principles), not an environment dimension in hosted assignments.

## Slate membership and unattended execution

### Membership creation and provisioning

Slate membership must supply the people participating in the slate; [the domain model](#domain-model) owns its vocabulary. Membership and unattended execution must remain separate concepts: membership supplies people, while each agent's own requirements determine its unattended execution scope. A slate may have members with no unattended agents, only app-scoped agents, or a mixture. Agent requirement changes must not change membership.

Membership creation must require a committed declaration snapshot whose full app-and-agent configuration resolves without unassigned connections or missing viewer-mode secrets. Saving a declared connection assignment, supplying a declared secret through the slate-aware operation, and first use requiring viewer-mode resources must all attempt membership through that same domain owner and pure configuration resolver. An intermediate assignment or secret save must remain successful when another input is missing. Owner-only requests must resolve their own inputs without creating membership or depending on unrelated personal setup. Creation must not automatically establish membership for the creator. Existing membership must survive later missing configuration; each request must report missing inputs from its own requirements. Membership must enable unattended participation without a separate opt-in and must grant neither viewing nor source-management authority.

Platform must store one membership per slate and person. One membership operation owns completeness checking, insertion and starting background provisioning. The unique insert commits membership, then the inserting request awaits creation of the member-provisioning Workflow with its prepared snapshot and continues without waiting for execution. The Workflow migrates the person's viewer-mode databases and then installs their schedules. Membership remains established while provisioning runs or fails; requests have no provisioning gate or pending-state affordance. Only a newly established relationship may install initial personal databases and schedules; repeated use or configuration saves must not reinstall them. A build must independently migrate and reschedule the app actor and existing members at its own commit. Membership creation must not submit a job, and public slates must never acquire membership. No explicit join HTTP route or CLI command may bypass completed setup.

### Unattended execution scope

An agent requiring any `viewer` resource must be member-scoped for unattended execution. An agent requiring zero `viewer` resources must be app-scoped. This derivation must consider all actor-dependent requirements, including connections, secrets, and databases. Unattended scope must be derived from requirements rather than independently configured or stored as a separate execution-target setting.

| Concept | Meaning |
| --- | --- |
| Unattended scope | Derived from the agent's requirements: `app` or `member`. |
| Run actor | The concrete app or slate member that one run acts for. |
| Resource mode | Selects the resource Owner under the [resource configuration rules](#resource-configuration-and-execution--principles), independently of unattended scope. |

App-scoped unattended execution must run once for the app, with the app itself as actor and no acting person or invented system user. Member-scoped unattended execution must run for slate members, with each run acting for a particular member. Stored slate membership must supply the actors for member-scoped execution and must carry no agent scope setting. Membership determines who participates; the agent's requirements determine its unattended scope.

Hosted resource ownership must remain orthogonal to unattended execution scope. A member-scoped agent may read a member's Gmail, use the organization's model credential, and write to that member's slate-specific priorities database. An app-scoped run has no member against whom a viewer resource could resolve; deriving scope from requirements excludes that incompatible combination.

The derivation must use the agent's own requirements, independently of the app's requirements. The app may use `viewer` resources while its unattended agent requires only `owner` resources and runs once for the app. Unattended scope must not determine interactive app identity or redefine manually requested job behavior.

```text
Agent requirements → unattended scope
  app    → one run acting for the app
  member → slate membership supplies members → runs acting for particular members

Run actor + resource declaration → selected resource
```

## Execution and durable data

### Authored agents

Named agents have standing instructions in the slate's repository. Reading an agent definition is independent of its build or deployment and requires the same source-management authority as Git, including for public slates. The repository remains the source of authored instructions.

Hosted execution must separate the authorized trigger, prepared run and native execution. A trigger supplies a canonical slate, explicit app/user actor and user prompt; preparation applies the [resource rules](#resource-configuration-and-execution--principles) to the selected agent. The prepared run carries instructions, source revision, resource references and actor, with caller credentials and secret values excluded from persisted configuration. Manually requested jobs, catalog discovery and ordinary operation/result access follow private-slate viewing authorization. Source reads, rich execution inspection, schedule inspection and lifecycle mutations require source-management authority because their payloads can reveal authored prompts, tool arguments and results.

A job is an independent execution with its own prepared run and fresh conversation. Catalog identity, operation identity and session identity are distinct: the catalog locates the job, its receipt identifies the initial operation, and sessions belong to that job. Prepared configuration remains bound to the job so later submissions cannot change its resources. Catalog discovery must remain independent of execution state; native Pi records own submissions, transcripts, results and recovery rather than a second application ledger. Ordinary results exclude transcripts.

The stable agent scope owns catalog admission, schedules and deletion; the independent job owns execution. Authorized resolution must provide the job capability directly to the operation that uses it, without making the parent mirror every execution method. Capabilities and physical addresses remain server-side. Admission must make a job discoverable only with its native receipt; catalog metadata records actor and trigger provenance rather than copied execution status.

Hosted model selection must reuse declared-secret Owner resolution, independently of API-key ownership. Pi must own the selected model in conversation state: new jobs read current configuration, while existing conversations retain their selection. A default applies only when the model is undeclared; a declared missing or unavailable model must fail without substitution. Model identity may appear in native execution records; API-key values must remain private.

Hosted execution has three separate lifetimes: durable conversation records, ephemeral computer files/processes and persistent declared databases. API and scheduled jobs must share fresh-computer ownership, and direct and Code Mode tool calls must share that job's computer and resource authority. Deleting a job must release its computer without deleting declared databases or reversing external effects. Neither conversation durability nor completed-record reload establishes recovery of a stopped computer.

Agents use the same [resource authority](#authority-model--principles) and [SQL capability](#slate-databases-and-authored-migrations) as apps. Pi owns agent tool discovery and execution; model-authored code receives only prepared capabilities. Loader/action Tools retain their [billing policy](#slate-owner-billing-access); job billing requires a separately agreed implementation. Platform's [agent runtime rules](packages/platform/AGENTS.md#hosted-agent-runtime) guide native integration; its Zod/OpenAPI schemas own API fields and responses.

### Agent schedule lifecycle

Git is the schedule authoring authority. Installation uses the initiating build or membership snapshot under their [phase-ordering contracts](#build-pipeline), with each agent's requirements determining its [unattended scope](#unattended-execution-scope). Each firing prepares a fresh job for its stored actor from the latest coherent snapshot through the same preparation and admission path as API execution; schedule payloads carry no revision. The native scheduler owns timing and recurrence, and runtime inspection must not introduce another configuration store. Platform's [schedule provisioning rules](packages/platform/AGENTS.md#agent-schedule-provisioning) own parsing, native callback management and cancellation behavior.

### Slate databases and authored migrations

Declaring a hosted database must be sufficient configuration. Platform derives each instance centrally from `(SlateID, canonical Owner, declared slug)` in one platform-owned SQLite-backed Durable Object class, without database assignments or a picker. Two slates with the same Owner and slug have separate databases; agreeing app and agent declarations within one slate select the same database. Deployment migrates owner-mode databases for the app actor even with no members, together with existing members' viewer-mode databases. Initial membership migrates the person's viewer-mode databases. Both lifecycles use the shared phases and initiating revision under the [source](#source-revision-and-declaration-authority) and [build-ordering](#build-pipeline) contracts. Artifacts owns source; Durable Objects own persistent slate data.

Explicitly authored Kysely migrations are the database change source. Each database keeps its migrations and its own native Kysely CLI configuration under `databases/<slug>`; that configuration selects the logical database, and ContextLayer supplies the connection behind it: local storage during development, the platform-selected instance inside the hosted migration runner. Kysely owns migration ordering, loading and the applied-migration ledger in each instance; ContextLayer must not add a parallel migration system, a wrapper command or a second ledger. Query types are derived from the migrated database by a separate generation command; generation never applies migrations, and setup never infers DDL from types. Builds and membership apply the checked-in history with Kysely's native semantics: a failed migration leaves its earlier statements applied and itself absent from the ledger, and it stops the build or provisioning that ran it. The system performs no automatic rollback. During local startup, pending migrations must finish before app or agent queries.

Build hosts one shared, platform-controlled migration runner for pushes and initial membership. Its [runner rules](packages/build/AGENTS.md#migration-runner) own workspace preparation, sandbox lifetime and sequential target execution. Kysely owns migration loading and history; the SQLite Durable Object owns SQL execution and stored data; platform owns authority. Platform fixes the operation's permitted instance set in trusted runner configuration before any command starts. Trusted outbound code selects each statement's target only from that set, never from an authored physical database identity. The sandbox receives no storage binding, credential or means of addressing an instance outside that scope, and never the viewer-delegated runtime query operation, which can itself initiate membership. The local CLI has no path to hosted databases.

Installed build workspaces may be reused by later provisioning only for the same slate and exact revision. Reuse restores the pre-migration workspace into a fresh sandbox; each provisioning operation receives its own trusted database targets. Workspace reuse grants no additional database authority and must not carry a previous member's migration state. When no usable build snapshot exists, membership provisioning checks out that revision and installs dependencies without install scripts; it neither waits for nor runs a build. Cold preparation does not reproduce build-generated files, so migration inputs must be available from checked-in source and installed dependencies for provisioning to succeed without a snapshot.

Apps and agents must execute SQL through the same storage capability, using only prepared database references. Authored calls name declared slugs and provide parameterized SQL; physical selectors, the database namespace, provisioning and reusable credentials remain trusted. The SDK's typed Kysely interface is a dialect over that same capability, not a second query path; direct SQL remains available. Database lifetime follows the [job/data distinction](#authored-agents), and local execution follows the [local input boundary](#resource-configuration-and-execution--principles).

## Build and publication

### Build pipeline

Pushing a slate’s `main` branch starts the build Workflow. The Artifacts repository name is the SlateID, and the pushed commit must identify every phase's input: declaration preparation, build, migrations, publication and schedules. Platform owns actor and database selection and schedule installation; Build owns phase ordering. The Workflow must supply the trusted SlateID and commit to platform through `PROVISIONING`, then carry the same prepared value through migration and schedule provisioning.

The Workflow must prepare provisioning, build, migrate, publish and install schedules in that order. It applies the [database provisioning targets and migration semantics](#slate-databases-and-authored-migrations) to its selected snapshot. A failed migration stops publication without automatic retries; earlier SQL statements may already have committed. Pushed migrations must therefore remain compatible with the currently deployed Worker until publication completes. These ordering guarantees apply within one Workflow instance; builds of different commits are independent.

Authored build and migration code must run without reusable storage or deployment credentials. R2 is the handoff boundary: the Workflow selects a run-specific artifact prefix and issues temporary storage credentials scoped to that prefix, with object read/write access for the build and separate object read-only access for publication. Neither credential grants access outside that prefix or authority to issue further credentials; the parent R2 credential pair remains with the trusted Worker. The build snapshot belongs to migration execution; publication consumes compiled server modules and client assets from the build output folder.

Each publishing attempt must own a fresh platform-controlled Sandbox with no authored checkout or restored workspace, and destroy it when the attempt finishes. Artifact preparation must finish before the deployment credential is supplied, and only the platform-owned Wrangler upload command may receive it. Treat compiled code as upload data: the publisher must never execute authored modules, dependencies or build hooks. Downloaded contents must remain in a payload directory below the clean execution root, without restoring links or replacing platform tools or configuration. Platform owns the complete deployment configuration outside that payload, canonical SlateID and dispatch namespace; authored configuration and environment files must have no authority over publication. The only upload-time resource binding is `ASSETS`; the publisher must never create or upload secrets. These boundaries prevent an author's build, artifact or configuration from exercising the platform's deployment authority.

### Slate build inspection

Cloudflare Workflows must remain the owner of slate CI instance IDs, statuses, attempts, timings, errors, outputs and retention. The shared build Workflow's original Artifacts input identifies its slate. Management-authorized inspection must select native instances from that input, including when filtering shared Workflow pages; it must not introduce another execution record, state vocabulary or log store. Pagination applies to shared candidates before authorization filtering, so an empty authorized page does not establish that history is exhausted. Published-script inspection must read the native WfP script named by canonical SlateID. The trusted build commit must accompany the same script upload in custom metadata tags, independently of authored configuration or version annotations; neither the latest pushed commit nor a completed Workflow establishes the currently published revision. Script metadata does not identify the revision that answered an individual HTTP request.

Platform must authenticate normal management credentials and authorize the selected slate before invoking Build's private inspection entrypoint. Build must retain upstream Cloudflare credentials and restrict forwarding to the configured account, Workflow, dispatch namespace and canonical script. Only authorized native instance list rows and the selected published script's native metadata may cross this boundary. Native instance details are private ownership inputs: they must never become an author-facing response, including through direct API requests or error handling. Public visibility and viewer credentials must not grant inspection authority, and shared-page aggregate counts must not disclose other slates.

The inspection boundary must exclude instance parameters, steps, attempts, execution error text and command output from every phase, including trusted publication. Withholding those records avoids relying on string redaction to make arbitrary output safe. Native list rows retain execution state and timing metadata but contain no source Git SHA; `version_id` identifies the Workflow version. Published-script inspection retains the full native metadata response, including optional runtime, observability, placement and tail-consumer configuration, without returning script source, secret values or command output. Existing internal pipeline diagnostics remain private; inspection must not require additional log persistence, dependency patches or an execution/log store.

The public CLI must ship the pinned, unmodified native Cloudflare client and use its native commands and output with the normal ContextLayer login and refresh. ContextLayer supplies the scoped endpoint and resource selection; Cloudflare owns the inspection contracts and presentation.

### Worker deployment and secrets

Cloudflare Workers Builds owns repository-driven deployment of ContextLayer's service Workers. They must all use the same repository-root build/deploy workflow; [Service deployment](DEVELOPING.md#service-deployment) owns the package selection and operating instructions. This is separate from the build Worker's authored-slate deployment pipeline. Doppler owns centrally managed deployment secret values; each Worker's effective Wrangler configuration owns its required secret names through native `secrets.required`, including an explicit empty list when no secrets are needed. The shared deployment workflow connects these owners and must not maintain another secret allowlist.

The config-scoped read-only Doppler bootstrap token and private registry credential stay in the Workers Builds environment. Deployment selects only the Worker's declared runtime secrets and supplies them alongside code through native Wrangler deployment; Cloudflare holds deployed copies, while Doppler remains their source. The build Worker's snapshot and authored-slate deployment credentials follow this delivery boundary and the [build pipeline's isolation rules](#build-pipeline).

## Consumer entry points

### Platform storage and request flow

Each slate must have exactly one canonical personal or organization Owner and an immutable SlateID. Its public hostname is independent of that identity. Visibility is platform configuration, separate from ownership and the authored declaration; new slates are private. Changing visibility must not change ownership or grant management permission.

Personal creation must select the verified user as Owner; organization creation must resolve the organization and verify membership through web before writing. Creation establishes the slate record and an Artifacts repository named by its SlateID. The CLI must authenticate before scaffolding and configure the created slate's Git remote. API and dashboard consumers must share the same creation, listing and management operations.

The viewing rule allows anybody to view public slates, the owning user to view private personal slates, and members of the owning organization to view private organization slates. Management and Git source access require the owning user or an owning-organization member regardless of visibility. Organization membership checks use the slate's owning organization regardless of the session's selected organization. These rules apply consistently to resolution, resource configuration and delegated execution.

Platform owns hostname resolution and its authorization decision; dispatcher consumes that decision for browser requests and MCP. Resolution returns the canonical SlateID and Owner. Viewing and management predicates remain pure; their calling domain operations obtain authoritative membership facts from web. Public OAuth resource metadata remains separate from viewing authorization. The [identity and access contracts](#identity-and-access) define which credentials each boundary accepts.

Listing must return only slates manageable by the verified caller and obtain their latest main-branch commits from Artifacts.

Public hostname assignment must reserve `local`, because it selects the current checkout in the CLI, and `auth`, because it belongs to the auth-forwarding Worker. Neither can identify a slate.

Git clients use the immutable `/git/<slate-id>` endpoint. Management authorization must precede repository access or minting credentials. The Git service determines read versus write credentials: upload-pack reads and receive-pack writes, including their GET discovery requests. HTTP method alone does not identify a write. Artifacts credentials stay server-side, and pushes do not create slate records.

### Hosted-slate routing

Dispatcher asks platform to resolve each requested hostname and apply the [shared viewing rule](#platform-storage-and-request-flow), including for declaration retrieval. On success it invokes the selected slate Worker with only explicitly delegated capabilities; required browser sign-in redirects through auth with the original request URL, while other failures pass through. It strips ContextLayer authentication credentials before authored execution and prevents authored responses from changing ContextLayer authentication cookies. The [MCP surface](#authored-mcp-tools-and-views) has separate discovery and bearer authentication.

Browser request isolation belongs to dispatcher, before slate resolution and capability delegation. Fetch Metadata must admit same-origin requests, direct user navigation, and top-level GET navigation; same-site sibling origins are untrusted. Other cross-origin browser requests must stop before authored execution and metering. Requests without Fetch Metadata remain supported for non-browser clients. Top-level navigation may execute authored loaders and their side effects; this is the accepted navigation behavior, not a guarantee that all externally initiated work is prevented. Browser responses, including assets, must retain authored CSP while adding `frame-ancestors 'self'; base-uri 'self'; object-src 'none'`, and must strip every authored `Set-Cookie` for `ctx-viewer-auth` while preserving ordinary slate cookies. The browser policy must leave external images and ordinary browser networking available; it does not establish egress isolation. Authored document viewers must use alternatives to `<object>` and `<embed>`. MCP retains its separate bearer-only boundary.

[Dispatcher guidance](packages/dispatcher/AGENTS.md#deployment-configuration) owns routing configuration; [service deployment](DEVELOPING.md#service-deployment) owns the cross-service operating workflow.

### Slate tool calls and local development — agreed contract

#### Authored MCP tools and Views

An authored MCP tool has its own definition, execution handler and resource declaration. Web routes and MCP handlers are separate surfaces that may share slate modules. Views are separate artifacts, and several tools may reference the same View. MCP declarations use the shared schema, but the SDK build and dispatcher currently reject nonempty connections, databases or secrets. Resource execution is implemented for apps and agents.

The SDK evaluates definitions during the authored build and produces the tool manifest and self-contained View assets. Trusted dispatch consumes those artifacts without importing or evaluating authored modules. Shared native MCP schemas and the canonical declaration schema validate the artifact.

Slate creation registers the canonical MCP resource through web's trusted provisioning operation and returns successfully only after provisioning succeeds. Web owns the OAuth resource and allowed scopes; deployment and local setup must supply matching provisioning authority to the two services.

MCP follows the [OAuth resource and scope contract](#oauth-resources-and-scopes) through its separate bearer-only boundary. Public discovery describes the canonical resource and issuer but grants no slate access. Native OAuth challenges pass back without browser sign-in redirects. Web's native OAuth Provider and CIMD own discovered client identities, human consent, PKCE exchange and refresh.

Authorized calls use the native MCP SDK lifecycle and invoke the selected authored handler with validated arguments, without forwarding caller credentials. Trusted dispatch validates the result and records one tool execution under the [usage policy](#slate-owner-billing-access); discovery, resource reads and tool calls remain outside ordinary HTTP loader/action metering.

The View receives inputs and results and requests tool calls through the host's MCP Apps bridge. It does not receive ContextLayer credentials or fetch the slate's cookie-gated web routes. Serving its self-contained HTML as an authenticated MCP resource keeps rendering separate from slate-origin navigation.

#### Local tools

Local and hosted execution share the authored Tools interface and provider primitives, with configuration and authorization composed at their respective trusted entrypoints under the [resource rules](#resource-configuration-and-execution--principles). Local and hosted entrypoints remain separate typed capabilities.

The pure shared tools contract owns the HTTP tool-result schema used by both platform OpenAPI and Worker response parsing. Consumers must neither duplicate that schema nor import Worker entrypoints to obtain it.

The SDK owns Vite development-server composition; CLI tooling owns checkout resource preparation, local database connections and saved-login access. Local migrations, codegen and agents must share that connection implementation. Vite owns migration startup, hosted migration connections must load independently of local development tooling, and codegen remains explicitly local. Generated project files contain thin wiring; runtime and Vite behavior live in packages.

Git origin may identify the slate for access and billing, but it must not select pushed requirements or hosted assignments. A local tool request uses independently authorized personal-account execution and must require management of the slate whose Owner is billed; public viewing is insufficient.

The development-only auxiliary Worker holds the selected app connection inputs, canonical slate context and CLI access token. Unrelated secrets, database inputs and agent-only connections must not enter its Tools capability. Its token is a startup snapshot: no refresh token is copied into the Worker, and no continuously refreshing local authentication service is involved. The Worker and its token binding are excluded from production builds. Local startup metadata and credentials must never become authored browser or Worker configuration, and local browser origins must not gain credentialed web/platform access through blanket localhost trust.

#### Platform tool execution

Hosted Tools and Databases enter platform only through the private Execution service binding, with no public HTTP execution route. The binding grants transport authority; the viewer credential passed as data establishes identity. Request-scoped capabilities bind the canonical slate and viewer so authored code cannot read the credential or substitute another slate or person. Platform applies the shared [authority](#authority-model--principles), [resource preparation](#resource-configuration-and-execution--principles), [membership](#membership-creation-and-provisioning) and [billing](#slate-owner-billing-access) contracts before execution. Authored app behavior cannot replace this trusted authorization boundary.

The toolkit for hosted execution comes from the validated declaration, never inferred from an assigned account ID. Provider execution follows the [scoped-session contract](#authority-model--principles).

App actors and public viewers requiring viewer resources receive `forbidden`, independently of stored membership. The hosted Tools and Databases capabilities throw ordinary `Error` objects for `forbidden` and `not-declared`. A declared connection without an account assignment must be reported as `connection-required` with its slug, distinct from an undeclared resource (`not-declared`). A missing viewer-mode secret must be reported as `secret-required` with its name. Shared Zod schemas must own these safe payloads. Hosted Tools and Databases must preserve them as native HTTP 409 Responses over Cloudflare RPC, and SDK adapters must throw them in the authored app so its route error boundary can handle setup guidance. Authored error handling must preserve these Responses through any intervening data-access layer. Local Tools must use the same connection-refusal contract for missing startup assignments. Missing setup must stop before provider execution or tool usage recording; unrelated failures must remain exceptions. Successful tool calls must retain `{ data, logId }`. Account catalogs and credentials must stay in their trusted owners.

#### Local agent execution

The CLI owns local agent execution, with the checkout root as the working directory and the same prepared local database state used by the app. Claude Agent SDK owns execution and native Claude authentication. The SDK's native preset supplies base runtime instructions; platform instructions and then authored instructions extend it, while the task remains separate user input. Automatic user/project settings and CLAUDE.md loading are disabled; native managed policies still apply. SDK failures must surface. The SDK is loaded only for agent execution and remains an external runtime dependency so its matching Claude executable can resolve normally. [Local development](DEVELOPING.md#running-an-agent-locally) owns invocation and prerequisites.

### Slate chrome

The chrome is the trusted header and tray served by platform in an iframe. The SDK's `Layout` is the React Router document component that embeds it, not another name for the chrome. The authored app retains its routes, stylesheet and independent styling. Chrome UI and styling belong to platform, not another SDK stylesheet, ShadowRoot or system-data loader.

The chrome should read identity, connection configuration and personal secret requirements inside the chrome's iframe, through the same authorized domain operations used by other trusted consumers. These reads must bypass authored loaders, Workers, and clips metering.

#### Cross-site chrome authentication — principles

The chrome must run in an iframe on a trusted origin: `platform.usecontextlayer.com`, `frame.usecontextlayer.com`, or `usecontextlayer.com`, isolated from the authored parent. Shadow DOM isolates styles, not JavaScript authority. An authenticated same-origin relay available to chrome is equally available to authored page scripts and must not expose management operations. Private slate entry should leave chrome authenticated as the same viewer automatically, without an additional popup sign-in step. Its session flow must work across the site boundary to `contextlayer.xyz` while preserving that isolation.

Better Auth should own identity verification and session revocation. The chrome's iframe should authenticate directly with the native web session, and web logout must invalidate its authentication. Native session cookies must use Secure, HttpOnly, and SameSite=None in every environment. Credentials must remain in trusted documents and services; the authored parent must receive neither credentials nor profile/connection data. Browser third-party-cookie policy must be respected; cookie attributes and CSP must not be treated as a way to override it.

CSP must restrict the chrome's frame ancestors to the exact canonical HTTPS origin of its target slate. The canonical slate must also supply the presentation-message parent origin; caller-supplied origins grant no embedding permission. Other dashboard documents must deny framing. The chrome's iframe should forbid object embeds and base-URL changes. Frame forms must submit to the trusted platform origin while permitting the native provider authorization redirects. Cookie-authenticated form mutations must reject cross-site submissions through the framework's native CSRF protection. Better Auth's origin checks must remain enabled, and authored origins must not gain credentialed CORS access to web or platform. The parent/frame boundary carries only presentation data, such as height. Cross-origin messages must validate the sending origin, source window and payload; a matching origin alone does not identify the frame.

#### Chrome profile reads

Web owns the safe current-user profile contract, available through native web or authorized CLI credentials without response caching. Trusted consumers call web directly; platform must not add a profile proxy. The CLI derives web's origin from its configured issuer, and chrome reads profile data inside its frame. The SDK and dispatcher expose no Viewer capability or profile context to authored code.

#### Chrome resource configuration

Chrome owns the browser interaction for connection configuration and personal secret supply, using the [shared hosted configuration](#hosted-resource-configuration). Connected-account catalogs and credential mutations require Owner authorization; slate inventory requires viewing authorization. Account labels remain live presentation data rather than another persisted model. Authored SDK/runtime code exposes neither account catalogs nor connection-read capabilities.

Chrome uses the coherent pushed snapshot and its own verified browser identity. It is disabled in local development; checkout declarations, local assignments and environment values must not enter its frame or configuration operations. Local setup uses the [CLI tooling boundary](#local-tools).

### Dashboard account controls

Web owns session listing, switching and sign-out. The dashboard must use native Better Auth operations rather than introduce parallel platform endpoints. After a confirmed account switch, it navigates to Personal with history replacement and loads the new user's authorized slate list. Adding an account returns through web's existing sign-in page.

The URL selects dashboard Owner: `/dashboard/personal/slates` selects the verified user's personal Owner, `/dashboard/org/<organization-slug>/slates` selects an organization, and `/dashboard` starts in Personal. Personal is a real Owner variant, never a null organization. Resolve organization choices against web's authoritative records using the caller's credential, and use the stable organization ID for slate access. Display metadata must derive from the canonical Owner. Do not mutate the session's active organization; tabs may select different Owners independently.

Owner filters narrow an already-authorized listing and never grant access. Omitting a filter lists all manageable slates. Dashboard and API consumers share the [management and listing rules](#platform-storage-and-request-flow); neither may introduce a separate ownership model or authorization path.

### Development environment

DevEnvs share the Polar account, catalog and baseline customer entitlements while choosing web database storage independently. Each selected web database receives the same deterministic user, organization, membership and public OAuth registration from a checked-in fixture. Matching user and organization IDs make those separate web databases refer to the same Polar customers; sharing billing identity must not require sharing database rows. Explicit setup owns applying the fixture and ensuring provider state. Repeated setup must reuse existing provider resources, requiring operator input when they cannot be matched reliably. The baseline Owners hold private zero-price Unlimited subscriptions, keeping ordinary development independent of finite Free allowances while public Free, Pro and Ultra retain their billing meanings.

Fixture insertion prepares ordinary Better Auth records through a web-owned SQL template. Runtime authentication, signup, organization creation, sessions and grants retain their native owners. The fixed public client ID identifies a registration in each database; issuer verification and database-local credentials keep authentication separate across running web services. CLI OAuth credentials remain owned by the CLI; viewer handoff and slate-scoped OAuth grants retain their actual protocols. [Authentication fixture guidance](TESTING.md#fixtures-and-resource-ownership) owns test setup and session cleanup.

Local platform development and integration Workers must use remote Cloudflare resources isolated from production. Native Wrangler environments and framework configuration select bindings before requests run; runtime callers must not select namespaces or override this boundary.

DevEnv startup must publish the selected connection facts it owns: the four service URLs, the fixed public CLI client ID and both selected database URLs in the checkout’s ignored `.env.json`. Saved OAuth credentials remain in the selected login directory. DevEnv commands and test fixtures must consume that same record through shared typed composition, deriving the issuer and checkout-local credential directory without repeating provider discovery. Shell exports and subprocess environments are output boundaries over those same settings. Startup reuses the complete saved port set when all ports are free and assigns an entirely new set when any is occupied. Forwarding webhooks must be an explicit runtime choice, absent by default; ordinary billing reads and usage ingestion must work without it. [Billing ownership and admission](#slate-owner-billing-access) governs signup enrollment and entitlements.

Composition must retain rich connection values until serialization at each package’s `env.ts` boundary. Full service addresses use `_URL`; `_HOST` is reserved for a hostname and optional port without a scheme. Preserve upstream names such as `BETTER_AUTH_URL`. Public webhook ingress may differ from the local service address. There is no global environment registry, fixed hostname scheme, or environment-variable setting for the platform OAuth resource.

## Slate-Owner billing access

Web's native Better Auth/Polar integration owns individual and team customer creation, checkout and billing management. Platform consumes verified `customer.created` and `customer.state_changed` events; a newly created customer with an external ID receives a native subscription to the configured Free product. Polar owns subscription lifecycle, credit fulfillment and renewal, and its state-change event supplies the resulting entitlement. Platform keeps a bounded-staleness copy of Polar's complete native Customer State. The database stamps freshness when that state is persisted, independently of provider event timestamps or customer modification dates. The external customer ID is the Better Auth user or organization ID; Polar's merchant organization is a separate concept.

Identity and slate authorization precede the single shared billing decision: hosted requests require viewing, while local personal-account tool execution requires management of the slate whose Owner pays. Hostname resolution, delegated tool/database execution, and local personal-account execution reuse it with the canonical slate Owner. The gate pulls Customer State by the Owner’s external ID on a missing row or when the saved state is older than one hour, saves it, and evaluates the saved state. Polar not-found leaves no new row and refuses with `subscription-required`; customer creation remains web’s responsibility, and other Polar failures surface. Any saved active subscription outside the configured Free product admits. Free requires a positive saved balance on the configured `POLAR_CLIPS_METER_ID`. Meter balance movement does not trigger a state-change webhook, so an exhausted Free Owner may remain admitted for up to the hour. Product and meter IDs identify environment-specific Polar resources; credits and allowance amounts are not copied into platform policy. No active subscription and exhausted Free balance return nonempty HTTP 402 messages. Exhaustion includes the subscription renewal date and an existing web billing destination: personal billing for a personal Owner, or the organization chooser for an organization Owner. Already subscribed customers use Polar’s native portal for paid plan changes and payment details.

The billing boundary retains its existing scope before runtime dispatch, including hosted assets and MCP discovery/resources. Dispatcher forwards the actual incoming pathname; exactly `/slate.json` retains viewing authorization while skipping billing. Local Tools preserves the platform billing message. Local page rendering itself does not go through hosted dispatch. Slate creation/listing, dashboard, Git, connection configuration, and billing management remain available. The configured Free product must have a zero fixed price and no metered price, so exhaustion cannot create overage charges, with its recurring credit benefit granting the allowance. Polar owns the only balance ledger. Paid plans retain their existing overage policy. Usage reporting is asynchronous after execution, so a positive-balance admission check does not reserve clips or establish an exact operation ceiling.

Usage metering follows execution: recognized dynamic GETs cost 1 clip, recognized dynamic POST/PUT/PATCH/DELETE requests cost 3 clips, and returned tool executions cost 1 clip. HTTP dispatch uses the shared response classifier; all metered execution paths use the shared usage reporter. Redirects participate in dynamic response classification; responses classified as assets and exact `/slate.json` produce no usage events. The classifier's concrete content-type rules belong in code. Classification depends on authored response headers, so this is the user-approved normal-traffic heuristic, not an unbypassable distinction between static and dynamic responses. Reporting is asynchronous and must not delay the response. Rates and canonical slate-Owner attribution stay in trusted code, without SDK-side instrumentation or an authored reporting callback. Polar's existing Clips meter aggregates the event types and owns allowances and prices.
