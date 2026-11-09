---
title: "Iceberg v4 Stats-Only Fields: How Tables Store Statistics for Partition Expressions, and Why tight_stats Replaced tight_bounds"
description: "Iceberg v4 stats-only fields give derived values a field ID in content_stats, and the file-level tight_stats flag says when statistics are exact."
date: 2026-11-09T09:00:00Z
tags: ["Apache Iceberg", "iceberg-v4", "statistics", "query-planning"]
canonical: https://datalakehousehub.com/blog/iceberg-v4-stats-only-fields-tight-stats/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/iceberg-v4-stats-only-fields-tight-stats/).

The Iceberg v4 spec will let tables store statistics for values that are not table columns. A vote that passed on October 31, 2026 adds a `stats-fields` list. It assigns table field IDs to partition fields and to expressions such as `to_lower_case`, so their stats live in `content_stats` next to ordinary column stats. A separate vote that passed on October 27 replaced the per-column `tight_bounds` flag with a single file-level `tight_stats` flag that tells a reader when a file's stats are exact.

Both changes answer the same complaint. Iceberg's file-level statistics are the cheapest pruning tool a query planner has. A planner reads a manifest, sees that a file's `order_date` values run from March 1 to March 31, and skips the file for a query about April. No data file opens. But the statistics have always had two limits. They only describe real columns, and a reader can never be sure they are exact. A query filtering on `lower(email)` gets no help from bounds on `email`. A query asking for `count(*)` where `status IS NULL` can't trust the null counts enough to answer from metadata alone.

v4 fixes both limits with two small, precise spec changes. This article walks through the mechanism behind each: how a stats-only field gets an ID, where its stats live, what `tight_stats` promises, and what a manifest entry looks like before and after.

One caution up front. Both votes passed, but the stats-only fields vote closed with a note from Ryan Blue that the spec text still needs editing. Field names in the examples below follow the PR text as voted. Check the final spec before you write code against them.

## What v3 Column Metrics Left Out

Iceberg v1 through v3 store file statistics as a set of maps in each manifest entry. `lower_bounds` and `upper_bounds` map a field ID to a serialized bound. `null_value_counts`, `nan_value_counts` and `value_counts` map a field ID to a count. A reader looks up the field ID of the column in the filter and compares.

That design has three gaps that matter for pruning.

**Only schema fields get stats.** The maps are keyed by field ID, and only schema columns have field IDs. If you partition by `bucket(16, customer_id)`, the partition tuple records the bucket for each file, but there is no stats slot for a derived value that is not a partition field. If your queries filter on `lower(email)`, the only stats available are bounds on raw `email`, which do not translate to bounds on the lowercased value without care.

**The values are untyped bytes.** Bounds are stored as binary blobs that a reader decodes using the column's type. That works, but it means the stats structure itself does not carry types, and every reader carries decoding logic.

**Nothing says whether stats are exact.** A writer can truncate string bounds to save space. A row-level delete can remove the row that held the minimum, leaving the recorded lower bound lower than any live value. The bounds stay correct as bounds, since every live value still falls inside them, but they are no longer the true minimum and maximum. A planner can use them to skip files. It cannot use them to answer `MIN(order_date)` without reading data.

v4 started fixing the second gap first. Its new `content_stats` struct stores statistics as typed fields grouped by table field. The spec's v4 section describes the layout: each field's stats struct gets a block of 200 IDs starting at `10_000 + 200 * field-id`, and IDs from 10,000 up to 200,000,000 are reserved for column stats structs in `content_stats`. Every field-level struct is optional.

With typed, ID-addressed stats in place, the two remaining gaps become specific questions. How does something that is not a column get an ID? And how does a writer promise that its stats are exact? Stats-only fields answer the first. `tight_stats` answers the second.

## Stats-Only Fields: Giving Derived Values an ID

### The idea

Ryan Blue opened the discussion on October 22 and called the vote on October 27. Earlier drafts used the name "non-materialized columns." In his opening mail, Ryan explained the rename: "stats-only fields" says what the feature does, while the old name described what it is not.

The PR, apache/iceberg#18405, describes a stats-only field as a way to track stats for a derived value that is not part of the table schema and is not materialized. No data file stores the value. Writers compute it while writing, record its statistics, and discard it. Readers use the statistics for pruning.

### The two types

The PR defines two kinds of stats-only field.

**`partition-value`** stores stats for the output of a partition field. It identifies the partition field with a `partition-field-id`, and its result type comes from that partition field. The PR text gives a concrete use: filtering by bucket partition values in v4.

**`expr-value`** stores stats for the result of a value expression, as defined in Iceberg's expressions spec, held in an `expr` field. This is the general case. `to_lower_case(email)`, a date truncation, or any other value expression the spec can express gets a stats slot.

Each stats-only field also stores its current result type in `data-type`, so a reader knows how to interpret the typed stats without re-deriving the type.

### Where the ID comes from

The key move is that a stats-only field receives a field ID from the same ID space as table columns. That ID then maps into `content_stats` with the same arithmetic as any column: a 200-ID block starting at `10_000 + 200 * field-id`.

This is why the design is small. Readers already know how to find a column's stats in `content_stats` by ID. A stats-only field is just another ID. The reader looks up the stats-only field's definition in table metadata, sees that field 2001 is `to_lower_case(email)`, and reads the stats block for 2001 the same way it reads one for a column.

It also explains why ID unification work matters. An earlier v4 statistics discussion noted that stats are calculated for assigned field IDs in the table ID space and in the reserved ID space, with a separate proposal to unify ID spaces. Stats-only fields depend on that: a derived value and a column cannot share an ID.

### Writer rules

The PR sets rules for writers that keep the feature safe for readers.

Writers **must preserve** existing stats for stats-only fields listed in table metadata. A writer that does not understand an expression cannot drop stats that another writer produced when it rewrites manifests.

Writers **should produce** stats when possible. They are encouraged, not required, to compute stats for every stats-only field.

A writer **should produce no stats**, by setting the field's stats struct to null, when it does not support the expression, when the expression produces a different output type when bound, or when binding fails. A null stats struct tells readers "no information," which is always safe. A wrong stat is never safe.

During the discussion, Ryan left the handling of unbindable expressions to implementations rather than adding a strict "must ignore" rule, arguing that such a rule hides real errors. That is a deliberate choice. A writer that silently ignores a stats-only field it cannot bind will never tell anyone the field is broken.

### What the vote decided, and what it did not

The vote closed on October 31 with 15 +1 votes and no objections. The decision covers the metadata structure and writer obligations. Two adjacent questions stayed out of scope.

Collations came up in the thread. Ordering strings under a locale-aware collation is a natural use for a derived stats value. Ryan's preference was a new type with standardized collation metadata rather than overloading stats-only fields with collation expressions.

Generated columns also came up. Ryan considered unifying stats-only fields with generated columns, such as default value expressions, and decided against it, for the same reason the community kept expressions inside check constraints. Splitting an expression from a column that depends on it adds indirection without benefit.

## tight_stats: When a Reader Can Trust Stats Exactly

### The old design

Before October 27, the v4 draft placed a `tight_bounds` field inside each column's stats struct. Each column declared "my bounds are exact" on its own.

Anoop Johnson's spec PR, apache/iceberg#18585, replaced that with one `tight_stats` flag on the tracked file. The PR description is short: track stats tightness with a single file-level flag on the tracked file instead of a per-column field. The vote passed on October 27 with nine binding +1 votes and no objections.

### What "tight" means

The spec text went through several review rounds, visible in the PR's review comments. The direction stayed the same. Statistics are tight when the bounds and the null and NaN counts are exact for the live rows of a file.

Three details from the review are worth knowing.

**Live rows only.** Tightness is defined against the rows still live in the file, after deletion vectors are applied. A file whose minimum value was deleted still has tight stats only if the writer recomputed the bounds. One review comment captured the rule directly: a deletion vector does not by itself make a file's stats non-tight, because `tight_stats` is the only indicator of tightness.

**Strings and binary are never tight.** Writers truncate string and binary bounds to keep manifests small, so those bounds are never exact. A reader must not treat them as tight even when the flag is set.

**Absence means not tight.** When `tight_stats` is missing, readers must assume the stats are not tight. That makes the flag safe to add to an existing format. Old writers never set it, so their files are treated conservatively.

Review comments also discussed `value_count` and `total_bytes`. One revision stated that neither is part of tightness, because `value_count` counts values across all rows written and is not adjusted when rows are deleted, and `total_bytes` is an estimate. Another discussed whether variant bounds count as exact. Read the final spec text for these edge cases rather than relying on a single draft.

### Why one flag beats one per column

The per-column design looked more flexible. In practice, it did not match how writers produce stats.

A writer computes stats for a file in one pass. Either it tracked exact values for the live rows, or it did not. Mixed tightness within a file is rare and usually a sign of a bug. One flag matches the real process.

The single flag also covers more than bounds. The coverage of the old `tight_bounds` field, as its name suggests, was bounds. `tight_stats` covers bounds plus null and NaN counts. That broader promise is what lets a planner answer more questions from metadata.

And one flag is cheaper. A per-column boolean in every column stats struct adds up across wide tables with thousands of files per manifest. One field per file costs almost nothing.

### What a planner gets from tight stats

The difference between tight and non-tight stats is the difference between pruning and answering.

With non-tight stats, a planner prunes. If a filter asks for `amount > 1000` and a file's upper bound is 900, skip the file. That works whether or not the bound is exact, because every live value is still at or below the recorded upper bound.

With tight stats, a planner also answers. `SELECT MIN(amount)` can come from the smallest lower bound across files, with no data read. `SELECT COUNT(*) WHERE amount IS NULL` can come from summing null counts across files. Dashboards that show "latest event time" or "rows missing a value" turn into metadata reads.

Tight stats also matter for constraints. The v4 table constraint spec, voted the same day, adds unique and primary key constraints that most engines will start out not enforcing. Validating a key cheaply depends on exact bounds and counts. With tight stats, a validator can rule out overlap between files from metadata and only open files whose key ranges intersect.

## Stats-Only Fields and tight_stats Together

The two changes compose. A stats-only field gets a stats struct in `content_stats`. The file's `tight_stats` flag then governs that struct exactly as it governs column stats.

Consider a table of user events where queries filter on a normalized email. With a stats-only field for `to_lower_case(email)` and tight stats, a planner can prune files for `WHERE lower(email) = 'pat@example.com'` using the derived bounds. One caveat applies, and the spec is explicit about it: string bounds are never tight because they are truncated. The derived string bounds still prune, but they do not answer `MIN(lower(email))` from metadata.

For a numeric derived value, such as `bucket(16, customer_id)` tracked as a `partition-value` field, tight stats are realistic. A planner filtering on a bucket gets exact bounds on bucket values for each file, which is the case the PR text names directly.

## A Worked Manifest Entry, Before and After

The following is illustrative. It shows the shape of the data rather than the exact serialized form. Field names follow the PR text and the v4 content stats layout. The per-stat offsets inside each 200-ID block changed during review, so this example labels stats by name rather than by offset.

Start with a table whose schema has two columns:

- field 1: `event_time` (timestamp)
- field 2: `email` (string)

The table is partitioned by `bucket(16, email)`, and queries filter on `lower(email)`. A v4 table adds two stats-only fields:

```json
{
  "format-version": 4,
  "stats-fields": [
    {
      "field-id": 2000,
      "type": "partition-value",
      "partition-field-id": 1000,
      "data-type": "int"
    },
    {
      "field-id": 2001,
      "type": "expr-value",
      "expr": {
        "type": "apply",
        "function": "to_lower_case",
        "args": [ { "type": "reference", "field-id": 2 } ]
      },
      "data-type": "string"
    }
  ]
}
```

The first entry says field 2000 tracks the output of the partition field with ID 1000, the bucket, as an integer. The second says field 2001 tracks the result of applying `to_lower_case` to field 2, typed as a string. The expression JSON here is a sketch of a value expression, not the exact serialized grammar, which lives in Iceberg's expressions spec.

Now the stats block addresses. Each field's stats struct starts at `10_000 + 200 * field-id`:

| Field | Meaning | Stats struct ID |
|---|---|---|
| 1 | `event_time` column | 10,200 |
| 2 | `email` column | 10,400 |
| 2000 | bucket partition value | 410,000 |
| 2001 | `to_lower_case(email)` | 410,200 |

The stats-only field IDs here are arbitrary picks from the table's ID space for illustration. They only need to be unique and to fall where the stats block lands inside the reserved range, which runs up to field IDs just under one million.

A v3-style manifest entry for one data file looks like this in spirit:

```json
{
  "data_file": {
    "file_path": "s3://lake/events/data/00042.parquet",
    "record_count": 1200000,
    "lower_bounds": { "1": "<2026-10-01T00:00:00>", "2": "<Aaron@...>" },
    "upper_bounds": { "1": "<2026-10-31T23:59:59>", "2": "<zoe@...>" },
    "null_value_counts": { "1": 0, "2": 1840 }
  }
}
```

Two things are missing. There is no slot for the lowercased email, so a filter on `lower(email)` cannot prune with these bounds without extra reasoning. And there is no way to know whether `event_time` bounds are exact.

The v4 entry for the same file:

```json
{
  "tracked_file": {
    "location": "s3://lake/events/data/00042.parquet",
    "record_count": 1200000,
    "tight_stats": true,
    "content_stats": {
      "10200": { "lower_bound": "2026-10-01T00:00:00", "upper_bound": "2026-10-31T23:59:59",
                 "null_value_count": 0 },
      "10400": { "lower_bound": "Aaron@", "upper_bound": "zoe@",
                 "null_value_count": 1840 },
      "410000": { "lower_bound": 7, "upper_bound": 7, "null_value_count": 0 },
      "410200": { "lower_bound": "aaron@", "upper_bound": "zoe@",
                  "null_value_count": 1840 }
    }
  }
}
```

Read it top to bottom. `tight_stats: true` says the bounds and null counts are exact for live rows, with the standing exception that string bounds are truncated and never tight. That makes the `event_time` bounds exact, so `MIN(event_time)` over this file is October 1 at midnight without reading data. The bucket stats show this file holds only bucket 7, which is what you expect when a writer clusters by partition. The `to_lower_case(email)` stats give a planner real bounds for lowercased filters. Notice the lower bound changed from `Aaron@` to `aaron@`, which is the whole point. A query for `lower(email) = 'aaron@example.com'` keeps this file, and a query for a value outside `aaron@` to `zoe@` skips it.

## What Engines Must Implement, and How to Tell When They Have

The spec changes create work for three groups.

**Writers** have to compute derived values while writing, record their stats in the right `content_stats` slots, set `tight_stats` only when stats are exact for live rows, and preserve stats-only field stats they do not understand when rewriting manifests. Writers that cannot bind an expression should write a null stats struct.

**Planners** have to read `stats-fields` from table metadata, bind filter expressions to matching stats-only fields, and use `tight_stats` to decide between pruning and answering. Binding is the interesting part. A planner sees `WHERE lower(email) = ...` in a query and has to recognize it as the same expression a stats-only field tracks. Expression matching across SQL dialects and Iceberg's expression spec is where engines will differ.

**Maintenance jobs** such as compaction have to recompute stats for stats-only fields when they rewrite files, and set `tight_stats` correctly on the new files. Compaction is also the natural place to restore tightness. A file whose minimum row was deleted loses exactness. Rewriting it with fresh stats restores it.

How to tell when your engine supports all this:

- Check the engine's release notes for v4 table support, then specifically for `content_stats`, `tight_stats` and stats-only fields. These will land at different times.
- Inspect manifests directly. PyIceberg and the Java API expose manifest entries. Once v4 writers ship, look for `tight_stats` on new files and populated stats blocks for your stats-only field IDs.
- Run an `EXPLAIN` on a query filtering by the derived expression and compare files scanned with and without the stats-only field defined.
- For metadata-only aggregates, compare a `MIN` or `COUNT ... IS NULL` query's plan before and after compaction on a table with tight stats. An engine that uses tight stats skips the data scan.

The Java reference implementation is already moving. Anoop opened a companion PR on October 21, apache/iceberg#18598, that implements the file-level flag in the API and core, adding a `tightStats()` method on `ContentFile` that returns null when tightness is unknown. A review on the spec PR also noted that the current v4 Parquet path omits list-element and map key or value fields from `content_stats`, which is the kind of gap these implementation PRs exist to close.

## Failure Modes to Watch For

New statistics create new ways to be wrong. Four are worth planning for.

**A writer sets `tight_stats` after a delete without recomputing.** The rule is clear in the spec text, but bugs happen. If a writer copies stats forward after applying a deletion vector and marks them tight, metadata-only answers become wrong. Test this case explicitly: delete the row holding a file's minimum, then run `MIN` and compare against a full scan.

**Expression binding differs between writers and readers.** A writer that binds `to_lower_case` with one Unicode rule and a reader that evaluates `lower()` with another produce mismatched bounds. For pruning, a mismatch is only harmful if it makes a reader skip a file it needed. Treat locale-sensitive string transforms with suspicion until engines document their behavior, which is also why collation got its own track in the discussion.

**A maintenance job drops unknown stats.** An older tool rewriting manifests without understanding stats-only fields can drop their stats. The "must preserve" rule exists for this. Until every tool in your stack supports v4, run maintenance with the newest engine you have.

**Tables grow too many stats-only fields.** Every stats-only field adds a stats struct per file in every manifest. Ten derived fields on a table with a million files is ten million extra structs. Add stats-only fields for expressions your queries filter on often, not for every expression someone has ever written.

## Choosing Stats-Only Fields for Your Tables

Once engines support stats-only fields, the question becomes which ones to define. The feature costs manifest space and writer CPU, so pick deliberately.

**Start from the query log, not the schema.** Pull the most frequent filter predicates from your engine's query history. Look for predicates that wrap a column in a function: `lower(email)`, `date_trunc('day', event_time)`, `substr(sku, 1, 3)`, `json_extract(payload, '$.region')`. Each one is a candidate. A predicate on a plain column already has column stats and gains nothing.

**Prefer expressions with low output cardinality per file.** Stats help when a file's derived values cluster into a narrow range. A date truncation on a table written in time order produces tight, narrow bounds per file and prunes well. A hash of a random ID produces bounds that span the whole range in every file and prunes nothing.

**Pair stats-only fields with clustering.** Bounds only prune when similar values live in the same files. If queries filter on `lower(email)`, sort or cluster the table on `email` during compaction. The lowercased bounds then narrow along with the raw ones.

**Favor numeric and date outputs where you have a choice.** String bounds are truncated and never tight. A numeric derived value, such as a bucket number or an extracted year, gets exact bounds when `tight_stats` is set, which opens metadata-only answers as well as pruning.

**Watch manifest size after you add fields.** Measure the average manifest size before and after. Every stats-only field adds a typed stats struct to every file entry. If planning time rises after you add fields, the manifests grew faster than pruning improved, and you should drop the least used ones.

**Document each field's purpose.** A stats-only field is invisible to anyone reading the schema. Record why it exists and which queries it serves, in a table property or your data catalog. The next engineer who sees field 2001 in a manifest will need that note.

## Where v4 Statistics Are Heading

These two votes fit a larger pattern on the Iceberg dev list this fall. v4 is turning statistics from a best-effort hint into a declared contract. `content_stats` gave stats types. Stats-only fields gave derived values identities. `tight_stats` gave exactness a single, checkable signal. Table constraints, voted the same week as `tight_stats`, give keys a declared meaning that tight stats help validate.

The next steps are already visible. Collation-aware ordering for strings is on the table as its own type. Implementation PRs in the Java reference library are adding the flag and the content stats changes. And other v4 proposals, such as a `_last_updated_time` column and default value expressions, add more metadata that planners can reason about without reading data.

The direction is consistent: put more truth in metadata, mark clearly how much of it is exact, and let planners do more work before they open a file.

## Conclusion

Two small votes in one week changed what Iceberg statistics can say. Stats-only fields give derived values, from bucket partition outputs to lowercased strings, a field ID and a stats slot in `content_stats`, so planners can prune on the expressions people filter by. The file-level `tight_stats` flag tells readers when bounds and null counts are exact for live rows, which lets planners answer some aggregates from metadata and gives constraint validators the exact ranges they need.

Neither change is visible to a user writing SQL. Both show up as fewer files scanned and faster answers once engines implement them. Watch the final spec text for the remaining edits, watch your engine's release notes for v4 stats support, and test tightness after deletes before you trust a metadata-only answer.

## Keep Going

If this piece was useful, I have written a lot more on Iceberg's metadata and how planners use it. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers manifests, file statistics and the planning process that these v4 changes build on. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
