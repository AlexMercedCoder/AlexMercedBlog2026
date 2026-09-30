// Writes data/git-dates.json: first and last commit date for every file under
// content/ and data/, from full git history. The build reads git directly when
// history is complete and uses this snapshot only when the clone is shallow
// (see lib/git-dates.js). Run `npm run dates` and commit the result after
// content changes land.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, readGitHistory } = require('../lib/git-dates');

const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (shallow !== 'false') {
    console.error('git-dates: this clone is shallow, so dates would be wrong. Run `git fetch --unshallow` first.');
    process.exit(1);
}

const files = readGitHistory();
const sorted = Object.fromEntries(Object.keys(files).sort().map(k => [k, files[k]]));
fs.writeFileSync(path.join(ROOT, 'data', 'git-dates.json'), JSON.stringify({ generatedBy: 'scripts/build-git-dates.js', files: sorted }, null, 2) + '\n');
console.log(`git-dates: wrote ${Object.keys(sorted).length} entries to data/git-dates.json`);
