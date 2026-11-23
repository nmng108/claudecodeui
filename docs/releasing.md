# Releasing

A release is made by merging a pull request. Nothing is published from a developer's machine.

## How it works

1. Commits reach `main` as [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, ...). With squash merges the **pull request title** is the commit, and CI checks it.
2. On every push to `main`, [release-please](https://github.com/googleapis/release-please) opens or updates one **release PR**. It bumps `package.json` and `package-lock.json` and writes `CHANGELOG.md` from the commits since the last release: `fix:` raises the patch version, `feat:` the minor, `feat!:` (or a `BREAKING CHANGE:` footer) the major.
3. Merging the release PR creates the tag `vX.Y.Z` and the GitHub Release. In the same workflow run (`.github/workflows/release.yml`) the rest follows:

```
package ─ smoke (amd64, arm64) ─ npm ─ app image (GHCR) ─ bundles (release assets)
            agent check ──────────┘
```

| Step | What it does |
|---|---|
| package | `npm run build`, then one `npm pack` tarball. Everything below uses that exact file. |
| smoke | Builds both images from the tarball on native amd64 and arm64 runners and starts them (`scripts/ci/smoke-image.sh`, `smoke-stack.sh`). Nothing is published if this fails. |
| npm | `npm publish` of the tarball with trusted publishing (OIDC). A version with a suffix such as `1.40.0-rc.1` goes to the `next` dist-tag. Skipped if the version is already on npm. |
| agent check | Fails the release if the ssh-agent image version in `docker/ssh-agent/version.json` is not in GHCR yet (see below). Nothing is published before this passes. |
| app image | Pushes `ghcr.io/<owner>/cloudcli` for both architectures as `X.Y.Z`, and also `X.Y`, `X` and `latest` when this release is the highest stable one of that line. Publishing an older release again does not move them. Prereleases get only the exact version. |
| bundles | Builds the offline image, starts it with no network (`smoke-offline.sh`), and attaches `cloudcli-deploy.tar.gz` and `cloudcli-offline-X.Y.Z-linux-amd64.tar.gz` (with `.sha256` files) to the release. |

## The ssh-agent image has its own version

`cloudcli-ssh-agent` changes much less often than the app, so it is not rebuilt per release. Its version is a counter in `docker/ssh-agent/version.json`, together with a hash of every file the image is built from (the files in `docker/ssh-agent/` and the two shared files `ssh-key-core.ts` and `ssh-agent-proxy.ts` under `server/modules/ssh-keys/`).

- CI fails a PR that changes any of those files without a new counter (`scripts/release/ssh-agent-version.sh check`). Fix it with `scripts/release/ssh-agent-version.sh bump` and commit `version.json`. A bump is therefore also the signal that the app and the agent must be released together.
- `ssh-agent.yml` publishes `cloudcli-ssh-agent:<counter>` (amd64 and arm64) when `version.json` changes on `main`, or when run by hand (Actions → ssh-agent image → Run workflow). A tag that already exists is skipped; tick **force** to rebuild and overwrite it, for example to pick up a security update of the base image. `latest` follows `main`.
- Each release's compose file names the counter it was released with. If you merge the release PR before the agent workflow has finished, the release stops at "agent check"; run it again once the image exists.

The tag is created by release-please inside this workflow because a tag created with `GITHUB_TOKEN` does not start other workflows.

## Making a release

Review and merge the open release PR. To pick the version yourself, put `Release-As: 2.0.0` in the body of a commit on `main`.

**Trying it without releasing.** Actions → Release → Run workflow, on any branch, with the tag field **empty**: a dry run that builds the package, both images and the offline image, starts them, builds both bundles and checks their size, and publishes nothing. Pull requests that touch `docker/` or `deploy/` run a lighter version of it (`docker-ci.yml`).

**Publishing a release again.** If a step failed, fix the cause and run the same workflow with the existing tag (for example `v1.39.0`). Every step can be repeated, with these limits: npm never replaces a published version, so that step is skipped; the images are rebuilt from the tag's files, so the `X.Y.Z` image may differ from the first one by updated base layers; and it only works for tags made after this pipeline existed, because the run uses the tag's own `docker/`, `deploy/` and `scripts/`.

## One-time setup

- **Actions permissions.** Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests".
- **`RELEASE_PAT` secret (recommended).** A fine-grained token with Contents and Pull requests read/write on this repository. Without it the release PR is created with `GITHUB_TOKEN`, and GitHub does not run CI on such PRs.
- **npm trusted publisher.** On npmjs.com, package `@namng108/cloudcli` → Settings → Trusted Publisher: repository `nmng108/claudecodeui`, workflow `release.yml`. The package has to exist first, so publish the very first version by hand (`npm publish --access public`) or with a temporary token. The workflow file name is part of the trust, so rename `release.yml` only together with that setting.
- **Make the images public.** After the first push of each (the agent image is published when `version.json` first lands on `main`, before the first release), GitHub → your profile → Packages → `cloudcli` and `cloudcli-ssh-agent` → Package settings → Change visibility → Public. A new package starts private, and only a public one can be pulled without logging in. The `org.opencontainers.image.source` label already links each package to this repository.

## The offline bundle

`docker/offline/Dockerfile` is the release image plus the language runtimes of `docker/mise.toml`, installed into `/opt/mise-baked` (see the comments in the file for why not into the `/mise` volume). The app image's tag is `X.Y.Z-offline` and the bundle's `docker-compose.yml` is stamped with it; the ssh-agent image keeps its own counter as the tag.

A release asset can be 2 GiB at most. The amd64 bundle is about 1.9 GB, so it is close: `build-deploy-bundle.sh` fails with the numbers if it grows past the limit. Before that, drop a JDK from `docker/mise.toml` or split `images.tar.gz` (`split -b 1900M`, and `cat` it back in `install.sh`).

The Kiro CLI sign-in and the Claude and Kiro services are not part of it: the machine still needs access to them.

## Not part of this flow

- `docker.yml` (manual) pushes the Docker Sandbox templates to Docker Hub under `cloudcliai/sandbox`. It uses credentials this repository may not have.
- `desktop-release.yml` (manual) attaches the desktop apps to an existing release.
- `release-it` and the `npm run release` script were removed; `release-it` and `@release-it/conventional-changelog` can be dropped from `devDependencies`.
