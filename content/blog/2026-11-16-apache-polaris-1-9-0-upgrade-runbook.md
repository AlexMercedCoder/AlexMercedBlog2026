---
title: "Apache Polaris 1.9.0 Upgrade Runbook: JDBC Schema v6, 403 Location Checks and Breaking Changes"
description: "Step by step Apache Polaris 1.9.0 upgrade: schema v6 migration, strict version checks, default pagination, new 403 cases, authorizer changes and rollback."
date: 2026-11-16T09:00:00Z
tags: ["Apache Polaris", "Apache Iceberg", "Upgrade Guide", "Operations", "Catalog"]
canonical: https://iceberglakehouse.com/posts/apache-polaris-1-9-0-upgrade-runbook/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/apache-polaris-1-9-0-upgrade-runbook/).

Apache Polaris 1.9.0, released November 14, 2026, needs a Relational JDBC migration to schema v6 before startup. It also turns list pagination on by default, returns 403 for more location conflicts, and changes the PolarisPrincipal and authorizer contracts. Back up the metastore, run the migration, check custom authorizers, then restart and test engine connections.

This runbook covers how to upgrade. It does not cover whether 1.9.0 is the right release for your organization. That decision, including the persistence backend and multi-cloud egress questions, is covered on DataLakehouseHub in [What Apache Polaris 1.9.0 Brings to Low-Egress Multi-Cloud Catalogs](https://datalakehousehub.com/blog/apache-polaris-1-9-0-r2-dynamodb/), which was written before release to help teams evaluate it. Read that piece to decide. Read this one to execute.

Everything here comes from the [Polaris 1.9.0 release notes](https://polaris.apache.org/downloads/1.9.0/), the [release announcement](https://lists.apache.org/thread/1gvhpzqzlzvlcp4kss2kqzjmyk3xx3ym) on November 15, and the dev list threads that shaped the release. A disclosure: I work at Dremio, which offers a catalog built on Apache Polaris. This runbook covers only the open source project.

## What changed in 1.9.0, in one list

Apache Polaris is an open source catalog for Apache Iceberg. It implements the Iceberg REST catalog API so engines such as Spark, Flink, Trino, Dremio, StarRocks, and Doris can share tables. It graduated to a top-level Apache project in February 2026. For the broader history, see [The State of Apache Polaris in July 2026](https://iceberglakehouse.com/posts/state-of-apache-polaris-july-2026/).

Release 1.9.0 is an operations release more than a feature release. Most of what you need to plan around falls into five groups:

| Group | Change | Who is affected |
| --- | --- | --- |
| Persistence | Relational JDBC needs schema v6. Scripts v1 to v5 replaced by one `schema.sql`. | Everyone on Relational JDBC |
| API behavior | `LIST_PAGINATION_ENABLED` defaults to true. More cases return 403 for location conflicts. | Clients that list objects or create tables with explicit locations |
| Authorization | `PolarisPrincipal` and `PolarisAuthorizer` contracts changed. New `CATALOG_READ_CONFIG` privilege, off by default. | Custom authorizers, OPA and Ranger users |
| Storage clients | AWS SDK clients use Apache HttpClient 5, which disables `Expect: 100-continue` by default. | S3-compatible storage that needs expect-continue |
| Tooling | Python package drops boto3. Bootstrap requires a matching `--credential` per `--realm`. Iceberg upgraded to 1.12.0. | CLI users, automation scripts |

The sections below follow the order you execute them in.

## Which path applies to you

The steps above cover every case. In practice, your starting point decides which steps carry real work.

**From 1.8.x on Relational JDBC.** Your schema is most likely already at v6. Confirm it with the `version` table and skip the migration. Your work concentrates in Steps 3 through 6: pagination, location checks, authorizer changes, and expect-continue. This is the shortest path, and a one-hour window covers it for most deployments.

**From 1.7.x or earlier on Relational JDBC.** You need every schema migration up to v6, and you cross more than one release's worth of behavior changes. Read the release notes for each version you skip, not just 1.9.0. Plan a longer window, since the migration and the stop-all-nodes swap both apply. Rehearsal in staging is not optional on this path.

**On NoSQL persistence.** The Relational JDBC schema steps do not apply. Check the NoSQL upgrade notes for your backend instead, and review the new `polaris.persistence.retry.*` settings. The dev list voted in November to remove the Beta label from NoSQL persistence, with DynamoDB variants staying in beta, so check the release notes of the version you land on for the label's status.

**On in-memory persistence.** In-memory deployments hold no state across restarts, so there is nothing to migrate. These are for local development and tests. If one of them has quietly become a shared environment, the upgrade is a good moment to move it to a persistent backend.

**Running Polaris through Helm.** Update the chart values for any new properties you set, such as `expect-continue-enabled`, and run the schema migration as a separate job before the chart rolls the new image. A rolling deployment strategy conflicts with the strict schema check when the schema changes, so switch to a recreate strategy for that upgrade.

## Step 0: Rehearse in staging

Every step above is easier the second time. Rehearse the full upgrade in a staging environment that mirrors production before you schedule the real window.

A useful staging environment for this release has four parts. It runs the same Polaris version you run in production today, on the same persistence backend. It holds a copy of production metadata, restored from a recent dump, so location checks run against your real table locations. It connects each engine type you use, at the versions you use. And it points at the same kind of object storage, including any S3-compatible store, so HttpClient 5 behavior shows up before production.

Run the upgrade end to end in staging and time each step. The schema migration time depends on the size of your metastore tables, especially events and metrics reports if you keep long histories. That timing tells you how long the production write pause needs to be.

Then run the post-upgrade checks from Step 7 against staging. Any table that returns 403 in staging returns 403 in production. Fix those locations before the real upgrade, while the old version still serves them.

## Step 1: Pre-flight checks

Do these before you touch a running server. Each one prevents a specific failure later.

**Back up the metastore.** For Relational JDBC on PostgreSQL, take a full dump of the Polaris schema. The schema migration changes tables in place, and the only rollback for a failed migration is a restore.

```bash
pg_dump --host=<db-host> --username=<db-user> \
  --schema=polaris_schema --format=custom \
  --file=polaris-pre-1.9.0.dump <db-name>
```

`--schema` limits the dump to the Polaris schema, and `--format=custom` produces a file `pg_restore` can read selectively. Use the schema name your deployment actually uses. The default is `POLARIS_SCHEMA`, set through the `currentSchema` JDBC property.

**Record your current schema version.** Polaris keeps a `version` table in its schema. Check it before upgrading:

```sql
SELECT * FROM polaris_schema.version;
```

The Polaris docs map schema v6 to the 1.8.0 release. If you run 1.8.x and the table shows version 6, you have no schema migration to apply. If it shows a lower number, you need every migration between your version and v6.

**Check `currentSchema` in your JDBC URL.** The Relational JDBC docs warn about this for anyone upgrading from before 1.8.0. A `currentSchema` value in the JDBC URL overrides the default and can point Polaris at a different, empty schema. Polaris then starts against a blank metastore, and your catalogs appear to vanish. Confirm the URL and the `quarkus.datasource.jdbc.additional-jdbc-properties.currentSchema` property point at the same schema.

**Inventory custom authorizers.** If you run a custom `PolarisAuthorizer` implementation, it needs code changes before it works with 1.9.0. Details are in Step 4. OPA and Ranger users are affected too, through the principal attribute changes.

**List storage endpoints that need expect-continue.** Some S3-compatible stores and proxies behave differently without `Expect: 100-continue`. If you run anything other than AWS S3, plan to test uploads after the upgrade.

## Step 2: The schema migration

### What changed in the schema files

Before 1.9.0, the Relational JDBC module shipped numbered schema scripts, one per version. Release 1.9.0 replaces scripts v1 through v5 with a single `schema.sql`. New deployments bootstrap from that file. Existing deployments apply migrations as documented in the Relational JDBC metastore page.

The release notes state that Relational JDBC requires a migration to schema v6 before starting this version. The docs page lists v6 against 1.8.0, so most teams coming from 1.8.x are already there. Teams coming from 1.7.x or earlier have work to do.

### Version checks are strict

A dev list thread on November 12 made an important point about how Polaris checks schema versions. Jean-Baptiste Onofré noted that the schema version check is a strict equality. A 1.9.0 node fails against a v7 schema, and a 1.10.0 node fails against a v6 schema. His conclusion: do not mix versions during the upgrade ([thread](https://lists.apache.org/thread/sts19lsk3w4lj09r20howqk2xzhc6m2l)).

That shapes your rollout. A rolling upgrade, where you replace nodes one at a time while the rest keep serving, works only if the schema version stays the same across the change. If your upgrade includes a schema bump, every node on the old version stops working the moment the schema moves.

### The sequence

1. Stop or drain write traffic to the catalog if your engines tolerate a short pause. Reads continue to work until the schema changes.
2. Apply each schema migration between your current version and v6, in order, using the SQL in the Relational JDBC docs for each version.
3. Verify the `version` table shows 6.
4. Stop all old Polaris nodes.
5. Start the 1.9.0 nodes.
6. Run bootstrap only if you need new realms.

Step 6 deserves a warning taken straight from the docs. Re-bootstrapping is not sufficient to upgrade the SQL schema. Bootstrap is idempotent and ignores realms that already exist, so running it against an old schema does not migrate anything. Always apply migrations first.

### Planning ahead for 1.10.0

The same thread shows that 1.10.0, proposed for mid-December, will carry a schema v7. Pull requests #5089 (a realm purge queue table), #6013 (an index on events), and #4756 (changed report lookup indexes) all touch the schema, and the maintainers agreed to fold them into one v7 bump. The discussion also described a two-step migration for the purge table: create the table while the old version still serves, then record the version bump last, so the restart is the only window with no serving node.

Treat 1.9.0 as the release where you get your migration process right. You will use it again within a month.

## Step 3: API behavior clients will notice

### Pagination is on by default

`LIST_PAGINATION_ENABLED` now defaults to true. List operations, such as listing namespaces or tables, can return a page token, and clients must follow it to get the full list.

Iceberg REST clients from recent Iceberg releases handle page tokens. Older clients or custom scripts that call the REST API directly and read one response as the complete list now see partial results with no error. That is the failure to watch for: a script that inventories tables reports fewer than exist.

If you find a client that cannot follow page tokens, you can turn the feature off while you fix the client. Polaris feature flags are set in `application.properties` with the `polaris.features` prefix:

```properties
# Temporary: disable list pagination for clients that cannot follow page tokens.
polaris.features."LIST_PAGINATION_ENABLED"=false
```

The quoted key is the feature name, and the value overrides the default. Treat this as a stopgap, not a configuration to keep.

A related thread opened November 14 proposes pagination rules for Polaris-native list APIs in PR #6028, separate from the Iceberg REST rules. The first rule in that proposal is the one to code against now: any list response can be paginated, a client must always check for a page token, and a missing or null token means the end of the results ([thread](https://lists.apache.org/thread/2d3v9ob15w9fcpkb9qs65tmvhkmm1dcf)).

### More 403s on location conflicts

Location checks now return 403 Forbidden in more cases. The release notes list renames, commits, credential vending, and overlapping table or namespace locations. Table purge and metadata cleanup no longer delete files outside the table's location, and loading a table whose recorded locations differ now returns a `ForbiddenException`. Generic table creation also validates explicit base locations against allowed locations and the parent namespace.

These changes close real safety gaps. A table whose metadata points outside its own location can lead a purge to delete files that belong to something else. The cost is that tables created with unusual locations under older versions can start failing after the upgrade.

Before upgrading, look for tables whose locations sit outside their namespace's location or overlap with another table. After upgrading, watch engine logs for 403 responses on table loads and commits. A 403 that appears only after the upgrade, on a table that worked before, almost always points to a location that 1.9.0 now rejects.

### Spaces encoded as %20

Polaris 1.9.0 upgrades its bundled Apache Iceberg to 1.12.0. The Iceberg 1.12 Java REST client encodes spaces as `%20`. If you have namespaces or tables with spaces in their names and a proxy or gateway that rewrites URLs, test those paths. For a broader look at what Iceberg 1.12.0 changes across engines, see [Upgrading to Apache Iceberg 1.12.0 Without Breaking Your Engines](https://datalakehousehub.com/blog/upgrading-apache-iceberg-1-12-0/).

## Step 4: Authorization changes

### Custom authorizers

The `PolarisPrincipal` interface changed, including the attribute types and where the attribute keys live. `PolarisAuthorizer` implementations should now call `AuthorizationState.resolve()`. If you maintain a custom authorizer, rebuild it against the 1.9.0 interfaces before you upgrade servers. A custom authorizer built against 1.8.x does not load cleanly against the new interface.

### OPA and Ranger

The event attribute `ACCESS_DELEGATION_MODE` was replaced by `ACCESS_DELEGATION_MODES`, which changes the OpenTelemetry attribute name. Dashboards or alerts that filter on the old attribute go quiet after the upgrade. Update them in the same change window.

Release 1.9.0 also fixes several Ranger authorizer issues, including nested namespace mapping and a `javax/ws/rs` class loading error. If you worked around either of those, remove the workaround and test.

### The new CATALOG_READ_CONFIG privilege

Iceberg REST clients call `GET /v1/config` when they connect to a catalog. The response tells the client about server defaults, overrides, and endpoints. Release 1.9.0 adds a `CATALOG_READ_CONFIG` privilege for this call. Enforcement is off by default and controlled by `ENFORCE_CATALOG_CONFIG_AUTHORIZATION`.

Leave enforcement off during the upgrade. Turn it on only after you grant `CATALOG_READ_CONFIG` to every principal role that connects engines to a catalog. If you turn it on first, every engine fails at connection time. The full reference for the config endpoint is in the [Iceberg REST Catalog API quick reference](https://iceberglakehouse.com/iceberg/iceberg-rest-catalog-api/).

### Privilege changes that widen access

`TABLE_MANAGE_STRUCTURE` and the fine-grained table update privileges now include `TABLE_READ_PROPERTIES`. Principals allowed to change table structure can now also read table properties. That matches how most teams expected those privileges to work, but if you audit access for compliance, note it.

### External principals

Release 1.9.0 adds a mode that lets Polaris skip the principal metastore lookup, either globally or per realm, by setting `polaris.authentication.credential-mode` to `external`. Principals no longer need to be synced from your identity provider. This mode requires an external identity provider and an external policy decision point such as OPA or Ranger, and it is incompatible with internal authentication and authorization. Do not switch modes as part of a version upgrade. Upgrade first, confirm stability, and change identity architecture as a separate project.

## Step 5: Storage client changes

Polaris-managed AWS SDK clients now use Apache HttpClient 5. HttpClient 5 disables `Expect: 100-continue` by default. That header tells the server to confirm it will accept a request body before the client sends it. AWS S3 works either way. Some S3-compatible stores, load balancers, and proxies behave differently without it.

If uploads or metadata writes through Polaris fail against a non-AWS store after the upgrade, restore the old behavior:

```properties
# Restore Expect: 100-continue for Polaris-managed AWS SDK clients.
polaris.storage.expect-continue-enabled=true
```

S3 storage configurations also gain an optional `credentialVendingMechanism` field. Leaving it empty uses STS AssumeRole, which is the only supported value in 1.9.0. You do not need to set it. Its existence signals that other mechanisms are coming. Background on how vending works is in [REST Catalog Credential Vending](https://iceberglakehouse.com/iceberg/rest-catalog-credential-vending/).

Two fixes in this area are worth knowing. Credential vending no longer ends up with an empty location set when paths differ only by scheme or trailing slash. The `/config` response now advertises the credentials refresh endpoint, which lets clients refresh vended credentials without reloading the table.

## Step 6: Tooling and automation

**Python package.** The `apache-polaris` Python package no longer depends on boto3, and it accepts pydantic from 2.12 up to, but excluding, 3.0. If your automation relied on boto3 arriving as a transitive dependency of the Polaris package, add it explicitly. If you pin pydantic below 2.12, upgrade it.

**Bootstrap.** Bootstrap now requires a matching `--credential` for each `--realm`, unless you pass `--print-credentials`. Scripts that bootstrapped several realms with one credential fail. Update them to pass one credential per realm:

```bash
java -jar polaris-admin-tool.jar bootstrap \
  -r realm_a -c realm_a,<client-id-a>,<client-secret-a> \
  -r realm_b -c realm_b,<client-id-b>,<client-secret-b>
```

Each `-r` names a realm, and each `-c` supplies the realm, client ID, and client secret for that realm's root principal. Bootstrap skips realms that already exist, so running this against an upgraded deployment only creates the new ones.

**CLI additions.** The Python CLI adds `register` for tables and views, `namespaces update`, and `--ssl-ca-cert` and `--insecure` options. The `--insecure` flag disables certificate checks. Keep it out of production scripts.

**Root principal.** The `root` principal can no longer be dropped or renamed. Any automation that rotated access by renaming root needs a different approach.

## Step 7: Post-upgrade checks

Run these checks before you declare the upgrade done. Each one ties back to a change above.

1. **Version table.** Confirm the schema version matches what 1.9.0 expects and that all nodes run 1.9.0.
2. **Engine connections.** Connect each engine type you use. A connection failure at `GET /v1/config` points to config authorization or a TLS change.
3. **Full listings.** List namespaces and tables in a large catalog with each client. Compare counts to a pre-upgrade inventory. Short counts point to a client that ignores page tokens.
4. **Writes.** Commit to a test table from each writing engine, including against any non-AWS object store. Failures point to expect-continue or location checks.
5. **Credential vending.** Load a table with vended credentials and read data. Then let credentials approach expiry and confirm refresh works.
6. **Authorization.** Run a read, a write, and a denied action for a representative principal from each role. If you use OPA or Ranger, confirm decisions match before the upgrade.
7. **Telemetry.** Confirm dashboards that used `ACCESS_DELEGATION_MODE` now read `ACCESS_DELEGATION_MODES`.

## Other 1.9.0 changes worth knowing

Not every change in 1.9.0 needs action during the upgrade. These ones change behavior you will see afterward.

**Commits keep metadata when the outcome is unknown.** This is the most important correctness fix in the release. A commit writes new metadata files, then updates the metastore to point at them. If the connection to the metastore drops during that update, the server does not know whether the update landed. Older versions cleaned up the newly written metadata files in that case. If the update had in fact succeeded, the table then pointed at deleted files. Release 1.9.0 keeps newly written metadata when the outcome is unknown and still cleans up after known failures. Orphaned metadata files are a small cost. A table pointing at missing metadata is a broken table.

**The access delegation header accepts `none`.** Iceberg clients send an `X-Iceberg-Access-Delegation` header to ask the catalog for vended credentials or remote signing. Clients can now send `none` to say they want neither, which is useful for engines that bring their own storage credentials.

**Events share a CloudEvents envelope.** Polaris added a shared CloudEvents 1.0 JSON mapper for its events. If you consume Polaris events in a pipeline, expect the format to converge on that envelope across listeners.

**NoSQL commit retries are configurable.** Teams on the NoSQL persistence backend can tune commit retries through `polaris.persistence.retry.*` properties. The dev list also voted to remove the Beta label from NoSQL persistence, with DynamoDB variants staying in beta.

**Federation fixes.** Several external catalog and federation issues were fixed. Connection properties are now persisted and applied for Hadoop and Hive catalogs. Deleting an external catalog also removes its inline connection secrets. If you federate to Hive or Hadoop catalogs, recheck connection settings after the upgrade.

**Entity cache weighs grants.** The entity cache now counts grant records toward its size. With the same `ENTITY_CACHE_WEIGHER_TARGET`, deployments with many grants see more evictions and more metastore reads. Watch metastore load after the upgrade and raise the target if needed.

**Sibling checks fixed.** The `OPTIMIZED_SIBLING_CHECK` no longer rejects every entity created under a namespace. If you disabled it to work around that bug, you can turn it back on.

## Planning the maintenance window

A realistic window for a team already on schema v6 has five parts: announce, drain, swap, verify, and reopen. Announce the window to engine owners a few days ahead, and name the changes that affect them, especially pagination and the new 403 cases. Drain by pausing scheduled writers, such as ingestion jobs and table maintenance, a few minutes before the swap. Swap by stopping all old nodes and starting the new ones together. Verify with the Step 7 checks. Reopen by resuming writers one group at a time, starting with the least critical, and watch logs for 403s and write failures as each group resumes.

For a team migrating the schema, add the migration between drain and swap, and budget the time you measured in staging. Keep the database dump from Step 1 until the new version has run cleanly through at least one full cycle of your scheduled jobs.

## Rollback plan

Rollback depends on whether you changed the schema.

**No schema change** (you were already on v6): stop the 1.9.0 nodes, start the previous version's nodes, and restore old configuration. Data written through 1.9.0 is ordinary Iceberg metadata, so engines read it either way.

**Schema change** (you migrated from below v6): the old nodes fail the strict version check against the new schema. Rolling back means restoring the database from the pre-upgrade dump, which loses any catalog changes made after the migration. Keep the window between migration and verification short, and pause writes during it if you can.

In both cases, do not attempt to run old and new nodes side by side. The strict version check exists to stop exactly that.

## Failure modes, symptoms, and causes

| Symptom after upgrade | Likely cause | Fix |
| --- | --- | --- |
| Polaris fails at startup with a schema version error | Schema not at v6, or nodes of mixed versions | Apply migrations, run one version only |
| Catalogs appear empty | `currentSchema` points at a different schema | Fix the JDBC URL or property |
| Scripts report fewer tables than exist | Client ignores page tokens | Fix the client, or disable pagination temporarily |
| 403 on load or commit for an old table | Location now outside allowed or overlapping | Move the table or correct its location |
| Uploads fail on an S3-compatible store | Expect-continue disabled by HttpClient 5 | Set `polaris.storage.expect-continue-enabled=true` |
| Engines fail at connect time | `CATALOG_READ_CONFIG` enforced without grants | Grant the privilege, or turn enforcement off |
| Custom authorizer fails to load | Built against the old interfaces | Rebuild against 1.9.0 |
| Bootstrap script fails | One credential for several realms | Pass `-c` per realm |

## Conclusion

Polaris 1.9.0 tightens safety around locations and commits, prepares the ground for external identity, and cleans up persistence scripts. The upgrade is straightforward if you follow the order: back up, check the schema version, migrate to v6, stop every old node, start 1.9.0, and test listings, writes, vending, and authorization. The two traps are the strict schema version check, which forbids mixed-version clusters, and default pagination, which silently shortens lists for old clients.

Run the process carefully this time and keep the notes. Polaris 1.10.0 is proposed for mid-December with a schema v7, and the same runbook applies. For the decision side of this release, including the persistence and egress trade-offs, see the [DataLakehouseHub evaluation of 1.9.0](https://datalakehousehub.com/blog/apache-polaris-1-9-0-r2-dynamodb/). For an earlier release's changes for comparison, see [Apache Polaris 1.7.0](https://iceberglakehouse.com/posts/apache-polaris-1-7-0/).

## Keep Going

If this piece was useful, I have written a lot more on running Apache Polaris. *Apache Polaris: The Definitive Guide* (O'Reilly) covers deployment, persistence, authorization, and credential vending in depth. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
