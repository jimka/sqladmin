---
depends-on: [publish-v0-1-0]
---

# Release SQLAdmin 0.1.0 to GHCR — Implementation Plan

## Overview

This plan performs the release itself: it tags `v0.1.0`, lets the workflow build and push the image, makes the GHCR package public, and confirms a stranger can pull it.

It is separated from [`publish-v0-1-0.md`](publish-v0-1-0.md) because every step here is **irreversible or externally visible**. A git tag pushed to a public remote cannot be quietly recalled, a pushed image tag is immutable, and flipping package visibility to public is a disclosure that cannot be undone. `publish-v0-1-0.md` builds and proves the release machinery without firing it; this plan fires it.

**No source files are modified.** The only possible edit is committing a regenerated `THIRD-PARTY-NOTICES.md` at step 1.

---

## Prerequisites

Do not begin until all of the following hold.

1. `plans/publish-v0-1-0.md` is fully implemented and its `## Verification` steps 1–7 are green. Those steps prove the image builds, serves both halves, and runs against the seeded database — locally, before anything is published.
2. `plans/harden-for-publication.md` is fully implemented. `publish-v0-1-0.md` depends on it, so this is transitively required, but it is stated here because the consequence of skipping it is shipping a publicly pullable image with an unthrottled login endpoint and a cookie that breaks off-localhost.
3. The working tree is clean and on `main`, with everything from both plans merged in.
4. **The operator has explicitly approved the release.** This plan publishes under the user's own GitHub account and name. It is not to be run as an automatic continuation of the preceding plans.

---

## Ordered Implementation Steps

1. **Regenerate the notices one final time.** Run `python3 scripts/generate_third_party_notices.py` and confirm `git diff --exit-code THIRD-PARTY-NOTICES.md` is clean. If the file did change, a dependency moved since the inventory was last generated — commit the regenerated file before tagging, so the notices shipped inside the image match the image's actual contents.

2. **Tag and push.** `git tag v0.1.0 && git push origin v0.1.0`. Watch the Actions run to completion; a failure here leaves the tag in place, so see `## If the workflow fails` below rather than re-tagging.

3. **Make the GHCR package public.** A package pushed under a user account is **private by default** — `docker pull` fails for everyone else until this is changed. In GitHub: the `sqladmin` package page → Package settings → Change visibility → Public. Confirm the package is linked to the repo; the `org.opencontainers.image.source` label emitted by `metadata-action` does this automatically.

4. **Confirm the published image** from a shell that is not authenticated to GHCR.

---

## Verification

Run after step 4, from a machine (or shell) not logged in to GHCR.

1. **Anonymous pull succeeds:** `docker logout ghcr.io && docker pull ghcr.io/jimka/sqladmin:0.1.0`.
2. **Multi-arch manifest:** `docker manifest inspect ghcr.io/jimka/sqladmin:0.1.0` lists both `linux/amd64` and `linux/arm64`.
3. **All three tags resolve:** `docker manifest inspect` succeeds for `ghcr.io/jimka/sqladmin:0.1.0`, `:0.1`, and `:latest`.
4. **The pulled image runs:** start it with an allowlist pointing at any reachable Postgres, load `http://localhost:8000`, and log in. This exercises the published artifact rather than a local build — the one check that cannot be performed before release.

   ```bash
   docker run --rm -d --name sqladmin-pub -p 8000:8000 \
     -e SQLADMIN_ALLOWED_HOSTS=<host>:5432 \
     ghcr.io/jimka/sqladmin:0.1.0
   curl -sI http://localhost:8000/ | head -1        # 200
   curl -s  http://localhost:8000/api/config        # presets JSON
   docker rm -f sqladmin-pub
   ```

---

## If the workflow fails

A pushed tag is public the moment it lands, and the image tags it produces are immutable. Do not delete and re-push `v0.1.0` — anyone who fetched the tag in between gets a different commit under the same name, and GHCR may refuse to overwrite an existing tag.

Fix forward: commit the fix on `main` and tag `v0.1.1`. The `0.1` and `latest` tags follow the newer release automatically, per the tag mapping in `publish-v0-1-0.md` Phase 4.

The one case worth pausing on is an arm64 build timeout under QEMU. The fix is to drop `linux/arm64` from `platforms` and release `v0.1.1` as amd64-only — not to move the Node stage back under emulation, which is what made the build affordable in the first place.

---

## Non-Goals

- **Deleting or moving a published tag.** Fix forward with a new patch version.
- **Announcing the release** anywhere. Out of scope.
- **A CHANGELOG or release-notes automation.** The git tag is the release marker, matching the sibling project.
