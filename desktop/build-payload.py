"""Package a clean production runtime; business data is never an input."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import argparse
import hashlib
import subprocess

p = argparse.ArgumentParser()
for name in ['app', 'sdk', 'node', 'out', 'node-license']:
    p.add_argument('--' + name, required=True)
a = p.parse_args()
app, sdk, out = (Path(v).resolve() for v in [a.app, a.sdk, a.out])
out.mkdir(parents=True, exist_ok=True)
source = Path(__file__).resolve().parent
files = {}
for folder in ['server', 'dist']:
    assert (app / folder).is_dir(), 'Run npm run build before desktop packaging'
    for f in (app / folder).rglob('*'):
        if f.is_file():
            files[f.relative_to(app).as_posix()] = f
for name in ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']:
    files[name] = app / name
files['desktop-server.mjs'] = source / 'desktop-server.mjs'
files['node.exe'] = Path(a.node)
files['licenses/Node-LICENSE.txt'] = Path(a.node_license)
# npm supplies the installed production dependency graph, including hoisted modules.
result = subprocess.run(['npm.cmd', 'ls', '--omit=dev', '--all', '--parseable'],
                        cwd=app, capture_output=True, text=True, check=True)
for line in result.stdout.splitlines():
    module = Path(line.strip()).resolve()
    if module == app:
        continue
    assert module.is_relative_to(app / 'node_modules'), 'Dependency outside repository'
    assert module.is_dir(), 'Missing production dependency; run npm ci'
    for f in module.rglob('*'):
        if f.is_file():
            assert f.resolve().is_relative_to(app / 'node_modules'), 'External dependency symlink'
            files[f.relative_to(app).as_posix()] = f
for name in ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll']:
    files[name] = sdk / 'lib/net462' / name
files['WebView2Loader.dll'] = sdk / 'runtimes/win-x64/native/WebView2Loader.dll'
for name in ['LICENSE.txt', 'NOTICE.txt']:
    files['licenses/WebView2-' + name] = sdk / name
with ZipFile(out / 'payload.zip', 'w', ZIP_DEFLATED, compresslevel=6) as z:
    for name, f in sorted(files.items()):
        assert f.is_file(), 'Missing packaging input: ' + name
        assert not name.startswith(('data/', '../'))
        assert not name.lower().endswith(('.sqlite', '.sqlite-wal', '.sqlite-shm', '.db', '.log'))
        z.write(f, name)
digest = hashlib.sha256((out / 'payload.zip').read_bytes()).hexdigest()
(out / 'payload.sha256').write_text(digest, encoding='ascii')
print('PAYLOAD_OK', len(files), 'files,', (out / 'payload.zip').stat().st_size, 'bytes,', digest)
