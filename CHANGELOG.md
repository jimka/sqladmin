# Changelog

All notable changes to SQLAdmin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-07-23

### Added
- **Persistent app header.** A brand strip above the menu bar now shows the app
  name and version at all times, with About access alongside it. The name,
  version, and tagline are sourced from a single `appIdentity` module, and the
  displayed version is injected from `package.json` at build time so it can
  never drift from the release.

### Changed
- **Faster table opens.** Opening a table coalesces and parallelizes its
  metadata fetches instead of requesting them serially.
- **Tab-first lazy loading.** The dock panels now open their tab immediately and
  load content lazily, so tabs appear instantly rather than blocking on their
  data.
- **Licensing clarified.** README, license, and third-party notices spell out
  the PolyForm Noncommercial terms — internal business use is barred, and
  commercial licenses are offered.

### Internal
- Migrated to `@jimka/typescript-ui` 0.2.0, including the new Size-object setter
  API.
- Standardized the app shell on callable component construction.
- `dev` and `build` now type-check before running.

## [0.1.0] — Initial release

First public release: browse schemas and roles, edit rows, run and EXPLAIN SQL,
and visualize schema and role relationships as diagrams.

[0.2.0]: https://github.com/jimka/sqladmin/releases/tag/v0.2.0
[0.1.0]: https://github.com/jimka/sqladmin/releases/tag/v0.1.0
