import os
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default) or default


DB_URL = env("TIGER_DATABASE_URL")
BD_TOKEN = env("BRIGHTDATA_API_TOKEN")
BD_UNLOCKER_ZONE = env("BRIGHTDATA_UNLOCKER_ZONE", "rh_unlocker")
BD_SERP_ZONE = env("BRIGHTDATA_SERP_ZONE", "rh_serp")
GEMINI_KEY = env("GEMINI_API_KEY")
M_SCREEN = env("GEMINI_MODEL_SCREEN", "gemini-3.5-flash-lite")
M_VISION = env("GEMINI_MODEL_VISION", "gemini-3.5-flash")
M_JUDGE = env("GEMINI_MODEL_JUDGE", "gemini-3.1-pro-preview")
M_EMBED = env("GEMINI_MODEL_EMBED", "gemini-embedding-2")
# When set, every Gemini text/vision call uses this one model (e.g. to ride out rate limits). Embeddings are unaffected.
M_FORCE = env("GEMINI_FORCE_MODEL", "")
DO_TOKEN = env("DO_API_TOKEN")
DO_INFERENCE_KEY = env("DO_INFERENCE_KEY")
DO_INFERENCE_BASE_URL = env("DO_INFERENCE_BASE_URL", "https://inference.do-ai.run/v1")
SPACES_KEY = env("DO_SPACES_KEY")
SPACES_SECRET = env("DO_SPACES_SECRET")
SPACES_BUCKET = env("DO_SPACES_BUCKET")
SPACES_REGION = env("DO_SPACES_REGION", "sfo3")
SENTRY_DSN = env("SENTRY_DSN")
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache"
EVIDENCE_DIR = DATA_DIR / "evidence"
CACHE_DIR.mkdir(parents=True, exist_ok=True)
EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
