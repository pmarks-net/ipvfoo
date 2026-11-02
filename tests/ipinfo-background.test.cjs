"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../src/ipinfo-background.js"), "utf8");
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const extensionURL = page => `chrome-extension://${extensionId}/${page}`;
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));

function makeHarness({serviceReady = Promise.resolve(), storageReady = Promise.resolve(),
  tabs = {7: {id: 7, incognito: false}}, incognitoContext = false,
  domains = {"dns.example": {addr: "8.8.8.8"}}, methods = {}} = {}) {
  const calls = [];
  const tabCalls = [];
  const accessCalls = [];
  const logCalls = [];
  const nat64Prefixes = new Set(["0064ff9b0000000000000000"]);
  const storage = {setAccessLevel(value) { accessCalls.push(value); return Promise.resolve(); }};
  let listener;
  const results = {
    getStatus: {enabled: true, configured: true, authError: false, retryAt: 0},
    getSettings: {enabled: true, token: "fixture-token"},
    configure: {ok: true},
    lookup: {status: "ok", ip: "8.8.8.8", asn: "AS15169"},
    testToken: {status: "ok", ip: "8.8.8.8"},
    clearCache: undefined,
  };
  class MockService {
    constructor(args) {
      assert.equal(args.storage, storage);
      this.ready = serviceReady;
    }
  }
  for (const method of Object.keys(results)) {
    MockService.prototype[method] = function(...args) {
      calls.push({method, args});
      return methods[method] ? methods[method](...args) : results[method];
    };
  }
  const context = vm.createContext({
    URL,
    IpinfoService: MockService,
    storageReady,
    tabMap: {7: {domains}},
    NAT64_KEY: "nat64/",
    options: {"nat64/": nat64Prefixes},
    console: {error: (...args) => logCalls.push(args), log: (...args) => logCalls.push(args)},
    chrome: {
      runtime: {
        id: extensionId,
        getURL: extensionURL,
        onMessage: {addListener(callback) { listener = callback; }},
      },
      extension: {inIncognitoContext: incognitoContext},
      storage: {local: storage},
      tabs: {async get(tabId) {
        tabCalls.push(tabId);
        if (!Object.hasOwn(tabs, tabId)) throw new Error("fixture-token: tab missing");
        return tabs[tabId];
      }},
    },
  });
  vm.runInContext(source, context, {filename: "ipinfo-background.js"});
  const optionsSender = {id: extensionId, url: extensionURL("options.html")};
  const popupSender = {id: extensionId, url: extensionURL("popup.html#7")};
  function dispatchMessage(message, sender = popupSender) {
    let resolveResponse;
    const response = new Promise(resolve => { resolveResponse = resolve; });
    const responses = [];
    const keepAlive = listener(message, sender, value => {
      responses.push(plain(value));
      resolveResponse(plain(value));
    });
    return {keepAlive, response, responses};
  }
  async function send(request, sender = popupSender) {
    const dispatch = dispatchMessage({ipinfo: request}, sender);
    assert.equal(dispatch.keepAlive, true, "async bridge must keep sendResponse alive");
    return dispatch.response;
  }
  return {calls, tabCalls, accessCalls, logCalls, nat64Prefixes, optionsSender, popupSender,
    dispatchMessage, send};
}

test("only options receives stored credentials or changes settings", async () => {
  const h = makeHarness();
  assert.deepEqual(await h.send({action: "getSettings"}, h.optionsSender),
    {enabled: true, token: "fixture-token"});
  assert.deepEqual(await h.send({action: "saveSettings", enabled: true, token: "new-fixture"}, h.optionsSender),
    {ok: true});
  assert.deepEqual(await h.send({action: "clearToken"}, h.optionsSender), {ok: true});
  assert.deepEqual(h.calls.map(call => ({method: call.method, args: plain(call.args)})), [
    {method: "getSettings", args: []},
    {method: "configure", args: [{enabled: true, token: "new-fixture"}]},
    {method: "configure", args: [{enabled: false, token: ""}]},
  ]);
  const before = h.calls.length;
  for (const action of ["getSettings", "saveSettings", "clearToken", "testToken", "clearCache"]) {
    assert.deepEqual(await h.send({action, enabled: true, token: "fixture-token"}), {status: "error"});
  }
  assert.equal(h.calls.length, before, "popup cannot reach options-only service methods");
});

test("public status is safe and available to both owned surfaces", async () => {
  const h = makeHarness();
  for (const sender of [h.optionsSender, h.popupSender]) {
    const result = await h.send({action: "getStatus"}, sender);
    assert.deepEqual(result, {enabled: true, configured: true, authError: false, retryAt: 0});
    assert.equal(Object.hasOwn(result, "token"), false);
  }
  assert.deepEqual(plain(h.accessCalls), [{accessLevel: "TRUSTED_CONTEXTS"}]);
});

test("foreign extension, website, other extension page and missing sender are rejected", async () => {
  const h = makeHarness();
  const senders = [
    {id: "another-extension", url: extensionURL("options.html")},
    {id: extensionId, url: "https://example.com/options.html"},
    {id: extensionId, url: extensionURL("background.html")},
    {id: extensionId, url: extensionURL("options.html.extra")},
    {id: extensionId, url: "chrome-extension://another/options.html"},
    {id: extensionId},
    {},
    null,
  ];
  for (const sender of senders) {
    assert.deepEqual(await h.send({action: "getSettings"}, sender), {status: "error"});
  }
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.tabCalls, []);
});

test("popup cannot spoof another tab id or use an absent/noncanonical hash", async () => {
  const h = makeHarness({tabs: {7: {id: 7}, 8: {id: 8}}});
  const requests = [
    [{action: "lookup", tabId: 8, address: "8.8.8.8"}, h.popupSender],
    [{action: "lookup", tabId: "7", address: "8.8.8.8"}, h.popupSender],
    [{action: "lookup", tabId: -1, address: "8.8.8.8"}, h.popupSender],
    [{action: "lookup", tabId: 7.1, address: "8.8.8.8"}, h.popupSender],
    [{action: "lookup", tabId: 7, address: "8.8.8.8"}, {...h.popupSender, url: extensionURL("popup.html")}],
    [{action: "lookup", tabId: 7, address: "8.8.8.8"}, {...h.popupSender, url: extensionURL("popup.html#07")}],
    [{action: "lookup", tabId: 7, address: "8.8.8.8"}, h.optionsSender],
    [{action: "lookup", tabId: 7, address: null}, h.popupSender],
  ];
  for (const [request, sender] of requests) {
    assert.deepEqual(await h.send(request, sender), {status: "invalid"});
  }
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.tabCalls, []);
});

test("lookup requires the exact address currently captured for the popup tab", async () => {
  const h = makeHarness();
  assert.deepEqual(await h.send({action: "lookup", tabId: 7, address: "1.1.1.1"}), {status: "invalid"});
  assert.deepEqual(h.calls, []);
  assert.deepEqual(await h.send({action: "lookup", tabId: 7, address: "8.8.8.8"}),
    {status: "ok", ip: "8.8.8.8", asn: "AS15169"});
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, "lookup");
  assert.equal(h.calls[0].args[0], "8.8.8.8");
  assert.equal(h.calls[0].args[1].nat64Prefixes, h.nat64Prefixes);
  const noCapture = makeHarness({domains: {}});
  assert.deepEqual(await noCapture.send({action: "lookup", tabId: 7, address: "8.8.8.8"}),
    {status: "invalid"});
  assert.deepEqual(noCapture.calls, []);
});

test("incognito tab, sender tab and extension context prevent service lookup", async () => {
  for (const settings of [
    {tabs: {7: {id: 7, incognito: true}}},
    {incognitoContext: true},
    {},
  ]) {
    const h = makeHarness(settings);
    const sender = Object.keys(settings).length ? h.popupSender :
      {...h.popupSender, tab: {id: 99, incognito: true}};
    assert.deepEqual(await h.send({action: "lookup", tabId: 7, address: "8.8.8.8"}, sender),
      {status: "incognito"});
    assert.deepEqual(h.calls, []);
  }
});

test("incognito options cannot make a test-token network request", async () => {
  for (const inIncognitoContext of [false, true]) {
    const h = makeHarness({incognitoContext: inIncognitoContext});
    const sender = inIncognitoContext ? h.optionsSender :
      {...h.optionsSender, tab: {incognito: true}};
    assert.deepEqual(await h.send({action: "testToken", token: "fixture-token"}, sender),
      {status: "incognito"});
    assert.deepEqual(h.calls, []);
  }
});

test("valid options test and clear-cache actions reach only intended methods", async () => {
  const h = makeHarness();
  assert.deepEqual(await h.send({action: "testToken", token: "fixture-token"}, h.optionsSender),
    {status: "ok", ip: "8.8.8.8"});
  assert.deepEqual(await h.send({action: "clearCache"}, h.optionsSender), {ok: true});
  assert.deepEqual(h.calls.map(call => ({method: call.method, args: plain(call.args)})), [
    {method: "testToken", args: ["fixture-token"]},
    {method: "clearCache", args: []},
  ]);
});

test("invalid settings/token payloads and unsupported actions cannot reach service", async () => {
  const h = makeHarness();
  for (const request of [
    {action: "saveSettings", enabled: "true", token: "fixture-token"},
    {action: "saveSettings", enabled: true, token: null},
    {action: "saveSettings", enabled: true, token: "x".repeat(4097)},
    {action: "testToken", token: null},
    {action: "testToken", token: "x".repeat(4097)},
    {action: "fetch", url: "https://example.com"},
    {action: "testTokenThenFetch"},
    {},
  ]) {
    const result = await h.send(request, h.optionsSender);
    assert.ok(["error", "unconfigured"].includes(result.status));
  }
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.tabCalls, []);
});

test("non-IPinfo messages are ignored without taking over other background handlers", async () => {
  const h = makeHarness();
  for (const message of [undefined, null, {}, {other: "request"}, {ipinfo: null}, {ipinfo: "lookup"}]) {
    const result = h.dispatchMessage(message);
    assert.equal(result.keepAlive, undefined);
    await flush();
    assert.deepEqual(result.responses, []);
  }
  assert.deepEqual(h.calls, []);
});

test("async bridge waits for service and original background state before lookup", async () => {
  let serviceResolve;
  let storageResolve;
  const h = makeHarness({
    serviceReady: new Promise(resolve => { serviceResolve = resolve; }),
    storageReady: new Promise(resolve => { storageResolve = resolve; }),
  });
  const dispatch = h.dispatchMessage({ipinfo: {action: "lookup", tabId: 7, address: "8.8.8.8"}});
  assert.equal(dispatch.keepAlive, true);
  await flush();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.tabCalls, []);
  serviceResolve();
  await flush();
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.tabCalls, []);
  storageResolve();
  assert.deepEqual(await dispatch.response, {status: "ok", ip: "8.8.8.8", asn: "AS15169"});
  assert.equal(dispatch.responses.length, 1);
});

test("thrown and rejected errors are sanitized without logging token-bearing details", async () => {
  const scenarios = [
    [makeHarness({tabs: {}}), {action: "lookup", tabId: 7, address: "8.8.8.8"}, "popupSender"],
    [makeHarness({methods: {lookup() { throw new Error("fixture-token-sensitive"); }}}),
      {action: "lookup", tabId: 7, address: "8.8.8.8"}, "popupSender"],
    [makeHarness({methods: {configure() { return Promise.reject(new Error("fixture-token-sensitive")); }}}),
      {action: "saveSettings", enabled: true, token: "fixture-token"}, "optionsSender"],
    [makeHarness({methods: {testToken() { return Promise.reject(new Error("fixture-token-sensitive")); }}}),
      {action: "testToken", token: "fixture-token"}, "optionsSender"],
  ];
  for (const [h, request, surface] of scenarios) {
    const dispatch = h.dispatchMessage({ipinfo: request}, h[surface]);
    assert.equal(dispatch.keepAlive, true);
    assert.deepEqual(await dispatch.response, {status: "error"});
    await flush();
    assert.equal(dispatch.responses.length, 1);
    assert.deepEqual(h.logCalls, []);
    assert.equal(JSON.stringify(dispatch.responses).includes("fixture-token"), false);
  }
  const malformed = makeHarness();
  assert.deepEqual(await malformed.send({action: "getSettings"}, {id: extensionId, url: ":invalid"}),
    {status: "error"});
  assert.deepEqual(malformed.calls, []);
  assert.deepEqual(malformed.logCalls, []);
});
