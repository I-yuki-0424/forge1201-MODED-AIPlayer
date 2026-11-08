"""Several simulator shards seen as one batch of environments (a shard runs `--bots` bots; each bot is one environment)."""
from dataclasses import dataclass

from .envio import Shard


@dataclass
class Obs:
    shard: Shard
    env_id: int
    episode: int
    step: int
    terminated: bool
    outcome: str
    raw: dict            # the observation dict (fields of obs_spec)

    @property
    def key(self):
        return (self.shard.shard, self.env_id)


class Vec:
    def __init__(self, root, base, shard_ids):
        self.shards = [Shard(root, base, s) for s in shard_ids]

    def vocab(self):
        """Item vocabulary (index -> name) of the first hello received, or None."""
        for sh in self.shards:
            for h in sh.hello.values():
                return h["vocab"]["items"]
        return None

    def poll(self):
        out = []
        for sh in self.shards:
            for m in sh.poll():
                if m.get("type") == "obs":
                    out.append(Obs(sh, m["env_id"], m["episode"], m["step"], bool(m["terminated"]), m.get("outcome", ""), m["obs"]))
        return out

    def act(self, ob, candidate):
        ob.shard.act(ob.env_id, ob.episode, ob.step, candidate)

    def close(self):
        for sh in self.shards:
            sh.close()
