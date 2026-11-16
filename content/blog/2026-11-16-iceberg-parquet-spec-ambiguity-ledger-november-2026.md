---
title: "The Iceberg and Parquet Spec Ambiguity Ledger, November 2026: Name Mapping, Nanosecond Buckets, FILE Inline vs URI and distinct_count"
description: "Four Iceberg and Parquet spec ambiguities from November 2026, what each implementation does, the proposed fix, and how to test your own readers."
date: 2026-11-16T09:00:00Z
tags: ["Apache Iceberg", "Apache Parquet", "Specification", "Interoperability", "Data Engineering"]
canonical: https://iceberglakehouse.com/posts/iceberg-parquet-spec-ambiguity-ledger-november-2026/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/iceberg-parquet-spec-ambiguity-ledger-november-2026/).

Iceberg and Parquet implementations still disagree in places where the spec text allows two readings. In November 2026 the open cases include name mapping for Parquet files with only some field IDs, bucket rounding for negative nanosecond timestamps, FILE values that set both inline bytes and a URI, and whether distinct_count is exact.

Each of those cases produces the same symptom: one table, two engines, two answers. Nobody wrote a bug in the usual sense. Each implementation follows a sentence in the spec. The sentence just supports more than one reading, and different teams picked different ones.

This ledger tracks those cases. For each one, it records the spec text, what each implementation does today according to the dev list, the proposed fix, and a way to test your own stack. I will update it monthly and move settled cases to a "resolved" list at the bottom. The pages that explain how these mechanisms are meant to work already exist on this site, including [Iceberg Column Mapping](https://iceberglakehouse.com/iceberg/iceberg-column-mapping/) and [Apache Iceberg Schema Evolution](https://iceberglakehouse.com/apache-iceberg-schema-evolution/). This page records where implementations disagree today.

## Why spec ambiguity produces silent wrong answers

A table format exists so that many engines can read the same files and agree on the result. That promise rests on the spec. Each implementation reads the spec, writes code, and trusts that the other implementations read it the same way.

When the spec is precise, independent implementations converge. When a sentence is loose, each team fills the gap with the reading that seems natural to them. Those readings often stay hidden for years, because most tables never hit the edge case. Then a table built by one tool gets read by another, and the gap shows up as data.

The failures in this ledger share three traits that make them dangerous:

- **They are silent.** No reader raises an error. Each returns results that look valid.
- **They are data-dependent.** The difference appears only for specific files, values, or write patterns, so a smoke test passes.
- **They are spec-compliant.** Every implementation can point to text that supports its behavior, so bug reports stall on "this matches the spec."

The fix is always the same in shape. The community picks one reading, writes it into the spec in plain terms, adds a test value or fixture that catches the other readings, and the implementations that disagree ship a fix. The [iceberg-verification](https://github.com/apache/iceberg-verification) repository and the Parquet testing fixtures make the last step objective. A reference file with an expected result turns an argument into a test.

## The ledger at a glance

| Case | Spec | What diverges | Proposed resolution | Status, Nov 16, 2026 |
| --- | --- | --- | --- | --- |
| Name mapping with partial field IDs | Iceberg, Column Projection | Four readers resolve the same file four ways | Per-field: embedded ID wins, mapping fills the gaps | Consensus forming, spec PR requested |
| Bucket hashing of negative nanosecond timestamps | Iceberg, Appendix B | Floor vs truncate when converting to microseconds | Floor division, plus a pre-epoch test value | PR #18874 open |
| FILE value with both inline bytes and a URI | Parquet, FILE logical type | Inline bytes vs current object at URI | "Inline wins" proposal vs "error state" view | Under discussion, draft PR #635 |
| `distinct_count` exactness | Parquet, statistics | Readers treat it as exact or as an estimate | New `estimated_distinct_count` field | Proposal narrowed to a new field |

The sections below give the full record for each case.

## Case 1: Name mapping for Parquet files that carry only some field IDs

### The spec text

Iceberg identifies columns by field ID, not by name. Each column in a table schema has an integer ID, and data files written by Iceberg store that ID alongside each column. Renames are safe because readers match on the ID.

Files written by other tools often carry no IDs. That happens when you register existing Parquet files into an Iceberg table or convert a table from another format. For those files, Iceberg uses a name mapping, stored in the table property `schema.name-mapping.default`, which maps column names to field IDs. The mapping is covered in [Default Column Values and Field IDs](https://iceberglakehouse.com/posts/iceberg-default-values-and-field-ids/).

The Column Projection section of the spec has two sentences that describe the mapping. Sylwester Lachiewicz quoted both in his November 3 thread ([thread](https://lists.apache.org/thread/tct2yp45ytsb6dqw1tq7b8gnfnp7jndo)). The first says a reader should "use schema.name-mapping.default metadata to map field id to columns without field id." That reads as a per-column rule. The next paragraph says the mappings "provide fallback field ids to be used when a data file does not contain field id information." That reads as a per-file rule.

For a file with no IDs at all, both readings give the same answer. They diverge when some fields carry an ID and others do not.

### What each implementation does

Sylwester checked the main branches of four implementations and found four behaviors:

- **Java** (`ReadConf`, `ParquetSchemaUtil.HasIds`): if any field in the file has an ID, the whole file resolves by ID only, and the name mapping is not consulted.
- **PyIceberg** (`pyarrow_to_schema`, `_HasIds`): IDs are used only if every field has one, including list elements and map keys and values. Otherwise, the whole file resolves through the name mapping.
- **iceberg-rust** (`arrow/reader/pipeline.rs`): the first top-level column decides. If it has an ID, the file resolves by ID only.
- **iceberg-go** (`pruneParquetSchema.fieldID`): resolution is per field. An embedded ID wins, and the mapping fills in fields without one.

### Where this happens in real tables

This is not a theoretical case. Sylwester pointed to Delta Lake tables that use column mapping and were written without IcebergCompatV2. Those files store IDs for top-level columns but none for map keys and values or list elements. When such a table gets Iceberg metadata through a conversion tool, the files land in an Iceberg table with partial IDs.

With a map column in that table, PyIceberg sees missing IDs on the map key and value, falls back to the name mapping for the whole file, and reads the map. Java sees IDs on the top-level fields, resolves by ID only, and does not find the map's key and value. The same table returns different results depending on which library reads it.

### The proposed resolution

Sylwester proposed the per-field reading, which matches the Column Projection sentence. A field with an embedded ID resolves by that ID. A field without one falls back to the name mapping. This never overrides an ID that a writer recorded. It changes nothing for files with full IDs or no IDs. It makes the partial case readable.

On November 11, Manu Zhang replied that he is working on the same inconsistency in iceberg-cpp (PRs #1108 and #1109), called the proposal reasonable, and noted it aligns with how the Java Avro reader already works, while Java's ORC reader follows the Parquet rule ([reply](https://lists.apache.org/thread/vbq01jtsfgg2zfomsryvj2xpzlfv2gf3)). He asked for a spec PR. The thread continued through November 15.

### How to test your stack

Build a file with IDs on top-level fields only and read it with each library you use. PyArrow writes Parquet field IDs from field metadata, so you can create the partial case directly:

```python
import pyarrow as pa
import pyarrow.parquet as pq

# Top-level fields carry IDs. The map's key and value do not.
schema = pa.schema([
    pa.field("id", pa.int64(), metadata={b"PARQUET:field_id": b"1"}),
    pa.field(
        "attrs",
        pa.map_(pa.string(), pa.string()),
        metadata={b"PARQUET:field_id": b"2"},
    ),
])

table = pa.table(
    {"id": [1, 2], "attrs": [[("color", "red")], [("size", "L")]]},
    schema=schema,
)
pq.write_table(table, "partial_ids.parquet")
```

The `PARQUET:field_id` metadata key tells PyArrow to write a field ID into the Parquet schema for that field. The map type creates nested key and value fields with no metadata, so they get no IDs. Register this file into an Iceberg table whose schema assigns IDs to the map key and value, set a name mapping that covers them, and read the `attrs` column from each engine. If one returns the map and another returns nulls or fails, you have reproduced the case.

## Case 2: Bucket hashing of negative nanosecond timestamps

### The spec text

Iceberg's bucket partition transform hashes a value and takes the result modulo the number of buckets. Appendix B of the spec defines how each type is hashed. For timestamps, the value is hashed as a long count of microseconds since the epoch. Iceberg v3 added `timestamp_ns` and `timestamptz_ns`. Appendix B says nanosecond timestamps must be converted to microseconds before hashing, so a nanosecond timestamp and a microsecond timestamp for the same instant land in the same bucket.

The text does not say how to round when converting. For positive values, dividing by 1,000 gives the same answer whether you round toward zero or toward negative infinity. For negative values, meaning instants before 1970, the two methods differ.

Take the instant `1969-12-31T23:59:59.999999999`. That is -1 nanosecond. Floor division by 1,000 gives -1 microsecond. Truncation toward zero gives 0 microseconds. Those hash to different values and land in different buckets.

### What each implementation does

Roman Denysov raised the gap on November 6, 2026. On November 9, Jean-Baptiste Onofré checked the Java side ([reply](https://lists.apache.org/thread/v3cml24djnp17tszczmdj7nqfoj3byl5)). `DateTimeUtil.nanosToMicros` has used `Math.floorDiv` since the nanosecond types were first added, and the bucket transform hashes that result. He stated that Java, Go, and Rust (after a recent fix) all agree on floor division, which makes this a clarification of existing behavior rather than a format change.

He also recomputed the example from the thread. Hashing -1 microsecond gives bucket 12 out of 100. Hashing 0 microseconds gives bucket 76. I reproduced both numbers with an independent Murmur3 implementation:

```python
import struct
import mmh3  # pip install mmh3

def iceberg_hash_long(v: int) -> int:
    # Iceberg hashes a long as 8 little-endian bytes with 32-bit Murmur3.
    return mmh3.hash(struct.pack("<q", v))

def iceberg_bucket(v: int, n: int) -> int:
    # Clear the sign bit, then take the remainder.
    return (iceberg_hash_long(v) & 0x7FFFFFFF) % n

ns = -1  # 1969-12-31T23:59:59.999999999

floor_us = ns // 1000          # -1, rounds toward negative infinity
trunc_us = int(ns / 1000)      # 0, rounds toward zero

print(iceberg_hash_long(floor_us), iceberg_bucket(floor_us, 100))  # 1651860712 12
print(iceberg_hash_long(trunc_us), iceberg_bucket(trunc_us, 100))  # 1669671676 76
```

The helper packs the long as eight little-endian bytes and hashes it with 32-bit Murmur3, which is how Iceberg hashes longs. The bucket function clears the sign bit and takes the remainder, matching the spec. Python's `//` operator floors, and `int(a / b)` truncates, so the two lines show the two readings side by side.

### The proposed resolution

Roman opened [PR #18874](https://github.com/apache/iceberg/pull/18874) on November 10 and a companion PR in the verification repository. JB suggested two changes in review. First, put the rounding rule directly in the note on nanosecond conversion: divide by 1,000 and round toward negative infinity. Second, add a pre-epoch test value to the `timestamp_ns` and `timestamptz_ns` rows of the hash table. The value `1969-12-31T23:59:59.999999999` must hash to `1651860712`. An implementation that truncates gets `1669671676` instead, so the spec's own test table catches the bug.

That second suggestion is the pattern I want to see in every resolution. A rule in prose is good. A test value in the spec that fails the wrong reading is better.

### Who is exposed

You are exposed if you bucket-partition on a nanosecond timestamp column and hold data from before 1970. Most event data starts well after 1970, so most tables never hit this. Historical, scientific, and financial reference data are the likely exceptions. The effect of a mismatch is partition pruning that skips the bucket holding the row, so a filtered query misses data that a full scan finds. Join strategies that rely on matching buckets across tables, covered in [Storage-Partitioned Joins and the Bucket Transform](https://iceberglakehouse.com/posts/storage-partitioned-joins-and-the-bucket-transform/), break the same way.

## Case 3: The Parquet FILE type with both inline bytes and a URI

### The spec text

Parquet added a FILE logical type for storing file-like content, such as images or documents, in a table. Iceberg's v4 work builds on it for multimodal tables, covered in [What Iceberg v4's Proposed FILE Type Means for Multimodal Tables](https://iceberglakehouse.com/posts/iceberg-v4-file-type-multimodal-tables/). A FILE value can hold the bytes inline, point at an external object through a `uri` (with optional offset and size), or do both. When both are set, the inline bytes act as a cached copy of the referenced bytes.

The spec does not say which bytes a reader returns when the two disagree. That happens if the object at the URI is overwritten after the value is written.

### What diverges

Stefan Grafberger raised the case on November 3 while preparing FILE support ([thread](https://lists.apache.org/thread/6m6ptr3cwpxqdc37qn464gm00zkokhl3)). His example: write a value with inline bytes and a URI, then overwrite the object at the URI. One reader returns the inline bytes. Another fetches the URI and returns the new object. Both are spec compliant.

### The positions in the thread

Stefan proposed "inline wins." If `inline` is set, it supplies the bytes, and any locator fields (`uri`, `offset`, `size`) are provenance only. That restores the meaning from the original FILE PR (parquet-format #585) while keeping a later clarification (#603) that inline and a locator can both be set. He also proposed allowing `size` with inline alone, so readers learn the length without reading the bytes, and specifying that the checksum describes the source at the URI as it was when the inline copy was made. His draft is [parquet-format PR #635](https://github.com/apache/parquet-format/pull/635).

He considered making inline and the locator mutually exclusive and rejected it. That change invalidates values that current writers already produce, including the Hardwood writer and proposed fixtures in parquet-testing #128. It also removes the only record of where an inline copy came from, which matters for finding every copy of a file during a deletion request.

Divjot Arora asked whether changing how a released type is read is forward and backward compatible. Julien Le Dem answered that this is a case where the spec under-defined behavior. The community has to pick the correct reading, declare the others incorrect, and ship bug fixes for them.

On November 10, Daniel Weeks gave a different view of intent. He believes inline values are always meant to match the referenced part of the external file. If they do not match, that is an error state, and the spec should not try to define behavior for it. Readers should not be required to validate, because that undercuts the benefit of inline storage. The checksum exists for readers that choose to compare. His recommendation is to recognize the possibility and encourage implementations not to overwrite referenced files.

### Where it stands

The two positions agree that inline and the URI are meant to match. They disagree on whether the spec defines what readers return when they do not. "Inline wins" gives every reader the same answer in the error case. "Error state, undefined" keeps the spec smaller and puts the burden on writers not to overwrite referenced objects. The thread had fixtures under discussion through November 14 ([fixtures thread](https://lists.apache.org/thread/4ckswynrol05kp1zovw5mwq0s8fh55v2)).

### How to protect yourself now

Until this settles, treat objects referenced by FILE values as immutable. Write new objects to new keys rather than overwriting. If your storage supports object versioning or retention locks, turn them on for buckets that hold referenced files. If you must detect drift, compare the stored checksum against the object at the URI during maintenance, and flag mismatches.

## Case 4: Is Parquet's distinct_count exact?

### The spec text

Parquet column chunk and page statistics can carry a `distinct_count` field. The format does not say whether the value is exact or an estimate. Writers that populate it often compute it approximately, and query planners use it for join ordering and cardinality estimates.

### The disagreement

Adrian Garcia Badaracco proposed classifying `distinct_count` as inexact. On November 9, he argued that the field was never defined as accurate, no reader expects it to be accurate, and no writer writes completely accurate values ([thread](https://lists.apache.org/thread/k7kv2j2gh2h60616f0pr385zn5ow6sfs)). He cited a precedent. In 2023, PARQUET-2352 changed `min_value` and `max_value` from "Min and max values" to "Lower and upper bound values." As an alternative, he proposed deprecating `distinct_count` and adding `estimated_distinct_count`, defined as an estimate that can be higher or lower than the actual count by any amount.

On November 10, Daniel Weeks accepted a clarification but rejected redefining the field as an estimate ([reply](https://lists.apache.org/thread/0wgc55hv7kw665lklhmt021wkqbxj9oc)). His view is that nobody understood the field to be an estimate when it was introduced. A note that the value is not always accurate and can cause wrong results in some cases is a compatible change. Redefining it is not. If the community wants an estimate, it needs a new field, or it waits for the next major Parquet version, when incompatible changes are allowed. Adrian asked on November 11 for evidence that the field was ever understood as exact.

### Why it matters

A planner that treats an estimate as exact can make choices that depend on exactness. Join ordering is tolerant of error, since a bad estimate leads to a slower plan, not a wrong answer. Any optimization that uses `distinct_count` to skip work, such as assuming a column is unique because its distinct count equals its row count, can return wrong results if the count is approximate. The new-field path makes the contract explicit: an engine reading `estimated_distinct_count` knows it cannot rely on it for correctness.

On the Iceberg side, the v3 work already moved away from per-file distinct counts in manifests. The iceberg-go v3 tracker included an item to stop writing them. Iceberg's table-level distinct-value sketches live in Puffin files instead, as theta sketches, which are explicitly approximate.

### What to do now

If your engine uses Parquet `distinct_count` for anything beyond cost estimates, check what the writers in your environment put there. Treat it as an estimate until the spec says otherwise.

## Why these cases are surfacing now

Spec ambiguities have always existed. Four of them showing up on the dev lists within two weeks says something about where the ecosystem is in late 2026.

**There are more independent implementations.** Iceberg now has first-party libraries in Java, Python, Rust, Go, and C++. Each team reads the spec on its own. When Java was the only serious implementation, its behavior became the de facto rule, and nobody noticed when the text allowed another reading. Five readers find five readings.

**Conversion tools create unusual files.** Tools that add Iceberg metadata to existing Delta Lake or Hudi tables register files that no Iceberg writer produced. Those files carry whatever field IDs the original writer chose, which is how partial IDs show up in the first place. The name mapping case came from exactly this path.

**New types arrive with new edge cases.** Nanosecond timestamps and the FILE type are recent additions. Their spec text has seen less real-world use than older types, so the gaps have had less time to surface.

**The verification work makes gaps visible.** Once a project has reference tables and expected results, building a fixture for an edge case is cheap. Contributors who write fixtures run into the places where the text is unclear, and they raise them on the list. That is the system working as intended.

The trend is healthy. Ambiguities found on a dev list with a fixture attached get fixed. Ambiguities found in production by a confused analyst take much longer.

## How to report a new case so it gets resolved

The four threads in this ledger moved quickly because each one arrived with the same ingredients. If you find a new divergence, include these in your report:

1. **The spec sentence.** Quote the exact text and link the section. Show why it supports two readings.
2. **A minimal file.** Attach or link a file that triggers the difference. Smaller is better.
3. **The outputs.** Show what at least two implementations return, with versions and code paths where you know them. Sylwester's name mapping post named the exact functions in each library, which saved every maintainer a search.
4. **A proposed reading.** Pick one and explain why it fits the spec's intent and breaks the fewest existing files.
5. **A test value or fixture.** Offer a value that passes only under the proposed reading, as JB did for nanosecond buckets.

Send it to the dev list of the spec that owns the ambiguity, Iceberg or Parquet. File issues in each affected implementation once the list agrees on a reading.

## Running your own conformance checks

The four cases share a test method. Build a small file that hits the edge case, read it with every library in your stack, and compare. Here is the checklist I use for this ledger:

1. **Inventory your readers.** List each engine and library that reads shared tables, with versions. Tools built on PyIceberg, iceberg-rust, iceberg-go, or Iceberg Java inherit that library's behavior.
2. **Use the reference fixtures first.** The iceberg-verification repository and parquet-testing hold files built for exactly these checks. A fixture someone else built removes the risk that your test file is wrong.
3. **Build missing cases yourself.** The two snippets above cover cases 1 and 2. For case 3, write a FILE value with inline bytes and a URI, overwrite the object, and read it back.
4. **Compare results, not just success.** Every case here reads without error. Compare row counts, values, and the buckets queries scan.
5. **Pin library versions.** Fixes land in different releases for each implementation. A service that floats on a version range changes behavior when a fix ships.
6. **Re-run after upgrades.** Keep the fixtures in a test suite and run them in CI whenever an Iceberg or Parquet library version changes.

## What to watch for in the next edition

Each case has a clear next event. For name mapping, a spec PR implementing the per-field rule, plus a verification fixture with top-level IDs only. For nanosecond buckets, the merge of PR #18874 with the pre-epoch test value. For FILE, either "inline wins" lands in PR #635 or the community records the mismatch as an error state with guidance to writers. For `distinct_count`, a vote on `estimated_distinct_count`.

New cases enter the ledger when a thread shows two implementations returning different results for the same file. If you hit one, the most useful bug report includes the file, the spec sentence, and the outputs from two readers.

## Resolved

No cases resolved since the first edition.

## Changelog

- **November 16, 2026:** First edition. Four open cases from Iceberg and Parquet dev list threads dated November 3 to 15, 2026.

## Conclusion

Most spec ambiguity hides until a table built by one tool is read by another. This month's four cases show the pattern clearly. Four Iceberg readers resolve partial field IDs four ways. Truncation and floor division put pre-1970 nanosecond timestamps in different buckets. A FILE value can return inline bytes or a changed object depending on the reader. Planners disagree on whether `distinct_count` is a fact or a guess.

None of these is a crisis for a typical table. Each one is a real wrong answer for a specific table, and the fix pattern is the same every time: pick one reading, write it plainly, add a test value or fixture that fails the others, and ship the fixes. Run the checks above against your own stack, and watch this page for the next edition.

## Keep Going

If this piece was useful, I have written a lot more on how Iceberg and Parquet fit together at the spec level. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers schemas, field IDs, partition transforms, and how readers resolve data files. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
