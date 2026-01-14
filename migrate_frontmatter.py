import os
import glob
import frontmatter
import yaml
import argparse

def migrate_file(filepath, dry_run=False):
    """
    Migrates a single markdown file's frontmatter.
    """
    try:
        post = frontmatter.load(filepath)
        metadata = post.metadata
        content = post.content
        
        changed = False
        
        # 1. Remove Image Fields
        keys_to_remove = ['cover_image', 'bannerImage', 'image']
        for key in keys_to_remove:
            if key in metadata:
                if dry_run:
                    print(f"[DRY RUN] {filepath}: Would remove '{key}'")
                else:
                    del metadata[key]
                    changed = True

        if 'tags' not in metadata:
            print(f"[FIX] {filepath}: Adding missing field 'tags'")
            if not dry_run:
                metadata['tags'] = []
                changed = True
        
        # 2. Ensure Required Fields (Warn if missing others)
        required_fields = ['title', 'date']
        for field in required_fields:
            if field not in metadata:
                print(f"[WARNING] {filepath}: Missing required field '{field}'")
        
        # 3. Standardize Tags (Ensure list)
        if 'tags' in metadata:
            if isinstance(metadata['tags'], str):
                # split by comma if string
                tags_list = [t.strip() for t in metadata['tags'].split(',')]
                if dry_run:
                    print(f"[DRY RUN] {filepath}: Would convert tags string to list: {tags_list}")
                else:
                    metadata['tags'] = tags_list
                    changed = True
        
        # 4. Save if changed
        if changed and not dry_run:
            # We use frontmatter.dumps, but we need to be careful about YAML formatting.
            # python-frontmatter uses PyYAML.
            new_content = frontmatter.dumps(post)
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(new_content)
            print(f"[UPDATED] {filepath}")
        elif changed and dry_run:
            print(f"[DRY RUN] {filepath}: Changes detected but not saved.")
        else:
            # print(f"[SKIPPED] {filepath}: No changes needed.")
            pass

    except Exception as e:
        print(f"[ERROR] Failed to process {filepath}: {e}")

def main():
    parser = argparse.ArgumentParser(description='Migrate blog frontmatter.')
    parser.add_argument('--dry-run', action='store_true', help='Print changes without modifying files')
    args = parser.parse_args()

    base_dir = './content/blog'
    
    # Walk through all directories
    for root, dirs, files in os.walk(base_dir):
        for file in files:
            if file.endswith('.md'):
                filepath = os.path.join(root, file)
                migrate_file(filepath, dry_run=args.dry_run)

if __name__ == "__main__":
    main()
