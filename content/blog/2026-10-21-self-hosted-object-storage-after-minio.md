---
title: "Choosing Self-Hosted Object Storage for the Lakehouse After MinIO"
description: "MinIO's community edition is archived. Compare RustFS, SeaweedFS, Ceph, and Garage against what Iceberg actually needs, then test and migrate."
date: 2026-10-21T09:00:00Z
tags: ["object storage", "MinIO", "RustFS", "SeaweedFS", "Apache Iceberg"]
canonical: https://datalakehousehub.com/blog/self-hosted-object-storage-after-minio/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/self-hosted-object-storage-after-minio/).

For most of the last decade, the answer to "what object storage do we run on premises?" was one word. MinIO was the default S3-compatible store in reference architectures, Helm charts, CI pipelines, and lakehouse tutorials. If your Iceberg tables lived anywhere other than a public cloud, they very likely lived on MinIO.

That default is gone. MinIO's open source repository was archived in February 2026, after a year of steps that moved features and distribution behind its commercial product. Existing deployments still run. They just run on code that no longer receives public fixes.

At the same time, the replacements matured fast. RustFS reached general availability on September 16, 2026, under the Apache 2.0 license. SeaweedFS keeps shipping releases. Ceph's object gateway remains the heavyweight option it has always been. Garage serves small, geographically spread clusters. The Apache Iceberg project itself moved its integration tests off MinIO this fall.

This article is a decision guide for teams running a lakehouse on self-hosted storage. It covers what a lakehouse actually needs from an object store, which is a narrower and more specific list than "S3 compatible," how credential vending changes the requirements, how the main options compare, how to test a candidate against your actual table formats and catalog, and how to migrate. For laptop and CI setups, see [Local Iceberg Development Environments](https://iceberglakehouse.com/posts/local-iceberg-development-environments/). This piece is about storage you run in production.

## What Happened to MinIO

MinIO did not disappear in a single announcement. It wound down the community edition in stages, and the stages matter because they explain why so many teams waited too long.

In May 2025, a community release removed most management features from the web console, along with external identity provider logins through LDAP and OIDC. Those features moved to the commercial edition. The open source server still worked, but operators lost the interface many of them used every day.

In October 2025, MinIO stopped publishing Docker images and prebuilt binaries for the community edition. From then on, the community edition was source-only. Teams pulling `minio/minio:latest` in CI or Helm charts found themselves pinned to old images or building their own.

On December 3, 2025, the repository entered maintenance mode, with no new features and no pull requests accepted.

On February 12 and 13, 2026, the README changed to state that the repository is no longer maintained, and the repository was archived. It was briefly unarchived and archived again in April. Users are directed to MinIO's commercial products, which include a free standalone edition under a separate license and a distributed enterprise edition.

The practical consequence for a lakehouse team is security exposure. A storage layer holds every table you own. When vulnerabilities are reported against the last community release, no fix arrives in the public code. Community forks exist, including builds that restore the removed console, and the AGPL license guarantees the right to maintain them. But running a fork means trusting a small group of maintainers with the most sensitive layer of your platform.

Some teams will choose the commercial MinIO products, and that is a legitimate option with its own license terms. This article focuses on the open source paths, because that is where most lakehouse teams that chose MinIO for its license now have to make a decision.

## What a Lakehouse Actually Asks of Object Storage

"S3 compatible" is a marketing phrase that covers a huge API surface. Table formats use a specific subset of it, and they use that subset in specific patterns. Knowing the pattern is the most useful thing you can bring to a storage evaluation.

Start with reads. Parquet readers do not read files front to back. They read the footer first, because the footer holds the schema, row group locations, and statistics. The cheapest way to get the footer is a suffix range request, an HTTP `Range: bytes=-N` header that asks for the last N bytes of an object. Readers then issue more ranged requests for the specific column chunks the query needs. A store that handles ranged and suffix-ranged GETs correctly and quickly is the foundation of every query. A store that falls back to full-object reads, or mishandles suffix ranges, turns every query into a bandwidth problem.

Next, metadata reads. Iceberg reads a metadata JSON file, a manifest list, and manifests on every query plan. These are small objects, often kilobytes, read with high frequency. Small-object GET latency matters as much as large-object throughput for planning time, and a store tuned only for large sequential reads makes planning slow.

Then writes. Writers produce data files from tens to hundreds of megabytes, usually through multipart uploads. They produce small metadata files on every commit. Streaming writers commit frequently, which means many small PUTs. The store needs reliable multipart support and good small-object write performance.

Then deletes and listings. Table maintenance is where the less common operations show up. Snapshot expiration deletes data and metadata files that no snapshot references anymore, and efficient implementations use the batch `DeleteObjects` call rather than one request per file. Orphan file cleanup lists every object under the table location with `ListObjectsV2`, including pagination over potentially millions of keys, and compares the listing with the files the metadata references. A store with slow or inconsistent listings makes orphan cleanup painful or unsafe.

Consistency matters underneath all of it. Iceberg commits through the catalog, which swaps a pointer to a new metadata file atomically, so the object store itself does not need to provide transactions. But the engine that reads the new metadata must see the files it points to. Amazon S3 has offered strong read-after-write consistency since 2020, and lakehouse software increasingly assumes it. A self-hosted store needs to provide it too.

Conditional writes are newer. A PUT with `If-None-Match: *` succeeds only if the key does not already exist. A growing number of lakehouse tools use conditional writes to make commits safe without an external lock. Support across self-hosted stores varies, and it belongs on your test list.

Addressing is the last mechanical detail. Cloud S3 defaults to virtual-hosted-style URLs, where the bucket is part of the hostname. Self-hosted stores usually run behind a single hostname and need path-style URLs, where the bucket is part of the path. Iceberg's S3 client supports this through the `s3.path-style-access` property, and engines expose similar settings. It is a configuration detail, but it is the most common reason a first connection to a new store fails.

Beyond the API, three operational properties decide whether a store works for a lakehouse at scale. Erasure coding or replication protects data without tripling raw capacity. Lifecycle policies and versioning interact with table maintenance, and they need care, because a bucket-level lifecycle rule that deletes objects Iceberg still references corrupts tables. And observability, meaning request metrics, latency histograms, and capacity reporting, tells you when the storage is the bottleneck.

## The Credential Question

Credentials are where self-hosted object storage and modern lakehouse catalogs meet, and where many evaluations miss a requirement.

The older pattern gives every engine a long-lived access key with broad permissions on the warehouse bucket. Every Spark cluster, every query engine, and every notebook holds a key that reads and writes every table. It works, and it is the pattern most MinIO deployments used. It is also the pattern that governance teams now reject, because a leaked key exposes the whole lake and access control has to be enforced in each engine separately.

The newer pattern is credential vending. An Iceberg REST catalog such as Apache Polaris authenticates the engine, checks its privileges on the requested table, and returns short-lived storage credentials scoped to that table's location. The engine never holds a permanent key. Access control lives in the catalog, once.

On AWS, catalogs vend credentials by calling the Security Token Service, STS, to assume a role with a session policy that narrows access to specific prefixes. On self-hosted storage, that path requires the store to implement an STS-compatible API, and support varies widely between products. Ceph's RADOS Gateway implements a subset of STS. Other stores implement different subsets or none.

When a store has no usable STS, there are three options. The catalog can vend the static credentials it holds, which centralizes the key but does not scope it per table. The catalog can use remote signing, where the engine asks the catalog to sign each storage request, so no credentials leave the catalog at all. Or the engine brings its own credentials and the catalog does not delegate access. Polaris acknowledges these realities in its configuration. Its 1.8.0 release added CLI toggles that turn off STS and KMS on an existing S3 catalog without recreating it, and the community has been debating how to support stores whose credential mechanisms differ from AWS.

The Polaris project also published a reminder this fall of why endpoint configuration deserves care. CVE-2026-97395 affected Polaris versions before 1.8.0: a principal allowed to set table properties was able to set FileIO options such as `s3.endpoint` in table metadata, and Polaris then sent requests signed with operation-scoped credentials to a host the table writer chose. Self-hosted deployments, where custom endpoints are normal, are exactly where that class of issue shows up. Keep storage endpoints in catalog-level storage configuration, not in table properties, and upgrade catalogs promptly.

For a storage evaluation, this turns into a concrete question. Decide which credential model your catalog will use, then test that the candidate store supports it. If you want scoped, short-lived credentials, the store's STS support is a hard requirement, not a nice-to-have.

## The Options

Four open source options cover most lakehouse deployments. They differ less in raw features than in what each one was designed to be good at.

### RustFS

RustFS is a distributed object store written in Rust and released under Apache 2.0. Development began in February 2024, the code went open source in July 2025, it reached beta in April 2026, moved through a release candidate in August, and reached general availability in September. It is positioned explicitly as a MinIO replacement, and it is the closest match to MinIO's deployment model: a single binary or container per node, a decentralized metadata design, and a familiar web console.

The 1.0 release includes bucket and object lifecycle management, multipart uploads, erasure coding, data tiering, versioning, IAM policies, and OIDC login. It also exposes WebDAV, the Swift API, FTP, and an MCP interface, and it ships OpenTelemetry support for observability. It runs on Linux, Windows, and macOS, with Docker and Kubernetes deployment options.

Two features matter specifically for lakehouse teams. RustFS can read MinIO's on-disk format directly, which enables an in-place migration where you point RustFS at existing MinIO data directories. Coverage of that path describes it as preview-scoped with caveats around encryption, so treat it as something to test in staging before trusting it. And RustFS 1.0 includes S3 Tables support with an Iceberg REST catalog built into the storage system. That feature is also reported as preview, not production-ready for analytics pipelines.

The caution with RustFS is age. A 1.0 is a meaningful milestone, and the project has strong momentum, but it has less production history than the alternatives below. It has had public growing pains, including a reported authentication bypass in its internal RPC that was patched. None of that disqualifies it. It means you test it harder and watch its security advisories closely.

There is one notable endorsement from the lakehouse world. When the Apache Iceberg project's integration tests broke on the MinIO container this fall, the project switched its S3 test backend to RustFS across its repositories, and a release manager ran the Iceberg 1.12.0 release candidate integration tests against it. That is a CI use, not a production one, but it tells you the Iceberg S3 code paths work against it.

### SeaweedFS

SeaweedFS is older, Apache 2.0 licensed, and broader in scope. It started as a distributed file system optimized for billions of small files, and it offers an S3 gateway alongside a filer with POSIX-style access. Its core design packs small files into larger volumes, which gives it strong performance on small-object workloads, the pattern Iceberg metadata produces.

Its production record is longer than RustFS's. Kubeflow Pipelines replaced MinIO with SeaweedFS as its default storage backend, which is a meaningful signal from a project with heavy object storage usage. It keeps a steady release cadence, with version 4.48 released in late September 2026.

The tradeoff is operational design. SeaweedFS has more moving parts than a single-binary store, separating masters, volume servers, and filers, and its console is less polished than MinIO's was. Teams that want a drop-in replacement with the same operational feel find RustFS closer. Teams that want proven small-file performance and are willing to learn a different architecture find SeaweedFS compelling.

### Ceph RADOS Gateway

Ceph is the heavyweight. Its object gateway, RGW, provides an S3-compatible API on top of RADOS, Ceph's distributed storage layer, which also serves block and file storage. On Kubernetes, the Rook operator deploys and manages it. Ceph is mature, widely deployed at very large scale, and licensed under the LGPL.

For lakehouse teams, Ceph's advantages are scale, maturity, and breadth of S3 support, including a subset of the STS API, which matters for credential vending. If your organization already runs Ceph for block or file storage, RGW is the obvious choice, because you are adding a gateway to infrastructure you already operate.

The cost is complexity. Ceph needs dedicated expertise to run well. Its tuning surface is large, its failure modes are specific, and a small team adopting Ceph only for a lakehouse takes on a real operational burden. For a team without existing Ceph skills and a moderate data volume, it is usually more system than the problem requires.

### Garage

Garage is a lightweight distributed object store licensed under AGPLv3, designed for resilience across geographically distributed nodes rather than raw throughput in one data center. It suits small hosting platforms, homelabs, replicated backups, and clusters spread across sites where Ceph is too heavy.

Garage implements a deliberately smaller S3 surface than the others. For a lakehouse, check its compatibility documentation against the operation list in the previous sections before committing, especially for credential vending and conditional writes. The AGPL license also matters if you plan to modify and distribute it, which is the same consideration MinIO's AGPL raised.

### Staying on archived MinIO for now

Some teams are not ready to move this quarter, and running the last community release for a while longer is a real choice. It should be a deliberate, time-boxed one.

If you stay, reduce exposure. Put the store on a private network that only engines and the catalog reach. Remove any public or broad network paths. Rotate access keys and move them into the catalog so engines stop holding them directly. Turn on request logging and keep it. Inventory which tables live on it and which teams depend on them, because that list becomes your migration plan.

Community forks that keep building and patching the AGPL code exist, and some restore the removed console. They are an option for buying time, with the same caution as any small-maintainer project: read their release practices, check who reviews security fixes, and pin versions.

Set a date. A storage layer with no upstream fixes is a liability that grows with every disclosed vulnerability. A quarter or two of runway is reasonable for a planned migration. An open-ended plan to stay is not.

### Comparing them

| Store | License | Design center | Lakehouse strengths | Watch for |
|---|---|---|---|---|
| RustFS | Apache 2.0 | MinIO-style single binary, decentralized metadata | Closest MinIO replacement, MinIO on-disk format reading, console included, used by Iceberg CI | Young project, preview features, test security posture |
| SeaweedFS | Apache 2.0 | Small-file optimized distributed storage with S3 gateway | Strong small-object performance, longer production record | More components to operate, different operational model |
| Ceph RGW | LGPL | S3 gateway over unified block, file, and object storage | Mature at large scale, STS subset for credential vending | High operational complexity without existing Ceph skills |
| Garage | AGPLv3 | Lightweight geo-distributed replication | Simple multi-site resilience | Smaller S3 surface, AGPL obligations |

Other tools fill niches. VersityGW exposes an existing POSIX file system through the S3 API while keeping objects as regular files, which suits organizations with large parallel file systems. S3Proxy translates the S3 API to other backends. Neither is a general-purpose lakehouse store, but each solves a specific integration problem.

## Choosing by Organization Shape

The right store depends less on benchmarks than on who will run it and what else they run. Here is how the choice usually falls out.

A team that runs MinIO today, wants the smallest operational change, and values a permissive license should evaluate RustFS first. The deployment model, console, and migration path are the closest match. Plan a thorough staging test and track its release notes and advisories.

A team with heavy small-object workloads, such as streaming ingestion with frequent commits, many small files, or large metadata trees, and with appetite for a different architecture, should evaluate SeaweedFS first. Its storage design targets that pattern directly.

An organization that already runs Ceph, or that needs a single platform for block, file, and object storage at large scale, should use Ceph RGW. The marginal cost of adding object storage to an existing Ceph cluster is low, and its STS support helps with credential vending.

A small team running replicated storage across several sites, with modest throughput needs, should look at Garage, after confirming its S3 subset covers the table formats and catalog in use.

A regulated organization with strict support requirements should weigh commercial support as heavily as features. That points either to a vendor that supports one of the open source stores, to the commercial MinIO products, or to the storage vendors that already sell S3-compatible appliances. The license and support model belong in the decision alongside the technology.

In every case, decide the credential model first. If the catalog will vend scoped credentials through STS, test STS on every candidate before anything else, because it eliminates options faster than any performance test.

## Testing a Candidate Against Lakehouse Behavior

Vendor compatibility tables tell you which S3 operations a store claims to support. They do not tell you whether it handles the exact request patterns your engines send. A short smoke test that exercises those patterns catches most incompatibilities in minutes, before you load a single table.

The script below runs against any S3-compatible endpoint. Each check maps to a behavior from the section on what a lakehouse needs. It uses only `boto3`, cleans up after itself, and prints a pass or fail line per check. Run it against each candidate store with the credentials your engines will use.

```python
"""Smoke test the S3 operations a lakehouse depends on, against any S3-compatible store."""
import os
import uuid

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

ENDPOINT = os.environ["S3_ENDPOINT"]
BUCKET = os.environ.get("S3_BUCKET", "lakehouse-smoke-test")
STS_ROLE_ARN = os.environ.get("STS_ROLE_ARN")  # optional

session = boto3.session.Session(
    aws_access_key_id=os.environ["S3_ACCESS_KEY"],
    aws_secret_access_key=os.environ["S3_SECRET_KEY"],
    region_name=os.environ.get("S3_REGION", "us-east-1"),
)
s3 = session.client(
    "s3",
    endpoint_url=ENDPOINT,
    config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 2}),
)
prefix = f"smoke/{uuid.uuid4().hex}/"
results = []


def check(name):
    def wrap(fn):
        try:
            detail = fn()
            results.append((name, "PASS", detail or ""))
        except Exception as exc:  # report every failure, keep going
            results.append((name, "FAIL", f"{type(exc).__name__}: {exc}"))
        return fn
    return wrap


try:
    s3.create_bucket(Bucket=BUCKET)
except ClientError as exc:
    if exc.response["Error"]["Code"] not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
        raise


@check("small PUT and read-after-write GET")
def small_put_get():
    key = prefix + "metadata/v1.metadata.json"
    s3.put_object(Bucket=BUCKET, Key=key, Body=b'{"format-version": 2}')
    body = s3.get_object(Bucket=BUCKET, Key=key)["Body"].read()
    assert body == b'{"format-version": 2}', "read did not return the written bytes"


@check("HEAD returns content length")
def head():
    key = prefix + "metadata/v1.metadata.json"
    size = s3.head_object(Bucket=BUCKET, Key=key)["ContentLength"]
    assert size == 21, f"unexpected length {size}"


@check("multipart upload")
def multipart():
    key = prefix + "data/part-00000.parquet"
    part_one = os.urandom(5 * 1024 * 1024)
    part_two = b"PAR1" + os.urandom(1024) + b"PAR1"
    upload = s3.create_multipart_upload(Bucket=BUCKET, Key=key)
    parts = []
    for number, chunk in enumerate([part_one, part_two], start=1):
        etag = s3.upload_part(
            Bucket=BUCKET, Key=key, PartNumber=number,
            UploadId=upload["UploadId"], Body=chunk,
        )["ETag"]
        parts.append({"PartNumber": number, "ETag": etag})
    s3.complete_multipart_upload(
        Bucket=BUCKET, Key=key, UploadId=upload["UploadId"],
        MultipartUpload={"Parts": parts},
    )
    size = s3.head_object(Bucket=BUCKET, Key=key)["ContentLength"]
    assert size == len(part_one) + len(part_two), f"unexpected size {size}"


@check("suffix range GET (Parquet footer read)")
def suffix_range():
    key = prefix + "data/part-00000.parquet"
    tail = s3.get_object(Bucket=BUCKET, Key=key, Range="bytes=-8")["Body"].read()
    assert len(tail) == 8 and tail.endswith(b"PAR1"), f"got {len(tail)} bytes: {tail!r}"


@check("bounded range GET (column chunk read)")
def bounded_range():
    key = prefix + "data/part-00000.parquet"
    chunk = s3.get_object(Bucket=BUCKET, Key=key, Range="bytes=1024-2047")["Body"].read()
    assert len(chunk) == 1024, f"got {len(chunk)} bytes"


@check("ListObjectsV2 pagination")
def list_pagination():
    for i in range(5):
        s3.put_object(Bucket=BUCKET, Key=f"{prefix}list/file-{i}", Body=b"x")
    keys, token = [], None
    while True:
        kwargs = {"Bucket": BUCKET, "Prefix": prefix + "list/", "MaxKeys": 2}
        if token:
            kwargs["ContinuationToken"] = token
        page = s3.list_objects_v2(**kwargs)
        keys += [obj["Key"] for obj in page.get("Contents", [])]
        if not page.get("IsTruncated"):
            break
        token = page["NextContinuationToken"]
    assert len(keys) == 5, f"listed {len(keys)} of 5 keys"


@check("batch DeleteObjects")
def batch_delete():
    objects = [{"Key": f"{prefix}list/file-{i}"} for i in range(5)]
    response = s3.delete_objects(Bucket=BUCKET, Delete={"Objects": objects})
    assert not response.get("Errors"), f"errors: {response.get('Errors')}"
    remaining = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix + "list/").get("KeyCount", 0)
    assert remaining == 0, f"{remaining} objects survived the delete"


@check("conditional PUT (If-None-Match)")
def conditional_put():
    key = prefix + "metadata/v2.metadata.json"
    s3.put_object(Bucket=BUCKET, Key=key, Body=b"first", IfNoneMatch="*")
    try:
        s3.put_object(Bucket=BUCKET, Key=key, Body=b"second", IfNoneMatch="*")
    except ClientError as exc:
        status = exc.response["ResponseMetadata"]["HTTPStatusCode"]
        assert status in (409, 412), f"rejected with unexpected status {status}"
        return "second write rejected as expected"
    raise AssertionError("second conditional PUT succeeded and overwrote the object")


if STS_ROLE_ARN:
    @check("STS AssumeRole with prefix-scoped session policy")
    def sts_scoped():
        sts = session.client("sts", endpoint_url=os.environ.get("STS_ENDPOINT", ENDPOINT))
        policy = (
            '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",'
            '"Action":["s3:GetObject"],'
            f'"Resource":["arn:aws:s3:::{BUCKET}/{prefix}metadata/*"]}}]}}'
        )
        creds = sts.assume_role(
            RoleArn=STS_ROLE_ARN, RoleSessionName="lakehouse-smoke",
            DurationSeconds=900, Policy=policy,
        )["Credentials"]
        scoped = boto3.client(
            "s3", endpoint_url=ENDPOINT,
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
            config=Config(s3={"addressing_style": "path"}),
        )
        scoped.get_object(Bucket=BUCKET, Key=prefix + "metadata/v1.metadata.json")
        try:
            scoped.get_object(Bucket=BUCKET, Key=prefix + "data/part-00000.parquet")
        except ClientError:
            return "scoped credentials allowed metadata and blocked data"
        raise AssertionError("scoped credentials read outside their prefix")


leftovers = s3.list_objects_v2(Bucket=BUCKET, Prefix=prefix).get("Contents", [])
if leftovers:
    s3.delete_objects(Bucket=BUCKET, Delete={"Objects": [{"Key": o["Key"]} for o in leftovers]})

width = max(len(name) for name, _, _ in results)
for name, status, detail in results:
    print(f"{status:4}  {name:<{width}}  {detail}")
```

Here is what each check proves.

The small PUT and GET check writes a tiny JSON object, the shape of an Iceberg metadata file, and reads it back immediately. It confirms read-after-write consistency for new objects, which every commit depends on.

The HEAD check confirms the store reports object sizes correctly. Engines use object length to plan ranged reads, and a wrong length breaks footer reads.

The multipart check uploads a 5 MB part and a small final part, then confirms the assembled size. Five megabytes is the S3 minimum size for every part except the last, so this tests the boundary that real writers hit.

The suffix range check reads the last 8 bytes of that file with `Range: bytes=-8`. That is exactly how Parquet readers fetch the footer length and magic bytes. The test writes `PAR1` at the end of the file so the assertion is easy to read. A store that mishandles suffix ranges fails here, and every Parquet read on it pays for the mistake.

The bounded range check reads a 1 KB slice from the middle of the file, the pattern engines use to fetch individual column chunks.

The pagination check writes five keys and lists them two at a time with continuation tokens. Orphan file cleanup and some planners list large prefixes, and a store that drops or repeats keys across pages makes cleanup unsafe.

The batch delete check removes five keys in one `DeleteObjects` call and confirms nothing survived. Snapshot expiration on large tables deletes thousands of files, and per-object deletes are far slower.

The conditional PUT check writes a key with `If-None-Match: *`, then tries again. The second write must fail with a precondition error. If it succeeds, the store ignored the condition, and any tool that relies on conditional writes for commit safety is not safe on that store.

The optional STS check runs only when you set `STS_ROLE_ARN`. It assumes a role with a session policy that allows reads only under the test's metadata prefix, then confirms the scoped credentials read the metadata file and fail to read the data file. That is the essence of credential vending: the catalog hands out credentials, and the storage enforces the narrower scope. If your catalog will vend scoped credentials, this check is the one that decides the evaluation.

Passing the smoke test is the start. The next step is an end-to-end run with your real catalog and engines. Here is a Spark configuration for an Iceberg REST catalog, such as Polaris, with tables on a self-hosted store.

```properties
spark.sql.catalog.lake=org.apache.iceberg.spark.SparkCatalog
spark.sql.catalog.lake.type=rest
spark.sql.catalog.lake.uri=https://polaris.internal:8181/api/catalog
spark.sql.catalog.lake.warehouse=analytics
spark.sql.catalog.lake.credential=CLIENT_ID:CLIENT_SECRET
spark.sql.catalog.lake.scope=PRINCIPAL_ROLE:ALL
spark.sql.catalog.lake.header.X-Iceberg-Access-Delegation=vended-credentials
spark.sql.catalog.lake.io-impl=org.apache.iceberg.aws.s3.S3FileIO
spark.sql.catalog.lake.s3.endpoint=https://objects.internal:9000
spark.sql.catalog.lake.s3.path-style-access=true
spark.sql.catalog.lake.client.region=us-east-1
```

The first five lines connect Spark to the REST catalog and authenticate with an OAuth client credential. The access delegation header asks the catalog to vend storage credentials with each table load. The last four lines configure Iceberg's S3 client: use `S3FileIO`, send requests to the self-hosted endpoint, use path-style addressing, and set a region string, which many self-hosted stores require even though they ignore its value.

With that in place, run the operations that stress storage in a real lakehouse. Create a table and write a few hundred files. Run a `MERGE INTO` that produces delete files. Expire snapshots and remove orphan files. Run representative queries from every engine that will read the tables. Every one of those steps exercises a different storage path, and finding a gap in staging is far cheaper than finding it during an incident.

I work at Dremio, which reads Iceberg tables from S3-compatible stores, so I care that this end-to-end step includes every engine in your stack, not just the one you test with first. Engines differ in their S3 clients, their range request patterns, and their retry behavior.

## Migrating Tables Off MinIO

Iceberg tables store absolute file paths in their metadata. A manifest records each data file as a full URI such as `s3://warehouse/analytics/events/data/...`. That detail shapes every migration plan.

If the bucket name and the URI scheme stay the same, the migration is a storage problem only. Copy the objects to the new store, keep the bucket names, point engines and the catalog at the new endpoint, and the metadata still resolves. RustFS's ability to read MinIO's on-disk format directly, once validated in your environment, is a variant of this path that avoids copying at all. Tools such as the MinIO client's `mirror` command or `rclone` copy objects between S3-compatible endpoints for the general case.

If bucket names or path layouts change, the metadata has to change too. The usual approach is to register the tables fresh at the new location, either by rewriting metadata with updated paths or by using a catalog migration tool, and then validate row counts and checksums. Apache Polaris maintains an Iceberg catalog migrator for moving table registrations between catalogs, which helps when the catalog changes along with the storage.

Whichever path you take, follow the same sequence. Freeze writes on a table or a namespace. Copy the data and metadata. Switch the catalog's storage configuration to the new endpoint. Run validation queries that compare row counts, a few aggregates, and a sample of rows between old and new. Resume writes against the new store. Keep the old store read-only until a full maintenance cycle, including snapshot expiration, has run cleanly on the new one.

Do not migrate everything at once. Start with tables that have simple write patterns and low business risk, then move to streaming tables, which stress small-object writes, and finally to the largest and most critical tables. Moving in that order means each batch teaches you something about the new store under a heavier load than the last, and the tables that matter most move only after the platform has proven itself on the rest. Track each batch in a simple runbook with the table list, validation results, and cutover time, so the process repeats cleanly.

Keep a rollback path for each batch. Until the old store is retired, the catalog's previous storage configuration and the untouched copies are your rollback. If validation fails after cutover, switch the catalog back, investigate, and retry the batch. Writes made on the new store after cutover need to be replayed or copied back during a rollback, which is another reason to move tables in small batches and keep the window between cutover and validation short.

## Failure Modes

Storage problems in a lakehouse surface as table problems, which makes them easy to misdiagnose. These are the patterns to recognize.

Slow planning with fast scans points to small-object latency. If query plans take seconds while data reads are quick, the store is slow on the many small metadata reads. Compare small-object GET latency between candidates, and keep manifests compacted so planning reads fewer files.

Queries that read far more bytes than they return point to range request problems. If storage metrics show full-object reads where the engine expected ranged reads, the store or a proxy in front of it is not honoring range headers. The suffix range check in the smoke test catches this early.

Maintenance jobs that time out or leave garbage point to listing and delete problems. Orphan cleanup that never finishes, or snapshot expiration that leaves files behind, usually traces to slow pagination or per-object deletes. Confirm that the engine uses batch deletes and that the store returns consistent pages.

Tables that break after a storage policy change point to lifecycle rules. A rule that expires objects after 90 days deletes data files that a long-lived snapshot still references. Let Iceberg's snapshot expiration decide what to delete, and keep bucket lifecycle rules away from table locations, except for cleaning up incomplete multipart uploads.

Credential failures on every table load point to the delegation setup. If the catalog is configured to vend credentials and the store has no compatible STS, every request fails. Either configure the catalog for a credential mode the store supports, or choose a store whose STS works with your catalog.

Requests going to the wrong host point to endpoint configuration in the wrong place. Keep endpoints in the catalog's storage configuration and engine catalog properties, never in table properties, and keep catalogs patched against issues like CVE-2026-97395.

## Operational Guidance

Once a store is chosen and tables are moving, a few practices keep self-hosted storage healthy under a lakehouse.

Size for small objects, not just capacity. Iceberg metadata, streaming commits, and position delete files produce many small objects. Erasure coding schemes that are efficient for large objects add relative overhead for tiny ones. Check how your chosen store handles small objects, and keep table maintenance running so small files get compacted into target-sized ones.

Keep table maintenance on a schedule. Self-hosted storage has a fixed capacity, unlike cloud buckets that grow without limit. Snapshot expiration and orphan file removal are what return space. A table with no maintenance grows until the cluster fills, and the cleanup at that point is slow and risky.

Watch request metrics alongside capacity. Most stores expose request counts, error rates, and latency histograms through Prometheus or OpenTelemetry. Alert on small-object GET latency, ranged GET errors, and listing latency, since those map directly to planning time, query errors, and maintenance health.

Put the catalog in charge of access. Whatever credential model your store supports, route engine access through the catalog. Static keys belong to the catalog, not to every cluster. Where the store supports STS, use scoped, short-lived credentials. Where it does not, consider remote signing, so storage keys never leave the catalog.

Pin versions and track advisories. A young store moves fast, and so do its fixes. Pin exact versions in deployments, subscribe to security advisories, and keep a staging environment that runs the smoke test and a small end-to-end suite on every upgrade before production does.

Separate CI storage from production storage. A lightweight store is a fine choice for laptops and CI, and Iceberg's own move to RustFS for tests shows that pattern working. Production deserves its own evaluation against its own workload, even when the product is the same.

Plan capacity with headroom for rewrites. Compaction and layout rewrites write new files before old ones are expired, so a partition being rewritten briefly takes up to twice its size. Keep enough free capacity for your largest planned rewrite, plus normal growth.

## Where Self-Hosted Lakehouse Storage Is Heading

The end of MinIO's community edition forced a decision many teams had deferred, and the market that replaced it looks different from the one MinIO dominated.

The first change is license clarity. RustFS and SeaweedFS both use Apache 2.0, which removes the AGPL questions that followed MinIO into many legal reviews. For organizations that embed storage in products or distribute modified builds, that alone changes the calculation.

The second change is storage that understands tables. RustFS 1.0 ships an Iceberg REST catalog inside the storage system, in preview, following the cloud providers that added table-aware storage. Its roadmap points to S3 Vectors support in a 2.0 release, aimed at AI storage workloads. The direction is clear: object stores want to know which objects form a table, not just store bytes. That raises a design question for every lakehouse team. A catalog embedded in storage is convenient, but a catalog that lives apart from storage, such as Apache Polaris, keeps tables portable across stores and keeps access control in one place even when you run several storage systems. Expect most production deployments to keep the catalog separate, and treat storage-embedded catalogs as a fit for simpler deployments.

The third change is credential models catching up with self-hosted reality. The Polaris community's recent work on configuration toggles, credential mechanisms for non-AWS stores, and endpoint handling all reflect the same pressure. Self-hosted and alternative S3 stores are first-class targets now, and catalogs are adapting to stores whose STS support differs from AWS. Expect clearer, documented credential options for each major store over the next year.

The fourth change is testing culture. The Iceberg project switching its test backend after a container broke is a small event with a large lesson. The storage layer under a lakehouse is now a choice teams revisit, not a fixed assumption. Teams that keep a smoke test and an end-to-end suite ready make that choice in days rather than quarters.

## Conclusion

MinIO's community edition is archived, and lakehouse teams running self-hosted storage need a plan. The good news is that the options are better than they were a year ago. RustFS offers the closest MinIO replacement under Apache 2.0, with a fresh 1.0 release and an endorsement from Iceberg's own test suite. SeaweedFS brings a longer production record and strong small-object performance. Ceph RGW remains the choice for organizations that already run Ceph or need large-scale unified storage. Garage serves small, multi-site clusters.

The decision rests on lakehouse behavior, not on a generic compatibility claim. Tables need correct and fast ranged reads, quick small-object access for metadata, reliable multipart uploads, consistent listings, batch deletes, and increasingly conditional writes. Catalogs that vend scoped credentials need a working STS, or a fallback such as remote signing. Decide the credential model first, run the smoke test against every candidate, then validate end to end with your real catalog and engines.

Migrate table by table, keep the old store read-only until maintenance runs cleanly on the new one, and keep the test suite around. The next storage change will be easier for it, whenever and however it arrives.

## Keep Going

If this piece was useful, I have written a lot more on lakehouse architecture, catalogs, and the storage layer underneath them. *Apache Polaris: The Definitive Guide* (O'Reilly) covers catalog-managed access, credential vending, and how a REST catalog connects engines to object storage safely. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
