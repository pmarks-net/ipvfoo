"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = vm.createContext({AbortController, setTimeout, clearTimeout, fetch});
for (const file of ["iputil.js", "ipinfo-address.js", "ipinfo-service.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context, {filename: file});
}
const IpinfoService = vm.runInContext("IpinfoService", context);
const copy = value => JSON.parse(JSON.stringify(value));
const startTime = 1700000000000;

function memoryStorage(seed = {}) {
  const data = copy(seed);
  return {
    data,
    writes: [],
    async get(keys) {
      return copy(Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]])));
    },
    async set(values) {
      this.writes.push(copy(values));
      Object.assign(data, copy(values));
    },
    async remove(keys) { for (const key of keys) delete data[key]; },
  };
}

function record(ip) {
  return {ip, country_code: "US", country: "United States", asn: "AS15169", as_name: "Google LLC"};
}

function response(ip, status = 200, body = record(ip), headers = {}) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: {get(name) { return headers[name.toLowerCase()] ?? null; }},
    async json() { return body; },
  };
}

function harness({storage = memoryStorage(), fetcher, time = startTime} = {}) {
  let now = time;
  let timerId = 0;
  const timers = new Map();
  const calls = [];
  const service = new IpinfoService({
    storage,
    now: () => now,
    setTimeoutFn(callback, delay) {
      const id = ++timerId;
      timers.set(id, {callback, due: now + delay});
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    fetchFn: async (url, options) => {
      const ip = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      calls.push({url, options, ip});
      return fetcher ? fetcher(ip, options, calls.length) : response(ip);
    },
  });
  return {
    service, storage, calls, timers,
    async enable(token = "test-credential") {
      await service.ready;
      await service.configure({enabled: true, token});
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    now: () => now,
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test("disabled, empty token, private window and local/special/invalid addresses never fetch", async () => {
  const h = harness();
  await h.service.ready;
  assert.deepEqual(copy(h.service.getSettings()), {enabled: false, token: ""});
  assert.equal((await h.service.lookup("8.8.8.8")).status, "disabled");
  await h.service.configure({enabled: true, token: "   "});
  assert.equal((await h.service.lookup("8.8.8.8")).status, "unconfigured");
  await h.enable();
  for (const ip of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "100.64.0.1", "127.0.0.1",
    "169.254.1.1", "::", "::1", "fc00::1", "fe80::1", "ff02::1", "192.0.2.1", "2001:db8::1",
    "::ffff:192.168.1.1", "64:ff9b::a00:1", "", "(no address)", "garbage"]) {
    assert.notEqual((await h.service.lookup(ip)).status, "ok", ip);
  }
  assert.equal((await h.service.lookup("8.8.8.8", {incognito: true})).status, "incognito");
  assert.equal(h.calls.length, 0);
});

test("Lite request uses explicit target, Bearer header, no cookies, redirects or referrer", async () => {
  const h = harness();
  await h.enable("  test-credential  ");
  const result = await h.service.lookup("8.8.8.8");
  assert.deepEqual(copy(result), {
    status: "ok", ip: "8.8.8.8", countryCode: "US", country: "United States",
    asn: "AS15169", asName: "Google LLC",
  });
  const call = h.calls[0];
  assert.equal(call.url, "https://api.ipinfo.io/lite/8.8.8.8");
  assert.equal(call.options.headers.Authorization, "Bearer test-credential");
  assert.equal(call.options.credentials, "omit");
  assert.equal(call.options.referrerPolicy, "no-referrer");
  assert.equal(call.options.redirect, "error");
  assert.equal(call.options.cache, "no-store");
  assert.ok(!JSON.stringify(result).includes("credential"));
  assert.equal(h.timers.size, 0);
});

test("equivalent IPv6, mapped IPv4 and NAT64 share normalized requests and cache", async () => {
  const pending = [];
  const h = harness({fetcher: ip => new Promise(resolve => pending.push(() => resolve(response(ip))))});
  await h.enable();
  const lookups = [
    h.service.lookup("8.8.8.8"), h.service.lookup("::ffff:8.8.8.8"),
    h.service.lookup("64:ff9b::808:808"),
    h.service.lookup("2001:4860:4860::8888"),
    h.service.lookup("2001:4860:4860:0000:0000:0000:0000:8888"),
  ];
  await flush();
  assert.equal(h.calls.length, 2);
  pending.forEach(resolve => resolve());
  const results = await Promise.all(lookups);
  assert.ok(results.every(result => result.status === "ok"));
  assert.equal((await h.service.lookup("::ffff:8.8.8.8")).ip, "8.8.8.8");
  assert.equal(h.calls.length, 2);
});

test("successful cache survives worker restart and expires after 24 hours", async () => {
  const h = harness();
  await h.enable();
  await h.service.lookup("8.8.8.8");
  const restarted = harness({storage: h.storage});
  await restarted.service.ready;
  assert.equal((await restarted.service.lookup("8.8.8.8")).status, "ok");
  assert.equal(restarted.calls.length, 0);
  restarted.advance(86400000);
  await restarted.service.lookup("8.8.8.8");
  assert.equal(restarted.calls.length, 1);
});

test("success cache is bounded to 1000 and evicts the least recently used entry", async () => {
  const entries = Array.from({length: 1000}, (_, index) => {
    const ip = `8.8.${Math.floor(index / 256)}.${index % 256}`;
    return [ip, {expiresAt: startTime + 86400000, usedAt: startTime + index,
      result: {status: "ok", ip, countryCode: "US", country: "US", asn: "AS15169", asName: "Google"}}];
  });
  const h = harness({storage: memoryStorage({
    ipinfoSettings: {enabled: true, token: "test-credential"},
    "ipinfo.cache.v1": {version: 1, entries},
  }), time: startTime + 2000});
  await h.service.ready;
  await h.service.lookup("8.8.0.0"); // Makes the first entry the newest.
  await h.service.lookup("9.9.9.9");
  const saved = h.storage.data["ipinfo.cache.v1"].entries;
  assert.equal(saved.length, 1000);
  assert.ok(saved.some(([ip]) => ip === "8.8.0.0"));
  assert.ok(!saved.some(([ip]) => ip === "8.8.0.1"));
  assert.ok(saved.some(([ip]) => ip === "9.9.9.9"));
});

test("at most four HTTP requests run at once and queued requests eventually complete", async () => {
  const pending = [];
  let active = 0;
  let maximum = 0;
  const h = harness({fetcher: ip => new Promise(resolve => {
    maximum = Math.max(maximum, ++active);
    pending.push(() => { --active; resolve(response(ip)); });
  })});
  await h.enable();
  const promises = Array.from({length: 10}, (_, i) => h.service.lookup(`8.8.8.${i + 1}`));
  await flush();
  assert.equal(h.calls.length, 4);
  while (pending.length) {
    pending.splice(0).forEach(resolve => resolve());
    await flush();
  }
  assert.ok((await Promise.all(promises)).every(result => result.status === "ok"));
  assert.equal(maximum, 4);
  assert.equal(h.calls.length, 10);
});

test("disabling settles pending and active requests without waiting for fetch, and late responses cannot cache", async () => {
  const pending = [];
  const h = harness({fetcher: ip => new Promise(resolve => pending.push(() => resolve(response(ip))))});
  await h.enable();
  const promises = Array.from({length: 8}, (_, i) => h.service.lookup(`8.8.8.${i + 1}`));
  await flush();
  await h.service.configure({enabled: false, token: "test-credential"});
  assert.ok((await Promise.all(promises)).every(result => result.status === "disabled"));
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every(call => call.options.signal.aborted));
  pending.forEach(resolve => resolve());
  await flush();
  assert.equal(h.storage.data["ipinfo.cache.v1"]?.entries.length ?? 0, 0);
  await h.enable("replacement-credential");
  const newLookup = h.service.lookup("8.8.8.1");
  await flush();
  pending.at(-1)();
  assert.equal((await newLookup).status, "ok");
  assert.equal(h.calls.at(-1).options.headers.Authorization, "Bearer replacement-credential");
});

test("clearCache invalidates pending writes and requests, then permits a fresh lookup", async () => {
  const pending = [];
  const h = harness({fetcher: ip => new Promise(resolve => pending.push(() => resolve(response(ip))))});
  await h.enable();
  const first = h.service.lookup("8.8.8.8");
  await flush();
  await h.service.clearCache();
  assert.equal((await first).status, "error");
  pending[0]();
  await flush();
  assert.deepEqual(h.storage.data["ipinfo.cache.v1"].entries, []);
  const next = h.service.lookup("8.8.8.8");
  await flush();
  pending[1]();
  assert.equal((await next).status, "ok");
  assert.equal(h.calls.length, 2);
});

test("401 pauses all queued queries and persists through restart until saving even the same token", async () => {
  const h = harness({fetcher: ip => response(ip, 401)});
  await h.enable();
  const results = await Promise.all(Array.from({length: 8}, (_, i) => h.service.lookup(`8.8.8.${i + 1}`)));
  assert.ok(results.every(result => result.status === "auth_error"));
  assert.equal(h.calls.length, 4);
  assert.equal(h.service.getStatus().authError, true);
  const restarted = harness({storage: h.storage});
  await restarted.service.ready;
  assert.equal((await restarted.service.lookup("9.9.9.9")).status, "auth_error");
  assert.equal(restarted.calls.length, 0);
  await restarted.enable();
  assert.equal((await restarted.service.lookup("9.9.9.9")).status, "ok");
  assert.equal(restarted.calls.length, 1);
});

test("429 honors Retry-After seconds, persists globally, and resumes after the deadline", async () => {
  const h = harness({fetcher: ip => response(ip, 429, {}, {"retry-after": "120"})});
  await h.enable();
  const result = await h.service.lookup("8.8.8.8");
  assert.equal(result.retryAt, startTime + 120000);
  assert.equal((await h.service.lookup("9.9.9.9")).status, "rate_limited");
  assert.equal(h.calls.length, 1);
  const restarted = harness({storage: h.storage});
  await restarted.service.ready;
  assert.equal((await restarted.service.lookup("9.9.9.9")).status, "rate_limited");
  restarted.advance(120000);
  assert.equal((await restarted.service.lookup("9.9.9.9")).status, "ok");
});

test("429 supports HTTP dates and falls back to 60 seconds for missing/invalid headers", async () => {
  for (const [header, expected] of [
    [new Date(startTime + 90000).toUTCString(), startTime + 90000],
    [null, startTime + 60000], ["invalid", startTime + 60000],
    ["-1", startTime + 60000], ["9".repeat(400), startTime + 60000],
  ]) {
    const h = harness({fetcher: ip => response(ip, 429, {}, {"retry-after": header})});
    await h.enable();
    assert.equal((await h.service.lookup("8.8.8.8")).retryAt, expected);
  }
});

test("network and HTTP failures are cached for 60 seconds and do not expose thrown messages", async () => {
  for (const fetcher of [
    () => { throw new Error("DO NOT EXPOSE test-credential"); },
    ip => response(ip, 503),
  ]) {
    const h = harness({fetcher});
    await h.enable();
    const first = await h.service.lookup("8.8.8.8");
    assert.equal(first.status, "error");
    assert.ok(!JSON.stringify(first).includes("credential"));
    await h.service.lookup("8.8.8.8");
    assert.equal(h.calls.length, 1);
    h.advance(60000);
    await h.service.lookup("8.8.8.8");
    assert.equal(h.calls.length, 2);
  }
});

test("HTTP 403 pauses authentication until settings are saved", async () => {
  const h = harness({fetcher: ip => response(ip, 403)});
  await h.enable();
  assert.equal((await h.service.lookup("8.8.8.8")).status, "auth_error");
  assert.equal((await h.service.lookup("9.9.9.9")).status, "auth_error");
  assert.equal(h.calls.length, 1);
});

test("pending lookup queue is bounded and clearing a token settles all jobs", async () => {
  const h = harness({fetcher: () => new Promise(() => {})});
  await h.enable();
  const pending = Array.from({length: 1001}, (_, index) =>
    h.service.lookup(`8.8.${Math.floor(index / 256)}.${index % 256}`));
  await flush();
  assert.equal((await pending[1000]).label, "Busy; try again");
  assert.equal(h.calls.length, 4);
  await h.service.configure({enabled: true, token: ""});
  await Promise.all(pending);
  assert.equal((await h.service.lookup("9.9.9.9")).status, "unconfigured");
  assert.equal(h.calls.length, 4);
});

test("timeout aborts both stalled fetch and stalled body parsing at five seconds", async () => {
  for (const fetcher of [
    () => new Promise(() => {}),
    ip => ({...response(ip), json: () => new Promise(() => {})}),
  ]) {
    const h = harness({fetcher});
    await h.enable();
    const pending = h.service.lookup("8.8.8.8");
    await flush();
    h.advance(5000);
    const result = await pending;
    assert.equal(result.status, "error");
    assert.equal(result.label, "Timed out");
    assert.equal(h.calls[0].options.signal.aborted, true);
    assert.equal(h.timers.size, 0);
  }
});

test("missing metadata, bogon and malformed responses are handled without trusting arbitrary payloads", async () => {
  for (const [body, expected] of [
    [{ip: "8.8.8.8"}, "ok"], [{ip: "8.8.8.8", bogon: true}, "special"],
    [{ip: "9.9.9.9"}, "error"], [[], "error"], [null, "error"],
  ]) {
    const h = harness({fetcher: ip => response(ip, 200, body)});
    await h.enable();
    const result = await h.service.lookup("8.8.8.8");
    assert.equal(result.status, expected);
    if (expected === "ok") assert.equal(result.asn, "");
  }
  const invalidJSON = harness({fetcher: ip => ({...response(ip), json: () => { throw new Error("bad json"); }})});
  await invalidJSON.enable();
  assert.equal((await invalidJSON.service.lookup("8.8.8.8")).status, "error");
});

test("testToken works while disabled, queries only the test IP, and never stores its token or result", async () => {
  const h = harness();
  await h.service.ready;
  const before = copy(h.storage.data);
  assert.equal((await h.service.testToken("temporary-test-credential")).status, "ok");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].ip, "8.8.8.8");
  assert.deepEqual(h.storage.data, before);
  assert.equal(h.service.getStatus().configured, false);
  assert.equal((await h.service.testToken(" ")).status, "unconfigured");
  assert.equal(h.calls.length, 1);
});

test("metadata fields require strings rather than accepting arrays through regex coercion", async () => {
  const h = harness({fetcher: ip => response(ip, 200, {
    ip, country_code: ["US"], country: ["United States"],
    asn: ["AS15169"], as_name: ["Google LLC"],
  })});
  await h.enable();
  assert.deepEqual(copy(await h.service.lookup("8.8.8.8")), {
    status: "ok", ip: "8.8.8.8", countryCode: "", country: "", asn: "", asName: "",
  });
});

test("a rejected settings write is sanitized and leaves queries disabled", async () => {
  const storage = memoryStorage();
  storage.set = async () => { throw new Error("test-credential secret storage failure"); };
  const h = harness({storage});
  await h.service.ready;
  await assert.rejects(h.enable(), /^Error: Unable to save IPinfo settings\.$/);
  assert.equal((await h.service.lookup("8.8.8.8")).status, "disabled");
  assert.equal(h.calls.length, 0);
});

test("cache restoration drops expired, invalid and nonpublic entries", async () => {
  const result = {status: "ok", countryCode: "US", country: "US", asn: "AS15169", asName: "Google"};
  const storage = memoryStorage({
    ipinfoSettings: {enabled: true, token: "test-credential"},
    "ipinfo.cache.v1": {version: 1, entries: [
      ["8.8.8.8", {result, expiresAt: startTime - 1}],
      ["127.0.0.1", {result, expiresAt: startTime + 1000}],
      ["9.9.9.9", {result: {status: "arbitrary"}, expiresAt: startTime + 1000}],
      ["invalid", null],
    ]},
  });
  const h = harness({storage});
  await h.service.ready;
  await h.service.lookup("8.8.8.8");
  await h.service.lookup("9.9.9.9");
  assert.equal((await h.service.lookup("127.0.0.1")).status, "local");
  assert.equal(h.calls.length, 2);
});

test("lookup from storage.onChanged waits until enabling settings finish saving", async () => {
  const h = harness();
  await h.service.ready;
  const originalSet = h.storage.set.bind(h.storage);
  let releaseSettings;
  let lookupFromChange;
  let lookupSettled = false;
  let observedStatus;
  h.storage.set = async values => {
    await originalSet(values);
    if ("ipinfoSettings" in values) {
      // Chrome may dispatch this notification before resolving set().
      observedStatus = h.service.getStatus();
      lookupFromChange = h.service.lookup("8.8.8.8").then(result => {
        lookupSettled = true;
        return result;
      });
      await new Promise(resolve => { releaseSettings = resolve; });
    }
  };
  const saving = h.enable();
  await flush();
  assert.equal(observedStatus.enabled, true);
  assert.equal(lookupSettled, false);
  assert.equal(h.calls.length, 0);
  releaseSettings();
  await saving;
  assert.equal((await lookupFromChange).status, "ok");
  assert.equal(h.calls.length, 1);
});

test("lookup waiting on overlapping configuration saves uses only the latest saved token", async () => {
  const h = harness();
  await h.service.ready;
  const originalSet = h.storage.set.bind(h.storage);
  const releases = [];
  h.storage.set = async values => {
    await originalSet(values);
    if ("ipinfoSettings" in values) await new Promise(resolve => releases.push(resolve));
  };
  const firstSave = h.service.configure({enabled: true, token: "first-test-credential"});
  await flush();
  let lookupSettled = false;
  const lookup = h.service.lookup("8.8.8.8").then(result => { lookupSettled = true; return result; });
  const latestSave = h.service.configure({enabled: true, token: "latest-test-credential"});
  await flush();
  assert.equal(h.calls.length, 0);
  releases[0]();
  await firstSave;
  await flush();
  assert.equal(lookupSettled, false);
  assert.equal(h.calls.length, 0);
  assert.equal(releases.length, 2);
  releases[1]();
  await latestSave;
  assert.equal((await lookup).status, "ok");
  assert.equal(h.calls[0].options.headers.Authorization, "Bearer latest-test-credential");
  assert.equal(h.storage.data.ipinfoSettings.token, "latest-test-credential");
});

test("lookup waiting on a failed enabling save returns disabled without a request", async () => {
  const h = harness();
  await h.service.ready;
  let rejectSettings;
  let lookup;
  h.storage.set = async values => {
    if ("ipinfoSettings" in values) {
      lookup = h.service.lookup("8.8.8.8");
      await new Promise((resolve, reject) => { rejectSettings = reject; });
    }
  };
  const rejected = assert.rejects(h.enable(), /^Error: Unable to save IPinfo settings\.$/);
  await flush();
  assert.equal(h.calls.length, 0);
  rejectSettings(new Error("storage unavailable"));
  await rejected;
  assert.equal((await lookup).status, "disabled");
  assert.equal(h.calls.length, 0);
});

test("disabling cancels active and queued work before the settings write resolves", async () => {
  const h = harness({fetcher: () => new Promise(() => {})});
  await h.enable();
  const lookups = Array.from({length: 8}, (_, i) => h.service.lookup(`8.8.8.${i + 1}`));
  await flush();
  const originalSet = h.storage.set.bind(h.storage);
  let releaseSettings;
  h.storage.set = async values => {
    await originalSet(values);
    if ("ipinfoSettings" in values) await new Promise(resolve => { releaseSettings = resolve; });
  };
  const saving = h.service.configure({enabled: false, token: "test-credential"});
  assert.ok((await Promise.all(lookups)).every(result => result.status === "disabled"));
  await flush();
  assert.equal(h.calls.length, 4);
  assert.ok(h.calls.every(call => call.options.signal.aborted));
  releaseSettings();
  await saving;
});

test("clearCache immediately cancels a completed HTTP lookup still waiting for cache persistence", async () => {
  const h = harness();
  await h.enable();
  const originalSet = h.storage.set.bind(h.storage);
  let releaseCache;
  let holdFirstCache = true;
  h.storage.set = async values => {
    await originalSet(values);
    if ("ipinfo.cache.v1" in values && holdFirstCache) {
      holdFirstCache = false;
      await new Promise(resolve => { releaseCache = resolve; });
    }
  };
  const lookup = h.service.lookup("8.8.8.8");
  await flush();
  const clearing = h.service.clearCache();
  const result = await lookup;
  assert.equal(result.status, "error");
  assert.equal(result.label, "Cache cleared; reopen popup");
  releaseCache();
  await clearing;
  assert.deepEqual(h.storage.data["ipinfo.cache.v1"].entries, []);
});

test("negative cache survives worker restart, expires at 60 seconds, and clears persistently", async () => {
  const h = harness({fetcher: ip => response(ip, 503)});
  await h.enable();
  await h.service.lookup("8.8.8.8");
  const restarted = harness({storage: h.storage});
  await restarted.service.ready;
  assert.equal((await restarted.service.lookup("8.8.8.8")).status, "error");
  assert.equal(restarted.calls.length, 0);
  restarted.advance(60000);
  assert.equal((await restarted.service.lookup("8.8.8.8")).status, "ok");
  assert.equal(restarted.calls.length, 1);
  await h.service.clearCache();
  const cleared = harness({storage: h.storage});
  await cleared.service.ready;
  assert.equal((await cleared.service.lookup("8.8.8.8")).status, "ok");
  assert.equal(cleared.calls.length, 1);
});

test("default browser fetch and timer functions keep their native global receiver", async () => {
  let expectedReceiver;
  let fetchCalls = 0;
  let timerCalls = 0;
  let clearCalls = 0;
  const browser = vm.createContext({
    AbortController,
    fetch: function(url) {
      assert.equal(this, expectedReceiver, "fetch receiver");
      ++fetchCalls;
      return Promise.resolve(response(decodeURIComponent(url.split("/").at(-1))));
    },
    setTimeout: function() {
      assert.equal(this, expectedReceiver, "setTimeout receiver");
      ++timerCalls;
      return 1;
    },
    clearTimeout: function() {
      assert.equal(this, expectedReceiver, "clearTimeout receiver");
      ++clearCalls;
    },
  });
  expectedReceiver = vm.runInContext("globalThis", browser);
  for (const file of ["iputil.js", "ipinfo-address.js", "ipinfo-service.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), browser, {filename: file});
  }
  const BrowserService = vm.runInContext("IpinfoService", browser);
  const service = new BrowserService({storage: memoryStorage()});
  await service.ready;
  await service.configure({enabled: true, token: "test-credential"});
  assert.equal((await service.lookup("8.8.8.8")).status, "ok");
  assert.equal((await service.lookup("8.8.8.8")).status, "ok");
  assert.equal(fetchCalls, 1);
  assert.equal(timerCalls, 1);
  assert.equal(clearCalls, 1);
});
