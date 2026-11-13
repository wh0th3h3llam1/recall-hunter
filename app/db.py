"""Tiger Data (Postgres) access. Sync psycopg pool; call from async code via run_in_threadpool or directly (queries are short)."""
import json
from contextlib import contextmanager
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from .config import DB_URL

pool = ConnectionPool(DB_URL, min_size=1, max_size=8, kwargs={"row_factory": dict_row, "autocommit": True}, open=False)


def open_pool():
    pool.open(wait=True, timeout=30)


@contextmanager
def cursor():
    with pool.connection() as conn:
        with conn.cursor() as cur:
            yield cur


def q(sql: str, params=None) -> list[dict]:
    with cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall() if cur.description else []


def q1(sql: str, params=None) -> dict | None:
    rows = q(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params=None) -> None:
    with cursor() as cur:
        cur.execute(sql, params)


def vec(v: list[float] | None) -> str | None:
    return None if v is None else "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def js(o) -> str:
    return json.dumps(o, default=str)
