"""In-process pub/sub for hunt runs -> SSE. Events are also kept in a replay buffer per run."""
import asyncio
import json
import time
from collections import defaultdict

_buffers: dict[str, list[dict]] = defaultdict(list)
_subs: dict[str, list[asyncio.Queue]] = defaultdict(list)


def emit(run_id: str, type_: str, data: dict | None = None) -> None:
    ev = {"type": type_, "ts": time.time(), "data": data or {}}
    _buffers[run_id].append(ev)
    for qu in list(_subs[run_id]):
        qu.put_nowait(ev)


def make_emitter(run_id: str):
    def _e(type_: str, data: dict | None = None):
        emit(run_id, type_, data)
    return _e


async def stream(run_id: str):
    qu: asyncio.Queue = asyncio.Queue()
    for ev in _buffers[run_id]:
        qu.put_nowait(ev)
    _subs[run_id].append(qu)
    try:
        while True:
            try:
                ev = await asyncio.wait_for(qu.get(), timeout=15)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                continue
            yield f"event: {ev['type']}\ndata: {json.dumps(ev, default=str)}\n\n"
            if ev["type"] in ("done", "error"):
                break
    finally:
        _subs[run_id].remove(qu)
