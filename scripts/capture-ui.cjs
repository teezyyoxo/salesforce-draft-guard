// Run with Playwright installed: node scripts/capture-ui.cjs
// Captures real extension pages in a disposable browser profile with synthetic drafts.
const { chromium } = require('playwright');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = await mkdtemp(path.join(tmpdir(), 'draft-guard-preview-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    viewport: { width: 1120, height: 900 }, colorScheme: 'light'
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const options = await context.newPage();
    const errors = [];
    options.on('pageerror', error => errors.push(error.message));
    await options.goto(`chrome-extension://${id}/options.html`);
    await options.locator('#actions input').first().waitFor();
    await options.waitForFunction(() => document.querySelector('#keywords').value.includes('email'));
    assert.equal(await options.locator('#themeToggle').inputValue(), 'system');
    await options.emulateMedia({ colorScheme: 'dark' });
    await options.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await options.emulateMedia({ colorScheme: 'light' });
    await options.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    const tops = await options.locator('.check-card').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
    assert.equal(new Set(tops).size, 1, 'Desktop action checkboxes share a row');
    const frame = () => options.locator('.hero, .site-footer').evaluateAll(nodes => nodes.map(n => ({top:n.getBoundingClientRect().top,bottom:n.getBoundingClientRect().bottom})));
    const before = await frame();
    await options.locator('.settings-content').evaluate(n => n.scrollTop = n.scrollHeight);
    assert.deepEqual(await frame(), before, 'Only main content scrolls');
    await options.locator('#toastPosition').selectOption('upper-left');
    await options.locator('#save').click();
    await options.reload();
    await options.waitForFunction(() => document.querySelector('#toastPosition').value === 'upper-left');
    await options.locator('.settings-content').evaluate(n => n.scrollTop = n.scrollHeight);
    await options.locator('#reset').click();
    await options.waitForFunction(() => document.querySelector('#toastPosition').value === 'lower-right');
    await options.waitForFunction(() => document.querySelector('#status').textContent === '');
    await options.locator('.settings-content').evaluate(n => n.scrollTop = 0);
    await options.screenshot({ path: path.join(root, 'assets/screenshots/settings-light.png') });
    await options.locator('#themeToggle').selectOption('dark');
    await options.screenshot({ path: path.join(root, 'assets/screenshots/settings-dark.png') });
    await options.locator('.settings-content').evaluate(n => n.scrollTop = n.scrollHeight);
    await options.screenshot({ path: path.join(root, 'assets/screenshots/settings-display-dark.png') });
    await options.locator('#themeToggle').selectOption('light');
    await options.screenshot({ path: path.join(root, 'assets/screenshots/settings-display-light.png') });
    await options.locator('#themeToggle').selectOption('dark');
    await options.locator('.settings-content').evaluate(n => n.scrollTop = 0);
    const popup = await context.newPage();
    popup.on('pageerror', error => errors.push(error.message));
    await popup.setViewportSize({ width: 420, height: 540 });
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    const demo = {
      'sfdg:draft:demo-post': { actionType: 'post', label: 'Case update · Post', title: 'Case 00001234', value: 'I checked the latest logs and identified the connection timeout.\n\nNext step: verify the updated configuration with the customer.', updatedAt: Date.UTC(2026,9,9,14,24) },
      'sfdg:draft:demo-email': { actionType: 'email', label: 'Customer reply · Email', title: 'Case 00001234', value: 'Hi Alex,\n\nThanks for your patience. I’m reviewing the configuration and will follow up with the next steps shortly.', updatedAt: Date.UTC(2026,9,9,14,20) }
    };
    await popup.evaluate(async drafts => chrome.storage.session.set(drafts), demo);
    await popup.locator('#refresh').click();
    await popup.waitForFunction(() => document.querySelectorAll('.draft-card').length === 2);
    await popup.screenshot({ path: path.join(root, 'assets/screenshots/drafts-dark.png') });
    await popup.locator('#themeToggle').selectOption('light');
    await options.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await popup.screenshot({ path: path.join(root, 'assets/screenshots/drafts-light.png') });
    const popupFrame = () => popup.locator('.popup-header,.site-footer').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
    const popupBefore = await popupFrame();
    await popup.locator('.popup-content').evaluate(n => n.scrollTop = n.scrollHeight);
    assert.deepEqual(await popupFrame(), popupBefore);
    await popup.locator('.clear-button').first().click();
    await popup.waitForFunction(() => document.querySelectorAll('.draft-card').length === 1);
    await popup.locator('#clearAll').click();
    await popup.waitForFunction(() => !!document.querySelector('.empty-state'));
    const richText = '<p><strong>Bold</strong> <em>italic</em> <u>underline</u> <s>strike</s></p>\n' +
      '<p>Next line</p><p><br></p><ol><li data-list="ordered">First</li>' +
      '<li data-list="bullet">Bullet</li><li data-list="ordered">Second</li></ol>' +
      '<pre title="2 > 1">\n  first\n    second\n</pre><p>' + 'Long draft '.repeat(30) + 'End.</p>' +
      '<a href="/lightning/page/home">Salesforce link</a>' +
      '<a href="javascript:void(0)">Unsafe link</a>' +
      '<img src="https://example.invalid/image.png"><iframe src="https://example.invalid/"></iframe>';
    await popup.evaluate(html => chrome.storage.session.set({
      'sfdg:draft:demo-rich': { actionType: 'post', value: 'Wrong\n\nspacing', html, url: 'https://example.salesforce.com/' }
    }), richText);
    await popup.locator('#refresh').click();
    const richPreview = popup.locator('.draft-preview-rich');
    await richPreview.waitFor();
    assert.equal(await richPreview.locator('strong, em, u, s').count(), 4);
    assert.equal(await richPreview.locator('iframe, [src]').count(), 0);
    assert.equal(await richPreview.getByRole('link', { name: 'Salesforce link' }).getAttribute('href'),
      'https://example.salesforce.com/lightning/page/home');
    assert.equal(await richPreview.getByText('Unsafe link').getAttribute('href'), null);
    assert.equal(await richPreview.locator('pre').textContent(), '\n  first\n    second\n');
    assert.deepEqual(await richPreview.locator('li').evaluateAll(items => items.map(item => [item.value, getComputedStyle(item).listStyleType])),
      [[1, 'decimal'], [0, 'disc'], [2, 'decimal']]);
    assert.match(await richPreview.textContent(), /End\./);
    assert.equal(await richPreview.locator('p').evaluateAll(([first, second, blank]) =>
      second.offsetTop === first.offsetTop + first.offsetHeight && blank.offsetHeight === second.offsetHeight), true);
    assert.equal(await popup.evaluate(async () => (await chrome.storage.local.get('sfdg:ui-theme'))['sfdg:ui-theme']), 'light');
    await options.locator('#themeToggle').selectOption('system');
    await popup.waitForFunction(() => document.querySelector('#themeToggle').value === 'system');
    await options.setViewportSize({ width: 390, height: 720 });
    assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await options.screenshot({ path: path.join(root, 'assets/screenshots/settings-mobile.png') });
    assert.deepEqual(errors, [], 'No extension page errors');
    console.log('Verified themes, shared preference, sticky chrome, settings persistence/reset, draft clearing, rich-text preview, desktop actions, and mobile layout. Captured seven screenshots.');
  } finally {
    await context.close();
    await rm(profile, {recursive:true, force:true});
  }
})();
