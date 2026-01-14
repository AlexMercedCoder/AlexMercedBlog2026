# SoloPlatform (Static Edition) - Product Requirement Document

## 1. Executive Summary
**SoloPlatform** is a "No-Backend" static site generator template designed for independent creators. It allows users to manage a professional Blog, Event calendar, and Podcast feed simply by editing files in a GitHub repository.

The core philosophy is **"Clone & Go"**. There is no database to configure, no authentication to set up, and no API keys required for core functionality. It relies on established third-party integrations for dynamic features (RSVPs, Emails).

## 2. Core Constraints & Architecture
- **Architecture**: Static Site Generator (SSG). A build script compiles Markdown + JSON Config -> Static HTML.
- **Hosting**: Netlify / GitHub Pages / Vercel (Free Tiers).
- **Data Source**: Local Markdown files (`/content/blog`, `/content/events`) and `config.json`.
- **Styling**: **Material Design 3** implementation using modern CSS Variables, controlled by a user-editable `theme.json`.

## 3. Feature Specifications

### 3.1 Content Engines (Markdown-Based)
- **Blogs**: Standard Markdown files with frontmatter (title, date, tags, cover_image).
- **Events**: Markdown files for event details.
  - **RSVP Solution**: The "RSVP" button will legally just be a link.
    - *Option A*: generic `mailto:` link.
    - *Option B (Recommended)*: Link to a **Google Form** or **Luma** event page.
    - *Implementation*: Frontmatter field `rsvp_link`. If present, renders a "Register" button.
- **Podcasts**: Markdown files for episodes.
  - **Audio**: Frontmatter `audio_url` pointing to an external host (Archive.org, R2, S3).
  - **RSS Feed**: The build script will auto-generate a valid `feed.xml` based on these files.
- **Support Me**: A dedicated slot in the `config.json` for a generic "Support" link (Patreon, Ko-fi, GitHub Sponsors).

### 3.5 Feature Swapping (Hybrid Mode)
- **Concept**: Users can choose to use the internal engines OR replace them with external links.
- **Configuration**:
  ```json
  "features": {
    "blog": { "mode": "internal", "external_url": "" },
    "events": { "mode": "external", "external_url": "https://lu.ma/mypage" },
    "podcast": { "mode": "internal" }
  }
  ```
- **Behavior**:
  - If `mode` is "external", the Navigation Link goes directly to the `external_url` (e.g., Medium, Luma).
  - The internal routes for that feature are disabled/not generated.

### 3.6 Main Page
- **Content**: Driven by `/content/home.md`.
- **Design**: "Attractive Main Page" with a Hero section (from frontmatter) and rich markdown content below.
- **Context**: Can display recent items (latest 3 blog spots) if enabled in config.

## 4. Technical Stack
- **Language**: Node.js (for the build script).
- **Templating**: JavaScript Template Strings (Lite) or simple replacement. No heavy frameworks (Next/Nuxt) to keep the "Clone" process simple.
- **Dependencies**:
  - `marked` (Markdown parsing).
  - `fs-extra` (File operations).
  - `gray-matter` (Frontmatter parsing).
  - *No other runtime dependencies*.

## 5. Directory Structure
```
/content
  /blog
  /events
  /podcast
  home.md      <-- Main Page Content
/public (assets)
/src
  /layouts
  /components
  /styles
build.js
config.json
theme.json
README.md      <-- Comprehensive Usage Guide
```

## 6. Development Workflow
1.  User clones repo.
2.  Runs `npm install` (once).
3.  Runs `npm run dev` to watch for changes and rebuild locally.
4.  Commits changes -> Netlify auto-builds using `node build.js`.
