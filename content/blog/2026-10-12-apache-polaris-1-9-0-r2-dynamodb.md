---
title: "What Apache Polaris 1.9.0 Brings to Low-Egress Multi-Cloud Catalogs"
description: "What Apache Polaris 1.9.0 adds for multi-cloud lakehouses: Cloudflare R2 credential vending, a DynamoDB persistence backend, and the Iceberg 1.12 client."
date: 2026-10-12T09:00:00Z
tags: ["Apache Polaris", "Cloudflare R2", "DynamoDB", "credential vending", "object storage"]
canonical: https://datalakehousehub.com/blog/apache-polaris-1-9-0-r2-dynamodb/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/apache-polaris-1-9-0-r2-dynamodb/).

Picture a lakehouse that stores Iceberg tables in three places. Raw event data sits in Amazon S3 because that is where the producers live. A finance team keeps its modeled reporting tables in Azure. A product analytics team moved its largest tables to Cloudflare R2 because R2 does not charge for data leaving the bucket, and their dashboards read a lot of data. One Apache Polaris catalog sits on top of all three.

Two problems show up fast in that design. The first is credentials. Polaris hands engines short-lived, table-scoped storage credentials on AWS, Azure, and Google Cloud, but R2 has no AWS-style Security Token Service, so R2 catalogs fall back to clients holding long-lived keys. The second is the catalog's own database. Polaris needs a persistence backend, and the production default is PostgreSQL, which is one more stateful system to run in a stack that otherwise leans serverless.

Apache Polaris 1.9.0 targets both problems. The community plans to cut it at the end of October 2026, with Cloudflare R2 credential vending and a DynamoDB persistence backend both headed in as beta features, along with an upgrade to the Apache Iceberg 1.12 client. This article explains what each change does, how the community designed it, and how to evaluate it without betting production on a beta.

A note on timing and affiliation. This piece is written in mid-October 2026, before the release vote, so details come from the Polaris dev list and pull requests, and names can still change before the release ships. I also work at Dremio, which offers a catalog built on Apache Polaris. Everything here concerns the open source project.

## Where Polaris Stands Going Into 1.9.0

Polaris has kept a fast cadence since it graduated to an Apache Top-Level Project on February 18, 2026. Version 1.4.0 shipped in April, 1.5.0 in mid-May, 1.6.0 in July, 1.7.0 in early August, and 1.8.0 on September 28. The 1.9.0 proposal on the dev list explicitly aims to keep a monthly rhythm.

That cadence matters for planning. A monthly release train means features land in small increments and often arrive first as beta. Beta in Polaris means the code ships in the release, the community expects it to work, and the configuration surface and storage format can still change in a later release. You can run a beta feature in a test environment the day it ships. You should not put a production catalog's metadata into a beta persistence backend without a migration plan.

Polaris 1.8.0 set up several things that 1.9.0 builds on, so it is worth a quick recap.

Concurrent table commits that hit a stale sequence number now return a retryable 409 instead of a fatal 400. That applies to single-table commits and to multi-table `commitTransaction` calls. Clients that already retry on 409 now recover from commit races automatically. Stale commits also fail earlier, before Polaris writes a new metadata file, which saves an object storage write and delete for every conflict.

The Relational JDBC backend stopped creating its own database schema during bootstrap, since schema creation is a privileged database operation. Fresh installs need a database administrator to create the schema first. Schema version 6 fixed an index on Postgres and CockroachDB that made every `CREATE TABLE` and `CREATE NAMESPACE` scan the whole realm when the optimized location-overlap check was on. Existing deployments must recreate that index by hand.

Semantic models gained dedicated privileges for listing, creating, reading, updating, and dropping, grantable at model, namespace, or catalog scope. The Python CLI gained `--no-sts` and `--no-kms` on `catalogs update`, a `gcp` authentication type for federating BigLake catalogs, and a `--storage-name` option that references a server-side storage configuration. The release also fixed CVE-2026-97395.

For the full picture of running Polaris in production, including backups, realm bootstrap, and token signing across replicas, see [Running Apache Polaris in Production](https://datalakehousehub.com/blog/apache-polaris-in-production/). This article stays focused on what 1.9.0 changes.

## Why the Persistence Backend Decides So Much

Polaris is a catalog server. The server processes are stateless and scale horizontally. Everything durable lives in the metastore, the persistence backend that holds Polaris entities, role-based access control data, and policies. Catalogs, namespaces, tables, views, principals, roles, grants, and policy definitions all live there.

Every Iceberg commit that goes through Polaris touches the metastore. A commit checks the table's current state, validates the change, writes new Iceberg metadata to object storage, and then swaps the table's pointer in the metastore under a version check. The pointer swap is the atomic step that gives Iceberg its transactional guarantees across many engines. If the metastore is slow, every commit is slow. If it is down, nobody writes.

Before 1.9.0, Polaris supports three backends. The table summarizes their status in the 1.7 and 1.8 documentation.

| Backend | `persistence.type` | Support level | Typical use |
|---|---|---|---|
| In-memory | `in-memory` | Test only | Local development, loses data on restart |
| Relational JDBC | `relational-jdbc` | Ready to use | PostgreSQL in production, CockroachDB, H2 for tests |
| NoSQL | `nosql` with `MongoDb` backend | Beta | MongoDB or MongoDB Atlas |
| DynamoDB (proposed for 1.9.0) | Not final | Beta at launch | Serverless and AWS-native deployments |

The Relational JDBC path is the recommended production choice, and most teams run it on managed PostgreSQL. That works well. It also brings a set of chores: sizing the database, managing connection pools, planning failover, scheduling backups, and applying manual index changes like the one in 1.8.0, since Polaris has no automated schema migrations.

Teams that run everything else on serverless AWS services have asked for a backend that fits that model. DynamoDB has no servers to size, scales throughput on demand, and supports conditional writes, which is the primitive a catalog needs for version-checked pointer swaps. That is the motivation for the DynamoDB backend.

## The DynamoDB Backend and How the Community Shaped It

The DynamoDB work reached agreement on the dev list in early October. The interesting part is how, because the debate tells you what to expect from the code.

### Two internal persistence layers

Polaris has two internal approaches to persistence. The relational style uses an `AtomicOperationMetaStoreManager`, which models catalog operations as atomic operations against a store with relational habits. The NoSQL layer, which powers the MongoDB backend, was built for key-value and document stores from the start.

Jean-Baptiste Onofré and Robert Stupp argued that the NoSQL layer fits DynamoDB better, since DynamoDB is a key-value store. Yufei Gu and Yuewei Zhou argued that the atomic path adds little complexity, because Polaris correctness already works per entity with version checks, and DynamoDB's conditional writes support that directly. Dennis Huo pushed for an iterative approach that did not block progress on either.

The community sync settled it with three rules. Multiple DynamoDB implementations are acceptable. The documentation must explain how they differ. New backends start as beta. The first change in the series is pull request 5622, which arrived as one of several small, reviewable steps rather than one large drop.

### What that means for you

Read those rules carefully if you plan to evaluate DynamoDB persistence. "Multiple implementations are acceptable" leaves room for two DynamoDB backends with different internals, and you will eventually choose between them. The 1.9.0 release notes and documentation should tell you which implementation ships first and how it stores entities. That choice affects capacity planning, because the two layers use different access patterns, which produce different read and write unit costs.

"Starts as beta" means the table layout and configuration keys can change in a later release. If they change, you will need to migrate catalog metadata. Polaris includes tooling for moving between catalogs, and the Iceberg tables themselves stay in object storage untouched, but catalog entities such as principals, roles, grants, and policies live in the metastore. Plan an export and restore path before you trust any beta backend with real grants.

### The multi-object consistency question

A related thread shows why backend choice is not only an operations question. EJ Wang described a race in which two requests both check for overlapping table locations, both see none, and both create tables that point at conflicting storage paths. Each request is valid on its own. Together they break a catalog invariant.

The fix requires checking and writing in the same transaction. EJ proposed a manager layer that runs those business checks inside the write transaction, with database adapters that know nothing about tables or grants. The proof of concept includes adapters for FoundationDB, Spanner, and JDBC, with concurrency tests on FoundationDB and PostgreSQL. Jean-Baptiste Onofré favored multi-object conditional commits over request-scoped transactions, because conditional commits map to both relational and NoSQL stores.

DynamoDB supports transactions across multiple items, with limits on the number of items per transaction. Whether a given Polaris backend uses them for cross-entity invariants is exactly the kind of detail to confirm in the 1.9.0 documentation. If your catalog sees many concurrent `CREATE TABLE` calls in the same location tree, test that race against any new backend before production.

### Who benefits

The DynamoDB backend is a strong fit for three kinds of deployments. AWS-native platforms that want the catalog to match the rest of a serverless stack get one less database to operate. Teams running many small Polaris deployments, such as one per business unit or one per tenant, avoid running a PostgreSQL instance for each. Event-heavy environments with spiky commit traffic benefit from on-demand throughput.

It is a weaker fit if you run outside AWS, since DynamoDB is an AWS service. It is also a weaker fit if your organization already runs PostgreSQL well and has backups and failover solved. Swapping a mature backend for a beta one to remove a database you already operate competently is a poor trade.

## The Egress Problem That R2 Solves

Cloud object storage pricing has three parts: storage per gigabyte, request charges, and data transfer out of the provider's network. The first two are easy to model. The third surprises teams, because it grows with how much your data gets read from outside the provider, not with how much you store.

Lakehouse architectures read a lot of data. A query engine in one cloud scanning Iceberg tables in another pays egress on every byte it reads. A BI tool hosted by a SaaS vendor pulls data out of your cloud on every dashboard refresh. A data science team running notebooks on a different provider pays for every training set it loads. Multi-cloud lakehouses turn egress from a rounding error into a line item.

Cloudflare R2 takes a different pricing approach. R2 does not charge egress fees for reading data out of a bucket. You still pay for storage and for operations, split into write-type and read-type operation classes, but reads leave the network without a transfer charge. R2 also speaks the S3 API, so Iceberg's `S3FileIO` and most engines talk to it with a different endpoint and no code changes.

That makes R2 attractive for tables that many consumers read from many places: shared reference data, wide fact tables behind public dashboards, and datasets that partners or customers query directly. It is less compelling for tables that a single engine in one cloud reads from the same region, where egress was never the cost driver.

R2 is not a replacement for keeping data near compute. Latency still depends on distance, and a scan across continents is slower than a scan in the same region whatever the price. Treat R2 as a cost lever for read-heavy, widely shared tables, not as a reason to move everything.

### A quick test for which tables belong on R2

Not every table benefits from a move. Before you migrate anything, run each candidate through four questions.

First, who reads it, and from where? A table read mostly by one engine in the same AWS region as the data gains little from R2, since in-region reads carry no transfer charge on AWS either. A table read by engines in other clouds, by SaaS BI tools, or by external partners is a strong candidate.

Second, how often is it rewritten? R2 charges for operations, and write-type operations cost more than read-type ones. A table that ingests small files every minute and compacts hourly generates many writes. A wide fact table that loads nightly and gets read all day has the cost profile R2 rewards.

Third, where do its writers run? Writers need low latency to the catalog and to storage during commits. If the main writer is a Spark cluster in an AWS region, writing to R2 adds network distance to every commit. Some teams accept that for nightly batch loads. Few accept it for streaming ingestion.

Fourth, what does it cost to move back? Iceberg makes storage moves cheaper than they used to be, since metadata points at file paths and tools exist to copy and re-register tables. A move still means copying every data file and rewriting or relocating metadata. Start with tables where a wrong guess is cheap to undo.

Tables that pass all four questions are the ones to put on R2 first, and they are also the tables where R2 credential vending in 1.9.0 pays off most, since they are exactly the tables that many outside consumers read.

## Credential Vending for R2

Polaris already works with R2 today as an S3-compatible endpoint. What it cannot do before 1.9.0 is vend R2 credentials. To see why that matters, start with how vending works.

### How Polaris vends credentials on AWS

When an engine loads a table, it can send the `X-Iceberg-Access-Delegation: vended-credentials` header. Polaris checks the principal's privileges on the table, then generates storage credentials scoped to that table's location. On AWS, Polaris calls the Security Token Service (STS) `AssumeRole` operation with a session policy that limits access to the table's prefixes, and with read-only or read-write permissions to match the request. The engine receives an access key, secret, and session token that work only for that table and only for a short time.

This design keeps long-lived storage keys out of engines entirely. Revoking a user's catalog privileges revokes their storage access at the next credential refresh. Auditing happens in one place. For a deeper walkthrough of the cross-cloud vending model, see [Cross-Cloud Credential Vending in Apache Polaris](https://datalakehousehub.com/blog/polaris-cross-cloud-credential-vending/).

### Why R2 did not fit

R2 has no STS. For S3-compatible stores without STS, Polaris offers the `stsUnavailable` storage setting, exposed as `--no-sts` in the CLI. With STS off, Polaris still passes along endpoint settings, but it does not generate credentials. Clients must bring their own R2 keys, which brings back the long-lived key problem that vending exists to solve.

Cloudflare does offer a primitive for short-lived, scoped credentials. Its API endpoint `POST /accounts/{account_id}/r2/temp-access-credentials` creates temporary credentials for a bucket. The request names a bucket, a parent access key ID used for signing, a permission level (`object-read-only`, `object-read-write`, `admin-read-only`, or `admin-read-write`), and a time to live in seconds, with a maximum of 604,800 seconds, which is seven days. It accepts optional lists of prefixes or object paths to scope the credentials further. The response returns an access key ID, a secret access key, and a session token, the same shape that S3 clients expect from STS.

That shape is the key fact. Iceberg's S3 client already knows how to use an access key, secret, and session token. If Polaris can produce R2 credentials scoped to a table's prefix, every engine that supports vended credentials works with R2 tables without any engine change.

### The design debate

The R2 thread was the busiest on the Polaris list in early October, and the argument was about configuration, not cryptography.

The proposal adds a field to the storage configuration that names the credential vending mechanism. Yufei Gu worried that a free-form string lets a client work against one Polaris server and fail against another that does not recognize the value. Dmitri Bourlatchkov argued that a closed enum blocks downstream projects from adding their own mechanisms. Jean-Baptiste Onofré pointed out that only catalog administrators set this field through the Management API, and Iceberg REST clients never see it, since they only consume the vended credentials.

The sync produced a compromise. The OpenAPI spec keeps the field as a string. The documentation lists the accepted values. Servers validate the value at runtime and reject unknown ones. Austen Tomek, who authored the pull requests, planned two steps: first the existing `STS` mechanism expressed through the new field, then R2 in a second change. The R2 mechanism is named after how it signs rather than after a token format, since formats vary by provider. The chosen name is `R2_LOCAL_SIGNING`. Dmitri asked for R2 support to land in 1.9.0 as beta.

Naming the mechanism after its signing method signals intent. The same field can later express other providers' approaches without pretending they all issue identical tokens. If you run other S3-compatible stores that offer their own temporary credential APIs, watch this field. It is the extension point.

## Configuration Walkthrough

Since 1.9.0 has not shipped, this section shows two things: how to run an R2-backed Polaris catalog today on 1.8.0, and the building blocks that 1.9.0 vending relies on. When 1.9.0 ships, check its documentation for the exact property names before copying anything into production.

### Step 1: Create an R2 catalog on Polaris 1.8.0

The Polaris CLI creates an S3-compatible catalog with a custom endpoint. R2 endpoints follow the pattern `https://<account_id>.r2.cloudflarestorage.com`, and R2 accepts `auto` as its region.

```bash
polaris catalogs create \
  --storage-type s3 \
  --default-base-location s3://analytics-r2/warehouse \
  --endpoint https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com \
  --region auto \
  --path-style-access \
  --no-sts \
  r2_analytics
```

Each flag has a job. `--storage-type s3` tells Polaris to use its S3 integration, which covers S3-compatible stores. `--default-base-location` sets where new namespaces and tables land. `--endpoint` points Polaris and clients at R2 instead of AWS, and without it Polaris tries to contact AWS. `--region auto` satisfies the AWS SDK, which requires a region. `--path-style-access` puts the bucket name in the URL path, which works across S3-compatible stores. `--no-sts` tells Polaris not to call STS, since R2 has none.

The Polaris server itself also needs credentials to reach R2 for its own operations, such as writing metadata files during commits and running cleanup tasks. Provide those to the server process through its environment or secret store, scoped to the buckets the catalog uses.

### Step 2: Connect an engine without vending

On 1.8.0, an engine connecting to this catalog must supply its own R2 credentials. In Spark, that looks like this:

```bash
spark-submit \
  --packages org.apache.iceberg:iceberg-spark-runtime-4.0_2.13:1.12.0,org.apache.iceberg:iceberg-aws-bundle:1.12.0 \
  --conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions \
  --conf spark.sql.catalog.r2=org.apache.iceberg.spark.SparkCatalog \
  --conf spark.sql.catalog.r2.type=rest \
  --conf spark.sql.catalog.r2.uri=https://polaris.internal.example.com/api/catalog \
  --conf spark.sql.catalog.r2.warehouse=r2_analytics \
  --conf spark.sql.catalog.r2.credential=${POLARIS_CLIENT_ID}:${POLARIS_CLIENT_SECRET} \
  --conf spark.sql.catalog.r2.scope=PRINCIPAL_ROLE:ALL \
  --conf spark.sql.catalog.r2.s3.endpoint=https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com \
  --conf spark.sql.catalog.r2.s3.path-style-access=true \
  --conf spark.sql.catalog.r2.client.region=auto \
  --conf spark.sql.catalog.r2.s3.access-key-id=${R2_ACCESS_KEY_ID} \
  --conf spark.sql.catalog.r2.s3.secret-access-key=${R2_SECRET_ACCESS_KEY} \
  dashboards_refresh.py
```

The REST catalog lines authenticate Spark to Polaris with OAuth2 client credentials. The `s3.*` and `client.region` lines configure Iceberg's `S3FileIO` to talk to R2. The last two lines are the problem: a long-lived R2 key pair sits in the job configuration. Anyone who can read the job definition can read every object that key can reach, whatever their Polaris privileges say. Revoking catalog access does not revoke storage access.

### Step 3: The primitive that vending uses

Cloudflare's temporary credentials endpoint is what makes scoped R2 access possible. A direct call looks like this:

```bash
curl https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/r2/temp-access-credentials \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -d '{
    "bucket": "analytics-r2",
    "parentAccessKeyId": "'"${R2_PARENT_ACCESS_KEY_ID}"'",
    "permission": "object-read-only",
    "ttlSeconds": 3600,
    "prefixes": ["warehouse/product/events/"]
  }'
```

The request asks for one hour of read-only access to a single table's prefix. The response carries `accessKeyId`, `secretAccessKey`, and `sessionToken`. A catalog doing this on behalf of an engine produces exactly what Iceberg's S3 client consumes from AWS STS.

You do not call this endpoint yourself when Polaris vends credentials. The catalog generates the scoped credentials when an authorized principal loads a table. The `R2_LOCAL_SIGNING` name in the 1.9.0 design points at the catalog signing these credentials with the parent key it holds. The engine only sends the vended-credentials header and receives credentials back.

### Step 4: What changes once 1.9.0 vending works

Once R2 vending is available and configured on the catalog's storage settings, the engine configuration drops the static keys and adds the delegation header:

```bash
  --conf spark.sql.catalog.r2.header.X-Iceberg-Access-Delegation=vended-credentials \
  --conf spark.sql.catalog.r2.s3.endpoint=https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com \
  --conf spark.sql.catalog.r2.s3.path-style-access=true \
  --conf spark.sql.catalog.r2.client.region=auto \
```

The `s3.access-key-id` and `s3.secret-access-key` lines disappear. The catalog returns credentials scoped to each table as Spark loads it, and the `S3FileIO` uses them. The parent R2 key lives only inside the Polaris server's secret store. Engine definitions stop carrying storage secrets at all, and storage access follows catalog privileges again.

### Step 5: Persistence configuration today

For reference, here is how the Helm chart selects the two existing persistence backends. The DynamoDB keys will follow the same pattern under `persistence`, but use the names in the 1.9.0 chart documentation rather than guessing.

```yaml
# Relational JDBC (production default)
persistence:
  type: relational-jdbc
  relationalJdbc:
    secret:
      name: polaris-persistence

# NoSQL with MongoDB (beta)
# persistence:
#   type: nosql
#   nosql:
#     backend: MongoDb
#     database: polaris
#     secret:
#       name: polaris-mongodb
```

If you run Relational JDBC on Postgres or CockroachDB and upgraded to 1.8.0, finish the manual index work from the 1.8.0 upgrade notes before moving to 1.9.0:

```sql
DROP INDEX polaris_schema.idx_locations;
CREATE INDEX idx_locations ON polaris_schema.entities
  USING btree (realm_id, catalog_id, location_without_scheme)
  WHERE location_without_scheme IS NOT NULL;
```

Fresh installs on schema version 6 already have the correct index. CockroachDB deployments also need three grant and entity indexes listed in the same notes.

## The Iceberg 1.12 Client Inside Polaris

Polaris embeds the Apache Iceberg Java library, so every Iceberg release eventually becomes a Polaris upgrade. Iceberg 1.12.0 was announced on October 1, 2026, and Alex Dutra marked the Polaris upgrade to the 1.12 client ready for review within days, in pull request 5360. That upgrade is on the list of changes the community wants in 1.9.0.

### Path encoding

The main worry was URL encoding. Iceberg 1.12 fixed how the Java client encodes path segments, so a space now travels as `%20` instead of `+`. A catalog server that decodes `+` as a space sees different bytes after the upgrade.

Polaris turned out to be safe. Its REST layer decodes path parameters through JAX-RS, which follows RFC 3986, so Polaris never relied on the old behavior. The upgrade also fixes some URLs that Polaris advertised incorrectly before. No migration of persisted namespace names is needed. If you run Polaris, this change requires nothing from you. If you run a proxy or gateway in front of Polaris that rewrites paths, test a namespace with a space in its name after the upgrade.

### Remote signing comes back

Remote signing is an alternative to credential vending. Instead of handing the engine credentials, the catalog signs each storage request on the engine's behalf. That keeps credentials entirely on the server and lets the catalog see and authorize every object access. The cost is a round trip to the catalog for every signed request.

Polaris paused its remote signing work while the Iceberg spec changed underneath it. Iceberg 1.12 adds a `remote-signing-config` field to `LoadTableResult` and a client implementation that reads it, which covers nearly everything Polaris needs. Alex Dutra asked the community whether to resume the work. One gap remains: refreshing the authentication data inside that structure was left out of the Iceberg spec, and a separate proposal to the Iceberg community will address it.

Do not expect remote signing in 1.9.0. Today, a Polaris 1.8.0 server that receives a request for remote signing returns a clear 400 error explaining that the catalog cannot sign requests and that the client should configure storage credentials. The resumed work makes remote signing a realistic option in a later release, which matters most for regulated environments that want every object read authorized at the catalog.

### Server-side FileIO and metadata caching

Two threads tackled how Polaris builds its own server-side FileIO, the component it uses to read and write metadata files in object storage. Both reached the same conclusion: server-side FileIO should not depend on default table properties that a catalog sets with the `table-default.*` prefix. An earlier fix tied to CVE-2026-97395 already stopped Polaris from using caller-supplied metadata properties when building that FileIO. These changes prepare the ground for a table metadata cache.

The cache work raised a subtle question that matters for multi-cloud operators. Iceberg treats metadata files as immutable. If an S3-compatible endpoint changes, can the same metadata URI return different bytes? Dmitri Bourlatchkov reframed it as a cache correctness problem: Polaris does not control what an external store contains, so it should not assume two endpoints serve identical content. Jean-Baptiste Onofré noted that metadata files are immutable within one storage context, but an `s3://` URI is not a content hash. Robert Stupp summarized the two assumptions the cache depends on, and neither follows from the URI alone.

The practical lesson is direct. If you run one Polaris instance across several S3-compatible stores, such as AWS S3, R2, and an on-premises Ceph cluster, read this thread before enabling any metadata caching feature when it ships. Endpoint changes on a catalog's storage configuration need a cache flush.

### A commit-time performance fix

Ashok Borra raised a performance regression from validating historical metadata references on every commit. Since pull request 5115, each commit checks the location of every snapshot's manifest list and every statistics file in the table's history. For tables with long histories, that check grows with every snapshot. Ashok proposed limiting it, and Alex Dutra agreed. If you saw commit latency on long-lived tables climb after recent upgrades, this is the likely cause, and a fix is in progress.

## Multi-Region and High Availability Without Extra Moving Parts

Many teams evaluating 1.9.0 want to know whether R2 and DynamoDB make a multi-region catalog simpler. The answer depends on separating what Polaris provides from what its backends provide.

Polaris server processes are stateless. You run several replicas behind a load balancer, and any replica handles any request. The replicas need to agree on token signing keys so a token minted by one replica validates on another. That part of high availability is the same whatever backend you use.

The metastore is where availability gets decided. With Relational JDBC on PostgreSQL, availability comes from your database setup: a managed service with automatic failover, or a CockroachDB cluster that spans zones or regions. With MongoDB, it comes from replica sets. With DynamoDB, it comes from DynamoDB's own replication within a region and from whatever multi-region approach the Polaris backend supports. Confirm in the 1.9.0 documentation which DynamoDB features the backend relies on before you design around a multi-region table.

Storage is the third layer. Iceberg tables in R2 live in Cloudflare's network, tables in S3 live in an AWS region, and tables in Azure live in an Azure region. The catalog stores pointers to metadata files. If a storage region goes down, the catalog stays up but the tables in that region stop being readable.

That leads to a simple design rule. Put the catalog's metastore and server replicas where your writers are, since writers need the catalog for every commit. Let readers in other clouds reach the catalog over private connectivity, and let R2 absorb the read-heavy, cross-cloud traffic where egress fees hurt. For keeping catalog and storage traffic off the public internet, see [Keeping Lakehouse Traffic Off the Public Internet With Apache Polaris](https://datalakehousehub.com/blog/polaris-private-networking-lakehouse/).

What 1.9.0 changes in this picture is narrow and useful. DynamoDB removes the database you had to operate in an AWS-centered deployment. R2 vending removes the static keys you had to distribute to every reader of R2 tables. Neither makes a single catalog magically active in several regions at once. That remains an architecture decision you make with your backend's replication features and your tolerance for cross-region commit latency.

## Other Work Moving Through the Polaris List

Several other threads are active as 1.9.0 approaches. Not all of them will land in 1.9.0, so treat this as a map of where the project is going rather than a release promise.

**Polaris Directory.** The 1.9.0 proposal lists a feature called Polaris Directory as beta. Its user-facing documentation had not been published at the time of writing, so check the release notes for what it does and how to enable it.

**Table metrics and events over REST.** Pull request 4115 adds REST endpoints that expose table metrics and events, and the grant changes moved to a separate pull request. Yufei Gu argued that a new `TABLE_READ_METRICS` privilege should stay separate from full metadata access, since metrics reports include query filters that other users wrote. That separation matters for anyone exposing scan metrics to a wide audience.

**A shared event envelope.** The community settled on a JSON envelope for catalog events before merging a webhook listener. CloudEvents context attributes go at the top level, the Polaris payload goes inside `data`, and version one keeps parity with the existing Kafka events. The goal is one payload shape across Kafka, webhooks, and AWS CloudWatch.

**Catalog-level branches.** Ankur Kotwal proposed a `CATALOG_BRANCH` entity that groups per-table Iceberg branches and promotes them atomically through the existing `commitTransaction` path. Iceberg already branches single tables. Teams running backfills or write-audit-publish across many tables need multi-table atomic promotion, and this proposal provides it without engine changes. Version one supports fast-forward promotion only.

**Open Sharing.** Dennis Huo marked the Open Sharing API spec ready for review in pull request 5446. Sharing builds on existing Polaris authorization, with external identity providers treated as a first-class case.

**Credential access delegation values.** A thread shared with the Iceberg list discussed what a server should do when it cannot satisfy the access delegation header. Proposals included a `local` value, meaning the client brings its own credentials, and Daniel Weeks's preference for `none`, meaning the client does not need credentials from the catalog, so the catalog can skip generating them. This matters for mixed deployments where some catalogs vend and others do not.

## Failure Modes and Warning Signs

New backends and new credential mechanisms fail in predictable ways. Here are the ones to test for.

### Beta backend storage format changes

The symptom shows up on a later upgrade: release notes announce a changed layout for the DynamoDB backend, and your catalog entities need migration. The cause is adopting a beta backend for real grants and principals. Mitigate by running the beta backend only in environments you can rebuild, or by keeping an export of your Polaris configuration with the CLI's `setup export` command. Polaris 1.8.0 fixed several export bugs, including nested namespaces, policies in nested namespaces, and properties on principals and roles, so use a 1.8.0 or newer CLI for exports.

### Throttling under commit bursts

The symptom is commit latency spikes or 503 responses during heavy ingestion windows. With DynamoDB, the likely cause is throughput limits on a hot partition key or provisioned capacity set too low. Watch DynamoDB throttling metrics alongside Polaris request latency during your first load test. Polaris 1.8.0 returns 503 with `Retry-After: 0` for metastore failures during authentication, which lets well-behaved clients retry.

### Vended credentials that expire mid-query

The symptom is a long-running query that fails partway through with an access denied error from R2. The cause is a credential time to live shorter than the query, combined with an engine that does not refresh vended credentials. Iceberg clients support credential refresh, but behavior varies by engine version. Test your longest-running jobs against R2 tables with vending turned on, and choose a time to live that covers them with margin.

### Prefix scope that is too narrow or too wide

The symptom is either access denied errors on files the engine legitimately needs, or a security review finding that vended credentials reach more than one table. The cause is a mismatch between table locations and the prefixes the catalog scopes credentials to. Tables with `write.data.path` or `write.metadata.path` outside the table's base location are a common source. Polaris 1.8.0 fixed a related bug where Google Cloud Storage vending failed on bucket-root locations. Keep table locations tidy and inside allowed locations, and test vending on tables with custom paths.

### Cache staleness after endpoint changes

The symptom is a catalog serving metadata that no longer matches what the storage holds after someone changes a storage endpoint. This applies once metadata caching lands. Flush caches whenever you change a catalog's storage endpoint, and avoid changing endpoints on live catalogs where you can.

### Location overlap races

The symptom is two tables pointing at overlapping storage locations after a burst of concurrent `CREATE TABLE` calls. The cause is a check-then-write race that the backend does not close in one transaction. Test by firing concurrent creates in the same location tree against any new backend, then querying for overlapping locations.

## Operational Guidance for Evaluating 1.9.0

Here is how I recommend approaching the release when it ships.

**Upgrade the stable parts first.** The Iceberg 1.12 client upgrade and the bug fixes in 1.9.0 benefit every deployment. Take those on your normal upgrade schedule, after finishing any manual index work from 1.8.0.

**Evaluate R2 vending in a dedicated catalog.** Create a new catalog that points at an R2 bucket, configure the R2 mechanism, and grant a test principal access to one namespace. Confirm that engines receive credentials, that the credentials work only on the intended table prefixes, that they expire on schedule, and that long queries refresh correctly. Then revoke the principal's catalog privileges and confirm storage access ends at the next refresh.

**Evaluate DynamoDB in a disposable environment.** Stand up a realm on the DynamoDB backend, bootstrap it, and replay a representative commit load. Measure commit latency at your peak concurrency. Check DynamoDB metrics for throttling. Run the concurrent create test for location overlaps. Export the configuration and restore it into a fresh realm to prove your recovery path.

**Size the parent R2 key carefully.** The parent key that Polaris uses to sign R2 credentials is now the most sensitive secret in the R2 setup. Scope it to the buckets the catalog manages, store it in your secret manager, and rotate it on a schedule. Every vended credential derives from it.

**Watch the release notes for names.** The configuration field for the vending mechanism, the accepted values, and the DynamoDB configuration keys were still settling in October. Copy them from the 1.9.0 documentation, not from dev list threads or articles like this one.

**Keep an eye on the cadence.** Beta features in a monthly release train tend to move to general availability within a few releases if users report back. File issues and share results on the dev list. The fastest way to get a beta feature you depend on stabilized is to be one of the people testing it.

For context on how the project handled earlier trust and correctness work, [Apache Polaris 1.7.0 and the Quiet Work of Making a Catalog Trustworthy](https://datalakehousehub.com/blog/apache-polaris-1-7-0/) covers the previous release cycle.

## Conclusion

Apache Polaris 1.9.0 targets two specific frictions in multi-cloud lakehouses. R2 credential vending brings the scoped, short-lived credential model to a storage service that has no STS, so read-heavy tables can live where egress is free without scattering long-lived keys across every engine. DynamoDB persistence gives AWS-centered teams a metastore that matches a serverless operating model. The Iceberg 1.12 client upgrade keeps Polaris current with the protocol and reopens the path to remote signing.

Both headline features start as beta, and the community was explicit about that. Upgrade to the stable parts of 1.9.0 on your normal schedule. Test R2 vending and DynamoDB persistence in environments you can rebuild, with real load and real failure tests. Move them into production once the configuration surface settles and your own tests pass.

The larger pattern is worth noticing. Polaris keeps moving security and operational concerns into the catalog: credentials, signing, metrics, events, and soon multi-table branches. That is the right direction for an open lakehouse, because it lets many engines share one place where access gets decided.

## Keep Going

If this piece was useful, I have written a lot more on catalogs and the open lakehouse. *Apache Polaris: The Definitive Guide* covers the catalog's architecture, access control model, credential vending, and deployment patterns in depth. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
