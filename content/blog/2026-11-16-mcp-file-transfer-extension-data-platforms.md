---
title: "The MCP File Transfer Extension for Data Platforms: Moving Query Results Without the Context Window"
description: "The MCP file transfer extension lets agents move Parquet exports and uploads out of band, keeping bytes out of the context window and inside your storage."
date: 2026-11-16T09:00:00Z
tags: ["MCP", "AI Agents", "Data Platform", "Security", "Apache Iceberg"]
canonical: https://datalakehousehub.com/blog/mcp-file-transfer-extension-data-platforms/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/mcp-file-transfer-extension-data-platforms/).

MCP's draft file extension, io.modelcontextprotocol/files, lets an agent move files to and from a tool without the model reading the bytes. The server returns an upload or download target, usually a pre-signed HTTPS URL, and the client transfers the file directly. For lakehouses, that means query results can leave as Parquet instead of as tokens.

The Model Context Protocol (MCP) project introduced the extension on November 10, 2026, in a post by Den Delimarsky and Wil St. Charles ([MCP blog](https://blog.modelcontextprotocol.io/posts/exploring-file-uploads-and-downloads-in-mcp/)). It is experimental. The authors say the overall shape is set, there is no reference implementation yet, and they expect it to become stable before the end of the year. The draft lives in the [experimental-ext-file-uploads repository](https://github.com/modelcontextprotocol/experimental-ext-file-uploads).

This article looks at the extension from the data platform side. It covers why returning rows through the context window breaks down for analytics, how the upload and download flows work, where object storage credentials belong, and what security controls a lakehouse team needs before turning it on. A disclosure: I work at Dremio, which ships an MCP Server for its platform. Nothing here depends on any vendor's implementation.

## Why rows in the context window break down

Most MCP tools for data platforms today follow one pattern. The agent calls a tool such as `run_query` with a SQL string. The server runs the query and returns the result as text or structured content in the tool result. The client puts that result in the model's context, and the model reads it.

That pattern works well for small answers. A count, a top-ten list, or a few dozen rows fit comfortably in context. The model reads them, reasons about them, and writes a reply.

It fails in three ways as results grow.

**Context cost.** Every row the tool returns becomes tokens the model processes. A result of a few thousand rows with a dozen columns consumes a large share of a context window and costs money on every turn that keeps it in history. The [context window management](https://datalakehousehub.com/knowledgebase/context-window-management/) problem gets worse the more data a tool returns.

**Fidelity.** Text is a lossy format for typed data. Timestamps lose time zones, decimals lose precision, and nulls turn into empty strings or the word "null." When the next step is a chart, a spreadsheet, or another system, the model has to reconstruct types from text. That is where errors creep in.

**The wrong worker.** Many analytic tasks do not need the model to read the data at all. A user asks for last quarter's orders as a file for finance. The agent needs to run the right query and hand back a file. Pushing every row through the model to produce that file is like printing a spreadsheet and retyping it.

Server builders have worked around this with ad hoc tricks. Some tools write results to a bucket and return a URL as text. Others return a truncated preview plus a row count. Those tricks work, but every server invents its own version, and clients cannot treat the URL as a file because they have no way to know it is one. The file extension gives that pattern a standard shape.

## What the extension standardizes

The extension adds file handling to MCP tools in both directions:

- **Uploads:** a tool declares that an argument is a file. The client sends file metadata first, then transfers the bytes out of band to a target the server provides, then retries the call.
- **Downloads:** a tool returns download targets alongside its normal result. The client fetches the files directly over HTTPS.
- **Small files inline:** files below a server-advertised limit can travel as base64 in the tool call itself.

The model sees file metadata, such as a name, a media type, and a size. It does not see the bytes unless the client chooses to show them. That is the key property for data platforms. The model decides which query to run and what to do with the result. The bytes move between the client and storage.

The extension works with MCP protocol revision 2026-07-28 and later and is optional on both sides. A server advertises support in its `server/discover` response, including whether it accepts out-of-band uploads and its `maxInlineBytes` limit. A client declares support in its capabilities metadata. Without both sides opting in, tools fall back to their normal behavior. For the protocol changes in the 2026-07-28 revision, see [MCP 2026-07-28 Spec: Stateless MCP for Data Platforms](https://iceberglakehouse.com/posts/mcp-2026-07-28-stateless-spec-data-platforms/) on IcebergLakehouse.com.

## The upload flow

Uploads matter for data platforms whenever a user hands the agent a file to load, join, or validate. Think of a CSV of customer IDs to match against a table, or a spreadsheet of budget targets to compare against actuals.

### Marking a file argument

A server marks a tool argument as a file with an `x-mcp-file` annotation in the tool's input schema. The annotation can list accepted media types and a maximum size. Based on the examples in the post, a tool that accepts a CSV for a lookup looks like this:

```json
{
  "name": "match_customer_ids",
  "description": "Match a list of customer IDs against the customers table.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id_file": {
        "type": "object",
        "x-mcp-file": { "accept": ["text/csv"], "maxSize": 157286400 },
        "properties": {
          "name": { "type": "string" },
          "mimeType": { "type": "string" },
          "size": { "type": "integer" },
          "data": { "type": "string" }
        },
        "required": ["name", "mimeType", "size"]
      }
    },
    "required": ["id_file"]
  }
}
```

The `x-mcp-file` object tells the client this argument is a file, which types the tool accepts, and the largest size allowed. The example caps it at 157,286,400 bytes, which is 150 MiB. The `name`, `mimeType`, and `size` fields describe the file. The optional `data` field carries base64 bytes for small inline files. The post also describes an optional SHA-256 digest on file inputs.

### The two-phase call

For files above the inline limit, the call happens in two phases.

1. **Metadata first.** The client calls the tool with only the file's metadata: name, media type, and size. No bytes.
2. **Server checks.** The server validates the metadata. It can reject a wrong type or an oversized file before any bytes move. If the checks pass, it returns a result with `resultType` set to `upload_required`.
3. **Upload target.** That result includes a URL to upload to, any headers to send, a `credentials` mode, an `expiresAt` time, and a `requestState` value. The URL is often a pre-signed object storage URL.
4. **Out-of-band transfer.** The client uploads the file over HTTPS with PUT, or POST with multipart form data.
5. **Retry.** The client calls the tool again with the same arguments plus the `requestState`.
6. **Verification and execution.** The server verifies the upload landed, then runs the tool. If the upload failed, the tool does not run.

An `upload_required` result, built from the field names in the post, looks like this:

```json
{
  "resultType": "upload_required",
  "uploads": [
    {
      "url": "https://upload.example.com/u/01JD3V7K2M?sig=...",
      "headers": { "Content-Type": "text/csv" },
      "credentials": "omit",
      "expiresAt": "2026-11-17T18:30:00Z"
    }
  ],
  "requestState": "eyJ0b29sIjoibWF0Y2hfY3VzdG9tZXJfaWRzIn0..."
}
```

The `url` and `headers` tell the client exactly where and how to send the bytes. The `credentials` value of `omit` means the client sends no MCP credentials with the upload, because the pre-signed URL authorizes itself. The `expiresAt` value bounds how long the target stays valid. The `requestState` is an opaque, tamper-protected value the client returns on retry. The exact nesting of upload targets is part of what the draft is still settling, so treat this as the shape, not the final schema.

### Why two phases

The two-phase design looks fussy until you consider the alternative. If the client uploaded first and called the tool second, the server gets no chance to reject a bad file before bytes move. If the bytes went through the MCP connection, a 150 MiB file ties up the protocol channel and every proxy between client and server.

Splitting metadata from bytes lets the server say no cheaply, lets storage handle large transfers, and keeps the MCP channel for small JSON messages. It also lets the server issue a target scoped to exactly one object with a short expiry.

## The download flow

Downloads are where the extension changes the most for analytics. A query tool can now return a file instead of rows.

The tool returns its normal result, such as a short summary for the model, and adds download targets in the result's `_meta` field under the extension's key. Each target carries a URL, a size, an expiry, and optionally a digest. The client fetches the file with an HTTPS GET. It does not retry the tool call. It checks that the byte count matches and, if a digest was provided, that the digest matches.

A query tool's result looks something like this:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Q3 orders for EMEA: 1,204,311 rows, 14 columns. Exported as Parquet."
    }
  ],
  "_meta": {
    "io.modelcontextprotocol/files": {
      "downloads": [
        {
          "name": "orders_emea_q3.parquet",
          "mimeType": "application/vnd.apache.parquet",
          "size": 209715200,
          "url": "https://download.example.com/d/01JD3V9P4Q?sig=...",
          "expiresAt": "2026-11-17T19:00:00Z"
        }
      ]
    }
  }
}
```

The `content` array holds what the model reads: one sentence describing the export. The row count in that sentence is whatever your query returned. The `_meta` block holds what the client handles: the file name, its media type, its size, and where to fetch it. The model never sees 200 MB of Parquet. It sees one line telling it the export exists.

The post lists the representation of download targets in `_meta` as an open question. Expect the field layout to change before the extension is final.

## A reference pattern for lakehouse query tools

Here is how I build a query tool around this extension on an Apache Iceberg lakehouse. The engine and catalog can be anything that reads Iceberg. The pattern has five steps.

1. **The agent calls the tool with a question or SQL.** The tool runs the query through the engine with the caller's identity, so catalog permissions apply.
2. **The tool decides between inline and file.** Small results go back as content the model reads. Large results, or results the user asked for as a file, go to storage.
3. **The tool writes Parquet to a scratch prefix.** Parquet keeps types, compresses well, and opens in every analytic tool. Arrow-based engines write it directly from result batches without converting to text.
4. **The tool issues a short-lived download URL** scoped to that one object.
5. **The tool returns a summary and the download target.**

A minimal sketch of steps 3 to 5 in Python, using PyArrow and boto3:

```python
import uuid
import boto3
import pyarrow.parquet as pq

s3 = boto3.client("s3")
BUCKET = "agent-exports"

def export_result(arrow_table, user_id: str) -> dict:
    # Write the result to a per-user scratch prefix with a random key.
    key = f"exports/{user_id}/{uuid.uuid4()}.parquet"
    local_path = f"/tmp/{uuid.uuid4()}.parquet"
    pq.write_table(arrow_table, local_path, compression="zstd")
    s3.upload_file(local_path, BUCKET, key)

    # Issue a GET URL valid for 15 minutes, scoped to this one object.
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET, "Key": key},
        ExpiresIn=900,
    )
    size = s3.head_object(Bucket=BUCKET, Key=key)["ContentLength"]

    return {
        "content": [{
            "type": "text",
            "text": f"Exported {arrow_table.num_rows} rows as Parquet.",
        }],
        "_meta": {"io.modelcontextprotocol/files": {"downloads": [{
            "name": "result.parquet",
            "mimeType": "application/vnd.apache.parquet",
            "size": size,
            "url": url,
        }]}},
    }
```

`pq.write_table` writes the Arrow table to Parquet with zstd compression. `upload_file` puts it in a scratch prefix under the user's ID, so cleanup and auditing can work per user. `generate_presigned_url` creates a GET URL for that single object that expires in 900 seconds. `head_object` reads back the size so the client can verify the download. The returned dictionary follows the result shape above. A production version adds a digest, writes directly to object storage instead of a temp file, and sets a lifecycle rule that deletes the scratch prefix after a day.

## Inline or file: a sizing rule for query tools

A tool that can return either rows or a file needs a rule for choosing. The rule should be simple enough that the model can predict it from the tool description.

I use three tests, in order.

**Did the user ask for a file?** If the request says "export," "download," "send me," or names a format, return a file regardless of size. The user's intent wins.

**Does the model need to read the result?** If the next step is reasoning about the numbers, such as comparing two regions or spotting a trend, the model needs the rows. Return them inline, and if the result is large, aggregate it in SQL first. A model reasoning over fifty summary rows beats a model skimming fifty thousand detail rows.

**Is the result small?** If neither of the first two tests decides it, use size. Below a few hundred rows, return inline. Above that, return a file with a short preview inline, such as the first ten rows and the column list, so the model can describe what it exported.

Put the rule in the tool description in plain words. A description that says "results over 500 rows are returned as a Parquet file with a 10-row preview" lets the model write SQL that aggregates when it wants to read, and plain selects when the user wants a file.

The server also has to respect the client's limits. A server learns whether the client supports the extension from its declared capabilities. If the client does not support it, the tool falls back to inline results with truncation and a clear note that the result was cut. Never return a download target to a client that has not declared support, because it has no way to fetch it.

## A second pattern: uploads that load data

Downloads cover results leaving the platform. Uploads cover data arriving. The most common data platform use is "here is a file, put it somewhere I can query it."

The upload pattern for that case has more moving parts than the export pattern, because it writes to the lakehouse.

1. **The tool declares a file argument** that accepts CSV, Parquet, or spreadsheet types, with a size cap that matches what your ingestion path handles.
2. **The metadata-first call** lets the server check the type, size, and the caller's write permission on the target namespace before any bytes move.
3. **The upload lands in a staging prefix,** never directly in a table location. The server issues a pre-signed PUT URL for one staging key.
4. **On retry, the server validates the file.** It checks size and digest, parses the header, infers or checks the schema, and rejects files that do not match.
5. **The server writes to a staging table,** not a production table, using a normal Iceberg append through the catalog, so the commit is atomic and auditable.
6. **The tool returns a summary** with row counts and the staging table name, and marks the `requestState` as used so a retry does not load the file twice.

Two rules keep this safe. Uploaded files never become table data files by being moved into a table location. They are read, validated, and rewritten through a writer that applies the table's schema. And uploads land in a namespace meant for user data, with its own retention, so a user cannot overwrite governed production tables through a chat window.

## What changes for clients and hosts

Server builders get most of the attention in a new extension, but clients carry real work too.

**Hosts need an approval model for files.** A host that shows "Allow match_customer_ids?" now also needs to show which file is going where. The draft notes that approval happens before the upload destination is known. A good host shows the file name and size at approval time, then checks the destination against the allowlist when the target arrives, and refuses if it does not match.

**Clients need storage plumbing.** Uploading with PUT or multipart POST, streaming large downloads to disk, verifying sizes and digests, and handling expiry are all new client responsibilities. Desktop and IDE clients can save downloads to a user-chosen folder. Agent runtimes on servers need a scratch area with its own cleanup.

**Clients decide what the model sees.** The extension keeps bytes out of the model by default. A client can still choose to show a file's contents, for example by loading the first rows of a downloaded Parquet file into context. That choice belongs to the client and the user, and it should be explicit.

## Where object storage credentials belong

The pattern above has the MCP server sign URLs with its own storage credentials. That raises the question every lakehouse team should ask first: who is allowed to read what?

The query runs with the caller's identity, so catalog permissions decide which rows the result contains. The export then lands in a bucket the MCP server controls, and the pre-signed URL grants read access to anyone holding it until it expires. Access control on the export is the URL itself.

That is acceptable when three conditions hold. The URL is short-lived. The URL is delivered only to the client that made the call. The export prefix is separate from the lakehouse tables, so a leaked URL exposes one result, not a table.

It is not acceptable to hand out pre-signed URLs for Iceberg data files directly. A tool that skips the export and returns URLs to the table's own Parquet files bypasses row filters, column masks, and deletion vectors. The client gets raw files, including rows the caller is not allowed to see and rows that were deleted. If a client needs table-level access to storage, that is what catalog credential vending is for, with credentials scoped by the catalog's permission model. The same principle shows up in [Implementing MCP in the Lakehouse](https://datalakehousehub.com/blog/mcp-lakehouse-semantic-data-layer-python/): the semantic and governance layer sits between the agent and the files, never beside it.

## The security model, and the gaps in the draft

The draft includes several security rules, and it is candid about what remains open.

**Credentials modes.** Each target sets `credentials` to `omit` or `include`. With `omit`, the client sends no MCP credentials, and the target must authorize itself, as a pre-signed URL does. With `include`, the client sends MCP credentials, but only to the MCP server's own path or origin. A relative `path` resolves against the server's address. That rule stops a malicious server from tricking a client into sending its MCP token to a third-party host.

**Redirects and headers.** Clients must refuse redirects and must reject targets that supply their own `Authorization` header. Both rules close ways for a target to steer credentials or requests somewhere unexpected.

**Request state.** The `requestState` value is tamper-protected. For tools that must not run twice, the server marks the state as used and shares that record across server instances. That matters for any tool that writes data. An upload that triggers a table load must not load the same file twice because a client retried.

**Integrity versus safety.** A matching digest proves the file is the one the server described. It does not prove the file is safe. The draft says downloaded files should be treated as untrusted. For data platforms, that means parsing uploaded CSVs and spreadsheets defensively and never executing anything inside them.

**The open gap: where uploads go.** The host approves a tool call before the destination of an `omit` upload is known. The approval prompt says "call match_customer_ids," and the server then names an upload URL. A hostile server can point that URL at any host. The draft recommends that clients allowlist permitted upload origins. Whether the allowlist should be mandatory is still open.

For a data platform, treat the allowlist as mandatory today. An agent that uploads a customer file to whatever URL a server names is a data exfiltration path. Configure clients to allow uploads only to your own storage endpoints. The controls that sit in front of MCP servers more broadly are compared in the [Agent Gateway Control Matrix](https://datalakehousehub.com/blog/agent-gateway-control-matrix/).

## Failure modes to plan for

**Expired targets.** A client that waits too long between receiving a target and using it gets an error from storage. Keep expiry short for security and long enough for slow networks. Fifteen minutes is a reasonable starting point for downloads. Handle expiry by re-calling the tool, not by extending URL lifetimes.

**Partial uploads.** A client that loses its connection mid-upload retries the tool call with a `requestState` whose upload never completed. The server must verify the object exists and matches the declared size before running the tool. The draft requires this verification, and server code has to implement it carefully.

**Duplicate side effects.** Without single-use request state, a retry runs a write tool twice. For tools that load data into tables, track used `requestState` values in a shared store, not in process memory, since MCP servers increasingly run as several stateless instances.

**Scratch storage growth.** Every export leaves an object behind. Without a lifecycle rule, the export bucket grows forever and holds copies of sensitive results long after anyone needs them. Set expiration on the prefix from day one.

**Model confusion about files.** A model that sees "exported as Parquet" sometimes tries to read the file anyway, by asking a different tool to fetch the URL. Give the model clear instructions in the tool description about what the file is for and that it does not need the contents.

**Regulated data in exports.** Exports are copies. If your environment has data residency or retention rules, they apply to the export bucket too. Lessons on running MCP in regulated settings are collected in [MCP in Regulated Environments](https://datalakehousehub.com/blog/mcp-regulated-environments-toronto-2026/).

## How to evaluate it before it is final

The extension is experimental, so production adoption waits for a stable release. You can still prepare now.

1. **Separate small and large result paths in your tools.** Even without the extension, a tool that decides "inline or file" based on size is easier to adapt.
2. **Standardize on Parquet for exports.** Typed, compressed, and readable everywhere, it is the right default for analytic results.
3. **Build the export bucket and lifecycle rules.** Scoped prefixes, short expiry, and automatic deletion are needed regardless of the protocol.
4. **Write the upload allowlist policy.** Decide which origins clients are allowed to upload to before any client supports uploads.
5. **Test with your own clients.** Once a client ships experimental support, run the export and upload patterns end to end against a staging catalog. Measure how long large downloads take over your network, confirm expiry handling, and check that approval prompts show the file name and size. Problems found in staging during the experimental phase are cheap to report and cheap to fix.
6. **Follow the repository.** Open questions include the `_meta` layout for downloads and whether the origin allowlist becomes mandatory. Feedback goes through the repository's issues and the working group.

## Conclusion

The MCP file extension separates two jobs that data tools have been forcing into one channel. The model decides what to do. The client and storage move the bytes. Uploads use a metadata-first call, an out-of-band transfer to a server-issued target, and a verified retry. Downloads return targets in `_meta` that the client fetches directly. For lakehouses, the result is that a query tool can hand back a typed Parquet file instead of thousands of rows of text.

The draft gets several security details right, including credential modes, refused redirects, and tamper-protected request state. It leaves the upload destination allowlist open, and data platforms should treat that allowlist as required. Build the export pattern now, keep table files behind the catalog, and adopt the extension when it stabilizes.

## Keep Going

If this piece was useful, I have written a lot more on connecting AI agents to lakehouse data. My books cover lakehouse architecture, semantic layers, and how agents should reach governed data through open standards such as Apache Iceberg and MCP. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
