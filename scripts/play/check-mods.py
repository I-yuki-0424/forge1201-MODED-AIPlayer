#!/usr/bin/env python3
"""Check the jars of the play world before the server starts (advisory; the server is the final judge).

  scripts/play/check-mods.py [DIR]          DIR defaults to /mnt/data/forgeaip-play (reads mods/ and client-only/)

Per jar it reads META-INF/mods.toml (Forge 1.20.1): mod id, version, the Minecraft and Forge ranges it asks for, and its
mandatory dependencies. It reports, and exits 1 on, problems that stop a server from starting:
  - a jar that is not a Forge mod, or asks for a Minecraft other than 1.20.1 / a Forge outside 47.x
  - two jars with the same mod id in mods/
  - a mandatory dependency (other than minecraft, forge) that no jar in mods/ provides (nested jar-in-jar mods are read too)
  - a jar in mods/ that looks client-only (known client libraries, or its mods.toml declares every dependency side=CLIENT)
It cannot know whether a mod is client-only for certain: if the server crashes on startup with a message about a class in
net.minecraft.client, move that jar to client-only/ and start again. Standard library only.
"""
import io, json, re, sys, tomllib, zipfile
from pathlib import Path

CLIENT_HINT = re.compile(r'(embeddium|rubidium|sodium|oculus|iris|optifine|entityculling|immediatelyfast|xaero|journeymap|jei|rei|emi|'
                         r'shader|dynamic[-_]?lights|lambdynlights|sound[-_]?physics|presence|notenoughanimations|better[-_]?(?:third|f3)|'
                         r'mouse[-_]?tweaks|controlling|configured|catalogue|skinlayers|appleskin|jade|wthit|waila)', re.I)

def read_mods(z: zipfile.ZipFile, depth=0):
    """Yield (modId, version, deps[list of dict], jar-name) for a jar and the jars nested in META-INF/jarjar."""
    out = []
    try:
        toml = tomllib.loads(z.read('META-INF/mods.toml').decode('utf-8', 'replace'))
    except KeyError:
        toml = None
    except Exception as e:                                   # a broken toml is a finding, not a crash of the checker
        return [('?', '?', [], f'unreadable mods.toml: {e}')]
    if toml:
        deps = toml.get('dependencies', {})
        for m in toml.get('mods', []):
            out.append((m.get('modId'), str(m.get('version', '?')), deps.get(m.get('modId'), []), toml.get('loaderVersion', '')))
    if depth < 2:
        for n in z.namelist():
            if n.startswith('META-INF/jarjar/') and n.endswith('.jar'):
                try:
                    out += read_mods(zipfile.ZipFile(io.BytesIO(z.read(n))), depth + 1)
                except Exception:
                    pass
    return out

def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else '/mnt/data/forgeaip-play')
    mods, client = root / 'mods', root / 'client-only'
    problems, warnings, provided, per_jar = [], [], {}, []
    jars = sorted(mods.glob('*.jar')) if mods.is_dir() else []
    if not jars:
        print(f'{mods}: no jars (vanilla Forge server). Put server-side mods there.')
    for j in jars:
        try:
            z = zipfile.ZipFile(j)
        except Exception as e:
            problems.append(f'{j.name}: not a readable jar ({e})'); continue
        found = read_mods(z)
        if not found:
            problems.append(f'{j.name}: no META-INF/mods.toml (not a Forge 1.20.1 mod; Fabric/NeoForge jars do not load here)'); continue
        per_jar.append((j, found))
        for mid, ver, deps, _ in found:
            if mid in provided and provided[mid][1] != j.name and not str(provided[mid][1]).startswith('nested'):
                problems.append(f'{j.name}: mod id {mid} is also in {provided[mid][1]}')
            provided.setdefault(mid, (ver, j.name))
    for j, found in per_jar:
        top = found[0]
        if CLIENT_HINT.search(j.name) or CLIENT_HINT.search(str(top[0])):
            warnings.append(f'{j.name}: looks client-only; if the server stops with a net.minecraft.client error move it to {client}/')
        for mid, ver, deps, _ in found:
            sides = []
            for d in deps:
                dm = d.get('modId')
                if dm in ('minecraft', 'forge'):
                    vr = str(d.get('versionRange', ''))
                    if dm == 'minecraft' and vr and not re.search(r'1\.20(\.1)?\b|1\.20,', vr):
                        problems.append(f'{j.name}: asks for minecraft {vr}')
                    if dm == 'forge' and vr and not re.search(r'47|\[?4[0-7]', vr):
                        warnings.append(f'{j.name}: asks for forge {vr} (server is 47.4.10)')
                    sides.append(d.get('side', 'BOTH'))
                    continue
                if d.get('mandatory', d.get('type') == 'required') and dm not in provided:
                    problems.append(f'{j.name}: mandatory dependency {dm} {d.get("versionRange", "")} is not in mods/')
            if sides and all(s == 'CLIENT' for s in sides):
                warnings.append(f'{j.name}: declares itself client-side (side=CLIENT) in mods.toml')
    cj = sorted(client.glob('*.jar')) if client.is_dir() else []
    print(json.dumps({'server_jars': len(jars), 'client_only_jars': len(cj), 'mod_ids': len(provided)}))
    for w in warnings: print('warning:', w)
    for p in problems: print('PROBLEM:', p)
    return 1 if problems else 0

if __name__ == '__main__':
    sys.exit(main())
