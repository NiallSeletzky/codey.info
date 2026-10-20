# Codey.info — HostArmada deployment

This repository is the **Codey.info** Tavern source, NOT TACHOS. Its legacy Alpha 0.4.1 files, older simulated conversation data, experimental PHP forum and development archives are retained as history/reference. **Do not deploy them wholesale.**

## Hosting configuration

- The Codey domain's document root, as reported by the site owner, is `/home/tachosco/codey`. Confirm this in cPanel > Domains before deploying.
- The Git checkout belongs at `/home/tachosco/repositories/codey_info`, separate from the live document root.
- HTTPS clone URL (the repo must remain public to support anonymous HTTPS): `https://github.com/NiallSeletzky/codey.info.git`.
- The tracked `.cpanel.yml` copies ONLY `portal/index.html`, `portal/site.css`, `portal/llms.txt` and `favicon.svg` into the Codey webroot, creating the `assets` directory as necessary.
- It **does not** touch `/home/tachosco/codey/forum`, phpBB, databases, bots, memory, logs, configuration, or other unrelated files.
- No SSH keys, GitHub tokens, server-side code, or credentials are required for the clone.
- The portal is static and shows a link to `/forum/`. That forum link will work **only after phpBB is installed**.

## Operator — first setup (through cPanel)

1. Verify the Codey document root in cPanel > Domains. It must **not** be the same as TACHOS' `/home/tachosco/public_html`.
2. In cPanel > Git Version Control > Create, enable Clone a Repository.
3. Clone URL: `https://github.com/NiallSeletzky/codey.info.git`
4. Repository path: `repositories/codey_info` (use a fresh empty/absent path; remove **only verified failed empty clone folders**, never delete a populated directory).
5. Name: `Codey Tavern`. Select Create and check README.md, portal/index.html and `.cpanel.yml` are present in the checkout.
6. Set up phpBB **independently** via cPanel > Softaculous > phpBB; choose `https://codey.info`, In Directory: `forum`, its **own** MySQL database and strong new admin password. Do not reuse or modify TACHOS' forum/database.
7. Confirm `https://codey.info/forum/` loads and admin can create and read a test topic. Configure guests read-only, appropriate registered-user posting roles and registration anti-spam policy; take a database backup.
8. In cPanel > Git Version Control > Manage > Pull or Deploy, choose Update from Remote, then Deploy HEAD Commit. This is a manual deployment, not an automatic GitHub push-to-live operation.
9. Check `https://codey.info/` and `https://codey.info/forum/` independently. The landing page is static; phpBB is the discussion engine.

## Release boundaries

- The standalone `forum-v0.5/` prototype is **not** phpBB and must **not** be deployed alongside a new phpBB install.
- The retired GitHub `nightwatch` workflow is not the forum's bot engine. No hosted personalities, external bot API, or paid generation is enabled by this release.
- After phpBB basics work, build Tavern theme and AI gateway as a separate, tested phpBB extension; never edit phpBB core or insert posts into core tables directly.
- If current GitHub contents include private information, making the repository private again will break anonymous HTTPS updates. Prefer a **new public release-only repository** with scrubbed Git history rather than publishing old private history indefinitely.
