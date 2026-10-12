---
title: "Upgrading to Apache Iceberg 1.12.0 Without Breaking Your Engines"
description: "A platform engineer's upgrade guide to Apache Iceberg 1.12.0: variant and geospatial changes, REST catalog behavior, removed APIs, and rollback."
date: 2026-10-12T09:00:00Z
tags: ["Apache Iceberg", "Iceberg 1.12.0", "upgrades", "REST catalog", "Spark", "Flink"]
canonical: https://datalakehousehub.com/blog/upgrading-apache-iceberg-1-12-0/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/upgrading-apache-iceberg-1-12-0/).

Your Spark jobs pin one Iceberg version. Your Flink streaming sink pins another. PyIceberg runs inside a few notebooks and a Lambda function, and your REST catalog server embeds its own copy of the Iceberg Java library. Then a new release lands, and someone asks a simple question in standup: can we upgrade this sprint?

Apache Iceberg 1.12.0 makes that question harder than usual. The release carries 777 commits from 142 contributors since 1.11.0. It removes Spark 3.4 and Flink 2.0 support. It changes the default AWS HTTP client. It teaches the REST client to retry certain POST requests on its own. It also adds real engine support for Variant shredding, geospatial columns, Hilbert-curve clustering, and a Flink task that turns streaming equality deletes into deletion vectors.

This article is an upgrade guide for platform engineers. It covers what changed, which pieces of your stack feel each change, and the order that keeps your tables safe. It ends with a pre-production checklist and a rollback plan you can adapt.

A short disclosure before we start. I work at Dremio, which builds a lakehouse engine and a catalog on Apache Polaris. Everything here concerns the open source Iceberg project and applies no matter which engines you run.

## Why a Point Release Deserves an Upgrade Plan

Iceberg version numbers confuse people because two different things carry versions. The table format has a spec version, and the Java library has a release version. Format version 2 and format version 3 describe what sits in your metadata files. Library version 1.12.0 describes the code that reads and writes them.

Upgrading the library does not upgrade your tables. A table at format version 2 stays at format version 2 after you move to 1.12.0. It only changes when someone sets `format-version` to 3 on purpose. That separation is the single most useful fact to keep in mind during this upgrade, because it means most library upgrades are reversible.

Most, not all. A newer library can write things into metadata that an older library reads differently or not at all. A new feature that writes a new kind of file can strand older readers. A behavior change in the client can surprise a catalog server that someone wrote against older assumptions. The goal of an upgrade plan is to find those edges before production does.

The release itself came together at the end of September 2026. The release candidate vote passed with four binding approvals, and the community announced the release on October 1. The previous release, 1.11.0, shipped in late spring 2026. If you skipped 1.11.0, read its notes too, since this upgrade inherits everything from that cycle. I covered that release in detail in [An In-Depth Overview of the Apache Iceberg 1.11.0 Release](https://datalakehousehub.com/blog/2026-05-apache-iceberg-1-11-0-deep-dive/), and this guide picks up where that one stops.

One more framing point. Iceberg is a library that many independent projects embed. Your upgrade is really a coordination problem across those projects. Spark and Flink get new runtime jars from the Iceberg project directly. PyIceberg, iceberg-go, and iceberg-rust ship on their own schedules. Catalog servers such as Apache Polaris embed the Java library and need their own release before they speak the new client features fluently. Commercial engines pick up new versions on vendor timelines. Plan for a window where different parts of your stack run different versions, because that window always exists.

The good news is that Iceberg was designed for this. The spec defines how readers and writers interoperate across versions, and the REST protocol defines a contract between clients and servers that does not depend on a shared library version. The upgrade risks live in a small number of known places. The rest of this article walks through them.

## What Changed in the Data Types: Variant and Geospatial

Two type families got serious engine work in 1.12.0. Both started as spec additions in format version 3, and both now move closer to production use.

### Variant reads and shredding

Variant is the format version 3 type for semi-structured data, such as JSON payloads with fields that change from record to record. A Variant column stores each value in a compact binary encoding. Engines can optionally "shred" frequently used fields into separate typed Parquet columns, which lets readers prune files and skip decoding for those fields.

Three changes matter here. First, Spark 4.0 and 4.1 now read unshredded Variant columns through the vectorized Parquet path. Before 1.12.0, those reads decoded one row at a time. If you store large Variant columns and query them without shredding, scans get faster after the upgrade with no changes on your side.

Second, the shredding rule got stricter. The old rule shredded a field when most of its values shared a type. Under that rule, a typed column sometimes covered only part of its field, with the rest stuck in the untyped residual. The new rule shreds a field only when every value falls into a single type family after numeric widening. Fields that mix types stay in the residual. Single-type fields behave exactly as before.

This change affects layout, not correctness. Readers must already handle both typed and residual data, so files written under the old rule stay valid. Expect the new writer to shred fewer fields on messy data. If you tuned queries around a field that used to shred and no longer does, you will see more decoding work for that field. Check your heaviest Variant queries after the upgrade.

Third, shredded writes are no longer limited to Spark. Flink can write shredded Variant, and so can the Kafka Connect sink and the generic record writer. Streaming pipelines that land JSON through those paths now produce files with the same read-time pushdown benefits that Spark batch jobs got earlier. Flink also gained Variant support in its Avro readers and writers.

A batch of fixes rounds out the Variant work. String bounds on shredded columns now follow UTF-8 byte order, and binary upper bounds truncate upward so pruning stays correct. Large decimals above precision 18 shred correctly. ORC filter pushdown on tables with a Variant column works again. If you already run Variant on 1.11.0, these fixes are a reason to upgrade on their own, since bounds errors cause readers to skip files they need.

For a primer on how shredding works at the file level, see [Variant Shredding Explained](https://datalakehousehub.com/blog/variant-shredding-explained/).

### Geospatial read and write support

The `geometry` and `geography` types now have read and write paths. Both store values as Well-Known Binary (WKB), a standard binary encoding for shapes. In Parquet they map to the Parquet geometry and geography logical types, so files describe themselves to any Parquet reader that understands those types. Avro reads and writes work too.

Spark 4.1 is the first engine with a complete path. It reads and writes both types in Parquet and supports row-level `DELETE`, `UPDATE`, and `MERGE` on tables with geospatial columns, including the merge-on-read path that uses deletion vectors on format version 3.

The limits are real and worth stating plainly. Support covers Spark 4.1 only, not Spark 3.5, Spark 4.0, Flink, or ORC. Reads use the row-based reader because Arrow has no geospatial vector yet. There are no spatial predicates, so you cannot filter on a shape. You filter on other columns and process the shapes afterward.

One small behavior change hides here. `GeometryType` and `GeographyType` now print their resolved coordinate reference system in `toString()`. A geometry column prints as `geometry(OGC:CRS84)` instead of a bare type name, and geography adds its edge algorithm. If any of your tooling parses type strings, such as schema diff scripts or data contract checks, update the parsers before the upgrade reaches production.

## Deletes, Streaming, and Layout

The second cluster of changes concerns how rows get deleted and how files get organized. These features change physical layout, so they deserve care during rollout.

### Deletion vectors get co-located access

Deletion vectors are the format version 3 replacement for position delete files. Each vector is a compressed bitmap that marks deleted row positions in one data file, stored in a Puffin file. In 1.12.0, a data file exposes its vector directly through `DataFile.deletionVector()`. Two fixes also landed. One corrects references when several vectors share one Puffin file. The other keeps encryption metadata intact when vectors merge.

The shared-Puffin fix matters if you run format version 3 tables with frequent small deletes. Writers pack several vectors into one Puffin file to reduce file counts. A reference bug in that path produces readers that apply the wrong vector or fail to find one. If you saw intermittent delete-related read errors on 1.11.0, this release is your fix.

### Equality deletes become deletion vectors

Streaming upserts create a known performance trap. Flink writes equality deletes, which are files that say "remove every row whose key matches these values." They are cheap to write. They are expensive to read, because every query must open data files and compare key values to decide which rows survive. Tables with heavy upsert traffic get slower every hour until compaction catches up.

The new `ConvertEqualityDeletes` maintenance task for Flink resolves those equality deletes once. It finds the row positions that each equality delete targets and writes them as deletion vectors. After conversion, readers apply deletes by position, which costs a bitmap lookup instead of a value comparison.

The design pairs with `IcebergSink`. The sink stages new data files and equality deletes on a source branch. The converter resolves them into deletion vectors and commits the result to the target branch. It can also convert in place. Since deletion vectors are a format version 3 feature, the task requires format version 3 tables. It runs on Flink 1.20, 2.1, 2.2, and 2.3. A follow-up fix guarantees that deleted rows do not reappear after a failed conversion cycle, which tells you the community tested the failure path.

Treat this as an architectural option, not a drop-in setting. Adopting it means moving a streaming table to format version 3, which is a one-way change for readers that do not support version 3. Check every engine that reads the table before you flip the format version.

### Hilbert clustering joins Z-order

`rewrite_data_files` gained a Hilbert-curve clustering strategy. Both Hilbert and Z-order map several columns onto one space-filling curve, so rows with similar values across those columns land in the same files. That improves file skipping for queries that filter on more than one column.

The difference is in how the curves move through space. Z-order makes large jumps between regions, which can place distant values next to each other in the sort. Hilbert keeps neighbors on the curve adjacent in the data. For filters that select a compact region across two or three columns, Hilbert tends to produce tighter min and max bounds per file.

You choose it through the sort strategy:

```sql
CALL lake.system.rewrite_data_files(
  table => 'sales.orders',
  strategy => 'sort',
  sort_order => 'hilbert(customer_region, order_date)'
);
```

Hilbert clustering ships for Spark 4.1 only. The release also fixed the Z-order byte encoding for floating-point values. If you Z-ordered tables on float or double columns with an earlier version, those files sorted with a flawed key. They are still correct data, but their clustering is weaker than you expected. Rewriting them after the upgrade restores the skipping benefits you paid for.

Two smaller maintenance additions round this out. The `RepairTable` action interface defines a standard way to repair manifest entry statistics that disagree with their files. Spark's `rewrite_data_files` accepts `max-file-group-input-files` to cap how many input files go into one group, which helps when a single group grows large enough to strain executor memory.

## REST Catalog Changes for Clients and Servers

The REST catalog protocol is how most modern engines talk to Iceberg catalogs. Changes here touch every client and every server, so this section deserves the most attention during planning.

### New protocol surface

The OpenAPI spec picked up several additions. `VariantType` is now representable, so schemas with Variant columns can travel over the protocol without special handling. Read-only endpoints for listing and loading functions arrived. An unregister-table endpoint lets a client detach a table from a catalog without deleting its data or metadata, which is useful for moving tables between catalogs. Remote signing configuration became a formal part of the protocol, and a `labels` field lets catalogs attach descriptive metadata to objects.

On the library side, `CatalogObjectIdentifier` gives a shared way to name catalog objects. The Java client now implements remote signing configuration. Catalog labels are read from load responses and exposed on the loaded table through `SupportsLabels`.

Labels deserve a closer look because they open a new pattern. A catalog can attach ownership tags, PII markers, or cost centers to a table, and clients can read those labels when they load the table. Engines and governance tools no longer need a side channel to fetch that context. Expect catalogs to adopt this over the coming releases.

### Read restrictions are a contract, not enforcement

The spec now lets a catalog return a `ReadRestrictions` object when a client loads a table. The object describes required column projections, such as masking all but the last four characters, nulling a value, truncating a timestamp, or hashing. It can also carry a required row filter expressed as an Iceberg expression. The contract is client-enforced and fail-closed: a reader that supports restrictions must apply every action in full, and if it cannot, it must fail the query.

Here is the part that matters for security teams. No Iceberg reader applies read restrictions in 1.12.0. A catalog that returns them today gets silently ignored by every consumer. Do not treat this release as a fine-grained access control feature. Keep enforcing column masks and row filters where you enforce them now, in the engine or in a governed view layer, until readers ship support and you have tested it.

### Client behavior changes that reach your servers

Two client behaviors changed in ways that catalog server operators need to know about.

The REST client now retries POST requests that carry an `Idempotency-Key` header when the server returns 408, 500, 502, 503, or 504. That is the right behavior for a well-built server, since the key lets the server recognize a repeat and return the first result. A server that ignores the key will process a retried commit as a new request. Check whether your catalog honors idempotency keys before you upgrade clients at scale.

The Java client also fixed how it encodes URL path segments. A space in a namespace or table name now goes over the wire as `%20` instead of `+`. Servers that decode path parameters according to RFC 3986 handle this correctly. A custom server that treated `+` as a space now sees different bytes. The Apache Polaris community reviewed this exact change while upgrading to the 1.12 client and confirmed that Polaris needs no migration, since its framework already decoded paths per the RFC. If you run a homegrown catalog, test names with spaces before rollout.

### Delegated purge

Spark can now delegate `DROP TABLE ... PURGE` to REST catalogs through the `rest-catalog-purge` catalog property, on Spark 3.5, 4.0, and 4.1. With delegation, the catalog deletes the data and metadata files instead of the Spark driver. That keeps storage credentials for deletes inside the catalog, which fits the credential vending model where clients get scoped, short-lived access. It also means purge behavior now depends on your catalog's implementation. Confirm what your catalog does with a purge request before you enable the property.

## Breaking Changes and the Engine Matrix

Every Iceberg release removes APIs that earlier releases deprecated. This one removes more than usual, because the community swept through every method and field scheduled for removal in 1.12.0. Read this section with your build files open.

### Removed engine versions

Spark 3.4 support is gone. Spark 3.5, 4.0, and 4.1 remain. Flink 2.0 support is gone, while Flink 2.2 and 2.3 joined. The supported Flink versions are 1.20, 2.1, 2.2, and 2.3.

If any cluster still runs Spark 3.4, you have two choices. Hold that cluster on Iceberg 1.11.x, or upgrade Spark first. Holding is safe for a while, since 1.11.x readers handle tables written by 1.12.0 as long as nobody turns on features those readers lack. It stops being safe the day someone writes a format version 3 feature that 1.11.x mishandles. Set a deadline for retiring the old cluster rather than letting it drift.

The table below summarizes where each feature runs.

| Capability in 1.12.0 | Spark 3.5 | Spark 4.0 | Spark 4.1 | Flink 1.20 to 2.3 |
|---|---|---|---|---|
| Core reads and writes | Yes | Yes | Yes | Yes |
| Vectorized unshredded Variant reads | No | Yes | Yes | Not listed |
| Shredded Variant writes | Yes | Yes | Yes | Yes |
| Geospatial read, write, and row-level DML | No | No | Yes | No |
| Hilbert clustering in `rewrite_data_files` | No | No | Yes | No |
| `ConvertEqualityDeletes` maintenance | No | No | No | Yes (format v3) |
| Iceberg views in SQL | Yes | Yes | Yes | Yes (new) |
| Delegated `DROP TABLE ... PURGE` | Yes | Yes | Yes | No |

### Removed write paths and APIs

Writing position deletes that carry row data has been removed. This matches the move to deletion vectors on format version 3. If a custom writer produced position deletes with row data, it will fail to compile or fail at runtime. Readers still handle existing files of that kind.

`DataReader` is gone in favor of `PlannedDataReader`. The deprecated partition statistics read functionality is gone, replaced by the Partition Stats Scan API. Spark lost `SparkFilters`, several `SparkTableUtil` methods, and helper methods on `SparkReadConf`, `SparkWriteConf`, and `SparkSchemaUtil`. The data module lost `GenericAppenderFactory` and `BaseFileWriterFactory`. AWS lost its old S3 signer classes and properties. Flink lost `RewriteDataFiles.Builder.filter(Expression)`. Core lost the REST namespace encoding helpers and one `HadoopFileIO` constructor. Kafka Connect and BigQuery integrations lost a handful of members and constants.

Most teams never touch these classes. Teams that built custom writers, custom maintenance jobs, or internal Spark extensions often do. Search your internal repositories for each removed name before you bump the version. A compile failure in CI costs minutes. A `NoSuchMethodError` in a nightly maintenance job costs a morning.

### The AWS HTTP client switch

The default AWS SDK HTTP client moved to Apache HttpClient 5. If you use the `iceberg-aws-bundle` jar, the bundle handles this for you. If you put `iceberg-aws` on the classpath and manage the AWS SDK yourself, you must replace `software.amazon.awssdk:apache-client` with `software.amazon.awssdk:apache5-client`.

This is the change most likely to break a working deployment on upgrade day, because the failure shows up at runtime when the first S3 call happens. Check your dependency tree for `apache-client` before deploying.

### Dependency updates

The AWS SDK bill of materials jumped from 2.44.4 to 2.54.17. Jackson moved from 2.21.3 to 2.22.2. Netty moved to 4.2.18.Final, Caffeine jumped from 2.9.3 to 3.2.4, and Avro, ORC, Guava, RoaringBitmap, and Nessie all moved up.

The Jackson alignment fixed two high-severity `jackson-databind` CVEs, CVE-2026-54512 and CVE-2026-54513, and a further bump fixed GHSA-r7wm-3cxj-wff9. Three Jackson findings remain in the Kafka Connect runtime. They come from a copy of Jackson shaded inside `parquet-jackson`, which cannot move until Apache Parquet moves. If your security scanner flags the Kafka Connect jar after the upgrade, that is the reason. Document it as a known exception with an owner and a review date.

The Caffeine major version jump deserves a dependency check of its own. If your application also depends on Caffeine 2.x and does not shade it, you now have a version conflict to resolve.

## Coordinating the Rest of the Stack

The Iceberg Java release is one piece. Here is how the surrounding projects line up as of mid-October 2026.

### Apache Polaris

Polaris embeds the Iceberg Java library. The current Polaris release, 1.8.0, shipped on September 28, 2026, just before Iceberg 1.12.0, so it uses the 1.11 line. The upgrade to the 1.12 client was marked ready for review on the Polaris dev list within days of the Iceberg release. The community targets Polaris 1.9.0 for the end of October.

You do not need to wait for Polaris 1.9.0 to upgrade your engines. The REST protocol decouples client and server versions. An engine on 1.12.0 talks to a Polaris server on 1.8.0 using the protocol both understand. New protocol features, such as the formal remote signing configuration and labels on load responses, only light up once both sides support them.

Polaris 1.8.0 also includes a change that pairs well with the new client retry behavior. Concurrent table commits that hit a stale sequence number now return a retryable 409 instead of a fatal 400. Combined with idempotency-key retries on the client side, commit conflicts under concurrency recover more cleanly than before. Polaris 1.8.0 also requires a manual index recreation on existing Postgres and CockroachDB deployments to fix a slow location-overlap check. If you plan both upgrades, do the Polaris index work first.

### PyIceberg

PyIceberg is a separate codebase with its own versions. PyIceberg 0.12.0 covers development from early February through late August 2026. It does not track Java 1.12.0 feature for feature. One rename in 0.12.0 matters for REST users: the `rest-scan-planning-enabled` property became `scan-planning-mode`. If your notebooks or jobs set the old property, update them when you move to 0.12.0.

### Other clients and engines

Iceberg Go 0.7.0 passed its release vote in the same week as Java 1.12.0. The Rust client continues on its own cadence. Commercial and open source engines that embed Iceberg Java, including Trino and Dremio, adopt new library versions on their own schedules. Check each vendor's release notes rather than assuming a version.

The practical rule is simple. Every writer to a table must support every feature that any writer enables on that table. Readers can lag behind writers as long as writers stay within what readers understand. Build your rollout around that rule.

## Upgrade Walkthrough: Configuration and Verification

This section walks through a Spark upgrade against a REST catalog, since that combination covers most of the moving parts. Adjust names for your environment.

### Step 1: Pin the new runtime

Spark picks up Iceberg through a runtime jar matched to the Spark and Scala versions. For Spark 4.0 with Scala 2.13 and S3 storage, the coordinates look like this:

```bash
spark-submit \
  --packages org.apache.iceberg:iceberg-spark-runtime-4.0_2.13:1.12.0,org.apache.iceberg:iceberg-aws-bundle:1.12.0 \
  --conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions \
  --conf spark.sql.catalog.lake=org.apache.iceberg.spark.SparkCatalog \
  --conf spark.sql.catalog.lake.type=rest \
  --conf spark.sql.catalog.lake.uri=https://catalog.internal.example.com/api/catalog \
  --conf spark.sql.catalog.lake.warehouse=analytics \
  --conf spark.sql.catalog.lake.credential=${CLIENT_ID}:${CLIENT_SECRET} \
  --conf spark.sql.catalog.lake.scope=PRINCIPAL_ROLE:ALL \
  --conf spark.sql.catalog.lake.header.X-Iceberg-Access-Delegation=vended-credentials \
  your_job.py
```

Here is what each part does. The `--packages` line pulls the Spark runtime and the AWS bundle at the same version. Mixing versions between these two jars is a common source of class conflicts, so always bump them together. For Spark 4.1, swap the runtime artifact for `iceberg-spark-runtime-4.1_2.13`. For Spark 3.5, use `iceberg-spark-runtime-3.5_2.12` or `iceberg-spark-runtime-3.5_2.13` to match your Scala build.

The `spark.sql.extensions` line enables Iceberg's SQL extensions, which you need for stored procedures such as `rewrite_data_files`. The `lake` catalog lines point Spark at a REST catalog. The `credential` and `scope` lines handle OAuth2 client credentials against the catalog, and the `scope` value shown is the Polaris convention for activating all of a principal's roles. The access delegation header asks the catalog to vend scoped storage credentials, so the job never holds long-lived storage keys.

### Step 2: Fix the AWS client if you manage the SDK

If your build uses `iceberg-aws` instead of the bundle, update the HTTP client dependency. In a Maven build, the change looks like this:

```xml
<dependency>
  <groupId>org.apache.iceberg</groupId>
  <artifactId>iceberg-aws</artifactId>
  <version>1.12.0</version>
</dependency>





<dependency>
  <groupId>software.amazon.awssdk</groupId>
  <artifactId>apache5-client</artifactId>
</dependency>
```

Let the AWS SDK bill of materials manage the client version so it stays aligned with the rest of the SDK. Then run `mvn dependency:tree` and confirm that `apache-client` no longer appears anywhere, including as a transitive dependency of another library.

### Step 3: Verify reads before writes

Start the upgraded job in a read-only mode against production tables. Read-only verification proves that the new library parses your existing metadata and data without touching anything. These queries make a good baseline:

```sql
-- Confirm the table format version did not change
SHOW TBLPROPERTIES lake.sales.orders ('format-version');

-- Confirm snapshot history loads and matches what the old version reported
SELECT committed_at, snapshot_id, operation
FROM lake.sales.orders.snapshots
ORDER BY committed_at DESC
LIMIT 5;

-- Confirm file-level metadata reads cleanly
SELECT content, file_format, record_count, file_size_in_bytes
FROM lake.sales.orders.files
LIMIT 20;

-- Compare a representative aggregate against the same query on the old version
SELECT order_date, count(*) AS orders, sum(total_amount) AS revenue
FROM lake.sales.orders
WHERE order_date >= DATE '2026-09-01'
GROUP BY order_date
ORDER BY order_date;
```

Run the same aggregate on the old version and the new version and compare results. They must match exactly. A mismatch points to a reader change, most often in delete handling or predicate pushdown, and you want to find it here instead of in a dashboard.

### Step 4: Write to a branch first

Iceberg branches let you test writes without touching the main lineage. Create a branch, point a copy of your job at it, and compare the output:

```sql
ALTER TABLE lake.sales.orders CREATE BRANCH upgrade_test;

-- Point a test run at the branch
SET spark.wap.branch = upgrade_test;

INSERT INTO lake.sales.orders
SELECT * FROM lake.staging.orders_increment;

-- Confirm the branch exists and moved
SELECT name, type, snapshot_id
FROM lake.sales.orders.refs;

-- Inspect what the new writer produced on the branch
SELECT count(*) AS row_count
FROM lake.sales.orders VERSION AS OF 'upgrade_test';
```

After the test, drop the branch with `ALTER TABLE lake.sales.orders DROP BRANCH upgrade_test`. Snapshot expiration later removes the files the branch alone referenced. Branch testing proves that the new writer produces files your other readers accept. Point every other engine that reads this table at the branch and run its usual queries. That cross-engine check is the most valuable test in the whole upgrade.

### Step 5: Opt into new features one at a time

Do not enable Hilbert clustering, Variant shredding changes, and equality delete conversion in the same week as the library upgrade. Upgrade the library first and let it run for a full business cycle with no new features. Then adopt features one at a time, each with its own verification. When something breaks, you will know which change caused it.

## Failure Modes and Warning Signs

Most upgrades go fine. The ones that go wrong tend to go wrong in a small set of ways. Here is what to watch for, with the symptom you will see first.

### Class conflicts at startup

The symptom is a `NoSuchMethodError`, `ClassNotFoundException`, or `NoClassDefFoundError` when a job starts or when it first touches S3. The cause is almost always mixed versions on the classpath: an old `iceberg-aws` next to a new runtime jar, the old `apache-client` left behind after the HTTP client switch, or a Caffeine 2.x jar from another library colliding with Iceberg's Caffeine 3.x. Print the full classpath of a failing job and look for two versions of the same artifact.

### A custom maintenance job stops compiling

The symptom is a CI failure in an internal library, not in your main jobs. Teams often wrap `GenericAppenderFactory`, `SparkTableUtil`, or the old S3 signer in utility code years ago and forget about it. The fix is mechanical, since each removed API has a documented replacement. The risk is discovering this on upgrade day. Search for the removed names before you start.

### Duplicate commits from client retries

The symptom is two snapshots where you expected one, or a duplicate append after a network blip. The cause is a catalog server that does not honor the `Idempotency-Key` header. The 1.12.0 client retries POST requests with that header on 408, 500, 502, 503, and 504 responses. A server that treats the retry as a fresh request processes it twice. Managed and widely used catalogs handle this. Homegrown servers often do not. Test by injecting a 503 from a proxy in a staging environment and confirming the table ends with one snapshot.

### Lookup failures for names with spaces

The symptom is a 404 for a namespace or table whose name contains a space, against a custom catalog server. The cause is the corrected path encoding, where spaces now travel as `%20` instead of `+`. Servers that decode per RFC 3986 are fine. Servers with hand-written decoding are not. The fix belongs on the server side.

### Weaker skipping on Variant queries

The symptom is a Variant query that scans more data than it did before. The cause is the stricter shredding rule. A field with mixed types that used to shred partially now stays in the residual, so readers decode it instead of pruning with typed column statistics. The data is correct. The performance profile changed. If a hot query depends on such a field, clean up the source data so the field holds one type, or extract it into a regular column.

### Mismatched aggregates between versions

The symptom is a query that returns different results on the old and new versions. Treat this as a stop-the-rollout event. The 1.12.0 release fixed several real correctness bugs, including manifest pruning with negated filters, `notStartsWith` skipping row groups with nulls, null counts for files written without `null_count`, and nanosecond timestamp pushdown. A different result can mean the old version was wrong. It can also mean the new version is wrong in a way nobody has reported. Find out which before you continue, and file an issue with a reproduction if it is the new version.

### Security scanner findings that do not go away

The symptom is a scanner that still flags Jackson in the Kafka Connect runtime after you upgraded to fix the Jackson CVEs. This is expected. Those findings come from the Jackson copy shaded inside `parquet-jackson`. Record them as known exceptions until Apache Parquet ships an update and Iceberg picks it up.

### Silent masking gaps

The symptom is invisible, which is why it belongs on this list. A catalog administrator reads that the spec now supports read restrictions and configures masking rules in a catalog that returns them. No 1.12.0 reader applies them. Users see raw values. Make sure your governance team knows that this is a spec-level contract only in this release.

## Pre-Production Checklist and Rollback Plan

Here is the checklist I recommend, in order. Each item names the risk it addresses.

1. **Inventory every writer and reader.** List every engine, library, and service that touches your Iceberg tables, with its current Iceberg version. You cannot plan a coordinated upgrade without this list. Include scheduled maintenance jobs, which people forget.
2. **Retire or isolate Spark 3.4 and Flink 2.0.** These cannot run 1.12.0. Upgrade them or hold them on 1.11.x with a deadline.
3. **Search for removed APIs.** Grep internal code for every removed class and method listed in the release notes. Fix them in a branch before the upgrade.
4. **Check the AWS client.** If you manage the AWS SDK yourself, switch to `apache5-client` and confirm with a dependency tree.
5. **Check for Caffeine conflicts.** Look for Caffeine 2.x in your dependency tree.
6. **Test the catalog contract.** Confirm your catalog honors `Idempotency-Key` and decodes `%20` in paths. Inject a 503 in staging and verify a single snapshot results.
7. **Update type-string parsers.** Any tool that parses geometry or geography type strings needs to handle the new CRS suffix.
8. **Run read verification.** Compare representative aggregates between versions on production data, read-only.
9. **Run branch-based write verification.** Write with the new version to a branch, then read that branch from every other engine.
10. **Roll out by reader first, then writer.** Upgrade read-only consumers before writers. A new reader handles everything an old writer produces. The reverse is not guaranteed once new features appear.
11. **Hold new features for one cycle.** Run the new library with no feature changes for a full business cycle before adopting Hilbert clustering, equality delete conversion, or other new behavior.
12. **Update PyIceberg settings separately.** If you move to PyIceberg 0.12.0, rename `rest-scan-planning-enabled` to `scan-planning-mode` in every config.

### Rollback

Library rollback is simple when you follow the rules above. Since the upgrade does not change table format versions, an older library reads the tables the newer library wrote, as long as you have not enabled new features. Roll back by reverting the jar versions and dependency changes in the same commit that introduced them.

Rollback gets harder once you adopt features. If you moved a table to format version 3 to use equality delete conversion, older readers without version 3 support cannot read it, and there is no supported downgrade of a table's format version. If you wrote geospatial columns with Spark 4.1, readers without geospatial support fail on those columns. That is why the checklist holds features for a cycle. Library rollback stays cheap until the first feature adoption, so make that decision deliberately.

Keep one more tool in reserve. Iceberg snapshots let you roll a table back to a known good state with `CALL lake.system.rollback_to_snapshot('sales.orders', <snapshot_id>)`. Record the current snapshot ID of every critical table before the first upgraded writer runs. If a writer produces bad data, you can reset the table in seconds, then fix the writer at your own pace. Make sure snapshot expiration does not remove those snapshots during the upgrade window by checking your retention settings first.

### Sizing the effort

For a team with one Spark platform, one streaming pipeline, and a managed catalog, the work above fits in one or two weeks, most of it waiting for verification cycles. Teams with many engines, custom writers, and a homegrown catalog should plan for longer, because the catalog contract tests and the API search take real engineering time. The checklist does not change with size. The number of rows in your inventory does.

## Where Iceberg Goes After 1.12.0

The 1.12.0 release also tells you where the format is heading, and that helps you plan the next upgrade.

Format version 4 groundwork landed in this release, but version 4 has not been adopted. Iceberg 1.12.0 cannot create or commit a version 4 table. What it contains is a version 4 manifest reader that handles Parquet and Avro manifests, the ability to write manifests in the version 4 layout for testing, an adapter that surfaces version 4 tracked files through today's interfaces, relative paths in metadata, a content statistics addition to the spec, and a read-only implementation of a bounded-size compressed bitmap format based on Roaring. None of this changes your tables today. It does mean the next major format change has working code underneath it.

The spec work points the same way. The community adopted a formal expressions specification, so predicate expressions now have an engine-independent definition, and the REST spec aligned to it in the same release. Content file uniqueness got spelled out: within a snapshot, each content file appears in at most one live manifest entry. These definitions make it easier for many independent implementations to agree.

The dev list also started planning 1.13.0. The working target is early January 2027, with Spark 4.2 support, early version 4 work, and the version 4 spec pull request on the candidate list. Contributors also asked for a smaller release before the end of the year and for JDK 25 support. A vector type and a file type are under active design in biweekly community syncs, coordinated with a parallel vector type debate in Apache Parquet.

For planning, that means two things. Keep your upgrade process repeatable, because the community intends to ship on a steady cadence. And watch the version 4 discussions now, since the biggest metadata changes in years are coming, and the teams that read the proposals early will have the easiest migration.

## Conclusion

Apache Iceberg 1.12.0 is a maturity release with a wide reach. It makes format version 3 features practical in more engines, from vectorized Variant reads to geospatial DML to equality delete conversion in Flink. It expands the REST protocol and changes client behavior in ways catalog operators need to test. It removes old engine versions and a long list of deprecated APIs.

None of that makes the upgrade dangerous, if you treat it as a coordination problem. Keep the library upgrade separate from feature adoption. Upgrade readers before writers. Test your catalog's handling of retries and path encoding. Verify reads and branch writes across every engine that touches a table. Record snapshot IDs before the first new writer runs. Hold new features for a full cycle, then adopt them one at a time.

Do that, and 1.12.0 becomes what a point release should be: a set of improvements you pick up on your schedule, with a rollback path at every step.

## Keep Going

If this piece was useful, I have written a lot more on Apache Iceberg internals and operations. *Apache Iceberg: The Definitive Guide* covers the metadata structure, catalogs, and maintenance procedures that this upgrade touches, from snapshots and branches to compaction. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
