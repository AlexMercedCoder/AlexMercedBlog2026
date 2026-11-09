---
title: "Iceberg v4's _last_updated_time Column: \"Rows Changed Since T\" Without Rewriting Manifests"
description: "Iceberg v4's _last_updated_time column records when each row last changed, inherited from the snapshot timestamp with no manifest rewrite."
date: 2026-11-09T09:00:00Z
tags: ["Apache Iceberg", "iceberg-v4", "row-lineage", "incremental-processing"]
canonical: https://datalakehousehub.com/blog/iceberg-v4-last-updated-time/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/iceberg-v4-last-updated-time/).

Iceberg v4 is voting on a `_last_updated_time` column that records when each row last changed. Steven Wu opened the vote on October 30, 2026, and it was still open on November 3 with eight +1 votes, three of them binding. The value is inherited from the snapshot's timestamp through an optional manifest field, so upgrading a table to v4 needs no manifest rewrite. Queries such as "rows modified since Tuesday" become direct filters.

That last sentence describes something data engineers have wanted for a long time. Today, finding the rows that changed in an Iceberg table since a point in time means translating the time into a snapshot ID, then reading the changes between that snapshot and now. It works, but it pushes snapshot bookkeeping onto every consumer. A downstream job needs to remember the last snapshot it processed. An analyst asking "what changed since the 9 a.m. load" needs to look up which snapshot that was.

`_last_updated_time` moves that bookkeeping into the table. Every row carries the commit time of the snapshot that last wrote it, as a timestamp you can filter on with ordinary SQL.

A status note before the details. This article describes the proposal as voted, including revisions made during review. If the vote passes, the final spec text can still change in an editing pass. Check the spec before you build on any field name below.

## Sequence Numbers Versus Wall-Clock Time

Iceberg v3 added row lineage, which gives every row two metadata columns.

`_row_id` is a stable identifier assigned when the row is first written. It survives updates and compaction, so a downstream system can track the same logical row across rewrites.

`_last_updated_sequence_number` records the data sequence number of the commit that last modified the row. Sequence numbers increase with every commit, so this column tells you the order of changes precisely.

Sequence numbers answer "which change came first." They do not answer "when." A sequence number of 48,212 means nothing to a person, and translating it to a time means looking up the snapshot that carried that sequence number and reading its timestamp.

That translation is exactly the friction `_last_updated_time` removes. The proposal adds a third lineage column holding the commit timestamp of the snapshot that last updated the row. It sits next to `_last_updated_sequence_number` and answers the question people actually ask.

The two columns serve different jobs, and v4 keeps both.

**Use the sequence number for correctness.** It is strictly ordered within the table and never ambiguous. An incremental pipeline that must process every change exactly once should track sequence numbers or snapshot IDs.

**Use the timestamp for convenience and human questions.** "What changed in the last hour" and "show me rows touched after the bad deploy" are time questions. A timestamp column makes them one filter.

## Why This Needed Monotonic Snapshot Timestamps First

A timestamp column is only useful if timestamps move forward. Before v4, they did not have to.

An Iceberg snapshot carries a `timestamp-ms` field set by the writer's clock at commit time. Different writers run on different machines with different clocks. If writer A's clock runs a few seconds fast and writer B commits right after A, B's snapshot can carry an earlier timestamp than A's even though it came later. Time travel then picks the wrong snapshot. Steven Wu made this point when proposing the fix: a query for "the table as of 3:00 PM" picks the wrong snapshot when clocks drift between writers.

The fix came first, in a separate vote that passed in early October with nine binding +1 votes. In v4, every new snapshot on a branch must carry a `timestamp-ms` strictly greater than its parent's. Root snapshots stay unconstrained, and v1 through v3 tables keep their current behavior.

The Java implementation enforces this with a simple rule, described in the reference PR as a Lamport-style clock: a new snapshot's timestamp is the larger of the current time and the parent's timestamp plus one millisecond. If a writer's clock is behind, the commit still succeeds, with a timestamp one millisecond after its parent.

That rule makes `_last_updated_time` coherent. Rows updated by later commits always carry later or equal timestamps. Without it, a row can appear to have been updated before a change that happened earlier, and "changed since T" queries miss rows or include the wrong ones.

## How the Value Is Stored: Inheritance, Not Rewrites

The clever part of the proposal is that it adds a per-row column without storing a value per row.

### The tracking field

The proposal adds an optional `snapshot_timestamp` tracking field to v4 manifest entries. During review, Steven renamed the fields so that both the row column and the tracking field use Iceberg's `timestamptz` type, making the commit time directly usable in SQL predicates and metadata tables. The snapshot's own `timestamp-ms` stays a long in milliseconds and is converted to microseconds when inherited.

### Why writers leave it null

A writer does not know a snapshot's final timestamp until the commit succeeds. If the commit fails and retries, the timestamp can change. So the PR's rule for writers is to leave the field null on entries they add or modify. The spec text in review states it plainly: the snapshot's `timestamp-ms` is not known until the snapshot is successfully committed and can change when a commit is retried.

Readers fill in the null. When a reader finds an ADDED or MODIFIED entry with a null commit timestamp, it inherits the timestamp from the snapshot that committed it. This mirrors how Iceberg already handles sequence numbers, which writers also leave for readers to inherit, because they are only final after commit.

### When the value gets persisted

Inherited values become persisted values the next time a manifest is rewritten. A draft of the rules in Steven's working PR spelled them out:

- An ADDED entry must have a null timestamp.
- An entry MODIFIED by column files must have a null timestamp, so modified rows inherit the new snapshot's time.
- Any other entry written to a new manifest must carry its inherited or persisted timestamp.

So the value starts implicit and becomes explicit as manifests get rewritten in normal maintenance. No special backfill job is involved.

### From file-level to row-level

The tracking field lives on the manifest entry, which describes a data file. The row column is per row. The two connect the same way `_last_updated_sequence_number` does. If a row's lineage value is null in the data file, it inherits the file's value. When a writer rewrites a file during compaction, it writes the row-level values explicitly, so rows that were not changed keep their original timestamps instead of picking up the compaction's commit time.

This is the property that makes the column trustworthy. Compaction moves rows into new files but does not change them, so their `_last_updated_time` stays put. Only a real update or insert moves a row's timestamp forward.

## Why Inherit Instead of Storing a Timestamp Per Row

The inheritance design looks indirect at first. A simpler approach writes the commit time into a column in every data file. Three reasons explain why the proposal does not.

**The commit time is unknown at write time.** Data files are written before the commit. The writer does not know the final snapshot timestamp until the catalog accepts the commit, and a retried commit gets a new timestamp. A value written into the data file at write time is a guess. Inheritance defers the value until it is known.

**Storing per-row values means rewriting on retry.** When data files carry the timestamp and the commit retries with a new time, every data file in the commit needs rewriting. For a large commit, that is a lot of wasted work. Inheritance makes retries free, the same way Iceberg's sequence number inheritance already does.

**Upgrades need a backfill.** A stored per-row column added in v4 starts empty for every existing file. Filling it means rewriting every data file in the table. Inheritance from the manifest level gives every file a value, either inherited or set at upgrade, without touching data.

The design pays for these benefits with complexity in readers and in compaction, which must persist inherited values correctly. That is the right trade. Reader complexity is written once per engine. Rewrite costs recur for every table forever.

## Upgrading Without Rewriting Manifests

Manifests written before v4 have no `snapshot_timestamp` field. The question during review was what `_last_updated_time` should be for rows in those files.

Two options were on the table. One left the value null, meaning "unknown," for every row written before the upgrade. The other assigned those rows the commit time of the snapshot that performed the upgrade. Review comments show the PR moved to the second option, described in the thread as "snapshot time at conversion."

The trade-off is easy to state. Null is honest, because the table genuinely does not know when those rows last changed. The upgrade time is practical, because every row then has a value and filters behave predictably, at the cost of telling a small lie: rows written months ago appear to have been updated at upgrade time.

Read the final spec text for the exact rule, and plan for its consequence. If old rows carry the upgrade time, a query for "rows changed since the day before the upgrade" returns the entire table. Any downstream job that starts using `_last_updated_time` should begin from a point after the upgrade.

The important part holds either way. Upgrading a large table to v4 does not require rewriting its manifests to add timestamps. The change is metadata-only, which matters for tables with millions of files.

## Compaction, Rewrites and What Resets the Timestamp

Every maintenance operation in Iceberg rewrites files. Knowing which ones move `_last_updated_time` is the difference between a useful column and a confusing one.

**Data compaction keeps timestamps.** `rewrite_data_files` combines small files into large ones. Rows do not change, so their lineage values, including `_last_updated_time`, carry over. The new files carry explicit per-row values.

**Manifest rewrites keep timestamps.** `rewrite_manifests` reorganizes manifest files. Entries carry their inherited or persisted timestamps forward, as the persistence rule requires.

**Updates and merges move timestamps.** An `UPDATE` or `MERGE INTO` that changes a row writes it with a null lineage value, so it inherits the new snapshot's time. That is the intended behavior.

**Deletes do not create a timestamp.** A deleted row is gone, so it has no `_last_updated_time` to read. If you need to find deletions by time, use a changelog read between snapshots, covered below.

**Column file updates move timestamps for modified rows.** v4 adds column files, which update specific columns of existing rows without rewriting whole data files. The draft rule requires entries modified by column files to carry a null timestamp, so those rows inherit the new commit time.

**Deletion vector changes deserve a check.** Review discussion touched on entries marked MODIFIED only because their deletion vector changed. The surviving rows in such a file did not change, so their timestamps should not move. The final spec text settles how the null is treated in that case.

## Query Patterns: Time Filter Versus Incremental Snapshot Read

Once engines support the column, two ways to find changed rows will coexist. They answer slightly different questions.

### Pattern one: time filter

The query engine reads `_last_updated_time` like any metadata column:

```sql
-- Rows inserted or updated since a point in time
SELECT order_id, status, amount, _last_updated_time
FROM prod.sales.orders
WHERE _last_updated_time >= TIMESTAMP '2026-11-03 09:00:00 UTC';

-- How many rows changed per hour today
SELECT date_trunc('hour', _last_updated_time) AS hour, COUNT(*) AS changed_rows
FROM prod.sales.orders
WHERE _last_updated_time >= TIMESTAMP '2026-11-03 00:00:00 UTC'
GROUP BY 1
ORDER BY 1;
```

This syntax shows how the column will be used once engines expose it. Metadata columns in Spark and Trino are selected by name, the way `_file` and `_pos` are today. Check your engine's v4 release notes for the exact name and support.

The first query returns current rows whose last write happened at or after 9 a.m. The second buckets today's changes by hour, which is a cheap way to see load patterns or spot a runaway job.

Performance depends on pruning. Because `_last_updated_time` derives from manifest-level commit timestamps, a planner can skip whole files whose entries were committed before the filter time. On an append-heavy table, that makes "changed since T" queries close to free.

### Pattern two: incremental snapshot read

The existing approach reads changes between two snapshots. In Spark, an incremental read covers appends between two snapshot IDs:

```python
changes = (
    spark.read.format("iceberg")
    .option("start-snapshot-id", "8913746512231940211")
    .option("end-snapshot-id", "5530021497810027734")
    .load("prod.sales.orders")
)
```

For updates and deletes, Iceberg's Spark procedure builds a changelog view:

```sql
CALL prod.system.create_changelog_view(
  table   => 'sales.orders',
  options => map('start-snapshot-id', '8913746512231940211',
                 'end-snapshot-id',   '5530021497810027734')
);
```

The changelog view returns each changed row with a change type such as INSERT, DELETE, UPDATE_BEFORE or UPDATE_AFTER. That makes it the right tool for change data capture (CDC), where downstream systems must apply inserts, updates and deletes in order.

### Choosing between them

| Question | Time filter on `_last_updated_time` | Incremental snapshot read |
|---|---|---|
| "What changed since 9 a.m.?" | One filter, no snapshot lookup | Needs the snapshot ID for 9 a.m. |
| Does it show deletes? | No, deleted rows are gone | Yes, in a changelog view |
| Does it show intermediate versions? | No, only the current row state | Yes, each change between snapshots |
| Exactly-once processing | Risky at boundaries | Safe with snapshot IDs or sequence numbers |
| Works after snapshot expiration | Yes, value lives with the row | No, needs the snapshots to exist |

The last row is easy to miss and important. Incremental reads depend on snapshots. Once `expire_snapshots` removes them, you cannot read changes across them. `_last_updated_time` lives with the row, so "rows changed since last month" still works after last month's snapshots are gone. For audit-style questions over long windows, that is a real advantage.

Use the time filter for analytics, monitoring and ad hoc investigation. Use snapshot-based reads for pipelines that must not miss or double-count a change.

## Use Cases That Get Simpler

A few everyday tasks change shape once the column exists.

**Incident investigation.** A bad deploy wrote wrong values for an hour. Today, finding the affected rows means listing snapshots in that window and diffing them. With the column, it is a filter on a time range, joined to whatever identifies the bad writer. The investigation starts in seconds.

**Freshness monitoring.** A data quality check that asks "has this table received updates in the last two hours" can read the maximum `_last_updated_time` instead of parsing the snapshot log. Because the value derives from manifest metadata, an engine with good pruning answers it from metadata alone.

**Long-window audits.** Compliance teams ask which records changed during a quarter. Snapshots from that quarter are often expired by the time the question arrives. The column survives expiration, so the answer is still available.

**Partial refreshes for reverse ETL.** Tools that push current table state to operational systems need only the rows that changed since their last push. The watermark pattern above handles that without snapshot bookkeeping.

**Debugging slowly changing data.** When a row looks wrong, `_last_updated_time` tells you which commit last touched it. Join that time against the `snapshots` metadata table to find the snapshot, its operation and its summary, and you know which job wrote the value.

Each of these was possible before with snapshot reads. The difference is effort. A time column turns multi-step snapshot archaeology into one filter, which means more people actually do these checks.

## Clock Caveats: Commit Time Is Not Event Time

The most common mistake with this column will be treating it as the time something happened in the world. It is not.

**It is commit time.** `_last_updated_time` records when the snapshot that wrote the row committed. A streaming job that buffers events for five minutes and commits produces rows stamped with the commit time, five minutes after the events. A nightly batch that loads yesterday's sales stamps every row with last night's commit time.

**It is the writer's clock, adjusted for monotonicity.** The Lamport-style rule keeps timestamps increasing along a branch. If a writer's clock runs fast, the table's timestamps run fast too, and later commits stay at least one millisecond after it. The values are ordered, but they are not guaranteed to match wall-clock time exactly.

**It is per branch.** The monotonic rule applies within a branch. Rows on a development branch and rows on main carry timestamps from their own branch histories. Comparing `_last_updated_time` across branches compares two different sequences.

If you need event time, store it as a real column written by the producer. Many tables already carry an `event_time` or `updated_at` column set by the source system. Keep it. The two columns answer different questions, and having both lets you measure ingestion lag directly as the gap between them. Use `_last_updated_time` to answer "when did this table learn about this row," which is the question data engineers actually ask during incidents and audits.

## Failure Modes and Warning Signs

A few problems are predictable.

**Treating the column as CDC.** A pipeline that copies "rows where `_last_updated_time` > last run" will miss deletes and will see only the final state of rows updated twice between runs. If downstream needs every change, use a changelog read.

**Boundary double-counting.** A job that filters `>= last_run_time` and records `now()` as its new watermark can miss commits that landed between its query and its watermark write, or reprocess rows at the boundary. Track the maximum `_last_updated_time` actually seen, not the job's own clock.

**Surprise after upgrade.** If old rows receive the upgrade commit time, the first "changed since" query after the upgrade returns everything. Warn downstream consumers before you upgrade a shared table.

**Engines that ignore inheritance.** A reader that does not implement inheritance correctly returns null or wrong timestamps. Validate on a test table: insert, update one row, compact, and confirm the updated row's timestamp moved while the others did not.

**Clock skew in long-lived writers.** Monotonicity hides a fast clock by making every later commit even later. If timestamps start running noticeably ahead of real time, look for a writer host with a bad clock and fix its time sync.

## A Validation Test for When Your Engine Ships Support

When v4 support lands in your engine, run this sequence on a scratch table before trusting the column:

1. Create a v4 table and insert 100 rows. Record the snapshot's `committed_at` from the `snapshots` metadata table. Every row's `_last_updated_time` should match it.
2. Wait a minute, then update 10 rows. Those 10 should carry the new snapshot's time. The other 90 should not change.
3. Run `rewrite_data_files` with `rewrite-all` enabled. Every row's timestamp should stay exactly as it was before compaction.
4. Run `rewrite_manifests`. Timestamps should again stay put.
5. Delete 5 of the updated rows. They should disappear, and the remaining rows should keep their timestamps.
6. Upgrade a separate v3 table to v4 and read `_last_updated_time` on pre-upgrade rows. Confirm the behavior matches the final spec text.

If any step fails, report it to the engine's issue tracker with the table metadata attached. Lineage bugs are subtle and worth catching before production depends on them.

## A Watermark Pattern for Analytics Consumers

Many consumers do not need exact CDC. A dashboard refresh, a reverse-ETL sync of current state or a feature table that only cares about the latest value of each row can use `_last_updated_time` as a watermark. The pattern is simple if you respect two rules: store the watermark from the data, and overlap the window slightly.

```sql
-- 1. Read the stored watermark for this consumer
--    (kept in a small control table you own)
SELECT last_seen FROM ops.consumer_watermarks WHERE consumer = 'crm_sync';

-- 2. Pull rows changed since then, with a small overlap
SELECT order_id, status, amount, _last_updated_time
FROM prod.sales.orders
WHERE _last_updated_time > TIMESTAMP '2026-11-03 09:00:00 UTC' - INTERVAL 5 MINUTES;

-- 3. After the downstream write succeeds, advance the watermark
--    to the max timestamp actually returned, not the job's clock
MERGE INTO ops.consumer_watermarks w
USING (SELECT 'crm_sync' AS consumer,
              TIMESTAMP '2026-11-03 10:14:07 UTC' AS new_last_seen) s
ON w.consumer = s.consumer
WHEN MATCHED THEN UPDATE SET last_seen = s.new_last_seen
WHEN NOT MATCHED THEN INSERT (consumer, last_seen) VALUES (s.consumer, s.new_last_seen);
```

Step one reads the consumer's last processed point. Step two pulls changed rows with a five-minute overlap, which protects against commits that landed with timestamps slightly behind the previous run's maximum. The overlap means some rows arrive twice, so the downstream write must be idempotent, keyed on `order_id`. Step three advances the watermark to the largest `_last_updated_time` actually returned in step two, which the job computes from the result set. Using the job's own clock instead risks skipping commits that were in flight when the job ran.

This pattern fits consumers that apply current state. It does not fit consumers that need deletes or every intermediate version. For those, keep using snapshot-based changelog reads.

## Questions Still Open in Review

The vote thread and PR review left a few items for the final editing pass. Daniel Weeks requested a type change during the vote, and Ryan Blue planned an editing pass before the result. Specific questions worth watching:

- The exact rule for rows written before the upgrade, and how readers distinguish them.
- How entries marked MODIFIED only for a deletion vector change treat a null timestamp.
- Final names and types for the tracking field and the row column, after the move to `timestamptz`.
- Whether metadata tables such as `files` and `entries` expose the persisted timestamp directly.

None of these change the core design. All of them affect code you write against the column, which is why waiting for the final text pays off.

## Where This Fits in v4

`_last_updated_time` is one of several v4 changes that move information into metadata where planners and users can reach it cheaply. Monotonic snapshot timestamps made time travel reliable. Content stats and stats-only fields made statistics typed and extensible. The `tight_stats` flag made exactness explicit. Default value expressions, also in a vote this week, let a column default be computed at write time.

The common theme is that v4 asks less of every consumer. Instead of each downstream job reconstructing when a row changed, the table records it once and every engine reads it the same way.

## Conclusion

The `_last_updated_time` proposal adds a row-level commit timestamp to Iceberg v4 without storing a timestamp per row. Writers leave a manifest field null, readers inherit the snapshot's timestamp, and values persist naturally as manifests get rewritten. Monotonic snapshot timestamps, already voted into v4, keep the values ordered. Upgrading needs no manifest rewrite.

Use the column for what it is good at: human questions about time, monitoring, audits over windows longer than snapshot retention, and fast "changed since" filters. Keep snapshot and sequence-number reads for pipelines that must see every change, including deletes. Remember that the value is commit time, not event time. And wait for the vote result and the final spec edit before you write code against the field names.

## Keep Going

If this piece was useful, I have written a lot more on Iceberg row lineage, time travel and incremental processing. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers snapshots, sequence numbers and change processing, which are the foundations this v4 column builds on. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
