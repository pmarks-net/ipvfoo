// Chromium extension integration. Optional live credential is supplied
// only via IPINFO_TEST_TOKEN; never written to reports, fixtures or screenshots.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {pathToFileURL} = require('node:url');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'validation');
const liveToken = process.env.IPINFO_TEST_TOKEN || '';
// Playwright resolves installed browser channels on each supported OS. The
// bundled full Chromium (not headless-shell) also supports extension widgets.
const browsers = (process.env.IPVFOO_TEST_BROWSERS || 'chromium').split(',').map(value => {
  const name = value.trim();
  if (!['chromium', 'chrome', 'edge'].includes(name)) {
    throw new Error(`Unsupported IPVFOO_TEST_BROWSERS entry: ${name}`);
  }
  const channel = name === 'edge' ? 'msedge' : name;
  const executablePath = process.env[`IPVFOO_${name.toUpperCase()}_PATH`];
  return [name, executablePath ? {executablePath} : {channel}];
});
const waitFor = async (check, message) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

async function runBrowser(name, launchOptions, testUrl) {
  const context = await chromium.launchPersistentContext('', {
    ...launchOptions, headless: process.env.IPVFOO_TEST_HEADED !== '1', viewport: {width: 1000, height: 760},
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging'],
  });
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  let worker;
  const report = {browser: name, version: context.browser().version(), checks: []};
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const {id} = await cdp.send('Extensions.loadUnpacked', {path: path.join(root, 'src'), enableInIncognito: true});
    worker = context.serviceWorkers().find(item => item.url().includes(id)) ||
      await context.waitForEvent('serviceworker', {timeout: 15000});
    await worker.evaluate(async () => { await Promise.all([storageReady, ipinfoService.ready]); });
    const base = `chrome-extension://${id}/`;
    const settings = await context.newPage();
    await settings.goto(base + 'options.html');
    await settings.locator('#ipinfo-token:not([disabled])').waitFor();
    assert.equal(await settings.locator('#ipinfo-token').inputValue(), '');
    assert.equal(await settings.locator('#ipinfo-enabled').isChecked(), false);
    await settings.screenshot({path: path.join(output, `${name}-settings.png`)});
    report.checks.push('Fresh install: disabled, empty masked token, options loaded');
    const upstream = await context.newPage();
    await upstream.goto(pathToFileURL(path.join(root, 'tests', 'iputil_test.html')).href);
    await upstream.waitForFunction(() => document.body.style.backgroundColor === 'rgb(153, 255, 153)');
    await upstream.close();
    report.checks.push('Original upstream IP parser browser tests pass');

    await worker.evaluate(() => {
      globalThis.qaCalls = [];
      globalThis.qaOriginalFetch = ipinfoService._fetch;
      ipinfoService._fetch = async url => {
        const ip = decodeURIComponent(url.split('/').pop());
        qaCalls.push(ip);
        return new Response(JSON.stringify({ip, asn: 'AS15169', as_name: 'Fixture Network',
          country_code: 'US', country: 'United States'}), {status: 200, headers: {'Content-Type': 'application/json'}});
      };
    });
    const target = await context.newPage();
    await target.goto(testUrl);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, testUrl);
    await waitFor(() => worker.evaluate(id => Object.values(tabMap[id]?.domains || {}).some(d => d.addr === '127.0.0.1'), tabId), 'Browser did not capture loopback IP');
    let popup = await context.newPage();
    await popup.goto(base + `popup.html#${tabId}`);
    await popup.locator('.countryTd', {hasText: 'Loopback'}).waitFor();
    const preview = await context.newPage();
    await preview.goto(base + 'popup.html');
    await preview.locator('#ipinfo_status', {hasText: 'Preview'}).waitFor();
    await preview.close();
    assert.equal(await worker.evaluate(() => qaCalls.length), 0);
    report.checks.push('Actual webRequest capture of loopback: visible row, zero API calls');

    await settings.locator('#ipinfo-token').fill('test-only-not-a-real-token');
    await settings.locator('#ipinfo-show').click();
    assert.equal(await settings.locator('#ipinfo-token').getAttribute('type'), 'text');
    await settings.locator('#ipinfo-show').click();
    await settings.locator('#ipinfo-enabled').check();
    await settings.locator('#ipinfo-save').click();
    await settings.locator('#ipinfo-status', {hasText: 'Saved.'}).waitFor();
    assert.equal(await settings.locator('#ipinfo-token').getAttribute('type'), 'password');
    assert.equal(await worker.evaluate(async () => JSON.stringify(await chrome.storage.sync.get()).includes('test-only-not-a-real-token')), false);
    await worker.evaluate(id => {
      const info = tabMap[id];
      for (const [domain, ip] of [
        ['private.test', '192.168.1.1'], ['cgnat.test', '100.64.0.1'], ['ipv6-local.test', 'fd00::1'],
        ['nat64-private.test', '64:ff9b::c0a8:101'], ['google-v4.test', '8.8.8.8'],
        ['duplicate.test', '8.8.8.8'], ['google-v6.test', '2001:4860:4860::8888'],
        ['a-very-long-domain-name-that-will-exercise-the-existing-expandable-hostname-control.example.test', '8.8.8.8'],
      ]) info.addDomain(domain, DFLAG_H1, ip, 0);
    }, tabId);
    await waitFor(async () => await popup.locator('.asnTd', {hasText: 'AS15169'}).count() === 4, 'Metadata columns did not populate');
    assert.equal(await worker.evaluate(() => qaCalls.length), 2);
    report.checks.push('Private IPv4/IPv6/NAT64 skipped; two public IPs deduplicated across rows');
    await waitFor(() => popup.locator('img.countryFlag').evaluateAll(images => images.length === 4 && images.every(img => img.complete && img.naturalWidth > 0)), 'Known country flags did not load');
    const knownFlags = await popup.locator('img.countryFlag').evaluateAll(images => images.map(img => ({
      src: img.src, width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height,
      code: img.parentElement.textContent, title: img.parentElement.title,
    })));
    for (const flag of knownFlags) {
      const source = new URL(flag.src);
      assert.equal(source.protocol, 'chrome-extension:');
      assert.equal(source.hostname, id);
      assert.match(source.pathname, /\/us\.svg$/i);
      assert.equal(flag.width, 20);
      assert.equal(flag.height, 15);
      assert.equal(flag.code, 'US');
      assert.equal(flag.title, 'United States');
    }
    for (const domain of ['private.test', 'cgnat.test', 'ipv6-local.test', 'nat64-private.test', '127.0.0.1']) {
      assert.equal(await popup.locator('#addr_table tr').filter({hasText: domain}).locator('img.countryFlag').count(), 0);
    }
    report.checks.push('Known countries load local 20x15 SVG flags with unchanged code/title; local rows have no flags');
    assert.equal(await popup.locator('.orgTd .orgName', {hasText: 'Fixture Network'}).count(), 4);
    assert.equal(await popup.locator('.orgTd').filter({hasText: 'Fixture Network'}).first().getAttribute('title'), 'Fixture Network');

    // Isolate rendering edge cases without API calls or mutating captured rows.
    const flagCases = await context.newPage();
    await flagCases.goto(base + 'popup.html');
    await flagCases.locator('#ipinfo_status', {hasText: 'Preview'}).waitFor();
    const invalidFlags = await flagCases.evaluate(() => {
      const row = document.querySelector('#addr_table tr');
      return [
        {status: 'ok', countryCode: 'ZZ', country: 'Unknown'},
        {status: 'ok', countryCode: '../US', country: 'Malformed'},
        {status: 'ok', countryCode: 'USA', country: 'Malformed three-character code'},
        {status: 'ok', countryCode: '', country: 'Missing'},
        {status: 'ok'},
        {status: 'local', countryCode: 'US', label: 'Local'},
        {status: 'special', countryCode: 'US', label: 'Documentation'},
        {status: 'error', countryCode: 'US'},
      ].map(result => {
        renderMetadata(row, result);
        return {status: result.status, flagCount: row.querySelectorAll('img.countryFlag').length};
      });
    });
    assert.ok(invalidFlags.every(result => result.flagCount === 0), 'Unknown, malformed or unavailable metadata created a flag');
    await flagCases.evaluate(() => renderMetadata(document.querySelector('#addr_table tr'), {status: 'ok', countryCode: 'US', country: 'United States'}));
    await waitFor(() => flagCases.locator('img.countryFlag').evaluateAll(images => images.length === 1 && images[0].complete && images[0].naturalWidth > 0), 'US flag failed to load in fallback fixture');
    await flagCases.locator('img.countryFlag').evaluate(img => { img.src = chrome.runtime.getURL('__missing_flag_fixture__.svg'); });
    await waitFor(() => flagCases.locator('img.countryFlag').evaluateAll(images => images.every(img => getComputedStyle(img).display === 'none' || img.getBoundingClientRect().width === 0)), 'Failed flag remained visibly broken');
    assert.equal(await flagCases.locator('#addr_table tr').first().locator('.countryTd').innerText(), 'US');
    assert.equal(await flagCases.locator('#addr_table tr').first().locator('.countryTd').getAttribute('title'), 'United States');
    await flagCases.evaluate(() => {
      const row = document.querySelector('#addr_table tr');
      renderMetadata(row, {status: 'ok', countryCode: 'US', country: 'United States'});
      globalThis.qaOldFlag = row.querySelector('img.countryFlag');
      renderMetadata(row, {status: 'ok', countryCode: 'SG', country: 'Singapore'});
      qaOldFlag.dispatchEvent(new Event('error'));
    });
    await waitFor(() => flagCases.locator('img.countryFlag').evaluateAll(images => images.length === 1 && images[0].complete && images[0].naturalWidth > 0 && /\/sg\.svg$/i.test(images[0].src)), 'Country replacement kept a stale flag or old image error removed the new flag');
    assert.equal(await flagCases.locator('#addr_table tr').first().locator('.countryTd').innerText(), 'SG');
    assert.equal(await flagCases.locator('#addr_table tr').first().locator('.countryTd').getAttribute('title'), 'Singapore');
    const organizationStates = await flagCases.evaluate(() => {
      const row = document.querySelector('#addr_table tr');
      const longName = 'Fixture Network International Services and Infrastructure Organization';
      renderMetadata(row, {status: 'ok', asn: 'AS4294967295', asName: longName});
      const name = row.querySelector('.orgName');
      const populated = {text: name.textContent, title: row.querySelector('.orgTd').title,
        width: name.getBoundingClientRect().width, scroll: name.scrollWidth, overflow: getComputedStyle(name).textOverflow};
      const emptyStates = [{status: 'ok'}, {status: 'local', label: 'Local'}, {status: 'special', label: 'Documentation'},
        {status: 'error'}, {status: 'disabled'}, {status: 'incognito'}].map(result => {
        renderMetadata(row, result);
        return {text: row.querySelector('.orgTd').textContent, title: row.querySelector('.orgTd').title};
      });
      return {longName, populated, emptyStates};
    });
    assert.equal(organizationStates.populated.text, organizationStates.longName);
    assert.equal(organizationStates.populated.title, organizationStates.longName);
    assert.ok(organizationStates.populated.width > 0 && organizationStates.populated.width <= 150);
    assert.ok(organizationStates.populated.scroll > organizationStates.populated.width);
    assert.equal(organizationStates.populated.overflow, 'ellipsis');
    assert.ok(organizationStates.emptyStates.every(state => state.text === '—' && state.title !== organizationStates.longName));
    report.checks.push('Organization is visible with full tooltip, long-name ellipsis, and no stale name for missing/local/error/disabled data');

    // Use preview rows to exercise display/copy without creating API requests.
    const nativeAddress = '2001:4860:1234:5678:abcd:ef01:2345:6789';
    const mappedAddress = '::ffff:192.168.100.200';
    const nat64Address = '64:ff9b::192.168.100.200';
    for (const [address, expandWith] of [[nativeAddress, 'click'], [mappedAddress, 'Enter'], [nat64Address, 'Space']]) {
      await flagCases.evaluate(address => {
        table.replaceChildren(makeRow(true, ['address.test', address, '6', DFLAG_H1]));
        getSelection().removeAllRanges();
      }, address);
      const cell = flagCases.locator('.addrTd');
      const complete = cell.locator(':scope > .selectMe');
      assert.equal(await cell.textContent(), address, 'Compaction changed the underlying address');
      assert.equal(await complete.getAttribute('title'), address, 'Complete address is unavailable on hover');
      assert.equal(await complete.evaluate(span => span.classList.contains('compactAddress')), true);
      const snipIcon = complete.locator('.addressEllipsis img.snipImg');
      await waitFor(() => snipIcon.evaluate(img => img.complete && img.naturalWidth > 0), 'IPv6 ellipsis image failed to load');
      assert.equal(await snipIcon.getAttribute('src'), 'snip.png');
      const iconSize = await snipIcon.evaluate(img => ({width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height}));
      assert.deepEqual(iconSize, {width: 15, height: 11});
      await complete.hover({position: {x: 2, y: 5}});
      await complete.click({position: {x: 2, y: 5}});
      assert.equal(await flagCases.evaluate(() => getSelection().toString()), address, 'Click selection copied the abbreviated address');
      await flagCases.evaluate(() => getSelection().removeAllRanges());
      await complete.click({button: 'right', position: {x: 2, y: 5}});
      assert.equal(await flagCases.evaluate(() => getSelection().toString()), address, 'Right-click selection copied the abbreviated address');
      const lookup = await flagCases.evaluate(() => selectionToLookupUrl(getSelection().toString()).href);
      // The existing HE lookup converts a dotted IPv4 tail to hexadecimal.
      const lookupAddress = address.replace('192.168.100.200', 'c0a8:64c8');
      assert.ok(decodeURIComponent(lookup).endsWith(lookupAddress), 'Lookup URL lost part of the selected address');
      await flagCases.keyboard.press('Escape');
      await flagCases.evaluate(() => getSelection().removeAllRanges());
      if (address.endsWith('192.168.100.200')) {
        await complete.locator('.selectMe').click();
        assert.equal(await flagCases.evaluate(() => getSelection().toString()), '192.168.100.200', 'Embedded IPv4 is no longer independently selectable');
        await flagCases.evaluate(() => getSelection().removeAllRanges());
      }
      const ellipsis = complete.locator('.addressEllipsis');
      if (expandWith === 'click') await ellipsis.click();
      else { await ellipsis.focus(); await flagCases.keyboard.press(expandWith); }
      assert.equal(await complete.evaluate(span => span.classList.contains('is-expanded')), true, `${expandWith} did not expand IPv6`);
      assert.equal(await complete.locator('.addressHidden').evaluate(span => getComputedStyle(span).position), 'static');
      assert.equal(await ellipsis.isVisible(), false);
      assert.equal(await cell.textContent(), address);
      // A same-address pushOne must preserve the user's expansion.
      await flagCases.evaluate(address => pushOne(['address.test', address, '6', DFLAG_H1 | AFLAG_CACHE]), address);
      assert.equal(await complete.evaluate(span => span.classList.contains('is-expanded')), true, 'Connection-state update collapsed the expanded IPv6');
    }
    report.checks.push('Compact native/mapped/NAT64 IPv6 preserves full hover/copy/lookup and IPv4 suffix selection; click/Enter/Space expansion survives same-IP updates');
    await flagCases.close();
    assert.equal(await worker.evaluate(() => qaCalls.length), 2);
    report.checks.push('Unknown/malformed/missing countries omit flags; failed images preserve code; country changes remove stale flags');
    assert.equal(await popup.locator('.asnTd').filter({hasText: 'AS15169'}).first().getAttribute('title'), 'Fixture Network');
    const ipv6 = popup.locator('tr').filter({hasText: 'google-v6.test'}).locator('.addrTd');
    assert.equal(await ipv6.innerText(), '2001:4860:4860::8888');
    await ipv6.click({button: 'right'});
    assert.equal(await popup.evaluate(() => window.getSelection().toString()), '2001:4860:4860::8888');
    assert.match(await popup.evaluate(() => selectionToLookupUrl(window.getSelection().toString()).href), /^https:\/\/bgp\.he\.net\/ip\//);
    await popup.keyboard.press('Escape');
    await popup.evaluate(() => window.getSelection().removeAllRanges());
    const widths = await popup.evaluate(() => ({scroll: document.documentElement.scrollWidth, width: document.body.getBoundingClientRect().width}));
    assert.ok(widths.width <= 800 && widths.scroll <= 1000);
    assert.equal(await popup.locator('table').evaluate(table => getComputedStyle(table).backgroundImage), 'none');
    assert.equal(await popup.locator('th').filter({hasText: /^Domain$/}).evaluate(th => getComputedStyle(th).backgroundImage), 'none');
    assert.deepEqual(await popup.locator('th').allTextContents(), ['Domain', 'IP address', 'Organization', 'ASN', 'Country']);
    for (const theme of ['light', 'dark']) {
      await popup.emulateMedia({colorScheme: theme});
      await popup.locator('.border').screenshot({path: path.join(output, `${name}-popup-${theme}.png`)});
    }
    report.checks.push('Country/ASN tooltips, full IPv6 selection/right-click lookup, bounded width, light/dark screenshots');
    await popup.close();
    popup = await context.newPage();
    await popup.goto(base + `popup.html#${tabId}`);
    await waitFor(async () => await popup.locator('.asnTd', {hasText: 'AS15169'}).count() === 4, 'Cache did not populate reopened popup');
    assert.equal(await worker.evaluate(() => qaCalls.length), 2);
    report.checks.push('Reopening popup reuses cache without new API requests');

    const privateContext = await context.browser().newContext();
    try {
      const privateTarget = await privateContext.newPage();
      await privateTarget.goto(testUrl + '?incognito');
      const privateId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, testUrl + '?incognito');
      // Spanning extensions cannot navigate an incognito tab to an extension
      // page. The action popup lives in the extension context, keyed to the
      // actual incognito target tab, just as Chrome's toolbar popup does.
      const privatePopup = await context.newPage();
      await privatePopup.goto(base + `popup.html#${privateId}`);
      await privatePopup.locator('#ipinfo_status', {hasText: 'incognito'}).waitFor();
      assert.equal(await worker.evaluate(() => qaCalls.length), 2);
      await privatePopup.close();
      report.checks.push('Popup for an actual incognito target tab issues zero API requests');
    } finally { await privateContext.close(); }

    // Force an IP change while its response is pending; old metadata must not
    // overwrite the newer row. This also exercises pushOne/minimalCopy.
    await worker.evaluate(id => {
      const previous = ipinfoService._fetch;
      ipinfoService._fetch = async url => {
        if (url.endsWith('/8.8.4.4')) {
          await new Promise(resolve => { globalThis.qaRelease = resolve; });
          return new Response(JSON.stringify({ip: '8.8.4.4', asn: 'AS999', as_name: 'Stale Network', country_code: 'ZZ'}));
        }
        return previous(url);
      };
      tabMap[id].addDomain('race.test', DFLAG_H1, '8.8.4.4', 0);
    }, tabId);
    await waitFor(() => worker.evaluate(() => typeof qaRelease === 'function'), 'Delayed lookup not started');
    await worker.evaluate(id => { tabMap[id].addDomain('race.test', DFLAG_H1, '8.8.8.8', 0); }, tabId);
    await popup.locator('tr').filter({hasText: 'race.test'}).locator('.asnTd', {hasText: 'AS15169'}).waitFor();
    await worker.evaluate(() => qaRelease());
    await waitFor(() => worker.evaluate(() => ipinfoService._active === 0), 'Delayed lookup did not complete');
    assert.equal(await popup.locator('tr').filter({hasText: 'race.test'}).locator('.asnTd').innerText(), 'AS15169');
    assert.equal(await popup.locator('tr').filter({hasText: 'race.test'}).locator('.orgTd').innerText(), 'Fixture Network');
    assert.equal(await popup.locator('tr').filter({hasText: 'race.test'}).locator('.orgTd').getAttribute('title'), 'Fixture Network');
    await waitFor(() => popup.locator('tr').filter({hasText: 'race.test'}).locator('img.countryFlag').evaluateAll(images => images.length === 1 && /\/us\.svg$/i.test(images[0].src) && images[0].complete && images[0].naturalWidth > 0), 'Late response replaced or removed the current country flag');
    report.checks.push('Late response cannot overwrite metadata after the row IP changes');
    await worker.evaluate(id => {
      tabMap[id].domains['race.test'].flags |= AFLAG_CACHE;
      tabMap[id].pushOne('race.test');
    }, tabId);
    await popup.locator('tr').filter({hasText: 'race.test'}).locator('.cacheTd img').waitFor();
    assert.equal(await popup.locator('tr').filter({hasText: 'race.test'}).locator('.orgTd').innerText(), 'Fixture Network', 'Same-IP connection update discarded organization');

    await popup.close();
    const workerControl = await context.newCDPSession(settings);
    await workerControl.send('ServiceWorker.enable');
    await workerControl.send('ServiceWorker.stopAllWorkers');
    const restored = await settings.evaluate(() => chrome.runtime.sendMessage({ipinfo: {action: 'getStatus'}}));
    assert.equal(restored.configured, true);
    worker = context.serviceWorkers().find(item => item.url().includes(id)) ||
      await context.waitForEvent('serviceworker', {timeout: 15000});
    await worker.evaluate(async () => {
      await ipinfoService.ready;
      globalThis.qaOriginalFetch = ipinfoService._fetch;
      globalThis.qaCalls = [];
      ipinfoService._fetch = async url => { qaCalls.push(url); throw new Error('Unexpected cache miss after worker restart'); };
    });
    popup = await context.newPage();
    await popup.goto(base + `popup.html#${tabId}`);
    await waitFor(async () => await popup.locator('.asnTd', {hasText: 'AS15169'}).count() === 5, 'Persistent cache did not survive actual service-worker restart');
    assert.equal(await worker.evaluate(() => qaCalls.length), 0);
    report.checks.push('Actual MV3 worker stop/restart restores settings and successful cache without network');

    // Simulate an incognito-marked captured tab at the bridge boundary. The
    // separate bridge unit tests also verify sender.tab and actual tab flags.
    const incognito = await worker.evaluate(async () => ipinfoService.lookup('9.9.9.9', {incognito: true}));
    assert.equal(incognito.status, 'incognito');
    await settings.locator('#ipinfo-clear').click();
    await settings.locator('#ipinfo-status', {hasText: 'Token removed.'}).waitFor();
    assert.equal(await settings.locator('#ipinfo-token').inputValue(), '');
    await waitFor(async () => await popup.locator('.asnTd', {hasText: 'AS15169'}).count() === 0, 'Clearing token did not refresh existing popup');
    assert.equal(await popup.locator('img.countryFlag').count(), 0, 'Clearing metadata left stale country flags');
    assert.equal(await popup.locator('.orgTd', {hasText: 'Fixture Network'}).count(), 0, 'Clearing token left stale organization names');
    report.checks.push('Clear token disables lookup and refreshes open popup; incognito lookup blocked');

    if (liveToken) {
      await popup.close();
      await worker.evaluate(async id => {
        ipinfoService._fetch = qaOriginalFetch;
        await ipinfoService.clearCache();
        tabMap[id].domains = newMap();
        tabMap[id].addDomain('google-dns-v4.test', DFLAG_H1, '8.8.8.8', 0);
        tabMap[id].addDomain('google-dns-v6.test', DFLAG_H1, '2001:4860:4860::8888', 0);
      }, tabId);
      await settings.locator('#ipinfo-token').fill(liveToken);
      await settings.locator('#ipinfo-test').click();
      await settings.locator('#ipinfo-status', {hasText: 'Connection successful:'}).waitFor({timeout: 15000});
      assert.equal(await worker.evaluate(() => ipinfoService.getStatus().configured), false);
      await settings.locator('#ipinfo-enabled').check();
      await settings.locator('#ipinfo-save').click();
      await settings.locator('#ipinfo-status', {hasText: 'Saved.'}).waitFor();
      popup = await context.newPage();
      await popup.goto(base + `popup.html#${tabId}`);
      await waitFor(async () => await popup.locator('.asnTd', {hasText: 'AS15169'}).count() === 2, 'Live IPv4/IPv6 lookup failed');
      report.live = await popup.locator('#addr_table tr').evaluateAll(rows => rows.filter(row => row.querySelector('.asnTd').textContent !== '—').map(row => ({
        ip: row.querySelector('.addrTd').textContent, country: row.querySelector('.countryTd').textContent,
        asn: row.querySelector('.asnTd').textContent, organization: row.querySelector('.asnTd').title,
      })));
      report.checks.push('Real IPinfo: unsaved-token test plus popup IPv4/IPv6 metadata');
      await target.goto('https://example.com/', {waitUntil: 'domcontentloaded', timeout: 20000});
      await waitFor(async () => {
        const row = popup.locator('#addr_table tr').filter({hasText: 'example.com'});
        return await row.count() > 0 && /^AS[0-9]+$/.test(await row.first().locator('.asnTd').innerText());
      }, 'Actual public website connection was not enriched after navigation');
      report.publicCapture = await popup.locator('#addr_table tr').filter({hasText: 'example.com'}).first().evaluate(row => ({
        ip: row.querySelector('.addrTd').textContent,
        country: row.querySelector('.countryTd').textContent,
        asn: row.querySelector('.asnTd').textContent,
      }));
      assert.equal(await popup.locator('#addr_table tr').filter({hasText: 'google-dns-'}).count(), 0);
      assert.equal(await popup.locator('#addr_table tr').filter({hasText: 'api.ipinfo.io'}).count(), 0);
      report.checks.push('Actual public example.com capture enriched after navigation; stale rows and API traffic absent');
      await settings.locator('#ipinfo-clear').click();
      await settings.locator('#ipinfo-status', {hasText: 'Token removed.'}).waitFor();
    } else report.live = 'Skipped: set IPINFO_TEST_TOKEN for live verification';
    assert.equal(errors.length, 0, 'Extension page JavaScript errors occurred');
    report.checks.push('No extension page JavaScript errors');
    return report;
  } catch (error) {
    const diagnostics = {pageErrors: errors};
    diagnostics.state = worker ? await worker.evaluate(() => ({status: ipinfoService.getStatus(), calls: globalThis.qaCalls})).catch(() => null) : null;
    const visiblePopup = context.pages().find(page => page.url().includes('/popup.html#'));
    if (visiblePopup) diagnostics.rows = await visiblePopup.locator('#addr_table tr').evaluateAll(rows => rows.map(row => ({text: row.innerText, title: row.querySelector('.countryTd')?.title}))).catch(() => null);
    console.error(JSON.stringify(diagnostics, null, 2));
    throw error;
  } finally {
    if (worker) await worker.evaluate(async () => {
      await ipinfoService.configure({enabled: false, token: ''});
      await ipinfoService.clearCache();
      await chrome.storage.local.remove(['ipinfoSettings', 'ipinfo.cache.v1', 'ipinfo.state.v1']);
    }).catch(() => {});
    await context.close();
  }
}

(async () => {
  await fs.mkdir(output, {recursive: true});
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {'Content-Type': 'text/html'});
    response.end('<!doctype html><title>IPvFoo integration fixture</title><h1>Local capture fixture</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const results = [];
  try {
    for (const [name, launchOptions] of browsers) {
      const report = await runBrowser(name, launchOptions, `http://127.0.0.1:${server.address().port}/${name}`);
      results.push(report);
      console.log(`${name}: ${report.checks.length} integration checks passed; live API ${liveToken ? 'passed' : 'skipped'}`);
    }
    await fs.writeFile(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2) + '\n');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => {
  const safe = liveToken ? String(error.stack || error).split(liveToken).join('[redacted]') : String(error.stack || error);
  console.error(safe);
  process.exitCode = 1;
});
