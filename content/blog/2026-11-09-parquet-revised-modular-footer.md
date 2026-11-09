---
title: "Parquet's Revised Modular Footer Proposal: Row Groups Stop Being Physical Boundaries"
description: "Parquet's revised modular footer proposal makes row groups optional, defines statistics over row ranges and stores metadata modules as Parquet pages."
date: 2026-11-09T09:00:00Z
tags: ["parquet", "apache-parquet", "file-formats", "query-planning"]
canonical: https://datalakehousehub.com/blog/parquet-revised-modular-footer/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/parquet-revised-modular-footer/).

The revised Parquet modular footer proposal, posted to the Parquet dev list on October 30, 2026, stops treating row groups as physical boundaries. Row group metadata becomes optional, and a column chunk becomes any contiguous run of pages for one column. Statistics are defined over row ranges, and footer modules are stored as Parquet pages. It is a proposal, not yet a format change.

Every engineer who has profiled a query on a wide Parquet table has met the footer problem. The query touches four columns out of 900. The data read is small. The time goes into reading and decoding the footer, a single Thrift-encoded blob at the end of the file that describes every column in every row group. To find four columns, the reader decodes metadata for all 900, row group by row group. On object storage with thousands of such files, footer decoding becomes a visible share of query planning and execution.

The modular footer work started as a fix for that cost. The October revision goes further. It changes what a row group is. Julien Le Dem, one of Parquet's co-creators, called the revision fairly transformational and asked for broad review, since the project wants to avoid changing the footer again for a long time.

This article explains today's footer, the changes in the revision, what each one means for readers and writers, and what Apache Iceberg has to change if it lands.

## Today's Footer in One Picture

A Parquet file today has a simple physical layout:

```
+-------------------------------------------------------------+
| "PAR1" magic                                                |
| Row group 0                                                 |
|   Column chunk A: [dict page][data page][data page]...      |
|   Column chunk B: [data page][data page]...                 |
|   ... one chunk per column ...                              |
| Row group 1                                                 |
|   Column chunk A ...                                        |
|   Column chunk B ...                                        |
| ...                                                         |
| Optional page indexes (column index, offset index)          |
| Footer: FileMetaData (Thrift)                               |
|   schema                                                    |
|   row_groups[]                                              |
|     columns[] -> offsets, sizes, encodings, statistics      |
|   key/value metadata                                        |
| footer length (4 bytes) + "PAR1" magic                      |
+-------------------------------------------------------------+
```

Three properties of this layout matter for what follows.

**Row groups are horizontal slices.** Every column has exactly one chunk per row group, covering the same rows. If a file has 10 row groups and 900 columns, it has 9,000 column chunks, and the footer describes all of them.

**The footer is one structure.** `FileMetaData` holds the schema, every row group and every column chunk's metadata, including statistics. A reader that wants anything decodes it as one Thrift message. Thrift's compact protocol does not support random access into the middle of a message.

**Statistics live at the column chunk level.** Minimum, maximum and null counts are recorded per column per row group. Finer-grained stats live in the optional page indexes, which sit outside the footer.

The row group's dual role causes the trouble. It is both a logical unit, the set of rows a split covers, and a physical unit, the place where every column's data for those rows sits together. Writers have to pick one row group size for all columns, even when a narrow integer column and a wide text column behave completely differently.

## How the Proposal Got Here

The work has been visible on the dev list for months.

In June 2026, Jiayi Wang raised a question about assumptions readers make that the spec does not state. In the thread, Jiayi described how parquet-java assigns row groups to splits using a midpoint computed from the first column chunk's offset, which silently assumes that the first column in schema order has the smallest file offset and that row groups do not overlap. The spec, by Jiayi's reading, only requires less than that. The discussion surfaced how much reader behavior depends on layout conventions rather than spec rules.

In September, Jiayi opened issue #622 on the parquet-format repository, titled "Introduce modular footer." The issue describes a layout that separates schema, column placement, statistics and other metadata into independently addressable and decodable modules, so readers fetch only the metadata needed for schema resolution, I/O planning and pruning. Prototype results and benchmarks went through community sync meetings, with feedback folded into later drafts.

The modular footer was not the only idea in play. Earlier in 2026, an alternative proposal kept Thrift and added a lightweight byte-offset index into the footer, so readers decode selectively with much less disruption. A separate effort explored non-contiguous pages to give writers more layout freedom. The October revision pulls in that layout flexibility directly.

## The Changes in the Revision

The October 30 revision makes several connected changes. Here they are one at a time.

### 1. Row group metadata becomes optional

In today's format, the footer is organized around row groups. The revision makes row group metadata optional. A file can describe its data without declaring row groups at all.

Row groups do not vanish as a concept for readers that want them. They stop being the structure the footer is built on.

### 2. A column chunk is a contiguous run of pages for one column

Today, a column chunk is "the pages of column X inside row group N." The revision redefines it as any contiguous set of pages for one column.

The consequence is the important part: different columns can have different numbers of chunks. A narrow integer column can be one chunk for the whole file. A wide text column can be ten chunks. Each column is laid out the way that suits it, instead of all columns sharing the row group's boundaries.

### 3. Statistics are defined over row ranges

If row groups no longer define physical slices, statistics cannot be "per column per row group." The revision defines stats over row ranges instead. A statistic says "for rows 0 through 1,048,575 of this column, the minimum is X." Since chunk boundaries can differ by column, each column's stats follow its own row ranges.

This is closer to how page indexes already work, where each page records the first row it covers. Row ranges make that idea the main way statistics are expressed.

### 4. Footer modules are stored as Parquet pages

An earlier version of the proposal introduced an EncodedArray concept for storing metadata modules. Reviewers found it confusing. The revision replaces it with Parquet pages themselves. Metadata modules, such as the per-column placement and stats, are written as Parquet pages.

That choice reuses machinery every Parquet reader already has: page headers, encodings and compression. A reader that can decode a data page can decode a metadata module. It also makes metadata columnar. Statistics for one column across many chunks sit together and decode without touching other columns' metadata.

### 5. Readers fetch only what they need

The goal from issue #622 carries through. Schema, column placement and statistics become separately addressable modules. A query that needs four columns reads the schema, then the placement and stats modules for those four columns. It skips the other 896.

## A Worked Example: One Wide Table, Before and After

Numbers make the change concrete. Take a hypothetical event table with 900 columns. Most are sparse attributes, a few are dense keys and timestamps, and one is a long JSON payload. A typical file holds 8 million rows. The arithmetic below is illustrative, chosen to show the shape of the change rather than measured results.

**Today.** The writer picks a row group size of 1 million rows, so the file has 8 row groups. The footer describes 8 times 900, or 7,200 column chunks, each with offsets, sizes, encodings and statistics. A query that selects `event_time`, `user_id`, `country` and `revenue` with a filter on `event_time` opens the file, fetches the footer and decodes all 7,200 entries to find the 32 it needs. Then it checks `event_time` stats for 8 row groups and reads the surviving ones.

The row group size is a compromise. The JSON payload column wants smaller groups so a single chunk does not grow to hundreds of megabytes. The sparse attributes want larger groups so their tiny chunks do not each carry their own page headers and stats overhead. One size serves neither well.

**Under the revision.** The writer lays out each column on its own terms. The 890 sparse attributes each become one chunk for the whole file. `event_time`, `user_id`, `country` and `revenue` each become 8 chunks, matching their size. The JSON payload becomes 32 smaller chunks. Metadata modules describe placement and row-range statistics per column, stored as pages.

The same query reads the schema module, then the placement and stats modules for its four columns. It skips the modules for the other 896 columns. It checks `event_time` row-range stats, computes which row ranges survive the filter, and reads the matching pages of the four columns, aligning them by row number.

The footer work drops from decoding 7,200 entries to decoding modules for 4 columns. The read path adds alignment logic, since `event_time` and `revenue` chunk boundaries now line up only because the writer chose so, not because a row group forced it. For a table queried thousands of times a day across thousands of files, the planning savings compound.

## Comparing the Footer Approaches

The modular footer is one of several approaches the Parquet community has discussed this year. They trade disruption against benefit differently.

| Approach | What changes | Reader benefit | Compatibility cost |
|---|---|---|---|
| Current footer | Nothing | Baseline | None |
| Thrift footer plus byte-offset index | Adds a small index pointing into the existing footer | Selective decoding of column metadata | Low, old readers ignore the index |
| Modular footer, first drafts | Separates schema, placement and stats into modules | Fetch and decode only needed modules | High, new footer layout |
| Modular footer, October revision | Modules as pages, optional row groups, per-column chunks, row-range stats | Selective metadata plus finer pruning and flexible layout | Highest, changes the data layout model |

Read the table as a spectrum. The byte-offset index captures much of the decode savings with minimal disruption. The October revision captures the most benefit, including layout freedom that the other approaches do not touch, and asks the most of every implementation. The review will decide where on that spectrum Parquet lands, and it is possible for a lighter approach to ship first while the larger one matures.

## What Platform Teams Should Do Now

Nothing in the proposal requires action today. A few steps prepare you for whatever lands.

**Measure.** Run the footer report above across a sample of your largest and most-queried tables. Record footer size, decode time and columns touched per query. That baseline turns the eventual decision into a number.

**Find your widest tables.** Wide tables with selective queries benefit most. Make a short list. They are your candidates for early adoption once readers support the new footer.

**Inventory your readers.** List every engine, library and tool that reads your Parquet files, with versions. Format changes roll out only as fast as the slowest reader. Knowing your slowest reader now saves a surprise later.

**Tune today's files.** Larger row groups, statistics only on filtered columns and sorting on common filter columns all reduce footer cost and improve pruning under the current format. They also make the eventual migration smaller.

**Share benchmarks.** If you run wide tables at scale, your measurements are useful to the review. Post them on the dev list or in issue #622. Format decisions improve when they rest on production numbers.

## Reader Impact

### Planning

Planning gets cheaper on wide tables. Today, the footer decode cost grows with the number of columns times the number of row groups, regardless of how many columns a query touches. With modules, the cost tracks the columns the query uses. For a 900-column table where queries typically touch a handful, that is the difference between decoding everything and decoding a sliver.

### Page skipping

Row-range statistics put fine-grained pruning in the main metadata path. A reader can match a filter against stats for row ranges in each column and compute which row ranges survive. Combining ranges across columns, with an intersection for AND filters, gives the exact rows to read. Readers that already use page indexes do this today. The revision makes it the normal path rather than an optional extra.

### Memory

Readers today often hold the whole decoded footer in memory while scanning a file. For wide files with many row groups, that is a lot of objects. Modular reads let a reader hold only the modules it needs, which reduces memory pressure in engines that open many files at once.

### The cost: more complex alignment

The new flexibility moves work into readers. When columns have different chunk boundaries, a reader assembling rows has to align chunks that do not line up. Column A's chunk covers rows 0 to 2 million. Column B's chunks cover 0 to 500,000, then 500,000 to 1 million, and so on. To produce a batch of rows, the reader steps through each column's chunks independently and stitches them by row number.

Vectorized readers already handle page boundaries that do not align across columns, because page sizes differ by column today. Extending that logic to chunk boundaries is natural but not free. Split planning also changes. An engine that splits files by row group needs a new rule, such as splitting by row ranges.

## Writer Impact

### Uneven chunk counts per column

Writers gain the most freedom. Today, a writer buffers one row group's worth of rows for every column before flushing, which ties memory use to the widest columns. With independent chunk boundaries, a writer can flush each column when its own buffer fills. Narrow columns produce few large chunks. Wide columns flush more often. Memory use evens out, and file layout follows each column's real size.

### Streaming and incremental writers

Writers that produce files incrementally, such as streaming sinks, benefit from flushing columns independently. They no longer need to pick a row group size that works for every column at once.

### The cost: new writer logic and compatibility choices

Writers have to produce the new metadata modules and row-range statistics, and decide on chunk boundaries per column. They also face a compatibility question. A file written with the modular footer and independent chunk boundaries cannot be read by older readers that expect the current footer. Writers will need a setting that chooses the format, and teams will keep writing classic files until every reader in their stack understands the new one.

The proposal's compatibility details are part of the review, and the community's separate work on a taxonomy of format changes, which defines backward compatibility, forward compatibility and "correct failed reads" where a reader errors out instead of returning wrong data, sets the rules for how this rolls out.

## Inspecting Your Footer Cost Today

Before the proposal lands, you can measure how much the footer costs you now. PyArrow exposes footer metadata directly:

```python
import sys
import time
import pyarrow.parquet as pq

def footer_report(path):
    start = time.perf_counter()
    meta = pq.ParquetFile(path).metadata   # reads and decodes the footer
    elapsed_ms = (time.perf_counter() - start) * 1000

    chunks = meta.num_row_groups * meta.num_columns
    print(f"{path}")
    print(f"  columns:            {meta.num_columns}")
    print(f"  row groups:         {meta.num_row_groups}")
    print(f"  column chunks:      {chunks}")
    print(f"  footer bytes:       {meta.serialized_size:,}")
    print(f"  footer open (ms):   {elapsed_ms:.1f}")
    print(f"  bytes per chunk:    {meta.serialized_size / max(chunks, 1):.0f}")

for p in sys.argv[1:]:
    footer_report(p)
```

The script opens each file's metadata, which reads the footer and decodes it, and reports the counts that drive footer size. `num_columns` times `num_row_groups` gives the number of column chunks the footer describes. `serialized_size` is the footer's size in bytes. The timing includes the I/O to fetch the footer, so run it once against local files to isolate decode time, then against object storage paths through a filesystem such as `pyarrow.fs.S3FileSystem` to see the full cost.

Look for three warning signs. Footers above a few megabytes. Files where bytes per chunk is high, which usually means large statistics such as long string bounds. And tables where queries touch few columns but the footer covers hundreds. Those are the tables the modular footer helps most.

Two mitigations work today. Fewer, larger row groups reduce chunk count. Disabling statistics for columns that never appear in filters shrinks the footer, though it removes pruning for those columns, so only do it for columns you never filter on.

## Row-Range Statistics in More Detail

Row-range statistics are the quiet center of the revision, so they deserve a closer look.

Today's statistics answer "what values does this column hold in row group N." The answer is tied to a physical slice. Row-range statistics answer "what values does this column hold in rows R1 through R2." The answer is tied to a logical span of row numbers within the file.

That shift has three effects.

**Stats granularity becomes a writer choice per column.** A writer can record stats for large ranges on a column nobody filters, keeping metadata small, and for fine ranges on a column used in most filters, giving the planner precise pruning. Today, granularity is the row group size for the footer stats and the page size for page indexes, and both are global decisions.

**Pruning results combine across columns by row number.** A filter on `country = 'BR' AND revenue > 1000` produces surviving row ranges from each column's stats. Intersect them and you get the rows worth reading. Today's row group pruning does the same thing at a coarser grain, and page index pruning does it at a finer grain, but through an optional side structure many readers skip.

**Stats stay meaningful when layouts differ.** Because the unit is rows, not physical chunks, two columns with different chunk boundaries still produce comparable stats. A reader never has to reconcile "row group 3 of column A" with "chunk 7 of column B." It compares row numbers.

## Why This Matters for Point Lookups and AI Workloads

Lakehouse files increasingly serve workloads beyond large scans. Feature stores fetch a handful of rows by key. Retrieval pipelines for AI agents pull small result sets. Embedding columns are wide and heavy next to narrow key columns.

These workloads suffer most under today's footer. A point lookup that reads one row still pays for a full footer decode. A table with a 1,536-dimension embedding column next to a dozen small columns has to choose a row group size that fits the embeddings and wastes metadata on everything else.

The revision helps both. Selective metadata reads cut the fixed cost of opening a file for a tiny read. Per-column chunk boundaries let the embedding column use small chunks without forcing the key columns to follow. Combined with Parquet's separate work on a vector type, the footer change is part of how Parquet keeps up with workloads its original design did not anticipate.

## What Iceberg Manifests and Stats Need

Iceberg sits on top of Parquet, so a change in what a row group is ripples up.

**Split planning.** Iceberg manifests record `split_offsets` for each data file, which engines use to plan splits. Today those offsets typically mark row group starts. If row groups stop being physical boundaries, Iceberg needs a new way to describe split points, likely row ranges or byte offsets of chunk sets that line up across columns.

**File statistics.** Iceberg's file-level stats are aggregated from Parquet column stats. With row-range stats in Parquet, the aggregation changes, but the result at the file level, a min and max per column, stays the same. Iceberg v4's typed `content_stats` and file-level `tight_stats` flag stay compatible with either footer.

**Finer pruning.** Row-range stats open a door. Iceberg engines today prune whole files from manifest stats and then rely on Parquet readers for page-level pruning. With row ranges in the main footer path, readers prune within files more consistently, which helps large files and tables that compact into big files.

**Engine coordination.** Iceberg tables are read by many engines. A table can only use modular-footer Parquet files once every engine that reads it supports them. Iceberg does not currently record the Parquet footer version in table metadata, so teams will manage this through writer settings and engine version policies until a mechanism exists.

None of this requires Iceberg spec changes on day one. It does require Iceberg's Parquet integration in each language to learn the new footer and split model before any writer turns it on.

## Failure Modes to Plan For

If the proposal moves forward, a few risks deserve attention during rollout.

**Readers that assume the old layout.** The June thread showed parquet-java making layout assumptions the spec does not require. Other readers have their own. Files with uneven chunk boundaries will find those assumptions. The safest rollout keeps new layouts behind writer flags until conformance tests cover them.

**Mixed files in one table.** A table that holds classic and modular files at once is fine for a reader that understands both, and broken for one that does not. Plan engine upgrades before writer upgrades.

**Tooling gaps.** Command-line inspectors, data quality tools and file validators read footers directly. Each needs an update. Check the tools in your pipeline, not just the query engines.

**Performance regressions on narrow tables.** Modular footers help wide tables most. On narrow tables with few columns, the extra structure costs a little with little benefit. Benchmarks in the review should show both ends.

## How to Follow the Vote

The proposal is under review, not under vote. A format change of this size goes through discussion on dev@parquet.apache.org, review in the parquet-format repository, implementations in at least two languages and then a formal vote.

To follow it, subscribe to the Parquet dev list and watch issue #622 in apache/parquet-format. The community also holds footer sync meetings, announced on the dev list. If you maintain a Parquet reader or writer, or run wide tables at scale, your benchmarks are exactly the input the review needs.

## Conclusion

The revised modular footer proposal starts from a performance problem and ends with a structural change. Footers become sets of modules that readers fetch selectively, stored as ordinary Parquet pages. Row group metadata becomes optional. Column chunks become runs of pages per column with their own boundaries, and statistics follow row ranges instead of row groups.

For readers, that means cheaper planning on wide tables and finer pruning, in exchange for alignment logic across uneven chunks. For writers, it means freedom to lay out each column on its own terms. For Iceberg, it means new split planning and a coordinated rollout across engines. None of it is final. Measure your footer costs now, so when the vote comes you know how much this change is worth to your tables.

The broader lesson is about how open formats evolve. Parquet's footer survived more than a decade because it was simple and every engine could read it. Changing it takes years of review, two or more implementations and careful compatibility rules. That pace frustrates people who feel the footer cost today. It is also why Parquet files written in 2014 still open in 2026 engines, and why a change made carefully now will still be readable a decade from now.

## Keep Going

If this piece was useful, I have written a lot more on Parquet internals and how Iceberg uses them. *Architecting an Apache Iceberg Lakehouse* (Manning) covers file layout, statistics and planning across the format stack, which is the context you need to judge a change like this one. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
