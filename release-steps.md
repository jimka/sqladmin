# Steps to take when releasing a new version

## Update version string

Frontend and backend are always bumped together, to the same version. Update
version in the following files:
- frontend/package.json
- backend/pyproject.toml

If a new `@jimka/typescript-ui` version is being picked up in this release,
also bump its version in frontend/package.json's dependencies.

Run `npm install --package-lock-only` in frontend/ to update
frontend/package-lock.json.

Also bump the pinned `image:` tag in docker-compose.yml's `app` service to
`ghcr.io/jimka/sqladmin:X.Y.Z`. It's a plain string, not derived from
anything else in the repo, so nothing else catches this if it's missed —
`docker compose pull` silently keeps serving whatever version it last
pointed at (this went unbumped from 0.1.0 all the way to 0.6.0 before
being caught).

## Changelog

Add a new `## [X.Y.Z] — YYYY-MM-DD` section to the top of CHANGELOG.md
(above the previous release), grouped into Added / Changed / Fixed /
Internal as needed, and add the matching
`[X.Y.Z]: https://github.com/jimka/sqladmin/releases/tag/vX.Y.Z` link at the
bottom of the file. Unlike the library, there is no per-version file or
index to maintain — CHANGELOG.md is the only place this lives, and the
in-app Changelog dialog inlines it directly at build time.

## Third-party notices

Run `python3 scripts/generate_third_party_notices.py` and confirm
`git diff --exit-code THIRD-PARTY-NOTICES.md` is clean afterwards. If the
file changed, a dependency moved since it was last generated — commit the
regenerated file so the notices shipped inside the image match its actual
contents.

## Verify publish readiness

Verify that the changelog looks OK and contains everything in the coming
version.

Run:
- `cd backend && poetry run pytest`
- `cd backend && poetry run pyright`
- `cd frontend && npm run typecheck && npm test`
- `cd frontend && npm run build`

And make sure everything looks OK!

Run from the repo root, to validate the release image builds correctly:
- `docker build -t sqladmin-release-check .`

## Publish

Commit and push the version bump (package/lock files, CHANGELOG.md,
THIRD-PARTY-NOTICES.md).

`git tag vX.Y.Z && git push origin vX.Y.Z`

There is no separate publish step to run by hand: pushing the tag triggers
`.github/workflows/release.yml`, which builds a multi-arch (amd64/arm64)
image straight from the repo and pushes it to `ghcr.io/jimka/sqladmin`
tagged `X.Y.Z`, `X.Y`, and `latest`. Watch the Actions run to completion —
a failure there leaves the tag in place, so fix forward with a new tag
rather than re-tagging.
