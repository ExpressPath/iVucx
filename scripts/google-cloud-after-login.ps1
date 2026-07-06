param(
  [string]$ProjectId = "",
  [string]$Region = "asia-northeast1",
  [string]$Zone = "asia-northeast1-a"
)

$ErrorActionPreference = "Stop"

$Gcloud = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
if (-not (Test-Path $Gcloud)) {
  throw "gcloud was not found at $Gcloud"
}

Write-Host "== gcloud version =="
& $Gcloud --version

Write-Host "`n== auth accounts =="
$AccountsJson = & $Gcloud auth list --format=json
Write-Host $AccountsJson
$Accounts = $AccountsJson | ConvertFrom-Json
if (-not $Accounts -or $Accounts.Count -eq 0) {
  throw "No gcloud account is logged in. Run: $Gcloud auth login --update-adc"
}

if ($ProjectId) {
  Write-Host "`n== set project =="
  & $Gcloud config set project $ProjectId
} else {
  $ProjectId = (& $Gcloud config get-value project 2>$null).Trim()
}

if (-not $ProjectId) {
  Write-Host "`n== accessible projects =="
  & $Gcloud projects list --format="table(projectId,name,projectNumber)"
  throw "ProjectId is not set. Re-run with: .\scripts\google-cloud-after-login.ps1 -ProjectId YOUR_PROJECT_ID"
}

Write-Host "`n== enabled / required APIs =="
& $Gcloud services enable compute.googleapis.com drive.googleapis.com --project=$ProjectId

Write-Host "`n== compute zones quick check =="
& $Gcloud compute zones list --project=$ProjectId --filter="name=$Zone" --format="table(name,region,status)"

Write-Host "`nGoogle Cloud is ready for this repo."
Write-Host "Project: $ProjectId"
Write-Host "Region:  $Region"
Write-Host "Zone:    $Zone"
