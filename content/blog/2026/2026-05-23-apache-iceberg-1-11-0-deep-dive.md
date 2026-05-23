---
title: 'An In-Depth Overview of the Apache Iceberg 1.11.0 Release'
date: '2026-05-23'
description: 'Apache Iceberg 1.11.0 delivers manifest list encryption, the new pluggable File Format API, credential lifecycle refreshes, and Spark/Flink improvements.'
author: 'Alex Merced'
tags:
  - Apache Iceberg
  - Data Lakehouse
  - Releases
---

# An In-Depth Overview of the Apache Iceberg 1.11.0 Release

Apache Iceberg 1.11.0 was officially released on May 19, 2026, marking a major milestone in the evolution of open data lakehouse architectures. While minor point releases often focus on small bug fixes and dependency bumps, this release introduces fundamental structural changes. The community has completed major initiatives to improve security, extend file format capabilities, and optimize query planning overhead.

This release represents a convergence of two development focuses. First, it introduces structural changes to the core metadata specification to support advanced security features and lay the groundwork for future format revisions. Second, it stabilizes several feature sets in the Iceberg format specification, moving them from experimental status to fully stable defaults. 

This post analyzes the most critical improvements in the Apache Iceberg 1.11.0 release. We will examine the specific GitHub pull requests, explain the underlying mechanics of each feature, and review what these changes mean for data engineers and platform architects.

![Apache Iceberg 1.11.0 release overview diagram showing Security, Catalog, Storage, and Engine pillars](/assets/images/2026/apache-iceberg-1-11-0-deep-dive/)

---

## Manifest List Encryption (PR #7770, #15813)

Security in open data lakehouses has historically focused on encrypting the actual data files stored in object storage. While file-level encryption prevents unauthorized users from reading raw Parquet or ORC data, the table metadata has remained exposed. In a default setup, anyone with read access to the storage bucket could inspect the metadata JSON, manifest lists, and manifest files. 

These metadata files contain sensitive structural details. An attacker scanning an unencrypted manifest list can extract file paths, column names, partitions, partition bounds, and exact null value counts. In highly regulated industries such as healthcare or financial services, this structural exposure constitutes a major data leak.

To resolve this vulnerability, PR #7770, introduced by @ggershinsky, adds native encryption for manifest lists. This change works alongside follow-up improvements in PR #15813. Manifest lists can now be encrypted using the Galois/Counter Mode (GCM) stream cipher.

```
Metadata JSON (Contains encryption state references)
       │
       ▼
Manifest List (Encrypted via GCM Stream Cipher) ◄── Decrypted in-memory during planning
       │
       ▼
Manifest Files (Point to encrypted Parquet data files)
```

When a query engine plans a scan against an encrypted table, it performs the following sequence:

1. The client queries the catalog to fetch the table metadata.
2. The catalog returns the metadata location along with the required decryption keys.
3. The query engine reads the encrypted manifest list from object storage.
4. Using the catalog keys, the engine decrypts the manifest list in-memory.
5. The engine processes the decrypted partitions and statistics to prune manifest files.

This approach ensures that the manifest list is never written to disk in plain text. Unauthorized actors who bypass the catalog and scan the raw storage bucket will find only encrypted bytes, protecting both the table contents and its structural metadata.

![Manifest list encryption sequence showing key exchange and decryption query planning](/assets/images/2026/apache-iceberg-1-11-0-deep-dive/)

---

## Pluggable File Format API and V4 Spec Foundations (PR #15049)

Historically, Apache Iceberg hardcoded its support for data file formats. The core library contained format-specific code paths for Parquet, ORC, and Avro. If you wanted to query or write a table, the engine executed internal code blocks tailored to those exact structures.

This hardcoded design created a major bottleneck for format innovation. If a team wanted to test a next-generation format, they had to modify the core engine codebase, extending complex switch statements and format-dependent utilities.

PR #15049, introduced by @anoopj, restructures this architecture. It introduces a pluggable File Format API that decouples Iceberg core metadata management from physical storage layouts.

```
┌────────────────────────────────────────────────────────┐
│                  Iceberg Core Engine                   │
└───────────────────────────┬────────────────────────────┘
                            │
                            ▼
┌────────────────────────────────────────────────────────┐
│            File Format API Interface Layer             │
└──────┬────────────┬─────────────┬─────────────┬────────┘
       │            │             │             │
       ▼            ▼             ▼             ▼
  ┌─────────┐  ┌─────────┐   ┌─────────┐   ┌─────────┐
  │ Parquet │  │   ORC   │   │ Vortex  │   │  Lance  │
  └─────────┘  └─────────┘   └─────────┘   └─────────┘
```

The File Format API provides a clean plugin interface. A file format is defined as a plugin that implements standard reader and writer interfaces. Iceberg core negotiates table transactions, schemas, and partition specs, while delegating the physical file access to the registered plugin.

This decoupling makes it practical to support next-generation formats:

*   **Vortex:** A general-purpose, modular format designed as a successor to Parquet. It supports direct GPU decompression and allows query filters to run directly against compressed data. The community is actively using the new API to build a Vortex-backed Iceberg plugin.
*   **Lance:** A layout built for machine learning and AI workloads. It is optimized for high-dimensional vector search and random access to nested embeddings.
*   **Nimble:** A format optimized for wide tables containing thousands of feature columns. Nimble prioritizes fast decoding over high compression ratios, which accelerates model training pipelines.

Additionally, PR #15049 introduces the foundational Java interfaces and types for the upcoming V4 manifest specification. These changes prepare Iceberg for format-agnostic manifest storage, ensuring the metadata layer can scale to tables with millions of files without hitting Java memory overhead limits.

![Pluggable File Format API architecture decoupling Iceberg core from format plugins](/assets/images/2026/apache-iceberg-1-11-0-deep-dive/)

---

## REST Client Protocols and Extended Headers (PR #12194)

The REST Catalog protocol has become the standard interface for managing Iceberg tables across multiple processing engines. It isolates clients from catalog catalog details and provides a unified API for schema management, snapshot commits, and credential vending.

However, as deployments scale inside large enterprises, catalogs need to process custom client context. For example, a platform team might want to track which business unit submitted a query, pass custom security tokens, or inject correlation IDs for distributed tracing. In previous versions, the standard `RESTClient` did not allow clients to send custom HTTP headers.

PR #12194, written by @gaborkaszab, solves this constraint by extending header support inside the `RESTClient` implementations. 

```
┌────────────────────────────────┐
│      Iceberg REST Client       │
│  (Spark, Flink, Trino, etc.)   │
└───────────────┬────────────────┘
                │
                │  POST /v1/namespaces/db/tables/events
                │  Custom-Headers:
                │    - X-Trace-Id: trace-98421
                │    - X-Tenant-Id: finance-billing
                │
                ▼
┌────────────────────────────────┐
│      REST Catalog Server       │
│  (Parses headers for auditing)  │
└────────────────────────────────┘
```

With this update, client engines can configure and inject custom headers into every REST call. This change enables the following capabilities:

*   **Auditing and Governance:** Engines can pass tenant identifiers or user profiles in the HTTP headers, allowing the REST catalog server to log catalog operations with full user context.
*   **Distributed Tracing:** Tracing headers such as W3C Trace Context can propagate from client engines through the catalog server, providing end-to-end trace visibility for query planning operations.
*   **Dynamic Authorization:** Clients can send custom authorization tokens that the REST catalog server evaluates dynamically to enforce fine-grained access control.

The properties are configured during catalog initialization using the standard configuration map, making it simple to roll out headers across existing query platforms.

![Extended header propagation between Iceberg client and REST Catalog server](/assets/images/2026/apache-iceberg-1-11-0-deep-dive/)

---

## Overwrite-Aware Table Registration (PR #15525)

In multi-tenant data platforms, multiple engines frequently access and modify the same table metadata. When registering a new table or importing an existing table state into the catalog, concurrency conflicts can occur.

If two separate processes attempt to register or overwrite a table reference at the same location simultaneously, a naive catalog might register the second request, silently overwriting the first. This creates data inconsistencies where the catalog points to an outdated or incorrect `metadata.json` file.

PR #15525, written by @sririshindra, adds overwrite-aware table registration to the catalog API. 

```
Writer 1: Commits events_v1 ────► [Catalog Table Pointer] ◄──── Writer 2: Commits events_v2
                                            │
                                            ├────────► If conflict: Catalog rejects Writer 2
                                            └────────► Prevents silent metadata overwrites
```

This change extends the catalog registration endpoint to accept metadata location checks. The registration request includes details about the expected base version. If the catalog detects that another engine has modified or registered the table in the background since the query was planned, it rejects the transaction with a conflict exception. This validation ensures that table registration is safe and prevents silent metadata overwrites in highly active environments.

![Flowchart of table registration verifying catalog overwrite state and rejecting transaction on conflicts](/assets/images/2026/apache-iceberg-1-11-0-deep-dive/)

---

## Deletion Vector Pruning in Snapshot Validation (PR #15653)

One of the major highlights of the V3 format specification is the stabilization of deletion vectors. Deletion vectors improve row-level delete performance by replacing positional delete files with Roaring bitmaps. Instead of writing a new delete file for every minor update, the engine updates a binary bitmap linked directly to the data file.

However, as tables grow to hold millions of data files, validating these deletion vectors during query planning can introduce latency. During scan planning, the query engine must ensure that the deletion vectors linked in the metadata are valid and match the corresponding data files.

In earlier versions, this validation was executed across the entire table snapshot during plan initialization. If you had a 50 TB table and queried a single day, the planner still spent time validating deletion vectors for the entire table.

PR #15653, introduced by @anoopj, optimizes this process. It adds manifest partition pruning to deletion vector validation inside the `MergingSnapshotProducer`.

```
Query Filter: WHERE event_date = '2026-05-23'
       │
       ▼
Partition Pruning Step
       │
       ├─► Skip Partition '2026-05-22' ──► Skip Deletion Vector Validation
       │
       └─► Read Partition '2026-05-23'  ──► Run Deletion Vector Validation
```

With this change, the query planner matches the query filter predicates against partition bounds before executing deletion vector checks. If a partition is pruned out, the engine skips validating the deletion vectors for the files in that partition. This change reduces planning CPU cycles and improves scan startup times for partitioned tables.

![Diagram showing deletion vector validation pruning skipping skipped partitions during planning](/assets/images/2026/apache-iceberg-1-11-0-deep-dive/)

---

## Scheduled Credential Lifecycle Refresh (PR #15678, #15732, #15696)

To security-harden data lakehouses, platforms avoid using long-lived storage credentials. Instead, query engines authenticate using temporary tokens vended by the REST catalog or cloud identity providers. These credentials typically have short lifespans, often expiring after one hour.

This security model creates issues for long-running operations. If a massive query runs for 90 minutes, or a streaming Flink sink runs continuously, the temporary credentials expire mid-job. When the client attempts to write new files or fetch manifests after the expiration window, the storage client throws an authentication exception, failing the job.

The 1.11.0 release resolves this lifecycle problem. PR #15678 (by @danielcweeks) and PR #15732 (by @nastra) add scheduled refresh threads to the `S3FileIO` client. A parallel change in PR #15696 (by @nastra) implements the same capability for `GCSFileIO`.

```
Query Thread (Reads/Writes Data)
       │
       ├───────► Token Expiration Approaching (e.g. at 50 minutes)
       │
Background Refresh Thread
       │
       ├───────► Send Request to Catalog ──► Fetch New Credentials
       │
       └───────► Update S3FileIO/GCSFileIO Credentials In-Memory
       │
Query Thread (Continues without interruption)
```

Both file systems now run a background daemon thread that tracks token expiration times. Before the active credential expires, the background thread automatically polls the catalog for refreshed tokens and updates the file system client in-memory. The main query and write threads continue to run without interruption, eliminating query failures caused by expired credentials.

![Sequence flow showing background thread updating AWS/GCS storage client credentials before expiration](/assets/images/2026/apache-iceberg-1-11-0-deep-dive/)

---

## Spark Streaming Triggers and Z-Ordering (PR #13824, #15706)

Apache Spark remains the primary engine for heavy write workloads and batch compaction in Iceberg tables. Version 1.11.0 includes several updates to improve Spark streaming and layout optimization.

### Trigger.AvailableNow Support (PR #13824, #14026)
PR #13824, introduced by @alexprosak, adds support for the `AvailableNow` trigger in Spark Structured Streaming. This change was also backported to Spark 4.0, 3.5, and 3.4 in PR #14026.

```
Continuous Trigger:
[Read Batch 1] -> [Write] -> [Wait] -> [Read Batch 2] -> [Write] -> (Runs indefinitely)

AvailableNow Trigger:
[Scan All Available Data] -> [Process Batch 1] -> [Process Batch 2] -> [Write All] -> [Graceful Shutdown]
```

In Spark streaming, the default trigger runs continuously in the background, consuming resources even when no new files are arriving. The alternative `Once` trigger processes only a single batch and shuts down, which can leave data unprocessed if a large backlog has accumulated.

The `AvailableNow` trigger combines the benefits of both approaches. It scans the source for all available data, splits the workload into consecutive micro-batches, processes them all in a single run, and then shuts down the streaming context. This is useful for cost-optimized, hourly batch pipelines running on top of Iceberg tables.

### Z-Order Column Collision Validation (PR #15706)
PR #15706, introduced by @YanivZalach, addresses a failure mode during Z-order layout optimization. Spark uses the internal column name `ICEZVALUE` during Z-order sorting. If a user table already contained a column named `ICEZVALUE`, the compaction process failed or generated incorrect sort orders. 

The update adds strict schema validation that checks for column name collisions before running Z-order compactions, preventing data corruption.

![Comparison of continuous micro-batch streaming vs Spark AvailableNow trigger batches](/assets/images/2026/apache-iceberg-1-11-0-deep-dive/)

---

## Flink Post-Commit Maintenance and Branch Compaction (PR #15566, #15672, #14148)

Apache Flink is the standard engine for real-time streaming ingestion into Iceberg tables. Streaming ingestion has different write characteristics than batch ingestion, often writing many small files at high frequency. Iceberg 1.11.0 adds features to manage these files directly within Flink pipelines.

### Flink Post-Commit Maintenance (PR #15566, #15667)
PR #15566, written by @mxm, adds support for arbitrary post-commit maintenance tasks inside the Flink `IcebergSink` builder. This is also backported to active Flink branches in PR #15667.

During streaming ingestion, Flink commits data to the Iceberg table at every checkpoint. These frequent commits generate a large number of small manifest files. With the new post-commit interface, you can attach background maintenance tasks directly to the sink. 

After a commit succeeds, Flink runs compaction and manifest cleaning tasks in the background, keeping the table structure optimized without requiring external scheduler jobs.

```
Flink Stream Ingestion
       │
       ▼
[Commit Data File (Checkpoint)]
       │
       ├───────► Post-Commit Trigger
       │
       ▼
[Background Maintenance Action (RewriteDataFiles / Compaction)]
```

### Flink Branch Compaction Support (PR #15672, #15690)
PR #15672, also written by @mxm, adds branch support to the Flink `RewriteDataFiles` action. 

Historically, Flink's background compaction actions could only run on the table's main branch. In modern architectures, engines often ingest experimental data or staging runs into separate table branches. Flink can now run file compaction directly on these non-main branches, keeping staging and experiment branches organized before they are merged back.

### Flink Metadata Columns (PR #14148)
PR #14148, introduced by @Guosmilesmile, exposes metadata columns to Flink readers. 

Flink applications can now read the `_row_id` and `_last_updated_sequence_number` system columns. This is useful for CDC (Change Data Capture) reconciliation pipelines that need to track the exact ingestion sequence of rows.

![Flink data sink writing data and executing post-commit branch compaction on experimental branch](/assets/images/2026/apache-iceberg-1-11-0-deep-dive/)

---

## JSON to Variant Mapping and Spec Cleanups (PR #13137, #14045)

The Variant type is a key part of the Iceberg V3 specification, designed to store semi-structured data using a binary representation that supports predicate pushdown. Iceberg 1.11.0 refines this integration across multiple engines.

### Variant Type Validation (PR #13137, #14081)
PR #13137 (by @manirajv06) and PR #14081 (by @geruh) add schema validation and filtering rules for the Variant type in Parquet metrics. 

These updates ensure that Parquet file readers can extract column-level statistics from nested variant structures. This allows the query engine to prune files based on nested variant fields, improving query performance.

### Trino Variant Type Mapping
In parallel, query engine connectors are adopting these changes. Trino now maps its native `JSON` type to Iceberg's Variant type in V3 tables. This means you can write JSON data from Trino and query it with predicate pushdown, avoiding the performance penalties of plain string JSON.

### Positional Deletes with Row Data Deprecated (PR #14045)
PR #14045, written by @pvary, deprecates positional delete files that embed row data. 

In Iceberg V2, positional delete files could store the actual deleted row data alongside the file path and row offset. While this design saved a join step during reads, it duplicated data in the delete files, increasing storage costs and metadata complexity. 

The community has deprecated this option in favor of Deletion Vectors, simplifying the V3 read path.

---

## Table Upgrade Path and Connector Compatibility

All V3 features: manifest list encryption, deletion vectors, Variant types, geospatial types, and nanosecond timestamps: require upgrading your tables to format version 3.

```
Existing V2 Table
       │
       ├───────► Run: ALTER TABLE events SET TBLPROPERTIES ('format-version' = '3')
       │
Upgraded V3 Table
       │
       ├───────► New writes use Deletion Vectors and Variant type
       └───────► Existing data files are left untouched (no rewrite required)
```

The upgrade is a metadata-only operation executed using SQL:

```sql
-- Upgrade an existing table to Iceberg V3 format version
ALTER TABLE my_catalog.schema.events
SET TBLPROPERTIES ('format-version' = '3');
```

This operation updates the `format-version` pointer in the table's metadata JSON. It does not rewrite your existing data files, which remain in place and continue to be readable. 

New writes to the table will adopt V3 features automatically. For example, subsequent update or delete statements will write deletion vectors instead of positional delete files.

### Lifecycle Status Updates
Before planning your migration to V3, review the engine compatibility changes in Iceberg 1.11.0:

*   **Java 11 Support Dropped:** Iceberg 1.11.0 drops support for Java 11. Core libraries and engine connectors now require **Java 17** or **Java 21**.
*   **Spark 3.4 Support Deprecated:** Support for Spark 3.4 is deprecated. Teams should migrate to Spark 3.5 or Spark 4.0+.
*   **Flink 1.19 Support Removed:** Flink 1.19 is no longer supported. The release adds support for **Flink 2.1.0**.

Make sure all query engines and toolchains in your lakehouse deployment support Iceberg V3 and Java 17 before upgrading production tables.

![Table upgrade timeline showing migration SQL and deprecated connector support list](/assets/images/2026/apache-iceberg-1-11-0-deep-dive/)

---

## Conclusion

Apache Iceberg 1.11.0 is a significant release for the project. It moves beyond incremental enhancements to deliver major architectural updates. 

The unified File Format API restructures how Iceberg interacts with physical storage formats. This change makes it easier to integrate next-generation codecs designed for AI and high-performance workloads. 

At the same time, the stabilization of V3 features provides a production-ready path for deletion vectors, Variant data, geospatial types, and nanosecond precision. These features help organizations optimize query performance and reduce operational overhead.

If you are running Iceberg V2 tables in production, evaluate your workloads to identify tables that will benefit from a V3 upgrade. In particular, tables with active update patterns or large JSON columns will see immediate performance gains.

---

### Build Your Data Lakehouse Expertise

If you are designing, building, or managing modern data platforms, staying ahead of formatting specifications is critical. To deepen your understanding of these technologies, consider reading:

*   **"Architecting an Apache Iceberg Lakehouse"**: An architectural guide to designing open lakehouse platforms, managing catalog architectures, and optimizing table layouts.
*   **Other Data Lakehouse Publications**: Practical books covering hidden partitioning, schema evolution, and query acceleration engines.

Find these books and other lakehouse learning resources at [books.alexmerced.com](https://books.alexmerced.com).

To query your Iceberg V3 tables with automatic file layout optimization, background compaction, and zero infrastructure management, start a free trial of Dremio Cloud at [dremio.com/get-started](https://www.dremio.com/get-started).
