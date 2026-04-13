import os
import re

directories = [
    "01-apache-software-foundation",
    "02-apache-parquet",
    "03-apache-iceberg",
    "04-apache-polaris",
    "05-apache-arrow",
    "06-assembling-apache-lakehouse",
    "07-agentic-analytics"
]

urls = {
    1: "/blog/2026-03-07-apache-software-foundation-history-purpose-and-process.html",
    2: "/blog/2026-03-07-what-is-apache-parquet-columns-encoding-and-performance.html",
    3: "/blog/2026-03-07-what-is-apache-iceberg-the-table-format-revolution.html",
    4: "/blog/2026-03-07-what-is-apache-polaris-unifying-the-iceberg-ecosystem.html",
    5: "/blog/2026-03-07-what-is-apache-arrow-erasing-the-serialization-tax.html",
    6: "/blog/2026-03-07-assembling-the-apache-lakehouse-the-modular-architecture.html",
    7: "/blog/2026-03-07-agentic-analytics-on-the-apache-lakehouse.html"
}

base_dir = "/home/alexmerced/development/personal/Personal/blog/2026/AlexMercedBlog2026/staging/apache-lakehouse"

for subdir in directories:
    filepath = os.path.join(base_dir, subdir, "content.md")
    if not os.path.exists(filepath):
        print(f"File not found: {filepath}")
        continue
        
    with open(filepath, 'r') as f:
        content = f.read()
        
    # Replace the links with regex matching the exact URL paths like ../01-apache-software-foundation/README.md
    for i in range(1, 8):
        # We look for: (../0X-something/README.md)
        pattern = re.compile(r'\(\.\./0' + str(i) + r'-.*?/README\.md\)')
        replacement = f'({urls[i]})'
        content = pattern.sub(replacement, content)
        
    with open(filepath, 'w') as f:
        f.write(content)

print("Links fixed.")
