#!/usr/bin/env python3
"""Build a deterministic, runtime-only unpacked Chrome extension ZIP."""
from pathlib import Path
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parent.parent
FILES = [
    'manifest.json', 'background.js', 'content.js', 'content.css', 'injected.js',
    'draft-storage.js', 'popup.html', 'popup.css', 'popup.js',
    'options.html', 'options.css', 'options.js', 'theme.js', 'ui.css',
    'assets/icon.svg', 'assets/icon-16.png', 'assets/icon-32.png',
    'assets/icon-48.png', 'assets/icon-128.png', 'LICENSE',
]


def validate(manifest):
    references = [manifest['background']['service_worker'],
                  manifest['action']['default_popup'], manifest['options_page']]
    references += list(manifest['icons'].values())
    references += list(manifest['action']['default_icon'].values())
    for script in manifest['content_scripts']:
        references += script.get('js', []) + script.get('css', [])
    for resource in manifest['web_accessible_resources']:
        references += resource['resources']
    for file in FILES:
        assert (ROOT / file).is_file(), f'Missing release file: {file}'
        if file.endswith('.html'):
            for reference in re.findall(r'(?:src|href)="([^"]+)"', (ROOT / file).read_text()):
                if not reference.startswith(('https:', 'http:', '#')):
                    references.append(str(Path(file).parent / reference))
    missing = set(references) - set(FILES)
    assert not missing, f'Referenced resources excluded from ZIP: {missing}'


def main():
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    validate(manifest)
    version = manifest['version']
    destination = ROOT / 'releases' / f'v{version}'
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / f'Salesforce-Draft-Guard-v{version}.zip'
    # A fixed timestamp and file ordering make repeated builds byte-identical.
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
        for relative in sorted(FILES):
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            package.writestr(info, (ROOT / relative).read_bytes(), compresslevel=9)
    with zipfile.ZipFile(archive) as package:
        assert package.testzip() is None, 'ZIP integrity check failed'
        assert set(package.namelist()) == set(FILES)
        for relative in FILES:
            assert package.read(relative) == (ROOT / relative).read_bytes(), relative
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n')
    print(f'{archive.relative_to(ROOT)}: {len(FILES)} files, {archive.stat().st_size:,} bytes')
    print(f'SHA-256: {digest}')


if __name__ == '__main__':
    main()
