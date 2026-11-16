---
title: "Verifying Lakehouse Release Artifacts: Apache Trusted Releases, SBOMs and VEX"
description: "Verify lakehouse releases with signatures, checksums, SBOMs and VEX. Apache Polaris is adding CycloneDX inventories and trialling ASF Trusted Releases."
date: 2026-11-16T09:00:00Z
tags: ["Apache Polaris", "Software Supply Chain", "Security", "SBOM", "Apache Iceberg"]
canonical: https://datalakehousehub.com/blog/verifying-lakehouse-release-artifacts-atr-sbom-vex/
---

> **Cross-posted.** This article's canonical home is [Data Lakehouse Hub](https://datalakehousehub.com/blog/verifying-lakehouse-release-artifacts-atr-sbom-vex/).

Verifying a lakehouse release means checking more than a version number. Confirm the signature and checksum against the project's KEYS file, read the SBOM for bundled dependencies, and use VEX statements to tell which scanner findings are exploitable. Apache Polaris is proposing to publish SBOMs and to trial the ASF's Trusted Releases platform for 1.10.0.

Three threads on the Apache Polaris dev list in the week of November 9, 2026 turn this from a general best practice into a concrete change for anyone running open lakehouse software. On November 6 and 9, the project decided to document dependency vulnerability findings with VEX statements instead of forcing version overrides ([VEX thread](https://lists.apache.org/thread/pf9s8lqtr9nf7ompy1gobwlzvp4otqwn)). On November 9, Robert Stupp proposed publishing CycloneDX SBOMs alongside release artifacts ([SBOM thread](https://lists.apache.org/thread/cm3wb15vg7ws4j98bpq1myt5n18j635h)). On November 14, Jean-Baptiste Onofré proposed Polaris 1.10.0 for mid-December and evaluating the Apache Trusted Releases platform for it ([ATR thread](https://lists.apache.org/thread/nw6qb8mzw2mc0wc09clhqvt54sl6mf0m)).

This article is for platform teams that take open source releases into production. It is different from deciding which vulnerabilities to patch first. That question is covered in the [Lakehouse Dependency CVE Ledger, November 2026](https://datalakehousehub.com/blog/lakehouse-dependency-cve-ledger-november-2026/). Here the questions are earlier and broader: is the artifact you downloaded the one the project released, what is inside it, and which scanner findings actually matter.

## What an Apache release vote checks, and what it leaves to you

Every Apache Software Foundation (ASF) project, including Iceberg, Polaris, Arrow, and Parquet, follows the same release process. A release manager builds a release candidate, signs it with a personal key listed in the project's KEYS file, and publishes checksums. The project calls a vote. Committee members download the candidate, check signatures, checksums, license headers, and the build, and vote. A release needs at least three binding +1 votes and more +1 than -1 votes.

That process gives you real guarantees. The source release was reviewed by people accountable to the foundation. The signature ties it to a named release manager. The license files have been checked against what is bundled.

It leaves three things to you.

**Your copy.** The vote verified the candidate the committee downloaded. It cannot verify the copy you downloaded from a mirror, a package registry, or a container registry last Tuesday. You have to check your copy against the signature and checksum yourself.

**Convenience binaries.** ASF policy treats the source release as the official release. Binaries, JARs on Maven Central, wheels on PyPI, and container images are convenience artifacts built from that source. Their provenance is only as good as the process that built and uploaded them.

**What is inside.** A signature proves who released an artifact. It says nothing about which third-party libraries it bundles or whether any of them carry known vulnerabilities.

The three Polaris threads address exactly these gaps.

## Step 1: Verify signatures and checksums yourself

Signature and checksum checks take two minutes and catch corrupted downloads, tampered mirrors, and mistaken artifacts. Every Apache project documents the steps on its download page, and they are the same everywhere.

```bash
# 1. Download the artifact, its signature, its checksum, and the project's KEYS file
#    from the links on the project's official download page.

# 2. Import the release managers' public keys.
gpg --import KEYS

# 3. Check the signature against the artifact.
gpg --verify apache-polaris-1.9.0-bin.tgz.asc apache-polaris-1.9.0-bin.tgz

# 4. Check the checksum.
sha512sum -c apache-polaris-1.9.0-bin.tgz.sha512
```

`gpg --import` loads the public keys of everyone allowed to sign releases for the project. `gpg --verify` checks that the `.asc` signature matches the artifact and was made by one of those keys. A "Good signature" line means the file is exactly what that key holder signed. A warning that the key is not certified with a trusted signature is normal unless you have built a web of trust. The point is that the key appears in the project's own KEYS file. `sha512sum -c` recomputes the artifact's SHA-512 hash and compares it with the published value. The file names above follow the usual Apache pattern. Use the exact names from the download page.

Two rules make this check meaningful:

- **Get KEYS and checksums from the project's own site, not a mirror.** A tampered mirror can serve a tampered artifact with a matching tampered checksum. The KEYS file and checksums should come from the official `downloads.apache.org` links on the project's download page.
- **Automate it.** Put these commands in the pipeline that pulls new releases into your environment, and fail the pipeline on a bad signature.

Package registries add their own checks. Maven Central requires signed artifacts. PyPI supports trusted publishing from CI. Container registries support signing tools. Use those checks where your tooling supports them, and fall back to the commands above for anything else.

## Step 2: Read the SBOM

A software bill of materials (SBOM) lists the components inside an artifact: libraries, versions, licenses, and hashes. For server software like a catalog, that list matters, because a single binary distribution bundles hundreds of third-party libraries.

### What Polaris proposed

Robert Stupp's November 9 proposal sets a concrete initial scope:

- CycloneDX JSON SBOMs as sidecar files for the binary ZIP and TAR distributions, covering the server and admin tool, and for each Spark bundle JAR.
- Each SBOM identifies the actual release artifact by SHA-256, and the SBOMs are signed and published alongside the artifacts.
- Spark bundle SBOMs are also attached to the existing Maven publications.
- For the server and admin tool, the SBOM reuses inventories that Quarkus already generates. For the Spark bundles, it uses the official CycloneDX Gradle plugin, reading the dependencies the Shadow plugin actually selected for the bundle.
- Container image SBOMs come later as a separate step.

The proposal also replaces the build's license-report plugin with Licensee, a tool from Cash App that checks dependency licenses against an allowlist. The packaged LICENSE and NOTICE files stay. The old license-report ZIP goes away, and Robert asked whether anyone relies on it.

The detail about Shadow is the important one. A Spark bundle JAR is a "fat JAR" that copies its dependencies inside itself, sometimes renaming their packages. An SBOM built from the project's declared dependencies lists what the build asked for. An SBOM built from what Shadow actually packed lists what you received. Only the second is useful for checking vulnerabilities.

### The coverage limit, stated honestly

Yufei Gu raised a concern on November 15 that every SBOM consumer should understand. Robert's reply confirmed that dependencies embedded inside Iceberg's own bundled JAR are not fully inventoried, and that the generated SBOMs explicitly mark completeness as unknown. Expanding coverage depends on suitable SBOMs from upstream projects, such as Iceberg, that can be matched to the bundled artifacts.

Yufei's summary of the risk is the sentence to remember. VEX lets Polaris explain whether a known dependency vulnerability affects a release, but a dependency missing from the inventory can still escape detection, so missing information should not be read as evidence of safety. Robert agreed to proceed with the initial scope and clear documentation of the limitation.

That candor is a good sign. An SBOM that claims completeness when it is not complete is worse than no SBOM, because it gives false confidence.

### Reading one

CycloneDX JSON is easy to inspect with standard tools. To list every component and version in an SBOM:

```bash
jq -r '.components[] | "\(.name)\t\(.version)"' polaris-server-sbom.cdx.json | sort
```

`.components[]` walks the list of components, and the string template prints each name and version separated by a tab. Sorting the output makes it easy to diff two releases. Run the same command on the SBOM for the version you run today and the one you are upgrading to, and `diff` the results to see exactly which libraries changed.

Also check the `metadata` section. It identifies the artifact the SBOM describes, including its hash. Confirm that hash matches the artifact you verified in Step 1. An SBOM for a different build tells you nothing about yours.

## Step 3: Use VEX to separate real risk from noise

Point a vulnerability scanner at a lakehouse server distribution and it finds dozens of CVEs. Most of them do not matter. The library is present, but the vulnerable code is never reached. A Vulnerability Exploitability eXchange (VEX) statement is how a project says so in a machine-readable way.

### The Polaris case

Jean-Baptiste Onofré's November 6 email is a model of how to do this work. Several open pull requests were overriding transitive dependency versions to clear scanner findings. He checked each CVE against the server and admin distributions from both the 1.8.0 release and the main branch, looking at the JARs actually shipped and how each library is used. None were exploitable in Polaris:

1. **Brotli4j.** The vulnerable code is the native Brotli decoder, which ships only in Brotli4j's native JARs. Polaris ships the pure Java JARs with no native library, so the decoder never loads.
2. **ZooKeeper 3.8.6.** Every published CVE affecting that version is in the ZooKeeper server. Polaris uses only the ZooKeeper client, through Ranger and Hadoop, and starts no ZooKeeper server.
3. **commons-configuration2.** The CVE is a stack overflow when parsing untrusted YAML with cycles. Nothing Polaris ships uses the library's YAML support.
4. **Jetty.** The bug is in `jetty-server`, which Polaris does not ship. It ships `jetty-client` and supporting JARs.

He also showed that the overrides do not even quiet the scanners. The `hadoop-client-runtime` JAR bundles shaded copies of commons-configuration2 and Jetty that Gradle cannot change, so the findings stay regardless. Five more ZooKeeper CVEs affect the overridden version too. The plan became: document the assessments with VEX, and close the override PRs. The SBOM proposal links each SBOM to a mutable VEX feed, proposed in PR #6001, so assessments can change without regenerating signed release inventories.

### What a VEX statement looks like

CycloneDX supports VEX through an `analysis` object on each vulnerability. A statement for the ZooKeeper case, written in that format, looks like this:

```json
{
  "id": "CVE-XXXX-NNNNN",
  "affects": [{ "ref": "pkg:maven/org.apache.zookeeper/zookeeper@3.8.6" }],
  "analysis": {
    "state": "not_affected",
    "justification": "code_not_reachable",
    "detail": "Polaris uses only the ZooKeeper client via Ranger and Hadoop. No ZooKeeper server is started."
  }
}
```

The `id` names the vulnerability. The CVE number here is a placeholder. The `affects` entry points at the component by package URL. The `analysis.state` of `not_affected` is the claim, and `justification` gives a standard reason from a fixed list, here that the vulnerable code is not reachable. The `detail` field explains the reasoning in plain language so a human reviewer can check it.

Scanners that understand VEX use these statements to suppress findings automatically. Scanners that do not still let you attach them as evidence in a review.

### How to use VEX as a consumer

VEX shifts work from you to the project, but it does not remove your judgment.

- **Trust the reasoning, not the label.** Read the `detail`. A statement that says "Polaris does not start a ZooKeeper server" is checkable. Confirm your deployment matches.
- **Watch for configuration drift.** A `not_affected` justification often depends on how the software is configured. If you enable a feature the project assumed was off, the statement no longer applies.
- **Remember what VEX does not cover.** VEX speaks only about components in the inventory. Yufei's warning applies: a dependency missing from the SBOM is invisible to VEX, too.

## Why scanners overreport on lakehouse software

The Polaris VEX analysis is not an unusual case. Lakehouse software is built in ways that make vulnerability scanners noisy, and understanding why helps you triage faster.

**Huge transitive trees.** A catalog server or an engine pulls in cloud SDKs for several providers, Hadoop client libraries, serialization frameworks, and an HTTP stack. Each brings its own dependencies. A distribution with hundreds of JARs gives scanners hundreds of chances to match a CVE database entry.

**Client code that shares a name with server code.** Many projects publish client and server in the same artifact family. A scanner sees `zookeeper` or `jetty` and reports server CVEs, even when only client classes ship. JB's ZooKeeper and Jetty findings were exactly this.

**Optional native code.** Some libraries ship pure Java fallbacks alongside native code in separate artifacts. The Brotli4j case shows how a CVE in native code gets reported against a deployment that never loads it.

**Shaded and bundled copies.** Fat JARs, such as `hadoop-client-runtime` or an engine's Iceberg runtime JAR, copy dependencies inside themselves and often rename packages. Scanners that inspect contents find old versions you cannot upgrade without upgrading the bundling project. Scanners that only read metadata miss them entirely. Both outcomes are wrong in different directions.

**Unused features.** A library often contains code for formats or protocols the host project never calls. The commons-configuration2 YAML case is typical.

Every one of these produces a finding that is accurate about the library and wrong about the product. VEX exists to record the difference once, at the source, rather than in every downstream team's spreadsheet.

## Applying this across the open lakehouse stack

Polaris is the example this month, but you run more than a catalog. Each layer of an open lakehouse arrives through a different channel, and each needs the same three checks.

**Iceberg runtime JARs for engines.** Spark and Flink load Iceberg through a runtime JAR from Maven Central. That JAR bundles dependencies, which is why Polaris's SBOM cannot see inside it. Verify the JAR's signature from Maven Central, and pin the exact version in your engine's configuration rather than resolving a range at startup.

**PyIceberg and pyarrow wheels.** Python packages arrive from PyIceberg's and Arrow's PyPI pages. The pyarrow wheel bundles Arrow's C++ libraries and their native dependencies, which makes it a large native artifact. Use a lock file with hashes, so your installer refuses any wheel whose hash does not match.

**Catalog and engine container images.** Images bundle an operating system layer on top of the application. Scanners report OS package CVEs alongside application ones. Separate the two in triage, since the fixes come from different places.

**Arrow and Parquet libraries in your own services.** If your services link Arrow or Parquet directly, your build owns the dependency. Generate your own SBOM for each service, and include these libraries in it.

The same intake checklist applies to every item. Only the verification tool changes: GPG for Apache distributions, registry signatures and hashes for Maven and PyPI, and image signing tools for containers.

## Who owns this in your organization

Verification fails most often because nobody owns it. The platform team assumes security handles it. Security assumes the platform team pins and checks what it deploys.

Assign it explicitly. The team that deploys a component owns verifying its artifacts, collecting its SBOM, and recording its VEX version. Security owns the scanner, the triage policy, and the review of findings that VEX does not cover. Both share the deployment record.

Put the checks where they cannot be skipped: in the pipeline that promotes a new version from staging to production. A manual checklist gets skipped during an urgent upgrade, which is exactly when a tampered or wrong artifact does the most harm.

## Step 4: Know what ATR changes

The Apache Trusted Releases (ATR) platform is new infrastructure built by the ASF Tooling team. JB's November 14 email described it as a centralized platform to modernize how Apache projects build, verify, vote on, and publish releases. Its [documentation](https://releases.apache.org/docs/) is public.

According to that email, ATR does four things:

- **Automated checks during composition.** ATR validates release candidates for signatures, checksums, license headers, and SBOMs before a vote is called, giving release managers feedback early.
- **Managed voting and publishing.** ATR runs the release through three stages, Compose, Vote, and Finish. It tabulates votes, strips release candidate tags on approval, and tracks distribution to channels such as Maven Central and PyPI.
- **Trusted publishing from CI.** Projects with reproducible builds can trigger releases from GitHub Actions using OpenID Connect authentication, with no long-lived credentials.
- **A release catalog with attestations.** ATR generates release attestations and keeps a public catalog of current and archived ASF artifacts, to help downstream users verify provenance and meet regulations such as the EU Cyber Resilience Act.

JB noted a few prerequisites, including reproducible builds, and said he is checking them. Robert pointed to ATR presentations from the ASF Infrastructure track at Community Over Code in Glasgow as background.

For consumers, two parts of ATR matter most.

**Attestations.** A release attestation is a signed statement about how an artifact was built. If a release comes with one, you can check that the artifact came from the project's CI, from a specific source commit, rather than from someone's laptop. That covers the gap that signatures alone leave for convenience binaries.

**Reproducible builds.** A reproducible build produces byte-identical output from the same source. If Polaris ships reproducible builds, anyone can rebuild a release from source and compare hashes. That is the strongest provenance check available, because it does not require trusting any build server.

Polaris already moved in this direction. Release 1.4.0 added reproducible source tarballs. ATR builds on that foundation.

## An intake checklist for platform teams

Here is a checklist for bringing any open lakehouse release, whether Iceberg, Polaris, Arrow, Parquet, or an engine, into production. Each item maps to a step above.

1. **Verify the signature and checksum** against KEYS and checksum files from the project's official download page. Fail the pipeline on mismatch.
2. **Pull artifacts from one trusted channel per type.** Maven Central for JARs, PyPI for wheels, the project's download page for distributions, and a pinned registry for images. Record which channel each artifact came from.
3. **Collect the SBOM** if the project publishes one. Confirm its artifact hash matches your verified artifact.
4. **Diff the SBOM against the previous version** you ran. Review new and changed components.
5. **Run your scanner and apply the project's VEX.** Review remaining findings by hand.
6. **Record coverage gaps.** If the SBOM marks completeness as unknown, note which bundled components are not inventoried, and scan them separately where you can.
7. **Check attestations** when the project publishes them. Confirm the build came from the expected source commit.
8. **Store everything.** Keep the artifact hash, SBOM, VEX version, and scan results with your deployment record. When the next CVE lands, you can answer "are we affected" from your records instead of from memory.

The same practices apply to the infrastructure underneath your lakehouse. Choosing object storage after the changes in the MinIO project raised similar provenance questions, covered in [Choosing Self-Hosted Object Storage for the Lakehouse After MinIO](https://datalakehousehub.com/blog/self-hosted-object-storage-after-minio/).

## A worked intake: Polaris 1.9.0

Here is the checklist applied to the release that shipped on November 14, so you can see what each step produces today and what changes once the proposals land.

**Signature and checksum.** The 1.9.0 binary distribution, its `.asc` signature, and its `.sha512` checksum are linked from the [Polaris 1.9.0 download page](https://polaris.apache.org/downloads/1.9.0/). Run the four commands from Step 1. This step works today, as it has for every Apache release.

**SBOM.** The SBOM proposal targets the main branch after the 1.9.x branch was cut, so 1.9.0 does not ship with project-published CycloneDX sidecars. For this release, generate your own SBOM from the distribution with a scanner that inspects JAR contents, and mark it as consumer-generated in your records. Expect project SBOMs in a later release.

**Dependency diff.** Even without an SBOM, the release notes name changes that move the dependency tree. Polaris upgraded its bundled Apache Iceberg to 1.12.0. Its AWS SDK clients moved to Apache HttpClient 5. The `apache-polaris` Python package dropped its boto3 dependency and now accepts pydantic from 2.12 up to, but excluding, 3.0. Each of those shifts which CVEs a scanner reports. Diff your generated SBOM against the one you made for 1.8.x, and expect these areas to change.

**VEX.** The four override PRs from early November were closed in favor of VEX documentation, and the VEX feed itself is proposed in PR #6001. Until it publishes, JB's November 6 email is the project's written assessment of those four findings. Save a link to it with your scan results.

**Attestation.** No ATR attestation exists for 1.9.0. If the 1.10.0 trial goes ahead, that release is the first where you can check one.

The exercise shows the value of building the process before the inputs exist. Each later Polaris release fills in a step you already run, and your pipeline gets stricter without being redesigned.

## Failure modes

**Verifying against the wrong keys.** Downloading KEYS from a mirror, or importing keys from a public keyserver by name, lets an attacker supply both a fake key and a fake signature. Always use the project's KEYS file from its official site.

**Trusting an SBOM for a different artifact.** An SBOM generated from a source build describes that build. If you run a container image built separately, the SBOM does not describe it. Match hashes.

**Reading "not in the SBOM" as "not present."** Fat JARs and shaded dependencies hide components from many tools. The Polaris SBOM documents this limit for libraries inside Iceberg's bundled JAR. Treat missing entries as unknown.

**Override churn.** Forcing transitive versions to silence scanners, as the closed Polaris PRs did, can break runtime behavior and still leave findings in shaded copies. Prefer VEX for non-exploitable findings and real upgrades for exploitable ones.

**Stale VEX.** A VEX statement made for one release does not automatically cover the next. The Polaris design links SBOMs to a mutable VEX feed for this reason. Check the VEX version against the release you run.

**Regulatory gaps.** The EU Cyber Resilience Act raises expectations for manufacturers that ship software in products. If your product embeds open lakehouse components, your obligations depend on your role. Talk to counsel. SBOMs, VEX, and attestations are the evidence you will need either way.

## Where this is heading

Polaris is ahead of most open lakehouse projects on this work, and the pieces fit together. SBOMs list what ships. VEX explains which findings matter. ATR attests to how releases were built and runs the checks before votes. Reproducible builds let anyone confirm the result.

Watch for Polaris 1.10.0, proposed for mid-December, as the first release that potentially uses ATR, depending on JB's prerequisite check. Watch for SBOM publication landing on main after the 1.9.x branch. And watch for upstream SBOMs from Iceberg and other projects, which Robert named as the path to closing the coverage gap. As those arrive, this checklist gets easier to automate across the whole stack.

## Conclusion

A version number tells you what you meant to install. Verification tells you what you actually installed. Check signatures and checksums against the project's own KEYS file. Read the SBOM, match its hash to your artifact, and diff it between releases. Apply VEX statements to scanner findings, read their reasoning, and treat gaps in the inventory as unknown rather than safe.

Apache Polaris is turning these steps into release infrastructure: CycloneDX SBOMs for distributions and Spark bundles, a VEX feed for dependency findings, and a trial of the ASF's Trusted Releases platform. Build the intake checklist now, and each of those additions slots into a process you already run.

## Keep Going

If this piece was useful, I have written a lot more on running open lakehouse software in production. *Apache Polaris: The Definitive Guide* (O'Reilly) covers deploying and operating the catalog, and my other books cover lakehouse architecture end to end. You can find every book I have written, across lakehouse architecture, Apache Iceberg, Apache Polaris, and AI, at [books.alexmerced.com](https://books.alexmerced.com).
