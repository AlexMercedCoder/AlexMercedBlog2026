const fs = require('fs-extra');
const path = require('path');
const { marked } = require('marked');
const matter = require('gray-matter');
const hljs = require('highlight.js');

marked.use({
    renderer: {
        code(token) {
            // Handle both new (object) and old (string) marked renderer signatures
            const code = typeof token === 'string' ? token : token.text;
            const language = typeof token === 'string' ? arguments[1] : token.lang;
            
            const validLang = !!(language && hljs.getLanguage(language));
            const highlighted = validLang ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
            const langClass = language ? `language-${language}` : '';
            return `<div class="code-container"><button class="copy-btn" onclick="copyCode(this)">Copy</button><pre><code class="hljs ${langClass}">${highlighted}</code></pre></div>`;
        }
    }
});

// --- Configuration ---
const CONFIG_PATH = './config.json';
const THEME_PATH = './theme.json';
const CONTENT_DIR = './content';
const PUBLIC_DIR = './public';
const DIST_DIR = './dist';

// --- Helpers ---
function escapeXml(unsafe) {
    if (!unsafe) return "";
    return unsafe.replace(/[<>&'"]/g, c => {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
    });
}

async function generateCoverImage(title, slug, theme) {
    const dir = path.join(DIST_DIR, 'assets', 'covers');
    await fs.ensureDir(dir);
    
    // Text Wrapping Logic
    const words = title.split(' ');
    const lines = [];
    let currentLine = words[0];

    for (let i = 1; i < words.length; i++) {
        if (currentLine.length + 1 + words[i].length < 25) { // Approx char limit for 64px font
            currentLine += ' ' + words[i];
        } else {
            lines.push(currentLine);
            currentLine = words[i];
        }
    }
    lines.push(currentLine);

    // Generate tspans
    // Initial Y offset to center the block of text.
    // Each line adds ~1.2em height.
    // If we have N lines, total height is roughly N*1.2em.
    // We want to start drawing so the center of the block is at 50%.
    // A simple hack is to start at 50% minus half the total height, then add 1.2em per line.
    
    // Simplest approach: Start at 50% and use dy.
    // First line gets a negative dy correction if there are multiple lines? 
    // Actually, just standard vertical stacking centered around y="50%" is tricky with pure SVG without tspans math.
    
    // Better strategy for vertical centering of multi-line text:
    // y="50%" is the baseline for the first line? No.
    // usage: <text y="50%"> <tspan x="50%" dy="-0.6em">Line 1</tspan> <tspan x="50%" dy="1.2em">Line 2</tspan> </text>
    
    const lineHeight = 1.2; // em
    const startDy = -((lines.length - 1) * lineHeight) / 2;
    
    const textContent = lines.map((line, index) => {
        const dy = index === 0 ? `${startDy}em` : `${lineHeight}em`;
        return `<tspan x="50%" dy="${dy}">${escapeXml(line)}</tspan>`;
    }).join('');

    // SVG with Theme Gradient
    const svg = `
    <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:${theme.colors.primary};stop-opacity:1" />
                <stop offset="100%" style="stop-color:${theme.colors.secondary};stop-opacity:1" />
            </linearGradient>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="${theme.colors.on_primary}" stroke-width="1" opacity="0.1"/>
            </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)" />
        <rect width="100%" height="100%" fill="url(#grid)" />
        
        <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="'Roboto', sans-serif" font-weight="bold" font-size="64" fill="${theme.colors.on_primary}">
            ${textContent}
        </text>
        
        <rect x="45%" y="85%" width="10%" height="6" fill="${theme.colors.tertiary || theme.colors.on_primary}" rx="3" />
    </svg>
    `;
    
    const filePath = path.join(dir, `${slug}.svg`);
    await fs.writeFile(filePath, svg);
    return `/assets/covers/${slug}.svg`;
}

function calculateReadingTime(content) {
    const wordsPerMinute = 200;
    const words = content.replace(/[#*`]/g, '').split(/\s+/).length;
    const minutes = Math.ceil(words / wordsPerMinute);
    return `${minutes} min read`;
}

async function loadJSON(filepath) {
  if (await fs.pathExists(filepath)) {
    return fs.readJSON(filepath);
  }
  return {};
}

// ... existing code ...

async function getFiles(dir) {
    let results = [];
    const list = await fs.readdir(dir);
    for (const file of list) {
        const filePath = path.join(dir, file);
        const stat = await fs.stat(filePath);
        if (stat && stat.isDirectory()) {
            const subResults = await getFiles(filePath);
            results = results.concat(subResults);
        } else {
            results.push(filePath);
        }
    }
    return results;
}



// --- Generators ---

async function generateBlogRSS(posts, config) {
    if (posts.length === 0) return;
    const rssXml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
<channel>
 <title>${config.site_title}</title>
 <description>${config.site_description}</description>
 <link>${config.domain}</link>
 <language>en</language>
 ${posts.map(p => `
   <item>
    <title>${escapeXml(p.title)}</title>
    <link>${config.domain}/blog/${p.slug}.html</link>
    <description>${escapeXml(p.description)}</description>
    <pubDate>${p.dateObj.toUTCString()}</pubDate>
   </item>
 `).join('')}
</channel>
</rss>`;
    await fs.outputFile(path.join(DIST_DIR, 'feed.xml'), rssXml);
    console.log(`📡 Built Blog RSS Feed.`);
}

async function generateTagPages(posts, config, css) {
    const tagsMap = {};
    posts.forEach(p => {
        if (p.tags && Array.isArray(p.tags)) {
            p.tags.forEach(t => {
                const tag = t.trim();
                if (!tagsMap[tag]) tagsMap[tag] = [];
                tagsMap[tag].push(p);
            });
        }
    });

    const tagsDir = path.join(DIST_DIR, 'tags');
    await fs.ensureDir(tagsDir);

    for (const [tag, tagPosts] of Object.entries(tagsMap)) {
         tagPosts.sort((a, b) => b.dateObj - a.dateObj);
         const listHtml = tagPosts.map(p => `
            <div class="card">
                <h2><a href="/blog/${p.slug}.html">${p.title}</a></h2>
                <p class="meta"><small>${p.date}</small></p>
            </div>
        `).join('');
        
        const pageHtml = renderLayout(`<h1>Tag: ${tag}</h1>${listHtml}`, `Tag: ${tag}`, config, css, { path: `/tags/${tag}.html` });
        await fs.outputFile(path.join(tagsDir, `${tag}.html`), pageHtml);
    }
    console.log(`🏷️ Built ${Object.keys(tagsMap).length} Tag Pages.`);
}

function getRelatedPosts(current, all) {
    if (!current.tags || current.tags.length === 0) return [];
    
    return all
        .filter(p => p.slug !== current.slug) // Exclude self
        .map(p => {
            const intersection = p.tags ? p.tags.filter(t => current.tags.includes(t)).length : 0;
            return { post: p, score: intersection };
        })
        .filter(p => p.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(p => p.post);
}

async function generatePaginatedIndex(posts, distDir, config, css) {
    const perPage = config.posts_per_page || 10;
    const totalPages = Math.ceil(posts.length / perPage);
    
    for (let i = 1; i <= totalPages; i++) {
        const start = (i - 1) * perPage;
        const chunk = posts.slice(start, start + perPage);
        
        const listHtml = chunk.map(p => `
            <div class="card">
                ${p.coverImage ? `<a href="/blog/${p.slug}.html"><img src="${p.coverImage}" style="height: 200px; object-fit: cover; width: 100%; margin: 0 0 1rem 0;" /></a>` : ''}
                <h2><a href="/blog/${p.slug}.html">${p.title}</a></h2>
                <p class="meta"><small>${p.date} • ${p.readingTime || ''}</small></p>
            </div>
        `).join('');
        
        const prevLink = i > 1 ? `<a href="${i === 2 ? '/blog/index.html' : `/blog/page/${i - 1}.html`}" class="btn-support" style="text-decoration:none;">← Previous</a>` : '';
        const nextLink = i < totalPages ? `<a href="/blog/page/${i + 1}.html" class="btn-support" style="text-decoration:none;">Next →</a>` : '';
        
        const paginationHtml = `
            <div style="display: flex; justify-content: space-between; margin-top: 2rem;">
                <div>${prevLink}</div>
                <div>${nextLink}</div>
            </div>
             <p style="text-align: center; margin-top: 1rem; color: var(--md-sys-color-outline);">Page ${i} of ${totalPages}</p>
        `;

        const pageTitle = i === 1 ? 'Blog' : `Blog - Page ${i}`;
        const filePath = i === 1 ? path.join(distDir, 'index.html') : path.join(distDir, 'page', `${i}.html`);
        const seoUrl = i === 1 ? '/blog/index.html' : `/blog/page/${i}.html`;
        
        if (i > 1) await fs.ensureDir(path.join(distDir, 'page'));

        const fullHtml = renderLayout(`<h1>${pageTitle}</h1>${listHtml}${paginationHtml}`, pageTitle, config, css, { path: seoUrl, description: `Blog posts page ${i}` });
        await fs.outputFile(filePath, fullHtml);
    }
    console.log(`📝 Built Blog Index (${posts.length} posts, ${totalPages} pages).`);
}

// --- Layout Template ---


function generateCSS(theme) {
  if (!theme || !theme.colors) return '';
  
  // Extract font names for Google Fonts Import
  const headingFontName = theme.fonts.heading.split(',')[0].replace(/['"]/g, '').trim();
  const bodyFontName = theme.fonts.body.split(',')[0].replace(/['"]/g, '').trim();
  const googleFontsUrl = `https://fonts.googleapis.com/css2?family=${headingFontName}:wght@400;700&family=${bodyFontName}:wght@300;400;600&display=swap`;

  return `
    @import url('${googleFontsUrl}');

    :root {
      /* Colors */
      --md-sys-color-primary: ${theme.colors.primary};
      --md-sys-color-on-primary: ${theme.colors.on_primary};
      --md-sys-color-primary-container: ${theme.colors.primary_container};
      --md-sys-color-on-primary-container: ${theme.colors.on_primary_container};
      --md-sys-color-secondary: ${theme.colors.secondary};
      --md-sys-color-secondary-container: ${theme.colors.secondary_container};
      --md-sys-color-surface: ${theme.colors.surface};
      --md-sys-color-on-surface: ${theme.colors.on_surface};
      --md-sys-color-outline: ${theme.colors.outline};
      
      /* Fonts */
      --md-sys-typescale-headline-font: ${theme.fonts.heading};
      --md-sys-typescale-body-font: ${theme.fonts.body};
      
      /* Scale */
      --md-sys-shape-corner: 12px;
      --spacing: 8px;
      
      --card-bg: #FFFFFF;
      
      /* Widths */
      --max-width: 900px;
    }

    [data-theme="dark"] {
      --md-sys-color-primary: #D4E1F5;
      --md-sys-color-on-primary: #0A2647;
      --md-sys-color-primary-container: #2C4B70;
      --md-sys-color-on-primary-container: #D4E1F5;
      --md-sys-color-secondary: #8AB4F8;
      --md-sys-color-secondary-container: #0A2647;
      --md-sys-color-surface: #121212;
      --md-sys-color-on-surface: #E2E2E2;
      --md-sys-color-outline: #9CA3AF;
      --card-bg: #1E1E1E;
    }

    /* Modern Reset */
    *, *::before, *::after { box-sizing: border-box; }
    body {
        font-family: var(--md-sys-typescale-body-font);
        background-color: var(--md-sys-color-surface);
        color: var(--md-sys-color-on-surface);
        margin: 0;
        padding: 0;
        line-height: 1.6;
        -webkit-font-smoothing: antialiased;
    }

    /* Layout */
    header {
        background: var(--md-sys-color-surface);
        color: var(--md-sys-color-on-surface);
        padding: 1rem 2rem;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid rgba(0,0,0,0.1);
        position: sticky;
        top: 0;
        z-index: 1000;
        backdrop-filter: blur(10px);
    }
    
    header .brand h1 { margin: 0; font-size: 1.5rem; color: var(--md-sys-color-primary); }

    nav { display: flex; align-items: center; gap: 1.5rem; }
    nav a { 
        text-decoration: none; 
        color: var(--md-sys-color-on-surface); 
        font-weight: 500; 
        transition: color 0.2s;
    }
    nav a:hover { color: var(--md-sys-color-primary); }

    main {
        max-width: var(--max-width);
        margin: 3rem auto;
        padding: 0 1.5rem;
        min-height: 80vh;
    }

    footer {
        background: var(--md-sys-color-secondary-container);
        color: var(--md-sys-color-on-secondary-container);
        text-align: center;
        padding: 3rem 1rem;
        margin-top: 4rem;
    }
    
    /* Typography */
    h1, h2, h3, h4 { font-family: var(--md-sys-typescale-headline-font); color: var(--md-sys-color-on-surface); line-height: 1.2; }
    h1 { font-size: 3rem; margin-bottom: 1.5rem; color: var(--md-sys-color-primary); }
    h2 { font-size: 2rem; margin-top: 2.5rem; margin-bottom: 1rem; }
    p { margin-bottom: 1.5rem; font-size: 1.125rem; }
    a { color: var(--md-sys-color-primary); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 3px; }
    a:hover { color: var(--md-sys-color-secondary); }

    /* Components */
    img { max-width: 100%; height: auto; border-radius: var(--md-sys-shape-corner); display: block; margin: 2rem 0; }
    
    blockquote {
        margin: 2rem 0;
        padding-left: 1.5rem;
        border-left: 4px solid var(--md-sys-color-primary);
        font-style: italic;
        color: var(--md-sys-color-secondary);
    }

    .btn-support {
        display: inline-block;
        background: var(--md-sys-color-primary);
        color: var(--md-sys-color-on-primary) !important;
        padding: 0.6rem 1.2rem;
        border-radius: 50px;
        text-decoration: none;
        font-weight: 600;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
        transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn-support:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 12px rgba(0,0,0,0.15);
        color: var(--md-sys-color-on-primary);
    }

    .card {
        background: white;
        border: 1px solid rgba(0,0,0,0.05);
        padding: 2rem;
        border-radius: var(--md-sys-shape-corner);
        box-shadow: 0 2px 8px rgba(0,0,0,0.05);
        margin-bottom: 1.5rem;
        transition: transform 0.2s, box-shadow 0.2s;
    }
    .card:hover {
        transform: translateY(-4px);
        box-shadow: 0 8px 16px rgba(0,0,0,0.1);
    }
    .card h2 { margin-top: 0; font-size: 1.75rem; }
    .card h2 a { text-decoration: none; color: inherit; }
    .card h2 a:hover { color: var(--md-sys-color-primary); }

    /* Meta text */
    .meta { font-size: 0.9rem; color: var(--md-sys-color-outline); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }

    /* Mobile Responsiveness */
    @media (max-width: 768px) {
        h1 { font-size: 2.5rem; }
        header { flex-direction: column; gap: 1rem; padding: 1.5rem; }
        nav { flex-wrap: wrap; justify-content: center; gap: 1rem; }
        main { padding: 0 1rem; }
        .card { padding: 1.5rem; }
    }

    /* Highlight.js Atom One Dark */
    pre code.hljs{display:block;overflow-x:auto;padding:1em}code.hljs{padding:3px 5px}.hljs{color:#abb2bf;background:#282c34}.hljs-comment,.hljs-quote{color:#5c6370;font-style:italic}.hljs-doctag,.hljs-keyword,.hljs-formula{color:#c678dd}.hljs-section,.hljs-name,.hljs-selector-tag,.hljs-deletion,.hljs-subst{color:#e06c75}.hljs-literal{color:#56b6c2}.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string{color:#98c379}.hljs-attr,.hljs-variable,.hljs-template-variable,.hljs-type,.hljs-selector-class,.hljs-selector-attr,.hljs-selector-pseudo,.hljs-number{color:#d19a66}.hljs-symbol,.hljs-bullet,.hljs-link,.hljs-meta,.hljs-selector-id,.hljs-title{color:#61aeee}.hljs-built_in,.hljs-title.class_,.hljs-class .hljs-title{color:#e6c07b}.hljs-emphasis{font-style:italic}.hljs-strong{font-weight:bold}.hljs-link{text-decoration:underline} .code-container{position:relative;} .copy-btn{position:absolute;top:5px;right:5px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:#abb2bf;padding:2px 8px;border-radius:4px;cursor:pointer;font-size:0.8rem;transition:all 0.2s;} .copy-btn:hover{background:rgba(255,255,255,0.2);color:white;} .copy-btn.copied{background:#98c379;color:black;border-color:#98c379;}
  `;
}

// --- Layout Template ---
// Simple function to wrap content in full HTML document
// --- Layout Template ---
function renderLayout(bodyContent, pageTitle, config, cssContent, seo = {}) {
    const navLinks = config.nav_links.map(l => `<a href="${l.url}">${l.label}</a>`).join(' ');
    
    // Feature Links based on Config
    let featureLinks = '';
    if (config.features.blog.mode === 'internal') featureLinks += `<a href="/blog/index.html">${config.features.blog.label}</a> `;
    else if (config.features.blog.mode === 'external') featureLinks += `<a href="${config.features.blog.external_url}" target="_blank">${config.features.blog.label} <small>↗</small></a> `;

    if (config.features.events.mode === 'internal') featureLinks += `<a href="/events/index.html">${config.features.events.label}</a> `;
    else if (config.features.events.mode === 'external') featureLinks += `<a href="${config.features.events.external_url}" target="_blank">${config.features.events.label} <small>↗</small></a> `;

    if (config.features.podcast.mode === 'internal') featureLinks += `<a href="/podcast/index.html">${config.features.podcast.label}</a> `;
    else if (config.features.podcast.mode === 'external') featureLinks += `<a href="${config.features.podcast.external_url}" target="_blank">${config.features.podcast.label} <small>↗</small></a> `;
    // Support Link
    let supportLink = config.support_link ? `<a href="${config.support_link}" class="btn-support">Support Me ❤️</a>` : '';

    // Subscribe Section Logic
    let subscribeSection = '';
    if (config.email_subscribe_form_url) {
        subscribeSection = `
        <section class="card" style="margin-top: 2rem; border: 2px solid var(--md-sys-color-primary);">
            <h3>📬 Join the Mailing List</h3>
            <p>Get updates directly to your inbox.</p>
            <div style="text-align: center;">
                <a href="${config.email_subscribe_form_url}" target="_blank" class="btn-support" style="text-decoration:none;">Subscribe Now</a>
            </div>
        </section>`;
    }

    // SEO & Metadata Construction
    const fullTitle = `${pageTitle} | ${config.site_title}`;
    const description = seo.description || config.site_description;
    const url = seo.path ? `${config.domain}${seo.path}` : config.domain;
    const image = seo.image ? (seo.image.startsWith('http') ? seo.image : `${config.domain}${seo.image}`) : '';
    const type = seo.type || 'website';
    const publishedTime = seo.date ? new Date(seo.date).toISOString() : '';

    let jsonLd = {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "url": url,
        "name": fullTitle,
        "description": description,
        "author": {
            "@type": "Person",
            "name": config.author_name
        }
    };

    if (type === 'article') {
        jsonLd = {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            "mainEntityOfPage": { "@type": "WebPage", "@id": url },
            "headline": pageTitle,
            "description": description,
            "image": image,
            "author": { "@type": "Person", "name": config.author_name },
            "datePublished": publishedTime,
            "dateModified": publishedTime
        };
    } else if (type === 'event') {
        jsonLd = {
            "@context": "https://schema.org",
            "@type": "Event",
            "name": pageTitle,
            "description": description,
            "startDate": publishedTime,
            "eventStatus": "https://schema.org/EventScheduled",
            "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
            "location": {
                "@type": "Place",
                "name": seo.location,
                "address": seo.location 
            },
            "image": [image],
             "organizer": {
                "@type": "Person",
                "name": config.author_name,
                "url": config.domain
            }
        };
    }

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${fullTitle}</title>
    <meta name="description" content="${description}">
    <link rel="canonical" href="${url}" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    
    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="${type}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:title" content="${fullTitle}" />
    <meta property="og:description" content="${description}" />
    ${image ? `<meta property="og:image" content="${image}" />` : ''}

    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image" />
    <meta property="twitter:url" content="${url}" />
    <meta property="twitter:title" content="${fullTitle}" />
    <meta property="twitter:description" content="${description}" />
    ${image ? `<meta property="twitter:image" content="${image}" />` : ''}
    ${config.twitter_handle ? `<meta property="twitter:creator" content="${config.twitter_handle}" />` : ''}

    <!-- JSON-LD Structured Data -->
    <script type="application/ld+json">
    ${JSON.stringify(jsonLd)}
    </script>

    ${config.custom_head_html || ''}

    <style>
        ${cssContent}
        /* Basic Reset & Layout */
        body { font-family: var(--md-sys-typescale-body-font); background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface); margin: 0; padding: 0; }
        header { padding: 2rem; background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container); display: flex; justify-content: space-between; align-items: center; }
        nav a { margin-left: 1rem; text-decoration: none; color: inherit; font-weight: bold; }
        main { max-width: 800px; margin: 2rem auto; padding: 1rem; }
        footer { text-align: center; padding: 2rem; border-top: 1px solid #ccc; margin-top: 2rem; }
        img { max-width: 100%; height: auto; border-radius: var(--md-sys-shape-corner); }
        h1, h2, h3 { font-family: var(--md-sys-typescale-headline-font); }
        .btn-support { background: var(--md-sys-color-primary); color: var(--md-sys-color-on-primary); padding: 0.5rem 1rem; border-radius: 20px; }
        /* Card Style */
        .card { background: var(--card-bg); padding: 1.5rem; border-radius: var(--md-sys-shape-corner); box-shadow: 0 2px 5px rgba(0,0,0,0.1); margin-bottom: 1rem; }
        
        /* Mobile Menu */
        #mobile-menu-btn { display: none; background: none; border: none; font-size: 1.5rem; cursor: pointer; color: inherit; }
        #mobile-menu-dialog { border: none; border-radius: 12px; padding: 2rem; width: 90%; max-width: 400px; backdrop-filter: blur(5px); box-shadow: 0 10px 40px rgba(0,0,0,0.2); }
        #mobile-menu-dialog::backdrop { background: rgba(0,0,0,0.4); }
        #mobile-menu-dialog nav { display: flex; flex-direction: column; gap: 1rem; text-align: center; }

        @media (max-width: 768px) {
            header nav > a, header nav > .btn-support { display: none; }
            #mobile-menu-btn { display: block; }
        }
    </style>
</head>
<body>
    <header>
        <div class="brand">
            <h1><a href="/" style="text-decoration:none; color:inherit;">${config.site_title}</a></h1>
        </div>
        <nav>
            ${navLinks}
            ${featureLinks}
            <button onclick="document.getElementById('searchDialog').showModal()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;color:inherit;" aria-label="Search">🔍</button>
            <button id="theme-toggle" onclick="toggleTheme()" style="background:none;border:none;cursor:pointer;font-size:1.2rem;color:inherit;" aria-label="Toggle Theme">🌓</button>
            <button id="mobile-menu-btn" onclick="document.getElementById('mobile-menu-dialog').showModal()" aria-label="Menu">☰</button>
            ${supportLink}
        </nav>
    </header>
    <main>
        ${bodyContent}
        ${subscribeSection}
    </main>
    <footer>
        <p>&copy; ${new Date().getFullYear()} ${config.author_name}. Powered by SoloPlatform.</p>
        <div class="socials">
            ${Object.entries(config.social_links || {}).map(([k, v]) => `<a href="${v}">${k}</a>`).join(' | ')} | <a href="/feed.xml">RSS</a>
        </div>
    </footer>
    <dialog id="mobile-menu-dialog">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
            <h2 style="margin:0; font-size:1.5rem;">Menu</h2>
            <form method="dialog"><button style="background:none; border:none; cursor:pointer; font-size:1.2rem;">✕</button></form>
        </div>
        <nav>
            ${navLinks}
            ${featureLinks}
            ${supportLink}
        </nav>
    </dialog>
    <dialog id="searchDialog" style="width: 90%; max-width: 600px; border-radius: 12px; border: none; padding: 2rem; box-shadow: 0 20px 50px rgba(0,0,0,0.3); backdrop-filter: blur(5px); background: var(--card-bg); color: var(--md-sys-color-on-surface);">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1rem;">
            <h2 style="margin:0; font-size:1.5rem;">Search</h2>
            <form method="dialog"><button style="background:none; border:none; cursor:pointer; font-size:1.2rem; color:inherit;">✕</button></form>
        </div>
        <input type="text" id="searchInput" placeholder="Type to find posts, events..." style="width:100%; padding: 1rem; font-size: 1.1rem; border: 2px solid var(--md-sys-color-outline); border-radius: 8px; margin-bottom: 1rem; outline:none; background: var(--md-sys-color-surface); color: var(--md-sys-color-on-surface);">
        <div id="searchResults" style="max-height: 400px; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem;"></div>
    </dialog>


    <script>
        // Theme Toggle Logic
        const themeBtn = document.getElementById('theme-toggle');
        const html = document.documentElement;
        
        // Load saved theme
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'dark') {
            html.setAttribute('data-theme', 'dark');
        }

        function toggleTheme() {
            const current = html.getAttribute('data-theme');
            if (current === 'dark') {
                html.removeAttribute('data-theme');
                localStorage.setItem('theme', 'light');
            } else {
                html.setAttribute('data-theme', 'dark');
                localStorage.setItem('theme', 'dark');
            }
        }
    </script>

    <script>
        const searchInput = document.getElementById('searchInput');
        let searchIndex = null;
        
        searchInput.addEventListener('input', async (e) => {
            const q = e.target.value.toLowerCase();
            const resultsDiv = document.getElementById('searchResults');
            
            if (q.length < 2) { 
                resultsDiv.innerHTML = '<p style="color:#888; text-align:center;">Type 2+ characters...</p>'; 
                return; 
            }
            
            if (!searchIndex) {
                 try {
                    searchIndex = await fetch('/search.json').then(r => r.json());
                 } catch (err) {
                    console.error('Failed to load search index');
                    return;
                 }
            }
            
            const results = searchIndex.filter(i => 
                (i.title && i.title.toLowerCase().includes(q)) || 
                (i.description && i.description.toLowerCase().includes(q))
            );
            
            if (results.length === 0) {
                resultsDiv.innerHTML = '<p style="text-align:center;">No results found.</p>';
            } else {
                resultsDiv.innerHTML = results.map(r => 
                    '<div style="padding: 1rem; background: var(--card-bg); border: 1px solid rgba(0,0,0,0.1); border-radius: 8px;">' +
                        '<div style="display:flex; justify-content:space-between; margin-bottom:0.25rem;">' +
                            '<span style="font-size:0.8rem; font-weight:bold; color:var(--md-sys-color-primary); text-transform:uppercase;">' + r.type + '</span>' +
                        '</div>' +
                        '<a href="' + r.url + '" style="font-size: 1.1rem; font-weight: bold; text-decoration: none; color: var(--md-sys-color-on-surface); display: block; margin-bottom:0.25rem;">' + r.title + '</a>' +
                        '<p style="margin:0; font-size: 0.9rem; color: var(--md-sys-color-outline);">' + r.description.substring(0, 120).replace(new RegExp(q, 'gi'), m => '<mark style="background:#ffeb3b;color:black;">'+m+'</mark>') + '...</p>' +
                    '</div>'
                ).join('');
            }
        });
    </script>
    <script>
        function copyCode(btn) {
            const pre = btn.nextElementSibling;
            const code = pre.innerText;
            navigator.clipboard.writeText(code).then(() => {
                btn.textContent = 'Copied!';
                btn.classList.add('copied');
                setTimeout(() => {
                    btn.textContent = 'Copy';
                    btn.classList.remove('copied');
                }, 2000);
            }).catch(err => {
                console.error('Failed to copy:', err);
                btn.textContent = 'Error';
            });
        }
    </script>
</body>
</html>
    `;
}

// --- Main Build Function ---
async function build() {
    console.log('🚀 Starting Build...');

    // 1. Prepare Paths
    await fs.ensureDir(DIST_DIR);
    await fs.emptyDir(DIST_DIR);
    
    // 2. Load Configs
    const config = await loadJSON(CONFIG_PATH);
    const theme = await loadJSON(THEME_PATH);
    const css = generateCSS(theme);

    // 2.5 Load Content Early
    const allPosts = await getAllPosts(config, theme);
    
    // 3. Copy Assets
    if (await fs.pathExists(PUBLIC_DIR)) {
        await fs.copy(PUBLIC_DIR, DIST_DIR);
        console.log('📂 Copied public assets.');
    }
    
    // Global Search Index
    const searchIndex = [];

    // 3.5 Build Generic Pages (e.g. about.md)
    const contentFiles = await fs.readdir(CONTENT_DIR);
    for (const file of contentFiles) {
        // Skip reserved folders/files
        if (['blog', 'events', 'podcast', 'home.md'].includes(file)) continue;
        if (!file.endsWith('.md')) continue;

        const filePath = path.join(CONTENT_DIR, file);
        const raw = await fs.readFile(filePath, 'utf-8');
        const { content, data } = matter(raw);
        const html = marked.parse(content);
        const slug = file.replace('.md', '');

        const pageHtml = renderLayout(`
            <article>
                <h1>${data.title}</h1>
                <div class="content">${html}</div>
            </article>
        `, data.title, config, css, { 
            path: `/${slug}.html`, 
            description: data.description 
        });

        await fs.outputFile(path.join(DIST_DIR, `${slug}.html`), pageHtml);
        console.log(`📄 Built Generic Page: ${slug}.html`);
        
        // Add to search index if desired? Maybe not for 'about' page or yes? 
        // Let's add it.
        searchIndex.push({ title: data.title, type: 'Page', url: `/${slug}.html`, description: data.description || '' });
    }

    // 4. Build Home Page
    const homePath = path.join(CONTENT_DIR, 'home.md');
    let homeHtml = '<h1>Welcome</h1>';
    if (await fs.pathExists(homePath)) {
        const fileContent = await fs.readFile(homePath, 'utf-8');
        const { content, data } = matter(fileContent); // data is frontmatter
        const htmlContent = marked.parse(content);
        
        // Add Hero if exists
        let heroHtml = '';
        if (data.hero_image) {
            heroHtml = `<div class="hero"><img src="${data.hero_image}" alt="Hero Image"></div>`;
        }
        
        homeHtml = `${heroHtml} ${htmlContent}`;
    }

    // Add Latest Posts
    if (allPosts.length > 0) {
        const latest = allPosts.slice(0, 2);
        homeHtml += `
            <div style="margin-top: 4rem; border-top: 1px solid var(--md-sys-color-outline); padding-top: 2rem;">
                <h2>Latest Updates</h2>
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1rem;">
                    ${latest.map(p => `
                        <div class="card">
                             ${p.coverImage ? `<img src="${p.coverImage}" alt="${p.title}" style="width:100%;height:200px;object-fit:cover;">` : ''}
                            <div style="padding:1rem;">
                                <h3><a href="/blog/${p.slug}.html" style="text-decoration:none; color:inherit;">${p.title}</a></h3>
                                <p><small>${p.dateObj.toDateString()}</small></p>
                                <p>${p.description || ''}</p>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>`;
    }
    
    const fullHomeHtml = renderLayout(homeHtml, 'Home', config, css, { path: '/' });
    await fs.outputFile(path.join(DIST_DIR, 'index.html'), fullHomeHtml);
    console.log('🏠 Built Home Page.');

    // 5. Build Blog (Internal Mode)
    // 5. Build Blog (Internal Mode)
    if (config.features.blog && config.features.blog.mode === 'internal') {
        const blogSrc = path.join(CONTENT_DIR, 'blog');
        const blogDist = path.join(DIST_DIR, 'blog');
        await fs.ensureDir(blogDist);
        
        if (await fs.pathExists(blogSrc)) {

            // Reuse pre-loaded posts
            const posts = allPosts;
            
            // Pass 2: Render Pages with Related Posts
            for (const post of posts) {
                const related = getRelatedPosts(post, posts);
                const relatedHtml = related.length > 0 ? `
                    <div style="margin-top: 4rem; border-top: 1px solid var(--md-sys-color-outline); padding-top: 2rem;">
                        <h3>Check out these related posts:</h3>
                        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem;">
                            ${related.map(p => `
                                <div class="card" style="padding: 1rem;">
                                    <h4><a href="/blog/${p.slug}.html">${p.title}</a></h4>
                                    <p class="meta"><small>${p.date}</small></p>
                                </div>
                            `).join('')}
                        </div>
                    </div>` : '';

                const seoData = {
                    type: 'article',
                    path: `/blog/${post.slug}.html`,
                    image: post.coverImage,
                    description: post.content.substring(0, 150).replace(/[#*`]/g, '') + '...',
                    date: post.date
                };

                // Giscus Script Logic
                let commentsSection = '';
                if (config.features.giscus && config.features.giscus.repo) {
                   const g = config.features.giscus;
                   commentsSection = `
                   <div style="margin-top: 4rem;">
                       <script src="https://giscus.app/client.js"
                            data-repo="${g.repo}"
                            data-repo-id="${g.repoId}"
                            data-category="${g.category}"
                            data-category-id="${g.categoryId}"
                            data-mapping="${g.mapping}"
                            data-strict="${g.strict}"
                            data-reactions-enabled="${g.reactionsEnabled}"
                            data-emit-metadata="${g.emitMetadata}"
                            data-input-position="${g.inputPosition}"
                            data-theme="${g.theme}"
                            data-lang="${g.lang}"
                            crossorigin="anonymous"
                            async>
                        </script>
                   </div>
                   `;
                }

                const postHtml = renderLayout(`
                    <article>
                        <h1>${post.title}</h1>
                        <p class="meta"><small>${post.date} | ${post.readingTime} | ${post.tags ? post.tags.join(', ') : ''}</small></p>
                        <img src="${post.coverImage}" alt="Cover Image" style="margin-bottom: 2rem; box-shadow: 0 4px 12px rgba(0,0,0,0.15);" />
                        <div class="content">${post.html}</div>
                        ${relatedHtml}
                        ${commentsSection}
                    </article>
                `, post.title, config, css, seoData);
                
                await fs.outputFile(path.join(blogDist, `${post.slug}.html`), postHtml);
                searchIndex.push({ title: post.title, type: 'Blog', url: `/blog/${post.slug}.html`, description: seoData.description });
            }
            
            // Pass 3: Build Indexes & Features
            await generatePaginatedIndex(posts, blogDist, config, css);
            await generateBlogRSS(posts, config);
            await generateTagPages(posts, config, css);
        }
    }

    // 6. Build Events (Internal Mode)
    if (config.features.events && config.features.events.mode === 'internal') {
        const eventsSrc = path.join(CONTENT_DIR, 'events');
        const eventsDist = path.join(DIST_DIR, 'events');
        await fs.ensureDir(eventsDist);
        
        if (await fs.pathExists(eventsSrc)) {
            const files = await fs.readdir(eventsSrc);
            const events = [];
            
            for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const raw = await fs.readFile(path.join(eventsSrc, file), 'utf-8');
                const { content, data } = matter(raw);
                const html = marked.parse(content);
                const slug = file.replace('.md', '');
                
                // RSVP Button Logic
                let rsvpBtn = '';
                if (data.rsvp_link) {
                    rsvpBtn = `<a href="${data.rsvp_link}" target="_blank" class="btn-support">RSVP / Register 🎟️</a>`;
                }

                const seoData = {
                    type: 'event',
                    path: `/events/${slug}.html`,
                    date: data.event_date,
                    location: data.location,
                    description: `Event: ${data.title} at ${data.location}`
                };

                // Save Individual Event Page
                const eventHtml = renderLayout(`
                    <article>
                        <h1>${data.title}</h1>
                        <p class="meta"><strong>📅 Date:</strong> ${data.event_date} | <strong>📍 Location:</strong> ${data.location}</p>
                        ${rsvpBtn}
                        <hr>
                        <div class="content">${html}</div>
                    </article>
                `, data.title, config, css, seoData);
                
                await fs.outputFile(path.join(eventsDist, `${slug}.html`), eventHtml);
                events.push({ ...data, slug, dateObj: new Date(data.event_date) });
                searchIndex.push({ title: data.title, type: 'Event', url: `/events/${slug}.html`, description: seoData.description });
            }
            
            // Build Events Index
            events.sort((a, b) => a.dateObj - b.dateObj); // Ascending for upcoming
            const listHtml = events.map(e => `
                <div class="card">
                    <h2><a href="/events/${e.slug}.html">${e.title}</a></h2>
                    <p>📅 ${e.event_date} @ ${e.location}</p>
                    ${e.rsvp_link ? `<a href="${e.rsvp_link}" target="_blank">RSVP ↗</a>` : ''}
                </div>
            `).join('');
            
            const indexHtml = renderLayout(`<h1>Upcoming Events</h1>${listHtml}`, 'Events', config, css, { path: '/events/index.html' });
            await fs.outputFile(path.join(eventsDist, 'index.html'), indexHtml);
            console.log(`📅 Built Events (${events.length} events).`);
        }
    }

    // 7. Build Podcast (Internal Mode)
    if (config.features.podcast && config.features.podcast.mode === 'internal') {
        const podSrc = path.join(CONTENT_DIR, 'podcast');
        const podDist = path.join(DIST_DIR, 'podcast');
        await fs.ensureDir(podDist);
        
        if (await fs.pathExists(podSrc)) {
            const files = await fs.readdir(podSrc);
            const episodes = [];
            
            for (const file of files) {
                if (!file.endsWith('.md')) continue;
                const raw = await fs.readFile(path.join(podSrc, file), 'utf-8');
                const { content, data } = matter(raw);
                const html = marked.parse(content);
                const slug = file.replace('.md', '');
                
                // Audio Player logic
                let audioPlayer = '';
                if (data.audio_url) {
                    audioPlayer = `<audio controls src="${data.audio_url}" style="width:100%; margin: 1rem 0;"></audio>
                                   <p><a href="${data.audio_url}" download>Download MP3</a></p>`;
                }
                
                const seoData = {
                    path: `/podcast/${slug}.html`,
                    date: data.date,
                    description: `Podcast Episode: ${data.title}`
                };

                // Save Episode Page
                const epHtml = renderLayout(`
                    <article>
                        <h1>${data.title}</h1>
                        <p class="meta">Posted: ${data.date} | Duration: ${data.duration}</p>
                        ${audioPlayer}
                        <div class="content">${html}</div>
                    </article>
                `, data.title, config, css, seoData);
                
                await fs.outputFile(path.join(podDist, `${slug}.html`), epHtml);
                episodes.push({ ...data, slug, html, dateObj: new Date(data.date) });
                searchIndex.push({ title: data.title, type: 'Podcast', url: `/podcast/${slug}.html`, description: seoData.description });
            }
            
            // Build Podcast Index
            episodes.sort((a, b) => b.dateObj - a.dateObj);
            const listHtml = episodes.map(e => `
                <div class="card">
                    <h2><a href="/podcast/${e.slug}.html">${e.title}</a></h2>
                    <p>🎧 ${e.duration}</p>
                    <small>${e.date}</small>
                </div>
            `).join('');
            
            const indexHtml = renderLayout(`<h1>Podcast Episodes</h1>${listHtml}`, 'Podcast', config, css, { path: '/podcast/index.html' });
            await fs.outputFile(path.join(podDist, 'index.html'), indexHtml);
            
            
            // Generate RSS Feed (basic)
            const rssXml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
<channel>
 <title>${config.site_title} Podcast</title>
 <description>${config.site_description}</description>
 <link>${config.domain || 'https://example.com'}</link>
 ${episodes.map(e => `
   <item>
    <title>${e.title}</title>
    <link>${config.domain || 'https://example.com'}/podcast/${e.slug}.html</link>
    <description><![CDATA[${e.html}]]></description>
    <enclosure url="${e.audio_url}" length="${e.length_bytes || 0}" type="audio/mpeg" />
    <pubDate>${e.dateObj.toUTCString()}</pubDate>
   </item>
 `).join('')}
</channel>
</rss>`;
            await fs.outputFile(path.join(DIST_DIR, 'feed.xml'), rssXml);
            console.log(`🎙️ Built Podcast (${episodes.length} episodes) & RSS Feed.`);
        }
    }

    // 8. Build Sitemap & Robots.txt
    const domain = config.domain || 'https://example.com';
    const today = new Date().toISOString();
    
    // Collect specific URLs
    const sitemapUrls = [
        { loc: `${domain}/`, priority: '1.0' },
        { loc: `${domain}/index.html`, priority: '0.8' }
    ];

    // Helper to add Feature Indexes
    if (config.features.blog?.mode === 'internal') sitemapUrls.push({ loc: `${domain}/blog/index.html`, priority: '0.9' });
    if (config.features.events?.mode === 'internal') sitemapUrls.push({ loc: `${domain}/events/index.html`, priority: '0.9' });
    if (config.features.podcast?.mode === 'internal') sitemapUrls.push({ loc: `${domain}/podcast/index.html`, priority: '0.9' });

    // Read generated files to populate sitemap (simple discovery of what we just built)
    // Actually, we can just walk the dist folder or use the lists we already have if we scoped them higher.
    // For simplicity/robustness, let's walk the dist folder for .html files.
    // Previously we had getFiles here, but it's now a helper function at top level
    // We can just call it directory.
    
    // NOTE: getFiles is async and defined in helpers scope now.



    const allFiles = await getFiles(DIST_DIR);
    const allHtml = allFiles.filter(f => f.endsWith('.html'));
    const uniqueUrls = new Set(sitemapUrls.map(u => u.loc));

    const xmlItems = sitemapUrls.map(u => `
  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <priority>${u.priority}</priority>
  </url>`).join('');

    // Add all other HTML files not explicitly added
    const dynamicItems = allHtml.map(p => {
        const relPath = path.relative(DIST_DIR, p).replace(/\\/g, '/');
        const url = `${domain}/${relPath}`;
        if (!uniqueUrls.has(url)) {
            return `
  <url>
    <loc>${url}</loc>
    <lastmod>${today}</lastmod>
    <priority>0.6</priority>
  </url>`;
        }
        return '';
    }).join('');

    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${xmlItems}
${dynamicItems}
</urlset>`;

    await fs.outputFile(path.join(DIST_DIR, 'sitemap.xml'), sitemapXml);
    console.log('🗺️ Built sitemap.xml');

    const robotsTxt = `User-agent: *
Allow: /
Sitemap: ${domain}/sitemap.xml`;
    await fs.outputFile(path.join(DIST_DIR, 'robots.txt'), robotsTxt);
     console.log('🤖 Built robots.txt');

    // 9. Client-Side Search Index
    await fs.outputFile(path.join(DIST_DIR, 'search.json'), JSON.stringify(searchIndex));
    console.log('🔍 Built search.json');

    console.log('✅ Build Complete!');
}

async function getAllPosts(config, theme) {
    const posts = [];
    if (config.features.blog && config.features.blog.mode === 'internal') {
        const blogSrc = path.join(CONTENT_DIR, 'blog');
        if (await fs.pathExists(blogSrc)) {
            const files = await getFiles(blogSrc);
            for (const filePath of files) {
                if (!filePath.endsWith('.md')) continue;
                const relPath = path.relative(blogSrc, filePath);
                const slug = relPath.replace(/\.md$/, '');
                
                const raw = await fs.readFile(filePath, 'utf-8');
                const { content, data } = matter(raw);

                // Draft Mode Check
                const isDraft = data.draft === true;
                const showDrafts = process.argv.includes('--drafts');
                if (isDraft && !showDrafts) continue;

                const html = marked.parse(content);
                
                // Dynamic Cover Image
                let coverImage = data.cover_image;
                if (!coverImage) {
                    const safeName = path.basename(slug);
                    coverImage = await generateCoverImage(data.title, safeName, theme);
                }
                
                const readingTime = calculateReadingTime(content);
                
                posts.push({ ...data, slug, dateObj: new Date(data.date), coverImage, readingTime, html, content });
            }
            // Sort Posts
            posts.sort((a, b) => b.dateObj - a.dateObj);
        }
    }
    return posts;
}

build().catch(err => console.error(err));
