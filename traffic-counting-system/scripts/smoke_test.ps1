# Smoke test for the Traffic Counting API (Phase 4 - local tests).
# Start the server first:
#   $env:API_KEY='dev-secret-test'
#   .venv\Scripts\python.exe -m uvicorn app.main:app --port 8000
# Then run:
#   powershell -ExecutionPolicy Bypass -File scripts\smoke_test.ps1

$base = 'http://127.0.0.1:8000'
$apiKey = 'dev-secret-test'
$pass = 0
$fail = 0

function Check($name, $expected, $actual) {
    if ("$actual" -eq "$expected") {
        Write-Host "[PASS] $name (got $actual)" -ForegroundColor Green
        $script:pass++
    } else {
        Write-Host "[FAIL] $name (expected $expected, got $actual)" -ForegroundColor Red
        $script:fail++
    }
}

$validBody = '{"camera_id":"CAM-001","vehicle_count":12,"non_vehicle_count":4,"person_count":7,"event_time":"2026-10-13T15:30:00Z","source":"nodered"}'
$negativeBody = '{"camera_id":"CAM-001","vehicle_count":-1,"non_vehicle_count":0,"person_count":0}'
$missingCamBody = '{"vehicle_count":1,"non_vehicle_count":0,"person_count":0}'
$noTimeBody = '{"camera_id":"CAM-002","vehicle_count":3,"non_vehicle_count":1,"person_count":2,"source":"nodered"}'

# NOTE: do NOT use `curl.exe -d` from PowerShell 5.1 - embedded double quotes in
# the JSON argument get mangled by native argument passing. Invoke-WebRequest
# sends the body string correctly.
function Post-Json([string]$url, [string]$json, [string]$key) {
    $headers = @{}
    if ($key) { $headers['X-API-Key'] = $key }
    try {
        $r = Invoke-WebRequest -Uri $url -Method Post -ContentType 'application/json' `
            -Headers $headers -Body $json -UseBasicParsing
        return [int]$r.StatusCode
    } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

# --- 1-3: basic endpoints ---
Check "GET /" 200 (curl.exe -s -o NUL -w "%{http_code}" "$base/")
$healthCode = curl.exe -s -o NUL -w "%{http_code}" "$base/health"
$healthBody = curl.exe -s "$base/health"
Check "GET /health status" 200 $healthCode
if ($healthBody -match '"database":"connected"') { Write-Host "[PASS] GET /health database connected" -ForegroundColor Green; $pass++ }
else { Write-Host "[FAIL] GET /health body: $healthBody" -ForegroundColor Red; $fail++ }
Check "GET /docs" 200 (curl.exe -s -o NUL -w "%{http_code}" "$base/docs")

# --- 4-5: API key enforcement ---
Check "POST without API key -> 401" 401 (Post-Json "$base/api/traffic" $validBody $null)
Check "POST with wrong API key -> 401" 401 (Post-Json "$base/api/traffic" $validBody "wrong-key")
Check "GET latest without API key -> 401" 401 (curl.exe -s -o NUL -w "%{http_code}" "$base/api/traffic/latest")

# --- 5: valid insert ---
Check "POST valid event -> 201" 201 (Post-Json "$base/api/traffic" $validBody $apiKey)
Check "POST event without event_time -> 201" 201 (Post-Json "$base/api/traffic" $noTimeBody $apiKey)

# --- 8: invalid payloads ---
Check "POST negative count -> 422" 422 (Post-Json "$base/api/traffic" $negativeBody $apiKey)
Check "POST missing camera_id -> 422" 422 (Post-Json "$base/api/traffic" $missingCamBody $apiKey)


# --- 6-7: reads ---
$latest = curl.exe -s "$base/api/traffic/latest" -H "X-API-Key: $apiKey"
if ($latest -match '"camera_id":"CAM-001"' -or $latest -match '"camera_id":"CAM-002"') { Write-Host "[PASS] GET latest returns a record" -ForegroundColor Green; $pass++ }
else { Write-Host "[FAIL] GET latest: $latest" -ForegroundColor Red; $fail++ }

$histAll = curl.exe -s "$base/api/traffic/history?limit=10" -H "X-API-Key: $apiKey"
if ($histAll -match '"vehicle_count":12') { Write-Host "[PASS] GET history returns inserted record" -ForegroundColor Green; $pass++ }
else { Write-Host "[FAIL] GET history: $histAll" -ForegroundColor Red; $fail++ }

$histCam = curl.exe -s "$base/api/traffic/history?camera_id=CAM-001&limit=10" -H "X-API-Key: $apiKey"
if ($histCam -match 'CAM-001' -and $histCam -notmatch 'CAM-002') { Write-Host "[PASS] history filters by camera_id" -ForegroundColor Green; $pass++ }
else { Write-Host "[FAIL] history camera filter: $histCam" -ForegroundColor Red; $fail++ }

$histTime = curl.exe -s "$base/api/traffic/history?start=2026-10-13T00:00:00Z&end=2026-10-14T00:00:00Z&limit=10" -H "X-API-Key: $apiKey"
if ($histTime -match 'CAM-001') { Write-Host "[PASS] history filters by time range" -ForegroundColor Green; $pass++ }
else { Write-Host "[FAIL] history time filter: $histTime" -ForegroundColor Red; $fail++ }

$histDates = curl.exe -s "$base/api/traffic/history?start_date=2026-10-13&end_date=2026-10-13&limit=1000" -H "X-API-Key: $apiKey"
if ($histDates -match '"camera_id":"CAM-001"' -and $histDates -match '"vehicle_count":12') { Write-Host "[PASS] history filters inclusive UTC calendar dates" -ForegroundColor Green; $pass++ }
else { Write-Host "[FAIL] history date filter: $histDates" -ForegroundColor Red; $fail++ }

$histEmpty = curl.exe -s "$base/api/traffic/history?start=2030-01-01T00:00:00Z&limit=10" -H "X-API-Key: $apiKey"
if ($histEmpty -match '^\[\s*\]$' -or $histEmpty -eq '[]') { Write-Host "[PASS] history empty range -> []" -ForegroundColor Green; $pass++ }
else { Write-Host "[FAIL] history empty range: $histEmpty" -ForegroundColor Red; $fail++ }

$cameras = curl.exe -s "$base/api/cameras" -H "X-API-Key: $apiKey"
if ($cameras -match 'CAM-001' -and $cameras -match 'event_count') { Write-Host "[PASS] GET cameras lists camera" -ForegroundColor Green; $pass++ }
else { Write-Host "[FAIL] GET cameras: $cameras" -ForegroundColor Red; $fail++ }

$latest404 = curl.exe -s -o NUL -w "%{http_code}" "$base/api/traffic/latest?camera_id=NO-SUCH-CAM" -H "X-API-Key: $apiKey"
Check "GET latest unknown camera -> 404" 404 $latest404

Write-Host "`n==== RESULT: $pass passed, $fail failed ====" -ForegroundColor Cyan
if ($fail -gt 0) { exit 1 }
