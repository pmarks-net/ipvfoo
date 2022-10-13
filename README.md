**IPvFoo** is a Chrome extension that adds an icon to your location bar, indicating whether the current page was fetched using IPv4 or IPv6. When you click the icon, a pop-up appears, listing the IP address for each domain that served the page elements.

Everything is captured privately using the webRequest API, without creating any additional network traffic.

## Manifest v3 bug?

I rewrote IPvFoo for Manifest V3 because Google is mandating it soon, but there is a bug (suspecting [crbug/1316588](https://bugs.chromium.org/p/chromium/issues/detail?id=1316588)) where Chrome forgets to send events to MV3 extensions after a day or two.  The easiest workaround is: Right-click the IPvFoo icon > Manage extension > turn it off and on again.

## Add to Chrome link
https://chrome.google.com/webstore/detail/ipvfoo/ecanpcehffngcegjmadlcijfolapggal

## Screenshot:
![Screenshot](/misc/screenshot_webstore_640x400.png?raw=true)

## Firefox Support:
IPvFoo now [runs on Firefox](https://addons.mozilla.org/firefox/addon/ipvfoo-pmarks/), but there are [a few bugs](https://github.com/pmarks-net/ipvfoo/issues/32) to work out.
