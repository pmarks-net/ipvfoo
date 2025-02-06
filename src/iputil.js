"use strict";

const DOT = '.';
const COLON = ':';
const IPV6_PART_COUNT = 8;

// Based on Guava ipStringToBytes.
// Returns 32/4=8 hex digits for IPv4, 128/4=32 hex digits for IPv6.
function parseIP(s) {
  // Make a first pass to categorize the characters in this string.
  let hasColon = false;
  let hasDot = false;
  for (const c of s) {
    if (c == DOT) {
      hasDot = true;
    } else if (c == COLON) {
      if (hasDot) {
        throw "colon after dot";
      }
      hasColon = true;
    } else if (!(parseInt(c, 16) >= 0)) {
      throw "invalid digit";
    }
  }

  // Now decide which address family to parse.
  if (hasColon) {
    if (hasDot) {
      const lastColon = s.lastIndexOf(COLON);
      const prefix = textToPackedIPv6(s.slice(0, lastColon) + ':0:0');
      const suffix = textToPackedIPv4(s.slice(lastColon + 1));
      return prefix.slice(0, 96/4) + suffix;
    }
    return textToPackedIPv6(s);
  } else if (hasDot) {
    return textToPackedIPv4(s);
  }
  throw "no colons or dots";
}

// The input is a /96 or /128 worth of hex digits.
function formatIPv6(packed, with_dots = false) {
  if (!(packed.length == 96/4 || packed.length == 128/4)) {
    throw "bad length";
  }
  const hextets = new Array(IPV6_PART_COUNT);
  for (let i = 0; i < IPV6_PART_COUNT; i++) {
    hextets[i] = 4*i < packed.length ? parseInt(packed.substr(4*i, 4), 16) : 0;
  }
  let suffix = "";
  if (with_dots) {
    suffix = [(hextets[6] >> 8) & 0xff, hextets[6] & 0xff,
              (hextets[7] >> 8) & 0xff, hextets[7] & 0xff].join('.');
    // Format as <prefix>:4:4, then replace the 3-character suffix.
    hextets[6] = hextets[7] = 4;
  }
  compressLongestRunOfZeroes(hextets);
  const text = hextetsToIPv6String(hextets);
  if (with_dots) {
    return text.slice(0, text.length-3) + suffix;
  }
  return text;
}

function formatIPv6WithDots(packed) {
  return formatIPv6(packed, true);
}

// Based on Guava textToNumericFormatV4
function textToPackedIPv4(s) {
  const parts = s.split(DOT, 5);
  if (parts.length != 4) {
    throw "wrong number of octets";
  }
  var packed = "";
  for (const p of parts) {
    const octet = parseInt(p, 10);
    if (!(octet < 256 && p == octet.toString(10))) {
      throw "bad octet";
    }
    packed += (octet >> 4).toString(16) + (octet & 0xf).toString(16);
  }
  return packed;
}

// Based on Guava textToNumericFormatV6
function textToPackedIPv6(s) {
  // An address can have [2..8] colons.
  let delimiterCount = 0;
  for (const c of s) {
    if (c == COLON) delimiterCount++;
  }
  if (delimiterCount < 2 || delimiterCount > IPV6_PART_COUNT) {
    throw "incorrect number of parts";
  }
  let partsSkipped = IPV6_PART_COUNT - (delimiterCount + 1); // estimate; may be modified later
  let hasSkip = false;
  const slen = s.length;
  for (let i = 0; i < slen - 1; i++) {
    if (s.charAt(i) == COLON && s.charAt(i + 1) == COLON) {
      if (hasSkip) {
        throw "can't have more than one ::";
      }
      hasSkip = true;
      partsSkipped++; // :: means we skipped an extra part in between the two delimiters.
      if (i == 0) {
        partsSkipped++; // Begins with ::, so we skipped the part preceding the first :
      }
      if (i == slen - 2) {
        partsSkipped++; // Ends with ::, so we skipped the part after the last :
      }
    }
  }
  if (s.charAt(0) == COLON && s.charAt(1) != COLON) {
    throw "^: requires ^::";
  }
  if (s.charAt(slen - 1) == COLON && s.charAt(slen - 2) != COLON) {
    throw ":$ requires ::$";
  }
  if (hasSkip && partsSkipped <= 0) {
    throw ":: must expand to at least one '0'";
  }
  if (!hasSkip && delimiterCount + 1 != IPV6_PART_COUNT) {
    throw "incorrect number of parts";
  }

  // Iterate through the parts of the ip string.
  // Invariant: start is always the beginning of a hextet, or the second ':' of the skip
  // sequence "::"
  let packed = "";
  let start = 0;
  if (s.charAt(0) == COLON) {
    start = 1;
  }
  while (start < slen) {
    let end = s.indexOf(COLON, start);
    if (end == -1) {
      end = slen;
    }
    if (s.charAt(start) == COLON) {
      for (let i = 0; i < partsSkipped; i++) {
        packed += '0000';
      }
    } else {
      // Note: parseIP already verified that this string contains only hex digits.
      const hextet = parseInt(s.slice(start, end), 16);
      if (hextet > 0xffff) {
        throw "hextet too large";
      }
      packed += hextet.toString(16).padStart(4, '0');
    }
    start = end + 1;
  }
  return packed;
}

// Based on Guava compressLongestRunOfZeroes
function compressLongestRunOfZeroes(hextets) {
  let bestRunStart = -1;
  let bestRunLength = -1;
  let runStart = -1;
  for (let i = 0; i < hextets.length + 1; i++) {
    if (i < hextets.length && hextets[i] == 0) {
      if (runStart < 0) {
        runStart = i;
      }
    } else if (runStart >= 0) {
      const runLength = i - runStart;
      if (runLength > bestRunLength) {
        bestRunStart = runStart;
        bestRunLength = runLength;
      }
      runStart = -1;
    }
  }
  if (bestRunLength >= 2) {
    for (let i = bestRunStart; i < bestRunStart + bestRunLength; i++) {
      hextets[i] = -1;
    }
  }
}

// Based on Guava hextetsToIPv6String
function hextetsToIPv6String(hextets) {
  // While scanning the array, handle these state transitions:
  //   start->num => "num"     start->gap => "::"
  //   num->num   => ":num"    num->gap   => "::"
  //   gap->num   => "num"     gap->gap   => ""
  let out = "";
  let lastWasNumber = false;
  for (let i = 0; i < hextets.length; i++) {
    const thisIsNumber = hextets[i] >= 0;
    if (thisIsNumber) {
      if (lastWasNumber) {
        out += COLON;
      }
      out += hextets[i].toString(16);
    } else {
      if (i == 0 || lastWasNumber) {
        out += COLON + COLON;
      }
    }
    lastWasNumber = thisIsNumber;
  }
  return out;
}
