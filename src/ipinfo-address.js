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

// Requires <script src="iputil.js">

// These rules describe address purpose, not live BGP reachability.
// IANA special-purpose registries, checked 2026-11-02 (registry revision 2025-10-09):
// https://www.iana.org/assignments/iana-ipv4-special-registry/
// https://www.iana.org/assignments/iana-ipv6-special-registry/
// Most-specific rules win, including globally reachable exceptions within a
// non-global parent. A null status explicitly permits lookup (including N/A
// reachability for Teredo); unlisted addresses are also eligible for lookup.
// Multicast and deprecated IPv6 compatible/site-local ranges are added from
// RFC 1112 and RFC 4291. No registry or DNS requests are made at runtime.
const IPINFO_ADDRESS_RULES = [
  ["0.0.0.0/8", "special", "Unspecified"],
  ["10.0.0.0/8", "local", "Local"],
  ["100.64.0.0/10", "local", "CGNAT"],
  ["127.0.0.0/8", "local", "Loopback"],
  ["169.254.0.0/16", "local", "Link-local"],
  ["172.16.0.0/12", "local", "Local"],
  ["192.0.0.0/24", "special", "Reserved"],
  ["192.0.0.9/32", null],
  ["192.0.0.10/32", null],
  ["192.0.2.0/24", "special", "Documentation"],
  ["192.88.99.2/32", "special", "Reserved"],
  ["192.168.0.0/16", "local", "Local"],
  ["198.18.0.0/15", "special", "Benchmark"],
  ["198.51.100.0/24", "special", "Documentation"],
  ["203.0.113.0/24", "special", "Documentation"],
  ["224.0.0.0/4", "special", "Multicast"],
  ["240.0.0.0/4", "special", "Reserved"],
  ["255.255.255.255/32", "special", "Broadcast"],
  ["::/96", "special", "Reserved"],
  ["::/128", "special", "Unspecified"],
  ["::1/128", "local", "Loopback"],
  ["64:ff9b:1::/48", "local", "Translation"],
  ["100::/64", "special", "Discard-only"],
  ["100:0:0:1::/64", "special", "Dummy"],
  ["2001::/23", "special", "Reserved"],
  ["2001::/32", null],
  ["2001:1::1/128", null],
  ["2001:1::2/128", null],
  ["2001:1::3/128", null],
  ["2001:2::/48", "special", "Benchmark"],
  ["2001:3::/32", null],
  ["2001:4:112::/48", null],
  ["2001:20::/28", null],
  ["2001:30::/28", null],
  ["2001:db8::/32", "special", "Documentation"],
  ["3fff::/20", "special", "Documentation"],
  ["5f00::/16", "special", "Reserved"],
  ["fc00::/7", "local", "Local"],
  ["fe80::/10", "local", "Link-local"],
  ["fec0::/10", "local", "Site-local"],
  ["ff00::/8", "special", "Multicast"],
].map(([cidr, status, label]) => {
  const [address, bits] = cidr.split("/");
  return {packed: parseIP(address), bits: Number(bits), status, label};
}).sort((a, b) => b.bits - a.bits);

// Matches the /96 defaults in common.js. User-discovered /96 prefixes can be
// passed in as the existing Set of 24-character packed hexadecimal prefixes.
const IPINFO_TRANSLATION_PREFIXES = new Set([
  "::ffff:0:0", "64:ff9b::", "64:ff9b:1::",
].map(address => parseIP(address).slice(0, 24)));

function ipinfoPrefixMatches(packed, rule) {
  if (packed.length != rule.packed.length) return false;
  const whole = Math.floor(rule.bits / 4);
  if (packed.slice(0, whole) != rule.packed.slice(0, whole)) return false;
  const remaining = rule.bits % 4;
  if (!remaining) return true;
  const shift = 4 - remaining;
  return (parseInt(packed[whole], 16) >> shift) ==
      (parseInt(rule.packed[whole], 16) >> shift);
}

function ipinfoFormatIPv4(packed) {
  return [0, 2, 4, 6].map(offset => parseInt(packed.slice(offset, offset + 2), 16)).join(".");
}

// Return a canonical IP eligible for lookup, or a local reason to skip it.
// A dotted IPv6 suffix is not evidence of NAT64: only recognized prefixes are
// unwrapped. Classification happens after translation so private embedded IPv4
// addresses cannot escape filtering and a recognized local NAT64 prefix works.
function getIpinfoLookupTarget(address, nat64Prefixes = []) {
  if (typeof address != "string" || !address) {
    return {status: "invalid", label: "No address"};
  }
  let packed;
  try {
    // parseIP historically permits overlong all-zero hextets. Keep API input
    // strict without changing the extension's existing parser or display rules.
    if (address.includes(":") && address.split(":").some(
        part => !part.includes(".") && part.length > 4)) {
      throw new Error("Invalid hextet");
    }
    packed = parseIP(address);
    if (!/^(?:[0-9a-f]{8}|[0-9a-f]{32})$/.test(packed)) {
      throw new Error("Invalid packed address");
    }
  } catch {
    return {status: "invalid", label: "No address"};
  }

  if (packed.length == 32) {
    const prefix = packed.slice(0, 24);
    const suppliedPrefixes = Object.prototype.toString.call(nat64Prefixes) == "[object Set]" ||
        Array.isArray(nat64Prefixes) ?
        nat64Prefixes : [];
    const translated = IPINFO_TRANSLATION_PREFIXES.has(prefix) ||
        Array.from(suppliedPrefixes).some(candidate =>
          typeof candidate == "string" && /^[0-9a-f]{24}$/i.test(candidate) &&
          candidate.toLowerCase() == prefix);
    if (translated) {
      packed = packed.slice(24);
    }
  }

  const rule = IPINFO_ADDRESS_RULES.find(candidate => ipinfoPrefixMatches(packed, candidate));
  if (rule?.status) return {status: rule.status, label: rule.label};
  return {status: "query", ip: packed.length == 8 ? ipinfoFormatIPv4(packed) : formatIPv6(packed)};
}
