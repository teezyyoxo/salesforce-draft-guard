// Reads all actual GitHub issues; never creates or modifies GitHub reports.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const repo = 'teezyyoxo/salesforce-draft-guard';
const pages = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/issues?state=all&per_page=100`, '--paginate', '--slurp'], { encoding: 'utf8' }));
const issues = pages.flat().filter(issue => !issue.pull_request).sort((a,b) => a.number-b.number);
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('[', '&#91;').replaceAll(']', '&#93;').replace(/\r?\n/g, ' ');
const checked = new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
let table = `Snapshot checked ${checked}. **${issues.filter(i => i.state === 'open').length} open · ${issues.filter(i => i.state === 'closed').length} closed.**\n\n| GitHub report | Status | Labels |\n| --- | --- | --- |\n`;
if (!issues.length) table += '| No GitHub issues have been filed in this repository. | — | — |\n';
for (const issue of issues) table += `| [#${issue.number} ${escape(issue.title)}](${issue.html_url}) | **${issue.state === 'closed' ? 'Closed' : 'Open'}** | ${issue.labels.map(l => escape(l.name)).join(', ') || '—'} |\n`;
for (const relative of ['README.md']) {
  const file = path.join(__dirname, '..', relative);
  const source = fs.readFileSync(file, 'utf8');
  const pattern = /<!-- github-issues:start -->[\s\S]*?<!-- github-issues:end -->/;
  if (!pattern.test(source)) throw new Error(`Missing issue markers in ${relative}`);
  fs.writeFileSync(file, source.replace(pattern, `<!-- github-issues:start -->\n${table}<!-- github-issues:end -->`));
}
console.log(`Updated README issue table and badge from ${issues.length} actual GitHub reports.`);

const open = issues.filter(i => i.state === 'open').length;
const closed = issues.filter(i => i.state === 'closed').length;
fs.writeFileSync(path.join(__dirname, '..', 'assets/issues-status.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="188" height="20" role="img" aria-labelledby="title"><title id="title">GitHub issues: ${open} open, ${closed} closed</title><rect width="188" height="20" rx="3" fill="#032d60"/><path d="M48 0h137a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H48Z" fill="#0176d3"/><g fill="white" font-family="Arial,sans-serif" font-size="11"><text x="7" y="14">issues</text><text x="58" y="14">${open} open · ${closed} closed</text></g></svg>\n`);
