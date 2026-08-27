#!/usr/bin/env bash
# Smoke test Nomad plugin: validate→plan stages with optional submit+status.
# Env: SMOKE_SUBMIT=1 (submit), SMOKE_KEEP=1 (skip cleanup)
set -euo pipefail

BASE="${HUB_BASE_URL:-http://127.0.0.1:3000/api/v1}"
KEY="${HUB_OPERATOR_API_KEY:?set HUB_OPERATOR_API_KEY to an instance-operator API key}"

auth=(-H "x-api-key: ${KEY}" -H 'content-type: application/json')

body=$(
  cat <<'EOF'
{
  "jobspecId": "bridge-services",
  "variables": {
    "job_name": "bridge-services-smoke",
    "datacenter": "dc1",
    "zone_id": "example-zone",
    "bridge_api_image": "example.com/brokkr/bridge-api:1.0.0",
    "bind_image": "example.com/brokkr/bind9:1.0.0",
    "kea_image": "example.com/brokkr/kea-dhcp:1.0.0"
  }
}
EOF
)

echo "== GET ${BASE}/plugins/nomad/health"
curl -fsS "${auth[@]}" "${BASE}/plugins/nomad/health" | tee /tmp/nomad-smoke-health.json
echo

echo "== POST ${BASE}/plugins/nomad/validate"
curl -fsS "${auth[@]}" -d "${body}" "${BASE}/plugins/nomad/validate" | tee /tmp/nomad-smoke-validate.json
echo
python3 - <<'PY'
import json, sys
r = json.load(open("/tmp/nomad-smoke-validate.json"))
sys.exit(0 if r.get("status") == "ok" else 1)
PY

echo "== POST ${BASE}/plugins/nomad/plan"
curl -fsS "${auth[@]}" -d "${body}" "${BASE}/plugins/nomad/plan" | tee /tmp/nomad-smoke-plan.json
echo
python3 - <<'PY'
import json, sys
r = json.load(open("/tmp/nomad-smoke-plan.json"))
sys.exit(0 if r.get("status") == "ok" else 1)
PY

if [[ ${SMOKE_SUBMIT:-} != "1" ]]; then
  echo "OK — health/validate/plan passed. Set SMOKE_SUBMIT=1 to also submit + status (+ stop)."
  exit 0
fi

echo "== POST ${BASE}/plugins/nomad/submit (SMOKE_SUBMIT=1)"
curl -fsS "${auth[@]}" -d "${body}" "${BASE}/plugins/nomad/submit" | tee /tmp/nomad-smoke-submit.json
echo
job_id=$(
  python3 - <<'PY'
import json, sys
r = json.load(open("/tmp/nomad-smoke-submit.json"))
if r.get("status") != "ok" or not r.get("jobId"):
    sys.exit(1)
print(r["jobId"])
PY
)

echo "== GET ${BASE}/plugins/nomad/status?jobId=${job_id}"
curl -fsS "${auth[@]}" "${BASE}/plugins/nomad/status?jobId=${job_id}" | tee /tmp/nomad-smoke-status.json
echo

if [[ ${SMOKE_KEEP:-} == "1" ]]; then
  echo "OK — submit returned jobId=${job_id} (SMOKE_KEEP=1; skipped stop/purge)."
  exit 0
fi

stop_body=$(
  python3 - <<PY
import json
print(json.dumps({"jobId": "${job_id}", "purge": True}))
PY
)

echo "== POST ${BASE}/plugins/nomad/stop (purge=true)"
curl -fsS "${auth[@]}" -d "${stop_body}" "${BASE}/plugins/nomad/stop" | tee /tmp/nomad-smoke-stop.json
echo
python3 - <<'PY'
import json, sys
r = json.load(open("/tmp/nomad-smoke-stop.json"))
sys.exit(0 if r.get("status") == "ok" else 1)
PY

echo "OK — submit returned jobId=${job_id}; stop+purge succeeded."
