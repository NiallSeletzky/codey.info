"""Preview allowlisted public files without exposing repository or secrets."""
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ['portal']

def copy_public(target):
    for name in ASSETS:
        source = ROOT / name
        if not source.exists():
            raise SystemExit(f'Missing public asset: {name}')
        files = list(source.rglob('*')) if source.is_dir() else [source]
        if source.is_symlink() or any(item.is_symlink() for item in files):
            raise SystemExit(f'Symlink refused: {name}')
        if source.is_dir():
            destination = target if name in ('public', 'portal') else target / name
            shutil.copytree(source, destination, dirs_exist_ok=True)
        else:
            shutil.copyfile(source, target / name)
    if not (target / 'index.html').is_file():
        raise SystemExit('Missing index.html')

if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else '4173'
    if mode == '--build':
        output = ROOT / 'dist'
        output.mkdir(exist_ok=False)
        copy_public(output)
        print(f'Built {output}; move it aside before rebuilding.')
    else:
        with tempfile.TemporaryDirectory(prefix='website-preview-') as temporary:
            copy_public(Path(temporary))
            if mode == '--check':
                print('Public assets checked successfully')
            else:
                server = ThreadingHTTPServer(('127.0.0.1', int(mode)), partial(SimpleHTTPRequestHandler, directory=temporary))
                print(f'Preview: http://127.0.0.1:{mode} (restart after edits)', flush=True)
                try:
                    server.serve_forever()
                except KeyboardInterrupt:
                    pass
                finally:
                    server.server_close()
