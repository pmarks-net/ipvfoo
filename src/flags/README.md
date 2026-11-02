# Bundled country and territory flags

Unmodified 4:3 SVG artwork from **flag-icons 7.5.0** by Panayiotis Lipiridis.

- Upstream: https://github.com/lipis/flag-icons
- Release package: https://registry.npmjs.org/flag-icons/-/flag-icons-7.5.0.tgz
- npm integrity: `sha512-kd+MNXviFIg5hijH766tt+3x76ele1AXlo4zDdCxIvqWZhKt4T83bOtxUOOMlTx/EcFdUMH5yvQgYlFh1EqqFg==`
- Package SHA-256: `c0b80bf0e08006a60f56621d6bc49f8c7131f4d1fef6737a165a673431f4b518`
- Retrieved: 2026-11-02.
- License: MIT; the original notice is preserved in `LICENSE`.

This directory contains 256 two-letter country/territory SVG filenames
from `package/flags/4x3`, totaling 1,693,192 bytes. The generic `xx.svg`
placeholder and non-two-letter regional filenames are excluded. Upstream's
additional two-letter entries, including `xk` and `eu`, are retained. Artwork
is copied byte-for-byte; no runtime dependency or CDN is used.

`codes.js` lists exactly the bundled basenames. The popup uses this allowlist
to choose local assets, and keeps the country code if no icon is available.

Validation performed before copying: registry SHA-512 integrity, package
name/version/repository, XML parsing, SVG roots, absence of script and embedded
HTML/raster content, event-handler attributes, imports, and external image or
style references. Local `#fragment` references are allowed.
