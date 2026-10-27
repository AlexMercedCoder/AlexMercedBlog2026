---
title: "Building Lightweight Serverless Ingestion to Apache Iceberg with PyIceberg and DuckDB"
date: 2026-08-19T09:00:00Z
tags: ["PyIceberg", "DuckDB", "serverless", "ingestion"]
canonical: https://iceberglakehouse.com/posts/serverless-iceberg-ingestion-pyiceberg-duckdb/
description: "Build lightweight serverless ingestion to Apache Iceberg with PyIceberg and DuckDB, running small feeds in functions that bill for seconds."
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/serverless-iceberg-ingestion-pyiceberg-duckdb/).

The most common ingestion job in most companies is small. A vendor drops a CSV in a bucket every hour. A webhook delivers a few thousand JSON events a minute. A SaaS export lands nightly at a few hundred megabytes. For years, the standard answer to "get this into the lakehouse" was the same regardless of size: stand up a Spark job, or buy a managed pipeline tool, and accept that the smallest task in the platform runs on the heaviest machinery.

That answer is obsolete, and the tools that obsoleted it matured fast enough that many teams have not noticed. PyIceberg, the pure-Python implementation of Apache Iceberg, writes tables directly from any Python runtime, no JVM, no cluster. DuckDB, the in-process analytical engine, now reads and writes Iceberg tables through a REST catalog, with MERGE INTO and v3 table support landing in its recent extension releases. Between them, a complete ingestion pipeline fits inside a serverless function that runs for seconds and bills for seconds.

This article builds that pipeline properly: the architecture, the working code, the design decisions that separate a demo from production, the limits of the runtime it runs in, and the boundaries where small tools stop being the right tools. A disclosure up front: I work at Dremio, a query engine vendor in the Iceberg ecosystem, and I have written books on this format. Nothing here requires any vendor's product, and that independence is the point of the pattern.

## The Case for Small Ingestion

Start with why this pattern deserves deliberate architecture rather than being treated as a toy. Three forces push real workloads toward lightweight ingestion, and each is worth naming precisely.

The first is the shape of the work. Ingestion at the edges of a platform is mechanical: fetch, parse, validate, maybe reshape, append, commit. There is no distributed join, no shuffle, no working set that exceeds one machine's memory. Distributed engines exist for problems that need distribution, and a 200 MB hourly file is not one of them. Running it through a cluster means paying cluster startup, cluster minimums, and cluster operations for a task a laptop finishes in seconds.

The second is economics, and the arithmetic is stark at the low end. A serverless function processing an hourly drop runs perhaps 30 seconds per invocation, 720 invocations a month, billed by the second at function rates. The equivalent always-on pipeline infrastructure, or per-job cluster spin-up, costs one to two orders of magnitude more for the same bytes moved, before counting the human cost of operating it. For a platform with dozens of small feeds, the difference funds an engineer.

The third is organizational. When ingestion requires the platform team's machinery, every new feed is a ticket in someone else's queue. When ingestion is a Python function writing through a governed catalog, the team that owns the data source owns its feed, and the platform team governs through the catalog instead of gatekeeping through infrastructure. The catalog-centric security model, short-lived credentials vended per table rather than storage keys handed to jobs, is what makes that delegation safe, and it is a newer capability than most teams' habits.

None of this argues that clusters are obsolete. It argues for matching machinery to work, and the honest observation is that the industry ran small work on big machinery for a decade because no alternative existed. Now one does.

## The Toolkit, Precisely

Three components make the pattern work, and knowing exactly what each does, and does not do, prevents most design mistakes.

PyIceberg is the Apache Iceberg project's native Python implementation, a library that speaks the table format and catalog protocols directly. It loads tables from REST, AWS Glue, Hive Metastore, and SQL catalogs, plans scans, and, critically for this article, writes: appends from Arrow tables, overwrites, upserts, schema changes, and table creation, all from a process that starts in milliseconds. Recent releases ride on a Rust core for the performance-critical paths, and the project's cadence through its 2026 releases has steadily closed the gap with the Java implementation for exactly the operations ingestion needs. What PyIceberg is not: a query engine. It reads and writes data, and it pushes down simple filters, and it does not execute SQL.

The write surface defines what the pattern can do without SQL: beyond plain appends, PyIceberg performs filter-scoped overwrites, upserts keyed on identifier columns, deletes by predicate, table creation, partition spec definition, and schema evolution through a fluent update API. That list is complete for ingestion, and the operations commit with the same snapshot semantics as any engine's writes, because they are the same specification implemented natively.

DuckDB is the query engine half. It runs in-process, starts instantly, and executes vectorized analytical SQL at speeds that embarrass much larger systems on single-node work. Its Iceberg extension grew from read-only beginnings into a full read-write client: attach an Iceberg REST catalog and DuckDB creates schemas and tables, inserts, updates, deletes, and, as of extension version 1.5.3, runs MERGE INTO, evolves schemas with ALTER TABLE, writes partitioned tables with partition transforms, and writes v3 tables where deletes become compact deletion vectors instead of Parquet positional delete files. The one boundary to respect: writes go through an attached REST catalog only, while the path-based iceberg_scan function stays read-only. That is the correct design, because the catalog is where commits become atomic and where governance lives.

The REST catalog is the piece that turns two libraries into a system. It is the standardized HTTP API for Iceberg catalogs, implemented by Apache Polaris, by managed platform catalogs, and by a growing field of others, and it does three jobs in this pattern: it arbitrates commits so concurrent writers do not corrupt each other, it vends short-lived storage credentials so functions never hold long-lived keys, and it gives every engine, from the Lambda writing the table to the warehouse-scale engine querying it, the same view of the same tables. Choosing REST catalog compatibility as a hard requirement is the single most future-proof decision in this architecture.

The division of labor follows naturally. PyIceberg owns table lifecycle and commits from Python. DuckDB owns SQL transformation, validation, and set-based operations like MERGE. The catalog owns atomicity and access. Some pipelines use PyIceberg alone, some use DuckDB alone, and the interesting ones compose both, with Arrow as the zero-copy handoff between them.

Polars and Daft both read Iceberg and both interoperate with PyIceberg through Arrow, and either substitutes for DuckDB where a DataFrame API fits the team better than SQL. The engines at the heavy end, Spark, Flink, Dremio, Trino, remain the right writers for large continuous streams and the right query layer for consumers. The pattern here occupies the space below them, and the shared catalog means nothing about choosing it now constrains choosing them later.

Choosing among the compositions is mostly reading the task:

| Pipeline shape                         | Right tool                                          | Reason                             |
| -------------------------------------- | --------------------------------------------------- | ---------------------------------- |
| Clean append, light reshaping          | PyIceberg alone                                     | Fewest moving parts, fastest start |
| Dedup, joins, aggregation before write | PyIceberg reads input, DuckDB transforms and writes | SQL where SQL wins                 |
| Upserts on business keys               | DuckDB MERGE INTO                                   | One atomic set-based statement     |
| Table setup and evolution scripts      | DuckDB SQL or PyIceberg API                         | Version-controlled DDL either way  |
| Sustained high-volume streams          | Graduate to a streaming engine                      | Beyond the pattern's boundaries    |

## Serverless Limits You Design Against

A function is not a laptop, and the gap between the two shows up as five hard numbers. Every platform sets them slightly differently.

Execution time is capped. AWS Lambda stops at 15 minutes. Cloud Run jobs and Azure's premium plans go longer, but a function that regularly runs for 10 minutes is one slow object store call away from a timeout it cannot recover. Size batches so the typical invocation finishes under 2 minutes and the worst case under 5.

Memory is capped and it is what you pay for. A 500 MB Parquet batch decompressed into Arrow is 2 to 4 GB, and DuckDB and PyArrow both want their own copy. Set DuckDB's `memory_limit` to roughly 60 to 70 percent of the function's memory, and set `threads` to match the vCPU count rather than letting DuckDB assume a big machine.

Temporary disk is small. Lambda's `/tmp` starts at 512 MB and can be raised to 10 GB. DuckDB spills there when it passes its memory limit, so point `temp_directory` at `/tmp` and size the two together. On Cloud Run the filesystem is in memory, so spills count against the memory limit instead, and a job sized for Lambda fails there.

Package size is capped at 250 MB unzipped for a Lambda zip, and PyArrow alone eats a large fraction of it. Use a container image, which allows up to 10 GB, and install only the extras the feed needs. The `s3fs`, `gcsfs`, and `adlfs` extras each pull in a cloud SDK, and a feed writes to exactly one cloud.

Cold starts cost 1 to 3 seconds for the imports alone, plus whatever DuckDB spends fetching an extension. For a function running every minute that is a small fraction of invocations, and for one running hourly it is every invocation. Initialize the catalog client and the DuckDB connection at module scope so warm invocations reuse them, and bake the extensions into the image.

| Constraint          | AWS Lambda                        | Google Cloud Run (jobs)                     | Azure Functions (Premium)  |
| ------------------- | --------------------------------- | ------------------------------------------- | -------------------------- |
| Max execution time  | 15 minutes                        | 24 hours per task                           | Unbounded (60 min default) |
| Max memory          | 10 GB                             | 32 GB                                       | 14 GB                      |
| Ephemeral disk      | 512 MB to 10 GB                   | In-memory filesystem, counts against memory | Up to 250 GB               |
| Deployment          | Zip (250 MB) or container (10 GB) | Container                                   | Zip or container           |
| Concurrency control | Reserved concurrency per function | Max instances, task parallelism             | Max scale-out per plan     |
| Native scheduling   | EventBridge                       | Cloud Scheduler                             | Timer trigger              |

Packaging is where the package size limit and the cold start get solved or created, and a container image settles both:

```dockerfile
FROM public.ecr.aws/lambda/python:3.12

RUN pip install --no-cache-dir \
    "pyiceberg[s3fs,pyarrow]==0.11.1" \
    "duckdb==1.5.3"

RUN python -c "import duckdb; c = duckdb.connect(); \
    c.execute('INSTALL iceberg'); c.execute('INSTALL httpfs')"

ENV DUCKDB_EXTENSION_DIR=/tmp/duckdb_ext

COPY ingest.py ${LAMBDA_TASK_ROOT}/
CMD ["ingest.handler"]
```

Three decisions in that file matter. Pin both libraries to exact versions, because a floating pin picks up the next release candidate the day it ships, and because DuckDB's Iceberg extension is versioned against the DuckDB binary, so a mismatch surfaces as a load error on a cold start rather than in a test. Install extras selectively, one image per cloud. And pre-install the DuckDB extensions at build time, because DuckDB writes installed extensions under the home directory, which is read-only at execution time on most runtimes. Point `extension_directory` at a writable path, or every cold start fetches 20 MB from the CDN first.

## The Architecture: Event-Driven Ingestion

The reference architecture is short enough to hold in your head, which is one of its virtues.

An event source triggers a function. The classic trigger is object storage notification, a file landing in a raw bucket fires the function with the object's key, and the same shape serves queue-driven ingestion from SQS or Pub/Sub, scheduled pulls from APIs on a cron trigger, and webhook receivers behind an API gateway. The function authenticates to the REST catalog with its identity, not with storage keys. It reads the raw input, validates and transforms it into the target schema, appends or merges into the Iceberg table, and exits. The commit lands atomically through the catalog, and every downstream consumer, warehouse-scale engines included, sees the new snapshot on their next query.

One refinement on the trigger is worth making on day one, because it decides how many commits the table absorbs. Instead of one invocation per arriving object, schedule one invocation per feed per interval and have it list or dequeue everything since the last watermark. A hot feed runs every 2 minutes, a cold one every 15, and each invocation commits once for many events rather than once per event. The per-object trigger is how teams end up committing every two seconds and filling a table with 40 KB files. The interval trigger costs a little freshness and buys a great deal of file sizing.

That shape needs a watermark, and the ordering rule is what makes it safe: advance the watermark only after the commit returns. If the function dies after writing files but before committing, the files are orphans that maintenance cleans up, and the next invocation re-reads the same input. If it dies after committing but before advancing the watermark, the next invocation re-reads and commits the same rows again, which is why idempotency has to be designed in rather than hoped for. The gap is narrow and it closes permanently only with an idempotent write path.

For a feed too large for one invocation, shard by partition rather than by time, each shard a function writing only its partition values. Writers on disjoint partitions still contend on the metadata pointer, but they never conflict on data, so the retry succeeds without rewriting anything.

The properties worth noticing are the ones missing. There is no pipeline server, nothing running between invocations, no cluster to size, because the event is the orchestration. State lives in the raw bucket, which is the replay log, the Iceberg table, whose snapshots are the record of what committed, and one small watermark table. That statelessness is what makes the pattern reliable, and preserving it is a design discipline the later sections defend.

One layout convention pays for itself immediately: structure the raw bucket as a permanent landing zone, not a scratch space. Prefix objects by feed and arrival date, never delete on success, and transition old objects to cold storage rather than removing them. The raw zone is the replay log and the audit trail: reprocessing after a bug means re-firing events over existing objects, backfilling a column means replaying a date range, and answering "what did the vendor send us on March 3rd" means reading the object, not archaeology. Cold storage costs almost nothing, and the first bad-transform incident repays a decade of it.

## The Code: A Working Ingestion Function

Here is a complete ingestion handler in the PyIceberg-only style, the shape I reach for first when the transformation is light. The example is AWS Lambda for concreteness, and nothing about it is AWS-specific.

```python
import json
import pyarrow as pa
import pyarrow.csv as pv
import pyarrow.fs as pafs
from pyiceberg.catalog import load_catalog

CATALOG_URI = "https://catalog.example.com/api/catalog"
TABLE_NAME = "sales.vendor_orders"

def handler(event, context):
    record = event["Records"][0]
    bucket = record["s3"]["bucket"]["name"]
    key = record["s3"]["object"]["key"]

    catalog = load_catalog(
        "lakehouse",
        **{
            "type": "rest",
            "uri": CATALOG_URI,
            "warehouse": "prod",
            "credential": "CLIENT_ID:CLIENT_SECRET",
        },
    )
    table = catalog.load_table(TABLE_NAME)

    s3 = pafs.S3FileSystem()
    with s3.open_input_stream(f"{bucket}/{key}") as stream:
        arrow_table = pv.read_csv(stream)

    arrow_table = arrow_table.cast(table.schema().as_arrow())

    table.append(arrow_table)

    return {
        "status": "committed",
        "rows": arrow_table.num_rows,
        "source": key,
    }
```

Walk the load-bearing lines. The catalog configuration authenticates the function's identity to the REST catalog, and the credential shown as a placeholder belongs in your secret manager, injected at runtime. From that point, storage access flows through credentials the catalog vends for this table, scoped and short-lived, which is why the function's IAM role needs no direct grant on the warehouse bucket. The CSV is read straight into Arrow and cast against the table's schema, the cheapest validation gate you will ever install, because a column drift fails loudly here instead of landing silently as bad data. The append writes Parquet into the table's location and commits a new snapshot through the catalog in one atomic step. If anything above the append raises, nothing committed, and the event redelivers for retry.

Cold starts deserve one honest paragraph, because they are the serverless tax everyone asks about. The imports above, PyArrow especially, cost a second or two on a cold invocation, and catalog authentication adds a round trip. For hourly and minutely feeds this is noise. For latency-sensitive webhook ingestion, standard mitigations apply, provisioned concurrency or a slim container image, and if single-digit-millisecond ingestion latency is a genuine requirement, this is the wrong pattern entirely, and a streaming engine is the right one. Moving the catalog handle and the DuckDB connection to module scope costs nothing and pays on every warm invocation. Choosing tools honestly includes naming what they are not for.

## Adding DuckDB: SQL in the Middle

The PyIceberg-only function covers clean appends. Real feeds are rarely clean, and the moment the work becomes relational, deduplicate against what already landed, join a reference table, aggregate before writing, upsert on a business key, you want SQL, and DuckDB supplies it in-process.

The composition pattern that keeps the best of both: DuckDB attaches the REST catalog and does the relational work, including the write, while Arrow moves data between Python and SQL with zero copies. Here is the upsert version of the handler's core, replacing the plain append:

```python
import duckdb

con = duckdb.connect()
con.execute("INSTALL iceberg; LOAD iceberg;")
con.execute("""
    CREATE SECRET catalog_auth (
        TYPE iceberg,
        CLIENT_ID 'CLIENT_ID',
        CLIENT_SECRET 'CLIENT_SECRET',
        OAUTH2_SERVER_URI 'https://catalog.example.com/api/catalog/v1/oauth/tokens'
    )
""")
con.execute("""
    ATTACH 'prod' AS lakehouse (
        TYPE iceberg,
        ENDPOINT 'https://catalog.example.com/api/catalog'
    )
""")

con.register("incoming", arrow_table)

con.execute("""
    MERGE INTO lakehouse.sales.vendor_orders t
    USING (
        SELECT * EXCLUDE (rn) FROM (
            SELECT *, row_number() OVER (
                PARTITION BY order_id ORDER BY updated_at DESC
            ) AS rn
            FROM incoming
        ) WHERE rn = 1
    ) s
    ON t.order_id = s.order_id
    WHEN MATCHED THEN UPDATE SET
        status = s.status,
        updated_at = s.updated_at
    WHEN NOT MATCHED THEN INSERT *
""")
```

The register call is the seam: the Arrow table from the ingestion step becomes a SQL-queryable relation with no serialization, because DuckDB reads Arrow memory directly. The inner query deduplicates the batch itself, keeping the latest version per key, which matters because vendor files and webhook batches routinely contain their own duplicates. The MERGE then reconciles against the live table, and on a v3-format table the extension writes the delete side of matched updates as deletion vectors, the compact Puffin-encoded form, rather than as a scatter of positional delete Parquet files. The whole statement commits as one Iceberg snapshot through the catalog.

The other composition suits different teams: DuckDB transforms the batch and hands the Arrow result to PyIceberg's append, leaving the write to the reference implementation. That shape is the safer default on Azure, where the DuckDB extension's attached catalogs cover S3, S3 Tables, and GCS but not yet ADLS.

Two version-sensitive notes keep this section honest over time. The extension's write capabilities grew in visible stages, initial writes in its 1.4 line with update and delete support arriving for v2 tables under merge-on-read semantics, then the 1.5.3 wave adding MERGE, partitioned writes with transforms, ALTER TABLE, and v3 tables where deletes become deletion vectors. The extension updates between DuckDB releases, so running its update command in your build process and pinning what you deploy are both worth the minute they take. It also respects the table's declared write modes: tables configured for copy-on-write updates refuse merge-on-read writers rather than silently disobeying the table's contract, which is the behavior you want from a guest in a multi-engine lakehouse and one more reason to set those properties deliberately at creation.

The same attached catalog turns DuckDB into the table lifecycle tool for the pipeline's setup scripts: CREATE SCHEMA and CREATE TABLE with partition transforms, ALTER TABLE as feeds evolve, all in SQL that lives in version control next to the function code. Between PyIceberg's programmatic API and DuckDB's SQL surface, choose per task and feel no guilt: they commit through the same catalog into the same tables, and mixing them is normal, not messy.

## What Actually Happens on a Small Commit

Trusting a pattern in production is easier when you can narrate its critical path, so walk what the append in that handler physically does, because the details explain both the reliability and the maintenance metabolism.

The append call writes the Arrow table as one or more Parquet files into the table's data location, sized by what arrived, using credentials the catalog vended when the table loaded. Nothing about those files is visible to any reader yet, which is the property that makes crashes benign: data files without metadata are inert bytes. PyIceberg then constructs the metadata for the new snapshot, a manifest listing the new files with their column statistics, and the commit machinery above it, and asks the catalog to advance the table from the snapshot it loaded to the new one.

The catalog performs the only step that needs coordination: an atomic compare-and-swap on the table pointer. If no other writer committed since this function loaded the table, the swap succeeds and the snapshot is live, all files at once, for every engine on their next planning call. If another writer got there first, the swap fails cleanly, the library refreshes to the current snapshot, reapplies the append against it, and retries, which for pure appends is conflict-free reconciliation, since two batches of new files never contend for the same rows. Upserts reconcile with more care, and the same retry loop governs them.

Three practical consequences fall out of this narration. Readers never see partial data, which is why downstream jobs can trigger on table updates without coordination protocols. Failed invocations litter only unreferenced files, which is why orphan cleanup exists and why storage alarms should not panic on them. And every commit costs a catalog round trip plus a pointer race, which is the physical reason batching matters: the pattern's ceiling is not bandwidth, it is commit arbitration, and designing around single-digit commits per table per minute keeps the race trivially winnable. Every commit also adds at least one manifest, one manifest list, and one metadata file, so a function committing every 10 seconds produces 8,640 snapshots a day and at least that many small objects at every level of the metadata tree.

## The Design Decisions That Separate Production From Demo

The handler above works. Whether the system works after six months depends on decisions the happy path never exercises. These five are the ones that matter, in the order teams usually learn them.

**Idempotency, because every trigger delivers twice eventually.** Object notifications, queues, and webhooks all deliver at-least-once, and a function that blindly appends turns every redelivery into duplicate rows. The defenses, in increasing strength: make the write an upsert on a business key, as the MERGE version does, so replays converge instead of duplicating. Track processed source objects in a small manifest table and skip keys already ingested, checked and updated in the same pipeline. Or write each source object to a deterministic target, overwriting a partition derived from the input key, so replays overwrite themselves. Pick one deliberately and write it in the runbook, because "we retry safely" is the property everything else leans on.

**Commit concurrency, because functions scale out and catalogs arbitrate.** Iceberg commits are optimistic. Every write carries a requirement that the table's metadata is still the version it started from, the catalog checks that requirement atomically with the update, and the first writer to commit moves the table forward while the rest fail cleanly, reload, rebuild their manifest list on top of the winner, and commit again. Nothing is lost, and the cost is the retry itself: a metadata reload, a new manifest list, a new metadata file, one more round trip. PyIceberg retries with exponential backoff and jitter for exactly this reason, tunable through the `commit.retry.num-retries`, `commit.retry.min-wait-ms`, and `commit.retry.max-wait-ms` table properties. Under light contention the cost is milliseconds. With 20 functions arriving at once and 19 losing the first race, it becomes a thundering herd where every retry conflicts with a different winner, and throughput collapses precisely when the feed gets busy. The design answers are batching and serialization. Batch upstream, an SQS queue in front of the function with batch size tuned so each invocation commits once for many events. Serialize per table, function concurrency limits or FIFO queues keyed by table, so one table sees one committer at a time while different tables ingest in parallel. Design for commits per table per minute in the single digits, and treat anything beyond as a signal to batch harder or graduate the feed to a streaming writer.

**File sizes, because small writers write small files.** A function committing every few minutes writes files sized by what arrived, often single-digit megabytes, and a table accumulating thousands of tiny Parquet files punishes every reader. A 2 MB commit every minute is 1,440 files a day and 43,200 a month, and query planning evaluates every one. Batch harder at write time, and accept that the real answer is scheduled compaction, covered below, treated as part of the table's contract rather than an apology.

**Schema drift, because upstreams change without warning.** The cast against the table schema catches drift and turns it into a clear failure, which is the right default: better a dead-letter queue full of the vendor's surprise column than a table quietly missing it. For sources you control, evolve deliberately, through PyIceberg's schema update API or DuckDB's ALTER TABLE, committed as part of a release. For sources you do not, route cast failures to a dead-letter location with the payload intact, alert, and decide as humans. Automatic evolution on external feeds is how tables end up with seventeen variants of the same column.

**Secrets and identity, because functions multiply.** The catalog-credential model earns its keep here: functions hold only their client credentials from the secret manager, storage access arrives vended and scoped per table, and rotating one secret in one place rotates the fleet. Resist the shortcut of granting functions direct bucket access, because it works immediately and then becomes a permanent, unauditable bypass of the governance the catalog exists to provide. One expiry detail belongs here too: vended storage credentials and catalog OAuth tokens both have lifetimes, often an hour, and an append that outlives one fails on its last Parquet write with an access-denied error near the end of a long invocation. Keep batches short and treat that failure as retryable.

One gap sits outside all five, because optimistic concurrency cannot close it: the duplicate commit from a retried invocation. A function commits, then dies before advancing its watermark, the platform retries, the retry reads the same input and commits the same rows, and both commits were perfectly valid appends. Nothing in the table format can tell them apart. Apache Polaris 1.7.0 added an opt-in fix at the catalog level: a client sends an `Idempotency-Key` header on create and update requests, the catalog stores that key with the table entity in the same transaction as the commit, and a retry carrying the same key inside the TTL, five minutes by default, receives the original success response instead of applying the change twice. Derive the key from the batch identity, a hash of the sorted input object keys works. As of PyIceberg 0.11.1 that header is not yet a first-class per-request API, so sending it means a small patch to the commit path or a wrapper around the REST call. Until the chain is idempotent end to end, deduplicate on read with a qualify on the key, or let compaction deduplicate as it rewrites, and know that both are fallbacks rather than fixes.

## Maintenance Is Part of the Table's Contract

A table written by small, frequent committers has a predictable metabolism: many small data files, many snapshots, and, for upsert feeds on v3 tables, accumulating deletion vectors. None of this is pathology. All of it is scheduled work, and the serverless pattern is only complete when maintenance is designed in rather than borrowed from whoever notices slow queries first.

Three jobs, on calendars, per table. Compaction rewrites small files into read-optimized ones, targeting the streaming-written partitions, daily on active tables. Snapshot expiration trims history to the agreed time-travel window, weekly, and setting `history.expire.max-snapshot-age-ms` deliberately is part of the same decision. Orphan cleanup removes files abandoned by failed writes, less often and reliably, with a grace period longer than your longest possible invocation so an in-flight commit's files are never deleted from under it. The jobs themselves run anywhere: a scheduled function invoking an engine's maintenance procedures, a small container on a scheduler, or a managed catalog's automatic table services, which increasingly handle exactly this and suit this pattern beautifully, since the whole point is minimizing infrastructure you operate. Note what still needs an engine: PyIceberg has no rewrite-data-files action yet, so the data file rewrite itself runs in Spark, Dremio, Trino, or a DuckDB rewrite, even where the catalog handles expiration and cleanup.

Size targets give the compaction job its goal: rewrite toward the table's target file size, typically in the low hundreds of megabytes, and confine each run to recent partitions where the small files concentrate, since cold partitions compact once and stay compacted. On upsert feeds, fold delete cleanup into the same pass, so files carrying accumulated deletion vectors get rewritten clean in one motion rather than in two jobs that each rewrite the same bytes. One targeted pass, one owner, one calendar entry per table is the entire ambition.

The organizational half matters as much. The schedule belongs in the dataset's documentation next to its schema and owner, and one team owns it per table. The anti-pattern to avoid by name: every consumer of a slow table independently running compaction against it, conflicting with each other and with the writers. One metabolism, one caretaker.

## The Cost Model, Honestly

The economics are the pattern's loudest selling point, so they deserve honest arithmetic rather than a slogan, and the honest version includes where costs hide.

The visible costs are function seconds and object storage requests. A minutely feed running two-second invocations totals well under an hour of compute a day, which at serverless rates is coffee money monthly. Against any always-on alternative, the pattern wins by an order of magnitude or more for feeds below a few gigabytes per hour. That comparison is real and durable, and it is the one on the slide.

The hidden costs are requests and maintenance. Small commits mean more PUT requests per byte, the catalog round trips add API traffic, and the maintenance jobs consume compute that the ingestion saved. Sum honestly and the pattern still wins comfortably at small scale, and the margin narrows as volume grows. That narrowing is the graduation signal: when a feed's function time, request charges, and compaction load approach what a right-sized continuous writer costs, the feed outgrew the pattern. Put a monthly cost line per feed on a dashboard and the moment announces itself.

## The Development Loop Nobody Advertises

An underrated property of this stack: the whole pipeline runs on a laptop, unchanged, because nothing in it needs infrastructure that only exists in the cloud. Designing that into your workflow collapses the develop-and-test cycle from minutes to seconds.

The local setup mirrors production in miniature. A REST catalog runs as a local container, several open implementations ship images that start in seconds, backed by a temp directory. The handler imports and runs as a plain Python function in a test, with the event payload built as a fixture. PyIceberg and DuckDB behave identically locally and deployed, because they are libraries, not services.

That enables a testing pyramid most pipeline stacks cannot offer honestly. Unit tests exercise transformation logic against Arrow tables in memory. Integration tests run the full handler against the containerized catalog and assert on committed snapshots: row counts, schema, and, for the idempotency test the design section demanded, invoking the handler twice with the same event and asserting the table converged instead of duplicating. That double-invocation test is the highest-value test in the suite, and it runs in seconds in CI on every commit. Deployment stops being the first time the pipeline meets a real catalog.

Keep one honest gap on the checklist: local containers do not reproduce cloud identity, so credential vending and IAM interplay need a staging pass. Everything else tests locally, which is what makes small feeds cheap to build as well as cheap to run.

## Observability for Pipelines That Are Not Running

Serverless ingestion inverts the monitoring problem: there is no pipeline server to health-check, and silence is ambiguous between "nothing arrived" and "everything is broken." Observability here means instrumenting outcomes rather than processes, and four signals cover it.

Freshness is the primary signal: the lag between now and the newest data in the table, measured from snapshot timestamps or a max event-time query, alerted per feed against that feed's expected cadence. It catches every failure mode upstream of it, dead triggers, failing functions, poisoned queues, without knowing which one fired, and it is the alert that pages.

Volume validates plausibility: rows committed per window against historical bands, catching the silent partial failures freshness misses, the vendor file that arrived half-sized, the webhook that started dropping fields.

Dead-letter depth is the third alert, because the dead-letter queue is where designed-for failures accumulate, and an unwatched queue is just a slower way to lose data. Non-zero depth is a work item, sustained growth is a page.

And commit retries per table, exported from the function's logs, is the early-warning gauge on concurrency: a climbing retry rate says writers are colliding and batching needs adjustment, weeks before it becomes visible as latency. Add files per snapshot, average data file size, and commits per hour to the same dashboard, and the table's health fits in one glance.

All four derive from the table, the queue, and function logs, no agents and no monitoring infrastructure, which keeps the operational surface as small as the compute surface. Wire them into the same dashboard as the per-feed cost line, and each feed becomes a glanceable row: fresh, plausible, clean, cheap.

One more line belongs in the economics discussion because procurement teams ask about it: portability. Every component here is either open source or a commodity cloud primitive with an equivalent on every provider. The handler changes its trigger parsing and storage client between clouds and nothing else, the catalog protocol is a standard, and the tables are open format on object storage. A platform built this way negotiates with its cloud provider from a position no proprietary pipeline product offers, and the tail of small feeds, usually the stickiest integrations in a migration audit, becomes the easiest part of the estate to move.

## Failure Modes Worth Rehearsing

**The partial-batch trap.** A function processing a hundred queue messages commits once, then crashes before acknowledging, and the batch redelivers. Without idempotency this is silent duplication at batch scale. This is failure mode number one in practice, which is why idempotency led the design section, and rehearsing it means literally forcing a redelivery in staging and checking row counts.

**The runaway retry loop.** A poison input, a malformed file, a payload that always fails the cast, redelivers forever, burning invocations and burying real errors. Every trigger needs a dead-letter destination and a maximum receive count, configured on day one, because the day you need it is not the day to add it.

**Timeout mid-write.** Functions have wall-clock limits, and an invocation that dies during the write phase leaves data files without a commit, invisible to readers, cleaned by orphan maintenance. The failure is benign for the table and looks alarming in storage. Size timeouts generously against worst-case inputs, and let orphan cleanup do its quiet job.

**The catalog outage.** Every write path in this pattern runs through the catalog, which is the correct design and a real dependency. During a catalog outage, ingestion pauses, events accumulate in queues, and recovery is automatic when service returns, which is exactly the behavior you want and exactly what to verify in a game day. The raw bucket plus replayable triggers is the disaster story: nothing is lost, everything is re-runnable.

**The silent version drift.** The function image pins PyIceberg, the extension autoloads its version, the table sits at a format version, and a year passes. A v3 table gains features some pinned client cannot write, or a new client writes what an old reporting tool cannot read. Same discipline as every fleet: a compatibility note per table, versions bumped deliberately, one canary feed upgraded first.

## Backfills and Replays, Designed In

Every ingestion system eventually runs backward: a transform bug corrupts three weeks of a table, a new column needs history, a vendor resends corrected files. Pipelines designed only for forward flow handle these moments with panic and hand-written scripts. This pattern handles them with the pieces it already has, provided two designs were honored: the permanent raw landing zone and an idempotent write path.

The replay itself is mechanical. Re-fire events over the raw objects for the affected range, a short script listing keys and invoking the function or re-enqueueing messages, and let the idempotent writes converge the table. Upsert-shaped feeds reapply and settle to correct values. Overwrite-partition feeds rewrite the affected partitions cleanly. Plain-append feeds with a processed-keys manifest need the affected keys cleared from the manifest first, which is the moment that strategy proves its worth, because it makes the replay's scope explicit and auditable.

Iceberg contributes its own tools here. Snapshot history means the pre-bug state stays queryable while the replay runs, so validation is a query comparing the corrected range against expectations, and communication to consumers cites concrete snapshots. For the sharpest incidents, rolling back to the last good snapshot and then replaying forward from the raw zone turns a corruption into a rewind, with the audit trail recording the whole episode. Rehearse a small replay once in staging, write the script into the runbook, and this failure category loses its teeth.

## When to Graduate

Graduate a feed to a streaming writer or engine-based pipeline when sustained volume keeps invocations near their memory or time ceilings, when required commit frequency defeats reasonable batching, when latency requirements drop below what cold starts and batching allow, or when transformation logic grows joins and state that fight the stateless shape. Graduate nothing merely because it grew steadily, and let the cost dashboard tell the truth about the crossover.

Notice what graduation does not require: migrating the table. The Iceberg table, its catalog entry, its history, and every consumer stay exactly where they are while the writer changes underneath. That is the payoff of standing everything on open formats and a standard catalog, and it is the reason this architecture ages gracefully: every component is replaceable because every interface is open.

## A Worked Example: Thirty Feeds, One Pattern

To see the pattern operating as a platform rather than a trick, here is a composite of deployments I have watched teams build, with no invented benchmark numbers.

The setting is a mid-sized company whose analytics platform runs on Iceberg with a REST catalog, warehouse-scale engines serving BI, and a long tail of inbound data: a dozen SaaS exports landing nightly as files, several vendor drops on odd schedules, webhook streams from two product surfaces, and a handful of partner APIs polled hourly. Before the migration the tail ran through a managed ETL tool, two inherited cron servers, and three feeds that were "temporarily" manual. Its monthly bill exceeded the bill for the core pipelines, and every new feed was a three-week ticket.

The platform team's move was to build the pattern once as a template rather than thirty times as functions. The template is a repository scaffold: a handler skeleton with the catalog connection, schema cast, and dead-letter routing wired, the double-invocation idempotency test written and failing until the feed author picks a strategy, Terraform for the trigger, queue, and alarms, and a manifest where the feed declares its table, cadence, and expected volume band, from which the alerts generate. A new feed is a pull request: implement the transform, choose an idempotency strategy from the three documented options, set the manifest values, and the paved road does the rest.

Adoption sorted the feeds naturally. The nightly files and API polls moved first, a day or two each, mostly PyIceberg-only handlers. The webhook streams took the DuckDB MERGE shape with SQS batching in front, tuned until commits per table settled into single digits per minute. Two feeds refused the pattern honestly: a high-volume clickstream stayed on its streaming writer, and one legacy feed's transformation was so stateful it went to the engine-based pipeline where it belonged. The template's boundary documentation names both outcomes as success, because owning everything was never the goal.

The steady state a few quarters in: several dozen feeds, each a glanceable dashboard row, maintenance centralized through the catalog platform's table services plus one scheduled compaction job the team owns, and the tail's infrastructure bill reduced to function seconds and requests. The change nobody predicted mattered most: source teams began shipping their own feeds through the template, with the platform team reviewing pull requests instead of holding a queue, and the three-week ticket became a two-day PR. The architecture's cheapest resource turned out to be permission.

## Where This Is Heading

Three changes will make this pattern noticeably better over the next year, and all three point the same direction: Iceberg is becoming a library rather than a platform.

The first is PyIceberg's Rust core. The `pyiceberg-core` package, built from iceberg-rust, is where the heavy operations are moving, starting with manifest parsing and statistics and heading toward data file writing. Every piece that moves there shrinks the memory footprint and shortens the cold start, and those two numbers matter more inside a function than anywhere else in the stack. Async scan planning through the REST catalog is planned for a later release, cutting the metadata work a function does before it can commit.

The second is DuckDB's extension closing its storage gap. Attached REST catalogs on ADLS are the missing piece for Azure teams who want the SQL-native shape. Watch the extension changelog rather than the DuckDB release notes, because they ship on different schedules.

The third is idempotent commits becoming standard rather than a catalog feature. Polaris 1.7.0 shipped the first opt-in implementation, the Iceberg REST specification has been discussing a standard header since late 2025, and once PyIceberg and DuckDB both send it, the duplicate-on-retry window closes for every catalog. The watermark-after-commit ordering then becomes belt and suspenders rather than load bearing.

The format itself is also chipping at the metadata cost of frequent commits: v4 proposals for a root manifest with inlined small commits would collapse the three metadata objects each commit writes today into far fewer. None of it is shipped, and all of it targets exactly the workload this pattern produces. The Spark cluster remains the right tool for terabyte-scale backfills and for the compaction job. It stopped being the right tool for landing the stream.

## Conclusion

Small ingestion deserved small machinery for years before small machinery existed. Now it does, and it is not a compromise: PyIceberg gives Python direct, correct table writes, DuckDB puts real SQL, MERGE included, inside the same process, and the REST catalog makes the whole thing governed, atomic, and engine-agnostic. A function, a queue, a catalog, and two libraries cover the long tail of feeds that never needed a cluster, at costs that round toward zero and with an operational surface a single team can own.

Build it with the five production decisions made deliberately, idempotency, concurrency, file sizes, schema drift, and identity, size the function against the runtime's real limits rather than a laptop's, and put maintenance on the calendar as part of each table's contract. Then watch the cost line for the day a feed earns heavier tools. The tables stay open, the writers stay swappable, and the platform team gets out of the queue-ticket business. That is what right-sized architecture feels like.

## Keep Going

If this piece was useful, I have written much more on building lakehouses at every scale. _Apache Iceberg: The Definitive Guide_ from O'Reilly covers the format underneath this whole pattern, _Architecting an Apache Iceberg Lakehouse_ from Manning covers the platform design decisions around it, and _Apache Polaris: The Definitive Guide_ from O'Reilly covers the REST catalog and credential vending that make it secure. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
