#!/usr/bin/env python3
"""The forgeaip-create mod set from its lock file (TASK-20261031-020): vanilla + Create + optimisation only.

  pack.py server <mods-dir>    make <mods-dir> hold exactly the server jars of the lock (sha512-checked, others removed)
  pack.py mrpack <out.mrpack>  client pack for the Modrinth App / Prism Launcher (installs Forge and the client jars)
  pack.py list                 the set, one line per jar

Every jar is checked against the sha512 in the lock; a mismatch stops before anything is replaced.
"""
import hashlib
import json
import os
import sys
import tempfile
import urllib.request
import zipfile

LOCK = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'forgeaip-create.lock.json')
UA = 'forgeaip/1.0 (github.com/I-yuki-0424/forge1201-MODED-AIPlayer)'


def load():
    with open(LOCK, encoding='utf-8') as f:
        return json.load(f)


def fetch(mod, dest_dir):
    """Download one jar into dest_dir unless an identical file is already there."""
    path = os.path.join(dest_dir, mod['file'])
    if os.path.exists(path) and sha512(path) == mod['sha512']:
        return False
    req = urllib.request.Request(mod['url'], headers={'User-Agent': UA})
    fd, tmp = tempfile.mkstemp(dir=dest_dir, suffix='.part')
    try:
        with os.fdopen(fd, 'wb') as out, urllib.request.urlopen(req, timeout=120) as r:
            while chunk := r.read(1 << 20):
                out.write(chunk)
        if sha512(tmp) != mod['sha512']:
            raise SystemExit(f"{mod['file']}: sha512 does not match the lock, nothing replaced")
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
        return True
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def sha512(path):
    h = hashlib.sha512()
    with open(path, 'rb') as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def server(mods_dir):
    lock = load()
    want = [m for m in lock['mods'] if m['side'] in ('both', 'server')]
    os.makedirs(mods_dir, exist_ok=True)
    for m in want:
        print(f"{'fetched' if fetch(m, mods_dir) else 'kept   '} {m['file']}")
    keep = {m['file'] for m in want}
    for f in sorted(os.listdir(mods_dir)):
        if f.endswith('.jar') and f not in keep:
            os.unlink(os.path.join(mods_dir, f))
            print(f'removed {f}')


def mrpack(out):
    lock = load()
    index = {
        'formatVersion': 1, 'game': 'minecraft', 'versionId': lock['pack_version'], 'name': lock['name'],
        'summary': 'Vanilla + Create + optimisation; matches the forgeaip build world',
        'files': [{
            'path': f"mods/{m['file']}", 'hashes': {'sha1': m['sha1'], 'sha512': m['sha512']},
            'env': {'client': 'required', 'server': 'unsupported' if m['side'] == 'client' else 'required'},
            'downloads': [m['url']], 'fileSize': m['size'],
        } for m in lock['mods'] if m['side'] in ('both', 'client')],
        'dependencies': {'minecraft': lock['minecraft'], 'forge': lock['forge']},
    }
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('modrinth.index.json', json.dumps(index, indent=2))
    os.chmod(out, 0o644)
    print(f"{out}: {len(index['files'])} jars, Forge {lock['forge']}")


def main(argv):
    if argv[:1] == ['server'] and len(argv) == 2:
        server(argv[1])
    elif argv[:1] == ['mrpack'] and len(argv) == 2:
        mrpack(argv[1])
    elif argv == ['list']:
        for m in load()['mods']:
            print(f"{m['side']:6} {m['file']:45} {m['why']}")
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
