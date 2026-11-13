"""Create/update the DigitalOcean App Platform app from the public GitHub repo. Secrets come from .env and are sent
as encrypted SECRET env vars to DigitalOcean only. Usage: .venv/Scripts/python deploy/do_app.py [branch]"""
import sys, json, httpx
from dotenv import dotenv_values

BRANCH = sys.argv[1] if len(sys.argv) > 1 else "v2-extension"
e = dotenv_values(".env")
H = {"Authorization": f"Bearer {e['DO_API_TOKEN']}", "Content-Type": "application/json"}
API = "https://api.digitalocean.com/v2/apps"
SECRET_KEYS = ["TIGER_DATABASE_URL", "BRIGHTDATA_API_TOKEN", "GEMINI_API_KEY", "DO_INFERENCE_KEY", "DO_SPACES_KEY",
               "DO_SPACES_SECRET", "SENTRY_DSN"]
PLAIN_KEYS = ["BRIGHTDATA_UNLOCKER_ZONE", "BRIGHTDATA_SERP_ZONE", "GEMINI_MODEL_SCREEN", "GEMINI_MODEL_VISION",
              "GEMINI_MODEL_JUDGE", "GEMINI_MODEL_EMBED", "DO_INFERENCE_BASE_URL", "DO_SPACES_BUCKET", "DO_SPACES_REGION"]
envs = [{"key": k, "value": e[k], "type": "SECRET", "scope": "RUN_TIME"} for k in SECRET_KEYS if e.get(k)]
envs += [{"key": k, "value": e[k], "scope": "RUN_TIME"} for k in PLAIN_KEYS if e.get(k)]
envs += [{"key": "RH_BD_WAIT_S", "value": "90", "scope": "RUN_TIME"}]
spec = {"name": "recall-hunter", "region": "sfo",
        "services": [{"name": "api", "dockerfile_path": "Dockerfile", "source_dir": "/",
                      "git": {"repo_clone_url": "https://github.com/wh0th3h3llam1/recall-hunter.git", "branch": BRANCH},
                      "http_port": 8080, "instance_count": 1, "instance_size_slug": "apps-s-1vcpu-1gb",
                      "routes": [{"path": "/"}], "health_check": {"http_path": "/api/health"}, "envs": envs}]}
apps = httpx.get(API, headers=H, timeout=30).json().get("apps") or []
app = next((a for a in apps if a.get("spec", {}).get("name") == "recall-hunter"), None)
if app:
    r = httpx.put(f"{API}/{app['id']}", headers=H, json={"spec": spec}, timeout=60)
else:
    r = httpx.post(API, headers=H, json={"spec": spec}, timeout=60)
print(r.status_code)
a = (r.json() or {}).get("app") or {}
print(json.dumps({"id": a.get("id"), "live_url": a.get("live_url"), "default_ingress": a.get("default_ingress"),
                  "error": None if r.status_code < 300 else r.text[:300]}))
