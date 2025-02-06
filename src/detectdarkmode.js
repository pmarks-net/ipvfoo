"use strict";
const query = window.matchMedia('(prefers-color-scheme: dark)');
chrome.runtime.sendMessage({darkModeOffscreen: query.matches});