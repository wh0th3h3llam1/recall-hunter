"""Observability + sponsor proof log. Every external call goes through log_call -> rh.api_calls (Tiger hypertable)."""
import time
from contextlib import contextmanager
from .config import SENTRY_DSN
from . import db

SENTRY_ON = False


def init_sentry():
    global SENTRY_ON
    if not SENTRY_DSN:
        return
    import sentry_sdk
    sentry_sdk.init(dsn=SENTRY_DSN, traces_sample_rate=1.0, send_default_pii=False, environment="hackathon")
    SENTRY_ON = True


def log_call(sponsor: str, product: str, endpoint: str, status: str, latency_ms: int,
             records: int = 0, cost_usd: float = 0.0, sample=None) -> None:
    try:
        db.execute(
            "INSERT INTO rh.api_calls(sponsor,product,endpoint,status,latency_ms,records,cost_usd,sample) "
            "VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
            (sponsor, product, endpoint, status, latency_ms, records, cost_usd, db.js(sample) if sample is not None else None),
        )
    except Exception as e:  # never break the pipeline on logging
        print("log_call failed:", e)


@contextmanager
def span(op: str, description: str = ""):
    """Sentry span if Sentry is on; always yields a timer dict with ms."""
    t = {"ms": 0}
    start = time.perf_counter()
    if SENTRY_ON:
        import sentry_sdk
        with sentry_sdk.start_span(op=op, name=description or op):
            yield t
    else:
        yield t
    t["ms"] = int((time.perf_counter() - start) * 1000)


def capture(e: Exception):
    if SENTRY_ON:
        import sentry_sdk
        sentry_sdk.capture_exception(e)
