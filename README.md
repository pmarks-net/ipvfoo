**IPvFoo** is a Chrome/Firefox extension that adds an icon to indicate whether the current page was fetched using IPv4 or IPv6. When you click the icon, a pop-up appears, listing the IP address for each domain that served the page elements.

Everything is captured privately using the webRequest API, without creating any additional network traffic.

## Screenshot
![Screenshot](/misc/screenshot_webstore_1_640x400.png?raw=true)

## Add to Chrome
https://chrome.google.com/webstore/detail/ipvfoo/ecanpcehffngcegjmadlcijfolapggal

<!--
<picture><img src="https://badgen.net/chrome-web-store/v/ecanpcehffngcegjmadlcijfolapggal"></picture>
<picture><img src="https://badgen.net/chrome-web-store/users/ecanpcehffngcegjmadlcijfolapggal"></picture>
<picture><img src="https://badgen.net/chrome-web-store/rating/ecanpcehffngcegjmadlcijfolapggal"></picture>
-->

## Add to Firefox
https://addons.mozilla.org/addon/ipvfoo/

<picture><img src="https://badgen.net/amo/v/ipvfoo"></picture>
<picture><img src="https://badgen.net/amo/users/ipvfoo"></picture>
<picture><img src="https://badgen.net/amo/rating/ipvfoo"></picture>

## Add to Edge
https://microsoftedge.microsoft.com/addons/detail/ipvfoo/dphnkggpaicipkljebciobedeiaiofod
*(You can also run the Chrome version on Edge, as they are identical.)*

## Safari?

IPvFoo cannot be [ported to Safari](https://github.com/pmarks-net/ipvfoo/issues/39) because the `webRequest` API does not report IP addresses.  In theory, a Safari extension could do its own DNS lookups over HTTPS, but such behavior is beyond the scope of IPvFoo.

## troubleshooting
### ipv4-only sites are shown as ipv6 when using nat64
set 'NAT64 Prefix' in the extension options

