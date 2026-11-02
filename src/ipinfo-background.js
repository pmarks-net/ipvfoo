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

// Requires <script src="ipinfo-service.js"> and the state in background.js.

// This bridge is loaded after background.js. Only extension-owned options and
// popup pages can access it; a lookup must refer to the popup's current tab and
// an IP actually captured for that tab. No URLs, credentials or page content
// from the visited site are forwarded to IPinfo.
const ipinfoService = new IpinfoService({storage: chrome.storage.local});
chrome.storage.local.setAccessLevel?.({accessLevel: "TRUSTED_CONTEXTS"}).catch(() => {});

async function handleIpinfoMessage(request, sender) {
  if (sender.id != chrome.runtime.id || !sender.url) return {status: "error"};
  const url = new URL(sender.url);
  const isOptions = url.href.split(/[?#]/, 1)[0] == chrome.runtime.getURL("options.html");
  const isPopup = url.href.split(/[?#]/, 1)[0] == chrome.runtime.getURL("popup.html");
  if (!isOptions && !isPopup) return {status: "error"};
  await ipinfoService.ready;
  if (request.action == "getStatus") return ipinfoService.getStatus();

  if (request.action == "lookup") {
    if (!isPopup || !Number.isSafeInteger(request.tabId) || request.tabId < 0 ||
        url.hash != `#${request.tabId}` || typeof request.address != "string") {
      return {status: "invalid"};
    }
    await storageReady;
    const tab = await chrome.tabs.get(request.tabId);
    if (tab.incognito || sender.tab?.incognito || chrome.extension.inIncognitoContext) {
      return {status: "incognito"};
    }
    const info = tabMap[request.tabId];
    if (!info || !Object.values(info.domains).some(domain => domain.addr == request.address)) {
      return {status: "invalid"};
    }
    return ipinfoService.lookup(request.address, {nat64Prefixes: options[NAT64_KEY]});
  }

  if (!isOptions) return {status: "error"};
  switch (request.action) {
    case "getSettings":
      return ipinfoService.getSettings();
    case "saveSettings":
      if (typeof request.enabled != "boolean" || typeof request.token != "string" ||
          request.token.length > 4096) {
        return {status: "error"};
      }
      return ipinfoService.configure({enabled: request.enabled, token: request.token});
    case "clearToken":
      return ipinfoService.configure({enabled: false, token: ""});
    case "testToken":
      if (sender.tab?.incognito || chrome.extension.inIncognitoContext) {
        return {status: "incognito"};
      }
      if (typeof request.token != "string" || request.token.length > 4096) {
        return {status: "unconfigured"};
      }
      return ipinfoService.testToken(request.token);
    case "clearCache":
      await ipinfoService.clearCache();
      return {ok: true};
    default:
      return {status: "error"};
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message?.ipinfo || typeof message.ipinfo != "object") return;
  handleIpinfoMessage(message.ipinfo, sender).then(sendResponse, () => {
    // Deliberately never log thrown fetch/storage errors that may carry secrets.
    sendResponse({status: "error"});
  });
  return true;
});
