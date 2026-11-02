/*
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

"use strict";

// Requires <script src="ipinfo-address.js">

const IPINFO_CACHE_TTL = 24 * 60 * 60 * 1000;
const IPINFO_RETRY_DELAY = 60 * 1000;
const IPINFO_REQUEST_TIMEOUT = 5 * 1000;
const IPINFO_MAX_ENTRIES = 1000;
const IPINFO_MAX_REQUESTS = 4;
const IPINFO_MAX_TOKEN_LENGTH = 4096;

// Owns the local settings, cache, and shared request queue. Network requests are
// started only by lookup() or an explicit testToken() from the options page.
class IpinfoService {
  constructor({storage, fetchFn = fetch, now = Date.now,
      setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout} = {}) {
    if (!storage) throw new Error("IPinfo local storage is required.");
    this._storage = storage;
    // Browser Web IDL functions require their Window/WorkerGlobalScope receiver.
    // Calling unbound native functions as this._fetch()/this._clearTimeout()
    // would otherwise supply the service instance and throw Illegal invocation.
    this._fetch = fetchFn.bind(globalThis);
    this._now = now;
    this._setTimeout = setTimeoutFn.bind(globalThis);
    this._clearTimeout = clearTimeoutFn.bind(globalThis);
    this._settings = {enabled: false, token: ""};
    this._cache = new Map();
    this._failures = new Map();
    this._jobs = new Map();
    this._queue = [];
    this._active = 0;
    this._generation = 0;
    this._configVersion = 0;
    this._configurationPending = false;
    this._configurationSettled = Promise.resolve();
    this._authPaused = false;
    this._retryAt = 0;
    this._writes = Promise.resolve();
    this.ready = this._load();
  }

  async _load() {
    try {
      const values = await this._storage.get([
        "ipinfoSettings", "ipinfo.cache.v1", "ipinfo.state.v1",
      ]);
      const settings = values["ipinfoSettings"];
      this._settings = {
        enabled: settings?.enabled === true,
        token: this._token(settings?.token),
      };
      const state = values["ipinfo.state.v1"];
      this._authPaused = state?.authPaused === true;
      this._retryAt = Number.isFinite(state?.retryAt) ? state.retryAt : 0;
      if (Array.isArray(state?.failures)) {
        for (const item of state.failures.slice(-IPINFO_MAX_ENTRIES)) {
          if (!Array.isArray(item) || item.length !== 2) continue;
          const [ip, entry] = item;
          if (typeof ip !== "string" || !entry || entry.result?.status !== "error" ||
              !Number.isFinite(entry.expiresAt) || entry.expiresAt <= this._now()) continue;
          const target = getIpinfoLookupTarget(ip);
          if (target.status !== "query" || target.ip !== ip) continue;
          this._failures.set(ip, {
            result: {status: "error", label: "Lookup unavailable"},
            expiresAt: Math.min(entry.expiresAt, this._now() + IPINFO_RETRY_DELAY),
          });
        }
      }
      const cache = values["ipinfo.cache.v1"];
      if (cache?.version === 1 && Array.isArray(cache.entries)) {
        for (const item of cache.entries.slice(-IPINFO_MAX_ENTRIES)) {
          if (!Array.isArray(item) || item.length !== 2) continue;
          const [ip, entry] = item;
          if (typeof ip !== "string" || !entry ||
              !Number.isFinite(entry.expiresAt) || entry.expiresAt <= this._now()) continue;
          const target = getIpinfoLookupTarget(ip);
          if (target.status !== "query" || target.ip !== ip) continue;
          const result = this._cachedResult(entry.result, ip);
          if (!result) continue;
          this._cache.set(ip, {
            result,
            expiresAt: Math.min(entry.expiresAt, this._now() + IPINFO_CACHE_TTL),
            usedAt: Number.isFinite(entry.usedAt) ? entry.usedAt : 0,
          });
        }
      }
    } catch {
      // A broken local store must never accidentally enable online lookups.
      this._settings = {enabled: false, token: ""};
      this._cache.clear();
      this._failures.clear();
    }
  }

  _token(value) {
    return typeof value === "string" && value.length <= IPINFO_MAX_TOKEN_LENGTH ?
        value.trim() : "";
  }

  // Callers must await ready. Only the trusted options page should receive this.
  getSettings() {
    return {...this._settings};
  }

  getStatus() {
    return {
      enabled: this._settings.enabled, configured: !!this._settings.token,
      authError: this._authPaused, retryAt: this._retryAt > this._now() ? this._retryAt : 0,
    };
  }

  async configure({enabled, token} = {}) {
    await this.ready;
    const version = ++this._configVersion;
    ++this._generation;
    this._configurationPending = true;
    let finishConfiguration;
    this._configurationSettled = new Promise(resolve => { finishConfiguration = resolve; });
    this._settings = {enabled: enabled === true, token: this._token(token)};
    this._authPaused = false;
    this._retryAt = 0;
    this._failures.clear();
    this._cancelJobs({status: "disabled", label: "Settings changed"});
    try {
      await this._write({
        "ipinfoSettings": {...this._settings},
        "ipinfo.state.v1": this._state(),
      });
    } catch {
      if (version === this._configVersion) {
        this._settings = {enabled: false, token: ""};
        ++this._generation;
        this._cancelJobs({status: "disabled", label: "Settings could not be saved"});
      }
      throw new Error("Unable to save IPinfo settings.");
    } finally {
      if (version === this._configVersion) this._configurationPending = false;
      finishConfiguration();
    }
    return this.getStatus();
  }

  async lookup(address, {nat64Prefixes = [], incognito = false} = {}) {
    await this.ready;
    const target = getIpinfoLookupTarget(address, nat64Prefixes);
    if (target.status !== "query") return target;
    if (incognito) return {status: "incognito", label: "Private window"};
    // storage.onChanged can reach the popup before storage.set() resolves.
    // Follow newer saves too; never turn that brief interval into a sticky
    // Disabled result in an already-open popup.
    while (this._configurationPending) await this._configurationSettled;
    const blocked = this._blocked();
    if (blocked) return blocked;
    const ip = target.ip;
    const now = this._now();
    const cached = this._cache.get(ip);
    if (cached?.expiresAt > now) {
      cached.usedAt = now;
      return {...cached.result};
    }
    this._cache.delete(ip);
    const failed = this._failures.get(ip);
    if (failed?.expiresAt > now) return {...failed.result};
    this._failures.delete(ip);
    if (this._jobs.has(ip)) return this._jobs.get(ip).promise;
    if (this._jobs.size >= IPINFO_MAX_ENTRIES) {
      return {status: "error", label: "Busy; try again"};
    }
    const job = {
      ip, generation: this._generation, controller: new AbortController(), cancelled: false,
    };
    job.promise = new Promise(resolve => { job.resolve = resolve; });
    this._jobs.set(ip, job);
    this._queue.push(job);
    this._pump();
    return job.promise;
  }

  _blocked() {
    if (!this._settings.enabled || this._configurationPending) {
      return {status: "disabled", label: "Disabled"};
    }
    if (!this._settings.token) return {status: "unconfigured", label: "Set API token"};
    if (this._authPaused) return {status: "auth_error", label: "Check API token"};
    if (this._retryAt > this._now()) {
      return {status: "rate_limited", label: "Rate limited", retryAt: this._retryAt};
    }
    return null;
  }

  _pump() {
    const blocked = this._blocked();
    if (blocked) {
      this._cancelJobs(blocked);
      return;
    }
    while (this._active < IPINFO_MAX_REQUESTS && this._queue.length) {
      const job = this._queue.shift();
      if (job.cancelled) continue;
      ++this._active;
      void this._run(job);
    }
  }

  async _run(job) {
    try {
      const result = await this._request(job.ip, this._settings.token, job.controller);
      if (job.cancelled || job.generation !== this._generation) return;
      if (result.status === "auth_error" || result.status === "rate_limited") {
        if (result.status === "auth_error") this._authPaused = true;
        else this._retryAt = Math.max(this._retryAt, result.retryAt);
        this._cancelJobs(result, job);
        await this._write({"ipinfo.state.v1": this._state()}).catch(() => {});
      } else if (result.status === "ok" || result.status === "special") {
        this._cache.set(job.ip, {
          result, expiresAt: this._now() + IPINFO_CACHE_TTL, usedAt: this._now(),
        });
        this._pruneCache();
        await this._persistCache().catch(() => {});
      } else {
        this._failures.set(job.ip, {result, expiresAt: this._now() + IPINFO_RETRY_DELAY});
        while (this._failures.size > IPINFO_MAX_ENTRIES) {
          this._failures.delete(this._failures.keys().next().value);
        }
        await this._write({"ipinfo.state.v1": this._state()}).catch(() => {});
      }
      // configure()/clearCache() may run while the local write is pending.
      if (!job.cancelled && job.generation === this._generation) job.resolve({...result});
      else job.resolve({status: "disabled", label: "Settings changed"});
    } catch {
      if (this._jobs.get(job.ip) === job) this._jobs.delete(job.ip);
      job.resolve({status: "error", label: "Lookup unavailable"});
    } finally {
      if (this._jobs.get(job.ip) === job) this._jobs.delete(job.ip);
      --this._active;
      this._pump();
    }
  }

  _cancelJobs(result, except = null) {
    for (const job of this._jobs.values()) {
      if (job === except) continue;
      job.cancelled = true;
      job.resolve({...result});
      job.controller.abort();
      this._jobs.delete(job.ip);
    }
    this._queue = [];
  }

  async testToken(token) {
    await this.ready;
    token = this._token(token);
    if (!token) return {status: "unconfigured", label: "Enter an API token"};
    // Tests are explicit one-shot operations; their token/results are not saved.
    return this._request("8.8.8.8", token, new AbortController());
  }

  async clearCache() {
    await this.ready;
    ++this._generation;
    this._cache.clear();
    this._failures.clear();
    this._cancelJobs({status: "error", label: "Cache cleared; reopen popup"});
    try {
      await this._write({
        "ipinfo.cache.v1": {version: 1, entries: []},
        "ipinfo.state.v1": this._state(),
      });
    } catch {
      throw new Error("Unable to clear IPinfo cache.");
    }
    return {status: "ok"};
  }

  _state() {
    for (const [ip, entry] of this._failures) {
      if (entry.expiresAt <= this._now()) this._failures.delete(ip);
    }
    return {authPaused: this._authPaused, retryAt: this._retryAt, failures: [...this._failures]};
  }

  _write(values) {
    const snapshot = JSON.parse(JSON.stringify(values));
    const write = this._writes.catch(() => {}).then(() => this._storage.set(snapshot));
    this._writes = write;
    return write;
  }

  _persistCache() {
    return this._write({"ipinfo.cache.v1": {version: 1, entries: [...this._cache]}});
  }

  _pruneCache() {
    const now = this._now();
    for (const [ip, entry] of this._cache) {
      if (entry.expiresAt <= now) this._cache.delete(ip);
    }
    if (this._cache.size > IPINFO_MAX_ENTRIES) {
      const oldest = [...this._cache].sort((a, b) => a[1].usedAt - b[1].usedAt);
      for (const [ip] of oldest.slice(0, this._cache.size - IPINFO_MAX_ENTRIES)) {
        this._cache.delete(ip);
      }
    }
  }

  _text(value, limit) {
    return typeof value === "string" ?
        value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, limit) : "";
  }

  _metadata(data, ip) {
    return {
      status: "ok", ip,
      countryCode: typeof data.country_code === "string" && /^[A-Z]{2}$/.test(data.country_code) ?
          data.country_code : "",
      country: this._text(data.country, 128),
      asn: typeof data.asn === "string" && /^AS[0-9]{1,10}$/.test(data.asn) ? data.asn : "",
      asName: this._text(data.as_name, 256),
    };
  }

  _cachedResult(result, ip) {
    if (result?.status === "special") return {status: "special", ip, label: "Special"};
    if (result?.status !== "ok") return null;
    return this._metadata({
      country_code: result.countryCode, country: result.country,
      asn: result.asn, as_name: result.asName,
    }, ip);
  }

  _retryAfter(value) {
    const now = this._now();
    if (typeof value === "string" && value.trim()) {
      value = value.trim();
      if (/^[0-9]+$/.test(value)) {
        const deadline = now + Number(value) * 1000;
        if (Number.isFinite(deadline)) return deadline;
      } else if (/[a-z]/i.test(value)) {
        const date = Date.parse(value);
        if (Number.isFinite(date)) return Math.max(now, date);
      }
    }
    return now + IPINFO_RETRY_DELAY;
  }

  async _request(ip, token, controller) {
    let timer;
    let onAbort;
    const cancelled = new Promise(resolve => {
      onAbort = () => resolve({status: "error", label: "Cancelled"});
      controller.signal.addEventListener("abort", onAbort, {once: true});
      if (controller.signal.aborted) onAbort();
    });
    const timeout = new Promise(resolve => {
      timer = this._setTimeout(() => {
        resolve({status: "error", label: "Timed out"});
        controller.abort();
      }, IPINFO_REQUEST_TIMEOUT);
    });
    try {
      const request = (async () => {
        try {
          const response = await this._fetch("https://api.ipinfo.io/lite/" + encodeURIComponent(ip), {
            method: "GET", headers: {Authorization: "Bearer " + token},
            credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
            cache: "no-store", signal: controller.signal,
          });
          if (response.status === 401 || response.status === 403) {
            return {status: "auth_error", label: "Check API token"};
          }
          if (response.status === 429) {
            return {
              status: "rate_limited", label: "Rate limited",
              retryAt: this._retryAfter(response.headers?.get("Retry-After")),
            };
          }
          if (!response.ok) return {status: "error", label: "Lookup unavailable"};
          const data = await response.json();
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            return {status: "error", label: "Invalid response"};
          }
          const returned = getIpinfoLookupTarget(data.ip);
          if (returned.status !== "query" || returned.ip !== ip) {
            return {status: "error", label: "Invalid response"};
          }
          if (data.bogon === true) return {status: "special", ip, label: "Special"};
          return this._metadata(data, ip);
        } catch {
          return {status: "error", label: "Lookup unavailable"};
        }
      })();
      return await Promise.race([request, cancelled, timeout]);
    } finally {
      this._clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }
}
