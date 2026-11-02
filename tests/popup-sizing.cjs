// Exercise adaptive sizing in the actual action widget, never popup.html in a tab.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'validation');
// Use the same browser selection as browser-integration.cjs. Channels resolve
// installed browsers across platforms; explicit executable overrides are optional.
const browsers = (process.env.IPVFOO_TEST_BROWSERS || 'chromium').split(',').map(value => {
  const name = value.trim();
  if (!['chromium', 'chrome', 'edge'].includes(name)) {
    throw new Error(`Unsupported IPVFOO_TEST_BROWSERS entry: ${name}`);
  }
  const channel = name === 'edge' ? 'msedge' : name;
  const executablePath = process.env[`IPVFOO_${name.toUpperCase()}_PATH`];
  return [name, executablePath ? {executablePath} : {channel}];
});
const waitFor = async (fn, message) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
};
const shortRows = [['a.test', '8.8.8.8'], ['b.test', '1.1.1.1']];
const mixedRows = [
  ['www.google.com', '2001:4860:4829:7700::'],
  ['accounts.google.com', '2404:6800:4001:c01::54'],
  ['fonts.gstatic.com', '142.250.4.94'],
  ['lh3.googleusercontent.com', '172.217.194.132'],
];
const longDomain = Array.from({length: 4}, (_, i) => `segment${i}-` + 'x'.repeat(40)).join('.') + '.example.test';
const longestIPv6 = '2001:4860:1234:5678:abcd:ef01:2345:6789';
const longOrganization = 'Fixture Network International Services and Infrastructure Organization';

async function attachPopupTarget(cdp, targetId) {
  const {sessionId} = await cdp.send('Target.attachToTarget', {targetId, flatten: false});
  let nextId = 1;
  const pending = new Map();
  cdp.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (!message.id || !pending.has(message.id)) return;
    const {resolve, reject, timer} = pending.get(message.id);
    clearTimeout(timer);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Popup CDP timed out: ${method}`)); }, 10000);
    pending.set(id, {resolve, reject, timer});
    cdp.send('Target.sendMessageToTarget', {sessionId, message: JSON.stringify({id, method, params})})
      .catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
  });
}

async function checkBrowser(name, launchOptions, url, scale) {
  const context = await chromium.launchPersistentContext('', {
    ...launchOptions, headless: process.env.IPVFOO_TEST_HEADED !== '1', viewport: null,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--window-size=1280,900', `--force-device-scale-factor=${scale}`],
  });
  const variant = `${name}-adaptive-${scale}x`;
  const stages = {};
  let popup;
  let evaluate;
  const capture = async stage => {
    await new Promise(resolve => setTimeout(resolve, 250));
    const metrics = await evaluate(`(() => ({
      innerWidth, innerHeight, devicePixelRatio,
      bodyWidth: document.body.getBoundingClientRect().width,
      scrollWidth: document.documentElement.scrollWidth,
      tableWidth: document.querySelector('table').getBoundingClientRect().width,
      tableBackground: getComputedStyle(document.querySelector('table')).backgroundImage,
      headers: Array.from(document.querySelectorAll('th'), th => ({text: th.textContent, width: th.getBoundingClientRect().width,
        background: getComputedStyle(th).backgroundImage})),
      rows: Array.from(document.querySelectorAll('#addr_table tr'), tr => {
        const td = tr.querySelector('.addrTd');
        const span = td.querySelector('.selectMe');
        const rect = span.getBoundingClientRect();
        const ellipsis = span.querySelector('.addressEllipsis img.snipImg');
        const org = tr.querySelector('.orgTd');
        const orgName = org?.querySelector('.orgName');
        return {height: tr.getBoundingClientRect().height, domain: tr.querySelector('.domainTd').textContent,
          address: td.textContent, ipCellWidth: td.getBoundingClientRect().width,
          ipTextWidth: rect.width, ipTextHeight: rect.height,
          addressTitle: span.title, compact: span.classList.contains('compactAddress'), expanded: span.classList.contains('is-expanded'),
          ellipsis: ellipsis ? {src: ellipsis.src, loaded: ellipsis.complete && ellipsis.naturalWidth > 0,
            width: ellipsis.getBoundingClientRect().width, height: ellipsis.getBoundingClientRect().height} : null,
          columns: Array.from(tr.children, td => td.classList[0]),
          country: tr.querySelector('.countryTd').textContent, asn: tr.querySelector('.asnTd').textContent,
          organization: org?.textContent, organizationTitle: org?.title,
          orgTextWidth: orgName?.getBoundingClientRect().width, orgScrollWidth: orgName?.scrollWidth,
          flags: Array.from(tr.querySelectorAll('img.countryFlag'), img => ({
            src: img.src, loaded: img.complete && img.naturalWidth > 0,
            width: img.getBoundingClientRect().width, height: img.getBoundingClientRect().height,
          }))};
      })
    }))()`);
    stages[stage] = metrics;
    const screenshot = await popup('Page.captureScreenshot', {format: 'png'});
    await fs.writeFile(path.join(output, `${variant}-${stage}-toolbar-popup.png`), Buffer.from(screenshot.data, 'base64'));
    console.log(`${variant}/${stage}: ${metrics.innerWidth}x${metrics.innerHeight} CSS px`);
    assert.equal(metrics.devicePixelRatio, scale, 'Requested native scale was not applied');
    assert.ok(metrics.innerWidth > 0 && metrics.innerWidth <= 780, `Popup width ${metrics.innerWidth}px is invalid or exceeds its cap`);
    assert.ok(metrics.scrollWidth <= metrics.innerWidth + 1, `Horizontal overflow: ${metrics.scrollWidth} > ${metrics.innerWidth}`);
    assert.ok(metrics.tableWidth <= metrics.innerWidth, 'Table escaped popup bounds');
    assert.equal(metrics.tableBackground, 'none', 'Domain lock separator spans the table header');
    assert.ok(metrics.headers.every(header => header.background === 'none'), 'Header has an icon separator background');
    assert.deepEqual(metrics.headers.map(header => header.text), ['Domain', 'IP address', 'Organization', 'ASN', 'Country']);
    assert.ok(metrics.rows.every(row => row.columns.join(',') === 'domainTd,addrTd,cacheTd,orgTd,asnTd,countryTd'), 'Body columns do not match the header order');
    return metrics;
  };
  try {
    const cdp = await context.browser().newBrowserCDPSession();
    const {id} = await cdp.send('Extensions.loadUnpacked', {path: path.join(root, 'src')});
    const worker = context.serviceWorkers().find(item => item.url().includes(id)) ||
      await context.waitForEvent('serviceworker', {timeout: 15000});
    await worker.evaluate(async () => { await Promise.all([storageReady, ipinfoService.ready]); });
    const tab = await context.newPage();
    await tab.goto(url);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(item => item.url === url).id, url);
    await waitFor(() => worker.evaluate(id => !!tabMap[id]?.lastPattern, tabId), 'No browser action was configured');
    const replaceRows = async rows => {
      await worker.evaluate(({tabId, rows}) => {
        const info = tabMap[tabId];
        info.domains = newMap();
        info.mainDomain = rows[0][0];
        for (const [domain, ip] of rows) info.addDomain(domain, DFLAG_H1, ip, 0);
        info.pushAll();
      }, {tabId, rows});
      if (evaluate) await waitFor(() => evaluate(`document.querySelectorAll('#addr_table tr').length === ${rows.length}`), 'New popup rows did not arrive');
    };
    await replaceRows(shortRows);
    await tab.bringToFront();
    // triggerAction expects the outer tab target, not the inner page target.
    const {targetInfos: tabs} = await cdp.send('Target.getTargets', {filter: [{type: 'tab'}]});
    const targetInfo = tabs.find(info => info.url === url);
    assert.ok(targetInfo, 'Outer browser tab target not found');
    await cdp.send('Extensions.triggerAction', {id, targetId: targetInfo.targetId});
    const popupTarget = await waitFor(async () => {
      const {targetInfos} = await cdp.send('Target.getTargets');
      return targetInfos.find(info => info.url.startsWith(`chrome-extension://${id}/popup.html#`));
    }, 'Browser toolbar popup target did not appear');
    popup = await attachPopupTarget(cdp, popupTarget.targetId);
    evaluate = async expression => {
      const result = await popup('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value;
    };
    await waitFor(() => evaluate('document.querySelectorAll("#addr_table tr").length >= 2'), 'Popup rows did not arrive');
    const short = await capture('short-ipv4');
    assert.ok(short.innerWidth <= 600, 'Short IPv4 content unnecessarily opens a wide popup');
    assert.ok(short.rows.every(row => row.height <= 42), 'Short rows wrapped vertically');
    assert.ok(short.rows.every(row => row.ipTextHeight <= 20 && row.ipTextWidth <= row.ipCellWidth), 'Short IPv4 text is wrapped or clipped');
    await replaceRows(mixedRows);
    const mixed = await capture('mixed-ipv6');
    assert.ok(mixed.innerWidth >= short.innerWidth + 25, 'Popup does not grow with wider domain/IPv6 content');
    assert.ok(mixed.rows.every(row => row.height <= 42), 'Ordinary mixed rows wrapped excessively');
    await replaceRows([[longDomain, longestIPv6], ['short.test', '8.8.8.8']]);
    const longest = await capture('longest-ipv6');
    assert.equal(longest.rows[0].address, longestIPv6);
    assert.equal(longest.rows[0].addressTitle, longestIPv6);
    assert.ok(longest.rows[0].compact && longest.rows[0].ellipsis?.loaded, 'Long IPv6 lacks a loaded middle ellipsis icon');
    assert.equal(longest.rows[0].ellipsis.src, `chrome-extension://${id}/snip.png`);
    assert.equal(longest.rows[0].ellipsis.width, 15);
    assert.equal(longest.rows[0].ellipsis.height, 11);
    assert.ok(longest.rows[0].ipTextHeight <= 20, 'Compact native IPv6 is not displayed on a single line');
    assert.ok(longest.rows[0].ipTextWidth <= 152 && longest.rows[0].ipTextWidth <= longest.rows[0].ipCellWidth, 'Compact native IPv6 is too wide');
    assert.equal(await evaluate(`(() => {
      const td = document.querySelector('.addrTd');
      getSelection().removeAllRanges();
      selectAddress(td, td, getSelection());
      const text = getSelection().toString(); getSelection().removeAllRanges(); return text;
    })()`), longestIPv6, 'Compact display changed the full copied address');
    await evaluate('document.querySelector(".snipLinkVisible").click()');
    const expanded = await capture('expanded-domain');
    assert.equal(expanded.rows[0].domain, longDomain, 'Expanded domain lost text');
    assert.ok(expanded.rows[0].height < 170, 'Expanded domain wrapped into an excessively tall column');
    // Hold responses so sizing is checked before and after populated long ASNs.
    await worker.evaluate(async asName => {
      globalThis.qaMetadataReleases = [];
      ipinfoService._fetch = async url => {
        const ip = decodeURIComponent(url.split('/').pop());
        await new Promise(resolve => qaMetadataReleases.push(resolve));
        return new Response(JSON.stringify({ip, asn: 'AS4294967295', as_name: asName, country_code: 'NZ', country: 'New Zealand'}));
      };
      await ipinfoService.configure({enabled: true, token: 'fixture-not-a-real-token'});
    }, longOrganization);
    await waitFor(() => worker.evaluate(() => qaMetadataReleases.length === 2), 'Delayed metadata requests did not start');
    const pending = await capture('metadata-pending');
    assert.ok(pending.rows.every(row => row.flags.length === 0), 'Pending metadata retained country flags');
    assert.ok(pending.rows.every(row => row.organization === '—'), 'Pending metadata retained an old organization');
    await worker.evaluate(() => qaMetadataReleases.splice(0).forEach(resolve => resolve()));
    await waitFor(() => evaluate('Array.from(document.querySelectorAll(".asnTd")).every(td => td.textContent === "AS4294967295")'), 'Metadata never populated');
    await waitFor(() => evaluate('document.querySelectorAll("img.countryFlag").length === 2 && Array.from(document.querySelectorAll("img.countryFlag")).every(img => img.complete && img.naturalWidth > 0)'), 'Toolbar flags failed to load');
    const populated = await capture('metadata-populated');
    assert.ok(populated.rows.every(row => row.country === 'NZ'), 'Country data not visible');
    assert.ok(populated.rows[0].ipTextHeight <= 20, 'Async metadata caused compact native IPv6 to wrap');
    assert.ok(populated.rows.every(row => row.organization === longOrganization && row.organizationTitle === longOrganization), 'Organization text or full tooltip is missing');
    assert.ok(populated.rows.every(row => row.orgTextWidth > 0 && row.orgTextWidth <= 150 && row.orgScrollWidth > row.orgTextWidth), 'Long organization is not visibly bounded and truncated');
    assert.ok(populated.rows.every(row => row.flags.length === 1 && row.flags[0].loaded && row.flags[0].width === 20 && row.flags[0].height === 15), 'Toolbar flag dimensions/loading incorrect');
    for (const row of populated.rows) {
      const source = new URL(row.flags[0].src);
      assert.equal(source.protocol, 'chrome-extension:');
      assert.equal(source.hostname, id);
      assert.match(source.pathname, /\/nz\.svg$/i);
    }
    // Combine the longest visible domain, a wide mixed-format IPv6 address,
    // a cached-state icon, a long special-purpose label and a populated ASN.
    // Both IPv6 forms remain compact, with complete copyable addresses.
    const mixedFormatIPv6 = '2001:db8:1234:5678:abcd:ef01:192.168.100.200';
    await replaceRows([[longDomain, longestIPv6], ['documentation.test', mixedFormatIPv6]]);
    await worker.evaluate(id => {
      tabMap[id].domains['documentation.test'].flags |= AFLAG_CACHE;
      tabMap[id].pushOne('documentation.test');
    }, tabId);
    await waitFor(() => evaluate('Array.from(document.querySelectorAll(".countryTd")).some(td => td.textContent === "Documentation")'), 'Documentation metadata did not arrive');
    const widest = await capture('widest-cells');
    assert.equal(widest.rows[0].address, longestIPv6);
    assert.equal(widest.rows[1].address, mixedFormatIPv6);
    assert.ok(widest.rows.every(row => row.ipTextWidth <= row.ipCellWidth && row.ipTextHeight <= 20), 'Compact IP text escaped its cell or wrapped');
    assert.equal(widest.rows[0].flags.length, 1);
    assert.equal(widest.rows[1].flags.length, 0);
    assert.equal(widest.rows[0].organization, longOrganization);
    assert.equal(widest.rows[1].organization, '—');
    await evaluate('document.querySelector(".addressEllipsis").click()');
    const expandedAddress = await capture('expanded-ipv6');
    assert.ok(expandedAddress.rows[0].expanded, 'Clicking the IPv6 ellipsis did not expand it');
    assert.equal(expandedAddress.rows[0].address, longestIPv6);
    assert.ok(expandedAddress.rows[0].ipTextWidth <= expandedAddress.rows[0].ipCellWidth, 'Expanded IPv6 escaped its cell');
    await worker.evaluate(() => ipinfoService.configure({enabled: false, token: ''}));
    await replaceRows(shortRows);
    const shrunk = await capture('short-again');
    assert.ok(shrunk.rows.every(row => row.flags.length === 0), 'Disabled metadata left stale toolbar flags');
    assert.ok(shrunk.rows.every(row => row.organization === '—'), 'Disabled metadata left stale organization names');
    assert.ok(shrunk.innerWidth <= 600 && shrunk.innerWidth < mixed.innerWidth, 'Popup does not shrink again for short IPv4 content');
    return {browser: name, variant, version: context.browser().version(), targetType: popupTarget.type, stages};
  } catch (error) {
    await fs.writeFile(path.join(output, `${variant}-failure.json`), JSON.stringify(stages, null, 2) + '\n');
    throw error;
  } finally { await context.close(); }
}

(async () => {
  await fs.mkdir(output, {recursive: true});
  const server = http.createServer((_request, response) => {
    response.writeHead(200, {'Content-Type': 'text/html'});
    response.end('<!doctype html><link rel="icon" href="data:,"><title>Toolbar popup sizing test</title><h1>Fixture</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const results = [];
  try {
    for (const [name, launchOptions] of browsers) {
      for (const scale of [1, 2]) {
        results.push(await checkBrowser(name, launchOptions, `http://127.0.0.1:${server.address().port}/${name}-${scale}`, scale));
      }
    }
    await fs.writeFile(path.join(output, 'popup-sizing-results.json'), JSON.stringify(results, null, 2) + '\n');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
