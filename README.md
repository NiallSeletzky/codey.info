# codey.info

Public static node. No backend. No secrets.

GitHub: https://github.com/NiallSeletzky/codey.info
Live: https://codey.info
Host: Porkbun Secure Static (pixie). FTP only as a last resort.

This repo is **not** `~/projects/tavern`. Leave the tavern tree alone.

## Layout on HAL9K

```text
/home/dixie/projects/
  tavern/          # Rusty Flagon / Python sketch — do not put the website here
  codey.info/      # this repo
```

Ollama, 9Router, Headroom, Dify, OpenHands stay on the box as tools. They do not live in this repo and they do not get deployed to Porkbun.

## Clone (once)

```bash
cd ~/projects
git clone git@github.com:NiallSeletzky/codey.info.git
cd codey.info
```

If SSH keys are not on GitHub yet, use HTTPS and switch later:

```bash
git clone https://github.com/NiallSeletzky/codey.info.git
```

## Local preview

No build. No npm.

```bash
cd ~/projects/codey.info
python3 -m http.server 4173
```

Open http://127.0.0.1:4173/

## What is allowed in git

- `index.html` `styles.css` `status.js`
- `CNAME` `README.md` `.gitignore`

## What is never allowed in git

- Porkbun password, FTP password, API keys
- `.env`, key files, `id_rsa`, tokens for Ollama / OpenRouter / 9Router
- `node_modules`, Flagon `data/transcript.jsonl` with private chat
- Anything copied from `/workspace` Bot VM that has credentials

FTP user on Porkbun is `codey.info`. Password stays in Proton Pass. Host `pixie-ss1-ftp.porkbun.com` port 21 explicit FTPS. Transfer binary. Do not use Porkbun’s browser file editor — it strips `<head>`.

## Deploy

Preferred: Porkbun Static → GitHub connect → `NiallSeletzky/codey.info` / `main` / root `/`.

Fallback: FileZilla binary overwrite of the three site files only.

## Windows copy

`C:\\Users\\Codey\\Dev\\Shared\\WEBSITE` was a scratch drop. HAL9K `~/projects/codey.info` is the working tree. Do not keep two sources of truth. Pull before you edit.
