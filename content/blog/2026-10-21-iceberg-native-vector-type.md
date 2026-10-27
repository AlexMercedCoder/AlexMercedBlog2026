---
title: "Iceberg Is Getting a Vector Type, and Parquet Decides What It Looks Like"
description: "Iceberg's proposed vector type enforces fixed dimension, non-null, and finite values. What it promises, how Parquet shapes it, and what to do now."
date: 2026-10-21T09:00:00Z
tags: ["Apache Iceberg", "vector type", "embeddings", "Parquet", "AI"]
canonical: https://datalakehousehub.com/blog/iceberg-native-vector-type/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/iceberg-native-vector-type/).

Open any Iceberg table that feeds a retrieval system and look at the embedding column. It is almost always `list<float>`. That type says "a variable number of floats, any of which can be null." It says nothing about the one fact every consumer of that column depends on: each row holds exactly 768 numbers, or 1,024, or 1,536, and every one of them is a real, finite value.

Because the type cannot say it, nobody enforces it. A pipeline change swaps the embedding model and starts writing 1,024-dimension vectors into a 768-dimension column. The write succeeds. An upstream API overflows and returns NaN for a handful of rows. The write succeeds again. The failure shows up weeks later as a similarity search that returns garbage, or an index build that crashes on row 40 million.

Apache Iceberg is fixing this. In July 2026, Yan Yan opened a dev list discussion proposing a first-class vector type. By late September there was a GitHub issue (apache/iceberg #18297) and a design document. On October 8 the community's biweekly sync set a narrow first scope for the type. And the most important decisions about how those vectors sit on disk are happening on a different mailing list entirely, in the Apache Parquet community, where a heated debate over NaN, naming, and quantization is still running.

This article explains the proposal from the spec level up: what the type promises, why each restriction exists, how it maps to Parquet, what you do with your embedding columns today, and what to watch before the type lands. If you run vector search over Iceberg tables, the query-side architecture is covered in [Vector Search Directly Over Iceberg Tables](https://iceberglakehouse.com/posts/vector-search-over-iceberg-tables/). This piece is about the type itself.

## Why `list<float>` Was Never the Right Container

Iceberg's type system is deliberately small. It has primitives (int, long, float, double, decimal, string, binary, timestamps, and in v3 the variant, geometry, and geography types) and three nested types: struct, list, and map. When embeddings arrived in lakehouse tables around 2023, teams reached for the obvious fit. An embedding is a sequence of floats, so it became a list of floats.

A list in Iceberg carries two pieces of type information. The element type, and whether elements are required or optional. That is it. There is no length. Every row of a list column can hold a different number of elements, and the format treats that as normal, because for most list data it is normal. A list of order line items, a list of tags, a list of phone numbers: these vary row to row by design.

Embeddings are the opposite. Variation in length is always a bug. A model produces vectors of one fixed dimension, and every downstream computation assumes it. A dot product between a 768-element vector and a 1,024-element vector is undefined. A vector index built for one dimension rejects the other. So the single most important invariant of an embedding column is the one invariant `list<float>` cannot express.

Yan Yan's July proposal named this directly. Today embeddings live in Iceberg as a list, and a list cannot express that every value shares one dimension. The proposal favored a dense numeric vector with a compact schema encoding, something like `float[768]`, with a fixed dimension, non-null elements, and nullability controlled at the field level rather than the element level.

That last point deserves a moment. In a `list<float>` column there are two places a null can live. The whole list can be null (no embedding for this row yet), and an individual element can be null (a hole inside the vector). The first case is legitimate and common. Rows get written before their embeddings are computed. The second case has no meaning for an embedding. A vector with a null at position 312 is not a vector anyone can compute a distance from. The vector type keeps the first kind of null and removes the second.

There is a performance cost to the list representation too, and it comes from how Parquet stores nested data. That cost is the reason the Parquet community became the critical path for this whole effort, so it gets its own section below.

The type gap also leaks into tooling. Schema-aware tools such as catalogs, data quality frameworks, and semantic layers read the Iceberg schema to understand a column. A `list<float>` tells them nothing about the column's role. A vector type tells every tool reading the schema that this column is an embedding of a known dimension. That makes it possible for a catalog to flag a dimension mismatch at commit time, for a query planner to choose a vector-aware execution path, and for an agent browsing the catalog to understand what the column is for.

## What the First Version of the Type Promises

The October 8 sync produced the clearest statement of scope so far. The notes, which Yan Yan circulated with a draft spec pull request, set five rules for the first version.

First, the vector is one-dimensional and fixed-length. A column declares its dimension once in the schema, and every non-null value has exactly that many elements. Matrices and tensors are out.

Second, the coordinates are numeric and non-null. There is no such thing as a missing element inside a vector.

Third, the coordinates are finite. NaN, positive infinity, and negative infinity are not valid values. Both +0 and -0 remain valid, which matches IEEE 754 behavior where the two zeros compare equal.

Fourth, the initial element types are int, long, float, and double. Narrower types such as int8, which matter a great deal for quantized embeddings, are deferred as possible future Iceberg primitives. The notes point out that the Parquet representation can still carry narrower types, so the door stays open at the file level.

Fifth, distance functions and sparse vectors are out of scope for now. They come back with the index design, which is a separate Iceberg workstream.

Here is how the new type compares with the representation teams use today.

| Property | `list<float>` today | Proposed vector type |
|---|---|---|
| Dimension in schema | No | Yes, fixed per column |
| Row-level null (no embedding yet) | Allowed | Allowed (field nullability) |
| Null elements inside a vector | Allowed unless `element_required` | Never allowed |
| NaN or infinity | Allowed | Not allowed |
| Element types | Any Iceberg type | int, long, float, double |
| Parquet layout | Repeated field with repetition and definition levels | Builds on Parquet's emerging vector logical type |
| Engine knows it is an embedding | No | Yes |

Several things are absent from that first scope on purpose. Philipp Fischbeck argued on the dev list in July for a lean feature list in the first pass: no vector-specific statistics, no vector-specific constraints, and no vector schema evolution. That argument held. There is no "promote a 768-dimension vector to 1,024" operation, because no such conversion produces meaningful data. A new embedding model means a new column.

Statistics deserve a note because Iceberg leans heavily on them. For ordinary columns, Iceberg stores per-file lower and upper bounds that let engines skip files during planning. For a vector column, per-file min and max bounds across 768 coordinates do not help a nearest-neighbor query skip anything useful. Vector pruning belongs to an index, not to column bounds. So the first version skips vector statistics and leaves pruning to the index work.

The restrictions are the feature. Each one converts a convention that teams enforce by hand, or forget to enforce, into a guarantee the format makes. An engine reading a vector column knows the dimension before it reads a byte. It knows it never needs to check for nulls inside a vector. It knows every value is safe to feed to a distance kernel.

## Why Finite Values Became the Fight

The most contested restriction is the one that looks smallest: no NaN, no infinity. It drew the longest threads, and the arguments on both sides are good. Understanding them tells you a lot about what a file format owes its users.

The debate happened on the Parquet list, where Rok Mihevc opened parquet-format PR #624 in September for a LIST-based `VECTOR` logical type. The draft contract was strict. Every non-null vector holds exactly `num_elements` values. Elements are non-null and finite. Elements are numeric or boolean primitives, with no nesting.

Antoine Pitrou objected. Parquet is a general-purpose format, he argued, and NumPy produces arrays containing NaN and infinity all the time. Readers that cannot handle those values can refuse them. The format itself should not.

Alkis Evlogimenos answered with a survey of how vector systems already behave. Postgres, Oracle, MySQL, SQL Server, Milvus, Qdrant, and Pinecone all reject nulls, NaN, and infinity in vector values. DuckDB and ClickHouse accept them, but only because they store vectors as plain float arrays, and their vector features stop working when bad values appear. In other words, the systems that allow non-finite values do so by not treating the column as a vector at all.

Daniel Weeks made the mathematical case. A vector has dimension, magnitude, and direction. A NaN coordinate destroys all three. A similarity score computed from a vector containing NaN is NaN, and NaN poisons every comparison it touches. A top-k search over a column with a few NaN vectors returns results in an order that depends on how the sorting code treats NaN, which differs between languages and libraries.

Two practical points settled much of the argument. Will Edwards noted that embedding APIs do sometimes return NaN on numeric overflow. That is exactly the bad data a strict type is meant to catch at write time, before it reaches an index. Divjot Arora added the decisive operational point: statistics cannot reliably detect non-finite values after the fact. If the type does not guarantee finiteness, every reader that cares has to scan every value to find out. A type-level guarantee is the only way a reader trusts the column without a full pass.

That last argument is the one I find most convincing, because it mirrors how Iceberg already thinks. Iceberg's value comes from letting engines trust metadata instead of re-reading data. A schema that says "these vectors are finite" is metadata an engine can act on. A schema that says "these are floats, good luck" forces the engine back to the data.

The debate also produced a naming question. Andrew Lamb suggested a narrower name, such as `FINITE_VECTOR` or `VECTOR_EMBEDDING`, if the real objection was that the word "vector" promised something general. Gang Wu proposed separating the two concerns entirely: treat a general fixed-size list as the physical layout, and the specialized vector as a separate logical contract on top.

## Ryan Blue's Two-Type Compromise

By early October the Parquet thread had a shape, and Ryan Blue described it plainly. He proposed two types. One is a `FINITE_VECTOR`. The other is a separate fixed-length list, or vector, that allows special values such as NaN.

This compromise is easy to misread, so it helps to be precise about where it lives. It is a Parquet proposal, made on the Parquet list, about Parquet logical types. It is not an Iceberg counter-proposal to Yan Yan's design, and it is not a split between dense and sparse vectors. Both of Ryan's types are dense and fixed-length. The difference between them is only whether non-finite values are allowed.

Ryan also laid out what a logical type buys anyone. I find his list the clearest way to understand why this matters, so here it is in my own words.

A logical type describes the data to users and readers. A tool that sees `FINITE_VECTOR` knows it is looking at an embedding without guessing from a column name.

It signals that the repetition and definition levels in the file reflect a fixed number of elements. Implementations use that to decode faster, because they no longer need to walk the levels to find where each row ends.

It guarantees no null elements, so readers skip null handling inside the vector.

The finite variant guarantees no NaN or infinity, so every vector has a finite length and is safe for distance calculations.

Steven Wu agreed that `FINITE_VECTOR` adds value and argued against forcing every use case into a generic fixed-length list. Alkis suggested calling it `VECTOR` to match other engines and type systems, leaving room for a non-finite variant later. Gang Wu supported separating the vector type from a general fixed-length list and moving the vector type first.

The compromise gives each camp what it needs. Teams storing embeddings for search get a strict type that engines trust. Teams storing scientific arrays, where NaN carries meaning such as "sensor offline," get a fixed-length type without the finiteness rule. Neither group forces its constraints on the other.

## The Quantization Objection

Not everyone accepted the premise. Jan Finis argued that the finite restriction adds little on its own and that the fixed-length part belongs in a general feature rather than a one-off type. Existing Parquet types already store uncompressed vectors well, he said. The real gain is quantization, where storage size and processing speed improve by orders of magnitude.

Will Edwards made a related point from the engine side. He wants every engine to offer vector functions over plain lists of floats without a new logical type. He sees more value in a type that describes how to unpack quantized codes, scales, and codebooks, because that is where machine learning storage is heading.

This objection is worth taking seriously, because the arithmetic supports it. A 768-dimension float32 vector is 3,072 bytes. One billion of them is about 3 TB before compression, and float data compresses poorly with general-purpose codecs. Scalar quantization to int8 cuts that to 768 bytes per vector, a 4x reduction. Product quantization and binary quantization go further, down to tens of bytes per vector. For teams storing embeddings at scale, the quantized representation is where the storage bill drops.

So why ship the simple type first? Because Iceberg needs a stable target this year, and quantization formats are not converging fast. Every vector database and library has its own quantization scheme, its own codebook layout, and its own tradeoffs between recall and size. Standardizing those in a file format is a multi-year effort. Standardizing "a fixed-length array of finite floats" is a months-long effort, and it unblocks every engine and table format that wants to treat embeddings as a real type now.

My read is that both sides are right about something, and the likely outcome reflects that. A narrow vector type ships first. Quantized encodings follow as a separate track, possibly as encodings rather than types. Parquet's recent encoding work points the same way. The C++ implementation of ALP, an encoding built for floating-point data, merged in October, and ALP targets exactly the kind of float columns embeddings produce.

The Iceberg sync notes already reflect this order. Narrower element types like int8 are deferred as future Iceberg primitives, while the Parquet layer keeps room to carry them. Iceberg is building on the simple type and leaving the quantization door open.

## How the Vector Maps onto Parquet's Bytes

To see why Iceberg waits on Parquet, you need to see how Parquet stores a list today. Parquet uses the Dremel encoding for nested data. Every value in a repeated field carries two small integers: a repetition level, which says whether this value starts a new row or continues the current list, and a definition level, which says how many of the optional fields above this value are actually present.

For a 768-element embedding, every row writes 768 values plus 768 repetition levels plus 768 definition levels. A reader decoding that column has to walk all of those levels to reconstruct where each row's list starts and ends. The levels compress well, but decoding them costs CPU on every read, and that cost lands on every query that touches the column.

The Parquet community measured this carefully over the summer. In the FIXED_SIZE_LIST logical type discussion, Andrew McCormick benchmarked readers that know the list has a fixed length. A hint-aware reader on a plain LIST landed around 1,430 nanoseconds per row, compared with about 2,600 nanoseconds for a full Dremel decode. That is close to a 45 percent reduction in decode time without changing the bytes on disk at all. Gunnar Morling reported similar results from a fixed-length list fast path he built in Hardwood. For 768-element embeddings, read times dropped to the level of a flat column holding the same data.

Those results matter for the design. They show that a logical type which tells the reader "every list in this column has exactly N elements and no nulls" delivers most of the performance of a brand-new physical layout, while staying readable by every existing Parquet reader. An old reader that does not understand the logical type falls back to the physical LIST and still reads correct data. It is slower, but it is right.

The physical question was narrowed further at a Parquet community call on September 8. Rok Mihevc summarized two options on the dev list. In one, each vector is stored as a single fixed-length byte array holding all its elements, with the logical type recording the element type. In the other, the vector keeps a LIST structure and the logical type carries the fixed-length and non-null guarantees. PR #624 took the LIST-based path for its draft, which preserves compatibility with readers that know nothing about vectors.

This is why Iceberg defers. The Iceberg vector sync explicitly builds on Parquet's emerging representation. Iceberg's own spec defines types and how they map to each file format. Picking a mapping before Parquet decides invites a second migration later. Iceberg has done this before. When the variant type was being designed, the board minutes recorded that the Iceberg update to add variant was approved and waiting on Parquet upstream. Variant took that path, and it worked. Vectors are following the same playbook.

For formats without native vector support, the Iceberg plan is pragmatic. Avro and ORC files use a list representation, and writers enforce the vector rules before writing. The group will explore an Avro vector logical type with the Avro community. ORC support is still open.

## What This Means for Engines and Readers

A table format type is only useful when engines understand it. Here is what changes for each part of the read and write path once the type exists.

Writers carry the enforcement burden. A writer producing a vector column must check dimension, nulls, and finiteness for every value before committing. That check is cheap relative to computing the embedding in the first place. A float32 finiteness check over 768 values is a few hundred nanoseconds of vectorized CPU work. The payoff is that bad data fails at write time, in the pipeline that produced it, with an error that names the problem.

Readers get to drop defensive code. Today any engine running a similarity function over `list<float>` has to handle lists of the wrong length, null elements, and NaN coordinates, usually by returning null or raising an error at query time. With a vector type, those cases cannot exist in valid data, so the kernel becomes a tight loop over contiguous floats.

Query planners gain a signal. An engine that sees a vector column can choose a vector-aware scan path, use SIMD distance kernels sized to the known dimension, and size memory buffers exactly. A planner reading `list<float>` has to treat the column like any other nested data.

Catalogs gain a validation point. A REST catalog that receives a commit can compare the vector dimension in the new schema with the existing schema and reject a change that silently alters the dimension. That turns the "someone swapped the embedding model" failure from a silent corruption into a rejected commit.

Arrow is the natural in-memory partner. Apache Arrow already has a `FixedSizeList` type, and most engines that read Parquet decode into Arrow. A Parquet vector column decodes straight into an Arrow fixed-size list of float32 with no reshaping, which means the data lands in memory as one contiguous buffer of floats. That is the layout distance kernels want.

Engines that query Iceberg (Spark, Trino, Flink, DuckDB, Dremio, and the rest) each need to map the new type into their own type systems. I work at Dremio, which reads Iceberg and Arrow natively, so I watch this mapping closely, but the same work is required of every engine. Expect engines to adopt read support first, then write support with enforcement, then vector-aware execution paths, in that order.

## Preparing Your Embedding Columns Today

The vector type is not in a released spec yet, so the practical question is what to do with the embedding columns you write this quarter. The answer is to behave as if the type already exists. Store vectors in the closest legal representation, enforce the vector rules at write time, and record the dimension where tools find it. When the type ships, your data already satisfies it, and migration becomes a schema change instead of a cleanup project. This piece covers the spec debate and the type itself. Storing compressed codes, their codebooks, and codebook versioning inside a table is a separate design problem, covered in [Storing Quantized Embeddings in Apache Iceberg](https://iceberglakehouse.com/posts/quantized-embeddings-iceberg-sq8-pq/).

Start with an audit. This Spark SQL query checks an existing table for every violation the vector type forbids. Run it before you assume your embeddings are clean.

```sql
SELECT
  count(*)                                             AS rows_with_embedding,
  count_if(size(embedding) <> 768)                     AS wrong_dimension,
  count_if(exists(embedding, x -> x IS NULL))          AS null_elements,
  count_if(exists(embedding, x -> isnan(x)
           OR x = CAST('Infinity' AS DOUBLE)
           OR x = CAST('-Infinity' AS DOUBLE)))        AS non_finite
FROM rag.chunks
WHERE embedding IS NOT NULL
```

Each column of the result maps to one rule of the proposed type. `size` returns the element count of each list, so `wrong_dimension` counts rows whose length differs from the model's dimension. The `exists` higher-order function tests each element, so `null_elements` catches holes inside a vector and `non_finite` catches NaN and both infinities. The outer `WHERE` clause keeps row-level nulls out of the count, because a missing embedding is legal under the new type. Any nonzero number in the last three columns is data that the vector type will reject.

Next, write new tables so they match the type's rules. This PyIceberg and PyArrow example creates a table with a non-null element list, validates every batch before commit, and appends only clean data.

```python
import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
from pyiceberg.catalog import load_catalog
from pyiceberg.schema import Schema
from pyiceberg.types import FloatType, ListType, LongType, NestedField, StringType

DIM = 768

schema = Schema(
    NestedField(field_id=1, name="chunk_id", field_type=LongType(), required=True),
    NestedField(field_id=2, name="text", field_type=StringType(), required=False),
    NestedField(
        field_id=3,
        name="embedding",
        field_type=ListType(element_id=4, element_type=FloatType(), element_required=True),
        required=False,
    ),
    NestedField(field_id=5, name="embedding_model", field_type=StringType(), required=False),
)

catalog = load_catalog("lakehouse")
table = catalog.create_table(
    "rag.chunks",
    schema=schema,
    properties={
        "embedding.dimension": str(DIM),
        "write.metadata.metrics.column.embedding.element": "none",
    },
)


def validate_embeddings(batch: pa.Table, column: str, dim: int) -> None:
    col = batch.column(column).combine_chunks()
    present = col.filter(pc.is_valid(col))
    wrong_len = pc.sum(pc.not_equal(pc.list_value_length(present), dim)).as_py() or 0
    values = present.flatten()
    null_elems = values.null_count
    non_finite = pc.sum(pc.invert(pc.is_finite(values))).as_py() or 0
    if wrong_len or null_elems or non_finite:
        raise ValueError(
            f"{column}: {wrong_len} wrong-length, {null_elems} null elements, "
            f"{non_finite} non-finite values"
        )


texts = [f"chunk {i}" for i in range(1000)]
vectors = np.random.rand(1000, DIM).astype(np.float32)  # stand-in for model output
fixed = pa.FixedSizeListArray.from_arrays(pa.array(vectors.ravel()), DIM)

target = table.schema().as_arrow()
batch = pa.table(
    {
        "chunk_id": pa.array(range(1000), pa.int64()),
        "text": pa.array(texts),
        "embedding": fixed.cast(target.field("embedding").type),
        "embedding_model": pa.array(["text-embed-v2"] * 1000),
    }
).cast(target)

validate_embeddings(batch, "embedding", DIM)
table.append(batch)
```

Walk through it piece by piece.

The schema declares the embedding as a `ListType` with `element_required=True`. That is the closest the current spec gets to the vector type's "no null elements" rule, and it is enforced by the format today. The field itself stays optional, which matches the vector type's field-level nullability. A row without an embedding is fine. A vector with a hole is not.

The `embedding_model` column records which model produced each vector. This is cheap insurance. When you change models, you write a new column or a new table, and this field lets you prove which rows came from which model.

The table properties do two jobs. `embedding.dimension` is a plain custom property. Iceberg does not interpret it, but any tool, script, or agent reading the table metadata finds the dimension there without opening a data file. The `write.metadata.metrics.column.embedding.element` property set to `none` turns off column statistics for the vector elements. Per-file min and max bounds over 768 coordinates do nothing for nearest-neighbor pruning and add bulk to manifests, which mirrors the vector type's choice to skip vector statistics in its first version.

The `validate_embeddings` function enforces the three rules the format does not enforce yet. It drops row-level nulls first, then counts lists with the wrong length, null elements, and non-finite values. Any nonzero count raises an error and the commit never happens. All three checks are vectorized Arrow compute calls, so the cost stays small even for large batches.

The data path starts from a `FixedSizeListArray`, which is how most embedding code already holds vectors in memory. It casts to the table's list type only at the boundary. When the vector type lands and engines map it to Arrow's fixed-size list, that cast disappears and the rest of the pipeline stays the same.

## Failure Modes Before and After the Type

Even with a vector type on the way, embedding columns fail in predictable ways. Some failures go away with the type. Others need discipline that no type provides.

The silent model swap is the most common failure and the one the type fixes best. Today, switching from a 768-dimension model to a 1,024-dimension model and writing into the same `list<float>` column succeeds. The table now holds two incompatible populations of vectors. Similarity search quietly compares vectors from different embedding spaces, and results degrade without any error. With a vector type, the write fails at the first wrong-length value. Until then, the dimension check in your writer is the only defense, and the audit query above is how you find out whether it has already happened.

Same-dimension model swaps are the failure the type does not fix. Two models with identical output dimensions produce vectors in completely different spaces. A vector type guarantees shape, not meaning. A 768-dimension vector from model A and a 768-dimension vector from model B pass every type check and still produce nonsense when compared. The proposed type enforces dimension at the schema level, but it does not enforce which model produced the values. That is why the `embedding_model` column in the example matters, and why a model change belongs in a new column even when the dimension stays the same.

NaN leakage is the second failure the type fixes. A batch of NaN vectors from an overflowing API call enters the table, then poisons an index build or a top-k query. Under the vector type, the writer rejects the batch. Today, the finiteness check in your writer catches it, if you run one.

Statistics bloat is a quieter problem. Iceberg collects column metrics by default for a limited number of columns, and a wide vector list adds lower and upper bounds for its element column. For tables with millions of small files, that metadata adds up. Turning metrics off for the element column, as the example does, removes the cost with no loss of pruning ability.

Partial engine support is the failure to plan for once the type ships. The first engines to support the type will not all arrive at once. A table written with a vector column by a new writer is unreadable by an old engine that does not know the type, the same way early v3 tables were unreadable by engines without v3 support. Plan the upgrade the way you planned the v3 upgrade: confirm every engine that reads the table supports the type before the first writer starts using it.

Format mismatch across files is the last one. Iceberg tables can hold Parquet, Avro, and ORC data files. If a table mixes formats, vector enforcement depends on the writer for each format. The sync notes are clear that formats without native vector support use a list representation with writer-side enforcement. In practice, standardize vector tables on Parquet and avoid the question.

## Operational Guidance for the Next Two Quarters

Here is the plan I recommend for any team storing embeddings in Iceberg between now and the type's release.

Run the audit query against every table with an embedding column. Record the results. If any table shows wrong-dimension rows, find out which pipeline wrote them and which model produced them before you do anything else. Mixed-dimension tables need to be split, and the split is easier while the table is small.

Adopt one table per embedding model, or one column per model in a shared table. Name columns after the model and dimension, such as `embedding_textv2_768`. When a model changes, add a new column, backfill it, switch readers, and drop the old one. That workflow matches the vector type's lack of schema evolution and keeps every column internally consistent.

Set `element_required` on every new embedding list. It is free, enforced by the format, and it matches the coming type. Changing it on an existing column is a stricter schema change, so do it on new tables or new columns.

Put the validation function, or your equivalent, in every writer. Python pipelines get the PyArrow version above. Spark writers get an equivalent check with the same higher-order functions the audit query uses, run as a filter that routes bad rows to a quarantine table instead of the main one. Flink writers check in the map operator that calls the embedding model, which is the earliest point the bad data exists.

Record the dimension in table properties. A custom property costs nothing and gives catalog browsers and agents a reliable place to read it. When the type ships, the dimension moves into the schema and the property becomes redundant, which is fine.

Turn off element-level column metrics on embedding columns. Check your manifest sizes before and after. On tables with many small files, the difference shows up in planning time.

Watch three threads. The Parquet vector type thread decides the physical layout and the name. The Iceberg vector sync, which meets on the Thursday biweekly schedule, decides the table-level spec and the mapping to each file format. The Iceberg index work decides how vector pruning works once the type exists. The index design was finalized in September around region files that are globally ordered and non-overlapping, so a single-key lookup costs one small file read once index metadata is cached. Vector indexes will build on that same machinery.

Inventory your engines. List every engine that reads or writes your embedding tables, and track each one's support for the type as releases land. Do not start writing the new type until every reader supports it.

### What migration looks like once the type ships

The exact syntax is not final, so treat this as a sequence rather than a script. The steps follow from how Iceberg handles new types and from the rules in the sync notes.

Step one is engine readiness. Every engine that reads the table needs a release that maps the vector type into its own type system. Until that is true for all of them, keep writing the list representation.

Step two is a new column, not an altered one. The vector type has no schema evolution in its first version, and converting a list column to a vector column in place is not part of the proposal. Add a vector column with the same dimension next to the existing list column. Because Iceberg tracks columns by field ID, adding a column is a metadata-only change and rewrites no data files.

Step three is a backfill. Copy values from the list column into the vector column with an `UPDATE` or a rewrite job. If your writers already enforced dimension, non-null elements, and finiteness, every row converts cleanly. Any row that fails the conversion is a row your audit query should have caught, which is a strong reason to run that audit now.

Step four is the reader switch. Point queries, index builders, and retrieval services at the new column. Run both columns in parallel for a release cycle and compare results on a fixed set of queries before you trust the new path.

Step five is the cleanup. Drop the list column, then expire old snapshots so the data files that held only the old column age out on your normal maintenance schedule.

Teams that skipped the write-time checks face a different first step: find and quarantine the bad rows before any of the above. That work grows with table size, so it is cheaper this quarter than next year.

## Where This Is Heading

The vector type is one piece of a larger shift. The lakehouse formats are learning new data types for AI workloads, and they are doing it in coordination across projects.

The clearest sign is the File type, which went to a vote on the Iceberg list on October 13. A file field references a range of bytes stored inline or in an external object, with fixed sub-fields for the URI, offset, size, content type, checksum, and an inline payload. Its semantics follow the FILE logical type in the Parquet spec. Put the File type and the vector type side by side and you get the full retrieval data model inside one table: the source document as a typed file reference, the chunks as text, and the embeddings as typed vectors, all governed by the same catalog, the same snapshots, and the same access controls.

The second sign is indexing. Distance functions and sparse vectors are explicitly out of the first vector version and will return with the index design. That ordering is correct. A type with no index support still pays off through enforcement and faster decoding. An index without a type has nothing stable to index. Once both exist, an engine can plan an approximate nearest-neighbor query against an Iceberg table using index files the table itself manages, with no second system holding a copy of the vectors.

The third sign is encodings. ALP has merged in the Parquet C++ implementation, and its target is floating-point data. Quantized vector encodings are the obvious next step, and the Parquet debate has made the demand clear. Expect quantization to arrive as encodings or as a separate type track, after the simple type stabilizes.

The fourth sign is coordination. Iceberg's vector sync defers explicitly to Parquet's decision. The Iceberg File type mirrors Parquet's FILE logical type. Arrow already has the fixed-size list that both formats decode into. The table format, the file format, and the in-memory format are converging on one vocabulary for vectors. That convergence is what makes an open lakehouse a credible home for embeddings. A vector stored by one engine reads correctly in every other engine, with the same guarantees, without conversion.

The open question that matters most is timing. As of mid-October 2026, the Iceberg spec version the type lands in is not settled, and the Parquet logical type has not gone to a vote. The direction is clear and the scope is narrow, which is usually a good sign for a fast vote. But the spec is not final, and nothing in this article should be read as final syntax.

## Conclusion

Embedding columns have lived in Iceberg as `list<float>` because there was nothing better. That representation cannot express the one property every embedding depends on, a fixed dimension, and it cannot keep out null elements or NaN values that break every downstream computation. The proposed vector type fixes all three with a narrow, enforceable contract: one-dimensional, fixed-length, non-null, finite, with int, long, float, and double elements.

The decisions that shape how those vectors sit on disk are being made in the Parquet community, where the debate over finiteness, naming, and quantization produced Ryan Blue's two-type compromise. A `FINITE_VECTOR` for embeddings and a separate fixed-length type for arrays that need special values. Iceberg is building on that work rather than racing it, the same way it built variant on Parquet's variant.

You do not need to wait for the release to benefit. Audit your embedding columns now. Enforce dimension, non-null elements, and finiteness in every writer. Record the model and dimension in metadata. Keep one model per column. Tables written this way move to the new type with a schema change instead of a cleanup project, and they are safer to query today.

## Keep Going

If this piece was useful, I have written a lot more on Apache Iceberg's design and how its spec evolves. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers the table format's type system, metadata structure, and file format mappings that this proposal builds on. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
