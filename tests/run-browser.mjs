import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');
const args = process.argv.slice(2);
const selected = args.filter(arg => arg.startsWith('--suite=')).map(arg => arg.slice('--suite='.length));
const forwarded = args.filter(arg => !arg.startsWith('--suite='));
const available = (await fs.readdir(path.join(root, 'tests/e2e'))).filter(name => name.endsWith('.spec.ts')).sort();
for (const name of selected) if (!available.includes(`${name}.spec.ts`)) throw new Error(`Unknown browser suite: ${name}`);
const files = available.filter(file => !selected.length || selected.includes(file.replace('.spec.ts', '')));
const results = [];
const basePort = Number(process.env.TEST_E2E_PORT || (process.platform === 'win32' ? 18081 : 4000));
const reports = path.join(root, 'playwright-report');
await fs.mkdir(reports, {recursive: true});

// Keep production throttles intact. Each suite gets its own disposable backend,
// database, cookies and report instead of repeatedly logging into one account
// through one rate limiter across the entire browser run.
for (const [index, file] of files.entries()) {
  const name = file.replace('.spec.ts', '');
  console.log(`BROWSER SUITE ${name}`);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'test', `tests/e2e/${file}`, ...forwarded,
      '--workers=1', ...(!selected.length ? ['--pass-with-no-tests'] : []), '--reporter=list,html', `--output=test-results/${name}`], {
      cwd: root, stdio: 'inherit', windowsHide: true,
      env: {...process.env, TEST_E2E_PORT: String(basePort + index), TEST_E2E_ISOLATED: '1',
        PLAYWRIGHT_HTML_REPORT: path.join(reports, name), PLAYWRIGHT_HTML_OPEN: 'never'},
    });
    child.once('error', reject);
    child.once('exit', status => resolve(status ?? 1));
  });
  results.push({suite: name, exitCode: code});
}
await fs.writeFile(path.join(reports, 'suites.json'), JSON.stringify(results, null, 2));
await fs.writeFile(path.join(reports, 'index.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>ZDis browser suites</title><h1>ZDis browser suites</h1><ul>${results.map(result => `<li><a href="${result.suite}/index.html">${result.suite}</a>: ${result.exitCode === 0 ? 'completed' : 'failed'}</li>`).join('')}</ul></html>`);
process.exitCode = results.some(result => result.exitCode !== 0) ? 1 : 0;
