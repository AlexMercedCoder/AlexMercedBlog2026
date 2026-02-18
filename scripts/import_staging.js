const fs = require('fs-extra');
const path = require('path');
const matter = require('gray-matter');
const slugify = require('slugify');

// Paths relative to execution in root or scripts folder
const STAGING_DIR = path.resolve(__dirname, '../staging');
const CONTENT_DIR = path.resolve(__dirname, '../content/blog/2026');
const PUBLIC_ASSETS_DIR = path.resolve(__dirname, '../public/assets/images/2026');

const SERIES_MAP = {
    'data_modeling': { label: 'Data Modeling', tags: ['Data Modeling', 'Data Engineering', 'Architecture'] },
    'debp': { label: 'Data Engineering Best Practices', tags: ['Data Engineering', 'Best Practices', 'Pipelines'] },
    'semantic_layer_seo': { label: 'Semantic Layer SEO', tags: ['Semantic Layer', 'Data Governance', 'BI'] }
};

async function main() {
    console.log('🚀 Starting Staging Import...');

    console.log(`📂 Staging Dir: ${STAGING_DIR}`);
    console.log(`📂 Content Dir: ${CONTENT_DIR}`);

    // Ensure destination directories exist
    await fs.ensureDir(CONTENT_DIR);
    await fs.ensureDir(PUBLIC_ASSETS_DIR);

    if (!(await fs.pathExists(STAGING_DIR))) {
        console.error('❌ Staging directory not found!');
        return;
    }

    const seriesList = await fs.readdir(STAGING_DIR);
    let currentDate = new Date('2026-02-18');

    for (const series of seriesList) {
        const seriesPath = path.join(STAGING_DIR, series);
        const stats = await fs.stat(seriesPath);
        if (!stats.isDirectory()) continue;
        
        console.log(`\nProcessing Series: ${series}`);
        
        // Check config
        const seriesConfig = SERIES_MAP[series] || { tags: [series] };

        const chapters = await fs.readdir(seriesPath);
        chapters.sort(); // Ensure order by folder name (e.g. 01, 02)
        console.log(`Found ${chapters.length} chapters.`);

        for (const chapter of chapters) {
            console.log(`   Detailed check: ${chapter}`);
            const chapterPath = path.join(seriesPath, chapter);
            const cStats = await fs.stat(chapterPath);
            if (!cStats.isDirectory()) {
                console.log(`   Skipping ${chapter} (not a directory)`);
                continue;
            }

            // Look for main markdown file
            const files = await fs.readdir(chapterPath);
            const mdFile = files.find(f => f.endsWith('.md'));

            if (!mdFile) {
                console.warn(`   ⚠️ Skipping ${chapter}: No markdown file found.`);
                continue;
            }

            const chapterContentPath = path.join(chapterPath, mdFile);
            console.log(`   📄 Reading: ${chapterContentPath}`);

            // 1. Read Content & Extract Title
            const rawFileContent = await fs.readFile(chapterContentPath, 'utf-8');
            
            // Fix: Separate declaration and assignment
            const parsed = matter(rawFileContent);
            let frontmatter = parsed.data;
            let content = parsed.content;
            
            // Extract Title from H1 if not in frontmatter
            let title = frontmatter.title;
            if (!title) {
                const titleMatch = content.match(/^#\s+(.+)$/m);
                if (titleMatch) {
                    title = titleMatch[1].trim();
                     // Remove H1 from content
                    content = content.replace(/^#\s+(.+)$/m, '').trim();
                } else {
                    title = `${series} - ${chapter}`;
                }
            }

            // Generate Filename
            const titleSlug = slugify(title, { lower: true, strict: true, remove: /[*+~.()'"!:@]/g });
            const dateStr = currentDate.toISOString().split('T')[0];
            const filename = `${dateStr}-${titleSlug}.md`;
            const destPath = path.join(CONTENT_DIR, filename);

            // 2. Handle Images
            let coverImage = frontmatter.cover_image || frontmatter.bannerImage;
            
            // Prepare Image Directory: public/assets/images/2026/series/chapter/
            const relImageDir = `assets/images/2026/${series}/${chapter}`;
            const absImageDir = path.join(PUBLIC_ASSETS_DIR, series, chapter);
            await fs.ensureDir(absImageDir);

            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
                    // Copy Image
                    const srcImg = path.join(chapterPath, file);
                    const destImg = path.join(absImageDir, file);
                    await fs.copy(srcImg, destImg);
                    
                    const publicPath = `/${relImageDir}/${file}`;
                    
                    // Replace in Markdown
                    // Regex is safer with escape
                    const escapedFile = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    
                    // 1. Markdown Image: ![alt](file.png)
                    content = content.replace(new RegExp(`\\]\\(${escapedFile}\\)`, 'g'), `](${publicPath})`);
                    content = content.replace(new RegExp(`\\]\\("./${escapedFile}"\\)`, 'g'), `](${publicPath})`);
                    
                    // 2. HTML Image: src="file.png"
                    content = content.replace(new RegExp(`src="${escapedFile}"`, 'g'), `src="${publicPath}"`);
                    
                    // Set first image as cover if not set
                    if (!coverImage) coverImage = publicPath;
                }
            }

            // 3. Prepare Final Frontmatter
            // Description: First paragraph
            let description = frontmatter.description;
            if (!description) {
                const descMatch = content.match(/^(?!#)(.+)$/m); 
                if (descMatch) {
                    description = descMatch[1].replace(/[\[\]#*`]/g, '').substring(0, 160).trim() + '...';
                } else {
                    description = title; 
                }
            }

            // Clean up old frontmatter fields we don't need
            const newFrontmatter = {
                title,
                date: dateStr,
                description,
                author: "Alex Merced",
                tags: seriesConfig.tags,
                cover_image: coverImage, 
                draft: false
            };

            // Write File
            const newFileContent = matter.stringify(content, newFrontmatter);
            await fs.writeFile(destPath, newFileContent);
            console.log(`      ✅ Created: ${filename}`);

            // Increment Date (Disabled per user request)
            // currentDate.setDate(currentDate.getDate() + 1);
        }
    }
    console.log('🎉 Import Complete!');
}

main().catch(console.error);
