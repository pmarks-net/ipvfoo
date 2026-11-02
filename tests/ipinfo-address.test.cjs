"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({});
for (const file of ["iputil.js", "ipinfo-address.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), context, {filename: file});
}
const classify = (address, prefixes) => JSON.parse(JSON.stringify(
  context.getIpinfoLookupTarget(address, prefixes)));

test("RFC1918 edges stay exact rather than filtering classful address space", () => {
  for (const ip of ["10.0.0.0", "10.255.255.255", "172.16.0.0", "172.31.255.255",
    "192.168.0.0", "192.168.255.255"]) {
    assert.deepEqual(classify(ip), {status: "local", label: "Local"}, ip);
  }
  for (const ip of ["9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0",
    "192.167.255.255", "192.169.0.0"]) {
    assert.deepEqual(classify(ip), {status: "query", ip}, ip);
  }
});

test("CGNAT boundaries and local IPv4 purposes are skipped", () => {
  for (const ip of ["100.64.0.0", "100.127.255.255"]) {
    assert.deepEqual(classify(ip), {status: "local", label: "CGNAT"}, ip);
  }
  for (const ip of ["100.63.255.255", "100.128.0.0"]) {
    assert.deepEqual(classify(ip), {status: "query", ip}, ip);
  }
  for (const [ip, label] of [["127.0.0.1", "Loopback"], ["127.255.255.255", "Loopback"],
    ["169.254.0.1", "Link-local"], ["169.254.255.255", "Link-local"]]) {
    assert.deepEqual(classify(ip), {status: "local", label}, ip);
  }
});

test("special IPv4 ranges are not candidates for network lookups", () => {
  for (const ip of ["0.0.0.0", "0.255.255.255", "192.0.0.1", "192.0.0.8", "192.0.0.11",
    "192.0.0.170", "192.0.0.171", "192.0.2.1", "192.88.99.2", "198.18.0.0",
    "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.0", "239.255.255.255",
    "240.0.0.0", "255.255.255.255"]) {
    assert.equal(classify(ip).status, "special", ip);
  }
  for (const ip of ["198.17.255.255", "198.20.0.0", "223.255.255.255"]) {
    assert.deepEqual(classify(ip), {status: "query", ip}, ip);
  }
});

test("IPv4 public IANA exceptions survive broader exclusions", () => {
  for (const ip of ["192.0.0.9", "192.0.0.10", "192.31.196.1", "192.52.193.1",
    "192.175.48.1", "8.8.8.8", "1.1.1.1"]) {
    assert.deepEqual(classify(ip), {status: "query", ip}, ip);
  }
});

test("IPv6 local, multicast and special purposes are skipped", () => {
  for (const ip of ["::", "::1", "::8.8.8.8", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fe80::1", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fec0::1", "ff00::", "ff02::1",
    "100::1", "100:0:0:1::1", "2001:2::1", "2001:db8::1", "3fff::1", "3fff:fff::1",
    "5f00::1", "64:ff9b:1:2::808:808", "2001:5::1"]) {
    assert.ok(["local", "special"].includes(classify(ip).status), ip);
  }
  for (const ip of ["3fff:1000::1", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
    assert.deepEqual(classify(ip), {status: "query", ip}, ip);
  }
});

test("IPv6 longest-prefix public exceptions and transitional N/A entries survive", () => {
  for (const ip of ["2001::1", "2001:1::1", "2001:1::2", "2001:1::3", "2001:3::1",
    "2001:4:112::1", "2001:20::1", "2001:2f::1", "2001:30::1", "2001:3f::1",
    "2002::1", "2620:4f:8000::1"]) {
    assert.deepEqual(classify(ip), {status: "query", ip}, ip);
  }
  for (const ip of ["2001:1::4", "2001:4:111::1", "2001:4:113::1", "2001:40::1"]) {
    assert.equal(classify(ip).status, "special", ip);
  }
});

test("mapped and recognized NAT64 forms share their embedded IPv4 target", () => {
  for (const ip of ["::ffff:8.8.8.8", "::ffff:808:808", "64:ff9b::8.8.8.8",
    "64:ff9b::808:808", "64:ff9b:1::808:808"]) {
    assert.deepEqual(classify(ip), {status: "query", ip: "8.8.8.8"}, ip);
  }
  for (const ip of ["::ffff:192.168.1.1", "64:ff9b::192.168.1.1", "64:ff9b:1::a00:1",
    "::ffff:7f00:1", "64:ff9b::6440:1"]) {
    assert.equal(classify(ip).status, "local", ip);
  }
});

test("recognized custom NAT64 precedes local-prefix filtering", () => {
  const prefix = context.parseIP("fd00:1234::").slice(0, 24);
  assert.deepEqual(classify("fd00:1234::8.8.8.8", [prefix]), {status: "query", ip: "8.8.8.8"});
  assert.equal(classify("fd00:1234::192.168.1.1", [prefix]).status, "local");
  assert.equal(classify("fd00:1234::8.8.8.8").status, "local");
  const prefixSet = vm.runInContext("new Set(['" + prefix + "'])", context);
  assert.deepEqual(classify("fd00:1234::808:808", prefixSet), {status: "query", ip: "8.8.8.8"});
  assert.deepEqual(classify("fd00:1234::808:808", new Set([prefix])),
    {status: "query", ip: "8.8.8.8"});
});

test("unknown dotted suffixes are not mistaken for NAT64", () => {
  assert.deepEqual(classify("2001:4860::192.168.1.1"), {status: "query", ip: "2001:4860::c0a8:101"});
  assert.deepEqual(classify("2001:4860::8.8.8.8", ["bad-prefix"]),
    {status: "query", ip: "2001:4860::808:808"});
});

test("equivalent IPv6 spellings normalize to one cache key", () => {
  const expected = {status: "query", ip: "2001:4860:abcd::1"};
  for (const ip of ["2001:4860:ABCD:0:0:0:0:1", "2001:4860:abcd::0001", "2001:4860:abcd::1"]) {
    assert.deepEqual(classify(ip), expected, ip);
  }
});

test("invalid and unavailable inputs never become lookup targets", () => {
  for (const ip of [null, undefined, 42, {}, "", "(no address)", "example.com", "1.2.3",
    "256.1.1.1", "01.2.3.4", "1.2.3.4/24", "1.2.3.4:443", " 8.8.8.8", "8.8.8.8 ",
    "2001:::1", "2001::1::2", "[2001:4860::1]", "fe80::1%eth0", "2001:00000::1",
    "2001:10000::1", "::ffff:999.1.1.1", "https://8.8.8.8"]) {
    assert.equal(classify(ip).status, "invalid", String(ip));
  }
});
