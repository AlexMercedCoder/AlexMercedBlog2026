---
title: "What Vortex Has to Prove Before Iceberg Adds a Fourth File Format"
description: "The Vortex proposal split into criteria and candidate. What field IDs, statistics, governance, and ecosystem support a new Iceberg file format must prove."
date: 2026-10-21T09:00:00Z
tags: ["Apache Iceberg", "Vortex", "Parquet", "file formats"]
canonical: https://datalakehousehub.com/blog/iceberg-new-file-format-criteria-vortex/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/iceberg-new-file-format-criteria-vortex/).

Every Apache Iceberg table makes a promise that is easy to forget because it has held for so long. Any engine that understands Iceberg can read any Iceberg table. Spark writes it, Trino reads it, Flink appends to it, DuckDB queries it, and a Python script inspects it, all without anyone checking which tool wrote which file. That promise rests on a short list of data file formats that every serious engine supports: Parquet above all, with ORC and Avro beside it.

In July 2026, Martin Prammer proposed adding a fourth. The candidate is Vortex, a columnar format built for fast random access on object storage. What made the proposal interesting was its structure. Prammer split the draft into two parts. The first defines the criteria any file format has to meet to join Iceberg. The second argues that Vortex meets them. He asked the community to settle the criteria before arguing about the candidate, because the criteria will outlive this one proposal.

That framing is the right one, and it is the subject of this article. Whether Vortex joins Iceberg matters to the teams who want its performance. What the bar looks like matters to everyone, because it decides how Iceberg evolves at its lowest layer for the next decade, and every future candidate will be measured against it.

This piece covers why Iceberg has kept its format list short, what a new format has to provide for Iceberg's metadata model to work, how governance and stability fit in, what Vortex brings, how Parquet's own modernization changes the math, and what to do with your tables while the decision plays out. The broader survey of new file formats is in [The File Format Renaissance](https://iceberglakehouse.com/posts/file-formats-renaissance/), and the [Vortex knowledge base entry](https://iceberglakehouse.com/iceberg/vortex-file-format/) covers the format's basics. This piece is about the admission bar.

## Why Iceberg's Format List Has Stayed Short

Iceberg's spec names the data file formats it supports, and each data file entry in a manifest records which format that file uses. Parquet, ORC, and Avro have been on that list since the early days. Parquet carries the overwhelming share of analytical data. ORC serves teams that came from the Hive ecosystem. Avro shows up mostly in metadata, since Iceberg manifests themselves are Avro files, and occasionally for row-oriented data.

The list stayed short for a reason that has nothing to do with the merits of newer formats. A table format is a contract between writers and readers who never coordinate directly. When a writer picks a file format, every reader of the table inherits that choice. If one engine writes a format that another engine cannot read, the table is broken for the second engine, even though nothing is corrupt. Every format on the list is a format every engine has to support, or else the table quietly fractures into "readable by some."

That is why adding a format costs more than adding most features. A new partition transform or metadata field is something engines adopt incrementally, and the spec rules about what readers must do when they meet something unknown keep tables safe. A new data file format has no graceful fallback. A reader that cannot decode the bytes cannot answer the query, and the only safe behavior is to fail.

Iceberg did prepare for change. The 1.11.0 release in May 2026 introduced a pluggable File Format API in the Java implementation, which decouples Iceberg's core metadata handling from the reader and writer code for each physical format. A format becomes a plugin that implements standard reader and writer interfaces. That change lowered the engineering cost of experimenting with new formats, and the community has used it to build a Vortex-backed plugin. But an API for plugins is not the same as a place in the spec. A plugin lets a deployment use a format. Admission into the spec says every Iceberg implementation should be able to read it.

The distinction is the heart of the debate. Teams have always been free to experiment. The question Prammer put to the list is what a format must prove before experimentation turns into a promise that every engine keeps.

## The Criteria Question

The criteria section of the draft is still under discussion on the dev list, and in early October Prammer asked the community to confirm two things before going further: whether the general rules for adding any file format match expectations, and whether concerns remain about how Vortex meets them. The draft also gained an overview of Vortex and its community policies after questions at a community sync.

I am not going to restate the draft's wording, because it is a living document and the final text belongs to the community. What follows is my reading of what any such bar has to cover, based on how Iceberg's metadata model depends on its file formats and on how the community has handled similar decisions. I group the requirements into three families: technical requirements that Iceberg's metadata model imposes, governance requirements about who controls the format, and ecosystem requirements about who can read it.

The technical family is the least negotiable, because Iceberg's features are built on assumptions about what a data file can do. The governance family is where the hardest judgment calls live. The ecosystem family decides whether admission helps users or strands them.

## Technical Requirement One: Field IDs and Schema Evolution

The first technical requirement is the one most people outside the Iceberg community underestimate. Iceberg tracks columns by numeric field ID, not by name or position. That single decision is what makes Iceberg's schema evolution safe. You can rename a column, drop one, add another with the same name, or reorder columns, and old data files still read correctly, because the reader matches columns by ID.

For this to work, the ID has to live inside each data file. In Parquet, every field in the file schema carries a `field_id`, and Iceberg writers set it to the Iceberg field ID. When a reader opens an old file after a rename, it ignores the stored names and matches IDs. ORC and Avro carry the same information through their own attribute mechanisms.

Any new format has to do the same thing. It needs a place in its schema to store a stable integer ID for every field, including fields nested inside structs, lists, and maps. Readers need to project columns by that ID. Without it, a rename silently returns the wrong column or nulls, which is the class of bug Iceberg was created to eliminate.

You can see the mechanism directly. This Python snippet opens a Parquet data file written by an Iceberg writer and prints the field IDs stored in its schema.

```python
import pyarrow.parquet as pq

schema = pq.read_schema("part-00000-example.parquet")

for field in schema:
    field_id = (field.metadata or {}).get(b"PARQUET:field_id", b"missing").decode()
    print(f"{field.name:<24} id={field_id:<6} type={field.type}")

# Nested fields carry their own IDs too, for example the element of a list.
for field in schema:
    if hasattr(field.type, "value_field"):
        element = field.type.value_field
        element_id = (element.metadata or {}).get(b"PARQUET:field_id", b"missing").decode()
        print(f"  {field.name}.element id={element_id}")
```

`pq.read_schema` reads only the footer, so this is cheap even for large files. PyArrow exposes the Parquet `field_id` as field metadata under the key `PARQUET:field_id`. The first loop prints each top-level column's name, its ID, and its Arrow type. The second loop shows that list elements carry their own ID, which Iceberg assigns as a separate field. Run it on a file from any Iceberg table and every field shows an ID. Run it on a Parquet file written by a tool with no Iceberg awareness and the IDs are missing, which is exactly why Iceberg has special handling, through name mapping, for importing files that lack them.

A candidate format has to make this snippet's equivalent work: open a file, read a stable ID for every field at every nesting level, and project by it. That is a precise, testable requirement, and it is the first thing a criteria document should say.

## Technical Requirement Two: Types, Statistics, and Row Positions

Three more technical requirements follow from features Iceberg already ships.

The first is a complete type mapping. The Iceberg spec defines how each Iceberg type maps to each supported file format. A new format needs the same table, covering every primitive (including decimals with precision and scale, timestamps with and without time zone, nanosecond timestamps, UUIDs, and fixed-length binary), every nested type, and the v3 additions: variant, geometry, and geography. The v4 work adds more. The File type, which went to a vote in October, maps to Parquet's FILE logical type, to a record in Avro, and to a tagged struct in ORC. The vector type in design builds on Parquet's emerging vector representation. A new format joins a moving target, and it has to show mappings for the types Iceberg is adding, not just the ones it had.

The second is statistics. Iceberg's file pruning depends on per-file metrics stored in manifests: record counts, value counts, null counts, NaN counts, and lower and upper bounds per column. Writers compute those metrics as they write. Readers never compute them. A new format needs a writer that produces every metric Iceberg expects, with semantics that match the other formats exactly. NaN handling and the treatment of positive and negative zero in bounds are the classic places where formats disagree. A format whose writer computes bounds differently produces tables where pruning skips files it should read, which returns wrong answers.

The third is row positions. Iceberg's row-level deletes identify rows by position within a data file. Position delete files and v3 deletion vectors both say "row 41,207 of this file is deleted." That only works if every reader of the format assigns the same position to the same row, every time, regardless of how it reads the file. v3 row lineage adds row IDs and sequence numbers that also depend on stable row ordering. A format with internal reordering, or with readers that disagree on row numbering, breaks deletes silently. The format has to guarantee a stable, total row order per file and expose positions to readers cheaply.

Two smaller requirements round out the technical family. Iceberg records split offsets for data files so engines can parallelize reads of large files, and a new format needs natural split boundaries, the role row groups play in Parquet. And Iceberg's table encryption work integrates with Parquet's modular encryption. A new format needs an encryption story that fits the same key management model, or tables that require encryption cannot use it.

## Governance Requirements: Who Controls the Format

The technical bar is demanding but checkable. Governance is where judgment comes in, and it is where the hardest questions about any young format live.

The first governance question is control. When Iceberg admits a format, it binds its own future to that format's future. If a single company controls the format, its roadmap, its spec, and its license can change in ways the Iceberg community has no say in. The industry has watched that risk play out at other layers of the stack. Iceberg's own credibility rests on being governed at the Apache Software Foundation, where no single vendor controls the project.

Vortex addresses this directly. It started at a company called Spiral and moved to the Linux Foundation, where it is an incubation-stage project at LF AI & Data. The project describes itself as independent and not controlled by any single company. That is a meaningful step, and it is the kind of evidence the criteria should ask for. The open questions are the ones any incubating project faces: how diverse its committer base is, how decisions get made, and how the project behaves when a major contributor's interests diverge from the community's. The October revision of the draft added an overview of Vortex's community policies after questions at a sync, which shows the Iceberg community asking exactly these questions.

The second governance question is the spec. Iceberg's guarantees are written down. Its spec defines behavior independently of any implementation, which is why Java, Python, Rust, Go, and C++ implementations interoperate. A file format that joins Iceberg needs the same property: a written specification that a second team can implement from scratch, not a reference library whose behavior is the definition. Parquet earned its position partly because its format is specified in a document that many teams have implemented independently. A criteria document should ask for a spec that stands on its own and evidence that someone has implemented it without reading the reference code.

The third governance question is stability. A table written today has to be readable in ten years. Vortex declares its file format stable as of release 0.36.0 and commits that future releases will read files written by any version from 0.36.0 forward. That is the right commitment. The criteria should go further and ask how the format handles additions after stability, which is exactly the problem the Parquet community is wrestling with right now.

That Parquet debate is the best available case study. In October, Alkis Evlogimenos proposed a versioning model for Parquet and surveyed eight readers to see what they do when they meet something unknown. Unknown logical types are safe everywhere, because readers fall back to the physical type. Unknown encodings are mostly safe, because readers fail on the affected column. Unknown page types and compression codecs are not safe: some readers skip unknown pages and silently drop rows, and one treats unknown codecs as uncompressed. Twenty years into Parquet's life, its community is still discovering how readers behave at the edges.

A new format needs a clear answer to the same question on day one. When a newer writer adds an encoding or a feature, what does an older reader do? The only acceptable answers are "reads correctly" and "fails loudly." "Returns wrong data" disqualifies a format for a table spec, no matter how fast it is.

## Ecosystem Requirements: Who Can Read It

The third family of requirements asks whether admitting the format helps users or strands them.

Iceberg has reference implementations in several languages. Java is the oldest and the one most engines build on. PyIceberg serves Python users, iceberg-rust serves a fast-growing set of Rust engines, and Go and C++ implementations shipped releases this fall. A format admitted to the spec needs a credible path to reading in each of them. A format with an excellent Rust library and no mature Java reader leaves the Java-based engines, which still carry most production Iceberg workloads, unable to read tables that use it.

Vortex's core is written in Rust, with Python packages and a growing set of integrations, and the Iceberg community has built a Java plugin on the new File Format API. The criteria should ask for evidence of reader support in the languages Iceberg implementations use, and for a realistic timeline to engine support in the major query engines.

Engine adoption is the requirement that most directly affects users. When a team writes a table in a new format, every engine that reads the table needs support. In practice, that means the first production users of a new format will be teams that control every reader of their tables, such as a platform team running one engine over tables no one else touches. Broad adoption follows engine support, and engine support follows demand. A criteria document cannot force engines to adopt a format, but it can require that the format's reader libraries be embeddable, licensed permissively, and documented well enough that engine teams can adopt it without heroics.

Security is the last ecosystem requirement, and it gets less attention than it deserves. A file reader parses untrusted bytes. Every engine that reads Iceberg tables runs that parser inside its process, sometimes with broad access to credentials and data. A new format's reader needs fuzz testing, a vulnerability disclosure process, and a security response track record before it runs inside every engine in the ecosystem. Vortex publishes a vulnerability reporting address, which is the starting point. The criteria should ask for more over time.

## What Vortex Brings

With the bar laid out, it is worth being specific about why anyone wants Vortex in Iceberg at all.

Vortex was designed around a different access pattern from Parquet. Parquet is built for large sequential scans. It compresses well and reads whole column chunks efficiently, but fetching a few scattered rows is expensive, because readers decompress and decode whole pages to reach individual values. Vortex targets fast random access on object storage alongside scan performance. The project claims random access reads around 100 times faster than Parquet, with similar compression ratios, and those figures depend on data shape and access pattern.

The design choices behind that claim are worth understanding. Vortex strictly separates logical types from physical encodings. It uses cascading compression, where encodings nest inside one another, an approach based on the BtrBlocks research. It draws on a set of lightweight encodings from recent research, including FastLanes for integers, FSST for strings, and ALP for floating-point data, and many of its compute kernels operate directly on encoded data without full decompression. Its built-in encodings are compatible with Apache Arrow's memory format, which allows zero-copy handoff to Arrow-based engines. Its encoding system, type system, compression strategy, and layout strategy are all pluggable.

The workload that benefits most is the one Iceberg tables increasingly serve. Vector search, feature lookups for machine learning, and retrieval for AI applications read scattered rows by position or key rather than scanning whole columns. A table that stores embeddings and the rows they describe gets queried this way constantly. A format that makes point reads cheap on object storage changes what an Iceberg table can be used for. That is the strongest argument for Vortex: it serves the AI access pattern without moving data into a separate system.

I want to be careful here. Benchmarks published by a format's own project are a starting point, not a verdict. The Iceberg community will want independent measurements, run through Iceberg's own read paths, on representative tables, across more than one engine. Performance in a standalone benchmark and performance inside an Iceberg scan, with Iceberg's planning, deletes, and projection in the loop, are different numbers.

## Parquet Is Not Standing Still

The case for a new format depends on the gap between it and Parquet, and that gap is closing from the Parquet side.

The Parquet community has spent 2026 adding exactly the modern encodings that Vortex was built around. ALP, the adaptive lossless floating-point encoding, has merged in the Parquet C++ implementation. PFOR for integers and FSST for strings are active proposals, with detailed benchmarks posted to the list. The FastLanes bit-packing layout was discussed and decoupled from PFOR so it can be added later. Parquet also opened a vote on versioned releases in July, and its community is now debating a concrete versioning model so new features can ship without breaking older readers.

Parquet is also addressing random access directly for the AI workloads that motivate Vortex. The fixed-size list work this summer showed that readers which know a list has a fixed length decode vectors far faster without changing the bytes on disk. The vector logical type debate is about making embeddings first-class. Page indexes, already part of the format, let readers skip to specific pages instead of scanning whole column chunks.

None of this makes Parquet as fast as a format designed from scratch for random access. Parquet carries twenty years of compatibility constraints, and some of its costs, such as the repetition and definition level machinery for nested data, are structural. But it changes the cost-benefit math for Iceberg. If Parquet closes most of the gap for most workloads over the next two years, the benefit of admitting a new format shrinks, while the cost of supporting it stays the same.

This is the real tension in the debate. A new format has to be better than Parquet will be by the time engines support the new format, not better than Parquet was when the proposal was written.

## How Mixed-Format Tables Work in Practice

One detail of Iceberg's design makes a new format less disruptive than it sounds. Iceberg records the format per file, not per table. Each data file entry in a manifest carries a `file_format` field, and a single table can hold Parquet files and ORC files side by side. The table property `write.format.default` controls what writers produce, and engines can override it per write.

That means adopting a new format does not require rewriting a table. New files land in the new format while old files stay in the old one. Readers handle each file according to its recorded format. It also means a table can drift into mixed formats without anyone deciding it should, if one writer is configured differently from the others.

You can see a table's format mix with a query against the `data_files` metadata table in Spark SQL.

```sql
SELECT
  file_format,
  count(*)                                   AS files,
  sum(record_count)                          AS records,
  round(sum(file_size_in_bytes) / 1e9, 2)    AS size_gb,
  min(readable_metrics.event_ts.lower_bound) AS earliest_event,
  max(readable_metrics.event_ts.upper_bound) AS latest_event
FROM lake.analytics.events.data_files
GROUP BY file_format
ORDER BY files DESC
```

Each row of the result is one file format present in the current snapshot. `files`, `records`, and `size_gb` show how much of the table each format holds. The time range columns use the typed bounds from `readable_metrics` to show which period of data each format covers, which tells you whether a format change happened at a clear point or whether formats are interleaved because writers disagree.

For a table that should be uniform, the expected result is one row. Two rows on a table you thought was all Parquet means some writer is producing another format. That matters today for ORC and Avro, and it will matter more if a fourth format joins the spec, because every reader of a mixed table needs support for every format in it.

Pinning the default is one line, and it is worth doing on any table where you want to control format adoption deliberately.

```sql
ALTER TABLE lake.analytics.events SET TBLPROPERTIES (
  'write.format.default'        = 'parquet',
  'write.delete.format.default' = 'parquet'
)
```

The first property sets the format for data files. The second sets it for delete files, which writers otherwise create in the data file default. With both pinned, a new writer that respects table properties cannot introduce a different format by accident. Engines that override the format per write still can, which is why the audit query belongs in your regular table checks.

Mixed-format tables also give a safe adoption path when a new format does arrive. Create a test table, or a branch of an existing one, set the default to the new format, write a representative slice of data, and run your real queries against it in every engine that reads the table. If any engine fails, the experiment stays isolated. Only after every reader passes does the format move to production tables, and even then, old files stay in Parquet until compaction rewrites them.

## Failure Modes When Formats Change

Format transitions fail in a few predictable ways. Most of them are not about the new format's quality. They come from the gap between what the writer supports and what every reader supports.

The stranded reader is the most common. One engine starts writing a new format to a shared table. A second engine, which the writing team did not know about, fails on every query that touches the new files. The warning sign is a query error naming an unsupported file format, and it often appears in a downstream team's dashboard before anyone on the writing team notices. The prevention is the audit query above plus an inventory of every engine that reads each table.

The silent semantic mismatch is the most dangerous. Two formats encode the same Iceberg type with slightly different semantics, such as timestamp precision, NaN handling in bounds, or decimal rounding, and a query returns different answers depending on which files it reads. Nothing errors. The warning sign is a reconciliation check that disagrees after a format change. The prevention is conformance testing: write the same data in both formats and compare reads value by value, including edge cases, in every engine.

The stats gap shows up as worse pruning after a format change. If a new format's Iceberg writer does not produce every metric the old one did, such as NaN counts or bounds for nested fields, manifests carry less information and engines skip fewer files. The warning sign is scan reports showing more files read for the same queries after the change. The prevention is comparing `readable_metrics` coverage between files of each format.

The delete mismatch shows up as wrong row counts. If a reader assigns row positions differently than the writer did, position deletes and deletion vectors remove the wrong rows. The prevention is a test that deletes specific rows by key from a new-format file and confirms exactly those rows disappear in every engine.

The tooling gap is the least dramatic and the most common. Backup tools, data quality frameworks, lineage scanners, and file inspection utilities often read data files directly. A format change can break them even when every query engine works. The prevention is including those tools in the reader inventory.

## What to Do While the Decision Plays Out

The admission debate will take time, and it should. Here is a sensible posture for teams running Iceberg in production in the meantime.

Keep production tables on Parquet. It is the format every engine and tool supports, and its modernization means the performance you get keeps improving without changing formats. Pin `write.format.default` on important tables so no writer changes it by accident.

Audit your tables for format drift. Run the format mix query across your catalog. Any table with more than one format deserves an explanation.

Experiment where you control every reader. If you have a workload that depends on random access, such as vector retrieval or feature lookups, and you control the engines that read those tables, the File Format API and the Vortex plugin work make experimentation possible. Keep experiments on isolated tables or branches, and measure through Iceberg's read path, not only through standalone benchmarks.

Follow the dev list thread and the community syncs. The criteria discussion is open. If your organization has requirements around encryption, compliance, or specific engines, the time to state them is while the criteria are being written, not after a format is admitted.

Track Parquet's encoding and versioning work. ALP, PFOR, FSST, and the vector type will reach engines over the next year. Some of the performance you want from a new format arrives through Parquet upgrades with no table change at all.

Watch engine support announcements. If a fourth format is admitted, engine support determines when you can use it. I work at Dremio, which reads Iceberg tables through Arrow, so I watch engine-side support closely, and the same question applies to every engine in your stack: does it read the new format in all of its Iceberg read paths, including deletes?

## A Checklist for Any Candidate Format

Pulling the three families together gives a checklist that applies to Vortex today and to whatever format comes next. This is my synthesis, not the draft's text, and the community's final criteria will differ in wording and detail.

| Area | Requirement | How to verify |
|---|---|---|
| Schema | Stable integer field IDs at every nesting level, projection by ID | Read IDs from files, rename and drop columns, confirm old files read correctly |
| Types | Mapping for every Iceberg type, including v3 and in-flight v4 types | Round-trip tests per type, with edge values |
| Statistics | Writer produces every Iceberg metric with matching semantics | Compare manifest metrics against Parquet files holding the same data |
| Row positions | Stable, total row order, cheap position access | Delete rows by position, confirm in every reader |
| Splits and encryption | Natural split points, fit with Iceberg's key management | Parallel read tests, encrypted table tests |
| Governance | Neutral foundation home, diverse maintainers, open decision process | Committer and contributor diversity, documented governance |
| Specification | Written spec independent of the reference library | An independent implementation from the spec alone |
| Stability | Backward compatibility commitment, defined behavior for unknown features | Older readers either read correctly or fail loudly on newer files |
| Ecosystem | Readers for the languages Iceberg implementations use | Working readers in Java, Python, Rust, and others |
| Security | Fuzzing, disclosure process, response record | Published process and history |

A few rows deserve emphasis.

The specification row is the one most likely to separate a format that belongs in a table spec from a fast library. A format defined by its implementation can change behavior in a patch release, and every Iceberg implementation in every language then has to chase it. A format defined by a document can be implemented and tested against.

The stability row is where the Parquet versioning survey offers a model. A candidate format can publish the same kind of table: for each class of change, what an older reader does. That table is worth more to a table format community than any benchmark.

The governance row is the slowest to satisfy, because it depends on time. A project that moved to a foundation recently has not yet shown how it behaves through a contentious decision or a change in its main sponsor's priorities. That is not a criticism of any project. It is the reason the criteria should look for evidence accumulated over time, not just a foundation logo.

## Precedents From Iceberg's Own History

Iceberg has made format-level decisions before, and two precedents show how the community thinks.

The first is Puffin. When Iceberg needed to store statistics blobs, such as distinct-value sketches, and later deletion vectors, it did not adopt an existing format. It defined Puffin, a small format of its own, specified in the Iceberg repository and governed by the Iceberg community. That choice shows a strong preference for formats whose evolution Iceberg controls when the format sits close to Iceberg's own semantics. It also shows that Iceberg is willing to add formats when the need is clear. The bar is not "never." It is "only with control over the guarantees Iceberg depends on."

The second is variant. When Iceberg designed its variant type for semi-structured data, it did not define a private encoding. It waited for Parquet to standardize the variant encoding upstream and built on that work. The same pattern is repeating now with the vector type, where Iceberg's vector sync defers to Parquet's representation, and with the File type, whose semantics follow Parquet's FILE logical type. Iceberg prefers to build on shared standards in the formats it already supports rather than fork its own.

Put the precedents together and a principle emerges. Iceberg adds formats when it needs capabilities no existing format offers, and it prefers either formats it governs directly or improvements to formats it already supports. A new third-party data file format sits outside both patterns, which is why the criteria discussion carries so much weight. It is defining a third path that Iceberg has not taken before.

## Where This Is Heading

Several outcomes are possible, and they are not mutually exclusive.

One outcome is that the criteria get adopted and Vortex is admitted, with a staged rollout: spec support first, then reader support across implementations, then writer support in engines. That path makes Vortex the first data file format added to Iceberg in years, and it sets a precedent for others.

Another is that the criteria get adopted and Vortex stays outside the spec for now, as a plugin format usable through the File Format API, while it builds the track record the criteria ask for. In that world, teams with full control of their readers use Vortex in practice, and the spec decision follows evidence.

A third is that Parquet's modernization narrows the gap enough that the community decides the cost of a fourth format outweighs the benefit for the foreseeable future. Even then, the criteria document has lasting value, because the next proposal, whether Lance, a successor to Vortex, or something not yet written, starts from a clear bar instead of a fresh argument.

The constant across all three is that the file format layer is in motion again for the first time in a decade. AI workloads want random access, vectors, and multimodal data. Parquet is adding encodings and types to serve them. New formats are designed for them from the start. Iceberg sits on top of all of it, and its job is to keep the promise that every engine reads every table, while giving users access to the improvements underneath. Getting the admission criteria right is how it does both.

### Signals worth watching

Three concrete signals will tell you where the decision is going before any final vote.

The first is whether the criteria get their own vote, separate from Vortex. A standalone vote on the general rules means the community has accepted the split Prammer proposed, and every later format proposal will cite that document. If the criteria and the candidate get voted together, the precedent is weaker.

The second is a spec pull request. Admission to the spec means changes to the format mapping sections, the data file format enum, and the type tables. A draft spec PR that adds those sections, with reviewers from several companies, is the clearest sign the proposal is moving from discussion to implementation.

The third is reader support outside Java. Watch PyIceberg and iceberg-rust for Vortex read support, behind flags at first. Reader support in more than one implementation is the evidence the ecosystem requirements ask for, and it is the step that turns a spec change into something users can rely on.

## Conclusion

Martin Prammer's proposal to add Vortex to Apache Iceberg did something more valuable than argue for one format. By splitting the draft into criteria and candidate, it asked the community to define what any data file format must prove to join the spec. That question will shape Iceberg's lowest layer for years.

The bar has three parts. Technically, a format has to carry field IDs for schema evolution, map every Iceberg type, produce every metric Iceberg's pruning relies on, keep row positions stable for deletes, and fit Iceberg's split and encryption models. In governance, it needs a neutral home, an independent written spec, and a clear stability contract that never lets an older reader return wrong data. In the ecosystem, it needs readers across Iceberg's implementation languages, a path to engine support, and a security track record.

Vortex brings a real capability, fast random access on object storage, aimed at the AI workloads Iceberg tables increasingly serve. Parquet is closing part of that gap with new encodings and types. The decision will turn on the size of the gap that remains and on how well Vortex meets the bar. In the meantime, keep production tables on Parquet, pin your format defaults, audit for drift, experiment only where you control every reader, and take part in the criteria discussion while it is still open. The rules written this year decide which formats every Iceberg engine reads for the next decade, and the people who show up to write them are the ones whose workloads they will fit.

## Keep Going

If this piece was useful, I have written a lot more on Apache Iceberg's architecture and how its spec evolves. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers the table format's metadata structures, schema evolution by field ID, and the file format mappings that every candidate format has to match. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
