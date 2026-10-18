"""Fetch official build inputs using the configured HTTPS proxy, with timeouts."""
import argparse
import hashlib
from pathlib import Path
import re
import urllib.request
from zipfile import ZipFile

p = argparse.ArgumentParser()
p.add_argument('--sdk', required=True)
p.add_argument('--out', required=True)
p.add_argument('--node-version', required=True)
a = p.parse_args()
assert re.fullmatch(r'v\d+\.\d+\.\d+', a.node_version)
out = Path(a.out)
out.mkdir(parents=True, exist_ok=True)
sdk = Path(a.sdk)

def download(url, target):
    request = urllib.request.Request(url, headers={'User-Agent': 'Yundaizhang-build/1.0'})
    with urllib.request.urlopen(request, timeout=60) as response:
        content = response.read()
    target.write_bytes(content)
    return content

if not (sdk / 'lib/net462/Microsoft.Web.WebView2.Core.dll').is_file():
    archive = out / 'webview2-sdk.zip'
    content = download('https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/'
                       '1.0.4258.31/microsoft.web.webview2.1.0.4258.31.nupkg', archive)
    assert hashlib.sha256(content).hexdigest() == '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9', 'WebView2 SDK checksum mismatch'
    with ZipFile(archive) as z:
        for name in z.namelist():
            assert (sdk / name).resolve().is_relative_to(sdk.resolve()), 'Invalid archive path'
        z.extractall(sdk)
download(f'https://raw.githubusercontent.com/nodejs/node/{a.node_version}/LICENSE',
         out / 'Node-LICENSE.txt')
print('Official SDK and runtime license ready')
