"""Print the latest deployment phase + live URL of the recall-hunter DO app. Usage: python deploy/status.py [--wait]"""
import sys, time, httpx
from dotenv import dotenv_values
H = {"Authorization": f"Bearer {dotenv_values('.env')['DO_API_TOKEN']}"}
API = "https://api.digitalocean.com/v2/apps"
for _ in range(60 if "--wait" in sys.argv else 1):
    app = next(a for a in httpx.get(API, headers=H, timeout=30).json()["apps"] if a["spec"]["name"] == "recall-hunter")
    d = httpx.get(f"{API}/{app['id']}/deployments", headers=H, timeout=30).json()["deployments"][0]
    steps = [s["name"] + ":" + s.get("status", "") for s in (d.get("progress") or {}).get("steps", [])]
    print(d["phase"], app.get("live_url"), steps, flush=True)
    if d["phase"] in ("ACTIVE", "ERROR", "CANCELED", "SUPERSEDED"):
        break
    time.sleep(20)
