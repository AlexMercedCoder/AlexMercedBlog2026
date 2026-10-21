---
title: "How to Choose Between Partitioning, Sort Orders, and Z-Order in Apache Iceberg"
description: "Partitioning, sort orders, and Z-order each cluster Iceberg data differently. Compare the costs, the failure modes, and how to measure layout with data_files."
date: 2026-10-21T09:00:00Z
tags: ["Apache Iceberg", "partitioning", "Z-order", "sort order", "query performance"]
canonical: https://datalakehousehub.com/blog/iceberg-partitioning-sort-order-zorder/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/iceberg-partitioning-sort-order-zorder/).

A query filters an Iceberg table on one customer ID. The table holds a year of events in 150,000 Parquet files. The engine reads the table metadata, checks the column statistics for every file, and finds that 149,000 of them cover a range that includes that customer. It reads all of them. The query returns 30 rows after reading every one of those files.

Nothing is broken. The statistics are accurate. Every file really does contain a range of customer IDs wide enough to include the one you asked for, because the rows landed in files in the order they arrived, and customers arrive in random order. Iceberg did its job. The layout gave it nothing to work with.

File layout is the single biggest lever on read cost in an Iceberg table, and it is controlled by three separate mechanisms that people tend to mix up: partitioning, sort orders, and Z-order clustering. Each one changes which rows end up in which files. Each one has a different cost, a different failure mode, and a different set of queries it helps.

This article explains all three from the metadata up. It covers how Iceberg uses file statistics to skip work, what each layout mechanism does to those statistics, how they combine, how to measure whether your layout is working, and how to design a layout for a real query mix. If you want a quick definition of any single term, the knowledge base has short entries on [sort order](https://iceberglakehouse.com/iceberg/iceberg-sort-order/), [Z-order clustering](https://iceberglakehouse.com/iceberg/iceberg-zorder/), and [table clustering](https://iceberglakehouse.com/iceberg/iceberg-clustering/). This piece is the full decision guide.

## Three Levels of Skipping, and Where Layout Fits

Every Iceberg read is an exercise in avoiding work. The engine wants to touch as few bytes as possible, and the format gives it three chances to skip data before it decodes a single value.

The first chance is the manifest list. Each snapshot points to a manifest list, and each entry in that list describes one manifest file, including a summary of the partition values it covers: lower and upper bounds per partition field, plus whether nulls or NaN values appear. If a query filters on a partition column and a manifest's partition range cannot match, the engine skips the whole manifest without opening it.

The second chance is the manifest itself. Each manifest lists data files, and each data file entry carries its partition tuple plus per-column statistics: record count, null counts, and lower and upper bounds for each tracked column. The engine compares the query predicate against those bounds. If a file's range for `customer_id` is 1,000 to 2,000 and the query asks for 5,000, the file is skipped. This is file pruning, and it is where layout matters most.

The third chance is inside the Parquet file. Parquet stores min and max statistics for each row group and, when page indexes are written, for each page. Readers skip row groups and pages whose ranges cannot match. Optional Bloom filters let readers skip row groups for equality predicates on high-cardinality columns where min and max are useless.

Layout does not change how any of these mechanisms work. It changes how useful their statistics are. A lower and upper bound is a summary of a range. If the rows in a file cover a narrow range of a column, the bounds are tight and the file is easy to skip. If the rows cover nearly the full range, the bounds tell the engine nothing, and the file is read on every query.

So the goal of every layout technique is the same. Put rows that share values close together in the same files, so the bounds on each file stay narrow on the columns that queries filter by. Partitioning does this at the coarsest grain by putting rows into separate directories of files. Sorting does it within and across files by ordering rows on one or more columns. Z-order does it across several columns at once with a space-filling curve.

The trade is always the same too. Clustering on one column scatters the others. There is no layout that keeps every column tight at once. Choosing a layout means deciding which filters matter most and accepting worse pruning on the rest.

## Partitioning: Coarse Skipping That Costs Files

Partitioning splits a table into groups of files by the value of a partition expression. In Iceberg, those expressions are transforms applied to source columns, and the table tracks them in its partition spec. This is hidden partitioning. Users filter on the source column, such as `event_ts`, and Iceberg translates that filter into partition space automatically. Nobody writes `WHERE event_date = ...` against a derived column, and nobody gets the wrong answer for forgetting to.

Iceberg supports a fixed set of transforms. `identity` uses the column value as is. `year`, `month`, `day`, and `hour` truncate timestamps and dates. `bucket[N]` hashes a value into N buckets. `truncate[W]` cuts strings to W characters or rounds numbers down to a multiple of W. A spec can combine several, such as `days(event_ts)` plus `bucket(16, customer_id)`.

Partitioning gives the strongest pruning Iceberg offers. A file belongs to exactly one partition, so a filter that excludes a partition excludes every file in it with certainty, and the manifest-list summaries let the engine skip whole manifests at once. For tables where almost every query filters on time, a time-based partition is the most effective layout decision you will make.

The cost is file count. Every partition gets its own files. A streaming job that writes every minute into an hourly-partitioned table produces at least one file per partition per commit. Partition too finely and you get thousands of tiny files per day, each with its own manifest entry, its own open cost on read, and its own statistics overhead. Small files raise planning time, raise object storage request counts, and lower compression ratios. The rule of thumb that holds up in practice: partition on a column that nearly every query filters on, at a grain that leaves each partition with at least several target-sized files.

The second cost is cardinality. Partitioning on a high-cardinality column such as `customer_id` with the identity transform produces one partition per customer, which is millions of tiny partitions. That is the classic over-partitioning mistake. The `bucket` transform exists for this case. `bucket(16, customer_id)` spreads customers across 16 partitions, so a lookup on one customer reads one bucket out of 16 instead of the whole table. The bucket transform also enables storage-partitioned joins in engines that support them, because two tables bucketed the same way can be joined bucket by bucket without a shuffle.

Iceberg's partition evolution matters for layout decisions too. You can change a table's partition spec with `ALTER TABLE ... ADD PARTITION FIELD` or `REPLACE PARTITION FIELD` without rewriting existing data. Old files keep the old spec, new files use the new one, and the engine plans each spec's files separately. That means a partitioning mistake is cheap to fix going forward, and a compaction job can rewrite older data into the new spec on your schedule.

Partitioning helps only the columns in the partition spec. It does nothing for a filter on `product_id` if the table is partitioned by day. For those columns, you need to control the order of rows within each partition, which is what sort orders and Z-order do.

## Sort Orders: One Column Gets Perfect Clustering

An Iceberg table can declare a sort order in its metadata. A sort order is a list of sort fields, each with a source column, an optional transform, a direction, and a null ordering. The table tracks its sort orders by ID, and the current one is the table's default write order. Engines that honor it sort data before writing it, and compaction jobs use it when rewriting.

In Spark with the Iceberg SQL extensions, you set it with DDL:

```sql
ALTER TABLE lake.analytics.events WRITE ORDERED BY customer_id, event_ts
```

This command does two things. It sets the table's sort order, and it sets the table property `write.distribution-mode` to `range`, so Spark range-partitions rows across write tasks before sorting them. The result is a global sort: across all files written in that job, each file holds a contiguous slice of the sort key.

The alternative is a local sort:

```sql
ALTER TABLE lake.analytics.events WRITE DISTRIBUTED BY PARTITION LOCALLY ORDERED BY customer_id
```

This hash-distributes rows by partition, so each table partition goes to one writer, and then sorts rows only within each task. The shuffle is cheaper than a range sort. Files within a partition are each sorted internally, which helps row-group and page skipping inside Parquet. But files from different tasks overlap each other on the sort column, so file-level pruning is weaker.

Sorting gives the first sort column perfect clustering. After a global sort on `customer_id`, every file holds a disjoint range of customer IDs. A query for one customer matches exactly one file, or two if the customer straddles a boundary. On a partition with 400 files, that is the difference between reading 400 files and reading one.

The second sort column gets much less. Within each run of identical `customer_id` values, rows are ordered by `event_ts`. That helps only for queries that filter on both columns together. A query that filters only on `event_ts` sees every file covering nearly the full time range of the partition, because each file holds a slice of customers, and each customer has events across the whole period. The second column is clustered only inside the first.

This is the key property of a lexicographic sort. It is excellent for the leading column, useful for the leading prefix, and close to useless for later columns on their own. A sort on `(region, customer_id)` helps queries on `region` and queries on `region AND customer_id`. It does almost nothing for queries on `customer_id` alone, unless region is low cardinality, in which case each region's slice is itself sorted by customer, and a customer lookup touches one slice per region.

That last point is the most useful trick in sort order design. A low-cardinality column placed first costs almost nothing for later columns. If `region` has 8 values, sorting by `(region, customer_id)` gives a customer lookup at most 8 runs to check instead of 1. Placing a high-cardinality column first, by contrast, destroys clustering on everything after it.

Sort orders are also the only layout tool that engines apply at write time in the normal write path. Spark honors the table's sort order for inserts and for `MERGE INTO`. That makes sorting the cheapest way to keep a table organized continuously, without waiting for compaction.

Iceberg prepends partition columns to the sort when needed, so you do not repeat them in the write order. And sort fields accept transforms, so a sort on `days(event_ts)` or `bucket(16, customer_id)` is valid when you want ordering at a coarser grain than the raw column.

## Z-Order: Good Enough on Several Columns Instead of Perfect on One

Z-order exists because of the problem in the previous section. When queries filter on two or three different columns independently, no lexicographic sort serves them all. Z-order gives up perfect clustering on the first column in exchange for decent clustering on every column in the set.

The mechanism is a space-filling curve. Picture two columns as the axes of a grid. A lexicographic sort walks the grid one full row at a time, so neighbors along the first axis stay together and neighbors along the second axis end up far apart. A Z-order curve, also called a Morton curve, walks the grid in small square blocks, then blocks of blocks, recursively. Points close together in both dimensions end up close together on the curve. When you cut the curve into files, each file covers a compact rectangle of the grid instead of a long thin strip.

The way to build that curve is bit interleaving. Take the binary representation of each column's value and weave the bits together: the first bit of column A, then the first bit of column B, then the second bit of A, then the second bit of B, and so on. Sort rows by the interleaved result. Rows that share high-order bits in both columns sort next to each other.

Iceberg's implementation in the Spark rewrite action follows this approach, with practical details that matter for your results. Each column value is first converted to a byte representation that preserves sort order, so negative numbers sort before positive ones and floats compare correctly as bytes. Variable-length values such as strings contribute a fixed number of leading bytes, controlled by the `var-length-contribution` option, which by default matches the width used for primitive types. The interleaved output has a size cap, set by `max-output-size`. Rows are then sorted by the interleaved bytes and written into target-sized files.

Two consequences follow directly from that design.

First, only the leading bytes of a string participate. If a string column holds URLs that all start with `https://www.`, the first 8 bytes are identical for every row, and the column contributes nothing to the clustering. The same applies to IDs with a fixed prefix such as `cust-00`. Z-order works best on numeric columns, timestamps, and strings whose variation starts at the first character.

Second, each added column dilutes the others. With two columns, each gets half the bits of clustering. With four, each gets a quarter. In practice, Z-order on two or three columns gives clearly useful pruning on each, and adding more columns quickly leaves every column with wide file ranges. If you are tempted to Z-order on six columns, the queries on those columns do not share a layout, and you need a different design.

Z-order has an important operational limit in Iceberg. It is a rewrite strategy, not a table sort order. The table's sort order cannot contain a Z-order expression, so normal writes do not produce Z-ordered files. Z-ordering happens when you run `rewrite_data_files` with a `zorder(...)` sort order. Data written between compactions lands in whatever order the writer produced, and it stays unclustered until the next rewrite covers it.

There is one more detail in the Spark implementation worth knowing. If you include an identity partition column in the Z-order list, the action drops it with a warning, because every row in a partition already shares that value. Interleaving a constant wastes bits.

Z-order also does not replace sorting for a dominant column. If 80 percent of your queries filter on `customer_id` and 20 percent on `product_id`, a sort on `customer_id` serves the 80 percent perfectly and leaves the 20 percent no worse than an unsorted table. A Z-order on both serves both moderately. The right choice depends on the query mix, and that is a measurement question, which the next sections cover.

## How the Three Mechanisms Combine

These tools are not alternatives. They operate at different levels and stack.

Partitioning sets the outer boundaries. Within each partition, either a sort order or a Z-order arranges rows into files. Inside each file, the arrangement also makes Parquet row group and page statistics tighter, because a file's internal order follows the same layout.

| Mechanism | Where it acts | Columns it serves well | Applied at write time | Main cost |
|---|---|---|---|---|
| Partitioning (transforms) | Directory and manifest level | Partition source columns | Yes, always | More files, risk of small files |
| Global sort (`WRITE ORDERED BY`) | Across files within a partition | Leading sort column, then prefixes | Yes, in engines that honor it | Range shuffle on every write |
| Local sort (`LOCALLY ORDERED BY`) | Within each written file | Leading column, row-group level | Yes | Weak file-level pruning |
| Z-order (`zorder(...)` in rewrite) | Across files within a partition | Two or three columns, moderately | No, compaction only | Full rewrite of the targeted files |
| Bloom filters (Parquet) | Row groups within a file | High-cardinality equality filters | Yes, when enabled | Extra bytes per file |

A common and effective combination looks like this. Partition by time at a grain that keeps partitions reasonably full. Set a local sort or a cheap global sort for ingestion so new files are not random. Then run a nightly or weekly compaction over recently closed partitions that either sorts them globally on the dominant column or Z-orders them on the two or three columns that queries share.

That pattern separates the two jobs layout has to do. Ingestion stays fast because it does a cheap sort. Read performance on older data comes from a heavier rewrite that runs once per partition, after the partition stops receiving new data.

Bloom filters fill a gap the others leave. A Z-order on `(customer_id, product_id)` narrows file ranges on both columns, but each file still spans a range of customers. A Parquet Bloom filter on `customer_id`, enabled per column with `write.parquet.bloom-filter-enabled.column.customer_id`, lets the reader skip row groups inside a matching file when the specific value is absent. Its size is capped per column by `write.parquet.bloom-filter-max-bytes`, which defaults to 1 MB, and it helps only equality and IN predicates.

## Measuring Layout With the Files Metadata Table

Layout decisions should rest on measurements, and Iceberg makes the measurements easy because the statistics live in metadata you query with SQL. Every Iceberg table exposes metadata tables, and `data_files` lists every live data file with its record count and per-column bounds. In recent Iceberg versions, the `readable_metrics` column presents those bounds as typed values instead of raw bytes.

This Spark SQL query measures how well a table is clustered on one column. It reports the number of files, how wide each file's range is relative to the whole column range, and how many files a lookup on one specific value must read.

```sql
WITH f AS (
  SELECT
    file_path,
    record_count,
    readable_metrics.customer_id.lower_bound AS lo,
    readable_metrics.customer_id.upper_bound AS hi
  FROM lake.analytics.events.data_files
  WHERE readable_metrics.customer_id.lower_bound IS NOT NULL
),
g AS (
  SELECT min(lo) AS gmin, max(hi) AS gmax, count(*) AS file_count
  FROM f
)
SELECT
  max(g.file_count)                                          AS data_files,
  round(percentile_approx((f.hi - f.lo) / (g.gmax - g.gmin), 0.5), 4) AS median_span_fraction,
  round(percentile_approx((f.hi - f.lo) / (g.gmax - g.gmin), 0.9), 4) AS p90_span_fraction,
  sum(CASE WHEN 424242 BETWEEN f.lo AND f.hi THEN 1 ELSE 0 END)        AS files_touched_by_probe
FROM f
CROSS JOIN g
```

Here is what each part does.

The first expression, `f`, reads one row per data file from the `data_files` metadata table and pulls the typed lower and upper bounds for `customer_id`. The filter drops files where the column has no bounds, which happens when metrics are disabled for the column or the column is all null in that file.

The second expression, `g`, finds the global minimum and maximum across all files, plus the file count.

The final query computes the span fraction for each file: the width of its range divided by the width of the whole column. A value near 1.0 means the file covers almost every customer, which means it cannot be pruned for any customer lookup. A value near 0.0 means the file covers a narrow slice. The median and 90th percentile summarize the distribution. The last column counts how many files contain a specific probe value. That is a direct estimate of how many files a point lookup reads, before any Parquet-level skipping.

Run it before and after a layout change and you have an objective measure of the change. An unsorted table on a random key typically shows a median span fraction close to 1.0 and a probe count close to the file count. After a global sort on that key, the median span drops toward one divided by the file count, and the probe touches one or two files. After a two-column Z-order, both columns land somewhere in between, which is the trade working as designed.

For numeric and timestamp columns, the arithmetic works directly. For strings, compute the probe count instead of the span fraction, since string subtraction is not defined. Add a `WHERE` on the partition column to measure one partition at a time, which is usually the right scope, since layout is applied per partition.

The second measurement comes from the engine. Iceberg produces a scan report for each table scan, including the number of data files considered and the number skipped. Engines expose this in their query profiles, and Spark reports it through Iceberg's metrics reporting. Comparing skipped versus scanned files for your real queries tells you whether the layout helps the workload you actually run, not just a probe value you picked.

One caution about bounds on strings. By default, Iceberg truncates string bounds to 16 characters through the `write.metadata.metrics.default` setting of `truncate(16)`. For strings that differ only after the 16th character, the bounds cannot separate them, and pruning on that column is weak no matter how well the data is sorted. Raise the truncation length per column with `write.metadata.metrics.column.<name>` if you depend on string pruning. Also note that Iceberg collects bounds only for the first 100 columns by default, controlled by `write.metadata.metrics.max-inferred-column-defaults`. On wide tables, a filter column that sits past position 100 gets no bounds unless you configure it explicitly.

## A Worked Layout Design

Here is a layout design for a concrete table. The table and its query mix are illustrative, but the reasoning carries over to most event tables.

The table is `analytics.events`, with columns `event_ts` (timestamp), `customer_id` (long), `product_id` (long), `region` (string with 8 values), `event_type` (string with about 30 values), and a payload. It receives a steady stream of events and holds two years of history.

The query mix has three families. Almost every query filters on a time range, usually the last day, week, or month. Customer support tools look up one customer's events, always with a time range. Product analysts aggregate by product and region over a month or quarter, often filtering on a handful of product IDs.

Start with partitioning. Time appears in nearly every query, so it belongs in the partition spec. The question is grain. If the table receives a few gigabytes per day, `days(event_ts)` produces partitions of several target-sized files each, which is right. Hourly partitions produce dozens of small files per day. Monthly partitions make the time filter coarser than the queries need. Daily wins.

Do not partition on `customer_id`. It has millions of values. Bucketing it is possible, but the customer lookups already arrive with a time filter, and file-level pruning inside each day will serve them well if the files are clustered. Do not partition on `region` either. Eight values times 730 days is 5,840 partitions, and many region-days end up small. Region is better used as a leading sort column, where its low cardinality costs nothing.

Next, decide the within-partition layout. Two column families matter: `customer_id` for support lookups and `product_id` for analysts. They are independent, so no single lexicographic sort serves both. That points to Z-order on `(customer_id, product_id)` for closed partitions.

For ingestion, keep it cheap. A local sort by `customer_id` within each task gives row-group-level clustering in new files with only a hash shuffle by partition.

Here is the full setup in Spark SQL with the Iceberg extensions.

```sql
CREATE TABLE lake.analytics.events (
  event_ts     TIMESTAMP,
  customer_id  BIGINT,
  product_id   BIGINT,
  region       STRING,
  event_type   STRING,
  payload      STRING
)
USING iceberg
PARTITIONED BY (days(event_ts))
TBLPROPERTIES (
  'write.target-file-size-bytes'                        = '536870912',
  'write.parquet.bloom-filter-enabled.column.customer_id' = 'true',
  'write.metadata.metrics.column.payload'               = 'none'
);

ALTER TABLE lake.analytics.events
  WRITE DISTRIBUTED BY PARTITION LOCALLY ORDERED BY customer_id;

CALL lake.system.rewrite_data_files(
  table      => 'analytics.events',
  strategy   => 'sort',
  sort_order => 'zorder(customer_id, product_id)',
  where      => 'event_ts >= TIMESTAMP "2026-10-18 00:00:00" AND event_ts < TIMESTAMP "2026-10-19 00:00:00"',
  options    => map(
    'rewrite-all',                         'true',
    'target-file-size-bytes',              '536870912',
    'partial-progress.enabled',            'true',
    'max-concurrent-file-group-rewrites',  '4'
  )
);
```

Walk through each statement.

The `CREATE TABLE` partitions by `days(event_ts)` with hidden partitioning, so queries filter on `event_ts` directly. The target file size of 512 MB keeps file counts low. The Bloom filter on `customer_id` lets readers skip row groups inside a file when a looked-up customer is absent. Setting metrics to `none` for `payload` stops Iceberg from storing bounds for a large text column that no query filters on, which keeps manifests smaller.

The `ALTER TABLE` sets the ingestion layout. Each day's rows go to one writer per partition and get sorted by `customer_id` within the task. This is cheap and gives every new file internal ordering, which tightens Parquet row group statistics right away.

The `CALL` is the nightly compaction for the previous day, scheduled after the partition stops receiving late data. `strategy => 'sort'` with a `zorder(...)` sort order tells the action to Z-order. The `where` clause limits the rewrite to one day's files. `rewrite-all` forces a rewrite of every file in scope, including files that are already the right size, because the goal here is layout, not just compaction. Partial progress lets the job commit in groups so a failure late in the job does not throw away all the work. The concurrency setting limits how many file groups rewrite at once to protect the cluster.

After the first compaction, run the measurement query on that partition for both `customer_id` and `product_id`. If both columns show median span fractions well below 1.0 and probe counts far below the file count, the Z-order is doing its job. If `product_id` stays near 1.0, check whether the column has enough distinct values per day to cluster on, and whether the leading bytes vary.

Where does `region` go? Analysts filter on it together with product. It has 8 values, so adding it to the Z-order wastes a third of the bits on a column that a cheap prefix handles better. An alternative design is a global sort by `(region, product_id)` instead of Z-order, if product analysis dominates the workload and customer lookups are rare. That is a real fork in the design, and the measurement query plus scan reports on the actual workload decide it.

## Failure Modes

Layout problems rarely announce themselves. Queries just get slower as the table grows. These are the common patterns and the signals that identify each one.

Over-partitioning shows up as many small files and long planning times. The signal is a `data_files` count that grows much faster than data volume, with median file sizes far below the target. The fix is partition evolution to a coarser grain, followed by compaction of recent partitions into the new spec.

Under-clustering shows up as files that cannot be skipped. The signal is a median span fraction near 1.0 on the columns queries filter by, and scan reports that show almost no skipped files. The fix is a sort order for ingestion and a sort or Z-order compaction for closed partitions.

A Z-order with too many columns shows up as moderate span fractions on every column and good pruning on none. The signal is a Z-order list of four or more columns and probe counts that are a large share of the file count on every column. The fix is to cut the list to the two or three columns that queries share and move the rest to a sort prefix, a partition, or a Bloom filter.

Prefix-heavy strings show up as a Z-order or sort that does nothing for a string column. The signal is a string column whose values share a long common prefix, such as URLs, paths, or prefixed IDs. The fix is to cluster on a derived column with the variable part, such as a host extracted from the URL or the numeric suffix of an ID, or to raise the bounds truncation length if the issue is the 16-character limit.

Layout decay shows up as performance that degrades between compactions. Every write after a compaction adds files in ingestion order. Merge-on-read deletes and updates add delete files and, in v3, deletion vectors, which leave the original file bounds in place even when the rows that set those bounds are deleted. The signal is a rising share of recently written files in the scan for typical queries. The fix is a compaction schedule that matches the write rate, and in tables with heavy updates, compaction that applies deletes as well as reorganizing.

Compaction that rewrites too much shows up as a large, recurring compute bill. A daily job that Z-orders the whole table rewrites data that has not changed. The signal is a rewrite job whose input bytes are much larger than the bytes written since the last run. The fix is the `where` filter on recent partitions, so each partition is reorganized once after it closes.

Mismatched engines show up as layout that only one engine maintains. Some writers ignore the table's sort order. If a second engine writes to the table without honoring it, its files arrive unsorted. The signal is a mix of tight and wide files in the same partition, correlated with the writer. The fix is to standardize writers, or rely on compaction to repair whatever the other writers produce.

## Operational Guidance

A few rules cover most tables.

Choose the partition from the filter that appears in nearly every query, usually time. Choose the grain so each partition holds several target-sized files. Prefer evolving the spec later over guessing too fine now.

Choose the sort from the most common non-partition filter. Put low-cardinality columns first only if they also appear in filters. Put the dominant high-cardinality column right after them.

Use Z-order when two or three independent filters each matter, none dominates, and the columns are numeric, temporal, or strings that vary early. Run it on closed partitions in compaction, not on the whole table.

Enable Bloom filters on high-cardinality columns used in equality lookups, especially when the layout cannot cluster on them.

Turn off metrics on wide columns that no query filters on, and raise truncation on string columns you depend on for pruning.

Measure before and after every change with the `data_files` query and the engine's scan reports. Keep the before numbers. Layout tuning without measurements turns into folklore quickly.

Schedule compaction by partition age, not by calendar alone. A partition that still receives late data is not ready for an expensive rewrite. A partition that closed yesterday is.

### A decision sequence

When a new table arrives, work through these questions in order. Each answer narrows the next.

Which filter appears in nearly every query? That column, usually a timestamp, becomes the partition source. If no filter is near-universal, leave the table unpartitioned or use a coarse bucket, and let sorting do the work.

What grain keeps each partition at several target-sized files? Estimate daily volume, divide by the target file size, and pick the transform that lands in that range. Revisit the choice after a month of real data, because partition evolution makes the change cheap.

Is there one dominant filter besides the partition column? If one column appears in most of the remaining queries, sort on it. A global sort at ingestion works when write volume allows a range shuffle. Otherwise sort locally at ingestion and globally in compaction.

Are there two or three independent filters with similar weight? Then Z-order those columns in compaction. Check that each one is numeric, temporal, or a string whose values differ in the first few bytes.

Are there high-cardinality equality lookups the layout cannot reach? Add Bloom filters on those columns.

Are there wide columns no query filters on? Turn their metrics off to keep manifests lean.

Then measure. If the numbers disagree with the design, the numbers win. Query mixes change, and the design that fit last year's dashboards does not always fit this year's agents and ad hoc users.

This sequence fits on one page, and it covers the large majority of event, log, and transaction tables. Tables with very different shapes, such as wide feature tables or slowly changing dimensions, still follow the same logic. Find the filters that matter, give the most important one the strongest mechanism, and measure what you get.

## Where Layout Is Heading in Iceberg

Several pieces of current spec work change how much layout matters and how engines reason about it.

The first is honesty about bounds. In the v4 design discussions this fall, the community settled on a file-level flag that tells readers whether a file's column bounds are tight. Bounds stop being tight for two reasons. Deletion vectors added after a file is written remove rows, so the original minimum and maximum no longer describe the live data. Variable-length columns such as strings carry truncated bounds by design. Under the agreed approach, new v4 files mark their bounds as tight when no deletion vector is attached, and files inside existing v3 manifests carry no flag, so readers treat their bounds as wide. For layout, the lesson is direct. Good clustering produces tight bounds, and v4 lets engines trust tight bounds for more than pruning, including answering some aggregates from metadata alone. Tables that keep their layout fresh through compaction get more out of that.

The second is secondary indexing. Iceberg's index work defines index files that the table manages alongside its data, with a design built so that a single-key lookup costs one small file read once index metadata is cached. Indexes do not replace layout. They cover the columns layout cannot cluster on. A table Z-ordered on two columns with an index on a third covers more query shapes than any layout alone.

The third is server-side planning. The REST catalog protocol now includes scan planning endpoints, so a catalog can evaluate predicates against manifests and return the file list to the engine. That moves pruning work out of each engine, but it does not change the math. A server prunes using the same bounds a client would. Layout still decides how many files survive.

The fourth is automation. Teams increasingly hand layout maintenance to services that watch query patterns and table health, then schedule sorting or clustering rewrites without a human choosing columns. Those services still choose among the same mechanisms described here, and they still trade clustering on one column against another. Knowing the mechanics lets you check whether an automated choice matches your workload, using the same `data_files` measurements.

The common thread is that Iceberg keeps getting better at using statistics, and statistics are only as good as the layout that produced them.

## Conclusion

Iceberg skips work at three levels: manifest summaries, per-file column bounds in manifests, and row group and page statistics inside Parquet. Layout decides how useful those statistics are. Narrow ranges per file mean files get skipped. Wide ranges mean every file gets read.

Partitioning gives the strongest skipping for the columns in the spec, at the cost of file count, and hidden partitioning plus partition evolution make it safe to choose and cheap to change. Sort orders give perfect clustering on the leading column and apply at write time in engines that honor them. Z-order gives moderate clustering on two or three columns at once, at the cost of a compaction rewrite, and it works best on numeric and temporal columns. Bloom filters cover high-cardinality equality lookups the layout cannot reach.

The right design combines them. Partition on the near-universal filter at a sensible grain. Sort cheaply at ingestion. Reorganize closed partitions with a global sort or a Z-order based on the actual query mix. Then measure with the `data_files` metadata table and the engine's scan reports, and let those numbers settle every argument about which layout wins. Re-run those measurements whenever the query mix shifts, because a layout tuned for last quarter's dashboards drifts out of fit as new consumers, including AI agents issuing exploratory queries, start filtering on different columns.

## Keep Going

If this piece was useful, I have written a lot more on running Iceberg tables well in production. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers partitioning, sort orders, compaction strategies, and the metadata structures behind every technique in this article. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
