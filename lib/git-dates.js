// Per-file last-modified dates from git history, used for sitemap <lastmod>.
//
// Netlify may build from a shallow clone, where every file would look like it
// was last touched by the single fetched commit. So: with full history, read
// git at build time; with shallow history (or no git), fall back to
// data/git-dates.json, a snapshot committed by `npm run dates`
// (scripts/build-git-dates.js). Within one build the source never mixes.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'data', 'git-dates.json');
const TRACKED = ['content', 'data'];

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Walk `git log` once and collect first and last commit dates per path. */
function readGitHistory() {
    const out = git(['log', '--format=@%cI', '--name-only', '--no-renames', '--', ...TRACKED]);
    const files = {};
    let date = null;
    for (const line of out.split('\n')) {
        if (line.startsWith('@')) { date = line.slice(1); continue; }
        if (!line || !date) continue;
        // Newest first: the first sighting is the last modification.
        if (!files[line]) files[line] = { modified: date, created: date };
        files[line].created = date;
    }
    delete files['data/git-dates.json'];
    return files;
}

function loadDates() {
    try {
        if (git(['rev-parse', '--is-shallow-repository']) === 'false') {
            return { source: 'git', files: readGitHistory() };
        }
    } catch {
        // no git binary or not a repository: use the snapshot
    }
    if (fs.existsSync(SNAPSHOT)) {
        return { source: 'snapshot', files: JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')).files };
    }
    return { source: 'none', files: {} };
}

let cache;
function dates() {
    if (!cache) cache = loadDates();
    return cache;
}

function dateSource() {
    return dates().source;
}

/** Last commit date (ISO string) for a repo-relative path, or null. */
function gitModified(relPath) {
    const f = dates().files[relPath.replace(/\\/g, '/')];
    return f ? f.modified : null;
}

module.exports = { ROOT, readGitHistory, dateSource, gitModified };
