---
title: "Should Iceberg v4 Stop Writing ORC and Avro Data Files? The Feature-Gap Case and the Read Path That Stays"
description: "Iceberg v4 may stop writing ORC and Avro data files while keeping existing files readable, plus how to audit an estate and plan a migration."
date: 2026-11-09T09:00:00Z
tags: ["Apache Iceberg", "iceberg-v4", "parquet", "orc"]
canonical: https://datalakehousehub.com/blog/iceberg-v4-orc-avro-data-files/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/iceberg-v4-orc-avro-data-files/).

It is an open question, and it only concerns new files. On November 2, 2026, Kevin Liu asked the Apache Iceberg dev list whether v4 should stop writing ORC and Avro data files while keeping existing files readable. His reasons: neither format supports variant shredding, and the draft vector type has no ORC mapping. Nothing has gone to a vote yet.

If you run Iceberg on Parquet, this thread looks like housekeeping. If you migrated a Hive warehouse into Iceberg a few years ago, it is personal. Hive's ACID tables defaulted to ORC, and many Iceberg migrations registered those ORC files in place rather than rewriting petabytes. Some streaming pipelines wrote Avro data files because their upstream data was already Avro. Those tables work today. The question is what happens to them as v4 features arrive that only Parquet can carry.

This article lays out where ORC and Avro data files still show up, the specific feature gaps behind the proposal, what "write-never, read-forever" changes and leaves alone, and a practical way to audit and migrate an estate without waiting for a decision.

## How We Got Here: Manifests First, Data Files Second

The data file question follows an earlier decision about metadata.

Since its first versions, Iceberg has stored manifests in Apache Avro, a row-oriented format. Every manifest entry carries per-column statistics, and wide tables carry hundreds of them. Avro makes a reader deserialize each entire record even when it only needs a few fields. v4 moves metadata to Parquet so planners can project only the columns they need.

In August 2026, the dev list settled the metadata side quickly. Steven Wu argued that Avro manifests cannot support projection reads, which defeats the purpose of the change. Anoop Johnson noted that Iceberg does not track the format of the root manifest today, so supporting Avro roots requires new tracking that buys nothing. Russell Spitzer described Parquet-only manifests as a step toward converging on a single file format, and Manu Zhang agreed while recalling a separate discussion about deprecating ORC. Upgraded tables keep their v3 Avro leaf manifests. The restriction covers newly written v4 metadata.

In mid-October, Kevin Liu asked whether v4 should go Parquet-only for data files as well. That first pass drew real pushback. Péter Váry and Junwang Zhao objected to narrowing the spec, and Junwang named Vortex, Lance and Nimble as newer formats worth keeping the door open for. Kevin agreed to move the topic to its own thread. The November 2 thread is that follow-up, with a narrower framing: stop writing ORC and Avro data files in v4, keep reading them.

## Where ORC and Avro Data Files Still Show Up

Before weighing the proposal, it helps to know who it affects. ORC and Avro data files appear in Iceberg tables through a few predictable paths.

**Hive migrations.** Iceberg's `migrate` and `add_files` procedures register existing files in place. A Hive table stored as ORC becomes an Iceberg table whose data files are ORC. Unless someone later set the table's write format to Parquet and compacted, every file in that table is still ORC, and new writes keep producing ORC.

**Engines and teams that chose ORC on purpose.** Some organizations standardized on ORC years ago for its compression and built-in indexes. Their Iceberg tables set `write.format.default` to `orc` and write ORC for every new file.

**Avro-native streaming.** Pipelines that read Avro records from Kafka sometimes wrote Avro data files directly, especially for row-oriented landing tables. Avro data files are cheap to append and expensive to scan, so they tend to appear in raw zones rather than in modeled, query-facing tables.

**Delete files.** Position delete files in v2 tables can be written in any supported format, and some engines wrote them in Avro or ORC to match the table. v3 deletion vectors live in Puffin files instead, but v2 tables on ORC still carry ORC delete files.

Most modern Iceberg tables never touch these paths. The tables that do are often among the largest and oldest in an estate, which is exactly why the read path matters more than the write path.

## The Feature-Gap List

Kevin's case rests on features that v3 and v4 add for Parquet and that ORC and Avro do not support. The argument points to Iceberg's own format test kit, which already lists features those formats lack. Three gaps matter most.

### Variant shredding

Iceberg v3 added the `variant` type for semi-structured data such as JSON. A variant value can be stored as an opaque binary blob, which works in any format but cannot be pruned or projected. Shredding splits frequently used fields out of the variant into their own typed columns inside the data file. A query on `payload.region` then reads one narrow column and uses its statistics, instead of decoding every blob.

Shredding depends on the Parquet variant encoding, which defines how shredded fields sit next to the residual binary value. ORC and Avro have no equivalent layout in Iceberg today. A variant column in an ORC file is a blob. The feature that makes variant fast is Parquet-only in practice.

### The vector type

The v4 draft adds a vector type for embeddings, so tables can hold fixed-length arrays of floats with type-level meaning for similarity search. The proposal notes that the draft vector type has no ORC mapping. Parquet is getting a matching vector type of its own, which gives Iceberg a native encoding to map onto. ORC does not have that path.

For teams planning to store embeddings next to their tables, this is the gap that matters most. A v4 table that writes ORC cannot hold vectors natively.

### Statistics and indexing

v4 is reworking statistics into typed `content_stats`, adding stats-only fields for derived values and a file-level `tight_stats` flag for exact stats. Those live in metadata, so they apply regardless of data file format in principle. In practice, the writers that compute rich stats, shred variants and produce page-level indexes are the Parquet writers. Parquet also has page indexes and a long-running effort to rework its footer for faster metadata access. ORC has its own indexes and bloom filters, but the Iceberg community's investment is concentrated on Parquet.

There is also a broader implementation argument. Earlier in October, Kevin pointed to thin support for ORC and Avro outside the Java implementation. Iceberg now has first-party libraries in Python, Rust, Go and C++. Each format each library supports is work, and ORC writers in particular are scarce outside Java. A Rust-based Flink acceleration project noted this month that ORC write support in Rust is weak even though the reader is solid.

## Read-Forever Versus Write-Never

The proposal's framing matters. It is not "remove ORC and Avro." It is "v4 writers stop producing them, and v4 readers keep reading them."

### What changes under the proposal

- A v4 table writes new data files only in Parquet, or in whatever formats the v4 spec allows, if newer formats such as Vortex or Lance enter later.
- Setting `write.format.default` to `orc` or `avro` on a v4 table becomes invalid.
- Engines implementing v4 writes need Parquet writers only for data, which shrinks the work for non-Java libraries.

### What stays the same

- Existing ORC and Avro data files stay readable. A v3 table upgraded to v4 keeps every file it had. Readers continue to support those formats.
- v3 tables keep their current behavior. Nothing forces a format change on a table that stays at v3.
- Delete semantics are unaffected. Deletion vectors already moved to Puffin in v3.

### What the opponents care about

The October pushback raised two concerns worth taking seriously.

The first is principle. Iceberg has always been format-neutral, and that neutrality is part of its value. Narrowing the spec to one format sets a precedent that makes it harder to add new formats later. Junwang's list of Vortex, Lance and Nimble is a reminder that file formats keep evolving, and several are designed for workloads, such as random access for machine learning, where Parquet is not the strongest choice.

The second is practical. Organizations with large ORC estates face rewrite costs if they want v4 features. A spec that blocks ORC writes in v4 pushes those organizations to choose between staying on v3 and paying to rewrite.

The November framing addresses part of the second concern by keeping reads. It does not address the first, and that is where the vote, if one comes, will turn. A likely middle path, and one the October discussion hinted at, is to keep the spec format-neutral in principle while requiring Parquet for specific v4 features, such as variant shredding and vectors. That gives ORC tables a defined subset rather than a ban.

## Auditing Your Estate for Non-Parquet Data Files

Whatever the vote decides, you should know how much ORC and Avro you hold. Iceberg's metadata tables answer that without reading any data. These queries use Spark SQL syntax. Trino and other engines expose the same metadata tables with slightly different naming.

```sql
-- 1. File formats in the current snapshot of one table
SELECT file_format,
       COUNT(*)                         AS files,
       SUM(record_count)                AS records,
       ROUND(SUM(file_size_in_bytes) / 1e12, 3) AS terabytes
FROM prod.sales.orders.files
GROUP BY file_format;

-- 2. Same question across every snapshot still referenced
--    (files that expire_snapshots has not removed yet)
SELECT file_format, COUNT(*) AS files
FROM prod.sales.orders.all_data_files
GROUP BY file_format;

-- 3. Which partitions still hold ORC, so you can migrate in slices
SELECT partition, COUNT(*) AS orc_files,
       SUM(file_size_in_bytes) AS orc_bytes
FROM prod.sales.orders.files
WHERE file_format = 'ORC'
GROUP BY partition
ORDER BY orc_bytes DESC
LIMIT 50;

-- 4. What format does the table write by default today?
SHOW TBLPROPERTIES prod.sales.orders ('write.format.default');
```

Each query answers a different question.

The first query reads the `files` metadata table, which lists the data and delete files in the current snapshot along with their format, record count and size. Grouping by `file_format` gives you the mix in one line per format. If the table only shows `PARQUET`, it is already v4-ready on this axis.

The second query uses `all_data_files`, which covers files reachable from any snapshot still in the table's history. If the current snapshot is all Parquet but `all_data_files` shows ORC, the ORC files are only referenced by old snapshots. Expiring those snapshots removes them, with no rewrite needed.

The third query finds where ORC lives by partition. Large tables rarely migrate in one job. Ordering partitions by ORC bytes gives you a migration queue, biggest first or smallest first depending on whether you want quick progress or quick wins.

The fourth query checks the write default. A table whose files are mostly Parquet but whose `write.format.default` is still `orc` will keep producing ORC with every write. Fix the property before you compact, or compaction output will be ORC too.

To run the audit across a whole catalog, loop over tables with your engine's catalog listing or with PyIceberg, run query one per table and collect results into a single report. Sort by ORC and Avro bytes. That list is your migration backlog, and its size tells you how much the v4 decision will cost you. Keep the report in version control and rerun it monthly, so you can see whether the non-Parquet share is shrinking or quietly growing.

### Running the audit across a whole catalog

One table at a time does not scale to a few thousand tables. PyIceberg, the Python library for Iceberg, exposes the same metadata through `table.inspect`, which makes a catalog-wide report a short script:

```python
from collections import Counter
from pyiceberg.catalog import load_catalog

catalog = load_catalog("prod")  # reads connection settings from .pyiceberg.yaml

report = []
for namespace in catalog.list_namespaces():
    for identifier in catalog.list_tables(namespace):
        table = catalog.load_table(identifier)
        files = table.inspect.files().to_pylist()
        bytes_by_format = Counter()
        for f in files:
            bytes_by_format[f["file_format"]] += f["file_size_in_bytes"]
        non_parquet = sum(v for k, v in bytes_by_format.items() if k != "PARQUET")
        write_default = table.properties.get("write.format.default", "parquet")
        report.append((".".join(identifier), non_parquet, write_default, dict(bytes_by_format)))

for name, non_parquet, default, mix in sorted(report, key=lambda r: -r[1]):
    if non_parquet:
        print(f"{name}: {non_parquet / 1e9:.1f} GB non-Parquet, writes {default}, mix {mix}")
```

The script loads the catalog named `prod` from PyIceberg's configuration file, walks every namespace and table, and reads each table's current `files` metadata as a list of rows. It sums bytes by `file_format`, records the table's write default and prints only tables holding non-Parquet data, largest first. Tables whose write default is not Parquet deserve attention even when they hold little ORC today, because they keep adding more.

Reading the files metadata loads manifests, not data. On very large tables, that still means reading many manifest files, so run the script outside peak hours and expect it to take a while on a big catalog.

## A Rewrite Plan That Does Not Wait for v4

You do not need to wait for a vote to start. Moving a table's data files to Parquet is supported in v2 and v3 today, and it helps on its own merits: better vectorized reads in most engines, page indexes and access to variant shredding once you upgrade.

### Step one: change the write default

```sql
ALTER TABLE prod.sales.orders
SET TBLPROPERTIES ('write.format.default' = 'parquet');
```

From this moment, new appends write Parquet. The table now holds a mix of formats, which Iceberg supports. Readers handle each file according to its own format, recorded in the manifest entry.

### Step two: rewrite in slices

Iceberg's Spark procedures rewrite data files with the table's current write settings. The `rewrite_data_files` procedure accepts a filter and options, so you can migrate one partition range at a time:

```sql
CALL prod.system.rewrite_data_files(
  table   => 'sales.orders',
  where   => 'order_date >= ''2024-01-01'' AND order_date < ''2024-04-01''',
  options => map(
    'rewrite-all', 'true',
    'target-file-size-bytes', '536870912',
    'partial-progress.enabled', 'true',
    'partial-progress.max-commits', '10'
  )
);
```

The `where` argument limits the rewrite to one quarter of data. The `rewrite-all` option forces every file in range to be rewritten, even files that are already well sized, because the goal here is changing format rather than fixing file sizes. The target file size sets output files to 512 MB. Partial progress lets the job commit in several groups, so a failure halfway through keeps the work already done and a concurrent writer is less likely to conflict with one giant commit.

Run quarter by quarter, or partition by partition from the audit queue, during low-traffic windows.

### Step three: clean up

After the rewrite, old ORC files are still referenced by earlier snapshots. Expire those snapshots when your retention policy allows, then remove orphan files:

```sql
CALL prod.system.expire_snapshots(
  table       => 'sales.orders',
  older_than  => TIMESTAMP '2026-11-01 00:00:00',
  retain_last => 5
);
```

Once old snapshots expire, rerun the `all_data_files` audit. When it shows only Parquet, the table is fully migrated.

### Step four: check delete files

For v2 tables with position or equality delete files, check the `delete_files` metadata table for non-Parquet formats as well. Set `write.delete.format.default` to `parquet`, then compact deletes. Upgrading the table to v3 and moving to deletion vectors removes the question entirely for new deletes.

### Costs to plan for

A format rewrite reads and writes every byte in scope. For a petabyte-scale ORC table, that is a real compute bill and real time. Three things reduce it. Migrate cold partitions only if anyone still queries them, and otherwise leave them as ORC and let readers handle them. Run rewrites on spot or preemptible capacity, since partial progress makes them restartable. And combine the format change with work you needed anyway, such as re-sorting or clustering, so you only rewrite once.

## How Readers Handle Mixed-Format Tables Today

Iceberg has always allowed one table to hold files in different formats. Each manifest entry records the file's format, and readers open each file with the matching reader. That design is why read-forever is cheap for the spec: nothing about it is new.

Mixed tables work, but they have costs worth knowing.

**Two code paths per scan.** An engine reading a table with both ORC and Parquet files runs two readers. Vectorized execution, filter pushdown and statistics use differ between them. Query performance on a mixed table often tracks the slower format, because the scan finishes when the last split finishes.

**Uneven feature support.** A v3 table with a variant column can shred variants in its Parquet files and store blobs in its ORC files. Queries on shredded fields prune the Parquet files and read every ORC file in full. The result is correct, but the cost is lopsided.

**Engine coverage differs.** Java engines read all three formats. Non-Java readers vary. If a Python or Rust tool needs to read the table, check that it supports every format the table holds before you rely on it. This is part of Kevin's argument: each format multiplies the work every library has to do.

## Rewrite Now, Later or Never: A Decision Guide

Not every ORC table needs a rewrite. Here is how I sort an audit backlog.

**Rewrite now** when the table is queried often, when you plan to use variant shredding or vectors, when non-Java tools need to read it, or when the table already needs a sort or clustering change. The rewrite pays for itself in faster reads and fewer reader gaps.

**Rewrite later** when the table is large and stable, queried mainly by Java engines with mature ORC readers, and has no v4 feature on its roadmap. Change the write default to Parquet now so new data lands in Parquet, and let compaction convert recent partitions as part of normal maintenance. The ORC share shrinks on its own.

**Never rewrite** cold archives that are rarely queried and slated for deletion under a retention policy. The read path stays, so they keep working. Spending compute to convert data nobody reads is the worst trade in the backlog.

Whatever bucket a table lands in, record the decision and the reason next to the table. When v4 lands in your engines, that note turns into your upgrade plan.

## Failure Modes in a Format Migration

A few things go wrong often enough to plan for.

**The write default stays on ORC.** Someone compacts before changing `write.format.default`, and compaction produces fresh ORC files. The audit looks unchanged and the compute is spent. Always change the property first and confirm it with `SHOW TBLPROPERTIES`.

**Type mapping differences surface.** ORC and Parquet map some types differently, including timestamps with and without time zones, decimals with unusual precision and certain nested types. Iceberg's schema governs the logical type, so a rewrite should preserve values, but engine bugs exist. Validate a sample after each slice by comparing row counts and checksums of key columns between the old and new snapshots using time travel.

**Concurrent writers conflict.** A long rewrite on a busy table can fail its commit when a streaming writer commits in between. Partial progress and smaller slices reduce the window. For tables with constant writes, schedule rewrites during the writer's maintenance window or pause it briefly.

**Readers lack Parquet features.** Rarely, an old engine reading the table was tuned for ORC and has a weaker Parquet reader. Check every engine that reads the table before the migration, not after.

## What ORC and Avro Still Do Well

A fair reading of the thread has to credit what these formats bring, because the people pushing back are not defending nostalgia.

ORC is a mature columnar format with strong compression, built-in lightweight indexes at the stripe and row-group level, and bloom filters. For many years it outperformed Parquet in Hive-based stacks, and its Java reader remains fast. Teams that tuned large ORC estates did so for good reasons, and those tables often still perform well for the queries they were built for.

Avro is the opposite design. It is row-oriented, compact for whole-record reads and cheap to append. It shines as a wire format and a landing format, where records arrive one at a time and get read back whole. Its schema evolution rules are well understood, and much of the streaming world speaks Avro natively. Iceberg itself used Avro for manifests for years because it fit the access pattern of that era.

Neither strength disappears under the proposal. Read-forever keeps existing ORC tables working, and Avro remains a fine format upstream of Iceberg, in Kafka topics and schema registries. What changes is where new investment goes. The v4 features that move the format forward, from shredded variants to vectors to richer statistics, are being designed around Parquet's layout, and the proposal asks whether the spec should say so plainly.

## Questions Worth Raising on the Dev List

If your organization runs a large ORC or Avro estate, the thread is the place to make that visible. Concrete data helps the community more than general objections. Useful contributions include the share of your data in each format from the audit above, which v4 features you need and on what timeline, which engines read your tables and how well each handles mixed formats, and whether a rule tying specific features to Parquet, rather than a blanket write ban, covers your needs.

The Apache process rewards this kind of input. Decisions on the dev list are made by the people who show up with evidence. A short email with real numbers from a production estate carries weight in a design discussion.

## What to Watch Next

Three outcomes are possible from the thread. The first is agreement on write-never for ORC and Avro in v4, with a vote to follow. The second is a narrower rule tying specific features such as variant shredding and vectors to Parquet while leaving general writes open. The third leaves the spec format-neutral and lets implementations decide what to support.

Any of these leaves the read path intact, which is the part that protects existing tables. The difference is how much pressure each puts on ORC-heavy teams to rewrite before adopting v4 features.

Watch the dev list for a `[VOTE]` thread, and watch how the vector type and variant shredding sections of the v4 spec describe format requirements. Those sections will settle the practical question even if the general one stays open.

Also watch the engines. A spec decision only matters once writers implement v4. Spark, Flink, Trino and the non-Java libraries will each ship v4 write support on their own schedules, and each release note will say which data formats v4 writes support. If the major writers ship v4 with Parquet-only data writes, the question is answered in practice regardless of what the spec permits. Track the release notes for every engine that writes your tables, and update your migration backlog when the first of them ships v4 writes.

## Conclusion

The proposal is narrower than its headline. Kevin Liu's November 2 thread asks whether v4 should stop writing ORC and Avro data files, not whether Iceberg should stop reading them. The reasons are concrete: variant shredding and the draft vector type have no ORC path, and maintaining three data formats across Java, Python, Rust, Go and C++ libraries is expensive. The objections are also concrete: format neutrality is part of Iceberg's identity, and new formats keep appearing.

You do not need to wait for the outcome. Audit your tables with the `files` and `all_data_files` metadata tables, change write defaults where you can, and rewrite in slices when a table needs v4 features or simply better reads. If your estate turns out to be all Parquet, the thread is a curiosity. If it turns out to be half ORC, you now know your migration backlog before the decision arrives.

## Keep Going

If this piece was useful, I have written a lot more on Iceberg table maintenance and migration. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers metadata tables, compaction, snapshot expiration and migrating existing Hive tables, which are the tools behind every step above. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
