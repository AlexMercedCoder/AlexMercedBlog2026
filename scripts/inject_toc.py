import os
import re

def build_toc():
    # Ordered list of query engine files
    files = [
        ("2026-04-29-query-engine-01-overview.md", "How Query Engines Think: The Tradeoffs Behind Every Data System"),
        ("2026-04-29-query-engine-02-row-vs-column-storage.md", "Row vs. Column: How Storage Layout Shapes Everything"),
        ("2026-04-29-query-engine-03-data-organization-on-disk.md", "How Databases Organize Data on Disk: Pages, Blocks, and File Formats"),
        ("2026-04-29-query-engine-04-indexing-strategies.md", "B-Trees, LSM Trees, and the Indexing Tradeoff Spectrum"),
        ("2026-04-29-query-engine-05-query-optimizer.md", "Inside the Query Optimizer: How Engines Pick a Plan"),
        ("2026-04-29-query-engine-06-execution-models.md", "Volcano, Vectorized, Compiled: How Engines Execute Your Query"),
        ("2026-04-29-query-engine-07-memory-and-caching.md", "Buffer Pools, Caches, and the Memory Hierarchy"),
        ("2026-04-29-query-engine-08-partitioning.md", "Partitioning, Sharding, and Data Distribution Strategies"),
        ("2026-04-29-query-engine-09-distributed-joins.md", "Hash, Sort-Merge, Broadcast: How Distributed Joins Work"),
        ("2026-04-29-query-engine-10-concurrency-control.md", "Concurrency, Isolation, and MVCC: How Engines Handle Contention"),
    ]
    
    toc = "\\n## Series Table of Contents\\n\\n"
    for i, (filename, title) in enumerate(files, 1):
        slug = filename.replace(".md", ".html")
        toc += f"{i}. [{title}](/blog/{slug})\\n"
    toc += "\\n---\\n\\n"
    return toc, [f[0] for f in files]

def inject_toc():
    toc_str, file_list = build_toc()
    
    for filename in file_list:
        filepath = os.path.join("content/blog", filename)
        if not os.path.exists(filepath):
            continue
            
        with open(filepath, "r") as f:
            content = f.read()
            
        # We need to inject the TOC right after the frontmatter and meta comments.
        # Find the end of frontmatter and any trailing meta comments.
        # Frontmatter ends with `---`
        # Then there might be `<!-- Meta ... -->` comments.
        
        # Let's split by `---` (3 parts: empty, frontmatter, rest)
        parts = content.split("---", 2)
        if len(parts) == 3:
            rest = parts[2]
            
            # Find the end of the meta comments
            lines = rest.strip().split('\\n')
            inject_idx = 0
            for i, line in enumerate(lines):
                if line.strip().startswith('<!--'):
                    inject_idx = i + 1
                elif line.strip() == '':
                    continue
                else:
                    break
                    
            new_rest = "\\n".join(lines[:inject_idx]) + "\\n" + toc_str + "\\n".join(lines[inject_idx:])
            new_content = "---".join(parts[:2]) + "---" + "\\n" + new_rest
            
            with open(filepath, "w") as f:
                f.write(new_content)
            print(f"Injected TOC into {filename}")

if __name__ == "__main__":
    inject_toc()
