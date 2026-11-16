---
title: "Iceberg v3 as the Default Format Version: An Implementation Readiness Report, November 2026"
description: "An implementation readiness matrix for making Iceberg v3 the default format version, covering Java, Go, C++, PyIceberg and Rust as of November 2026."
date: 2026-11-16T09:00:00Z
tags: ["Apache Iceberg", "Format Version", "Deletion Vectors", "Interoperability", "Data Engineering"]
canonical: https://iceberglakehouse.com/posts/iceberg-v3-default-readiness-report-november-2026/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/iceberg-v3-default-readiness-report-november-2026/).

Apache Iceberg is discussing making format version 3 the default for new tables, as it did when v2 became the default. As of November 16, 2026, Java and Go support most of v3, iceberg-cpp lacks only Variant, PyIceberg cannot write v3, and iceberg-rust is still adding it. This report tracks each gap until the switch.

The report has a narrow job. It does not tell you how to move your own tables to v3. If that is your question, read [Mastering Apache Iceberg v3: What's New and How to Plan Your Upgrade](https://iceberglakehouse.com/posts/apache-iceberg-v3-upgrade/) first. This piece answers a different question: when the project flips the default, which open implementations will be able to read and write the tables that result? A default only works if every library that touches the table can handle what the default produces.

I will update the matrix in this report as the dev list discussion moves. Each claim below points at the thread, issue, or pull request it came from. Where two sources disagree, I say so instead of picking one.

## What changing the default changes, and what it leaves alone

The format version is a single integer in a table's metadata file. The `format-version` field tells every reader which rules apply to the rest of the metadata. Version 1 was the original analytic format. Version 2 added row-level deletes through position and equality delete files. Version 3 adds a larger set of features that I cover below.

A library's "default format version" is the value it writes when you create a table and do not say which version you want. In Iceberg Java, that value lives in the table-creation path, and engines such as Spark and Flink inherit it. A user who runs `CREATE TABLE` without a `format-version` property gets whatever the library chose.

So the change under discussion is small in code and large in effect. Here is what it touches and what it leaves alone:

- **New tables created without an explicit version** start at v3 once the change ships in a release.
- **Existing tables** stay at whatever version they have today. Iceberg never upgrades a table's format version on its own. An upgrade happens only when someone sets the `format-version` table property to a higher number.
- **Tables created with an explicit `format-version`** keep that version. Setting `'format-version'='2'` still produces a v2 table.
- **Readers** do not change their behavior. A reader either supports the version in the metadata or refuses to load the table.

That last point is where readiness matters. A v3 table created by a Spark job is fine for Spark. It becomes a problem when a Python notebook, a Rust service, or a C++ engine tries to read or write the same table. If the library behind that tool does not support v3, it fails. In the worst case it reads the data while ignoring a v3 feature such as a deletion vector, and returns rows that were deleted.

## How the v2 switch was handled

The project has done this once before. Pull request [#8381](https://github.com/apache/iceberg/pull/8381) changed new tables to use v2 by default instead of v1. The motivation in that PR was practical. v1 tables wrote null transforms during partition spec evolution, which confused users. They also needed a flag to turn on snapshot ID inheritance, which affected performance. The PR argued that a v2 table with no delete files behaves like a v1 table, so moving the default harmed no one.

The review discussion is worth reading for what it reveals about readiness work. Ryan Blue objected to disabling a concurrent-replace test for REST catalogs, because it set a bad precedent and the related issue lacked a clear problem statement. Reviewers also debated keeping v1 in some REST tests because the commit protocol's `UpdateTableRequest` did not carry enough information in one case. In other words, the switch surfaced real gaps, and the gaps got fixed or tracked before the merge.

The v3 switch carries one difference that matters. In 2023, the Java implementation was the reference, and most of the ecosystem built on top of it. In late 2026, Iceberg has five first-party implementations: Java, Python (PyIceberg), Rust, Go, and C++. Each one moves at its own pace, and each one is the foundation for a different set of engines and tools. A default flip in Java now has a wider blast radius than it did for v2.

## The discussion that opened on November 15

Neelesh Salian started the thread "[DISCUSS] Make format version 3 the default" on the Iceberg dev list on November 15, 2026 ([thread](https://lists.apache.org/thread/fzf5yg9gno4q35gm8zzcpgfm8zxcfnn7)). He proposed following the same process as the v2 switch and framed the open question this way: Java and Go already support most of v3, with work still landing, so are the other implementations ready?

He listed two known gaps:

- PyIceberg cannot write v3 yet, tracked in [iceberg-python #1551](https://github.com/apache/iceberg-python/issues/1551).
- iceberg-rust is still working through v3, tracked in [iceberg-rust #2411](https://github.com/apache/iceberg-rust/issues/2411).

He also pointed at two pieces of supporting work. The implementation status page is getting a v3 breakdown in [iceberg #18062](https://github.com/apache/iceberg/pull/18062). The iceberg-verification repository is adding v3 reference tables so implementations can confirm they read v3 tables the same way.

On November 16, Gang Wu replied that iceberg-cpp supports most v3 features except the Variant type, and that work on Variant is active ([reply](https://lists.apache.org/thread/p504xo58z9tq0wrx6x71cl9p1czpto32)). The questions Neelesh asked are the right ones. What needs to happen before the switch, and does the project wait for every implementation or only some?

## What v3 contains

Before looking at the matrix, it helps to list what "supports v3" means. The v3 spec is not a single feature. It is a bundle, and an implementation can support some parts and not others. These are the parts that matter for a default flip:

| Feature | What it does | Why a reader cannot ignore it |
| --- | --- | --- |
| Deletion vectors | Store deleted row positions as a bitmap in a Puffin file, one per data file | A reader that skips them returns deleted rows |
| Row lineage | Assigns `_row_id` and `_last_updated_sequence_number` to rows, tracked through `first-row-id` and `next-row-id` in metadata | Writers must assign IDs on commit or they corrupt lineage |
| Default values | `initial-default` and `write-default` on schema fields | A reader must fill the default for files written before the column existed |
| Nanosecond timestamps | `timestamp_ns` and `timestamptz_ns` types | Unknown types block schema parsing |
| Variant | A semi-structured type, with optional shredding into typed columns | Unknown types block schema parsing |
| Geometry and geography | Spatial types with bounding-box metrics | Unknown types block schema parsing |
| Unknown type | A placeholder type for columns with no values yet | Unknown types block schema parsing |
| Multi-argument transforms | Partition transforms that take more than one source column | Partition parsing fails without support |

Two of these features change read results directly: deletion vectors and default values. If a reader skips either one, it returns the wrong data while appearing to work. The type additions fail loudly instead. A reader that does not know `variant` refuses to parse the schema. Loud failures are annoying. Silent wrong answers are dangerous.

Row lineage is a writer problem. A v3 writer has to assign row IDs on every commit. A library that writes v3 metadata without assigning lineage produces a table that breaks the guarantees other engines rely on for change tracking. For background on how deletion vectors change streaming writes, see [Mastering Apache Iceberg v3 Deletion Vectors for High-Throughput Streaming Ingest](https://iceberglakehouse.com/posts/apache-iceberg-v3-deletion-vectors-streaming-ingest/). For Variant, see [How Iceberg V3 Variant Shredding Changed Semi-Structured Data on S3 Tables](https://iceberglakehouse.com/posts/iceberg-v3-variant-shredding-s3-tables/).

## The readiness matrix, as of November 16, 2026

This matrix pulls from four kinds of sources: the published status page, the open status-page PR, the tracking issues for each implementation, and the iceberg-verification results. I mark each cell with the evidence behind it. "Y" means the source says the feature works. "Partial" means some of the feature works. "N" means the source says it does not. "Open" means work is tracked and not done.

| Feature | Java | Go | C++ | PyIceberg | Rust |
| --- | --- | --- | --- | --- | --- |
| Create or write v3 metadata | Y | Y (per thread) | Most of v3 (per Gang Wu) | N (#1551) | Partial (0.11.0) |
| Deletion vector read | Y | Y (verification run) | Not stated | Y for the reference table (verification run) | Y in 0.11.0, N in 0.10.1 (verification run) |
| Deletion vector write | Y | Not stated | Not stated | Open (#1078, #3474) | Open (#2411) |
| Row lineage on commit | Y | Not stated | Not stated | Open (#3621) | Partial (0.11.0 announcement) |
| Default values | Y | Not stated | Not stated | Rejected in initial scope (#1551) | Open (#2411) |
| `timestamp_ns` / `timestamptz_ns` | Y | Y | N on status page | Y on status page | Y |
| Variant | Y | Y | N (work active) | Conflicting sources | Metadata only in 0.11.0 |
| Geometry / geography | Y | N | N | N | N (draft PR) |
| Unknown type | Y | Y | N on status page | Y | N |

Here is what each row rests on, because a matrix without its evidence is just an opinion.

**The type rows** come from the [implementation status page](https://iceberg.apache.org/status/). It lists nanosecond timestamps and Variant as supported in Java, PyIceberg, Rust, and Go, and not in C++. It lists geometry and geography as Java only. It lists the unknown type in Java, PyIceberg, and Go. I treat this page with care. In the review of PR #18062, a reviewer said Variant is supported only in Java, Rust, and Go, with Python and C++ pending. The PR exists because the page needs corrections. Gang Wu's reply also suggests C++ is further along on types than the page shows. Where the page and a maintainer disagree, trust the maintainer and wait for #18062 to merge.

**The PyIceberg rows** come from issue #1551, titled "Support writing V3 tables." The write work is split into sub-issues: V3 metadata writing (#3619, addressed by #3551), upgrading tables to v3 (#3622), v3 manifests and manifest lists (#3620), and row lineage assignment on commit (#3621). Merge-on-read deletes with deletion vectors are tracked separately in #1078, with #3474 in review. The issue lists concrete blockers: `TableMetadataV3.model_dump_json` raises `NotImplementedError`, `SUPPORTED_TABLE_FORMAT_VERSION` is still 2, and `write_manifest` and `write_manifest_list` still have v1 and v2 branches only. The suggested initial scope rejects `write-default` values, `timestamp_ns` writes, multi-argument transforms, and Variant and geometry types with clear errors, to be handled later.

**The Rust rows** come from two places. Issue #2411 tracks v3 work and shows Variant (PR #2188), geometry and geography (draft PR #2933), zstd metadata compression (PR #2894), and deletion vector reads (#2792) as open, with default values, row lineage, and multi-argument transforms pending. The [Iceberg Rust 0.11.0 announcement](https://lists.apache.org/thread/lm4sskbfojckzmo6l3fkko1wcoz5v8h6) on November 4 says the release adds incremental v3 support, including row lineage, nanosecond timestamps, deletion vectors, and Variant in metadata, with no Variant reads or writes yet. The tracking issue and the release announcement describe the same work from two angles. The release has shipped pieces that the issue checklist has not ticked.

**The deletion vector read row** has the strongest evidence of anything in this matrix. [iceberg-verification PR #24](https://github.com/apache/iceberg-verification/pull/24), merged on November 16, adds a reference table named `v3/deletion-vector-parquet-data`. I cover it in the next section.

## Cross-implementation reads: the verification tables

Matrices built from issue trackers have a weakness. They report what maintainers believe. A reference table reports what the code does.

The iceberg-verification repository holds small Iceberg tables with known contents and an expected scan result. Each implementation reads the table, and the output must match the expected rows. If two libraries disagree, at least one has a bug.

PR #24 adds the first v3 table with a delete file. Its setup is simple on purpose:

1. Snapshot 1 appends two data files. `a.parquet` holds ids 1 through 5. `b.parquet` holds ids 6 and 7.
2. Snapshot 2 adds one deletion vector that deletes positions 0 and 3 of `a.parquet`.
3. A correct scan of snapshot 2 returns ids 2, 3, 5, 6, and 7.

The design includes a control. `b.parquet` has no deletion vector. A reader that applies the vector to every data file instead of only the file it references deletes rows from `b.parquet` and fails the test. The spec scopes a deletion vector to one data file, and this table checks that rule.

The PR reports results for five readers. A raw fastavro and pyarrow reader, PyIceberg 0.12.0, Iceberg Java 1.12.0, iceberg-go, and iceberg-rust 0.11.0 all matched the expected output. iceberg-rust 0.10.1 failed the second snapshot because it lacked a Puffin deletion vector loader. That single data point is the most useful sentence in this report. It shows that a reader one minor version behind returns different rows than the rest of the ecosystem.

A separate row lineage reference table is in progress as a draft (PR #26). When it lands, the row lineage row of the matrix gets the same kind of evidence.

To run the reference tables against your own stack, clone the repository and point your reader at the table directory. The README for each table includes the input block that generated it and the expected scan. A minimal PyIceberg check looks like this:

```python
from pyiceberg.table import StaticTable

# Load the reference table directly from its metadata file,
# without a catalog. Point this at your local clone.
table = StaticTable.from_metadata(
    "iceberg-verification/v3/deletion-vector-parquet-data/metadata/v2.metadata.json"
)

# Scan the current snapshot and collect the ids.
ids = sorted(table.scan().to_arrow().column("id").to_pylist())
print(ids)  # expected: [2, 3, 5, 6, 7]
```

`StaticTable.from_metadata` loads a table from one metadata file, which is how reference tables are meant to be read. The metadata file name in this example is a placeholder. Use the file the table's README names. The scan reads the current snapshot, applies any deletes the reader supports, and returns an Arrow table. If your reader prints `[2, 3, 4, 5, 6, 7]` or drops ids 6 and 7, it is not applying the deletion vector correctly. Run the same check with every library your organization uses against shared tables.

## The questions the community has to answer

The thread asked two questions. Here is how I read each one, with the trade-offs on both sides.

**Does the project wait for every implementation?** Waiting for all five protects mixed-library environments, which are now common. A data team writes with Spark, a platform team runs a Rust or Go service, and analysts query from Python. If the default moves while PyIceberg cannot write v3, a notebook that appends to a Spark-created table fails. The cost of waiting is that new Java users keep getting v2 tables and never benefit from deletion vectors or row lineage unless they opt in.

**Does the project wait for some implementations?** A partial-readiness rule is easier to meet. A reasonable version reads something like this: every implementation must at least read every v3 feature that changes query results (deletion vectors and default values), and must fail loudly on v3 features it does not support. That rule targets silent wrong answers, which are the real risk, and accepts loud failures as a tolerable cost. It does not require every library to write v3 before the default moves.

**What counts as "supports"?** The status-page PR defines a data type as `Y` when the library supports it in the schema and can read and write its values in a supported file format. That is a useful bar, and the community should apply the same definition to table features. "Parses the metadata" and "reads the data correctly" are different claims.

**What evidence closes a gap?** The verification repository already gives the answer for reads. A gap closes when the implementation passes the reference table for that feature. That gives the project an objective test for each row of the matrix, and it turns a debate about readiness into a checklist.

## What a reader should check before setting format-version=3 today

You do not need to wait for the default to move. Many teams already create v3 tables on purpose to get deletion vectors and row lineage. If you do, check these points first. Each one maps to a row in the matrix.

1. **List every library that touches the table.** Include engines, ingestion tools, notebooks, catalog services, and table maintenance jobs. For each one, find the underlying Iceberg implementation and its version. A tool built on PyIceberg inherits PyIceberg's v3 status.
2. **Separate readers from writers.** A library that reads v3 correctly but cannot write it is fine for a read-only consumer and a blocker for anything that appends, deletes, or runs maintenance.
3. **Check deletion vector reads against the reference table.** This is the check most likely to catch a silent problem. Run the snippet above with each reader you use.
4. **Avoid types your readers cannot parse.** If any reader lacks Variant or geometry support, do not add those columns yet. The table stays readable as long as its schema uses only types every reader knows.
5. **Watch for default values.** If a writer adds a column with an `initial-default`, every reader must fill that default for older files. PyIceberg's initial v3 scope rejects `write-default`, so plan schema changes around that.
6. **Pin versions.** iceberg-rust 0.10.1 and 0.11.0 behave differently on the same table. Lock the library versions in every service that reads shared tables, and upgrade them deliberately.

The parallel lesson from the Parquet side is covered in [Iceberg's Next Version Depends on Decisions Being Made in Parquet](https://iceberglakehouse.com/posts/parquet-constrains-iceberg/), which makes the case that implementation status, not spec approval, is the real ship date. The v3 default debate is the same lesson at the table-format layer.

## A bar I propose for the switch

The thread asked what needs to be done before the switch. Here is the bar I propose. It is my position, not a community decision, and it is built to be testable.

**Gate 1: every implementation reads every result-changing v3 feature.** Deletion vectors and default values change which rows and values a query returns. Every first-party library must pass a reference table for each one before the default moves. The deletion vector table already exists. A default-value table is the obvious next fixture.

**Gate 2: every implementation fails loudly on everything else.** A library that does not support Variant, geometry, or multi-argument transforms must refuse the table with a clear error that names the feature. Silent partial reads are not acceptable. This gate is cheap to meet and removes the worst outcome.

**Gate 3: the reference implementation and at least one other can write v3 with row lineage.** Java already does. A second writer proves the spec is implementable from the text alone, which is the real point of having multiple implementations. Go is the likely candidate given the thread.

**Gate 4: the status page matches the verification results.** Once PR #18062 merges, any cell marked `Y` for a feature with a reference table must pass that table. A status page that disagrees with the test suite is a bug.

**Gate 5: release notes call out the change in every implementation.** Users of PyIceberg or iceberg-rust need to know that tables created by Java engines will arrive as v3. A note in each project's next release is enough.

Gates 1 and 2 protect data correctness. Gate 3 protects the spec. Gates 4 and 5 protect users from surprise. None of them requires every library to support every v3 feature, which keeps the bar reachable within a release cycle or two.

## Failure modes when the default moves before the ecosystem

It helps to describe exactly what breaks, so you can recognize it.

**A Python writer hits a v3 table.** PyIceberg raises an error when asked to write a format version it does not support. A user tried to create a v3 table with nanosecond timestamps and hit "Writing V3 is not yet supported," according to the discussion on #1551. The failure is loud and clear. The cost is a broken pipeline, not bad data.

**An old Rust reader skips a deletion vector.** This is the quiet failure. The verification run showed iceberg-rust 0.10.1 failing the deletion vector table. A service on that version reading a v3 table with deletes returns rows that other engines treat as deleted. Nothing errors. Counts drift, and two dashboards disagree.

**A reader meets an unknown type.** A reader without Variant support fails on schema parsing. The failure is loud. It also blocks every column in the table, not just the Variant column, because the reader cannot build the schema.

**A writer without row lineage commits to a v3 table.** The spec requires lineage assignment on commit for v3. PyIceberg's design treats lineage assignment as a prerequisite for v3 appends (#3621) for exactly this reason. A writer that skips it leaves rows without valid IDs, which breaks incremental and change-tracking reads downstream.

**Table maintenance from a lagging library.** Compaction and snapshot expiration rewrite metadata and data files. A maintenance tool that does not understand deletion vectors either fails or rewrites files without applying deletes. Check maintenance tooling with the same care as query engines.

The warning signs are consistent. Watch for row counts that differ by engine, schema errors that name a type, and write failures that mention format version. Any of these after a table moves to v3 points back at this matrix.

## Where this goes next

Three things will move the matrix in the coming weeks, and I will update this report as each one lands.

The status page correction in PR #18062 will give the project one agreed view of type support across all five libraries. Expect the Variant and C++ rows to change.

PyIceberg's v3 metadata writing work (#3551) removes the `NotImplementedError` and is the first step toward v3 writes. Row lineage assignment (#3621) is the step that makes v3 appends possible. Those two together move PyIceberg from "cannot write" to "can append."

The row lineage reference table (iceberg-verification PR #26) will give the project the same objective test for lineage that PR #24 gave for deletion vectors.

Meanwhile, v4 work is moving in parallel, with a weekly metadata sync and votes on features such as default value expressions. A v3 default is the step that lets the community stop thinking of v3 as new. That matters because v4 assumes v3 features, including deletion vectors, are the baseline.

## Changelog

- **November 16, 2026:** First edition. Covers the dev list thread opened November 15, Gang Wu's iceberg-cpp update, the iceberg-verification deletion vector table merged November 16, and tracking issues #1551 and #2411.

## Conclusion

The format version default looks like a one-line change. It is really a statement that the whole ecosystem can handle what the default produces. As of November 16, 2026, Java leads, Go is close, C++ is missing Variant, Rust shipped partial v3 support in 0.11.0, and PyIceberg cannot yet write v3. Reads are in better shape than writes, and the deletion vector reference table gives the community its first hard evidence that independent readers agree.

If you are deciding whether to set `format-version=3` on your own tables now, use the checklist above and the verification tables. If you maintain an implementation, the most useful contribution to this discussion is a passing reference table. That is how a readiness debate becomes a release decision.

## Keep Going

If this piece was useful, I have written a lot more on Apache Iceberg's format and how its versions evolve. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers the table format spec, metadata structure, and row-level deletes in depth. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
