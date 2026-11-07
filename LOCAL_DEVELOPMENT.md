# Local development

Use Node.js 22 (`nvm use` if nvm is installed) and Python 3. The root package has no npm dependencies.

- `npm run dev`: preview the current portal homepage at http://127.0.0.1:4173.
- `npm run check`: validate the public preview assets.
- `npm run engine:start`: start the existing Node.js engine.
- `npm run engine:test`: run the engine tests.
- `npm run build`: package the historical root static site using the existing packaging script; preserve or move an existing dist/ first.

The preview serves an isolated copy of portal/, binds only to loopback, and needs restarting after edits. See HOSTARMADA_DEPLOY.md for current deployment instructions. phpBB is an independently managed PHP application and is not provided by the preview.

The sibling projects are ../tachos (port 4174) and ../mythai.homes (port 4175). Open ../websites.code-workspace for all three; ../WEBSITES.md records the layout. Each website has its own Git repository. Legacy ../tavern and ../tavernA checkouts are preserved pending history review.

Commit only intended changes, fetch and inspect before pushing, and never force push to resolve divergence. Existing work in this checkout predates this setup and should be reviewed separately.
