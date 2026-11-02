# Tests

Open `iputil_test.html` in a browser to run the original IP parser tests.

The IPinfo service and message bridge tests use Node.js's built-in test runner:

```
npm ci
npm test
```

The browser tests use Playwright with isolated temporary profiles. They do not
access your regular browser profile or require an IPinfo token:

```
npx playwright install chromium
npm run test:browser
npm run test:popup
```

`test:browser` covers settings, local-address filtering, caching, worker restarts,
private-window suppression, metadata, flags, and full-address selection and
lookup. It also runs `iputil_test.html`. `test:popup` opens the actual toolbar
widget, checking content-dependent sizing at display scales 1x and 2x, including
long addresses, expanded domains, and delayed metadata. Reports and screenshots
are written to the ignored `build/validation/` directory.

The default browser is Playwright's full Chromium. Set `IPVFOO_TEST_BROWSERS` to
a comma-separated list of `chromium`, `chrome`, and/or `edge` to select other
installed browsers. Playwright resolves their normal installation paths. Custom
executables can be supplied through `IPVFOO_CHROMIUM_PATH`, `IPVFOO_CHROME_PATH`,
or `IPVFOO_EDGE_PATH`. Set `IPVFOO_TEST_HEADED=1` to show the test browser windows.
These tests require a browser version with the extension debugging protocol.

For an optional live API check, provide `IPINFO_TEST_TOKEN` in the process
environment when running `test:browser`. It queries public test addresses and
`example.com`, and clears the temporary profile's test settings afterwards.
Never put a real token in a test, command-line argument, or committed file.

The automated browser tests cover Chromium-based browsers. Firefox uses the
shared runtime code and its own manifest; these scripts do not test Firefox's
extension runtime or Android UI.
