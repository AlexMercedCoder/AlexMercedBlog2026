import os
import re
import shutil
from datetime import datetime, timedelta

def get_title(content):
    match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
    if match:
        return match.group(1).strip()
    return "Untitled"

def process_series(base_date, series_path, series_prefix, tags):
    staging_base = f"staging/{series_path}"
    out_dir = "content/blog"
    assets_out = f"public/assets/blog/{series_prefix}"
    
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(assets_out, exist_ok=True)
    
    if not os.path.exists(staging_base):
        print(f"Staging path {staging_base} not found.")
        return
        
    dirs = sorted([d for d in os.listdir(staging_base) if os.path.isdir(os.path.join(staging_base, d))])
    
    # Pre-compute URL mappings
    url_map = {}
    slugs = {}
    for d in dirs:
        slug = f"2026-04-29-{series_prefix}-{d}"
        slugs[d] = slug
        url_map[f"../{d}/content.md"] = f"/blog/{slug}.html"
    
    for i, d in enumerate(dirs):
        dir_path = os.path.join(staging_base, d)
        content_file = os.path.join(dir_path, "content.md")
        
        if not os.path.exists(content_file):
            print(f"Skipping {d}: No content.md found")
            continue
            
        with open(content_file, "r") as f:
            content = f.read()
            
        title = get_title(content)
        # Remove the first H1 to avoid duplication
        content = re.sub(r'^#\s+.+\n+', '', content, count=1, flags=re.MULTILINE)
        
        # Calculate staggered date
        post_time = base_date + timedelta(minutes=i)
        date_str = post_time.strftime("%Y-%m-%dT%H:%M:%SZ")
        
        # Build frontmatter
        frontmatter = f"""---
title: "{title}"
date: {date_str}
tags: {tags}
---
"""
        
        # Replace cross-links
        for old_link, new_link in url_map.items():
            content = content.replace(old_link, new_link)
            
        # Also handle potential direct folder links
        for old_dir, new_slug in slugs.items():
            content = content.replace(f"../{old_dir}/", f"/blog/{new_slug}.html")
            
        # Find and copy images
        image_matches = re.finditer(r'!\[([^\]]*)\]\(([^)]+)\)', content)
        for match in image_matches:
            alt_text = match.group(1)
            img_path = match.group(2)
            
            # If it's a local image (no http or absolute path)
            if not img_path.startswith("http") and not img_path.startswith("/"):
                src_img = os.path.join(dir_path, img_path)
                if os.path.exists(src_img):
                    # Copy to public
                    dest_name = f"{d}-{os.path.basename(img_path)}"
                    dest_path = os.path.join(assets_out, dest_name)
                    shutil.copy2(src_img, dest_path)
                    
                    # Update content
                    new_img_path = f"/assets/blog/{series_prefix}/{dest_name}"
                    content = content.replace(f"]({img_path})", f"]({new_img_path})")
                else:
                    print(f"Warning: Image {img_path} not found in {dir_path}")
        
        out_content = frontmatter + content
        out_file = os.path.join(out_dir, f"{slugs[d]}.md")
        
        with open(out_file, "w") as f:
            f.write(out_content)
            
        print(f"Published: {slugs[d]}")

if __name__ == "__main__":
    base_time = datetime(2026, 4, 29, 12, 0, 0)
    
    print("Processing Apache Iceberg Masterclass...")
    process_series(
        base_time, 
        "apache-iceberg-masterclass", 
        "iceberg-masterclass", 
        '["iceberg", "data-lake"]'
    )
    
    # Start second series an hour later
    second_base = base_time + timedelta(hours=1)
    
    print("\\nProcessing Query Engine Optimization...")
    process_series(
        second_base, 
        "query-engine-optimization", 
        "query-engine", 
        '["query-engine", "database"]'
    )
    
    print("\\nMigration complete.")
