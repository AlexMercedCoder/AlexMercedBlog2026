---
title: "Storing Quantized Embeddings in Apache Iceberg: Scalar 8-Bit Codes vs Product Quantization"
description: "How SQ8 and product quantization shrink Iceberg embedding columns 4x to 64x, how to store codes and codebooks, and what breaks."
date: 2026-10-27T09:00:00Z
tags: ["Apache Iceberg", "embeddings", "quantization", "vector search", "Parquet"]
canonical: https://iceberglakehouse.com/posts/quantized-embeddings-iceberg-sq8-pq/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/quantized-embeddings-iceberg-sq8-pq/).

# Storing Quantized Embeddings in Apache Iceberg: Scalar 8-Bit Codes vs Product Quantization

A 1,536-dimension embedding stored as 32-bit floats takes 6,144 bytes. That number looks harmless on one row. Multiply it by a billion rows and the embedding column alone is about 6.1 TB before any other field in the table. It is almost always the widest column in the table, it compresses badly, and every similarity scan has to read all of it.

Teams that keep embeddings in Apache Iceberg tables hit this wall at a predictable point. The first few million vectors are fine. Somewhere past a few hundred million, the scans slow down, storage bills climb, and someone suggests moving the vectors into a dedicated vector database. Before you do that, there is a cheaper move. You can shrink the vectors.

Quantization replaces each float with a smaller code. Scalar quantization to 8 bits (SQ8) cuts the column by 4x. Product quantization (PQ) cuts it by 16x to 64x, depending on how you configure it. Both are well understood techniques from the vector search world. What is less understood is how to store the codes, the parameters, and the codebooks in an Iceberg table so that the table stays correct, readable by multiple engines, and safe to evolve.

This article covers the storage side of that problem. It explains both methods from first principles, maps them onto the types Iceberg and Apache Parquet support today, walks through a working pipeline in Python, and lists the failure modes I watch for before trusting quantized search in production.

## Why the Embedding Column Is the Expensive One

Start with the arithmetic, because it drives every decision that follows.

An embedding is a fixed-length array of numbers. Common sizes are 384, 768, 1,024, 1,536, and 3,072 dimensions. Each dimension is usually stored as a 32-bit float (float32), which is 4 bytes. The per-row cost is the dimension count times 4.

| Dimensions | float32 bytes per row | 100 million rows | 1 billion rows |
|---|---|---|---|
| 384 | 1,536 | 154 GB | 1.5 TB |
| 768 | 3,072 | 307 GB | 3.1 TB |
| 1,536 | 6,144 | 614 GB | 6.1 TB |
| 3,072 | 12,288 | 1.2 TB | 12.3 TB |

Compare that to the rest of a typical document table. A document ID, a tenant ID, a timestamp, a short title, and a handful of metadata fields fit in a few hundred bytes. The embedding column is often 90 percent of the table by volume.

Compression does not rescue you here. Parquet's general compression codecs, such as ZSTD and Snappy, work by finding repeated byte patterns. The low-order bits of a float32 embedding look close to random. Dictionary encoding fails for the same reason, since almost no two values repeat. In practice, raw float embeddings shrink by a small fraction under compression, not by the multiples you see on string or integer columns.

Parquet does have one encoding aimed at floating point data. BYTE_STREAM_SPLIT rearranges the bytes of each value into separate streams, so all the first bytes sit together, then all the second bytes, and so on. The high-order bytes (sign and exponent) repeat far more than the low-order ones, so a codec downstream finds more to work with. It helps. It does not change the order of magnitude.

The second cost is scan time. A brute-force similarity search reads every vector it compares. If a query filters down to 50 million candidate rows of 1,536 dimensions, the engine reads about 307 GB of embedding data for that query. Even at several gigabytes per second of throughput, that is minutes, not milliseconds.

So the column is large, it resists compression, and it sits on the hot path of every vector query. Those three facts make it the right target for a lossy encoding that trades a small amount of accuracy for a large reduction in bytes.

## What Iceberg and Parquet Can Hold Today

Before choosing a quantization scheme, you need to know which physical shapes the table format accepts. This is where a lot of design documents go wrong.

Iceberg's primitive types include `int` (32-bit), `long` (64-bit), `float`, `double`, `decimal`, `string`, `binary`, and `fixed(L)`, along with date, time, and timestamp types. Format version 3 added `variant`, geospatial types, and nanosecond timestamps. There is no 8-bit integer type in Iceberg. There is no 16-bit integer type either.

That matters for SQ8. The natural representation of an 8-bit code is a list of 8-bit integers. Iceberg cannot express that directly. If you write `list<int>`, each code takes 4 bytes in the logical model, and you have thrown away the savings at the type level, even if Parquet's encodings claw some of it back on disk.

The type that fits is `fixed(L)`. It holds exactly L bytes per value. Iceberg maps `fixed(L)` to Parquet's `FIXED_LEN_BYTE_ARRAY` physical type with the same length. A 1,536-dimension SQ8 vector becomes a `fixed(1536)` value. A PQ code with 96 sub-codes of one byte each becomes a `fixed(96)` value. The bytes are opaque to the table format. Their meaning comes from the quantization parameters you store alongside them.

On the Apache Arrow side, `fixed(L)` reads as `FixedSizeBinary(L)`. An engine that wants to compute on the codes reinterprets that buffer as a run of unsigned 8-bit integers. That reinterpretation is zero-copy, because the bytes in memory are already laid out the way an `uint8` array expects.

Float embeddings themselves are usually stored today as `list<float>`. That type allows any length and allows nulls inside the list, which is why the Iceberg community has been discussing a first-class vector type. A dev list proposal opened in July 2026, a tracking issue exists as apache/iceberg #18297, and the question of how quantized representations fit was raised early in that discussion. Nothing in this article depends on how that debate resolves. The storage patterns below work with types that every Iceberg engine reads today. If you want the background on the vector type itself, the companion piece on DataLakehouseHub, "[Iceberg Is Getting a Vector Type, and Parquet Decides What It Looks Like](https://datalakehousehub.com/blog/iceberg-native-vector-type/)," covers the spec debate in detail. This article covers the compressed representation that sits beside or in place of those float columns.

One more detail on Parquet. BYTE_STREAM_SPLIT was originally limited to FLOAT and DOUBLE. Later revisions of the Parquet format extended it to other fixed-width types, including `FIXED_LEN_BYTE_ARRAY`. Whether a given writer uses it for a given column depends on the writer's configuration. Check your writer before you assume it.

## Scalar Quantization to 8 Bits

Scalar quantization treats each dimension on its own. For every dimension, you learn a range, then map each float in that range to one of 256 integer levels.

The procedure has three steps.

First, compute statistics on a training sample. For each dimension d, record a minimum and a maximum. Many implementations use percentiles, such as the 0.1th and 99.9th, rather than the true extremes. A single outlier in one dimension otherwise stretches the range and wastes most of the 256 levels on empty space.

Second, compute a scale for each dimension: `scale_d = (max_d - min_d) / 255`.

Third, encode every value: `code = round((x - min_d) / scale_d)`, clipped to the range 0 through 255. Decoding reverses it: `x_hat = min_d + code * scale_d`.

The parameters are small. For a 1,536-dimension model you store 1,536 minimums and 1,536 scales, which is 12 KB of float32 values. That is a rounding error next to the table.

The savings are exactly 4x on the vector column. A 6,144-byte vector becomes 1,536 bytes. A billion rows drop from about 6.1 TB to about 1.5 TB.

The accuracy cost is usually small. Modern text embedding models spread information across many dimensions, and each dimension tolerates a step size of 1/255 of its range well. Cosine similarity computed on decoded SQ8 vectors tracks the float32 result closely for most retrieval workloads. "Usually" and "most" are the honest words there. The only way to know for your model and your data is to measure recall against exact search, which the operational section covers.

SQ8 has two properties worth calling out.

It is simple to compute on. A distance kernel that works on uint8 values runs well on vector instructions, since a single 512-bit register holds 64 codes at once. You can compute approximate dot products directly on codes, then correct with the per-dimension parameters, without decoding to floats first.

It is local. Each dimension's code depends only on that dimension's value and that dimension's parameters. There is no training step beyond computing ranges. That makes SQ8 cheap to retrain and easy to reason about when something drifts.

Its limit is the ceiling on compression. One byte per dimension is the floor for scalar codes at this precision. If 4x is not enough, you have to stop treating dimensions independently.

## Product Quantization

Product quantization gets more compression by encoding groups of dimensions together.

The method splits each D-dimension vector into M contiguous sub-vectors of D/M dimensions each. For a 1,536-dimension vector and M = 96, each sub-vector has 16 dimensions.

For each of the M sub-vector positions, you train a small codebook with k-means clustering. With 8 bits per sub-code, each codebook holds 256 centroids. Each centroid is a 16-dimension float vector in this example.

Encoding a vector is then a lookup. For each of its 96 sub-vectors, find the nearest of the 256 centroids in that position's codebook and record that centroid's index. The result is 96 indexes, each one byte. The whole vector is now 96 bytes.

That is 64x smaller than float32. A billion 1,536-dimension vectors drop from 6.1 TB to about 96 GB, which fits comfortably in the memory of a single large machine.

The codebooks are larger than SQ8's parameters but still small. Each of the 96 codebooks holds 256 centroids of 16 floats, so the total is 96 × 256 × 16 × 4 bytes, or about 1.5 MB. The total does not depend on M for a fixed D and fixed 8-bit codes: it is always 256 × D × 4 bytes.

The accuracy cost is real and depends heavily on M. Fewer sub-vectors means more compression and more error. More sub-vectors means less compression and less error. M = 96 for 1,536 dimensions is a common middle setting. M = 192 gives 192-byte codes and better accuracy. M = 48 gives 48-byte codes and noticeably worse accuracy for most text models.

PQ also enables a fast distance trick called asymmetric distance computation (ADC). The query stays in full precision. Before scanning, you compute the distance from each of the query's M sub-vectors to all 256 centroids in the matching codebook. That builds an M × 256 lookup table. The approximate distance from the query to any stored vector is then the sum of M table lookups, one per sub-code. No decoding happens. For M = 96, scoring a candidate costs 96 small lookups and additions instead of 1,536 multiply-adds.

That speedup is why PQ codes are the backbone of many approximate nearest neighbor indexes. The difference in this article is that the codes live in an open table, not inside a proprietary index file.

## SQ8 and PQ Side by Side

| Property | Scalar 8-bit (SQ8) | Product quantization (8-bit sub-codes) |
|---|---|---|
| Bytes per 1,536-dim vector | 1,536 | M (96 for M = 96) |
| Compression vs float32 | 4x | 16x to 64x typical |
| Training | Per-dimension ranges | k-means per sub-space |
| Parameters stored | 2 × D floats (about 12 KB) | 256 × D floats (about 1.5 MB) |
| Iceberg type for codes | `fixed(D)` | `fixed(M)` |
| Accuracy loss | Small for most text models | Moderate, tunable with M |
| Distance on codes | Integer dot product plus correction | Lookup-table sum (ADC) |
| Retraining cost | Cheap | Moderate, needs a fresh k-means run |

The usual pattern in production pairs the two ideas with a full-precision copy. Search runs on compressed codes to produce a shortlist. The shortlist is re-scored against exact vectors. Quantization handles the bulk of the scan. Exact vectors handle the final ordering. The re-scoring step reads only a few hundred or a few thousand full vectors per query, so its cost stays bounded no matter how large the table grows.

## Where the Codes, Parameters, and Codebooks Live

Codes are useless without the parameters that produced them. This is the part of the design that decides whether the table stays correct over time.

There are three tempting places to put quantization parameters. Two of them break.

The first tempting place is Parquet's footer. Parquet files support key-value metadata in the file footer, and it is technically possible to stash a codebook there. Do not. Iceberg does not carry Parquet footer metadata through its own metadata layer. Compaction rewrites data files, and the rewritten files do not inherit custom footer entries unless the writer knows to copy them. Engines ignore the entries. Every file carries its own copy, so a single wrong file silently poisons a fraction of results. The parameters become invisible to everyone who did not write them.

The second tempting place is a table property. Iceberg table properties are string key-value pairs in table metadata. A small SQ8 parameter set fits in a property as a base64 string. A 1.5 MB PQ codebook does not belong there. Table properties live in the metadata JSON that every reader loads at planning time, and bloating that file slows down every query against the table, including the ones that never touch embeddings. Properties also hold only one current value, so they cannot describe a table that contains codes from two codebook versions during a migration.

The third place, and the one I recommend, is a separate Iceberg table for codebooks with an explicit version key on every row of the data table.

The data table gets two columns for quantization: the code itself, and a `codebook_id` that names the parameter set used to produce it. The codebook table holds one or more rows per codebook version, with the model name, the dimension count, the method (SQ8 or PQ), M, the training date, and the parameters themselves as a binary blob or as one row per sub-space.

This design has several properties that the other two lack. The codebook is a first-class table, so it gets snapshots, time travel, and access control like any other table. A reader can join codes to their codebook by ID. Multiple codebook versions coexist, so you can re-encode the data table gradually, partition by partition, without a stop-the-world cutover. And the version stored on each row makes it impossible to decode a code with the wrong codebook by accident, as long as readers respect the join.

You can still put a pointer in a table property, such as `embedding.codebook.current = pq-v3`, so writers know which version to use for new rows. The property names the version. The codebook table holds the bytes.

## A Working Pipeline in Python

The example below trains both an SQ8 parameter set and a PQ codebook, encodes a batch of embeddings, and appends the results to Iceberg tables through PyIceberg. It uses NumPy for SQ8, the Faiss library's `ProductQuantizer` class for PQ, and PyArrow to build the batches.

```python
import numpy as np
import pyarrow as pa
import faiss
from pyiceberg.catalog import load_catalog
from pyiceberg.schema import Schema
from pyiceberg.types import (
    NestedField, StringType, LongType, FixedType, IntegerType, BinaryType
)

D = 1536          # embedding dimensions
M = 96            # PQ sub-vectors
NBITS = 8         # bits per PQ sub-code

# 1. Training sample: float32 embeddings, shape (n, D)
train = np.load("train_sample.npy").astype("float32")

# 2. SQ8 parameters, using percentiles to resist outliers
lo = np.percentile(train, 0.1, axis=0).astype("float32")
hi = np.percentile(train, 99.9, axis=0).astype("float32")
scale = np.maximum((hi - lo) / 255.0, 1e-12).astype("float32")

def sq8_encode(x):
    q = np.rint((x - lo) / scale)
    return np.clip(q, 0, 255).astype("uint8")

# 3. PQ codebook
pq = faiss.ProductQuantizer(D, M, NBITS)
pq.train(train)
centroids = faiss.vector_to_array(pq.centroids).astype("float32")

# 4. Encode a production batch
batch = np.load("batch.npy").astype("float32")
ids = np.load("batch_ids.npy")
sq8_codes = sq8_encode(batch)              # shape (n, 1536), uint8
pq_codes = pq.compute_codes(batch)         # shape (n, 96), uint8

# 5. Write to Iceberg
catalog = load_catalog("lakehouse")

docs_schema = Schema(
    NestedField(1, "doc_id", LongType(), required=True),
    NestedField(2, "codebook_id", StringType(), required=True),
    NestedField(3, "emb_sq8", FixedType(D), required=False),
    NestedField(4, "emb_pq", FixedType(M), required=False),
)
books_schema = Schema(
    NestedField(1, "codebook_id", StringType(), required=True),
    NestedField(2, "method", StringType(), required=True),
    NestedField(3, "dims", IntegerType(), required=True),
    NestedField(4, "subvectors", IntegerType(), required=False),
    NestedField(5, "params", BinaryType(), required=True),
)

docs = catalog.create_table_if_not_exists("rag.doc_embeddings_q", schema=docs_schema)
books = catalog.create_table_if_not_exists("rag.embedding_codebooks", schema=books_schema)

books.append(pa.table({
    "codebook_id": ["sq8-v1", "pq-v1"],
    "method": ["sq8", "pq"],
    "dims": pa.array([D, D], pa.int32()),
    "subvectors": pa.array([None, M], pa.int32()),
    "params": [np.concatenate([lo, scale]).tobytes(), centroids.tobytes()],
}))

docs.append(pa.table({
    "doc_id": pa.array(ids, pa.int64()),
    "codebook_id": ["pq-v1"] * len(ids),
    "emb_sq8": pa.array([r.tobytes() for r in sq8_codes], pa.binary(D)),
    "emb_pq": pa.array([r.tobytes() for r in pq_codes], pa.binary(M)),
}))
```

Here is what each part does and why.

The constants at the top fix the shape. D must match the embedding model. M must divide D evenly, since PQ splits vectors into equal sub-vectors. NBITS = 8 makes each sub-code one byte, which keeps the code a clean byte string.

The SQ8 block computes percentile ranges per dimension rather than raw minimum and maximum. The 0.1 and 99.9 percentile choice clips a small tail of values to the edges of the range in exchange for finer steps everywhere else. The `np.maximum` call guards against a dimension with zero range, which otherwise divides by zero.

The PQ block uses Faiss's `ProductQuantizer`, which trains one k-means codebook per sub-space. `vector_to_array` pulls the centroids out as a flat float32 array of 256 × D values, which is the exact byte layout you store.

The encoding step produces two code arrays. In practice you choose one method for a given table. The example writes both so you can compare them on your own data before committing.

The schemas use `FixedType(D)` for SQ8 and `FixedType(M)` for PQ. Those become `fixed(1536)` and `fixed(96)` in Iceberg and `FIXED_LEN_BYTE_ARRAY` in Parquet. PyArrow's `pa.binary(n)` with an explicit length creates the matching fixed-size binary array.

The codebook table stores parameters as a `binary` blob with enough descriptive fields to decode it: the method, the dimension count, and the sub-vector count. The data table stores the `codebook_id` on every row.

The `create_table_if_not_exists` calls make the script safe to rerun. In a real deployment, create both tables once with a partition spec that fits your access pattern, such as partitioning the data table by tenant or collection, and let the pipeline only append.

A real pipeline adds two things this example skips. It writes the float32 originals somewhere, either in the same table as a separate column or in a colder companion table keyed by `doc_id`, so re-scoring and re-training stay possible. And it writes codes through the same transaction that writes the document rows, so a reader never sees a document without its vector.

## Searching the Codes Inside an Engine

Storing codes is half the job. The other half is computing distances on them without dragging every byte back into a Python process.

For SQ8, the simplest path is decoding inside the engine. A query reads the `fixed(1536)` column as raw bytes, reinterprets them as uint8, applies `lo + code * scale` per dimension, and computes cosine similarity against the query vector. Engines with vectorized execution over Arrow buffers handle this well. Arrow's columnar layout means the codes for thousands of rows sit in one contiguous buffer, and a kernel can walk that buffer with SIMD (single instruction, multiple data) instructions.

A faster SQ8 path skips decoding. Because decoding is linear per dimension, a dot product between a float query and a decoded vector expands into a dot product between a transformed query and the raw codes, plus a constant. Precompute the transformed query once, then run an integer-friendly dot product over the codes. This is the same idea that makes int8 inference fast in machine learning runtimes.

For PQ, the ADC method described earlier is the natural fit. The engine builds the M × 256 table from the query and the codebook, then scores each row by summing M lookups. This needs either a user-defined function or a native kernel that understands PQ codes. Few general-purpose SQL engines ship one out of the box today, so teams usually implement ADC in a Python or Rust user-defined function, or score codes in a small service that reads the table through Arrow.

Either way, the shape of a quantized query is the same three stages.

Filter first. Use ordinary predicates on partition columns and metadata, such as tenant, language, date range, or document type, to shrink the candidate set. Iceberg's partition pruning and file-level statistics do this before a single vector is read. This is the lakehouse's structural advantage over a standalone vector store, and quantization does not change it.

Scan codes second. Score every surviving candidate on its compressed code. Keep the top K × R rows, where K is the number of results the caller wants and R is a re-ranking factor, often between 4 and 20.

Re-score third. Fetch full-precision vectors for the shortlist by `doc_id`, compute exact similarity, and return the top K. The shortlist is small, so this step costs little even against a cold table.

The re-ranking factor R is your main accuracy dial at query time. A larger R recovers more of the recall that quantization lost, at the cost of reading more full vectors.

## A Worked Sizing Example

Numbers make the tradeoffs concrete, so here is one full sizing pass for a realistic retrieval corpus.

Assume 800 million document chunks, embedded with a 1,536-dimension model. Queries filter by tenant first. The largest tenant holds 60 million chunks. The service needs the top 10 results with recall at 10 above 0.95 against exact search.

The float32 column costs 800 million × 6,144 bytes, or about 4.9 TB. A query against the largest tenant scans 60 million vectors, which is about 369 GB of embedding bytes. At a sustained 5 GB per second of scan throughput across a cluster, that one query spends over a minute just reading vectors.

With SQ8, the column drops to about 1.2 TB. The largest-tenant scan reads about 92 GB. At the same throughput, that is under 20 seconds. That is still slow for interactive search, though it is fine for batch jobs such as nightly deduplication or clustering.

With PQ at M = 96, the column drops to about 77 GB for the whole corpus. The largest-tenant scan reads 5.8 GB of codes. That is about one second at the same throughput, and the entire largest tenant fits in memory on one mid-sized machine, which pushes scoring time down further.

Now add re-scoring. With K = 10 and R = 10, each query fetches 100 full-precision vectors, about 614 KB. That cost is negligible next to the scan.

The remaining question is whether PQ at M = 96 and R = 10 clears the 0.95 recall bar. You cannot answer that from arithmetic. You answer it by running the benchmark in the next section. If it falls short, raise R first, since that only adds re-scoring cost. If raising R to 20 or 30 still falls short, move to M = 192, which doubles the code column to about 154 GB and usually recovers most of the gap.

The general lesson from this exercise: SQ8 solves a storage problem, and PQ solves a latency problem. If your bottleneck is the bill, SQ8 is often enough. If your bottleneck is the time it takes to read candidates, PQ is the tool.

## Measuring Recall in Practice

Every claim about quantization accuracy reduces to one measurement: what fraction of the true nearest neighbors does the quantized search find? The script below computes that for PQ with re-scoring, using the same Faiss quantizer from the pipeline.

```python
import numpy as np

def normalize(x):
    return x / np.linalg.norm(x, axis=1, keepdims=True)

base = normalize(np.load("eval_base.npy").astype("float32"))     # (N, D)
queries = normalize(np.load("eval_queries.npy").astype("float32"))  # (Q, D)
K, R = 10, 10

# Exact top-K by cosine similarity
exact = np.argsort(-queries @ base.T, axis=1)[:, :K]

# PQ approximate scores via decoded vectors
codes = pq.compute_codes(base)
approx_base = pq.decode(codes)
approx_scores = queries @ approx_base.T
shortlist = np.argsort(-approx_scores, axis=1)[:, :K * R]

# Re-score the shortlist with full precision
recalls = []
for qi in range(len(queries)):
    cand = shortlist[qi]
    exact_scores = base[cand] @ queries[qi]
    top = cand[np.argsort(-exact_scores)[:K]]
    recalls.append(len(set(top) & set(exact[qi])) / K)

print(f"recall@{K} with R={R}: {np.mean(recalls):.3f}")
```

The script normalizes vectors first, so the dot product equals cosine similarity. It computes the exact top K by brute force, which is the ground truth. It then scores every base vector on its decoded PQ approximation, keeps a shortlist of K × R candidates, re-scores those candidates with the original floats, and checks how many of the final K match the exact answer.

Decoding with `pq.decode` is the slow but simple way to approximate ADC for an offline evaluation. It produces the same ranking as ADC, because both compute distances against the same centroids. Keep the evaluation base to a few hundred thousand vectors so the exact search stays cheap on one machine.

Run this for several values of M and R and you have the curve the operational section asks for. Save the results next to the codebook row in the codebook table, so every codebook version carries its own measured recall.

## Choosing a Method by Workload

The right method depends on what the table does more than on how large it is.

**Interactive retrieval for RAG.** Retrieval-augmented generation (RAG) systems run many small queries with tight latency budgets and a tenant or collection filter. PQ with re-scoring fits this shape best. The codes for the filtered slice stay in memory, ADC scoring is fast, and re-scoring guarantees the final order matches exact search closely.

**Batch similarity jobs.** Deduplication, clustering, and nearest-neighbor joins run over large slices of the table on a schedule. Latency matters less than throughput and simplicity. SQ8 fits well here. It is cheap to compute on, easy to decode inside an engine, and its small accuracy loss rarely changes a clustering outcome.

**Analytics on embeddings.** Some teams compute centroids per segment, track drift over time, or project embeddings to two dimensions for inspection. These jobs need values close to the originals. Keep them on float32 or SQ8 and leave PQ out of the path.

**Archive tiers.** Old documents that are rarely searched still need to be searchable. PQ codes in the hot table plus float32 originals in a cold table keep search possible at a small fraction of the storage cost. Re-scoring reads from the cold tier only for the shortlist.

Many tables serve more than one of these workloads. In that case, store SQ8 codes and PQ codes together, as the pipeline example does. The extra 1,536 bytes per row for SQ8 is cheap next to the float column you no longer keep hot, and each workload reads only the column it needs, since Parquet's columnar layout lets a reader skip columns it does not request.

## Failure Modes

Quantization adds a model to your table. Models drift, get retrained, and fail in ways plain columns do not. These are the failures worth planning for.

**Decoding with the wrong codebook.** This is the most damaging failure because it produces plausible garbage. A PQ code decoded with a different codebook still yields a valid-looking vector. Similarity scores still come back in a normal range. Results are simply wrong. The defense is the `codebook_id` column on every row and a hard rule that every reader joins on it. A reader that assumes the current codebook applies to all rows is a bug waiting for the first retrain.

**Embedding model changes without a codebook change.** If the upstream model changes, even a minor version, the distribution of values shifts. SQ8 ranges stop matching, and values clip at the edges. PQ centroids stop matching, and quantization error rises. Store the model name and version in the codebook table and refuse to encode vectors from a model the codebook was not trained on.

**Training on an unrepresentative sample.** k-means on a sample drawn from one tenant, one language, or one week produces centroids that fit that slice and serve everything else poorly. Sample across the partitions the table actually serves. Re-check recall per segment, not just in aggregate, since an average can hide one segment that collapsed.

**Outlier dimensions in SQ8.** A few dimensions with long tails stretch their ranges if you use raw extremes. Most values in those dimensions then land in a handful of levels. Percentile ranges fix most of this. Check the histogram of codes per dimension after training. A dimension where 90 percent of codes sit in five levels is telling you its range is wrong.

**Silent loss of full-precision vectors.** Teams sometimes drop the float column to realize the full savings, then discover they cannot retrain codebooks or re-score shortlists. Keep originals somewhere, even in a colder storage tier. The cost of a cold copy is small next to the cost of re-embedding a billion documents.

**Compaction that drops custom metadata.** If any part of your design relies on Parquet footer metadata, compaction breaks it. This is one more reason the codebook belongs in its own table.

**Mixed codebooks inside a single scan.** During a gradual re-encode, one query touches rows from two codebook versions. That is fine as long as the scoring path builds one ADC table per version and dispatches by `codebook_id`. It is a bug if the scoring path builds one table and applies it to everything.

## Operational Guidance

**Measure recall before you commit.** Pick a few thousand real queries. Compute the exact top 10 with float32 vectors. Compute the quantized top 10 with your chosen method, M, and R. Report recall at 10 as the fraction of exact results the quantized search found. Do this per tenant or per segment, not just once overall. Repeat it every time you retrain.

**Start with SQ8 unless storage pressure is severe.** SQ8 gives 4x, trains in seconds, and loses little accuracy for most text models. Move to PQ when 4x does not get the hot data into the storage or memory budget you need.

**Choose M by measuring, not by rule of thumb.** Try M = D/8, D/16, and D/32. Plot recall at your target R against bytes per vector. Pick the knee of the curve. For many 1,536-dimension models that lands between 96 and 192 bytes.

**Retrain on a schedule and on triggers.** Schedule a codebook check monthly. Trigger a retrain when recall on your benchmark drops below your threshold or when the embedding model version changes.

**Re-encode on a branch.** A codebook change rewrites the code column for every row. Do that work on an Iceberg branch, verify recall on the branch, then fast-forward main. Readers never see a half-encoded table, and you can abandon the branch if recall disappoints. The [Write-Audit-Publish pattern on IcebergLakehouse](https://iceberglakehouse.com/posts/write-audit-publish-iceberg-branches/) describes the mechanics of that gate in detail.

**Partition with retrieval in mind.** Most vector queries filter on tenant or collection first. Partitioning on those fields lets Iceberg prune whole files before the scan reaches the code column. Quantization reduces bytes per row. Partition pruning reduces rows. You want both.

**Keep the codebook table small and protected.** It is tiny, but it is load-bearing. Grant write access to the pipeline that trains codebooks and nobody else. Tag the snapshot that holds each production codebook so it survives snapshot expiration.

**Watch the shortlist fetch.** Re-scoring reads full vectors by `doc_id`. If the full-precision copy lives in a separate table, that read is a lookup by key. Sort or bucket that table by `doc_id` so the lookup touches few files.

## How Quantization Interacts With Table Maintenance

Quantized columns change how routine Iceberg maintenance behaves, and a few of those interactions are easy to miss.

**Adding a code column is cheap.** Iceberg tracks columns by field ID, so adding `emb_pq` to an existing table is a metadata-only schema change. No data files are rewritten. Existing rows read the new column as null until you backfill them. That lets you introduce quantization to a live table without downtime. Write new rows with codes immediately, then backfill old partitions in batches on a branch.

**Compaction preserves codes but not footers.** Rewriting data files with a compaction job copies the `fixed(L)` values exactly, since they are ordinary column data. It does not carry custom Parquet footer entries forward. This is the strongest practical argument for keeping parameters in a codebook table instead of in file metadata.

**Sort order matters less than you expect.** Sorting by an embedding column does nothing useful, since byte order has no relationship to similarity. Sort by the fields you filter on, such as tenant and collection, so file-level statistics prune well. The code column rides along.

**Snapshot expiration can remove history you need.** If you replace codes during a re-encode, the old codes survive only in older snapshots. Once those snapshots expire, rolling back to the previous codebook means re-encoding from the float originals. Tag the last snapshot before each re-encode with a retention long enough to cover your rollback window. Tag the codebook table's snapshots the same way.

**Row-level deletes stay simple.** Deleting a document deletes its row, codes included. With Iceberg v3 deletion vectors or v2 position deletes, the code column needs no special handling. This is one place where keeping vectors in the table beats a separate index, because there is no second system to keep in sync after a delete.

**Statistics on code columns are noise.** Writers compute minimum and maximum statistics for columns by default. On a binary code column those bounds carry no pruning value and only add metadata. Most writers let you limit metrics per column through table properties such as `write.metadata.metrics.column.<name>`. Setting the code columns to `none` keeps manifests lean.

## Where This Is Heading

Three threads are worth following.

The first is the native vector type. If Iceberg lands a first-class vector type with a fixed dimension and an element type, the float side of this design gets cleaner, because the type itself will enforce length. Whether a quantized variant becomes part of the type, or stays a convention like the one in this article, is still an open question in the community discussion.

The second is engine support for computing on codes. Integer dot products and lookup-table scoring are small kernels. As more engines add native vector functions over Arrow data, expect them to accept fixed-size binary codes with a codebook argument, rather than only float lists.

The third is better quantization. Methods that learn rotations before quantizing, and methods that quantize residuals after a first coarse pass, push accuracy up at the same byte budget. They all produce the same storage artifacts: a code per row and a parameter set per version. The storage pattern here holds regardless of which method wins.

## Conclusion

Quantization is the cheapest way to make large embedding columns tractable in an Iceberg table. SQ8 gives 4x with little accuracy loss and almost no operational overhead. PQ gives 16x to 64x with more tuning and a real codebook to manage. Both store cleanly as `fixed(L)` columns that every Iceberg engine reads today.

The part that decides success is not the math. It is where the parameters live. Keep codebooks in their own versioned Iceberg table, stamp every row with the `codebook_id` that produced it, keep full-precision vectors for re-scoring and retraining, and do every re-encode on a branch with a recall check before you publish.

Do that, and your vectors stay in open files, next to the rest of your data, under the same governance, at a fraction of the size.

## Keep Going

If this piece was useful, I have written a lot more on Apache Iceberg table design and the lakehouse patterns around it. *Architecting an Apache Iceberg Lakehouse* (Manning) covers table design, partitioning, and maintenance decisions like the ones in this article. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
