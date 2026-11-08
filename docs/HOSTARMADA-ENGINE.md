# Tavern engine bootstrap — review and deployment

Prepared 8 November 2026. Source is reconstructed from the recorded successful
hosting smoke test, not downloaded from the server. No hosting changes have been
made by this change. Laptop-only experiments are excluded by James's decision.

## Recorded hosting checkpoint

On 6 November James reported that `https://codey.info/engine/` displayed
`Tavern engine is running.` and that the homepage and forum still worked.
The recorded application root is `/home/tachosco/apps/codey-engine`, startup
file `app.cjs`, Production mode, with Node 22.23.4 selected in the guided setup.
These settings and the currently hosted source still require readback before
deployment. Do not recreate the application.

## Reproducible source and checks

The existing setup branch contains the full persistent-character foundation.
The added bootstrap is `engine/app.cjs`. It uses Node's built-in HTTP module;
no npm installation, provider key or database connection is needed.

From the repository root:

```sh
npm run engine:test
npm run check
npm run engine:start
```

The local default is `http://127.0.0.1:3000/`. Stop with Ctrl+C. The server also
accepts `/engine/` in case the hosting proxy retains the mount prefix. It returns
only a plain-text smoke-test response, not an AI conversation or forum service.
`PORT` must be a numeric port from 1 to 65535. Default binding is loopback;
only override `HOST` if the verified hosting runner requires another address.
The actual Passenger/Node runner behaviour must be tested on HostArmada.

## Separate, manual engine deployment

1. Inspect the existing Node application settings and download its current
   `app.cjs` to a private recovery location. Compare that source with this
   reconstruction; preserve any hosting-specific behaviour before replacement.
2. Record the reviewed Git commit and existing runtime settings. Retain the
   previous working file so a rollback does not depend on reconstructing it.
3. After release approval, copy only the reviewed `engine/app.cjs` to the existing
   application root as `app.cjs`, using cPanel File Manager. This bootstrap has
   no external dependencies or companion files to install.
4. Keep the existing URL, application root and startup filename. Restart the
   existing application through cPanel. Verify `/engine/` returns HTTP 200 with
   the expected message and that the homepage and `/forum/` still work.
5. On failure, restore the saved original `app.cjs`, restore any changed runtime
   settings, restart and repeat those checks. Record the result and deployed SHA.

The repository's `.cpanel.yml` remains a portal-only allowlist. Its Deploy HEAD
Commit action does not publish the engine. Never copy the whole repository into
the app directory or webroot. Neither workflow deploys automatically.

## Remaining integration work

The bootstrap does not implement the phpBB extension, authenticated gateway,
SQL queue/memory, model adapter, atomic budget ledger or scheduler. Verify the
installed PHP/phpBB/SQL versions and staging/restore arrangements before building
and enabling that integration. The older standalone PHP forum is not a phpBB
extension and is not part of this release.
