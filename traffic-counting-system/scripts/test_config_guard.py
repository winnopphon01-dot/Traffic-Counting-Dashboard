"""Pre-deploy checks: production configuration guard (Phase 5).

Run:  .venv\\Scripts\\python.exe scripts\\test_config_guard.py
Verifies that APP_ENV=production refuses to start on SQLite or without an
API key, that the error message never echoes secrets, and that development
mode still loads with the SQLite fallback.
"""

import os
import subprocess
import sys
from pathlib import Path

PY = sys.executable
BACKEND_DIR = Path(__file__).resolve().parents[1]
CODE = "from app.config import get_settings; get_settings(); print('CONFIG_LOAD_OK')"

BASE_ENV = {
    k: v
    for k, v in os.environ.items()
    if k not in ("APP_ENV", "DATABASE_URL", "API_KEY")
}


def run(overrides: dict[str, str]) -> tuple[int, str]:
    env = {**BASE_ENV, **overrides}
    proc = subprocess.run(
        [PY, "-c", CODE],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return proc.returncode, proc.stdout + proc.stderr


failures = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global failures
    if ok:
        print(f"[PASS] {name}")
    else:
        failures += 1
        print(f"[FAIL] {name}: {detail}")


# 1) production + SQLite URL (with a secret-looking value) -> reject, no leak
code, out = run(
    {"APP_ENV": "production", "DATABASE_URL": "sqlite:///secret123.db", "API_KEY": ""}
)
check(
    "production refuses SQLite DATABASE_URL",
    code != 0
    and "Invalid production configuration" in out
    and "PostgreSQL" in out
    and "secret123" not in out,
    f"exit={code}, out={out[-500:]}",
)

# 2) production without API_KEY -> reject
code, out = run(
    {
        "APP_ENV": "production",
        "DATABASE_URL": "postgresql+psycopg://trafficapp:pw@traffic-postgres:5432/trafficdb",
        "API_KEY": "",
    }
)
check(
    "production refuses empty API_KEY",
    code != 0 and "API_KEY must be set" in out,
    f"exit={code}, out={out[-500:]}",
)

# 3) production with PostgreSQL + API_KEY -> loads
code, out = run(
    {
        "APP_ENV": "production",
        "DATABASE_URL": "postgresql+psycopg://trafficapp:pw@traffic-postgres:5432/trafficdb",
        "API_KEY": "test-key",
    }
)
check(
    "production loads with PostgreSQL + API_KEY",
    code == 0 and "CONFIG_LOAD_OK" in out,
    f"exit={code}, out={out[-500:]}",
)

# 4) development defaults -> loads (SQLite fallback allowed)
code, out = run({})
check(
    "development mode loads with defaults",
    code == 0 and "CONFIG_LOAD_OK" in out,
    f"exit={code}, out={out[-500:]}",
)

print(f"\n==== CONFIG GUARD RESULT: {'ALL PASS' if failures == 0 else f'{failures} FAILED'} ====")
sys.exit(1 if failures else 0)
