const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const matter = require('gray-matter');
const hljs = require('highlight.js');

let marked;

function headingSlug(raw) {
    return String(raw)
        .replace(/<[^>]*>/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-|-$/g, '');
}

async function setupMarked() {
    const m = await import('marked');
    marked = m.marked;
    marked.use({
        renderer: {
            code(token) {
                // Handle both new (object) and old (string) marked renderer signatures
                const code = typeof token === 'string' ? token : token.text;
                const language = typeof token === 'string' ? arguments[1] : token.lang;

                const validLang = !!(language && hljs.getLanguage(language));
                const highlighted = validLang ? hljs.highlight(code, { language }).value : hljs.highlightAuto(code).value;
                const langClass = language ? `language-${language}` : '';
                const label = (language || '').split(/\s+/)[0];
                // Order matters: the copy button must stay the immediate previous sibling of <pre>.
                return `<div class="code-block"${label ? ` data-lang="${escapeHtml(label)}"` : ''}><button class="copy-btn" type="button" onclick="copyCode(this)">Copy</button><pre><code class="hljs ${langClass}">${highlighted}</code></pre></div>`;
            },
            heading(token) {
                const depth = token.depth;
                let inner;
                try {
                    inner = this.parser.parseInline(token.tokens);
                } catch (e) {
                    inner = escapeHtml(token.text);
                }
                // The page template owns the single <h1>, so body headings start at h2.
                const level = Math.min(6, Math.max(2, depth === 1 ? 2 : depth));
                const id = headingSlug(token.text);
                if (!id) return `<h${level}>${inner}</h${level}>`;
                return `<h${level} id="${id}">${inner}<a class="heading-anchor" href="#${id}" aria-label="Permalink to this section">#</a></h${level}>`;
            }
        },
        hooks: {
            // Wrap tables so wide technical tables scroll instead of blowing out the layout.
            postprocess(html) {
                return html
                    .replace(/<table>/g, '<div class="table-wrap"><table>')
                    .replace(/<\/table>/g, '</table></div>');
            }
        }
    });
}

// --- Configuration ---
const CONFIG_PATH = './config.json';
const THEME_PATH = './theme.json';
const CONTENT_DIR = './content';
const PUBLIC_DIR = './public';
const DIST_DIR = './dist';

// Dev convenience: `node build.js --limit=8` builds a small slice for fast design iteration.
const LIMIT_ARG = process.argv.find(a => a.startsWith('--limit='));
const POST_LIMIT = LIMIT_ARG ? parseInt(LIMIT_ARG.split('=')[1], 10) : null;

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

function escapeHtml(unsafe) {
    if (unsafe === undefined || unsafe === null) return "";
    return String(unsafe).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function tagSlug(tag) {
    return String(tag).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tag';
}

// Pull a readable preview out of a post body, skipping the furniture that tops
// most articles (HTML comments, cross-post notes, headings, byline lines).
function excerpt(post, n = 180) {
    if (post.description) return post.description;
    const src = String(post.content || '')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/^\s*>.*$/gm, ' ')                       // blockquotes (cross-post notices)
        .replace(/^#{1,6}\s+.*$/gm, ' ')                  // headings
        .replace(/^\s*\**_?By\s+Alex\s+Merced\b.*$/gim, ' ') // byline lines
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^\s*[-*+]\s+/gm, ' ')
        .replace(/[*_`>|#]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (src.length <= n) return src;
    return src.slice(0, n).replace(/\s+\S*$/, '') + '…';
}

// Posts repeat their title as a leading H1; the page header already renders it.
function stripDuplicateTitle(md, title) {
    const m = md.match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m);
    if (!m || !title) return md;
    const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return norm(m[1]) === norm(title) ? md.replace(m[0], '') : md;
}

// Give the opening paragraph an editorial lead-in, but only when it is real body
// copy sitting at the top level (not a cross-post notice or a byline).
function markLeadIn(html) {
    // Only top-level paragraphs are candidates; skip short ones and byline lines.
    const re = /(^|<\/(?:blockquote|h[1-6]|pre|div|ul|ol|table|figure)>)(\s*)<p>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
        const inner = m[3];
        const text = inner.replace(/<[^>]*>/g, '').trim();
        if (text.length < 140) continue;
        if (/^\**_?by\s+alex\s+merced/i.test(text)) continue;
        return html.slice(0, m.index) + m[1] + m[2] + `<p class="lead-in">${inner}</p>` + html.slice(m.index + m[0].length);
    }
    return html;
}

function formatDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function isoDate(d) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    return d.toISOString().slice(0, 10);
}

async function generateCoverImage(title, slug, theme) {
    const dir = path.join(DIST_DIR, 'assets', 'covers');
    await fs.ensureDir(dir);

    const words = String(title || 'Untitled').split(' ');
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

    const lineHeight = 1.2; // em
    const startDy = -((lines.length - 1) * lineHeight) / 2;

    const textContent = lines.map((line, index) => {
        const dy = index === 0 ? `${startDy}em` : `${lineHeight}em`;
        return `<tspan x="50%" dy="${dy}">${escapeXml(line)}</tspan>`;
    }).join('');

    const coverFont = (theme.fonts && theme.fonts.cover) || "Georgia, serif";

    const svg = `
    <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" style="stop-color:${theme.colors.secondary};stop-opacity:1" />
                <stop offset="55%" style="stop-color:${theme.colors.primary};stop-opacity:1" />
                <stop offset="100%" style="stop-color:${theme.colors.on_tertiary_container};stop-opacity:1" />
            </linearGradient>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M 40 0 L 0 0 0 40" fill="none" stroke="${theme.colors.on_primary}" stroke-width="1" opacity="0.08"/>
            </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#grad)" />
        <rect width="100%" height="100%" fill="url(#grid)" />

        <text x="50%" y="47%" dominant-baseline="middle" text-anchor="middle" font-family="${escapeXml(coverFont)}" font-weight="bold" font-size="64" fill="${theme.colors.on_primary}">
            ${textContent}
        </text>

        <rect x="45%" y="82%" width="10%" height="6" fill="${theme.colors.tertiary || theme.colors.on_primary}" rx="3" />
        <text x="50%" y="90%" text-anchor="middle" font-family="${escapeXml(coverFont)}" font-size="26" letter-spacing="4" fill="${theme.colors.on_primary}" opacity="0.72">alexmerced.blog</text>
    </svg>
    `;

    const filePath = path.join(dir, `${slug}.svg`);
    await fs.writeFile(filePath, svg);

    // Convert to PNG for OG card compatibility (many crawlers ignore SVG og:image)
    try {
        const { execSync } = require('child_process');
        execSync(`convert -background none "${filePath}" "${path.join(dir, `${slug}.png`)}"`, { stdio: 'ignore' });
        await fs.remove(filePath);
        return `/assets/covers/${slug}.png`;
    } catch (e) {
        return `/assets/covers/${slug}.svg`;
    }
}

// Build lighter derivatives of the home banner so the hero does not ship the
// full-size original. Dimensions are read from the file, so swapping in art of a
// different shape needs no code change: drop the file in /public/assets and point
// `hero_image` in content/home.md at it.
const HERO_MAX_WIDTH = 1400;

async function generateHeroArt(heroImagePath) {
    if (!heroImagePath) return null;
    const rel = heroImagePath.replace(/^\//, '');
    const src = path.join(PUBLIC_DIR, rel);
    if (!await fs.pathExists(src)) {
        console.warn(`⚠️  hero_image not found: ${heroImagePath} (looked in ${PUBLIC_DIR})`);
        return null;
    }

    const { execSync } = require('child_process');

    // Intrinsic size drives the width/height attributes and the CSS aspect-ratio.
    let natural = null;
    try {
        const out = execSync(`identify -format "%w %h" "${src}[0]"`, { encoding: 'utf-8' }).trim().split(/\s+/);
        const w = parseInt(out[0], 10), h = parseInt(out[1], 10);
        if (w > 0 && h > 0) natural = { w, h };
    } catch (e) { /* identify unavailable; fall through */ }

    const outDir = path.join(DIST_DIR, 'assets');
    await fs.ensureDir(outDir);

    try {
        const webp = path.join(outDir, 'hero-banner.webp');
        const jpg = path.join(outDir, 'hero-banner.jpg');
        // The trailing '>' shrinks only, so smaller source art is never upscaled.
        execSync(`convert "${src}[0]" -resize '${HERO_MAX_WIDTH}x>' -strip -quality 80 "${webp}"`, { stdio: 'ignore' });
        execSync(`convert "${src}[0]" -resize '${HERO_MAX_WIDTH}x>' -strip -quality 82 "${jpg}"`, { stdio: 'ignore' });

        const width = natural ? Math.min(HERO_MAX_WIDTH, natural.w) : HERO_MAX_WIDTH;
        const height = natural ? Math.round(width * (natural.h / natural.w)) : null;
        return { webp: '/assets/hero-banner.webp', fallback: '/assets/hero-banner.jpg', width, height, natural };
    } catch (e) {
        // No ImageMagick: serve the original untouched.
        return {
            webp: null,
            fallback: heroImagePath,
            width: natural ? natural.w : null,
            height: natural ? natural.h : null,
            natural
        };
    }
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

// --- Shared UI partials ---

function renderTagChips(tags, limit) {
    if (!tags || !Array.isArray(tags) || tags.length === 0) return '';
    const list = limit ? tags.slice(0, limit) : tags;
    return `<ul class="chips">${list.map(t => `<li><a class="chip" href="/tags/${encodeURIComponent(tagSlug(t))}.html">${escapeHtml(t)}</a></li>`).join('')}</ul>`;
}

// Renders an `elsewhere:` frontmatter list as a grid of outbound link cards.
// Each entry: { url, label?, note? } — label defaults to the bare hostname.
function renderLinkGrid(entries, heading) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const cards = entries.map(e => {
        const url = typeof e === 'string' ? e : e.url;
        if (!url) return '';
        let label = (typeof e === 'object' && e.label) || '';
        if (!label) {
            try { label = new URL(url).hostname.replace(/^www\./, ''); } catch (err) { label = url; }
        }
        const note = (typeof e === 'object' && e.note) ? e.note : '';
        return `<li>
            <a class="link-card" href="${escapeHtml(url)}" target="_blank" rel="noopener">
                <span class="link-card__title">${escapeHtml(label)}<span class="link-card__arrow" aria-hidden="true">↗</span></span>
                ${note ? `<span class="link-card__note">${escapeHtml(note)}</span>` : ''}
            </a>
        </li>`;
    }).filter(Boolean).join('');

    const id = 'elsewhere-title';
    return `<section class="article-foot" aria-labelledby="${id}">
        <h2 id="${id}">${escapeHtml(heading || 'Find me elsewhere')}</h2>
        <ul class="link-grid">${cards}</ul>
    </section>`;
}

function renderPostCard(p, opts = {}) {
    const { featured = false, showExcerpt = true, level = 'h3' } = opts;
    const heading = featured ? 'h2' : level;
    return `<article class="card${featured ? ' card--featured' : ''} reveal">
        <a class="card__media" href="/blog/${p.slug}.html" tabindex="-1" aria-hidden="true">
            <img src="${p.coverImage}" alt="" width="1200" height="630" ${featured ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"'} decoding="async">
        </a>
        <div class="card__body">
            ${featured ? '<p class="card__kicker">Latest post</p>' : ''}
            <${heading} class="card__title"><a href="/blog/${p.slug}.html">${escapeHtml(p.title)}</a></${heading}>
            ${showExcerpt ? `<p class="card__excerpt">${escapeHtml(excerpt(p, featured ? 220 : 140))}</p>` : ''}
            <p class="card__meta"><time datetime="${isoDate(p.dateObj)}">${formatDate(p.dateObj)}</time><span class="dot"></span>${escapeHtml(p.readingTime || '')}</p>
            ${renderTagChips(p.tags, 3)}
        </div>
    </article>`;
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

async function generateTagPages(posts, config, assets) {
    const tagsMap = {};
    posts.forEach(p => {
        if (p.tags && Array.isArray(p.tags)) {
            p.tags.forEach(t => {
                const slug = tagSlug(t);
                if (!tagsMap[slug]) tagsMap[slug] = { label: String(t).trim(), posts: [] };
                if (!tagsMap[slug].posts.includes(p)) tagsMap[slug].posts.push(p);
            });
        }
    });

    const tagsDir = path.join(DIST_DIR, 'tags');
    await fs.ensureDir(tagsDir);

    for (const [slug, entry] of Object.entries(tagsMap)) {
        const tagPosts = entry.posts.slice().sort((a, b) => b.dateObj - a.dateObj);
        const listHtml = tagPosts.map(p => `
            <li class="stack-item reveal">
                <p class="stack-item__meta"><time datetime="${isoDate(p.dateObj)}">${formatDate(p.dateObj)}</time><span class="dot"></span>${escapeHtml(p.readingTime || '')}</p>
                <h2 class="stack-item__title"><a href="/blog/${p.slug}.html">${escapeHtml(p.title)}</a></h2>
                <p class="stack-item__excerpt">${escapeHtml(excerpt(p, 150))}</p>
            </li>
        `).join('');

        const body = `
            ${renderPageHead({
                eyebrow: 'Topic',
                title: escapeHtml(entry.label),
                lede: `${tagPosts.length} ${tagPosts.length === 1 ? 'post' : 'posts'} tagged “${escapeHtml(entry.label)}”.`
            })}
            <div class="shell page">
                <ol class="stack">${listHtml}</ol>
                <p class="page__back"><a class="link-back" href="/blog/index.html">Browse all posts</a></p>
            </div>`;

        const pageHtml = renderLayout(body, entry.label, config, assets, { path: `/tags/${slug}.html`, noindex: true, description: `Posts tagged ${entry.label}.` });
        await fs.outputFile(path.join(tagsDir, `${slug}.html`), pageHtml);
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

async function generatePaginatedIndex(posts, distDir, config, assets) {
    const perPage = config.posts_per_page || 10;
    const totalPages = Math.max(1, Math.ceil(posts.length / perPage));

    for (let i = 1; i <= totalPages; i++) {
        const start = (i - 1) * perPage;
        const chunk = posts.slice(start, start + perPage);

        // Page 1 leads with a featured post, then a grid. Later pages are a uniform grid.
        const featured = i === 1 ? chunk[0] : null;
        const rest = i === 1 ? chunk.slice(1) : chunk;

        const featuredHtml = featured ? `<div class="featured">${renderPostCard(featured, { featured: true })}</div>` : '';
        const gridHtml = rest.length ? `<div class="grid grid--cards">${rest.map(p => renderPostCard(p)).join('')}</div>` : '';

        const prevHref = i === 2 ? '/blog/index.html' : `/blog/page/${i - 1}.html`;
        const prevLink = i > 1 ? `<a class="pager__link" rel="prev" href="${prevHref}"><span aria-hidden="true">←</span> Newer posts</a>` : '<span></span>';
        const nextLink = i < totalPages ? `<a class="pager__link" rel="next" href="/blog/page/${i + 1}.html">Older posts <span aria-hidden="true">→</span></a>` : '<span></span>';

        const paginationHtml = `
            <nav class="pager" aria-label="Pagination">
                ${prevLink}
                <p class="pager__status">Page ${i} of ${totalPages}</p>
                ${nextLink}
            </nav>`;

        const pageTitle = i === 1 ? 'Blog' : `Blog, page ${i}`;
        const filePath = i === 1 ? path.join(distDir, 'index.html') : path.join(distDir, 'page', `${i}.html`);
        const seoUrl = i === 1 ? '/blog/index.html' : `/blog/page/${i}.html`;
        const prevUrl = i > 1 ? (i === 2 ? `${config.domain}/blog/index.html` : `${config.domain}/blog/page/${i - 1}.html`) : null;
        const nextUrl = i < totalPages ? `${config.domain}/blog/page/${i + 1}.html` : null;

        if (i > 1) await fs.ensureDir(path.join(distDir, 'page'));

        const body = `
            ${renderPageHead({
                eyebrow: 'The archive',
                title: i === 1 ? 'Writing' : `Writing, page ${i}`,
                lede: `${posts.length} posts on Apache Iceberg, lakehouse architecture, data engineering and applied AI.`
            })}
            <div class="shell page">
                ${featuredHtml}
                ${gridHtml}
                ${paginationHtml}
            </div>`;

        const fullHtml = renderLayout(body, pageTitle, config, assets, { path: seoUrl, description: `Articles on data lakehouses, Apache Iceberg and AI. Page ${i} of ${totalPages}.`, prevUrl, nextUrl });
        await fs.outputFile(filePath, fullHtml);
    }
    console.log(`📝 Built Blog Index (${posts.length} posts, ${totalPages} pages).`);
}

async function generateLLMsTxt(posts, config) {
    if (posts.length === 0) return;
    const header = `# ${config.site_title}\n> ${config.site_description}\n> Support: ${config.support_link || config.domain}\n\n## Content Directory\n`;
    const body = posts.map(p => `- [${p.title}](${config.domain}/blog/${p.slug}.html): ${p.description || "An article."}`).join('\n');
    const extras = `

## Events
- [Agentic Lakehouse Events](https://luma.com/agenticlakehouse): global meetups and webinars on agentic analytics
- [Data Lakehouse Hub Events](https://luma.com/DataLakehouseHub): global lakehouse meetups, linkups and webinars

## Community
- [Data Lakehouse Hub Slack](https://join.slack.com/t/thedatalakehousehub/shared_invite/zt-274yc8sza-mI2zhCW8LGkOh1uxuf8T5Q): practitioner community for lakehouse architecture
- [Data Events Slack](https://join.slack.com/t/data-events/shared_invite/zt-38vgrooy9-U9ral_gr3NAz_Siih1QwmQ): announcements for data conferences and meetups
- [Data & Tech Slack](https://join.slack.com/t/datatechcommunity/shared_invite/zt-12xrk4qmd-y~6jUFFd7kdaLhgLURKwoA): broader data and technology community
- [r/datalakehouseandai](https://www.reddit.com/r/datalakehouseandai/): subreddit for data lakehouse and AI discussion
- [Data Lakehouse Hub on LinkedIn](https://www.linkedin.com/company/data-lakehouse-hub/): company page for the Data Lakehouse Hub
- [Alex Merced Tech on YouTube](https://www.youtube.com/@AlexMercedCoder): software development and engineering channel
- [Alex Merced Data & AI on YouTube](https://www.youtube.com/@alexmerceddata): data lakehouse and AI channel
`;
    const content = header + body + extras;
    await fs.outputFile(path.join(DIST_DIR, 'llms.txt'), content);
    console.log('🤖 Built llms.txt');
}

// --- Design System (single stylesheet, emitted to /styles.css) ---

function themeVars(t) {
    return `
      --bg: ${t.bg};
      --bg-tint: ${t.bg_tint};
      --surface: ${t.surface};
      --surface-2: ${t.surface_2};
      --ink: ${t.ink};
      --ink-soft: ${t.ink_soft};
      --ink-muted: ${t.ink_muted};
      --brand: ${t.brand};
      --brand-hover: ${t.brand_hover};
      --brand-soft: ${t.brand_soft};
      --accent: ${t.accent};
      --accent-text: ${t.accent_text};
      --accent-soft: ${t.accent_soft};
      --rule: ${t.rule};
      --rule-strong: ${t.rule_strong};
      --shadow-1: ${t.shadow_1};
      --shadow-2: ${t.shadow_2};
      --selection: ${t.selection};`;
}

function generateCSS(theme) {
    const f = theme.fonts || {};
    const s = theme.scale || {};
    const mo = theme.motion || {};
    const c = theme.code || {};
    const light = theme.light || {};
    const dark = theme.dark || {};

    // A tiny inline SVG grain used to keep large gradient areas from looking flat.
    const grain = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E")`;

    return `@charset "UTF-8";
/* ==========================================================================
   alexmerced.blog design system
   Layers: tokens → reset → typography → layout → components → utilities
   ========================================================================== */

/* --- Tokens: type, space, radii, motion ---------------------------------- */
:root {
  color-scheme: light;

  --font-display: ${f.display};
  --font-body: ${f.body};
  --font-ui: ${f.ui};
  --font-mono: ${f.monospace};

  /* Fluid type scale (1.0625rem → 1.1875rem base, ~1.24 ratio) */
  --step--2: clamp(0.75rem, 0.73rem + 0.10vw, 0.8125rem);
  --step--1: clamp(0.875rem, 0.85rem + 0.12vw, 0.9375rem);
  --step-0:  clamp(1.0625rem, 1.02rem + 0.22vw, 1.1875rem);
  --step-1:  clamp(1.25rem, 1.18rem + 0.34vw, 1.4375rem);
  --step-2:  clamp(1.5rem, 1.37rem + 0.62vw, 1.875rem);
  --step-3:  clamp(1.8125rem, 1.58rem + 1.10vw, 2.5rem);
  --step-4:  clamp(2.125rem, 1.72rem + 1.95vw, 3.25rem);
  --step-5:  clamp(2.5rem, 1.85rem + 3.10vw, 4.25rem);

  /* Spacing (0.5rem base, geometric) */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-7: 3rem;
  --space-8: 4rem;
  --space-9: 6rem;
  --gutter: clamp(1rem, 4vw, 2.5rem);

  --radius-sm: ${s.radius_sm || '6px'};
  --radius: ${s.radius || '12px'};
  --radius-lg: ${s.radius_lg || '20px'};
  --radius-pill: ${s.radius_pill || '999px'};

  --measure: ${s.measure || '68ch'};
  --measure-wide: ${s.measure_wide || '78ch'};
  --w-shell: ${s.shell || '72rem'};
  --w-article: ${s.article || '48rem'};

  --dur-fast: ${mo.fast || '140ms'};
  --dur: ${mo.base || '240ms'};
  --dur-slow: ${mo.slow || '620ms'};
  --ease: ${mo.ease || 'cubic-bezier(0.22,0.61,0.36,1)'};
  --ease-out: ${mo.ease_out || 'cubic-bezier(0.16,1,0.3,1)'};

  --grain: ${grain};

  /* Brand badge keeps the same saturated gradient in both themes. */
  --mark-from: ${(theme.colors && theme.colors.primary) || '#0B5563'};
  --mark-to: ${(theme.colors && theme.colors.on_tertiary_container) || '#7A2707'};

  /* Code surface is intentionally dark in both themes for stable contrast. */
  --code-bg: ${c.bg};
  --code-bg-header: ${c.bg_header};
  --code-rule: ${c.rule};
  --code-text: ${c.text};
  --code-comment: ${c.comment};
  --code-keyword: ${c.keyword};
  --code-string: ${c.string};
  --code-number: ${c.number};
  --code-title: ${c.title};
  --code-type: ${c.type};
  --code-variable: ${c.variable};
  --code-punct: ${c.punctuation};

  /* --- Colour: light (default) --- */
${themeVars(light)}
}

/* Follow the OS unless the reader has made an explicit choice. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
${themeVars(dark)}
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
${themeVars(dark)}
}
:root[data-theme="light"] { color-scheme: light; }

/* --- Reset --------------------------------------------------------------- */
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; }
html {
  -webkit-text-size-adjust: 100%;
  scroll-behavior: smooth;
  scroll-padding-top: 6rem;
}
body {
  font-family: var(--font-body);
  font-size: var(--step-0);
  line-height: 1.72;
  font-optical-sizing: auto;
  color: var(--ink);
  background-color: var(--bg);
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}
.visually-hidden {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
img, picture, svg, video, canvas { display: block; max-width: 100%; height: auto; }
button, input, select, textarea { font: inherit; color: inherit; }
::selection { background: var(--selection); }
:where(a) { color: var(--brand); }
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
  border-radius: var(--radius-sm);
}
:where(button, a):focus-visible { outline-color: var(--accent); }

/* --- Typography ---------------------------------------------------------- */
h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-display);
  font-weight: 700;
  line-height: 1.14;
  letter-spacing: -0.015em;
  text-wrap: balance;
}
h1 { font-size: var(--step-4); letter-spacing: -0.028em; line-height: 1.06; }
h2 { font-size: var(--step-3); }
h3 { font-size: var(--step-2); }
h4 { font-size: var(--step-1); }
strong, b { font-weight: 600; }

.eyebrow {
  font-family: var(--font-ui);
  font-size: var(--step--2);
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent-text);
}
.lede {
  font-size: var(--step-1);
  line-height: 1.55;
  color: var(--ink-soft);
  text-wrap: pretty;
}
.dot {
  display: inline-block;
  width: 4px; height: 4px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.5;
  margin: 0 0.6em;
  vertical-align: 0.22em;
}

/* --- Layout -------------------------------------------------------------- */
.shell {
  width: 100%;
  max-width: var(--w-shell);
  margin-inline: auto;
  padding-inline: var(--gutter);
}
main { display: block; flex: 1 0 auto; }
.page { padding-block: clamp(2.5rem, 6vw, 4.5rem); }
.page--tight { padding-block: clamp(2rem, 4vw, 3rem); }
.page__back { margin-top: var(--space-7); }

.skip-link {
  position: absolute;
  left: var(--space-4); top: var(--space-2);
  z-index: 200;
  transform: translateY(-160%);
  background: var(--brand);
  color: var(--bg);
  font-family: var(--font-ui);
  font-size: var(--step--1);
  font-weight: 600;
  padding: 0.65rem 1rem;
  border-radius: var(--radius-sm);
  text-decoration: none;
  transition: transform var(--dur) var(--ease);
}
.skip-link:focus { transform: translateY(0); }

/* --- Reading progress ---------------------------------------------------- */
.progress {
  position: fixed;
  inset: 0 0 auto 0;
  height: 3px;
  z-index: 120;
  background: transparent;
  pointer-events: none;
}
.progress__bar {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, var(--brand), var(--accent));
  transition: width 90ms linear;
}

/* --- Masthead ------------------------------------------------------------ */
.masthead {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--bg);
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: saturate(140%) blur(14px);
  -webkit-backdrop-filter: saturate(140%) blur(14px);
  border-bottom: 1px solid transparent;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.masthead.is-stuck {
  border-bottom-color: var(--rule);
  box-shadow: 0 6px 24px -18px rgba(0,0,0,0.5);
}
.masthead__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  min-height: 4.25rem;
  padding-block: 0.75rem;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: 0.7rem;
  text-decoration: none;
  color: var(--ink);
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.0625rem;
  letter-spacing: -0.01em;
  line-height: 1.15;
  border-radius: var(--radius-sm);
}
.brand__mark {
  display: grid;
  place-items: center;
  width: 2.1rem; height: 2.1rem;
  flex: 0 0 auto;
  border-radius: 9px;
  background: linear-gradient(140deg, var(--mark-from), var(--mark-to));
  color: #FFFFFF;
  font-size: 0.9rem;
  letter-spacing: 0;
  box-shadow: var(--shadow-1);
}
.brand__text { max-width: 22ch; }
.brand__short { display: none; }
.brand:hover .brand__text, .brand:hover .brand__short { color: var(--brand); }
/* The full site title is too tall for a sticky mobile bar; use the wordmark. */
@media (max-width: 40rem) {
  .brand__text { display: none; }
  .brand__short { display: inline; }
}

.nav {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-family: var(--font-ui);
}
.nav__link {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-height: 2.75rem;
  padding: 0 0.7rem;
  border-radius: var(--radius-sm);
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--ink-soft);
  text-decoration: none;
  transition: color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
}
.nav__link:hover { color: var(--brand); background: var(--brand-soft); }
.nav__link sup { font-size: 0.7em; opacity: 0.65; }
.icon-btn {
  display: grid;
  place-items: center;
  width: 2.75rem; height: 2.75rem;
  flex: 0 0 auto;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--ink-soft);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.icon-btn:hover { color: var(--brand); background: var(--brand-soft); border-color: var(--rule); }
.icon-btn svg { width: 1.15rem; height: 1.15rem; stroke: currentColor; fill: none; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.nav__cta { margin-left: 0.35rem; }
#menu-btn { display: none; }

/* --- Buttons ------------------------------------------------------------- */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-height: 2.875rem;
  padding: 0.6rem 1.25rem;
  font-family: var(--font-ui);
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.2;
  text-decoration: none;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease), box-shadow var(--dur) var(--ease), background-color var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.btn--primary { background: var(--brand); color: var(--bg); box-shadow: var(--shadow-1); }
.btn--primary:hover { background: var(--brand-hover); color: var(--bg); transform: translateY(-1px); box-shadow: var(--shadow-2); }
.btn--ghost { background: transparent; color: var(--ink); border-color: var(--rule-strong); }
.btn--ghost:hover { color: var(--brand); border-color: var(--brand); background: var(--brand-soft); }
.btn-support { /* legacy hook kept for safety */ }

/* Ink strokes down the hero margins. Desktop only, where the shell leaves
   clear gutters; hidden for prefers-reduced-motion users mid-stroke. */
.hero-ink { display: none; }
@media (min-width: 78rem) {
  .hero-ink {
    display: block;
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: -1;
    pointer-events: none;
  }
}
.ink-stroke {
  fill: none;
  stroke: var(--brand);
  stroke-width: 1.5;
  stroke-linecap: round;
  opacity: 0.3;
  stroke-dasharray: 100;
  animation: inkDraw 18s ease-in-out infinite;
}
.ink-stroke--accent {
  stroke: var(--accent);
  opacity: 0.28;
}
.ink-dots circle {
  fill: var(--accent);
  opacity: 0.35;
  animation: inkBleed 6s ease-in-out infinite;
}
.ink-rules line {
  stroke: var(--rule-strong);
  stroke-width: 1;
  opacity: 0.5;
}
@keyframes inkDraw {
  0%       { stroke-dashoffset: 100; }
  30%, 72% { stroke-dashoffset: 0; }
  100%     { stroke-dashoffset: -100; }
}
@keyframes inkBleed {
  0%, 100% { opacity: 0.2; }
  50%      { opacity: 0.7; }
}
@media (prefers-reduced-motion: reduce) {
  .ink-stroke, .ink-dots circle { animation: none; }
  .ink-stroke { stroke-dashoffset: 0; }
}

/* --- Hero (home) --------------------------------------------------------- */
.hero {
  position: relative;
  isolation: isolate;
  overflow: hidden;
  padding-block: clamp(3rem, 8vw, 6rem) clamp(2.5rem, 6vw, 4.5rem);
  background:
    radial-gradient(120% 90% at 8% 0%, var(--brand-soft), transparent 60%),
    radial-gradient(90% 80% at 95% 10%, var(--accent-soft), transparent 62%),
    linear-gradient(180deg, var(--bg-tint), var(--bg));
  border-bottom: 1px solid var(--rule);
}
.hero::before {
  content: "";
  position: absolute; inset: 0;
  z-index: -2;
  background-image: var(--grain);
  background-size: 140px 140px;
  opacity: 0.035;
  mix-blend-mode: multiply;
}
:root[data-theme="dark"] .hero::before { mix-blend-mode: screen; opacity: 0.05; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .hero::before { mix-blend-mode: screen; opacity: 0.05; }
}
.hero::after {
  content: "";
  position: absolute;
  inset: auto 0 0 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--brand), var(--accent), transparent);
  opacity: 0.55;
}
.hero__inner {
  display: grid;
  gap: clamp(2rem, 5vw, 3.5rem);
  align-items: center;
}
@media (min-width: 62rem) {
  .hero__inner { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
}
/* Art and stats share the aside so a wide, short banner does not leave the
   column half empty next to a tall headline. */
.hero__aside { display: grid; gap: var(--space-6); align-content: center; }
.hero__aside .hero__stats { margin-top: 0; }
.hero__title {
  font-size: var(--step-5);
  margin-top: var(--space-4);
  font-weight: 800;
}
.hero__title em {
  font-style: italic;
  color: var(--brand);
}
.hero__lede {
  margin-top: var(--space-5);
  max-width: 46ch;
  font-size: var(--step-1);
  line-height: 1.55;
  color: var(--ink-soft);
  text-wrap: pretty;
}
.hero__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-6);
}
.hero__art {
  position: relative;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1px solid var(--rule);
  box-shadow: var(--shadow-2);
  transform: rotate(-0.6deg);
}
/* --hero-ratio is set inline from the source image's intrinsic size, so art of
   any shape is shown uncropped. */
.hero__art img { width: 100%; aspect-ratio: var(--hero-ratio, 3 / 2); object-fit: cover; }
.hero__stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-5) var(--space-7);
  margin-top: var(--space-7);
  padding-top: var(--space-5);
  border-top: 1px solid var(--rule);
  font-family: var(--font-ui);
}
.hero__stat b {
  display: block;
  font-family: var(--font-display);
  font-size: var(--step-2);
  font-weight: 700;
  color: var(--ink);
  letter-spacing: -0.02em;
}
.hero__stat span { font-size: var(--step--1); color: var(--ink-muted); }

/* --- Page head band (blog index, tags, generic pages) -------------------- */
.page-head {
  position: relative;
  overflow: hidden;
  padding-block: clamp(2.75rem, 6vw, 4.5rem);
  background:
    radial-gradient(110% 140% at 0% 0%, var(--brand-soft), transparent 55%),
    linear-gradient(180deg, var(--bg-tint), var(--bg));
  border-bottom: 1px solid var(--rule);
}
.page-head__inner { max-width: 46rem; }
.page-head h1 { margin-top: var(--space-3); }
.page-head .lede { margin-top: var(--space-4); max-width: 46ch; }

/* --- Post header --------------------------------------------------------- */
.post-head {
  position: relative;
  overflow: hidden;
  padding-block: clamp(2.5rem, 6vw, 4.5rem) clamp(2rem, 4vw, 3rem);
  background:
    radial-gradient(100% 120% at 100% 0%, var(--accent-soft), transparent 58%),
    radial-gradient(90% 110% at 0% 10%, var(--brand-soft), transparent 55%),
    linear-gradient(180deg, var(--bg-tint), var(--bg));
  border-bottom: 1px solid var(--rule);
}
/* Shares the prose measure so the header and body copy sit on the same axis,
   while the title itself is allowed to run a little wider. */
.post-head__inner {
  max-width: var(--measure);
  margin-inline: auto;
}
.post-head h1 {
  margin-top: var(--space-4);
  max-width: calc(var(--measure) + 7rem);
}
.byline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.5rem;
  margin-top: var(--space-5);
  font-family: var(--font-ui);
  font-size: var(--step--1);
  color: var(--ink-muted);
}
.byline a { color: var(--ink-soft); text-decoration-color: var(--rule-strong); }
.byline a:hover { color: var(--brand); }
.byline__author { font-weight: 600; color: var(--ink-soft); }

/* --- Chips / tags -------------------------------------------------------- */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  list-style: none;
  padding: 0;
  margin: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  min-height: 1.9rem;
  padding: 0.2rem 0.7rem;
  font-family: var(--font-ui);
  font-size: var(--step--2);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  text-decoration: none;
  color: var(--ink-muted);
  background: var(--surface-2);
  border: 1px solid var(--rule);
  border-radius: var(--radius-pill);
  transition: color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.chip:hover { color: var(--brand); border-color: var(--brand); background: var(--brand-soft); }
.chips--head { margin-top: var(--space-2); }

/* --- Long-form prose ----------------------------------------------------- */
.prose {
  max-width: var(--measure);
  margin-inline: auto;
  overflow-wrap: break-word;
  hyphens: none;
}
/* Left-aligned variant, used where prose sits under a left-aligned hero. */
.prose--flush { margin-inline: 0; }
.prose > * + * { margin-top: 1.35em; }
.prose p { text-wrap: pretty; }
.prose h2 {
  margin-top: 2.6em;
  padding-top: 0.2em;
  font-size: var(--step-2);
}
.prose h3 { margin-top: 2.1em; font-size: var(--step-1); }
.prose h4 { margin-top: 1.9em; font-size: var(--step-0); font-family: var(--font-ui); font-weight: 700; letter-spacing: 0.01em; }
.prose h2 + *, .prose h3 + *, .prose h4 + * { margin-top: 0.85em; }
.prose h2::after {
  content: "";
  display: block;
  width: 2.5rem;
  height: 2px;
  margin-top: 0.5em;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--accent), transparent);
}

/* Lead-in treatment, applied at build time only to a genuine opening paragraph. */
.prose .lead-in {
  font-size: 1.16em;
  line-height: 1.62;
  color: var(--ink-soft);
}
.prose .lead-in::first-letter {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.32em;
  color: var(--brand);
}

.prose a {
  color: var(--brand);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.22em;
  text-decoration-color: color-mix(in srgb, var(--brand) 45%, transparent);
  transition: color var(--dur-fast) var(--ease), text-decoration-color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
}
.prose a:hover {
  color: var(--brand-hover);
  text-decoration-color: currentColor;
  background: var(--brand-soft);
}

.prose ul, .prose ol { padding-left: 1.35em; }
.prose li + li { margin-top: 0.5em; }
.prose li::marker { color: var(--accent-text); font-weight: 600; }
.prose ul { list-style: none; padding-left: 1.5em; }
.prose ul > li { position: relative; }
.prose ul > li::before {
  content: "";
  position: absolute;
  left: -1.1em;
  top: 0.72em;
  width: 0.42em; height: 0.42em;
  border-radius: 50%;
  background: var(--accent);
  opacity: 0.75;
}
.prose ul ul, .prose ol ol, .prose ul ol, .prose ol ul { margin-top: 0.5em; }

.prose blockquote {
  margin-inline: 0;
  padding: 0.2em 0 0.2em 1.5em;
  border-left: 3px solid var(--accent);
  font-size: 1.06em;
  font-style: italic;
  color: var(--ink-soft);
}
.prose blockquote p + p { margin-top: 0.8em; }
.prose blockquote cite, .prose figcaption {
  display: block;
  font-family: var(--font-ui);
  font-style: normal;
  font-size: var(--step--1);
  color: var(--ink-muted);
}
.prose figure { margin-inline: 0; }
.prose figcaption { margin-top: 0.75em; text-align: center; }
.prose img {
  border-radius: var(--radius);
  border: 1px solid var(--rule);
  margin-inline: auto;
}
.prose hr {
  border: 0;
  height: auto;
  margin-block: 2.6em;
  text-align: center;
  color: var(--ink-muted);
}
.prose hr::before {
  content: "* * *";
  letter-spacing: 0.8em;
  font-size: 0.9em;
}
.heading-anchor {
  margin-left: 0.4em;
  font-family: var(--font-ui);
  font-size: 0.7em;
  font-weight: 500;
  color: var(--ink-muted);
  text-decoration: none;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.prose :is(h2, h3, h4):hover .heading-anchor,
.heading-anchor:focus-visible { opacity: 1; }
.heading-anchor:hover { color: var(--accent-text); }

/* Tables scroll rather than break the measure. */
.table-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  background: var(--surface);
}
.prose table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-ui);
  font-size: var(--step--1);
}
.prose th, .prose td {
  padding: 0.7rem 0.9rem;
  text-align: left;
  border-bottom: 1px solid var(--rule);
  vertical-align: top;
}
.prose thead th {
  background: var(--surface-2);
  font-weight: 700;
  white-space: nowrap;
}
.prose tbody tr:last-child td { border-bottom: 0; }

/* --- Code --------------------------------------------------------------- */
:not(pre) > code {
  font-family: var(--font-mono);
  font-size: 0.86em;
  padding: 0.15em 0.4em;
  border-radius: var(--radius-sm);
  background: var(--brand-soft);
  border: 1px solid var(--rule);
  color: var(--ink);
  word-break: break-word;
}
.prose a code { color: inherit; }

.code-block {
  position: relative;
  min-width: 0;
  border-radius: var(--radius);
  border: 1px solid var(--code-rule);
  background: var(--code-bg);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
.prose > .code-block { margin-top: 1.8em; margin-bottom: 1.8em; }
@media (min-width: 64rem) {
  /* Let code breathe past the reading measure without touching the page edge. */
  .prose--article > .code-block {
    width: calc(100% + 5rem);
    margin-inline: -2.5rem;
  }
}
.code-block::before {
  content: attr(data-lang);
  position: absolute;
  top: 0; left: 0;
  padding: 0.3rem 0.75rem;
  font-family: var(--font-ui);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--code-comment);
  background: var(--code-bg-header);
  border-right: 1px solid var(--code-rule);
  border-bottom: 1px solid var(--code-rule);
  border-bottom-right-radius: var(--radius-sm);
}
.code-block:not([data-lang])::before { content: none; }
.code-block pre {
  margin: 0;
  padding: 2.4rem 1.15rem 1.15rem;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  scrollbar-color: var(--code-comment) transparent;
  scrollbar-width: thin;
}
.code-block:not([data-lang]) pre { padding-top: 2.6rem; }
.code-block pre::-webkit-scrollbar { height: 10px; }
.code-block pre::-webkit-scrollbar-track { background: transparent; }
.code-block pre::-webkit-scrollbar-thumb {
  background: color-mix(in srgb, var(--code-comment) 55%, transparent);
  border-radius: var(--radius-pill);
}
.code-block code {
  display: block;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
  line-height: 1.66;
  font-variant-ligatures: none;
  tab-size: 2;
  color: var(--code-text);
  background: none;
  padding: 0;
  border: 0;
}
@media (min-width: 40rem) { .code-block code { font-size: 0.875rem; } }
.copy-btn {
  position: absolute;
  top: 0.4rem; right: 0.5rem;
  z-index: 2;
  min-height: 1.85rem;
  padding: 0.2rem 0.65rem;
  font-family: var(--font-ui);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--code-comment);
  background: color-mix(in srgb, var(--code-bg-header) 88%, transparent);
  border: 1px solid var(--code-rule);
  border-radius: var(--radius-pill);
  cursor: pointer;
  opacity: 0.6;
  transition: opacity var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.code-block:hover .copy-btn, .copy-btn:focus-visible { opacity: 1; }
.copy-btn:hover { color: var(--code-text); border-color: var(--code-text); }
.copy-btn.copied { color: var(--code-string); border-color: var(--code-string); opacity: 1; }

/* highlight.js token colours tuned for --code-bg */
.hljs { color: var(--code-text); background: transparent; }
.hljs-comment, .hljs-quote { color: var(--code-comment); font-style: italic; }
.hljs-keyword, .hljs-selector-tag, .hljs-doctag, .hljs-formula, .hljs-subst, .hljs-deletion { color: var(--code-keyword); }
.hljs-string, .hljs-regexp, .hljs-addition, .hljs-meta .hljs-string, .hljs-template-tag { color: var(--code-string); }
.hljs-number, .hljs-literal, .hljs-symbol, .hljs-bullet { color: var(--code-number); }
.hljs-title, .hljs-title.function_, .hljs-name, .hljs-section, .hljs-selector-id { color: var(--code-title); }
.hljs-type, .hljs-title.class_, .hljs-class .hljs-title, .hljs-built_in { color: var(--code-type); }
.hljs-attr, .hljs-attribute, .hljs-variable, .hljs-template-variable, .hljs-selector-class, .hljs-selector-attr, .hljs-selector-pseudo, .hljs-params { color: var(--code-variable); }
.hljs-meta, .hljs-punctuation, .hljs-operator { color: var(--code-punct); }
.hljs-link { color: var(--code-title); text-decoration: underline; }
.hljs-emphasis { font-style: italic; }
.hljs-strong { font-weight: 700; }

/* --- Cards & grids ------------------------------------------------------- */
.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--rule);
}
.section-head h2 { font-size: var(--step-2); }
.section-head a {
  font-family: var(--font-ui);
  font-size: var(--step--1);
  font-weight: 600;
  text-decoration: none;
  color: var(--brand);
}
.section-head a:hover { text-decoration: underline; }

.grid { display: grid; gap: var(--space-5); }
.grid--cards { grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr)); }
.grid--related { grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr)); }

.card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-1);
  overflow: hidden;
  transition: transform var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out), border-color var(--dur) var(--ease);
}
.card:hover, .card:focus-within {
  transform: translateY(-3px);
  box-shadow: var(--shadow-2);
  border-color: color-mix(in srgb, var(--brand) 40%, var(--rule));
}
.card__media { display: block; overflow: hidden; background: var(--surface-2); }
.card__media img {
  width: 100%;
  aspect-ratio: 1200 / 630;
  object-fit: cover;
  transition: transform var(--dur-slow) var(--ease-out);
}
.card:hover .card__media img { transform: scale(1.03); }
.card__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-5);
}
.card__kicker {
  font-family: var(--font-ui);
  font-size: var(--step--2);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent-text);
}
.card__title { font-size: var(--step-1); line-height: 1.2; text-wrap: pretty; }
.card__title a { color: var(--ink); text-decoration: none; }
.card__title a:hover { color: var(--brand); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 0.2em; }
.card__excerpt { font-size: 0.9375em; line-height: 1.6; color: var(--ink-muted); }
.card__meta {
  font-family: var(--font-ui);
  font-size: var(--step--1);
  color: var(--ink-muted);
  margin-top: auto;
}

.featured { margin-bottom: var(--space-6); }
.card--featured { border-radius: var(--radius-lg); }
.card--featured .card__title { font-size: var(--step-3); }
.card--featured .card__excerpt { font-size: 1em; color: var(--ink-soft); }
@media (min-width: 52rem) {
  .card--featured { flex-direction: row; align-items: center; }
  .card--featured .card__media { flex: 0 0 44%; align-self: stretch; display: grid; align-items: center; }
  .card--featured .card__body { flex: 1 1 auto; padding: var(--space-6); gap: var(--space-4); justify-content: center; }
}

/* --- Outbound link cards (about page "elsewhere") ------------------------ */
.link-grid {
  list-style: none;
  padding: 0;
  display: grid;
  gap: var(--space-4);
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
}
.link-card {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  height: 100%;
  padding: var(--space-4) var(--space-5);
  text-decoration: none;
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  box-shadow: var(--shadow-1);
  transition: transform var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out), border-color var(--dur) var(--ease);
}
.link-card:hover, .link-card:focus-visible {
  transform: translateY(-2px);
  box-shadow: var(--shadow-2);
  border-color: color-mix(in srgb, var(--brand) 45%, var(--rule));
}
.link-card__title {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.0625rem;
  letter-spacing: -0.01em;
  color: var(--brand);
}
.link-card__arrow { font-size: 0.8em; opacity: 0.7; transition: transform var(--dur-fast) var(--ease); }
.link-card:hover .link-card__arrow { transform: translate(2px, -2px); }
.link-card__note {
  font-family: var(--font-ui);
  font-size: var(--step--1);
  line-height: 1.55;
  color: var(--ink-muted);
}
@media (prefers-reduced-motion: reduce) {
  .link-card:hover { transform: none; }
  .link-card:hover .link-card__arrow { transform: none; }
}

/* --- Simple stacked list (tag pages) ------------------------------------ */
.stack { list-style: none; padding: 0; display: grid; gap: 0; }
.stack-item {
  padding-block: var(--space-5);
  border-bottom: 1px solid var(--rule);
}
.stack-item:first-child { padding-top: 0; }
.stack-item__meta {
  font-family: var(--font-ui);
  font-size: var(--step--1);
  color: var(--ink-muted);
}
.stack-item__title { margin-top: var(--space-2); font-size: var(--step-1); }
.stack-item__title a { color: var(--ink); text-decoration: none; }
.stack-item__title a:hover { color: var(--brand); text-decoration: underline; text-underline-offset: 0.2em; }
.stack-item__excerpt { margin-top: var(--space-2); color: var(--ink-muted); font-size: 0.9375em; }

/* Books */
.book-list__meta { margin: 0 0 var(--space-6); color: var(--ink-muted); font-size: var(--step--1); }
.book-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(21rem, 1fr)); gap: var(--space-8); }
.book-item { display: grid; grid-template-columns: 6.5rem 1fr; gap: var(--space-5); align-items: start; padding-bottom: var(--space-6); border-bottom: 1px solid var(--rule); }
.book-item__cover img { width: 100%; height: auto; border-radius: 2px; box-shadow: 0 2px 10px rgb(0 0 0 / 0.18); display: block; }
.book-item__title { margin: 0 0 var(--space-1); font-size: 1.0625em; line-height: 1.35; }
.book-item__publisher { margin: 0 0 var(--space-2); font-size: 0.75em; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-muted); }
.book-item__desc { margin: 0 0 var(--space-3); font-size: 0.9375em; line-height: 1.55; color: var(--ink-muted); }
.book-item__links { display: flex; flex-wrap: wrap; gap: var(--space-4); margin: 0; font-size: 0.875em; font-weight: 600; }
@media (max-width: 30rem) { .book-item { grid-template-columns: 5rem 1fr; gap: var(--space-4); } }
.link-back {
  font-family: var(--font-ui);
  font-size: var(--step--1);
  font-weight: 600;
  text-decoration: none;
}
.link-back:hover { text-decoration: underline; }

/* --- Article furniture --------------------------------------------------- */
.article { max-width: var(--w-article); margin-inline: auto; }
.article-foot {
  max-width: var(--w-article);
  margin: var(--space-8) auto 0;
  padding-top: var(--space-6);
  border-top: 1px solid var(--rule);
}
.article-foot h2 { font-size: var(--step-1); margin-bottom: var(--space-5); }
.comments { max-width: var(--w-article); margin: var(--space-8) auto 0; }

/* --- Pager --------------------------------------------------------------- */
.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin-top: var(--space-8);
  padding-top: var(--space-5);
  border-top: 1px solid var(--rule);
  font-family: var(--font-ui);
}
.pager__link {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-height: 2.75rem;
  padding: 0.5rem 1rem;
  font-size: 0.9375rem;
  font-weight: 600;
  text-decoration: none;
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius-pill);
  color: var(--ink);
  transition: color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
}
.pager__link:hover { color: var(--brand); border-color: var(--brand); background: var(--brand-soft); }
.pager__status { font-size: var(--step--1); color: var(--ink-muted); text-align: center; }
@media (max-width: 34rem) {
  .pager { flex-wrap: wrap; justify-content: center; }
  .pager__status { order: 3; width: 100%; }
}

/* --- Subscribe CTA ------------------------------------------------------- */
.cta {
  position: relative;
  overflow: hidden;
  margin-top: var(--space-9);
  padding-block: clamp(2.5rem, 6vw, 4rem);
  background:
    radial-gradient(90% 130% at 100% 0%, var(--accent-soft), transparent 58%),
    radial-gradient(80% 120% at 0% 100%, var(--brand-soft), transparent 55%),
    var(--bg-tint);
  border-top: 1px solid var(--rule);
  border-bottom: 1px solid var(--rule);
}
.cta__inner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-5);
}
.cta__text { max-width: 46ch; }
.cta h2 { font-size: var(--step-2); }
.cta p { margin-top: var(--space-3); color: var(--ink-soft); }

/* --- Footer -------------------------------------------------------------- */
.footer {
  padding-block: var(--space-8) var(--space-6);
  background: var(--bg);
  border-top: 1px solid var(--rule);
  font-family: var(--font-ui);
  font-size: var(--step--1);
  color: var(--ink-muted);
}
.footer__grid {
  display: grid;
  gap: var(--space-6);
  padding-bottom: var(--space-6);
  border-bottom: 1px solid var(--rule);
}
@media (min-width: 48rem) {
  .footer__grid { grid-template-columns: minmax(0, 1.4fr) repeat(2, minmax(0, 1fr)); gap: var(--space-7); }
}
.footer__blurb { max-width: 42ch; line-height: 1.7; margin-top: 1rem; }
.footer h2 {
  font-family: var(--font-ui);
  font-size: var(--step--2);
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--ink-soft);
  margin-bottom: var(--space-3);
}
.footer ul { list-style: none; padding: 0; display: grid; gap: 0.4rem; }
.footer a { color: var(--ink-muted); text-decoration: none; }
.footer a:hover { color: var(--brand); text-decoration: underline; text-underline-offset: 0.2em; }
.footer__run {
  margin-top: var(--space-6, 1.5rem);
  padding-top: var(--space-5, 1.25rem);
  border-top: 1px solid var(--rule);
}
.footer__run-title {
  font-family: var(--font-ui);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent-text);
  margin-bottom: 0.75rem;
}
.footer__run-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 0.75rem;
  list-style: none;
  margin: 0;
  padding: 0;
}
.footer__run-list a { font-size: 0.875rem; }
.footer__run-list li + li::before {
  content: "·";
  margin-right: 0.75rem;
  opacity: 0.5;
}

/* Mobile: one item per row left a separator stranded at line start and tiny tap
   targets. Below 640px the run items become chips instead. */
@media (max-width: 640px) {
  .footer__run-list { gap: 8px; }
  .footer__run-list li + li::before { content: none !important; margin-right: 0 !important; }
  .footer__run-list a {
    display: block;
    padding: 9px 12px;
    border: 1px solid var(--rule);
    border-radius: 8px;
    line-height: 1.2;
    max-width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.footer__legal { padding-top: var(--space-5); display: grid; gap: var(--space-3); }
.footer__disclaimer { max-width: 68ch; opacity: 0.85; }

/* --- Dialogs (menu + search) -------------------------------------------- */
dialog {
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--rule);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2);
  padding: 0;
}
dialog::backdrop {
  background: rgba(9, 12, 18, 0.55);
  backdrop-filter: blur(3px);
}
.dialog {
  width: min(92vw, 34rem);
  max-height: min(85vh, 44rem);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.dialog__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-5);
  border-bottom: 1px solid var(--rule);
}
.dialog__head h2 { font-size: var(--step-1); }
.dialog__body { padding: var(--space-5); overflow-y: auto; }
.dialog__nav { display: grid; gap: 0.25rem; }
.dialog__nav .nav__link { min-height: 3rem; padding-inline: 0.9rem; font-size: 1.0625rem; }
.dialog__nav .btn { margin-top: var(--space-4); }
.search-input {
  width: 100%;
  padding: 0.85rem 1rem;
  font-family: var(--font-ui);
  font-size: 1.0625rem;
  color: var(--ink);
  background: var(--bg);
  border: 1px solid var(--rule-strong);
  border-radius: var(--radius);
  outline: none;
}
.search-input:focus-visible { border-color: var(--brand); outline: 2px solid var(--accent); outline-offset: 1px; }
.search-results { display: grid; gap: 0.5rem; margin-top: var(--space-4); }
.search-hint { font-family: var(--font-ui); font-size: var(--step--1); color: var(--ink-muted); margin-top: var(--space-4); }
.search-result {
  display: block;
  padding: 0.85rem 1rem;
  text-decoration: none;
  background: var(--surface-2);
  border: 1px solid var(--rule);
  border-radius: var(--radius);
  transition: border-color var(--dur-fast) var(--ease), background-color var(--dur-fast) var(--ease);
}
.search-result:hover, .search-result:focus-visible { border-color: var(--brand); background: var(--brand-soft); }
.search-result__type {
  font-family: var(--font-ui);
  font-size: var(--step--2);
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent-text);
}
.search-result__title { display: block; margin-top: 0.2rem; font-family: var(--font-display); font-weight: 700; color: var(--ink); }
.search-result__desc { margin-top: 0.25rem; font-family: var(--font-ui); font-size: var(--step--1); color: var(--ink-muted); }
.search-result mark { background: var(--accent-soft); color: var(--ink); border-radius: 3px; padding: 0 2px; }

/* --- Motion ------------------------------------------------------------- */
.js .reveal {
  opacity: 0;
  transform: translateY(14px);
  transition: opacity var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-out);
}
.js .reveal.is-in { opacity: 1; transform: none; }

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .js .reveal, .js .reveal.is-in { opacity: 1; transform: none; transition: none; }
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .card:hover, .btn--primary:hover { transform: none; }
  .card:hover .card__media img { transform: none; }
  .progress__bar { transition: none; }
}

/* --- Small screens ------------------------------------------------------ */
@media (max-width: 60rem) {
  .nav__link, .nav__cta { display: none; }
  #menu-btn { display: grid; }
  .brand__text { font-size: 1rem; }
}
@media (max-width: 30rem) {
  .hero__art { transform: none; }
}

/* --- Print -------------------------------------------------------------- */
@media print {
  .masthead, .progress, .cta, .footer, .comments, dialog, .copy-btn { display: none !important; }
  body { background: #fff; color: #000; }
  .prose { max-width: none; }
}
`;
}

// --- Layout Template ---

function renderPageHead({ eyebrow, title, lede }) {
    return `<section class="page-head">
        <div class="shell">
            <div class="page-head__inner">
                ${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}
                <h1>${title}</h1>
                ${lede ? `<p class="lede">${lede}</p>` : ''}
            </div>
        </div>
    </section>`;
}

const ICONS = {
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    theme: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/></svg>',
    menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'
};

function buildNavItems(config) {
    const items = [];
    (config.nav_links || []).forEach(l => items.push({ label: l.label, url: l.url }));

    ['blog', 'events', 'podcast'].forEach(key => {
        const feat = config.features && config.features[key];
        if (!feat) return;
        if (feat.mode === 'internal') items.push({ label: feat.label, url: `/${key}/index.html` });
        else if (feat.mode === 'external') items.push({ label: feat.label, url: feat.external_url, external: true });
    });
    return items;
}

function renderLayout(bodyContent, pageTitle, config, assets, seo = {}) {
    const navItems = buildNavItems(config);
    const navHtml = navItems.map(i =>
        `<a class="nav__link" href="${i.url}"${i.external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(i.label)}${i.external ? '<sup aria-hidden="true">↗</sup>' : ''}</a>`
    ).join('');

    const supportLink = config.support_link
        ? `<a class="btn btn--primary nav__cta" href="${config.support_link}" target="_blank" rel="noopener">Support my work</a>`
        : '';

    // Subscribe band sits between <main> and the footer so it reads as site furniture, not content.
    let subscribeSection = '';
    if (config.email_subscribe_form_url) {
        subscribeSection = `
        <section class="cta" aria-labelledby="cta-title">
            <div class="shell cta__inner">
                <div class="cta__text">
                    <p class="eyebrow">Newsletter</p>
                    <h2 id="cta-title">Get new posts in your inbox</h2>
                    <p>Deep dives on Apache Iceberg, lakehouse architecture and applied AI. No spam, unsubscribe anytime.</p>
                </div>
                <a class="btn btn--primary" href="${config.email_subscribe_form_url}" target="_blank" rel="noopener">Subscribe</a>
            </div>
        </section>`;
    }

    // SEO & Metadata Construction
    const fullTitle = `${pageTitle} | ${config.site_title}`;
    const description = seo.description || config.site_description;
    const url = seo.path ? `${config.domain}${seo.path}` : config.domain;
    const image = seo.image
        ? (seo.image.startsWith('http') ? seo.image : `${config.domain}${seo.image}`)
        : `${config.domain}/og-image.png`;
    const type = seo.type || 'website';
    const publishedTime = seo.date ? new Date(seo.date).toISOString() : '';
    const modifiedTime = seo.updatedDate ? new Date(seo.updatedDate).toISOString() : publishedTime;

    const authorObj = {
        "@type": "Person",
        "name": config.author_name,
        ...(config.author_url ? { "url": config.author_url } : {}),
        ...(config.author_sameAs && config.author_sameAs.length ? { "sameAs": config.author_sameAs } : {})
    };

    let jsonLd = {
        "@context": "https://schema.org",
        "@type": "WebPage",
        "url": url,
        "name": fullTitle,
        "description": description,
        "author": authorObj
    };

    if (type === 'article') {
        jsonLd = {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            "mainEntityOfPage": { "@type": "WebPage", "@id": url },
            "headline": pageTitle,
            "description": description,
            "image": image,
            "author": authorObj,
            "datePublished": publishedTime,
            "dateModified": modifiedTime
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

    const SOCIAL_LABELS = { twitter: 'Twitter', x: 'X', github: 'GitHub', linkedin: 'LinkedIn', youtube: 'YouTube', mastodon: 'Mastodon', bluesky: 'Bluesky' };
    const socialEntries = Object.entries(config.social_links || {})
        .map(([k, v]) => [SOCIAL_LABELS[k.toLowerCase()] || (k.charAt(0).toUpperCase() + k.slice(1)), v]);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${fullTitle}</title>
    ${seo.noindex ? '<meta name="robots" content="noindex, follow" />' : ''}
    <meta name="description" content="${description.replace(/"/g, '&quot;')}">
    <meta name="author" content="${escapeHtml(config.author_name)}">
    <meta name="theme-color" content="${(assets.themeColorLight)}" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="${(assets.themeColorDark)}" media="(prefers-color-scheme: dark)">
    <link rel="canonical" href="${url}" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <link rel="alternate" type="application/rss+xml" title="${escapeHtml(config.site_title)} RSS" href="/feed.xml">
    ${seo.prevUrl ? `<link rel="prev" href="${seo.prevUrl}" />` : ''}
    ${seo.nextUrl ? `<link rel="next" href="${seo.nextUrl}" />` : ''}

    <!-- Fonts -->
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="${assets.fontsUrl}">

    <!-- Styles -->
    <link rel="stylesheet" href="${assets.cssHref}">

    <!-- Set the theme before first paint so there is no flash. -->
    <script>
      (function () {
        var r = document.documentElement;
        r.classList.add('js');
        try {
          var t = localStorage.getItem('theme');
          if (t === 'dark' || t === 'light') r.setAttribute('data-theme', t);
        } catch (e) {}
      })();
    </script>

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

    <!-- WebSite Schema (back-reference to alexmerced.com) -->
    <script type="application/ld+json">
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "Alex Merced's Blog",
      "url": "https://alexmerced.blog",
      "author": { "@type": "Person", "@id": "https://alexmerced.com/#alexmerced", "name": "Alex Merced", "url": "https://alexmerced.com" },
      "publisher": { "@type": "Person", "@id": "https://alexmerced.com/#alexmerced", "name": "Alex Merced", "url": "https://alexmerced.com" }
    }
    </script>

    ${config.custom_head_html || ''}
</head>
<body>
    <a class="skip-link" href="#main">Skip to content</a>
    ${seo.progress ? '<div class="progress" aria-hidden="true"><div class="progress__bar" id="progress-bar"></div></div>' : ''}

    <header class="masthead" id="masthead">
        <div class="shell masthead__inner">
            <a class="brand" href="/">
                <span class="brand__mark" aria-hidden="true">AM</span>
                <span class="brand__text">${escapeHtml(config.site_title)}</span>
                <span class="brand__short" aria-hidden="true">alexmerced.blog</span>
            </a>
            <nav class="nav" aria-label="Main">
                ${navHtml}
                <button class="icon-btn" type="button" id="search-btn" aria-label="Search the site">${ICONS.search}</button>
                <button class="icon-btn" type="button" id="theme-btn" aria-label="Switch colour theme">${ICONS.theme}</button>
                <button class="icon-btn" type="button" id="menu-btn" aria-label="Open menu" aria-haspopup="dialog">${ICONS.menu}</button>
                ${supportLink}
            </nav>
        </div>
    </header>

    <main id="main">
        ${bodyContent}
    </main>

    ${subscribeSection}

    <footer class="footer">
        <div class="shell">
            <div class="footer__grid">
                <div>
                    <a class="brand" href="/">
                        <span class="brand__mark" aria-hidden="true">AM</span>
                        <span class="brand__text">${escapeHtml(config.site_title)}</span>
                    </a>
                    <p class="footer__blurb">${escapeHtml(config.site_description)}</p>
                </div>
                <div>
                    <h2>Explore</h2>
                    <ul>
                        ${navItems.map(i => `<li><a href="${i.url}"${i.external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(i.label)}</a></li>`).join('')}
                        <li><a href="/feed.xml">RSS feed</a></li>
                    </ul>
                </div>
                <div>
                    <h2>Elsewhere</h2>
                    <ul>
                        ${socialEntries.map(([label, v]) => `<li><a href="${v}" target="_blank" rel="noopener">${escapeHtml(label)}</a></li>`).join('')}
                        ${config.support_link ? `<li><a href="${config.support_link}" target="_blank" rel="noopener">Buy me a coffee</a></li>` : ''}
                    </ul>
                </div>
            </div>

            <nav class="footer__run" aria-label="The Alex Merced Network">
              <div class="footer__run-title">The Alex Merced Network</div>
              <ul class="footer__run-list">
                <li><a href="https://alexmerced.com" target="_blank" rel="noopener">AlexMerced.com</a></li>
                <li><a href="https://whoisalexmerced.com" target="_blank" rel="noopener">WhoIsAlexMerced.com</a></li>
                <li><a href="https://alexmercedmedia.com" target="_blank" rel="noopener">AlexMercedMedia.com</a></li>
                <li><a href="https://books.alexmerced.com" target="_blank" rel="noopener">Books</a></li>
                <li><a href="https://alexmercedcoder.dev" target="_blank" rel="noopener">AlexMercedCoder.dev</a></li>
                <li><a href="https://alexmerceddata.com" target="_blank" rel="noopener">AlexMercedData.com</a></li>
                <li><a href="https://datalakehousehub.com" target="_blank" rel="noopener">DataLakehouseHub.com</a></li>
                <li><a href="https://iceberglakehouse.com" target="_blank" rel="noopener">IcebergLakehouse.com</a></li>
                <li><a href="https://agenticlakehouse.com" target="_blank" rel="noopener">AgenticLakehouse.com</a></li>
                <li><a href="https://agenticanalyticsnow.com" target="_blank" rel="noopener">AgenticAnalyticsNow.com</a></li>
                <li><a href="https://openagenticplatform.com" target="_blank" rel="noopener">OpenAgenticPlatform.com</a></li>
                <li><a href="https://www.alexmercedai.com" target="_blank" rel="noopener">AlexMercedAI.com</a></li>
                <li><a href="https://semanticlakehouse.com" target="_blank" rel="noopener">SemanticLakehouse.com</a></li>
                <li><a href="https://openlakehouse.alexmerced.com" target="_blank" rel="noopener">OpenLakehouse.AlexMerced.com</a></li>
                <li><a href="https://dataengnr.com" target="_blank" rel="noopener">DataEngnr.com</a></li>
                <li><a href="https://grokoverflow.com" target="_blank" rel="noopener">GrokOverflow.com</a></li>
                <li><a href="https://ingestthis.com" target="_blank" rel="noopener">IngestThis.com</a></li>
              </ul>
            </nav>
            <nav class="footer__run" aria-label="Free weekly newsletters">
              <div class="footer__run-title">Free Weekly Newsletters</div>
              <ul class="footer__run-list">
                <li><a href="https://amdatalakehouse.substack.com" target="_blank" rel="noopener">AI newsletter, Thursdays</a></li>
                <li><a href="https://amdatalakehouse.substack.com" target="_blank" rel="noopener">Apache lakehouse newsletter, Fridays</a></li>
                <li><a href="https://amdatalakehouse.substack.com" target="_blank" rel="noopener">Subscribe on Substack</a></li>
              </ul>
            </nav>
            <nav class="footer__run" aria-label="Events and community">
              <div class="footer__run-title">Events &amp; Community</div>
              <ul class="footer__run-list">
                <li><a href="https://luma.com/agenticlakehouse" target="_blank" rel="noopener">Agentic Lakehouse Events</a></li>
                <li><a href="https://luma.com/DataLakehouseHub" target="_blank" rel="noopener">Data Lakehouse Hub Events</a></li>
                <li><a href="https://join.slack.com/t/thedatalakehousehub/shared_invite/zt-274yc8sza-mI2zhCW8LGkOh1uxuf8T5Q" target="_blank" rel="noopener">Data Lakehouse Hub Slack</a></li>
                <li><a href="https://join.slack.com/t/data-events/shared_invite/zt-38vgrooy9-U9ral_gr3NAz_Siih1QwmQ" target="_blank" rel="noopener">Data Events Slack</a></li>
                <li><a href="https://join.slack.com/t/datatechcommunity/shared_invite/zt-12xrk4qmd-y~6jUFFd7kdaLhgLURKwoA" target="_blank" rel="noopener">Data &amp; Tech Slack</a></li>
                <li><a href="https://www.reddit.com/r/datalakehouseandai/" target="_blank" rel="noopener">r/datalakehouseandai</a></li>
                <li><a href="https://www.linkedin.com/company/data-lakehouse-hub/" target="_blank" rel="noopener">Data Lakehouse Hub on LinkedIn</a></li>
                <li><a href="https://www.youtube.com/@AlexMercedCoder" target="_blank" rel="noopener">Alex Merced Tech on YouTube</a></li>
                <li><a href="https://www.youtube.com/@alexmerceddata" target="_blank" rel="noopener">Alex Merced Data &amp; AI on YouTube</a></li>
              </ul>
            </nav>
            <div class="footer__legal">
                <p>&copy; ${new Date().getFullYear()} ${escapeHtml(config.author_name)}. Built with SoloPlatform.</p>
                <p class="footer__disclaimer">The views, thoughts, and opinions expressed on this site belong solely to Alex Merced and do not represent the views of any organization or employer.</p>
            </div>
        </div>
    </footer>

    <dialog id="menu-dialog" aria-label="Site menu">
        <div class="dialog">
            <div class="dialog__head">
                <h2>Menu</h2>
                <button class="icon-btn" type="button" data-close-dialog aria-label="Close menu">${ICONS.close}</button>
            </div>
            <div class="dialog__body">
                <nav class="dialog__nav" aria-label="Site">
                    ${navItems.map(i => `<a class="nav__link" href="${i.url}"${i.external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(i.label)}${i.external ? '<sup aria-hidden="true">↗</sup>' : ''}</a>`).join('')}
                    ${config.support_link ? `<a class="btn btn--primary" href="${config.support_link}" target="_blank" rel="noopener">Support my work</a>` : ''}
                </nav>
            </div>
        </div>
    </dialog>

    <dialog id="search-dialog" aria-label="Search">
        <div class="dialog">
            <div class="dialog__head">
                <h2>Search</h2>
                <button class="icon-btn" type="button" data-close-dialog aria-label="Close search">${ICONS.close}</button>
            </div>
            <div class="dialog__body">
                <label class="visually-hidden" for="search-input">Search posts and pages</label>
                <input class="search-input" type="search" id="search-input" placeholder="Search posts, pages, topics…" autocomplete="off">
                <div class="search-results" id="search-results"></div>
                <p class="search-hint" id="search-hint">Type at least two characters.</p>
            </div>
        </div>
    </dialog>

    <script>
    (function () {
      var root = document.documentElement;
      var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

      /* Theme toggle: cycles between light and dark, remembering the choice. */
      function currentTheme() {
        var attr = root.getAttribute('data-theme');
        if (attr) return attr;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      }
      var themeBtn = document.getElementById('theme-btn');
      if (themeBtn) {
        themeBtn.addEventListener('click', function () {
          var next = currentTheme() === 'dark' ? 'light' : 'dark';
          root.setAttribute('data-theme', next);
          try { localStorage.setItem('theme', next); } catch (e) {}
          themeBtn.setAttribute('aria-label', next === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
        });
      }

      /* Dialogs */
      function wire(btnId, dialogId, onOpen) {
        var btn = document.getElementById(btnId);
        var dlg = document.getElementById(dialogId);
        if (!btn || !dlg) return;
        btn.addEventListener('click', function () {
          if (typeof dlg.showModal === 'function') dlg.showModal();
          else dlg.setAttribute('open', '');
          if (onOpen) onOpen(dlg);
        });
        dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
      }
      wire('menu-btn', 'menu-dialog');
      wire('search-btn', 'search-dialog', function () {
        var i = document.getElementById('search-input');
        if (i) i.focus();
      });
      document.querySelectorAll('[data-close-dialog]').forEach(function (b) {
        b.addEventListener('click', function () {
          var d = b.closest('dialog');
          if (d) d.close();
        });
      });
      document.addEventListener('keydown', function (e) {
        var tag = (document.activeElement && document.activeElement.tagName) || '';
        if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) {
          var d = document.getElementById('search-dialog');
          if (d && !d.open) { e.preventDefault(); d.showModal(); var i = document.getElementById('search-input'); if (i) i.focus(); }
        }
      });

      /* Masthead shadow once scrolled */
      var mast = document.getElementById('masthead');
      if (mast) {
        var onScroll = function () { mast.classList.toggle('is-stuck', window.scrollY > 8); };
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
      }

      /* Reading progress */
      var bar = document.getElementById('progress-bar');
      if (bar) {
        var tick = function () {
          var h = document.documentElement.scrollHeight - window.innerHeight;
          var pct = h > 0 ? Math.min(100, Math.max(0, (window.scrollY / h) * 100)) : 0;
          bar.style.width = pct.toFixed(2) + '%';
        };
        var queued = false;
        var raf = function () {
          if (queued) return;
          queued = true;
          window.requestAnimationFrame(function () { queued = false; tick(); });
        };
        tick();
        window.addEventListener('scroll', raf, { passive: true });
        window.addEventListener('resize', raf);
      }

      /* Reveal on scroll. Everything is force-shown after a moment so a stalled
         observer can never leave content permanently invisible. */
      var reveals = document.querySelectorAll('.reveal');
      if (reveals.length) {
        var showAll = function () { reveals.forEach(function (el) { el.classList.add('is-in'); }); };
        if (reduce.matches || !('IntersectionObserver' in window)) {
          showAll();
        } else {
          var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
              if (entry.isIntersecting) {
                entry.target.classList.add('is-in');
                io.unobserve(entry.target);
              }
            });
          }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
          reveals.forEach(function (el) { io.observe(el); });
          setTimeout(showAll, 2000);
        }
      }
    })();

    function copyCode(btn) {
      var pre = btn.nextElementSibling;
      if (!pre) return;
      var code = pre.innerText;
      navigator.clipboard.writeText(code).then(function () {
        btn.textContent = 'Copied';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('copied');
        }, 2000);
      }).catch(function () {
        btn.textContent = 'Error';
      });
    }
    </script>

    <script>
    (function () {
      var input = document.getElementById('search-input');
      if (!input) return;
      var resultsDiv = document.getElementById('search-results');
      var hint = document.getElementById('search-hint');
      var index = null;

      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
      }
      function escRe(s) { return s.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&'); }

      var t;
      input.addEventListener('input', function (e) {
        clearTimeout(t);
        t = setTimeout(function () { run(e.target.value.trim().toLowerCase()); }, 120);
      });

      async function run(q) {
        if (q.length < 2) {
          resultsDiv.innerHTML = '';
          hint.textContent = 'Type at least two characters.';
          return;
        }
        if (!index) {
          hint.textContent = 'Loading index…';
          try {
            index = await fetch('/search.json').then(function (r) { return r.json(); });
          } catch (err) {
            hint.textContent = 'Search is unavailable right now.';
            return;
          }
        }
        var hits = index.filter(function (i) {
          return (i.title && i.title.toLowerCase().indexOf(q) > -1) ||
                 (i.description && i.description.toLowerCase().indexOf(q) > -1);
        });
        if (!hits.length) {
          resultsDiv.innerHTML = '';
          hint.textContent = 'No results for “' + esc(q) + '”.';
          return;
        }
        var shown = hits.slice(0, 30);
        hint.textContent = hits.length + (hits.length === 1 ? ' result' : ' results') + (hits.length > shown.length ? ' (showing 30)' : '');
        var re = new RegExp('(' + escRe(q) + ')', 'gi');
        resultsDiv.innerHTML = shown.map(function (r) {
          var desc = esc(String(r.description || '').substring(0, 140)).replace(re, '<mark>$1</mark>');
          return '<a class="search-result" href="' + esc(r.url) + '">' +
                   '<span class="search-result__type">' + esc(r.type) + '</span>' +
                   '<span class="search-result__title">' + esc(r.title).replace(re, '<mark>$1</mark>') + '</span>' +
                   '<span class="search-result__desc">' + desc + '</span>' +
                 '</a>';
        }).join('');
      }
    })();
    </script>
</body>
</html>`;
}

// --- Main Build Function ---
async function build() {
    console.log('🚀 Starting Build...');
    await setupMarked();

    // 1. Prepare Paths
    await fs.ensureDir(DIST_DIR);
    await fs.emptyDir(DIST_DIR);

    // 2. Load Configs
    const config = await loadJSON(CONFIG_PATH);
    const theme = await loadJSON(THEME_PATH);
    const css = generateCSS(theme);
    const cssHash = crypto.createHash('sha1').update(css).digest('hex').slice(0, 10);
    const assets = {
        cssHref: `/styles.css?v=${cssHash}`,
        fontsUrl: (theme.fonts && theme.fonts.google_url) || '',
        themeColorLight: (theme.light && theme.light.bg) || '#ffffff',
        themeColorDark: (theme.dark && theme.dark.bg) || '#0d1117'
    };
    await fs.outputFile(path.join(DIST_DIR, 'styles.css'), css);
    console.log(`🎨 Built styles.css (${(css.length / 1024).toFixed(1)} kB).`);

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

        const body = `
            ${renderPageHead({ eyebrow: escapeHtml(data.eyebrow || 'Page'), title: escapeHtml(data.title), lede: data.description ? escapeHtml(data.description) : '' })}
            <div class="shell page">
                <div class="prose">${html}</div>
                ${renderLinkGrid(data.elsewhere, data.elsewhere_title)}
            </div>`;

        const pageHtml = renderLayout(body, data.title, config, assets, {
            path: `/${slug}.html`,
            description: data.description
        });

        await fs.outputFile(path.join(DIST_DIR, `${slug}.html`), pageHtml);
        console.log(`📄 Built Generic Page: ${slug}.html`);

        searchIndex.push({ title: data.title, type: 'Page', url: `/${slug}.html`, description: data.description || '' });
    }

    // 4. Build Home Page
    const homePath = path.join(CONTENT_DIR, 'home.md');
    let heroTitle = escapeHtml(config.site_title);
    let homeProse = '';
    let showRecent = true;
    let heroImage = null;
    let heroAlt = '';
    let booksCount = null;

    if (await fs.pathExists(homePath)) {
        const fileContent = await fs.readFile(homePath, 'utf-8');
        const { content, data } = matter(fileContent);
        showRecent = data.show_recent_blog_posts !== false;
        heroImage = data.hero_image || null;
        heroAlt = data.hero_image_alt || '';
        booksCount = data.books_count !== undefined && data.books_count !== null ? String(data.books_count) : null;

        // Promote the document's own H1 into the hero so each page keeps exactly one <h1>.
        let md = content;
        const h1 = md.match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m);
        if (h1) {
            heroTitle = escapeHtml(h1[1]);
            md = md.replace(h1[0], '');
        } else if (data.title) {
            heroTitle = escapeHtml(data.title);
        }
        homeProse = marked.parse(md);
    }

    const heroArt = await generateHeroArt(heroImage);
    // Decorative unless home.md supplies hero_image_alt.
    const dims = [
        heroArt && heroArt.width ? `width="${heroArt.width}"` : '',
        heroArt && heroArt.height ? `height="${heroArt.height}"` : ''
    ].filter(Boolean).join(' ');
    const ratioStyle = heroArt && heroArt.natural
        ? ` style="--hero-ratio: ${heroArt.natural.w} / ${heroArt.natural.h}"`
        : '';
    const artHtml = heroArt ? `
        <div class="hero__art reveal"${ratioStyle}>
            <picture>
                ${heroArt.webp ? `<source srcset="${heroArt.webp}" type="image/webp">` : ''}
                <img src="${heroArt.fallback}" alt="${escapeHtml(heroAlt)}" ${dims} fetchpriority="high" decoding="async">
            </picture>
        </div>` : '';

    const totalTags = new Set(allPosts.flatMap(p => (p.tags || []).map(tagSlug))).size;

    let homeHtml = `
        <section class="hero">
            <svg class="hero-ink" viewBox="0 0 1440 760" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
                <defs>
                    <linearGradient id="amb-fade" x1="0" y1="0" x2="1440" y2="0" gradientUnits="userSpaceOnUse">
                        <stop offset="0" stop-color="#fff"/>
                        <stop offset="0.115" stop-color="#fff"/>
                        <stop offset="0.145" stop-color="#000"/>
                        <stop offset="0.855" stop-color="#000"/>
                        <stop offset="0.885" stop-color="#fff"/>
                        <stop offset="1" stop-color="#fff"/>
                    </linearGradient>
                    <mask id="amb-mask"><rect width="1440" height="760" fill="url(#amb-fade)"/></mask>
                </defs>

                <g mask="url(#amb-mask)">
                    <!-- pen strokes down the margins, drawn and re-drawn -->
                    <path class="ink-stroke" pathLength="100" d="M60 60 C-20 190, 150 260, 60 380 S-30 560, 80 700"/>
                    <path class="ink-stroke ink-stroke--accent" pathLength="100" style="animation-delay:-5s" d="M141 90 C81 220, 207 300, 131 420 S55 590, 151 720"/>
                    <path class="ink-stroke" pathLength="100" style="animation-delay:-8s" d="M1380 60 C1460 190, 1290 260, 1380 380 S1470 560, 1360 700"/>
                    <path class="ink-stroke ink-stroke--accent" pathLength="100" style="animation-delay:-3s" d="M1324 90 C1384 220, 1258 300, 1334 420 S1410 590, 1314 720"/>

                    <g class="ink-dots">
                        <circle cx="60" cy="380" r="4"/>
                        <circle cx="131" cy="420" r="3" style="animation-delay:-1.6s"/>
                        <circle cx="1380" cy="380" r="4" style="animation-delay:-2.9s"/>
                        <circle cx="1334" cy="420" r="3" style="animation-delay:-4.1s"/>
                    </g>

                    <!-- a paragraph rule, ruled and unruled -->
                    <g class="ink-rules">
                        <line x1="40" y1="176" x2="160" y2="176"/>
                        <line x1="40" y1="600" x2="150" y2="600"/>
                        <line x1="1280" y1="176" x2="1400" y2="176"/>
                        <line x1="1290" y1="600" x2="1400" y2="600"/>
                    </g>
                </g>
            </svg>
            <div class="shell hero__inner">
                <div class="hero__copy">
                    <p class="eyebrow">Data engineering · Lakehouse · AI</p>
                    <h1 class="hero__title">${heroTitle}</h1>
                    <p class="hero__lede">${escapeHtml(config.site_description)}</p>
                    <div class="hero__actions">
                        <a class="btn btn--primary" href="/blog/index.html">Read the blog</a>
                        <a class="btn btn--ghost" href="/about.html">About Alex</a>
                    </div>
                </div>
                <div class="hero__aside">
                    ${artHtml}
                    <div class="hero__stats">
                        <p class="hero__stat"><b>${allPosts.length}</b><span>published posts</span></p>
                        <p class="hero__stat"><b>${totalTags}</b><span>topics covered</span></p>
                        ${booksCount ? `<p class="hero__stat"><b>${escapeHtml(booksCount)}</b><span>published books</span></p>` : ''}
                    </div>
                </div>
            </div>
        </section>
        <div class="shell page">
            <div class="prose prose--flush">${homeProse}</div>
        </div>`;

    if (showRecent && allPosts.length > 0) {
        const latest = allPosts.slice(0, 3);
        homeHtml += `
            <section class="shell page page--tight" aria-labelledby="latest-title">
                <div class="section-head">
                    <h2 id="latest-title">Latest writing</h2>
                    <a href="/blog/index.html">All ${allPosts.length} posts →</a>
                </div>
                <div class="grid grid--cards">
                    ${latest.map(p => renderPostCard(p)).join('')}
                </div>
            </section>`;
    }

    const fullHomeHtml = renderLayout(homeHtml, 'Home', config, assets, { path: '/' });
    await fs.outputFile(path.join(DIST_DIR, 'index.html'), fullHomeHtml);
    console.log('🏠 Built Home Page.');

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
                    <section class="article-foot" aria-labelledby="related-title">
                        <h2 id="related-title">Related reading</h2>
                        <div class="grid grid--related">
                            ${related.map(p => renderPostCard(p, { showExcerpt: false, level: 'h3' })).join('')}
                        </div>
                    </section>` : '';

                // Smart description: prefer frontmatter, then first clean text block (skip leading images/comments)
                const autoDesc = post.content
                    .replace(/^(\s*<!--.*?-->\s*|\s*!\[.*?\]\(.*?\)\s*)+/s, '')
                    .replace(/[#*`!\[\]]/g, '')
                    .trim()
                    .substring(0, 155) + '...';
                const seoData = {
                    type: 'article',
                    path: `/blog/${post.slug}.html`,
                    image: post.coverImage,
                    description: post.description || autoDesc,
                    date: post.date,
                    updatedDate: post.updated || null,
                    progress: true
                };

                // Giscus Script Logic
                let commentsSection = '';
                if (config.features.giscus && config.features.giscus.repo) {
                    const g = config.features.giscus;
                    commentsSection = `
                   <div class="comments">
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

                const body = `
                    <article>
                        <header class="post-head">
                            <div class="shell">
                                <div class="post-head__inner">
                                    <p class="eyebrow">Article</p>
                                    <h1>${escapeHtml(post.title)}</h1>
                                    <p class="byline">
                                        <span class="byline__author">By <a href="https://alexmerced.com/about">Alex Merced</a></span>
                                        <span class="dot"></span><time datetime="${isoDate(post.dateObj)}">${formatDate(post.dateObj)}</time>
                                        <span class="dot"></span>${escapeHtml(post.readingTime || '')}
                                    </p>
                                    ${post.tags && post.tags.length ? `<div class="chips--head">${renderTagChips(post.tags)}</div>` : ''}
                                </div>
                            </div>
                        </header>
                        <div class="shell page">
                            <div class="prose prose--article content">${post.html}</div>
                            ${relatedHtml}
                            ${commentsSection}
                        </div>
                    </article>`;

                const postHtml = renderLayout(body, post.title, config, assets, seoData);

                await fs.outputFile(path.join(blogDist, `${post.slug}.html`), postHtml);
                searchIndex.push({ title: post.title, type: 'Blog', url: `/blog/${post.slug}.html`, description: seoData.description });
            }

            // Pass 3: Build Indexes & Features
            await generatePaginatedIndex(posts, blogDist, config, assets);
            await generateBlogRSS(posts, config);
            await generateTagPages(posts, config, assets);
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

                const rsvpBtn = data.rsvp_link
                    ? `<p class="hero__actions"><a class="btn btn--primary" href="${data.rsvp_link}" target="_blank" rel="noopener">RSVP / Register</a></p>`
                    : '';

                const seoData = {
                    type: 'event',
                    path: `/events/${slug}.html`,
                    date: data.event_date,
                    location: data.location,
                    description: `Event: ${data.title} at ${data.location}`
                };

                const body = `
                    <article>
                        <header class="post-head">
                            <div class="shell">
                                <div class="post-head__inner">
                                    <p class="eyebrow">Event</p>
                                    <h1>${escapeHtml(data.title)}</h1>
                                    <p class="byline"><span class="byline__author">${escapeHtml(data.event_date)}</span><span class="dot"></span>${escapeHtml(data.location || '')}</p>
                                    ${rsvpBtn}
                                </div>
                            </div>
                        </header>
                        <div class="shell page">
                            <div class="prose content">${html}</div>
                        </div>
                    </article>`;

                const eventHtml = renderLayout(body, data.title, config, assets, seoData);

                await fs.outputFile(path.join(eventsDist, `${slug}.html`), eventHtml);
                events.push({ ...data, slug, dateObj: new Date(data.event_date) });
                searchIndex.push({ title: data.title, type: 'Event', url: `/events/${slug}.html`, description: seoData.description });
            }

            events.sort((a, b) => a.dateObj - b.dateObj); // Ascending for upcoming
            const listHtml = events.map(e => `
                <li class="stack-item reveal">
                    <p class="stack-item__meta"><time datetime="${isoDate(e.dateObj)}">${escapeHtml(e.event_date)}</time><span class="dot"></span>${escapeHtml(e.location || '')}</p>
                    <h2 class="stack-item__title"><a href="/events/${e.slug}.html">${escapeHtml(e.title)}</a></h2>
                    ${e.rsvp_link ? `<p class="stack-item__excerpt"><a href="${e.rsvp_link}" target="_blank" rel="noopener">RSVP ↗</a></p>` : ''}
                </li>
            `).join('');

            const body = `
                ${renderPageHead({ eyebrow: 'Calendar', title: 'Upcoming events', lede: 'Talks, workshops and streams. Come say hello.' })}
                <div class="shell page"><ol class="stack">${listHtml}</ol></div>`;

            const indexHtml = renderLayout(body, 'Events', config, assets, { path: '/events/index.html' });
            await fs.outputFile(path.join(eventsDist, 'index.html'), indexHtml);
            console.log(`📅 Built Events (${events.length} events).`);
        }
    }

    // 6b. Build Books
    {
        const booksData = await fs.readJson(path.join(__dirname, 'data', 'books.json'));
        const booksDist = path.join(DIST_DIR, 'books');
        await fs.ensureDir(booksDist);

        const cards = booksData.books.map(b => `
            <li class="book-item">
                <a class="book-item__cover" href="${b.canonicalPage}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">
                    <img src="${b.cover}" alt="" loading="lazy" decoding="async">
                </a>
                <div class="book-item__body">
                    <h2 class="book-item__title"><a href="${b.canonicalPage}" target="_blank" rel="noopener">${escapeHtml(b.title)}</a></h2>
                    ${b.publisher ? `<p class="book-item__publisher">${escapeHtml(b.publisher)}</p>` : ''}
                    <p class="book-item__desc">${escapeHtml(b.description)}</p>
                    <p class="book-item__links">
                        <a href="${b.canonicalPage}" target="_blank" rel="noopener">Details</a>
                        <a href="${b.amazon}" target="_blank" rel="noopener">Buy on Amazon</a>
                    </p>
                </div>
            </li>`).join('');

        const jsonLd = {
            '@context': 'https://schema.org',
            '@type': 'ItemList',
            name: 'Books by Alex Merced',
            numberOfItems: booksData.books.length,
            itemListElement: booksData.books.map((b, i) => ({
                '@type': 'ListItem',
                position: i + 1,
                item: {
                    '@type': 'Book',
                    name: b.title,
                    description: b.description,
                    url: b.canonicalPage,
                    author: { '@type': 'Person', name: config.author_name, url: config.author_url },
                },
            })),
        };

        const body = `
            ${renderPageHead({ eyebrow: 'Bookshelf', title: 'Books', lede: escapeHtml(booksData.intro) })}
            <div class="shell page">
                <p class="book-list__meta">${booksData.count} of ${booksData.totalInCatalog} titles.
                    <a href="${booksData.catalog}" target="_blank" rel="noopener">See the complete catalog</a></p>
                <ul class="book-list">${cards}</ul>
            </div>
            <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;

        const booksHtml = renderLayout(body, 'Books', config, assets, {
            path: '/books/index.html',
            description: booksData.intro,
        });
        await fs.outputFile(path.join(booksDist, 'index.html'), booksHtml);
        console.log(`📚 Built Books (${booksData.books.length} titles).`);
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

                let audioPlayer = '';
                if (data.audio_url) {
                    audioPlayer = `<audio controls src="${data.audio_url}" style="width:100%; margin: 1.5rem 0;"></audio>
                                   <p><a href="${data.audio_url}" download>Download MP3</a></p>`;
                }

                const seoData = {
                    path: `/podcast/${slug}.html`,
                    date: data.date,
                    description: `Podcast Episode: ${data.title}`
                };

                const body = `
                    <article>
                        <header class="post-head">
                            <div class="shell">
                                <div class="post-head__inner">
                                    <p class="eyebrow">Podcast</p>
                                    <h1>${escapeHtml(data.title)}</h1>
                                    <p class="byline"><time>${escapeHtml(data.date)}</time><span class="dot"></span>${escapeHtml(data.duration || '')}</p>
                                </div>
                            </div>
                        </header>
                        <div class="shell page">
                            <div class="prose content">${audioPlayer}${html}</div>
                        </div>
                    </article>`;

                const epHtml = renderLayout(body, data.title, config, assets, seoData);

                await fs.outputFile(path.join(podDist, `${slug}.html`), epHtml);
                episodes.push({ ...data, slug, html, dateObj: new Date(data.date) });
                searchIndex.push({ title: data.title, type: 'Podcast', url: `/podcast/${slug}.html`, description: seoData.description });
            }

            episodes.sort((a, b) => b.dateObj - a.dateObj);
            const listHtml = episodes.map(e => `
                <li class="stack-item reveal">
                    <p class="stack-item__meta"><time>${escapeHtml(e.date)}</time><span class="dot"></span>${escapeHtml(e.duration || '')}</p>
                    <h2 class="stack-item__title"><a href="/podcast/${e.slug}.html">${escapeHtml(e.title)}</a></h2>
                </li>
            `).join('');

            const body = `
                ${renderPageHead({ eyebrow: 'Audio', title: 'Podcast episodes', lede: 'Conversations on data, lakehouses and AI.' })}
                <div class="shell page"><ol class="stack">${listHtml}</ol></div>`;

            const indexHtml = renderLayout(body, 'Podcast', config, assets, { path: '/podcast/index.html' });
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

    // Collect specific URLs (only canonical root, not /index.html duplicate)
    const sitemapUrls = [
        { loc: `${domain}/`, priority: '1.0' }
    ];

    if (config.features.blog?.mode === 'internal') sitemapUrls.push({ loc: `${domain}/blog/index.html`, priority: '0.9' });
    if (config.features.events?.mode === 'internal') sitemapUrls.push({ loc: `${domain}/events/index.html`, priority: '0.9' });
    if (config.features.podcast?.mode === 'internal') sitemapUrls.push({ loc: `${domain}/podcast/index.html`, priority: '0.9' });

    const allFiles = await getFiles(DIST_DIR);
    const allHtml = allFiles.filter(f => f.endsWith('.html'));
    const uniqueUrls = new Set(sitemapUrls.map(u => u.loc));

    const xmlItems = sitemapUrls.map(u => `
  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <priority>${u.priority}</priority>
  </url>`).join('');

    // Add all other HTML files not explicitly added (exclude tag pages: low-value, noindexed)
    const dynamicItems = allHtml.map(p => {
        const relPath = path.relative(DIST_DIR, p).replace(/\\/g, '/');
        // Skip tag pages (noindexed), skip root index.html (canonical is /)
        if (relPath.startsWith('tags/') || relPath === 'index.html') return '';
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
Allow: /llms.txt

# AI crawler allowances
User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: CCBot
Allow: /

Sitemap: ${domain}/sitemap.xml`;
    await fs.outputFile(path.join(DIST_DIR, 'robots.txt'), robotsTxt);
    console.log('🤖 Built robots.txt');

    // Generate llms.txt
    await generateLLMsTxt(allPosts, config);

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
            const parsed = [];

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

                parsed.push({ ...data, slug, content, dateObj: new Date(data.date) });
            }

            parsed.sort((a, b) => b.dateObj - a.dateObj);
            const selected = POST_LIMIT ? parsed.slice(0, POST_LIMIT) : parsed;
            if (POST_LIMIT) console.log(`⚡ --limit=${POST_LIMIT}: building ${selected.length} of ${parsed.length} posts.`);

            for (const post of selected) {
                const html = markLeadIn(marked.parse(stripDuplicateTitle(post.content, post.title)));

                // Dynamic Cover Image
                let coverImage = post.cover_image;
                if (!coverImage) {
                    const safeName = path.basename(post.slug);
                    coverImage = await generateCoverImage(post.title, safeName, theme);
                }

                posts.push({ ...post, coverImage, readingTime: calculateReadingTime(post.content), html });
            }
        }
    }
    return posts;
}

build().catch(err => { console.error(err); process.exitCode = 1; });
