---
title: "Parquet SERIALIZED_VALUE: Storing Protobuf and FlatBuffers Messages with Their Schema"
description: "SERIALIZED_VALUE stores protobuf, FlatBuffers or Thrift bytes in Parquet with the schema once per file, so replay works without per-row descriptor overhead."
date: 2026-11-16T09:00:00Z
tags: ["Apache Parquet", "Protobuf", "Schema Design", "Apache Iceberg", "Encoding"]
canonical: https://iceberglakehouse.com/posts/parquet-serialized-value-logical-type/
---

> **Cross-posted.** This article's canonical home is [Alex Merced's Lakehouse Blog](https://iceberglakehouse.com/posts/parquet-serialized-value-logical-type/).

SERIALIZED_VALUE is a proposed Parquet logical type for BINARY columns that hold serialized messages such as protobuf, FlatBuffers or Thrift. It records the message format and, when the format has one, stores the schema in the file. Parquet never decodes the bytes, and readers that don't know the type still read plain BINARY.

Neelesh Salian proposed the type on the Apache Parquet dev list on November 11, 2026 ([thread](https://lists.apache.org/thread/5xn8o9rvrv1rsjs811t2gn0tkjq0zl02)). It started life as part of a larger proposal called WIRE. Following a suggestion from Micah Kornfield, Neelesh split out the logical type, since it stands on its own, and left projection into the serialized bytes for a later proposal once engines agree to use it. The proposal document includes a security section, added after earlier feedback. By November 14, the discussion had drawn a skeptical reply, two supporting replies, a tracking issue ([parquet-format #640](https://github.com/apache/parquet-format/issues/640)), and outreach threads to the Spark and Flink dev lists.

This article covers what the type records, why teams keep raw messages in Parquet at all, how it compares to the struct column people use today, and what an Iceberg mapping needs. It is a Parquet format piece. If you are deciding how to land event data in the lakehouse in the first place, start with [Schema Registries and Event Schemas](https://iceberglakehouse.com/posts/schema-registries-and-event-schemas/), which covers decoding events into columns on the way in. This article covers the opposite choice: keeping events as opaque serialized bytes, with enough schema in the file to decode them later.

## Why teams store raw messages instead of flattening them

The usual path for event data into a lakehouse is to decode it. A Kafka consumer reads protobuf or Avro messages, decodes each into fields using a schema registry, and writes those fields as Parquet columns. Every field becomes queryable. Column statistics, encodings, and compression all apply. For most analytics, that is the right design.

Some teams also keep the original bytes. Julien Le Dem, one of Parquet's creators, described the pattern on November 14. Services encode their RPCs and events as protobuf or Thrift, either because those formats already carry their traffic or because they need a schema to manage compatibility over time. Those messages flow through Kafka and land in Parquet. Early Parquet integrations only supported decomposing such messages fully into columns. In practice, people often end up storing the original value as a binary column, too.

He gave several reasons:

- **Size.** When messages are large, fully decomposing them into columns is not always efficient.
- **Unknown fields.** Protobuf and Thrift let a writer's schema include fields that a reader's schema version does not know. Decoding with the reader's schema drops them. Keeping the bytes keeps them.
- **Schema versions.** The reader's schema version is not always the writer's. Keeping the bytes with the right schema lets you decode with the correct version later.

Scott Haines added a concrete case from his time at Twilio. His team offloaded protobuf call records from Kafka to Parquet on HDFS for historical replay. They kept the original Kafka payload bytes in a struct with fields for timestamp, key, payload, topic, version, format, and the Java class used to decode the payload. Storing that class name in every row, across millions of events a minute, added real overhead. He noted the same overhead appears if you store a protobuf `FileDescriptorSet`, or a reference to a schema registry entry, in every row.

Replay is the strongest use case. If a decoding bug, a schema mapping mistake, or a new requirement means you need to reprocess historical events, the decoded columns are not enough. You need the original messages, and you need to know exactly how to decode them.

## What the annotation records

A Parquet logical type annotates a physical type with meaning. A `STRING` annotation tells readers that a `BYTE_ARRAY` column holds UTF-8 text. A `TIMESTAMP` annotation tells readers that an `INT64` holds time since the epoch. Readers that understand the annotation interpret the values. The bytes on disk do not change.

SERIALIZED_VALUE annotates a BINARY column, physically a `BYTE_ARRAY`, that holds serialized messages. Per the proposal, it records two things:

1. **The serialization format,** such as protobuf, FlatBuffers, or Thrift.
2. **The schema, for formats that have one.** For protobuf, that is the descriptor that defines the message type.

The schema is stored once per file, not once per row. That is the efficiency gain over the struct pattern Scott described.

Parquet itself never decodes the bytes. Encoding, compression, and page layout treat the column like any other binary column. The annotation exists so that a reader, or a tool built on top of a reader, can find the format and schema without out-of-band knowledge.

## Backward compatibility: unaware readers see BINARY

A new logical type is only safe if old readers handle it gracefully. Parquet has a rule for this. Neelesh pointed to the handling of unrecognized logical types in [parquet-format PR #606](https://github.com/apache/parquet-format/pull/606): a reader that does not know a logical type reads the column as its physical type. For SERIALIZED_VALUE, that means plain `BYTE_ARRAY`.

So a file written with the annotation is readable by every existing Parquet reader. Old readers see a binary column and return bytes. New readers see the format and schema and offer to decode. No reader fails, and no data is lost.

This is the same compatibility pattern that made recent logical type additions safe to roll out. It is why Julien described the type as useful to people who need it while not inconvenient to people who do not.

## The objection: why not a struct?

Matt Topol, an Apache Arrow committer, raised the main objection on November 13. He said he still does not understand the use case. In his view, these messages are nearly always intermediate data passed between systems, not something you write raw to Parquet for storage. He called it a fairly niche case that a struct column handles for the readers and writers that care, rather than something that belongs in the format and that every implementation has to handle. He asked for a better explanation of the use case and how common it is before adding a type that current types can already model.

That is a fair challenge, and every new logical type should face it. Parquet's value comes partly from its small, stable set of types. Each addition costs every implementation some work, even if the work is only "read it as BINARY."

### The answer in the thread

Neelesh replied on November 14 that Scott's and Julien's examples match the use cases in the proposal. He agreed that a struct can hold the data and pointed out that Scott's setup is a good example of what that looks like. He then named the two costs the type is meant to remove:

- **Repeated schema references.** The struct pattern stores the format and schema reference in every row. At high event rates, that is measurable overhead, which Scott saw directly.
- **Private layouts.** Every team designs its own struct. Other readers cannot tell what the bytes are without knowing that team's convention.

SERIALIZED_VALUE stores each descriptor once per file and gives every reader a standard place to find the format and schema. Neelesh added a comparison with a struct column to the proposal's alternatives section.

Here is how the two approaches compare:

| Question | Struct column convention | SERIALIZED_VALUE annotation |
| --- | --- | --- |
| Where the format lives | A string field in every row | Once, in the column's logical type |
| Where the schema lives | A class name, descriptor, or registry reference in every row, or nowhere | Once per file, for formats that have a schema |
| What other readers understand | Nothing without the team's documentation | The format and schema, from the file alone |
| Effect on old readers | None, it is an ordinary struct | None, they read plain BINARY |
| Cost to implementations | None | Each implementation that wants to decode must add support |
| Works today | Yes | No, proposal stage |

The table makes the trade explicit. A struct costs nothing in the format and pushes all the cost to every team that uses it. The annotation costs a little in every implementation and removes the per-row overhead and the private conventions.

## What you can do today, and what changes

Until the type exists, teams that keep raw messages approximate it. A common approach stores the bytes in a binary column and puts the schema in Parquet's file-level key-value metadata. Here is that pattern with protobuf and PyArrow:

```python
import pyarrow as pa
import pyarrow.parquet as pq
from google.protobuf import descriptor_pb2

from events_pb2 import CallSummary  # generated protobuf class

def write_raw_events(messages, path):
    # Serialize each message to bytes. Parquet stores these as-is.
    payloads = [m.SerializeToString() for m in messages]

    # Capture the schema once: a FileDescriptorSet holding the .proto definition.
    fds = descriptor_pb2.FileDescriptorSet()
    CallSummary.DESCRIPTOR.file.CopyToProto(fds.file.add())

    schema = pa.schema(
        [pa.field("payload", pa.binary())],
        metadata={
            b"payload.format": b"protobuf",
            b"payload.message_type": CallSummary.DESCRIPTOR.full_name.encode(),
            b"payload.descriptor": fds.SerializeToString(),
        },
    )
    table = pa.table({"payload": payloads}, schema=schema)
    pq.write_table(table, path, compression="zstd")
```

`SerializeToString` turns each protobuf message into bytes. The `FileDescriptorSet` captures the message definition in protobuf's own binary schema format, and `CopyToProto` copies the generated class's file descriptor into it. The schema metadata stores the format, the full message type name, and the serialized descriptor once in the file footer. The data column holds only the payloads. Note that a real `FileDescriptorSet` also needs the descriptors of any imported `.proto` files, which this sketch leaves out. The metadata keys here are an invented convention, which is exactly the problem.

That approach removes the per-row overhead. It does not solve the second problem. The metadata keys are private. Another team, another tool, or an engine has no way to know that `payload.descriptor` holds a protobuf schema for the `payload` column. SERIALIZED_VALUE moves that information into a defined place in the format, attached to the column, where every reader looks for it.

## Reading the payload back: replay in practice

Storing the bytes is half the job. The point is to decode them later, possibly years later, with nothing but the file. Here is the read side of the workaround shown above, using the same metadata keys.

```python
import pyarrow.parquet as pq
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

def read_raw_events(path):
    table = pq.read_table(path)
    meta = table.schema.metadata

    # Rebuild the message class from the descriptor stored in the file.
    fds = descriptor_pb2.FileDescriptorSet.FromString(meta[b"payload.descriptor"])
    pool = descriptor_pool.DescriptorPool()
    for file_proto in fds.file:
        pool.Add(file_proto)
    desc = pool.FindMessageTypeByName(meta[b"payload.message_type"].decode())
    MessageClass = message_factory.GetMessageClass(desc)

    for raw in table.column("payload").to_pylist():
        yield MessageClass.FromString(raw)
```

The function reads the file and its schema metadata. It parses the stored `FileDescriptorSet` and loads each file descriptor into a fresh descriptor pool, which is protobuf's registry of known message types. It looks up the message type by the full name stored in the metadata and builds a message class from it with `GetMessageClass`. Each payload then decodes with `FromString`. The code never imports the generated `events_pb2` module, so it works even after the original code is gone.

That independence is the whole value of storing the schema with the data. A replay job written in two years does not need to find the right version of a generated class in an old repository. It reads the schema the writer used from the file.

Two cautions apply. Decode only files from trusted writers, for the reasons in the security section. And when your current schema registry has a newer version of the same message, decide deliberately which schema to use. The embedded one tells you what the writer meant. The registry one tells you what the field names mean today.

## FlatBuffers and Thrift are different from protobuf

The proposal names protobuf, FlatBuffers, and Thrift. They store schemas differently, which affects what "stores the schema in the file" means for each.

**Protobuf** has a standard binary schema format, the `FileDescriptorSet`, produced by the protobuf compiler. It is self-contained once you include imported files, and every protobuf runtime can load it. That makes protobuf the easiest case.

**FlatBuffers** compiles schemas from `.fbs` files and supports a binary schema form, `.bfbs`, used by its reflection API. FlatBuffers is designed for reading fields without unpacking the whole buffer, which makes it a natural fit for future projection work. Readers that want to decode generically need the reflection schema.

**Thrift** defines messages in an interface definition language, and its binary encodings carry field IDs and types on the wire but not names. Thrift has no single standard binary schema format in the way protobuf does. Storing "the schema" for Thrift likely means storing the IDL text or a compiled representation, and the proposal's format-specific details decide which.

The annotation records which format a column uses so a reader knows which of these rules applies. A generic decoding tool that supports all three needs format-specific code for each.

## When to keep raw messages at all

Keeping raw messages is not free, and the new type does not change that. Before adding a payload column to your event tables, check that you need one.

**Keep raw messages when replay is a real requirement.** If downstream decoding logic changes often, or regulations require reproducing exactly what a system received, the original bytes are the only complete record.

**Keep them when forward compatibility matters.** If producers add fields faster than your decoding pipeline adopts them, raw bytes preserve the new fields until you catch up.

**Keep them when full decoding is too expensive.** Large, deeply nested messages with fields nobody queries cost more to flatten than to store.

**Skip them when decoded columns are enough.** If your analytics, audits, and reprocessing all work from decoded columns, a payload column only adds storage. Many event tables fall in this group.

If you keep them, set a retention policy that matches the replay window you actually need, and design your tables so that retention is easy to apply.

## A table design for decoded plus raw

The cleanest way to keep both forms on Iceberg is two tables, not one wide table.

**The decoded table** holds the fields analysts query, partitioned for analytics, with the retention your analytics require. It is the table your semantic layer and dashboards read.

**The raw table** holds the payload column plus the identifiers you need to join back: event ID, event time, source topic, partition, and offset. Partition it by day. Its retention matches your replay window, and expiring it means deleting old partitions, a metadata operation in Iceberg that does not rewrite the decoded table.

The two tables share event IDs, so a replay job reads raw payloads for a time range, decodes them with the stored schema, and rewrites the matching rows in the decoded table. Keeping the payload out of the decoded table also keeps wide scans fast. Even though Parquet skips unread columns, a separate table means maintenance jobs such as compaction never rewrite large payload bytes when they only need to reorganize the decoded data.

If SERIALIZED_VALUE lands, it applies to the payload column in the raw table. Nothing else in the design changes. That is a good property for a design built ahead of a proposal: it works today with the metadata workaround, and it adopts the standard type later by changing how one column is annotated.

## The security section

The proposal includes a security section, added after feedback on the earlier WIRE thread. The details are in the proposal document, but the risks are worth understanding from first principles, because they apply to the workaround above as much as to the proposed type.

**Untrusted schemas.** A file that carries its own schema tells the reader how to interpret bytes. If the file comes from an untrusted source, so does the schema. A reader that decodes automatically using an embedded schema is trusting the file's author.

**Decoder risk.** Deserializers for formats such as protobuf and Thrift are complex code that parses attacker-controllable input. Bugs in deserializers are a known class of vulnerability. Decoding bytes from untrusted files with an embedded schema exercises that code on hostile input.

**Resource exhaustion.** A crafted message can be valid but enormous when decoded, with deep nesting or huge repeated fields. Decoding it can exhaust memory.

**Schema confusion.** A reader that uses an embedded schema instead of a known-good one can decode bytes into the wrong structure, producing plausible but wrong data.

Parquet's choice to never decode the bytes itself keeps these risks out of the format library. They move to whichever layer chooses to decode. That layer should decode only files from trusted writers, prefer known schemas from a registry over embedded ones when they disagree, and set limits on decoded size.

## What stays in WIRE: projection

The original WIRE proposal went further than an annotation. It included projection: reading individual fields out of serialized messages without decoding the whole message, and potentially pushing filters down to them. Neelesh's split keeps that for a follow-up proposal, once one or more engines agree to use it.

Projection is where most of the value and most of the complexity live. Reading one field from a million protobuf messages without deserializing each fully needs format-specific parsing in the reader, and pushing filters into serialized bytes needs engine support. Doing that well in every Parquet implementation is a large commitment, which is why gating it on engine interest is sensible.

The logical type is the foundation. Without a standard way to say "this column is protobuf with this schema," projection has nothing to build on. With it, engines can experiment with projection on their own, and the community can standardize what works.

Neelesh started threads on the Spark and Flink dev lists to ask whether those engines plan to support the type. Engine buy-in decides whether the type gets used beyond a few teams.

## What an Iceberg mapping needs

Iceberg sits on top of Parquet, and a new Parquet logical type does not automatically appear in Iceberg. Iceberg has its own type system, and every column in an Iceberg schema has an Iceberg type that maps to a Parquet physical and logical type. Today, a SERIALIZED_VALUE column inside an Iceberg table maps to Iceberg's `binary` type, since that is what the physical column is. Iceberg readers read it as bytes, and the annotation is invisible at the table level.

For Iceberg to expose the type, it needs several decisions. This is the same path recent types such as Variant, geometry, and the proposed FILE type followed, as covered in [What Iceberg v4's Proposed FILE Type Means for Multimodal Tables](https://iceberglakehouse.com/posts/iceberg-v4-file-type-multimodal-tables/).

1. **A type or a property.** Iceberg can add a new type, or treat SERIALIZED_VALUE as metadata on a `binary` column, such as a field property. A property is lighter and avoids a format version bump.
2. **Where the schema lives.** Parquet stores the schema per file. An Iceberg table has many files, possibly written with different schema versions. Iceberg needs a rule for whether the table schema carries a canonical message schema, or whether each file's schema is authoritative.
3. **Schema evolution.** Protobuf and Thrift have their own evolution rules. Iceberg's schema evolution tracks columns by field ID. A serialized column's internal schema evolves inside the bytes, out of Iceberg's view. The mapping has to state that Iceberg does not validate internal evolution.
4. **Statistics.** Min and max bounds on serialized bytes are meaningless for filtering. The mapping should say that writers skip bounds for these columns, as they do for other opaque binary data.
5. **Format versioning.** If the mapping adds a new type, it lands in a future Iceberg format version, with the usual reader requirements. The [Parquet versioning problem and why Iceberg cares](https://iceberglakehouse.com/posts/parquet-versioning-iceberg-v4/) covers how those layers coordinate.

None of this is proposed yet. It becomes relevant if the Parquet type is accepted and engines adopt it.

## Encoding and compression for serialized columns

Even without the new type, the physical storage choices for serialized columns matter. Parquet's encoding options for binary data are covered in [All About Parquet Part 06: Encoding in Parquet](https://iceberglakehouse.com/posts/2024-10-all-about-parquet-part-06/). A few points apply specifically to serialized messages.

**Dictionary encoding rarely helps.** Dictionary encoding pays off when values repeat. Serialized events are usually unique, since each carries its own timestamp or ID. Writers that try dictionary encoding first fall back to plain encoding after the dictionary grows, wasting work. Disable dictionary encoding for these columns.

**General compression helps a lot.** Serialized messages from one service share structure: the same field tags, similar string values, repeated enum codes. A general-purpose codec such as zstd finds that redundancy across a page of messages. Use it.

**Page size matters.** Larger pages give the codec more context to compress across messages, at the cost of reading more data for selective queries. Since these columns are usually read whole for replay rather than filtered, larger pages are a reasonable default.

**Keep decoded columns alongside.** The common design keeps both: decoded columns for analytics and the serialized column for replay and audit. Queries that never touch the payload column never read it, because Parquet is columnar. Storage cost is the only price.

## Status, and how to weigh in

As of November 16, 2026, SERIALIZED_VALUE is a proposal with a tracking issue, [parquet-format #640](https://github.com/apache/parquet-format/issues/640), and a proposal document linked from the dev list thread. Neelesh said he plans to add it to Parquet's Active Proposals list if the direction has support. The thread has one clear skeptic, two supporters with real use cases, and outreach to two engines.

The decision rests on Matt's question: how common is the use case? That is something users can answer better than maintainers. If your organization keeps raw protobuf, Thrift, or FlatBuffers messages in Parquet, for replay, audit, forward compatibility, or because decoding them fully is too expensive, the most useful contribution is a short reply on the thread or a comment on the issue describing your setup. Say how you store the schema today and what it costs.

## Conclusion

SERIALIZED_VALUE proposes a small change to Parquet: an annotation that says a binary column holds serialized messages in a named format, with the schema stored once per file. Parquet never decodes the bytes, and old readers keep reading plain BINARY. The type targets teams that keep raw event messages for replay, forward compatibility, or cost, and who today store format and schema information in every row or in private metadata conventions.

The case against it is that a struct column already works and new types cost every implementation something. The case for it is that per-row schema references are expensive at scale and private conventions make files unreadable to anyone else. Projection into the bytes, the bigger prize, waits for engine interest. If you store raw messages in Parquet today, store the schema once per file, disable dictionary encoding on the payload column, decode only trusted files, and tell the Parquet community about your use case.

## Keep Going

If this piece was useful, I have written a lot more on Parquet, Iceberg, and how the format layers fit together. *Apache Iceberg: The Definitive Guide* (O'Reilly) covers how Iceberg uses Parquet, type mapping, and schema evolution in depth. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
