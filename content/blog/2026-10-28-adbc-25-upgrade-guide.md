---
title: "What Actually Changes When You Upgrade to Apache Arrow ADBC 25"
description: "Apache Arrow ADBC 25 changes Go import paths, C# 1.0 packages, Rust cancellation and the C++20 baseline. What breaks per language, with examples."
date: 2026-10-28T09:00:00Z
tags: ["apache-arrow", "adbc", "go", "rust", "python"]
canonical: "https://datalakehousehub.com/blog/adbc-25-upgrade-guide/"
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/adbc-25-upgrade-guide/).

A dependency bot opens a pull request on Monday morning. It bumps your Go ADBC packages from 1.12 to 1.13, and the build fails with an import path error. Across the hall, the .NET team sees a NuGet package jump from 0.24 to 1.0 and wonders whether that means a rewrite. The Rust service compiles but now prints deprecation warnings about a `cancel` method nobody remembers calling. All three teams are looking at the same release.

Apache Arrow ADBC 25 shipped on October 26, 2026. The release notes list 56 resolved issues and 142 merged pull requests from 25 contributors. Most of that is bug fixes you will never notice. A handful of changes reach into your build files, your imports and your cancellation code. Those are the ones this guide covers.

I will go language by language: the Go module split, the C# 1.0 milestone, Rust's new cancellation handles and `Send` requirement, the C++20 baseline, and the Python and platform changes. Then I cover the PostgreSQL driver, which got the largest set of functional changes, plus the SQLite and Flight SQL updates. The article closes with the failure modes to expect and an upgrade checklist.

A note on where I sit. I work at Dremio. Dremio's co-founder Jacques Nadeau co-created Apache Arrow, and Dremio's query engine is built on Arrow and serves results over Arrow Flight. Nothing in this guide depends on Dremio. ADBC is a vendor-neutral Apache project, and everything here comes from the public release notes and source tree.

## A Quick Refresher on Where ADBC Sits

ADBC stands for Arrow Database Connectivity. It is a database access API, in the same family as JDBC (Java Database Connectivity) and ODBC (Open Database Connectivity), with one major difference. JDBC and ODBC hand results back row by row. ADBC hands results back as Apache Arrow record batches, which are columnar, typed, in-memory buffers.

That difference matters for analytics. Suppose a Python notebook pulls 20 million rows from a warehouse through ODBC and loads them into pandas or Polars. The driver converts each column value into a row-oriented structure, and then the client converts it back into columns. Two conversions, both expensive, both pointless if the server already stored the data in columns. ADBC skips both. If the server can produce Arrow, the bytes flow through to the client in Arrow form. If the server cannot, the driver does the conversion once, in compiled code, close to the wire.

ADBC has three layers that are easy to confuse.

The **API specification** defines the functions and semantics every driver implements: connecting, running queries, bulk ingest, reading catalog metadata, transactions, and cancellation. It has its own version number. ADBC 25 implements API version 1.1.0.

**Drivers** implement that API for a specific database. The project ships drivers for PostgreSQL, SQLite, Arrow Flight SQL, and a few others. Vendors and community projects ship their own drivers too.

The **driver manager** loads drivers at runtime, so an application can pick a driver by name without linking it at build time. Language bindings in Python, R, Rust, Go, C#, Java, Ruby and JavaScript wrap the driver manager or reimplement the API natively.

Arrow Flight SQL deserves a special mention because people often mix it up with ADBC. Flight SQL is a wire protocol. It defines how a client and server exchange SQL queries and Arrow data over gRPC. ADBC is a client API. The ADBC Flight SQL driver speaks the Flight SQL protocol, so any server that implements Flight SQL gets an ADBC driver for free. Many ADBC users never touch Flight SQL, and many Flight SQL clients never touch ADBC.

## Reading the Version Numbers

ADBC releases have a confusing numbering scheme, and ADBC 25 makes it more visible because C# jumped to 1.0.

The number 25 is the release of the **libraries** as a whole. It is a monotonic release counter, like Arrow's main releases. It does not appear in most package names.

Each language package has its own version number, and they move at different paces:

| Component | Version in release 25 | What the number tells you |
|---|---|---|
| C, C++, GLib, Go, Python, Ruby | 1.13.0 | Stable since 1.0, minor bump per release |
| C# core | 1.0.0 | First stable release of the core libraries |
| C# drivers | 0.25.0 | Still pre-1.0, tracking the release number |
| Java | 0.25.0 | Pre-1.0 |
| JavaScript | 0.25.0 | Pre-1.0 |
| R | 0.25.0 | Pre-1.0 |
| Rust | 0.25.0 | Pre-1.0 |
| API specification | 1.1.0 | Unchanged in this release |

The pattern is simple once you see it. Packages that have declared a stable API carry a 1.x version and bump the minor number each release. Packages that have not declared stability carry 0.N, where N is the release number. Under semantic versioning rules, a 0.x package can break its API on any minor bump. That explains why the Rust packages broke public APIs in this release without a major version change.

C# core crossing from 0.x to 1.0.0 is the headline. It means the C# core library now promises a stable API under semantic versioning. The C# drivers stay at 0.25.0, so they can still change.

The API specification version matters in a different way. A driver that implements API 1.1.0 supports features like statement options, cancellation, bulk ingest modes and richer error details that 1.0.0 lacked. A driver manager loading a driver asks for a specific API version. If you load a 1.0.0-only driver while asking for 1.1.0, the load fails or downgrades, depending on the binding.

## Go: The Module Split

The Go change is the one most likely to break a build on day one.

Before release 25, the Go code lived in one module, `github.com/apache/arrow-adbc/go/adbc`. The core interfaces, the driver manager, and the drivers all shipped together. The Flight SQL driver lived at `github.com/apache/arrow-adbc/go/adbc/driver/flightsql`.

In release 25, the core and the drivers became separate Go modules:

- `github.com/apache/arrow-adbc/go/adbc` holds the core interfaces and shared code.
- `github.com/apache/arrow-adbc/go/driver` holds the drivers, including `go/driver/flightsql`.

The two modules are tagged separately in the repository, as `go/adbc/v1.13.0` and `go/driver/v1.13.0`.

The project made this change for a security reason that every Go team will recognize. The Flight SQL driver pulls in gRPC, protobuf, OAuth2 libraries and OpenTelemetry exporters. Each of those brings its own dependency tree, and each tree collects CVE (Common Vulnerabilities and Exposures) reports over time. When the drivers shared a module with the core interfaces, every project that imported the core also inherited those dependencies in its module graph. Vulnerability scanners flagged them, even in projects that never used the Flight SQL driver. Splitting the modules lets a project that only needs the interfaces stay free of driver dependencies.

Here is what the change looks like in code. A program using the Flight SQL driver before the split imported this:

```go
// Before ADBC 25
import (
	"github.com/apache/arrow-adbc/go/adbc"
	drv "github.com/apache/arrow-adbc/go/adbc/driver/flightsql"
)
```

After the split, the driver import moves to the new module:

```go
// ADBC 25 and later
import (
	"context"
	"fmt"

	"github.com/apache/arrow-adbc/go/adbc"
	drv "github.com/apache/arrow-adbc/go/driver/flightsql"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/memory"
)

func run(ctx context.Context, uri string) error {
	driver := drv.NewDriver(memory.DefaultAllocator)

	db, err := driver.NewDatabase(map[string]string{
		adbc.OptionKeyURI: uri,
	})
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close()

	cnxn, err := db.Open(ctx)
	if err != nil {
		return fmt.Errorf("open connection: %w", err)
	}
	defer cnxn.Close()

	stmt, err := cnxn.NewStatement()
	if err != nil {
		return fmt.Errorf("new statement: %w", err)
	}
	defer stmt.Close()

	if err := stmt.SetSqlQuery("SELECT 1 AS theresult"); err != nil {
		return fmt.Errorf("set query: %w", err)
	}

	reader, _, err := stmt.ExecuteQuery(ctx)
	if err != nil {
		return fmt.Errorf("execute: %w", err)
	}
	defer reader.Release()

	for reader.Next() {
		col := reader.RecordBatch().Column(0).(*array.Int64)
		for i := 0; i < col.Len(); i++ {
			fmt.Println(col.Value(i))
		}
	}
	return reader.Err()
}
```

Walk through it. The `adbc` import still comes from the core module and supplies shared constants such as `adbc.OptionKeyURI`. The driver import is the only line that moved. `drv.NewDriver` takes an Arrow memory allocator, which controls where result buffers get allocated. `NewDatabase` takes a map of string options, the same option keys as before. `db.Open` returns a connection, `NewStatement` returns a statement, and `ExecuteQuery` returns an Arrow record batch reader plus a row count. The loop pulls record batches one at a time, and each batch exposes typed column arrays.

None of the driver logic changed. The option keys, such as `adbc.flight.sql.authorization_header` and the TLS options, keep the same names. You update the import path, update `go.mod`, and rebuild.

The `go.mod` change looks like this:

```
require (
	github.com/apache/arrow-adbc/go/adbc v1.13.0
	github.com/apache/arrow-adbc/go/driver v1.13.0
	github.com/apache/arrow-go/v18 v18.8.0
)
```

Run `go mod tidy` after editing the imports, and Go resolves both modules. Pin both to the same release. Mixing `go/adbc` at 1.13.0 with a driver module from a different release is a recipe for subtle interface mismatches.

Two more Go details matter. The release 25 modules declare `go 1.26.0` in their `go.mod` files, with a comment saying the project requires the latest Go 1.26 toolchain to pick up CVE fixes in Go itself. If your build image still runs Go 1.25, one of two things happens. With `GOTOOLCHAIN` set to `auto`, Go downloads a newer toolchain before building. With `GOTOOLCHAIN` set to `local`, which many locked-down CI images use, the build stops with a version error. Update the image first. Both modules also depend on `arrow-go/v18` at v18.8.0, so expect that dependency to move too.

If your project only uses the ADBC interfaces, for example a library that accepts any `adbc.Driver` from its caller, you get the full benefit of the split. Remove the driver import, and your module graph sheds gRPC and its dependencies. Run your vulnerability scanner before and after to see the difference.

## C#: Core Hits 1.0

The C# core libraries reached version 1.0.0 in release 25. Three things came with that number.

**API stability.** A 1.0 version is a promise. Under semantic versioning, the C# core packages will not break public APIs without a 2.0 release. For teams that held off on ADBC in .NET because every release shifted the ground, this is the signal to commit. The drivers stay at 0.25.0, so driver-specific APIs still carry the pre-1.0 caveat.

**ADBC 1.1 API support.** The C# core now supports the ADBC 1.1 APIs. The 1.1 revision of the specification added features such as typed option getters and setters, cancellation of running work, richer error details and more bulk ingest modes. Those are now reachable from .NET through the core libraries. If you wrote workarounds in .NET code for missing 1.1 features, review them. Some will now be dead code.

**Extension types in ADO.NET.** ADBC's C# libraries include an ADO.NET client, which wraps ADBC behind the standard `DbConnection`, `DbCommand` and `DbDataReader` interfaces that .NET developers already know. In release 25, that client supports Arrow's canonical extension types, including UUID and Variant.

Extension types are worth a paragraph. Arrow has a small set of storage types: integers, floats, strings, binary, lists, structs and so on. An extension type attaches a name and metadata to a storage type so that consumers can interpret it. A UUID is stored as a 16-byte fixed-size binary with the `arrow.uuid` extension name. Variant, the semi-structured type used by Apache Iceberg and Apache Parquet for JSON-like data, is stored as binary with its own extension name. Without extension type support, an ADO.NET reader sees a UUID column as a raw byte array and leaves the conversion to you. With it, the reader recognizes the type and returns something your code can treat as a UUID.

For the upgrade itself, the C# steps are short. Update the core package references to 1.0.0. Update driver packages to 0.25.0. Build and look for obsolete-member warnings, which are where 0.x APIs that did not survive into 1.0 tend to show up. If you consume UUID columns through ADO.NET, test what type your reader now returns. Code that cast the value to `byte[]` is the code most likely to need a change.

## Rust: Safer Cancellation and Send Drivers

The Rust libraries had the most invasive changes, and the project was clear about the reason. The release notes describe a set of changes aimed at reducing unsafe code and undefined behavior. Some low-level public APIs changed as a result, and exported drivers now require `Send`.

Rust packages are at 0.25.0. As noted earlier, pre-1.0 packages can break APIs on a minor bump, and this one does. The workspace also declares a minimum supported Rust version of 1.85.

**Exported drivers must be `Send`.** In Rust, `Send` is a marker trait that says a value can be moved to another thread safely. When you write an ADBC driver in Rust and export it through the C interface, the C side of the world has no idea about Rust's thread rules. A C or Python caller can create a connection on one thread and use it on another. If the Rust driver type was not `Send`, that was undefined behavior waiting to happen. Release 25 closes the hole by requiring exported drivers to implement `Send`. If you maintain a Rust driver that wraps a non-thread-safe client, you now have to fix that at compile time, usually by wrapping the client in a `Mutex` or by restructuring state.

**Cancellation moved to a handle.** The old API put a `cancel(&mut self)` method on `Connection` and `Statement`. That signature is the problem. It takes a mutable borrow of the statement. But the only time you want to cancel a statement is while it is running, and while it is running, something else already holds the mutable borrow, because `execute` takes `&mut self` too. The borrow checker made the old API impossible to call safely from a second thread. The release notes say so directly: the old `cancel` API was never usable safely.

Release 25 deprecates `cancel` (since 0.25.0) and adds `get_cancel_handle`. It returns a `Box<dyn CancelHandle>`. `CancelHandle` is a trait with one method, `try_cancel(&self)`, and the trait requires `Send + Sync`. You get the handle before you start the work, move it to another thread or task, and call `try_cancel` when you want to stop. Cancellation is best effort. Drivers that do not support it return a handle that reports cancellation as not implemented.

Here is a full example using the driver manager to load the PostgreSQL driver and cancel a slow query after five seconds:

```rust
use std::thread;
use std::time::Duration;

use adbc_core::options::{AdbcVersion, OptionDatabase, OptionValue};
use adbc_core::{CancelHandle, Connection, Database, Driver, Statement};
use adbc_driver_manager::ManagedDriver;

fn main() -> adbc_core::error::Result<()> {
    // Load the driver shared library by name, asking for API 1.1.0
    let mut driver = ManagedDriver::load_dynamic_from_name(
        "adbc_driver_postgresql",
        None,
        AdbcVersion::V110,
    )?;

    let db = driver.new_database_with_opts([(
        OptionDatabase::Uri,
        OptionValue::String("postgresql://localhost:5432/analytics".into()),
    )])?;

    let mut conn = db.new_connection()?;
    let mut stmt = conn.new_statement()?;
    stmt.set_sql_query("SELECT pg_sleep(60)")?;

    // Grab the handle BEFORE execute takes the mutable borrow
    let handle: Box<dyn CancelHandle> = stmt.get_cancel_handle();

    let watchdog = thread::spawn(move || {
        thread::sleep(Duration::from_secs(5));
        if let Err(e) = handle.try_cancel() {
            eprintln!("cancel failed: {e:?}");
        }
    });

    match stmt.execute() {
        Ok(reader) => {
            for batch in reader {
                println!("{} rows", batch?.num_rows());
            }
        }
        Err(e) => eprintln!("query stopped: {e:?}"),
    }

    watchdog.join().expect("watchdog thread panicked");
    Ok(())
}
```

Here is what each part does. `ManagedDriver::load_dynamic_from_name` finds the driver library by its base name, without the platform prefix or suffix, and initializes it at the requested API version. `AdbcVersion::V110` asks for the 1.1.0 API, which is where cancellation lives. `new_database_with_opts` takes an iterator of option pairs, here just the URI. The statement gets a query that sleeps for 60 seconds, which stands in for any slow query.

The key line is `get_cancel_handle`. It takes `&self`, so it borrows the statement briefly and returns an owned handle. The handle is `Send`, so `thread::spawn` can move it into the watchdog thread. Then `execute` takes the mutable borrow on the main thread. Five seconds later, the watchdog calls `try_cancel`, and the driver sends a cancel request to the server. The main thread sees `execute` return an error, or sees the reader stop with an error during iteration, depending on when the cancel lands.

If you used the deprecated `cancel` method anywhere, the compiler now warns you. The default implementation of `cancel` forwards to `get_cancel_handle().try_cancel()`, so old code keeps running for now. Migrate anyway. Deprecated methods get removed, and the new pattern is the only one that works across threads.

## C and C++: The C++20 Baseline

The C++ libraries now require C++20. That covers the driver manager and the drivers written in C++, such as PostgreSQL and SQLite.

The C API itself does not change. ADBC's public interface is a C header, and C callers do not need a C++20 compiler to call it. The requirement hits you if you build ADBC's C++ code from source, for example in a monorepo with vendored dependencies, or in a conda or vcpkg recipe.

Check three things. First, your compiler version. Any recent GCC, Clang or MSVC release supports the C++20 features most projects use, but older enterprise build images often pin compilers from several years ago. Second, your build flags. If your CMake setup forces `CMAKE_CXX_STANDARD` to 17 for the whole tree, ADBC's targets will fail. Let ADBC set its own standard, or raise the global setting. Third, mixed standard builds. Linking C++17 and C++20 objects together works in most toolchains as long as no C++ types cross the boundary. ADBC's boundary is the C API, so this is usually safe.

If you consume prebuilt binaries from PyPI, conda-forge or your package manager, none of this affects you. The packagers already built with C++20.

## Python, Windows on ARM and Platform Support

**Python 3.15 wheels are out, and Python 3.10 is gone.** Release 25 publishes wheels for Python 3.15. Python 3.10 reached end of life before the release, so the project dropped it. The Python packages now declare a minimum of Python 3.11. If a pipeline still runs 3.10, `pip` will keep installing the previous ADBC release, because the new one does not match the interpreter. That fails quietly. You end up on old drivers without an error message, so check your lock files.

**Windows on ARM gets partial support.** The release adds Windows-on-ARM builds for Node.js packages, Python wheels, and the Java JNI (Java Native Interface) JARs. ARM laptops running Windows are now common on developer desks, and before this release, ADBC users on those machines had to build from source or run under x64 emulation. The release notes call this some support, not complete support. Test your specific driver on the platform before you roll it out to a team.

**ADBC has a logo.** It does not change your code, but it is in the release notes, and it means project slides will look better.

## PostgreSQL Driver: Type Resolution and a Long List of Compatible Databases

The PostgreSQL driver got more functional changes than any other component in release 25. It is also the driver most people run in production, because PostgreSQL is everywhere and many databases speak its wire protocol.

Here is what changed, grouped by what it means for you.

**Temporary tables show up in catalog metadata.** ADBC's `GetObjects` call returns the catalogs, schemas, tables and columns a connection can see. Before release 25, the PostgreSQL driver left temporary tables out. Tools that build table pickers or autocomplete from `GetObjects` now see temp tables created in the session.

**TIME columns can be ingested.** Bulk ingest of Arrow `time` columns into PostgreSQL `TIME` columns now works. If you converted time-of-day values to strings or integers before ingest to dodge this gap, you can drop that step.

**Result schemas carry the exact PostgreSQL type.** Result set schema fields now include `POSTGRESQL:type` field metadata. Arrow types are coarser than PostgreSQL types. A PostgreSQL `varchar(50)`, `text` and `citext` all come back as Arrow strings. A `jsonb` column also comes back as a string or binary. The field metadata tells the consumer which PostgreSQL type produced the column, so downstream code can tell a `jsonb` from a plain `text` without a second query against the system catalog.

**UUID works for queries and bulk ingest.** The driver now supports Arrow's canonical UUID extension type in both directions. A PostgreSQL `uuid` column comes back as an `arrow.uuid` column, and an Arrow UUID column ingests into a `uuid` column. This pairs with the extension type support in the C# ADO.NET client.

**Decimal ingest got faster on Windows.** Decimal ingestion was already optimized on other platforms using 128-bit integer arithmetic. The Windows toolchain did not support that type, so Windows builds fell back to a slower path. Release 25 fixes that, and Windows users ingesting large decimal columns get a meaningful speedup.

**The driver is tested against many PostgreSQL-compatible databases.** The project now runs its test suite against AlloyDB Omni, CedarDB, Citus, CockroachDB, CrateDB, Materialize, ParadeDB, TimescaleDB and YugabyteDB. That list matters because "PostgreSQL compatible" covers a wide range of behavior. Some of these systems implement the wire protocol and most of the SQL surface but skip parts of the system catalog. Testing against them turns compatibility from a claim into a checked fact.

**A new option controls how the driver resolves types.** This is the change most likely to matter for teams using compatible databases. When the PostgreSQL driver starts, it needs to map PostgreSQL type OIDs (object identifiers, the numeric IDs PostgreSQL assigns to every type) to the parsers that turn wire data into Arrow arrays. By default, the driver asks the server for that mapping by querying the system catalog. That works on real PostgreSQL. It breaks on databases that do not implement the catalog tables the query needs. It also slows connection startup on databases with a very large number of tables and types.

Release 25 adds a database option called `adbc.postgresql.type_resolver_mode`. It accepts these values:

| Value | Behavior | Tradeoff |
|---|---|---|
| `server` | Query the server's catalog for the type mapping. This is the default. | Supports user-defined types, slower startup on very large catalogs, fails on databases missing the catalog tables |
| `builtin` | Use a fixed lookup table of PostgreSQL's built-in type OIDs | Fast startup, works on compatible databases without full catalogs, cannot read or write user-defined types |
| `auto` | Planned fallback mode | Not yet implemented in release 25, returns a not-implemented error |

The release notes say some of the compatible databases in the test list need the `builtin` mode enabled to work. The project plans to keep improving this so the downside goes away, and the `auto` value in the source is the placeholder for that work.

Here is how to set it from Python:

```python
import adbc_driver_postgresql.dbapi as pg

uri = "postgresql://analyst@db.internal:5432/warehouse"

with pg.connect(
    uri,
    db_kwargs={"adbc.postgresql.type_resolver_mode": "builtin"},
) as conn:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT order_id, customer_uuid, placed_at, total "
            "FROM sales.orders WHERE placed_at >= now() - interval '1 day'"
        )
        table = cur.fetch_arrow_table()

print(table.schema)
for field in table.schema:
    print(field.name, field.metadata)
```

Here is what each piece does. `adbc_driver_postgresql.dbapi.connect` returns a DB-API 2.0 connection, the standard Python database interface, backed by the ADBC driver. The `db_kwargs` argument passes options to the ADBC database object, and that is where `type_resolver_mode` lives, because type resolution happens once when the database initializes, not per connection. The `with` blocks close the cursor and connection. `fetch_arrow_table` returns the whole result as a PyArrow table, with no row-by-row conversion. The final loop prints each field's metadata, which is where you see the new `POSTGRESQL:type` entries.

Two warnings about `builtin`. If your schema uses enums, domains, composite types or extension types such as PostGIS geometry, `builtin` mode cannot handle them. Columns of those types will fail. And `builtin` is a database-level choice, so every connection from that database object uses it. If one application talks to both a full PostgreSQL server with custom types and a compatible database without a full catalog, create two ADBC database objects with different settings.

For real PostgreSQL with no startup problems, leave the default alone. Reach for `builtin` when a compatible database rejects the catalog query, or when connection startup on a catalog with tens of thousands of objects is measurably slow.

## SQLite and Flight SQL Changes

**SQLite.** The SQLite driver got a batch of fixes aimed at bringing its behavior closer to the other drivers. SQLite is often the driver people use for local development and tests, because it needs no server. When its behavior differs from the PostgreSQL or Flight SQL drivers, tests pass locally and fail in staging. Closer parity means fewer of those surprises. If your test suite has special cases for SQLite, rerun it with release 25 and see which ones you can delete.

**Flight SQL.** The Flight SQL driver now supports the `is_update` field when the server reports it. Flight SQL servers execute statements and return results as Arrow streams, and from the client's side, a statement that updates rows and a statement that returns rows can look similar on the wire. A server that sets `is_update` tells the client which kind of statement it ran. The driver uses that to route the result correctly, so an update statement reports its affected row count instead of looking like an empty query result. Servers that do not send the field behave as before.

The Flight SQL driver is the one most analytics tools use to reach engines that serve Arrow natively, because it carries Arrow data from server to client with no conversion in between. Since the Go drivers now live in their own module, Flight SQL users in Go are the group most affected by this release. The driver logic is the same, only its import path moved.

## A Smoke Test You Can Reuse

Release notes tell you what changed. A smoke test tells you whether the change reached your environment. Here is a short Python script that exercises the PostgreSQL changes from this release in about a second against a real server. Run it in the same environment, with the same lock file, that your production jobs use.

```python
import datetime
import uuid

import pyarrow as pa
import adbc_driver_manager
import adbc_driver_postgresql
import adbc_driver_postgresql.dbapi as pg

URI = "postgresql://ci_user@localhost:5432/ci"

print("driver manager:", adbc_driver_manager.__version__)
print("postgresql driver:", adbc_driver_postgresql.__version__)

sample = pa.table({
    "id": pa.array([1, 2], type=pa.int64()),
    "external_id": pa.array(
        [uuid.uuid4().bytes, uuid.uuid4().bytes], type=pa.uuid()
    ),
    "opens_at": pa.array(
        [datetime.time(9, 0), datetime.time(17, 30)], type=pa.time64("us")
    ),
})

with pg.connect(URI) as conn:
    info = conn.adbc_get_info()
    print("server:", info.get("vendor_name"), info.get("vendor_version"))

    with conn.cursor() as cur:
        # TIME and UUID ingest, into a session-scoped temp table
        rows = cur.adbc_ingest("adbc_smoke", sample, mode="create", temporary=True)
        print("ingested rows:", rows)

        cur.execute("SELECT id, external_id, opens_at FROM adbc_smoke ORDER BY id")
        result = cur.fetch_arrow_table()

    for field in result.schema:
        print(field.name, field.type, field.metadata)

    # Temp tables should now appear in catalog metadata
    objects = conn.adbc_get_objects(
        depth="tables", table_name_filter="adbc_smoke"
    ).read_all()
    print("temp table visible in GetObjects:", objects.num_rows > 0)
```

Walk through what each block proves.

The two version prints confirm the resolver installed the 1.13.0 packages. This is the cheapest guard against the silent Python 3.10 problem described in the failure modes below. If either line prints a 1.12 version, stop and fix the environment before testing anything else.

The `sample` table builds three columns. `pa.uuid()` is PyArrow's constructor for the canonical UUID extension type, and it stores each value as 16 raw bytes. `pa.time64("us")` is a time-of-day column with microsecond precision. Those two columns are exactly the types release 25 added ingest support for.

`adbc_get_info` returns a dictionary of driver and server facts. Printing the vendor name and version in CI logs saves time later, when someone asks which server a failing run hit.

`adbc_ingest` with `mode="create"` and `temporary=True` creates a temporary table and bulk loads the Arrow data into it. The PostgreSQL driver uses the `COPY` protocol for ingest, which avoids a per-row insert loop. Temporary tables vanish when the session ends, so the script leaves nothing behind on the CI database. Before release 25, the `opens_at` column was the one that failed at this step.

The `SELECT` reads the rows back as a PyArrow table. The schema loop is where you see the new behavior. The `external_id` field comes back as a UUID extension type, and each field's metadata includes the `POSTGRESQL:type` entry naming the server-side type.

The last block calls `adbc_get_objects` at table depth, filtered to the temp table's name. On release 24, temporary tables did not appear in this result. On release 25, the row count is above zero.

Turn the prints into assertions before you put this in CI. Assert the version strings start with `1.13`. Assert the UUID field's type is the extension type, not plain fixed-size binary. Assert the `GetObjects` count is positive. Each assertion maps to one line in the release notes, so a failure points straight at the change that did not land.

You can extend the same pattern to the other languages. A Go test that imports `go/driver/flightsql` and runs `SELECT 1` against a test server proves the module split is wired correctly. A Rust test that cancels a `pg_sleep` query with a handle from `get_cancel_handle`, as in the earlier example, proves cancellation works end to end. Keep each smoke test small enough to run on every build.

## Failure Modes During the Upgrade

These are the problems I expect teams to hit, roughly in order of how often.

**Go import path errors.** The build fails with a message that the package `github.com/apache/arrow-adbc/go/adbc/driver/flightsql` cannot be found in the module. The fix is the import change and `go.mod` update described above. Search your whole repository for `arrow-adbc/go/adbc/driver/` before you start. Generated code and test helpers often hide extra imports.

**Go toolchain mismatches in CI.** A local build works because the developer's machine downloaded Go 1.26 automatically, and the CI build fails because the image pins an older toolchain with `GOTOOLCHAIN=local`. Update the image.

**Python silently staying on the old release.** A Python 3.10 environment resolves to the last ADBC release that supported it. Nothing fails, but none of the fixes arrive. The warning sign is a lock file that shows an older `adbc-driver-manager` or `adbc-driver-postgresql` version than you expected. Upgrade the interpreter, or pin the ADBC packages explicitly so the resolver fails loudly.

**Rust driver crates that stop compiling.** If you maintain a Rust driver exported through the C interface and its types are not `Send`, release 25 refuses to compile it. The fix lives in your driver: make the shared state thread-safe. Do not reach for `unsafe impl Send` to silence the error. That reintroduces the exact undefined behavior the change was meant to remove.

**Rust deprecation warnings treated as errors.** Projects that build with `-D warnings` or `#![deny(deprecated)]` will fail on any call to the old `cancel` method. Migrate those calls to `get_cancel_handle` rather than allowing the lint.

**C++ standard conflicts in source builds.** A CMake tree that forces C++17 globally fails when it reaches ADBC's C++ targets. The error messages point at C++20 language features, which makes the cause easy to spot once you know to look for it.

**PostgreSQL user-defined types under `builtin`.** A team sets `type_resolver_mode` to `builtin` to fix a compatible database, then reuses the same configuration against a PostgreSQL server with enum columns. Queries touching those columns fail. Keep the setting scoped to the database that needs it.

**UUID type changes downstream.** Code that read PostgreSQL UUID columns as raw bytes or strings now receives an Arrow UUID extension type. Consumers that check types strictly, such as schema validation in a data pipeline, flag the change. Update the expected schema, and confirm that whatever writes the data further down, for example a Parquet writer, handles the extension type the way you want.

## An Upgrade Checklist

Use this as a working list for each service that depends on ADBC.

1. **Inventory the packages.** List every ADBC package each service uses and its current version. Note the language, because each one has a different version number for the same release.
2. **Check runtimes and toolchains.** Go 1.26 for Go modules. Python 3.11 or newer for Python packages. Rust 1.85 or newer for Rust crates. A C++20 compiler if you build from source.
3. **Go: update imports and modules.** Change every `go/adbc/driver/...` import to `go/driver/...`. Require both `go/adbc` and `go/driver` at v1.13.0. Run `go mod tidy` and your vulnerability scanner, and compare the results to the previous scan.
4. **C#: update package references.** Core packages to 1.0.0, driver packages to 0.25.0. Build and review obsolete-member warnings. Test UUID columns through ADO.NET.
5. **Rust: migrate cancellation.** Replace every `cancel()` call with a handle from `get_cancel_handle()` taken before execution starts. If you ship a driver, confirm its exported types are `Send` without `unsafe` shortcuts.
6. **Python: confirm the resolved version.** After upgrading, print `adbc_driver_manager.__version__` or check your lock file to confirm you are on the 1.13.0 packages.
7. **PostgreSQL: test type handling.** Run your schema checks against result sets and look for `POSTGRESQL:type` metadata and UUID extension types. If you connect to a PostgreSQL-compatible database that previously failed at startup, try `type_resolver_mode=builtin` on a dedicated database object.
8. **Flight SQL: check update statements.** If your server reports `is_update`, confirm that update and DDL statements now report affected rows as expected.
9. **Roll out by service, not all at once.** Start with services that only read data. Move write paths, especially bulk ingest, after a few days of clean runs.

## Where ADBC Is Heading

The release notes close with a short roadmap. The project is working on the next revision of the API standard, version 1.2.0, and the focus is missing features, mostly metadata and catalog data. Progress is tracked in a GitHub milestone for the 1.2.0 specification.

That focus makes sense. ADBC already does the core job well: run a query, get Arrow back, push Arrow in. The gaps show up when a tool wants to know more about the database it is talking to. A BI tool building a schema browser, a data catalog crawling tables, or an AI agent deciding which table answers a question all need rich metadata: column comments, constraints, statistics, and object types beyond plain tables. Today, much of that requires falling back to database-specific SQL against system catalogs, which defeats the point of a common API.

AI agents raise the stakes here. An agent connecting to a database through a tool interface such as MCP (Model Context Protocol) needs to discover structure before it writes a query. A standard, Arrow-native way to fetch that structure across many databases is exactly the layer an agent framework wants underneath it.

The other direction to watch is the C# work. With the core at 1.0 and the 1.1 API in place, the .NET ecosystem has a stable, Arrow-native data access layer for the first time. Expect more .NET drivers to show up, and expect the C# drivers to move toward their own 1.0.

## Conclusion

ADBC 25 is mostly a release of fixes, with a few changes that reach into your build. Go users have to move their driver imports to the new `go/driver` module, which pays them back with a cleaner dependency graph. C# users get a stable 1.0 core with the full 1.1 API and extension type support in ADO.NET. Rust users get a cancellation API that finally works across threads, at the cost of migrating old calls and making drivers `Send`. C++ source builds need C++20. Python users need 3.11 or newer.

The PostgreSQL driver is where most of the functional value lands: temp tables in metadata, TIME ingest, exact type metadata, UUID support, faster Windows decimal ingest, and a type resolver option that opens the driver to a long list of PostgreSQL-compatible databases.

Work through the checklist one service at a time, and the upgrade is an afternoon per language rather than a week of surprises.

## Keep Going

If this piece was useful, I have written a lot more on Apache Arrow and the open lakehouse stack it powers. *Architecting an Apache Iceberg Lakehouse* (Manning) covers how Arrow, Parquet, Iceberg and catalogs fit together into a working analytics platform. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
