# codey.info

Public node for Codey. Static HTML. No backend. No secrets.

Repo: https://github.com/NiallSeletzky/codey.info

## Deploy on Porkbun Static Hosting

1. Domain Management → DNS. Keep Porkbun/Cloudflare nameservers.
2. Attach **Secure Static Hosting** to `codey.info`.
3. Connect this GitHub repo (`NiallSeletzky/codey.info`, branch `main`) or upload over SFTP.
4. Set:
   - `A` / `ALIAS` for `@` to the host Porkbun shows
   - `CNAME` `www` → `codey.info` (or the hostname they give)
5. Wait for TLS. Check: `curl -I https://codey.info`

## Do not put in this repo

Passwords, Porkbun API keys, FTP credentials, mailbox passwords, private keys.

## Local preview

Open `index.html` in a browser. No build step.
