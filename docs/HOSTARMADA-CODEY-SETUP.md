# HostArmada checklist — codey.info / Rusty Flagon

This is **not** the TACHOS website. TACHOS already deploys from a different repository. A GitHub repository does not automatically link itself to a domain.

## A. Check the domain in cPanel

1. Open HostArmada → **cPanel → Domains**.
2. Find **codey.info** (not Cody). Confirm HTTPS is assigned and that its **Document Root** does not equal the TACHOS root `/home/tachosco/public_html` and does not have **Share document root** enabled.
3. Record the exact existing document root. **Do not guess it and do not change it while phpBB or other files are present**.
4. If missing from cPanel, add `codey.info` as a separately rooted addon/registered domain; this does not require transferring the registration from Porkbun. DNS still needs to point at HostArmada.

## B. Link the existing GitHub source (safe clone only)

- In cPanel → **Git Version Control**, check whether the repository URL `https://github.com/NiallSeletzky/codey.info.git` already appears. If it does, do not create a duplicate; inspect branch/path.
- If not, click **Create**, turn on **Clone a Repository**, and enter:
  - Clone URL: `https://github.com/NiallSeletzky/codey.info.git`
  - Repository Path: `/home/tachosco/repositories/codey-info` (provided this path is available and the cPanel account is `tachosco`)
  - Repository Name: `codey-info`
- The checkout belongs **outside** the website's public document root. Cloning does **not** publish it to the domain.
- **Do not click Deploy HEAD Commit** for this clone yet. GitHub `main` contains the old 0.4.1 nightwatch version. No safe reviewed public deployment mapping exists yet.
- To publish later we will choose a release branch, confirm the actual root and add an explicit, allowlisted `.cpanel.yml`. If we continue with cPanel pull deployment, updating GitHub still requires **Update from Remote → Deploy HEAD Commit**.

## C. Install phpBB separately

1. In cPanel → **Softaculous Apps Installer**, find **phpBB**.
2. Set `https://`, domain `codey.info`, installation directory `forum` (not `/forum` or `public_html/forum`).
3. Use a **new database and admin login**; do not reuse the TACHOS phpBB installation or database.
4. Visit `https://codey.info/forum/`; confirm admin access, a sample topic, viewing permissions, and correct mobile display.
5. Disable public registration initially or use approval/email verification, guest read-only, strong admin credentials and backups until moderation is configured.
6. Do not post credentials or the installation password in issues, commits or chat.

## D. Stop here

Before changing Git branches, making a homepage deployment or enabling autonomous AI, report:
- Codey document root (a path, **not a password**);
- Whether the separate `codey-info` Git checkout exists;
- Whether the new phpBB forum loads at `/forum/`.

The account path above follows TACHOS' known cPanel username, **but Codey's document root must be verified**. Do not deploy from the old `main` branch just because cPanel can clone it.
