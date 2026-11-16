---
title: "Polaris External Credential Mode: IdP-Only Principals, OPA and Ranger, and the Managed-Roles Middle Ground"
description: "Apache Polaris identity modes compared: internal, external credential mode in 1.9.0 with OPA or Ranger, and the proposed IdP-only principals with managed roles."
date: 2026-11-16T09:00:00Z
tags: ["Apache Polaris", "Apache Iceberg", "Security", "Identity", "Access Control"]
canonical: https://iceberglakehouse.com/posts/polaris-external-credential-mode-identity/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/polaris-external-credential-mode-identity/).

Apache Polaris can run with credential-mode set to external, where principals come entirely from an external identity provider's token and are never synced into Polaris. That mode needs an external authorizer such as OPA or Ranger. A November 2026 proposal adds a middle ground: IdP-managed users with Polaris-managed roles and grants.

Identity is the part of a catalog deployment that teams get wrong most often. The catalog sits between every engine and every table, so its idea of "who is asking" decides what every query can see. Polaris now supports three answers to that question, two shipped and one proposed, and each one moves the source of truth for users, roles, and grants to a different place.

This article explains each mode at the level of configuration properties and privileges. It covers internal mode, the external credential mode added in [Polaris 1.9.0](https://polaris.apache.org/downloads/1.9.0/) on November 14, 2026, and the hybrid that Jean-Baptiste Onofré proposed on the dev list on November 12 ([thread](https://lists.apache.org/thread/03g9pmcq42w81z7c7srmpjhjlwk45zoy)). It also covers what the `GET /v1/config` endpoint returns and the new privilege that guards it. For the base authorization model, start with [Iceberg Access Control Patterns](https://iceberglakehouse.com/iceberg/iceberg-access-control/), which this article builds on. A disclosure: I work at Dremio, which offers a catalog built on Apache Polaris. Everything here is about the open source project.

## Three things a catalog has to know

Every request to Polaris carries a token. From that token, Polaris has to answer three questions before it can authorize anything.

1. **Who is the principal?** A principal is a user or a service identity. Polaris needs a stable ID and name.
2. **Which roles are active?** Polaris uses role-based access control (RBAC). Principals hold principal roles. Principal roles are granted catalog roles. Catalog roles hold privileges on catalogs, namespaces, tables, and views.
3. **Who decides?** Some component has to evaluate "can these roles do this action on this resource." That is the authorizer, also called the policy decision point (PDP).

Each identity mode answers these three questions differently. The table below summarizes them, and the rest of the article explains each row.

| Mode | Principal comes from | Roles come from | Grants live in | Authorizer |
| --- | --- | --- | --- | --- |
| Internal | Polaris metastore | Polaris assignments, activated by the token | Polaris | Polaris default |
| External (1.9.0) | The token only | The token, verbatim | Not in Polaris | OPA or Ranger (required) |
| External with internal roles (proposed) | The token only | The token, mapped to existing Polaris principal roles | Polaris | Polaris default |

## Authentication types versus credential modes

Two separate settings control identity in Polaris, and mixing them up causes most configuration errors.

**`polaris.authentication.type`** decides how a token is validated. It has three values, documented in the [external identity provider guide](https://polaris.apache.org/in-dev/unreleased/external-idp):

- `internal` (the default) uses only Polaris's own token endpoint.
- `external` validates tokens from external OpenID Connect (OIDC) providers through Quarkus OIDC and disables the internal token endpoint, which then returns HTTP 501.
- `mixed` tries internal authentication first, then falls back to OIDC.

**`polaris.authentication.credential-mode`**, added in 1.9.0, decides what Polaris does with a validated token. It controls whether Polaris looks the principal up in its metastore or trusts the token entirely.

So a deployment can validate tokens from Okta or Keycloak (`type=external`) and still require every principal to exist in Polaris (internal credential mode). That combination is the most common external-IdP setup today. The new credential mode removes the second requirement.

## Mode 1: Internal credential mode

In internal credential mode, the token proves who the caller is, and Polaris's metastore defines everything else. Every principal must exist as an entity in Polaris. Every principal-role assignment must exist in Polaris. The token can only activate roles that are already assigned.

When `type=external` is combined with internal credential mode, Polaris maps claims in the token to a principal and to role names. The principal mapper reads the ID and name from configurable claim paths:

```properties
polaris.authentication.type=external
quarkus.oidc.auth-server-url=https://idp.example.com/realms/data
quarkus.oidc.client-id=polaris

# Where the principal's ID and name live in the JWT.
polaris.oidc.principal-mapper.type=default
polaris.oidc.principal-mapper.id-claim-path=polaris/principal_id
polaris.oidc.principal-mapper.name-claim-path=polaris/principal_name

# Where role names live, and how to turn them into Polaris role names.
quarkus.oidc.roles.role-claim-path=polaris/roles
polaris.oidc.principal-roles-mapper.type=default
polaris.oidc.principal-roles-mapper.mappings[0].regex=^.*$
polaris.oidc.principal-roles-mapper.mappings[0].replacement=PRINCIPAL_ROLE:$0
```

The `quarkus.oidc` properties point Polaris at the identity provider and name the client. The principal mapper properties say which JWT claims hold the principal's ID and name. The default mapper works only with JWTs, so opaque tokens need a custom implementation. The role properties say which claim holds role names and rewrite each one into the `PRINCIPAL_ROLE:<name>` form Polaris uses to activate roles. A filter property can also drop claim values you never want treated as roles, such as `profile` or `email`.

The strength of this mode is control. Polaris administrators see every principal and assignment through the Management API, and the default authorizer evaluates every request against grants stored in Polaris.

The weakness is synchronization. Every user who touches the catalog must exist in Polaris, and every group membership change in the IdP must be mirrored as a principal-role assignment. In a large organization, that means building and running a sync job between the IdP and Polaris. When the sync lags, a user who just joined a team cannot query that team's tables, and a user who left keeps access until the next run.

## Mode 2: External credential mode in 1.9.0

Polaris 1.9.0 adds a mode where Polaris skips the principal metastore lookup entirely. You enable it by setting `polaris.authentication.credential-mode` to `external`, globally or per realm. The release notes put it plainly: principals no longer need to be synced from an external IdP.

JB's November 12 email describes exactly how it behaves. A principal is authenticated entirely from its token. It does not need to exist in Polaris, so there is nothing to sync. Its roles are taken verbatim from the token, and they have no grants in the metastore.

That last point has a consequence. If the roles have no grants in Polaris, Polaris's default authorizer has nothing to evaluate. So external credential mode requires an external authorizer. Startup is refused with the default authorizer. The release notes add that the mode is incompatible with internal authentication and authorization.

The two external authorizers Polaris supports are Open Policy Agent (OPA) and Apache Ranger. Configuring OPA looks like this, based on the [OPA integration docs](https://polaris.apache.org/releases/1.7.0/managing-security/external-pdp/opa/):

```properties
polaris.authentication.type=external
polaris.authentication.credential-mode=external

# Hand every authorization decision to OPA.
polaris.authorization.type=opa
polaris.authorization.opa.policy-uri=https://opa.internal.example.com/v1/data/polaris/authz/allow
polaris.authorization.opa.http.timeout=PT2S
polaris.authorization.opa.auth.type=bearer
polaris.authorization.opa.auth.bearer.file-based.path=/var/run/secrets/opa-token
```

`polaris.authorization.type=opa` replaces the default authorizer. The `policy-uri` is the OPA decision endpoint, and it is required. The timeout bounds each decision, with a default of two seconds. The `auth` properties let Polaris authenticate to OPA with a bearer token read from a file, which suits Kubernetes secrets.

For each request, Polaris sends OPA a JSON input document with four parts. The `actor` holds the principal and its roles. The `action` names the operation, from Polaris's list of authorizable operations, such as loading a table. The `resource` lists the target resources and any secondary resources, each with a type, a name, and its parent hierarchy, such as a table's catalog and namespace. The `context` holds a request ID for correlating logs. OPA evaluates its policy and returns allow or deny.

The OPA docs recommend explicitly allowing only the operations you need, and keeping some operations, such as policy management in Polaris, under Polaris's native authorization. Start your policy with default deny and add rules per role.

Apache Ranger is the other supported option. Ranger fits organizations that already manage Hadoop-era services, such as Hive and HDFS, through Ranger policies and its admin console. The appeal is the same as OPA: one policy system across many data services. Release 1.9.0 fixed several Ranger authorizer issues, including how nested Polaris namespaces map to Ranger resources and a `javax/ws/rs` class loading error. If you evaluated the Ranger integration on an earlier release and hit either problem, retest on 1.9.0 before ruling it out. Check the Ranger integration docs for your release for the exact service definition and properties, since they have changed across releases.

### What external mode is good for

This mode fits organizations that already run a central policy engine. If OPA or Ranger already governs access to Kafka topics, Hive tables, and HDFS paths, putting the Iceberg catalog under the same policies keeps one place to answer "who can see what." Users and groups live in the IdP. Policies live in the PDP. Polaris enforces.

### What it costs

The cost is that Polaris RBAC stops being the source of truth. Grants made through the Polaris Management API mean nothing for external principals. Every privilege must be expressed in OPA or Ranger policy. Teams that liked Polaris's catalog roles and grants have to rebuild them as policy code.

It also adds a network dependency on every request. If the PDP is slow, every catalog call is slow. If it is down, nothing is authorized. Size and monitor the PDP like any other component on the critical path.

## Mode 3: The proposed middle ground

JB's proposal came from user conversations. He described an informal Polaris users discussion in France where several users shared a use case Polaris does not support. They want the IdP to remain the source of truth for users and their group or role membership. They also want Polaris RBAC, meaning principal roles, catalog roles, and grants managed through the Management API, to remain the source of truth for authorization. And they do not want to deploy an external authorizer.

Today, the only way to get Polaris RBAC is internal credential mode, which means syncing users and memberships. The proposal adds a third value:

```properties
polaris.authentication.type=external
polaris.authentication.credential-mode=external-with-internal-roles
polaris.oidc.principal-mapper.name-claim-path=preferred_username
quarkus.oidc.roles.role-claim-path=groups
polaris.oidc.principal-roles-mapper.filter=polaris_.*
polaris.oidc.principal-roles-mapper.mappings[0].regex=polaris_(.*)
polaris.oidc.principal-roles-mapper.mappings[0].replacement=PRINCIPAL_ROLE:$1
```

This is JB's example from the thread. The principal's name comes from the `preferred_username` claim. Roles come from the `groups` claim. The filter keeps only groups that start with `polaris_`. The mapping turns an IdP group named `polaris_analyst` into the Polaris principal role `analyst`. The mode name and config shape are still under discussion, so treat these exact keys as a draft.

### How the proposed mode behaves

The thread lays out the behavior point by point:

- The caller is authenticated from the token only. There is no principal lookup, and principals are never created in Polaris.
- Roles from the role mapper name principal roles that already exist in Polaris, using the `PRINCIPAL_ROLE:<name>` convention. Each existing principal role is activated, along with the catalog roles granted to it. Roles that do not exist in Polaris are ignored.
- Role membership comes from the token. Principal roles are never assigned to external principals inside Polaris.
- The default authorizer works, because the activated roles carry real grants.
- `PRINCIPAL_ROLE:ALL` is rejected with a 401, since an external principal has no assignments to expand.
- In mixed authentication, tokens issued by Polaris itself still resolve to internal principals.

Administrators are users whose IdP groups map to the `service_admin` principal role created at bootstrap.

The draft implementation is [PR #6066](https://github.com/apache/polaris/pull/6066). JB described it as small. It does not touch the `PolarisAuthorizer` interface or `PolarisCredential`. It adds a new credential mode value and a new principal attribute key. With that attribute set, the resolver loads an external principal's roles by name from the metastore, with their grants, instead of creating stand-in roles.

The PR also handles a security detail that matters. An external principal's name is asserted by the IdP. Without a guard, an IdP user named `root` gets treated as Polaris's root principal. The PR makes sure an external principal is never treated as root, whatever its name.

### What the reviewers said

Alex Dutra replied the same day in support. He compared the idea to a "federated" mode the community has discussed for a long time, with two differences: only roles are persisted ahead of time, not principals, and principals are not persisted just in time. They stay external. He agreed that unknown roles should be ignored and that `PRINCIPAL_ROLE:ALL` must be rejected. He suggested renaming the modes to `internal`, `federated`, and `external`. He also asked whether this mode should require a federated flag on principal role entities, which restricts which roles external principals can assume.

He flagged a limitation worth repeating. The model still requires principal roles to exist in Polaris before a user with the matching group can use them. Role names have to be kept in step between the IdP and Polaris.

Michael Collado added the reasoning behind that federated flag on November 13. His original design kept federated principals and roles strictly separate from native ones. The goal was to make sure that whoever controls role assignment in the IdP cannot be sidestepped by a Polaris service admin adding a native principal to a federated role, since those can be very different people. He also said he prefers consolidating the external and federated concepts so users do not have to learn three principal and role types.

That point is the governance heart of the design. In the hybrid mode, two groups share control. IdP administrators decide who is in which group. Polaris administrators decide what each role can do. A role that both systems can assign members to has two doors, and auditors will ask who holds each key.

## What GET /v1/config returns, and the new privilege

The other identity-adjacent change in 1.9.0 concerns the endpoint every Iceberg REST client calls first.

When a client connects to an Iceberg REST catalog, it calls `GET /v1/config`. The response has `defaults` and `overrides` maps of properties, a list of supported endpoints, and optional fields such as the idempotency key lifetime. Clients merge these with their own configuration. The endpoint is described in the [Iceberg REST Catalog API reference](https://iceberglakehouse.com/iceberg/iceberg-rest-catalog-api/).

### What leaks today

Vignesh A. opened a thread on November 7, active through November 13, describing what Polaris puts in that response ([thread](https://lists.apache.org/thread/3r0lgg5183fq8qb0cynb94vx2j14qbtb)). A successful call places the catalog entity's whole public properties map into `defaults`. Storage configuration, connection configuration, and secrets live in internal properties and are already left out. What still goes out includes `default-base-location`, operator custom keys, Iceberg catalog properties, and `polaris.config.*` catalog overrides, such as drop-with-purge, unstructured locations, list pagination, and credential vending settings.

His proposal: keep `default-base-location`, custom keys, and Iceberg catalog properties in the response. Drop `polaris.config.*` keys, since they are server and operator policy, not client configuration. They stay available through the Management API's catalog read, which is gated separately by `CATALOG_READ_PROPERTIES`. Prithvi S. agreed and suggested stripping everything with the `polaris.config.` prefix, so future server-side keys, such as table soft-delete settings in a pending PR, stay out of the response by default. Vignesh adopted the prefix rule.

### CATALOG_READ_CONFIG

Release 1.9.0 includes the authorization half of this work, from PR #5246. A new `CATALOG_READ_CONFIG` privilege guards `GET /v1/config`. Enforcement is off by default and controlled by `ENFORCE_CATALOG_CONFIG_AUTHORIZATION`. The changelog says the default will not flip until client-facing configuration is defined, which is what the thread is doing. A separate thread on November 13 discussed the soft rollout of this check ([thread](https://lists.apache.org/thread/pbg5v3612gfqt4yqjv2pxkz41h01cgyz)).

The identity mode matters here. In internal and hybrid modes, you grant `CATALOG_READ_CONFIG` to catalog roles like any other privilege. In external mode with OPA, the config call becomes another action your policy must allow. If your OPA policy is default deny and you forget this action once enforcement is on, every engine fails at connection time, before it ever loads a table.

## Auditing in each mode

Access reviews and incident response both start with the same questions: who had access, and who used it. Each mode answers them from a different place.

**Internal mode** keeps the full picture in Polaris. Principals, assignments, and grants are all entities you can list through the Management API. An access review is a query against Polaris. The usage side comes from Polaris events, which in 1.9.0 share a CloudEvents envelope and can flow to an OpenTelemetry pipeline.

**External mode** splits the picture across three systems. The IdP knows who exists and which groups they belong to. OPA or Ranger holds the policies and logs each decision. Polaris logs the requests and events. An access review means joining IdP group membership with PDP policy. Usage evidence comes from PDP decision logs correlated with Polaris events through the request ID that Polaris sends in the OPA input's `context`. Keep that ID in both log streams, or correlation becomes guesswork.

**The hybrid mode** splits it across two. The IdP holds membership. Polaris holds roles and grants. Since external principals never exist in Polaris, you cannot list "every user with access to table X" from Polaris alone. You list the roles with access to table X from Polaris, then list the members of the matching IdP groups. Document the group-to-role naming rule so auditors can follow it without reading regular expressions in a properties file.

In both external modes, record the principal name the IdP asserted in Polaris events. Because principals are never created in Polaris, the event log is the only place inside the catalog where an external user's activity shows up by name.

## Moving between modes

Few teams pick the right identity mode on day one. Here is how to move between them without an outage.

**From internal to hybrid.** This is the smoothest move, once the hybrid lands. Your principal roles and grants already exist in Polaris. The work is naming. Create IdP groups whose names map to your principal role names through the role mapper, populate them with the users currently assigned those roles in Polaris, and test with a few users in a separate realm before switching the main realm. After the switch, stop the user sync job and plan to retire the internal principal entities you no longer need.

**From internal to external.** This is a rewrite. Every grant in Polaris becomes policy in OPA or Ranger. Export grants per catalog role through the Management API, translate each into a policy rule, and run OPA in a shadow pattern where you compare its decisions with Polaris's for real traffic before cutting over. Plan on finding grants nobody remembers making.

**From external back to internal or hybrid.** This happens when a team finds that running a PDP on the catalog's critical path costs more than it saves. Translate PDP policies back into catalog roles and grants, then follow the internal or hybrid path. Policies that use attributes Polaris RBAC does not model, such as time of day or request origin, have no direct equivalent. Decide which of them you still need, and where else to enforce them.

In every move, change one realm at a time. The credential mode can be set per realm, so a staged rollout with a pilot realm is built into the configuration model.

## Choosing a mode

Here is a mechanism-level checklist. It assumes you already validate tokens from an external IdP, which is the right default for any shared deployment.

**Choose internal credential mode if:**

- You want Polaris to be the full source of truth for who can access the catalog.
- You can run a reliable sync from the IdP into Polaris principals and assignments.
- You need to list every principal through the Management API, for example for access reviews.

**Choose external credential mode if:**

- You already run OPA or Ranger as the organization's policy engine.
- You want catalog policies expressed in the same language as your other data policies.
- You accept that Polaris grants do not apply to external principals.
- You can run the PDP with the availability the catalog needs.

**Watch the hybrid mode if:**

- You want Polaris grants and catalog roles without running a PDP.
- You do not want to sync individual users into Polaris.
- You can keep a small, stable set of principal role names aligned with IdP group names.

In every mode, keep two things in view. First, credential vending ties into identity. Vended storage credentials are scoped by what the authorized principal can access, so an identity mistake becomes a storage access mistake. See [REST Catalog Credential Vending](https://iceberglakehouse.com/iceberg/rest-catalog-credential-vending/) for how that scoping works. Second, the root principal is special. Protect the bootstrap credentials, and in external modes confirm your version refuses to treat an IdP user as root.

## Failure modes and warning signs

**Startup refused in external mode.** If Polaris refuses to start after you set `credential-mode=external`, check the authorizer. The default authorizer is not allowed in this mode. Set `polaris.authorization.type` to `opa` or configure Ranger.

**Everyone denied after switching to external mode.** Roles from the token have no Polaris grants in external mode. If your OPA policy does not cover an action, it is denied. Check OPA decision logs for the action names Polaris sends.

**Roles silently missing.** In internal mode, a role in the token that is not assigned in Polaris does not activate. In the proposed hybrid, a role that does not exist in Polaris is ignored. Both fail quietly as missing access. Log the active roles per request while you roll out a mode change.

**Prefix mismatch.** Role mapping must produce names in the form Polaris expects. The external IdP guide's examples use `PRINCIPAL_ROLE:`. If a mapping produces a different prefix, no roles activate. Test the mapper with a real token before rollout.

**Engines fail at connect time.** If `ENFORCE_CATALOG_CONFIG_AUTHORIZATION` is on and principals lack `CATALOG_READ_CONFIG`, the first call every client makes is denied. Grant the privilege before enabling enforcement.

**Opaque tokens.** The default principal mapper reads JWT claims. Opaque access tokens need a custom mapper. A separate November thread discussed support for opaque tokens with external OIDC, which reviewers approved, so watch upcoming releases.

## Where this is heading

The direction across these threads is consistent. Polaris is moving identity out of its metastore and toward the organization's IdP, while keeping a choice about where authorization lives. External mode shipped in 1.9.0. The hybrid has broad support and a draft PR, with naming and the federated flag still open. The config response is getting a defined contract before its authorization check turns on by default.

Polaris 1.10.0 is proposed for mid-December. Whether the hybrid lands there depends on how quickly the naming and federated-flag questions settle. The safe plan is to design your role names now, since every mode except pure external mode depends on Polaris principal roles that match IdP groups. If you also run agents against the catalog, the token exchange patterns in [Securing Agent Identities in the Lakehouse](https://datalakehousehub.com/blog/securing-agent-identities-lakehouse-token-exchange/) apply on top of whichever mode you choose. For the bigger picture of where Polaris governance has been going this year, see [The State of Apache Polaris in July 2026](https://iceberglakehouse.com/posts/state-of-apache-polaris-july-2026/).

## Conclusion

Polaris now separates three identity questions: who the principal is, which roles are active, and who decides. Internal mode keeps all three in Polaris and requires syncing users. External mode, new in 1.9.0, takes the principal and roles from the token and requires OPA or Ranger to decide. The proposed hybrid takes the principal and role membership from the token and keeps grants and decisions in Polaris.

Pick the mode that matches where your organization already keeps the truth. If policies live in OPA, use external mode. If you want Polaris RBAC without user sync, follow the hybrid proposal and design role names that both systems share. In every case, grant `CATALOG_READ_CONFIG` before enforcement turns on, and test role mapping with real tokens before you switch.

## Keep Going

If this piece was useful, I have written a lot more on Apache Polaris and catalog security. *Apache Polaris: The Definitive Guide* (O'Reilly) covers principals, roles, grants, credential vending, and external identity in depth. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
