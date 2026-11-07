# Website workspace

Each website has an independent Git repository and release lifecycle. Existing directory names are retained to avoid breaking integrations.

| Domain | Directory | GitHub | Preview |
| --- | --- | --- | --- |
| codey.info | codey.info/ | NiallSeletzky/codey.info | localhost:4173 |
| tachos.co.uk | tachos/ | NiallSeletzky/tachos | localhost:4174 |
| mythai.homes | mythai.homes/ | NiallSeletzky/mythai.homes | localhost:4175 |

Open websites.code-workspace in VS Code for all three projects. In each repository use Node.js 22 (`nvm use` if nvm is installed), Python 3, `npm run dev`, and `npm run check`. There are no root npm dependencies to install. Previews bind to loopback and serve only public assets; restart after edits.

Codey's preview shows portal/, its current homepage. Its existing Node.js backend stays in engine/: `npm run engine:test` and `npm run engine:start`. The historical root static site has its existing `npm run build`; see HOSTARMADA_DEPLOY.md for the current portal deployment.

Tachos and MyThai build allowlisted public files to dist/. Existing dist directories are preserved: move old output aside before building again. MyThai's public/ contains a local placeholder pending import of its real source.

Work on feature branches, commit named files, fetch origin, inspect divergence and push without force. Existing uncommitted Codey work and legacy tavern/ and tavernA/ checkouts must be reviewed separately; do not overwrite them or merge them blindly. Do not commit .env, hosting credentials, generated artifacts or database exports. Setup does not change hosting, DNS or production branches.
