param(
  [string]$ProjectId = "project-529a8373-2a34-4950-85f",
  [string]$Zone = "us-west1-b",
  [string[]]$WorkerNames = @("ivucx-helper-worker-1", "ivucx-helper-worker-2")
)

$ErrorActionPreference = "Stop"
$Gcloud = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"

& $Gcloud compute instances stop @WorkerNames --project=$ProjectId --zone=$Zone --quiet
