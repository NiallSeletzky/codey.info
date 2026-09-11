"""Read public guestbook issues as data. Never run code or fetch guest URLs."""
import json
import re
import urllib.request
from datetime import datetime, timedelta, timezone

PREFIX = '[Flagon] '
RESERVED = {'mara', 'codey', 'percy', 'big', 'aldric', 'nix', 'editor', 'house', 'room'}


def guest(issue, tick):
    if 'pull_request' in issue or issue.get('state') != 'open':
        return None
    if any(label.get('name') == 'flagon-blocked' for label in issue.get('labels', [])):
        return None
    title = issue.get('title', '')
    if not title.startswith(PREFIX):
        return None
    handle = title[len(PREFIX):].strip()
    body = (issue.get('body') or '').strip()
    login = issue.get('user', {}).get('login', '')
    number = issue.get('number')
    if (not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9 _-]{0,23}', handle)
            or handle.lower() in RESERVED or not re.fullmatch(r'[A-Za-z0-9-]{1,39}(?:\[bot\])?', login)
            or type(number) is not int or number < 1 or not 1 <= len(body) <= 600
            or any(ord(c) < 32 and c not in '\n\t' for c in body)):
        return None
    try:
        created = datetime.fromisoformat(issue.get('created_at', '').replace('Z', '+00:00'))
        if created.tzinfo is None:
            return None
    except (ValueError, TypeError):
        return None
    return {'id': f'guest_issue_{number}', 'at': issue['created_at'], 'tick': tick,
            'handle': handle, 'kind': 'guest', 'reply_to': None, 'text': body,
            'identity': f'github:{login}', 'source_issue': number}


def collect(issues, ledger, tick):
    """At most three admissions, one per account per round, never replay an issue."""
    seen = set(ledger.get('processed', []))
    blocked = {s.lower() for s in ledger.get('blocked_accounts', [])}
    accounts = set()
    admitted = []
    for issue in sorted(issues, key=lambda i: i.get('number', 0)):
        number = issue.get('number')
        if number in seen:
            continue
        event = guest(issue, tick)
        if not event:
            continue
        account = event['identity'].lower()
        if account.removeprefix('github:') in blocked or account in accounts:
            continue
        admitted.append(event)
        accounts.add(account)
        seen.add(number)
        if len(admitted) == 3:
            break
    return admitted, {**ledger, 'processed': sorted(seen)}


def fetch_issues(repository, token):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('invalid repository')
    since = (datetime.now(timezone.utc) - timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ')
    # A fixed scan budget bounds API work even during a flood. Oldest of the
    # newest 100 eligible issues goes first. This is a small tavern, not a queue SLA.
    url = f'https://api.github.com/repos/{repository}/issues?state=open&sort=created&direction=desc&per_page=100&since={since}'
    req = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json',
        'Authorization': f'Bearer {token}', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(req, timeout=20) as response:
        data = json.loads(response.read(2_000_001))
    if not isinstance(data, list):
        raise ValueError('invalid issue response')
    return data
