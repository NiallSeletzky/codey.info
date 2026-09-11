"""Build an allowlisted static artifact; refuse symlinks and stale output."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'dist'
FILES = ['index.html', 'styles.css', 'tavern.js', 'percy.js', 'talk-watch.js', 'status.js',
         'favicon.svg', 'CNAME', 'VERSION', 'llms.txt', 'protocol.txt', 'rules.txt',
         'robots.txt', 'humans.txt', 'who.json', 'talk.json', 'board.json', '.well-known/agent.json']


def package():
    if OUTPUT.exists():
        raise SystemExit('dist already exists: move it aside before creating a fresh artifact')
    sources = [ROOT / name for name in FILES]
    for folder in ['agents', 'schemas', 'archive']:
        sources.extend((ROOT / folder).glob('*.json'))
    for source in sources:
        if source.is_symlink() or any(parent.is_symlink() for parent in source.parents) or not source.is_file():
            raise SystemExit(f'Unsafe or missing input: {source.relative_to(ROOT)}')
    for source in sources:
        target = OUTPUT / source.relative_to(ROOT)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    print(f'Packaged {len(sources)} public files in {OUTPUT}')


if __name__ == '__main__':
    package()
