---
title: "Iceberg Secondary Indexes Take Shape: REST Routes Under Tables and a Compaction-Aware Puffin Lifecycle"
description: "Iceberg secondary indexes as table sub-resources: REST routes, snapshot pinning, read restrictions, compaction invalidation and Puffin blob lifecycle."
date: 2026-11-16T09:00:00Z
tags: ["Apache Iceberg", "Catalog", "REST API", "Indexing", "Puffin"]
canonical: https://iceberglakehouse.com/posts/iceberg-secondary-indexes-rest-puffin-lifecycle/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/iceberg-secondary-indexes-rest-puffin-lifecycle/).

Apache Iceberg is adding secondary indexes as catalog objects that belong to a table. The working REST design nests them under /v1/{prefix}/namespaces/{namespace}/tables/{table}/indexes, keeps index names unique per table, and drops cross-namespace indexes. A separate proposal covers pluggable Puffin blob types and keeping data-file-scoped indexes valid through compaction.

Two efforts moved on the Iceberg dev list in the week of November 9, 2026. The dedicated index sync agreed on how indexes appear in the REST catalog API ([sync summary, November 10](https://lists.apache.org/thread/mqpz7pfhztx79r5ok0m7j4r7l3yovktq)), and Péter Váry updated the index spec draft in [PR #16961](https://github.com/apache/iceberg/pull/16961) the next day. In parallel, Alex Cruise's proposal for pluggable Puffin blob types and a compaction-aware lifecycle drew requests for a shorter summary from Zheng Hu on November 11 ([thread](https://lists.apache.org/thread/p1mz4xmkjj3mmzwkpq5lhnnl2xkybd8s)).

This article covers indexes as objects in their own right: how they are addressed, named, scoped, and kept correct as tables change. It does not repeat how Puffin statistics files work. For that, see [Inside the Puffin File Format](https://iceberglakehouse.com/posts/inside-the-puffin-file-format/), which covers theta sketches and Bloom filters. Everything here describes drafts under active review, so field names and routes can still change.

## What Iceberg uses for skipping today

Iceberg already avoids reading most data for most queries. It does this with layers of metadata, each coarser than the next.

**Partition pruning.** Manifests record each data file's partition values. A filter on a partition column skips whole partitions without opening a file.

**Column statistics in manifests.** Each data file's manifest entry carries lower and upper bounds, null counts, and value counts per column. A filter on `order_id = 12345` skips any file whose bounds exclude that value.

**Parquet row group and page statistics.** Inside a file, Parquet stores min and max values per row group and, with page indexes, per page. Readers skip row groups and pages that cannot match. The mechanics are covered in [Parquet Page Indexes and the Last Mile of Pruning in Apache Iceberg](https://iceberglakehouse.com/posts/parquet-page-index-pruning-iceberg/).

**Bloom filters.** Parquet Bloom filters, and Puffin blobs at the table level, answer "is this value definitely not here" for high-cardinality columns where min and max bounds are useless. See [Iceberg Bloom Filters](https://iceberglakehouse.com/iceberg/iceberg-bloom-filters/).

All of these work best when the data's physical layout matches the filter. If a table is sorted by `order_date`, bounds on `order_date` are tight and pruning works well. A lookup on `customer_id` in the same table finds wide bounds in every file, so every file looks like a possible match.

That is the gap a secondary index fills. It organizes pointers to rows by a key that is not the table's physical layout. A lookup on that key goes to the index first, gets a short list of files and positions, and reads only those.

## Two kinds of index, two kinds of risk

Alex Cruise's November 2 post introducing his proposal draws a distinction that explains most of the design choices in both efforts.

**Negative indexes** say where a value is definitely not. Bloom filters and min and max statistics are negative. If a negative index is out of date, the cost is efficiency. The reader scans a file that turns out to hold no matching rows. The answer is still correct.

**Positive indexes** say where a value is. A key index that maps `customer_id` values to file paths and row positions is positive. If a positive index is out of date, the cost is correctness. A reader that trusts it skips files the index does not list, and if new matching rows landed in an unlisted file, the query misses them.

Cruise's proposal focuses mainly on filters, the negative kind. The index spec in PR #16961 defines key indexes, the positive kind, and it treats correctness accordingly. That is why the spec ties every index snapshot to an exact table snapshot. His proposal includes a section comparing the two approaches, and he describes them as complementary despite overlapping scope.

Keep the distinction in mind for the rest of this article. Every rule about freshness, compaction, and authorization comes from the difference between "stale means slow" and "stale means wrong."

## The index object

The index spec draft defines an index as its own metadata object, separate from the table metadata but bound to one table.

### Scope and naming

The sync on October 27, recapped in the November thread, settled two scoping rules. An index must live in the same namespace as its table, so cross-namespace indexes are out. Rename and register operations are left out of the first version.

The November 9 sync, summarized by Huaxin Gao on November 10, added more:

- Index names are unique per table. An index's full identifier is the table identifier plus the index name.
- Indexes are sub-resources of their table. Renaming a table moves its indexes with it. Dropping a table drops its indexes. How a catalog removes them is up to the implementation.
- Multi-table indexes are out of scope.

That last rule matters. A multi-table index, such as one that covers a join, does not fit under a single table's path. Péter had raised this as the main drawback of nesting on November 4, and judged it unlikely to matter. The group agreed.

### Key fields

The review of PR #16961 shows the main fields in the draft. Indexes identify their key columns with `key-column-ids`, which holds field IDs only. A reader looks up names and types in the base table's schema, the same way Iceberg handles partition fields. This keeps indexes valid across column renames.

Each index snapshot carries a `source-table-snapshot-id` that pins it to one table snapshot. The draft's core rule is that "an index snapshot must index exactly the live rows of the referenced table snapshot." That one sentence is how a positive index stays correct. A reader knows exactly which table state the index describes.

The draft's type table reserves `VECTOR` for future specification. A reviewer suggested also reserving `TERM` for text and token predicates. The first version targets key indexes. The sync also removed derived columns, such as precomputed Hilbert curve values, from the index spec. Derived columns move forward as a separate effort, and the index spec picks them up later through the shared schema.

### File layout

Index data in the draft is organized into tracking files, range files, and region files. Leaf entries carry a transform value, a file path, and a row position. So a lookup walks from the tracking file to the range covering the key, then to the region holding the entries, and ends with a list of exact rows to read.

Reviewers raised open questions about this layout. One asked for a tracking file example with content statistics. Another proposed adding the Parquet page offset and compressed page size to leaf entries, so a lookup skips reading Parquet's offset index for each hit. Another proposal allows overlap between sorted runs, each tagged with a run ID, to reduce maintenance cost. All of these are under discussion.

## The REST routes

The REST catalog side lives in a separate pull request, #16963, which Huaxin is updating based on the November 9 sync. The agreed shape nests indexes under their table:

```text
GET    /v1/{prefix}/namespaces/{namespace}/tables/{table}/indexes
POST   /v1/{prefix}/namespaces/{namespace}/tables/{table}/indexes
GET    /v1/{prefix}/namespaces/{namespace}/tables/{table}/indexes/{index}
DELETE /v1/{prefix}/namespaces/{namespace}/tables/{table}/indexes/{index}
```

The first route lists a table's indexes, and the second creates one. The third loads a single index's metadata, and the fourth drops it. These lines show the resource paths agreed in the sync. The exact verbs and request bodies come from PR #16963 as it evolves, so check the merged OpenAPI file before building a client. An optional endpoint will list all indexes in a namespace, returning each index name and its table, for maintenance tools that sweep a whole namespace. Catalogs are not required to implement it.

Nesting reflects how indexes are used. A query engine loads a table, then wants that table's indexes. A path under the table makes that a single, predictable request. It also makes lifecycle rules obvious: anything under a table's path goes away when the table does.

For context on the rest of the REST API, see the [Iceberg REST Catalog API quick reference](https://iceberglakehouse.com/iceberg/iceberg-rest-catalog-api/).

### The open question: loadTable

One question stayed open after the sync. Should loading a table return its indexes?

Returning indexes with the table saves a round trip when an engine loads a table to read it. But most table loads do not read data. Catalog federation, UIs, and metadata tools load tables to show schemas and properties. Producing full index metadata on every load costs the catalog work for no benefit.

The options discussed: return indexes by default, return them only when the client asks, perhaps with only names by default, or distinguish loads for reading from loads for metadata. Clients that do not understand indexes ignore the extra field in every option, so compatibility is safe either way. The decision is about cost.

## Authorization: indexes must not leak data

The sync settled one rule that every catalog implementer should read twice. The spec does not define how catalogs authorize index access. But the read restrictions section must state that read restrictions apply whether a client reads the table, the index, or both. An index must never expose data the caller cannot otherwise see.

That rule exists because an index is a copy of data in a different shape. A key index on `customer_id` holds every customer ID value in the table, with pointers to rows. If a row filter hides some customers from an analyst, the index still contains their IDs. An analyst who reads the index directly learns which customer IDs exist and roughly where they are stored, even without reading the rows.

Catalogs that enforce row and column restrictions through the Iceberg REST spec's read restrictions have to apply them to index reads too. In practice, that means either denying direct index reads to restricted principals or having the engine apply the restrictions after the index lookup and before returning anything. A related proposal in the PR review asks that index files be encrypted whenever the source table uses table encryption, so indexed values do not sit in plaintext beside encrypted data.

## The compaction problem

Compaction rewrites data files. It merges small files into larger ones and applies deletes. The rows stay the same, but their file paths and positions change.

For a positive key index that stores file paths and positions, that is a disaster. Every pointer into a rewritten file is now wrong. A reviewer on PR #16961 raised exactly this: a pure compaction of the source table can invalidate every index snapshot and force a full rebuild. That point is not yet resolved.

The draft's snapshot rule keeps correctness intact. After compaction, the table has a new snapshot, and the old index snapshot references the old one. A reader that wants the current table state sees that no index snapshot matches the current table snapshot, and falls back to a scan. The answer is right. The index just stops helping until someone rebuilds it.

Another reviewer pointed at a related cost. Because the index is clustered on a key that is not the table's physical layout, every append touches every region of the index, so maintenance cost scales with index size rather than with the size of the change. The sorted-runs proposal, which lets new runs overlap old ones, is one answer. It trades read cost for write cost, the same trade log-structured merge trees make.

### Where Cruise's proposal fits

Alex Cruise's proposal attacks the compaction problem from the other side. It targets Puffin blobs scoped to individual data files, such as a filter built for one file's contents. His motivation is what he calls progressive indexing: discovering weeks or months after a file is written that a different index makes reads much faster, and adding that index without rewriting the file. Large old files are expensive to rewrite, so building an index beside them is often the only practical option.

To make that safe, the proposal defines lightweight metadata for each blob type: its configuration, its scope, and how it behaves when its data file is deleted or compacted. A file-scoped filter blob that knows its scope can be dropped when its file is compacted away, or carried forward when its file survives. Because most such blobs are negative indexes, a missing or dropped blob costs speed, not correctness.

The full document is long, and Zheng Hu's November 11 request for a short summary is the next step. Watch for that summary before forming a firm view.

## How readers use an index

Putting the pieces together, here is the read path an engine follows with a key index under the draft.

1. **Load the table** and its current snapshot ID.
2. **Load the index metadata,** either with the table or through the index route.
3. **Find an index snapshot** whose `source-table-snapshot-id` equals the current table snapshot. If none matches, skip the index and plan a normal scan.
4. **Apply read restrictions.** Confirm the caller can read the table, and that the index lookup will not reveal restricted values.
5. **Look up the key.** Walk the tracking, range, and region files to get a list of file paths and row positions.
6. **Read only those rows,** applying deletes as usual.

Step 3 is the correctness gate. A reader must never use an index snapshot built for a different table snapshot, because rows added or deleted since then are missing from it. Engines that want to use a slightly stale index have to fill the gap themselves, for example by scanning only the files added since the indexed snapshot and merging those results with the index lookup. The draft does not define that hybrid path today.

## A worked example: looking up one customer

A concrete case shows why this matters. Take an `orders` table partitioned by day and sorted by `order_ts` within each file. It holds three years of orders across tens of thousands of Parquet files. Analysts filter by date most of the time, and partition pruning handles those queries well.

A support agent asks for every order placed by customer 48213. Without an index, here is what the engine does:

1. It loads the table and plans a scan with the filter `customer_id = 48213`.
2. Partition pruning does nothing, since the filter is not on the partition column.
3. Manifest statistics do little. Every file holds orders from many customers, so each file's `customer_id` bounds span most of the ID range.
4. Bloom filters, if the table has them, help. They let the engine skip files that definitely lack the ID. But the engine still checks a filter for every file in the table.
5. The engine reads the files that remain and filters rows.

With a key index on `customer_id`, the path is different:

1. The engine loads the table and its current snapshot ID.
2. It finds an index snapshot built for that exact table snapshot.
3. It looks up 48213 in the index and gets a list of file paths and row positions, perhaps a few dozen entries spread across a few dozen files.
4. It reads those positions and applies any deletion vectors.

The second path touches a handful of files. The first touches metadata for every file and data for many of them. For point lookups and small key sets on large tables, that difference is the whole reason indexes exist.

Now add one more step. Overnight, a maintenance job compacts last week's partitions. The table gets a new snapshot. The index snapshot still references yesterday's table snapshot. The next morning, the support agent's lookup runs, step 2 finds no matching index snapshot, and the engine falls back to the first path until the index is rebuilt. The answer is still correct. It is just slow again. That is the compaction problem in miniature.

## When an index is worth it

Indexes cost storage, write time, and maintenance. They pay off only for some workloads. Use these tests before indexing a table once the feature ships.

**Selective lookups on a non-layout key.** The query pattern filters on a key that is not the partition or sort column and matches a small fraction of rows. Customer lookups on time-partitioned orders are the classic case.

**Read-heavy tables.** The table is read far more often than it is written. Every append adds index maintenance work, so write-heavy tables pay more.

**Infrequent compaction, or compaction-aware maintenance.** If compaction runs hourly and invalidates the index each time, the index rarely helps. Tables compacted weekly, with a rebuild scheduled right after, get far more use from an index.

**Bloom filters are not enough.** Try Bloom filters first. They are negative indexes, cheap to keep, and safe when stale. If lookups still read too many files, a positive key index is the next step.

**Deletes by key.** If streaming writers delete rows by key, a key index lets them write deletion vectors instead of equality deletes. This one benefit can justify an index on its own, even for write-heavy tables.

If a table fails most of these tests, the cost of an index likely outweighs its benefit. Better clustering, such as sorting files by the lookup key during compaction, often gets most of the gain with none of the upkeep.

## Why equality-delete retirement depends on indexes

Indexes matter for more than lookups. They are on the critical path for one of Iceberg v4's biggest changes.

Iceberg v4 aims to retire equality deletes, which streaming writers use to delete rows by key without knowing where those rows live. Readers pay for equality deletes on every scan. The alternative is deletion vectors, which mark exact row positions. But to write a deletion vector, a writer has to know where the row is.

A November 13 thread on Kafka Connect makes the connection explicit. Andrei Tserakhau summarized a proposal for the Kafka Connect sink to convert each commit's equality deletes into deletion vectors before committing. A benchmark posted on the related PR found the conversion fast when keys increase over time and much slower with random UUID keys on a large table, because the writer has to read many files to find the rows. The thread named the index work in #16961 as the path for tables that do not prune well. Maximilian Michels raised doubts about how far ad hoc scanning scales without one.

So a positive key index is the mechanism that makes "delete by key" cheap once equality deletes go away. The background on why v4 is retiring them is in [Why Iceberg V4 Wants to Retire Equality Deletes](https://iceberglakehouse.com/posts/equality-deletes-iceberg-v4/).

## What Iceberg borrows from database indexing

None of the ideas in the draft are new to databases. What is new is applying them to immutable files shared by many engines.

A traditional database keeps a secondary index as a B-tree that it updates in place on every insert, update, and delete, inside the same transaction as the row change. The database owns both the table and the index, so they never disagree. Iceberg cannot work that way. Its data files are immutable, many engines write to the same table, and no single process owns every write. So the draft versions the index separately and pins each version to a table snapshot. Consistency comes from the snapshot match, not from a shared transaction.

The sorted-runs proposal borrows from log-structured merge trees, the design behind many key-value stores. New entries go into small sorted runs, and background work merges runs together. Reads check several runs and merge results. That keeps writes cheap at the cost of slower reads until merges catch up. For an index whose maintenance otherwise touches every region on every append, it is a natural fit.

The negative-index approach in the Puffin proposal borrows from analytic databases, which rely on zone maps and filters rather than row-level pointers. Those structures tolerate staleness well, which is why they dominate in systems where data is written in large batches and rarely updated.

Iceberg is heading toward both kinds: negative, file-scoped blobs for broad skipping, and positive key indexes for lookups and deletes by key. The specs being written now decide how cleanly the two coexist.

## What is settled and what is open

| Topic | Status as of November 16, 2026 |
| --- | --- |
| Index in same namespace as its table | Agreed (October 27 sync) |
| REST routes nested under the table | Agreed (November 9 sync) |
| Names unique per table | Agreed |
| Rename moves, drop drops indexes | Agreed |
| Multi-table indexes | Out of scope |
| Derived columns | Removed, separate effort |
| Read restrictions apply to index reads | Agreed, to be written into the spec |
| Rename and register operations | Out of first version |
| Indexes returned by loadTable | Open |
| Compaction invalidating index snapshots | Open |
| Sorted runs with overlap | Under discussion |
| Index file encryption with table encryption | Proposed |
| Pluggable Puffin blob lifecycle | Proposal, summary requested |

## Failure modes to plan for

These indexes are not in a release yet. When they ship, plan for these failure modes from the start.

**Index stops helping after compaction.** If compaction invalidates index snapshots, queries silently fall back to scans after every maintenance run. Watch index hit rates alongside compaction schedules, and plan rebuilds after compaction.

**Rebuild cost grows with the table.** If maintenance scales with index size, large tables with frequent appends spend heavily on index upkeep. Measure index maintenance cost before indexing your largest tables.

**Access leaks through indexes.** A catalog that authorizes index reads more loosely than table reads exposes restricted values. Test index access with restricted principals before enabling indexes on tables with row filters.

**Stale index reuse.** An engine that uses an index snapshot built for an older table snapshot returns wrong answers. Confirm your engines implement the snapshot match rule exactly.

**Version mismatch.** The draft lists a required `format-version` for indexes, and reviewers asked how readers handle unknown versions. Readers that ignore an unknown index version and use the index anyway risk misreading it. Pin engine versions until this is settled.

## How to follow and contribute

The work is moving in weekly syncs and two pull requests. Read PR #16961 for the index format and PR #16963 for the REST routes. The sync recordings are public, and Péter posted the November 9 recording on YouTube. The Puffin lifecycle proposal lives in Alex Cruise's repository and a commentable document linked from his November 2 email.

The most useful contributions now are concrete. Workloads where a key index changes query plans, compaction schedules that stress the snapshot rule, and access control setups that test the read restriction rule all help reviewers make decisions with real cases.

## Conclusion

Iceberg secondary indexes are taking shape as table sub-resources with their own snapshots, files, and REST routes. The design treats key indexes as positive indexes, where staleness means wrong answers, and guards correctness by pinning each index snapshot to an exact table snapshot. The REST layout nests indexes under tables, and the sync agreed that indexes must never expose data a caller cannot see in the table.

The hard problems are the ones every database with secondary indexes faces: compaction invalidating pointers, maintenance cost on wide tables, and staying correct under concurrent writes. A parallel proposal for file-scoped Puffin blobs takes the negative-index path, where staleness only costs speed. Together they give Iceberg a route to fast key lookups and cheap deletes by key, which the retirement of equality deletes in v4 depends on.

## Keep Going

If this piece was useful, I have written a lot more on how Iceberg organizes and prunes data. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers manifests, statistics, Puffin files, and the REST catalog in depth. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
