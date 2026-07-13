# Releasing Attic

Releases are published from GitHub Actions to the public npm registry. The release workflow verifies the package on Node.js 24, requires a `v<package-version>` GitHub release tag, and publishes stable versions under `latest` and prereleases under `next`.

## First npm publication

npm requires a package to exist before it can be connected to a trusted publisher. On npmjs.com, create a short-lived granular access token with **Read and write**, **All Packages**, and **Bypass two-factor authentication** enabled. All Packages is necessary because the new package cannot be selected yet. Store the token as the `NPM_TOKEN` secret in the repository's `npm` environment:

```sh
gh secret set NPM_TOKEN --repo softzer0/attic --env npm
```

Enter the token only at the prompt. Never place it in a command, file, issue, or workflow.

Confirm that CI is green, then publish a GitHub release whose tag exactly matches `v<version>` from `package.json`. For example:

```sh
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 --repo softzer0/attic --verify-tag --generate-notes
```

The release workflow runs the complete package checks and publishes with npm provenance.

The `npm` environment accepts only `v*` tags and requires approval from `softzer0` before the publish job starts.

## Enable trusted publishing

After the first version exists on npm, open the package settings on npmjs.com and add a GitHub Actions trusted publisher with these exact values:

- Organization or user: `softzer0`
- Repository: `attic`
- Workflow filename: `release.yml`
- Environment: `npm`
- Allowed action: `npm publish`

Delete the bootstrap secret after the trusted publisher is active:

```sh
gh secret delete NPM_TOKEN --repo softzer0/attic --env npm
```

Future releases use short-lived OpenID Connect credentials and require no npm token. Trusted publishing requires npm 11.5.1 or newer and a GitHub-hosted runner; the workflow installs npm 11 on Node.js 24 to satisfy that contract.

## Subsequent releases

1. Update `version` in `package.json` and add the matching changelog entry.
2. Run `pnpm install --lockfile-only` if the package version changes the lockfile importer.
3. Run `pnpm check` and push the release commit.
4. Create and push the matching `v<version>` tag.
5. Publish the GitHub release for that tag.
6. Verify the `Release` workflow, npm package page, provenance, and dist-tag.

The workflow can be run manually from the Actions tab to verify a branch without publishing. Only a published GitHub release invokes the npm job.
