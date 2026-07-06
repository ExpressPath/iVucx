param(
  [string]$ProjectId = "project-529a8373-2a34-4950-85f",
  [string]$Zone = "us-west1-b",
  [string[]]$WorkerNames = @("ivucx-helper-worker-1", "ivucx-helper-worker-2")
)

$ErrorActionPreference = "Stop"
$Gcloud = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"

& $Gcloud compute instances start @WorkerNames --project=$ProjectId --zone=$Zone --quiet

$Ips = @{
  "ivucx-helper-worker-1" = "34.19.92.107"
  "ivucx-helper-worker-2" = "136.117.232.34"
}

$Deadline = (Get-Date).AddMinutes(5)
$Ready = @{}
foreach ($Name in $WorkerNames) {
  $Ready[$Name] = $false
}

while ((Get-Date) -lt $Deadline -and ($Ready.Values -contains $false)) {
  foreach ($Name in $WorkerNames) {
    if ($Ready[$Name] -or -not $Ips.ContainsKey($Name)) {
      continue
    }

    $Ip = $Ips[$Name]
    try {
      $Response = Invoke-WebRequest -UseBasicParsing -Uri "http://${Ip}:3000/healthz" -TimeoutSec 5
      if ($Response.StatusCode -eq 200) {
        $Ready[$Name] = $true
        Write-Host "ready $Name $Ip"
      }
    } catch {
      Start-Sleep -Seconds 5
    }
  }
}

foreach ($Name in $WorkerNames) {
  if (-not $Ready[$Name]) {
    Write-Warning "not ready: $Name"
  }
}
