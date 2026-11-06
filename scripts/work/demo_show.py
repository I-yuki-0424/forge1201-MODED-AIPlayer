#!/usr/bin/env python3
"""Guided demonstration of the BOT TODO batch (TASK-20261106-040) for the owner to WATCH in game, driven through the demo console's own API
(the bots appear in the console page). Narrates in chat (tellraw) and logs what it checked on the server. Throwaway/test code.

  cd /mnt/data/forgeaip-play/demo && python3 /home/coder/projects/forge1201-MODED-AIPlayer/scripts/work/demo_show.py [--watcher Seia_Y]

Needs the demo server and its console running (./up.sh --console). Scenes: 1 pit with direct pickup, 2 range audit, 3 defence, 4 full inventory
(discard), 5 problem bot glows and recovers, 6 move_to up a wall.
"""
import http.client, json, subprocess, sys, time, os

DEMO = os.environ.get('DEMO_DIR', '/mnt/data/forgeaip-play/demo')
WATCH = sys.argv[sys.argv.index('--watcher') + 1] if '--watcher' in sys.argv else 'Seia_Y'
BX, BZ, TOP = 2000, 2000, -51                 # arena: stone slab x/z 1998..2040, y -60..-51
BOX = dict(x0=BX + 2, z0=BZ + 2, x1=BX + 25, z1=BZ + 13, top=TOP, bottom=TOP - 2)      # 24 x 12 x 3
VANTAGE = (BX + 14, TOP + 14, BZ + 8)
results = []


def rcon(*cmd):
    return subprocess.run([f'{DEMO}/rcon.sh', *cmd], capture_output=True, text=True, timeout=60).stdout.strip()


def say(msg, color='aqua'):
    print(f'[demo] {msg}', flush=True)
    rcon('tellraw', '@a', json.dumps({'text': f'[demo] {msg}', 'color': color}))


def note(name, ok, detail=''):
    results.append((name, ok, detail))
    print(f'[check] {"PASS" if ok else "FAIL"} {name} {detail}', flush=True)
    rcon('tellraw', '@a', json.dumps({'text': f'[check] {"PASS" if ok else "FAIL"}: {name}', 'color': 'green' if ok else 'red'}))


class Console:
    def __init__(self):
        token = open(f'{DEMO}/console-data/console.token').read().strip()
        self.cookie, self.csrf = None, None
        r = self.call('POST', '/api/login', {'token': token}, raw=True)
        self.cookie = r[1].split(';')[0]
        self.csrf = r[0]['csrf']

    def call(self, method, path, body=None, raw=False):
        c = http.client.HTTPConnection('127.0.0.1', 3022, timeout=60)
        h = {'Host': 'localhost', 'Content-Type': 'application/json'}
        if self.cookie: h['Cookie'] = self.cookie
        if self.csrf and method != 'GET': h['X-CSRF'] = self.csrf
        c.request(method, path, json.dumps(body) if body is not None else None, h)
        r = c.getresponse(); data = r.read()
        out = json.loads(data) if data else {}
        if r.status >= 400: raise RuntimeError(f'{method} {path} -> {r.status} {out}')
        return (out, r.getheader('Set-Cookie') or '') if raw else out


def pos_of(name):
    o = rcon('data', 'get', 'entity', name, 'Pos')
    if '[' not in o: return None
    return [float(v.strip().rstrip('d')) for v in o.split('[')[-1].rstrip(']').split(',')]


def tp_verified(name, x, y, z, tries=6):
    """tp and read the position back: a teleport that did not take effect is retried, then reported (the first demo run left a bot at the spawn)."""
    for _ in range(tries):
        rcon('tp', name, f'{x}', f'{y}', f'{z}')
        time.sleep(1.5)
        p = pos_of(name)
        if p and abs(p[0] - x) < 3 and abs(p[2] - z) < 3: return True
    return False


def until(cond, secs, what):
    t0 = time.time()
    while time.time() - t0 < secs:
        v = cond()
        if v: return v
        time.sleep(2)
    raise TimeoutError(what)


def main():
    con = Console()
    def items():
        o = rcon('execute', 'if', 'entity', '@e[type=minecraft:item]')
        return int(o.split('count: ')[1].split()[0]) if 'count: ' in o else 0
    # ---- prepare the arena, the watcher
    for b in ('DemoA', 'DemoB', 'DemoC'): rcon('tp', b, f'{BX + 20}.5', str(TOP + 10), f'{BZ + 20}.5')      # out of the old pit before the arena is rebuilt
    try:
        for j in con.call('GET', '/api/state')['jobs']:
            if j['state'] in ('finished', 'cancelled', 'paused'): con.call('DELETE', f'/api/jobs/{j["id"]}')
    except Exception as e: print('old jobs', e)
    time.sleep(2)
    rcon('forceload', 'add', str(BX - 32), str(BZ - 32), str(BX + 64), str(BZ + 64))
    rcon('gamerule', 'doMobSpawning', 'false'); rcon('gamerule', 'doDaylightCycle', 'false'); rcon('time', 'set', 'day'); rcon('difficulty', 'easy')
    rcon('fill', str(BX - 2), str(TOP - 9), str(BZ - 2), str(BX + 40), str(TOP), str(BZ + 40), 'minecraft:stone')
    rcon('fill', str(BX - 2), str(TOP + 1), str(BZ - 2), str(BX + 40), str(TOP + 12), str(BZ + 40), 'minecraft:air')
    rcon('fill', str(BX + 30), str(TOP + 1), str(BZ + 20), str(BX + 38), str(TOP + 6), str(BZ + 28), 'minecraft:stone')
    rcon('kill', '@e[type=minecraft:item]'); rcon('kill', '@e[type=minecraft:zombie]'); rcon('op', WATCH)
    say('Demo starting. Fly above the pit:', 'yellow')
    rcon('tellraw', WATCH, json.dumps([{'text': '  [click: creative mode]', 'color': 'gold', 'clickEvent': {'action': 'run_command', 'value': '/gamemode creative'}},
                                      {'text': '   [click: go above the pit]', 'color': 'gold', 'clickEvent': {'action': 'run_command', 'value': f'/tp @s {VANTAGE[0]} {VANTAGE[1]} {VANTAGE[2]}'}}]))
    time.sleep(12)

    # ---- bots through the console
    names = ['DemoA', 'DemoB', 'DemoC']
    for n in names:
        try: con.call('POST', '/api/bots', {'name': n})
        except RuntimeError as e: print('add', n, e)
    until(lambda: all(b['state'] == 'online' for b in con.call('GET', '/api/state')['bots'] if b['name'] in names) and len(con.call('GET', '/api/state')['bots']) >= 3, 180, 'bots online')
    time.sleep(3)
    for i, n in enumerate(names):
        rcon('gamemode', 'survival', n); rcon('clear', n); rcon('effect', 'clear', n)
        rcon('give', n, 'minecraft:iron_pickaxe', '5'); rcon('give', n, 'minecraft:cobblestone', '32')
        ok = tp_verified(n, BOX['x0'] + 3 + i * 8 + 0.5, TOP + 1, BOX['z0'] - 1 + 0.5)
        note(f'setup: {n} stands at the pit', ok, str(pos_of(n)))
    rcon('give', 'DemoB', 'minecraft:iron_sword', '1')
    # DemoC starts with a FULL inventory of junk (scene 4)
    for i in range(30): rcon('give', 'DemoC', f'minecraft:{["dirt", "gravel", "granite", "diorite", "andesite", "netherrack"][i % 6]}', '64')
    # a block the iron pickaxes cannot break, in the last layer: a problem for whoever reaches it (scene 5)
    obs = (BOX['x0'] + 12, BOX['bottom'], BOX['z0'] + 5)
    rcon('setblock', *map(str, obs), 'minecraft:obsidian')
    time.sleep(2)

    say('1/6  Three bots dig a 24 x 12 x 3 pit. Mined blocks go straight into their inventory: no items appear on the ground.', 'yellow')
    job = con.call('POST', '/api/jobs/pit', {'name': 'demo pit', 'box': BOX, 'bots': names, 'method': 'sweep', 'road': False, 'start': True})
    jid = job['id']
    time.sleep(25)
    ent = items()
    note('direct pickup: while 3 bots dig, item entities on the ground', ent <= 2, f'items={ent}')
    say('4/6  DemoC began with a FULL inventory of junk. It empties it through the server (clear): nothing is thrown, nobody picks up trash.', 'yellow')
    time.sleep(10)
    c_free = None
    try: c_free = [b for b in con.call('GET', '/api/state')['bots'] if b['name'] == 'DemoC'][0]['free']
    except Exception: pass
    note('discard: DemoC freed slots without dropping items', (c_free or 0) >= 6 and items() <= 2, f'free={c_free} items={items()}')

    # ---- scene 2: range audit. Layer 0 of a lane is done once the lane has finished more than its 6 stations: then the cell is in a finished unit.
    def lane_done(i): return [r for r in con.call('GET', f'/api/jobs/{jid}')['regions'] if r['id'] == f'l{i}'][0]['done']
    until(lambda: lane_done(0) >= 8, 300, 'lane l0 past its first layer')
    detail = con.call('GET', f'/api/jobs/{jid}')
    sab = (BOX['x0'] + 3, TOP, BOX['z0'] + 4)
    rcon('setblock', *map(str, sab), 'minecraft:cobblestone')
    say(f'2/6  I just placed a stray cobblestone in an already finished layer at {sab[0]} {sab[1]} {sab[2]} (red lane). The range check should send that part back and dig it again.', 'yellow')

    # ---- scene 3: defence (fire resistance, so the sun cannot kill the zombie: only the bot can)
    until(lambda: lane_done(1) >= 2, 200, 'lane l1 digging')
    x, y, z = pos_of('DemoB')
    say('3/6  A zombie attacks DemoB while it digs. It should kill it and go on working.', 'yellow')
    n0 = len([e for e in con.call('GET', '/api/state')['log'] if 'defended itself' in e['msg']])
    rcon('summon', 'minecraft:zombie', f'{x:.1f}', f'{y + 1:.1f}', f'{z + 1.2:.1f}', '{PersistenceRequired:1b,ActiveEffects:[{Id:12,Amplifier:0,Duration:6000,ShowParticles:0b}]}')
    try:
        until(lambda: len([e for e in con.call('GET', '/api/state')['log'] if 'defended itself' in e['msg']]) > n0, 90, 'defence note')
        gone = 'No entity' in rcon('data', 'get', 'entity', '@e[type=minecraft:zombie,limit=1]', 'Health')
        note('defence: DemoB reported defending itself and the zombie is dead', gone, [e['msg'] for e in con.call('GET', '/api/state')['log'] if 'defended itself' in e['msg']][-1])
    except TimeoutError:
        rcon('kill', '@e[type=minecraft:zombie]')
        note('defence: DemoB reported defending itself', False, 'no "defended itself" note in 90 s')

    # ---- scene 5: problem bot glows, then recovers
    say('5/6  Somewhere in the last layer there is OBSIDIAN. Iron pickaxes cannot break it: whoever reaches it has a problem and should GLOW.', 'yellow')
    glow_bot = None
    def stuck():
        nonlocal glow_bot
        for b in con.call('GET', '/api/state')['bots']:
            if b['name'] in names and b.get('retired') and 'waiting' in str(b['retired']): glow_bot = b['name']; return True
        pv = con.call('GET', '/api/problems?n=20')
        return bool(pv['glowing'])
    try:
        until(stuck, 420, 'a bot hits the obsidian')
        pv = con.call('GET', '/api/problems?n=20')
        gb = glow_bot or (pv['glowing'][0] if pv['glowing'] else None)
        eff = rcon('data', 'get', 'entity', gb, 'ActiveEffects') if gb else ''
        note('glow: the problem bot glows in the game', 'glowing' in eff, f'bot={gb}')
        last = pv['recent'][-1] if pv['recent'] else {}
        note('glow: the problem is on record with position and facing', bool(last.get('cell') and last.get('heading')), json.dumps({k: last.get(k) for k in ('bot', 'reason', 'cell', 'heading', 'below', 'ahead')}))
        time.sleep(15)
        say(f'     {gb} glows (look for the outline through the blocks). Giving it a diamond pickaxe: it should carry on by itself and stop glowing.', 'yellow')
        rcon('give', gb, 'minecraft:diamond_pickaxe', '1')
        until(lambda: con.call('GET', f'/api/jobs/{jid}')['progress']['done'] > detail['progress']['done'] + 3, 120, 'work goes on')
        until(lambda: gb not in con.call('GET', '/api/problems?n=1')['glowing'], 120, 'glow cleared')
        note('glow: cleared after the bot carried on', 'glowing' not in rcon('data', 'get', 'entity', gb, 'ActiveEffects'), f'bot={gb}')
    except TimeoutError as e:
        note('glow: a problem bot appeared', False, str(e))

    # ---- finish the pit
    try:
        until(lambda: con.call('GET', f'/api/jobs/{jid}')['state'] == 'finished', 600, 'pit finished')
        left = 0
        for l in range(3):
            for blk in ('stone', 'cobblestone', 'water', 'dirt', 'obsidian'):
                o = rcon('fill', str(BOX['x0']), str(TOP - l), str(BOX['z0']), str(BOX['x1']), str(TOP - l), str(BOX['z1']), 'minecraft:air', 'replace', f'minecraft:{blk}')
                if 'filled' in o: left += int(o.split('filled ')[1].split()[0])
        notes = [e['msg'] for e in con.call('GET', '/api/state')['log'] if 'range check' in e['msg']]
        note('audit: pit finished, nothing left in the volume (stray block dug again)', left == 0, f'left={left}')
        note('audit: the range check reported sending units back', len(notes) > 0, '; '.join(notes[-2:]))
    except TimeoutError:
        note('pit finished', False, 'not finished in 10 min')

    # ---- scene 6: climbing
    say('6/6  DemoA walks to the top of the 6-high stone wall (x 2030..2038). No way on foot: it should build a pillar, climb, and remove it.', 'yellow')
    rcon('tp', 'DemoA', f'{BX + 22}.5', str(TOP + 1), f'{BZ + 24}.5')
    time.sleep(3)
    try:
        r = con.call('POST', '/api/commands', {'bots': ['DemoA'], 'command': 'move_to', 'args': {'x': BX + 33, 'y': TOP + 7, 'z': BZ + 24}})
        until(lambda: [b for b in con.call('GET', '/api/state')['bots'] if b['name'] == 'DemoA'][0].get('cmd') is None or [b for b in con.call('GET', '/api/state')['bots'] if b['name'] == 'DemoA'][0]['cmd'].get('status') != 'running', 120, 'move_to ends')
        time.sleep(2)
        pos = rcon('data', 'get', 'entity', 'DemoA', 'Pos')
        y = float(pos.split('[')[-1].rstrip(']').split(',')[1].strip().rstrip('d'))
        left = 0
        o = rcon('fill', str(BX + 20), str(TOP + 1), str(BZ + 18), str(BX + 29), str(TOP + 8), str(BZ + 30), 'minecraft:air', 'replace', 'minecraft:cobblestone')
        if 'filled' in o: left = int(o.split('filled ')[1].split()[0])
        note('climb: DemoA stands on top of the wall', y >= TOP + 6.9, f'y={y}')
        note('climb: no temporary block left at the wall', left == 0, f'left={left}')
    except Exception as e:
        note('climb', False, str(e))

    ok = all(r[1] for r in results)
    say(f'Demo finished: {sum(1 for r in results if r[1])}/{len(results)} checks passed. Open the console (Automation page) for the problem list.', 'green' if ok else 'red')
    json.dump({'ok': ok, 'results': results}, open(f'{DEMO}/out/demo-show-result.json', 'w'), indent=1)


if __name__ == '__main__':
    try: main()
    except Exception as e:
        say(f'Demo stopped by an error: {e}', 'red'); raise
