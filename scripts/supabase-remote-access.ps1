[CmdletBinding()]
param(
  [string]$DbUrl = $env:SUPABASE_DB_URL,
  [string]$ExpectedProjectRef = $env:SUPABASE_PROJECT_REF,
  [string]$AppBaseUrl = "https://ivucx.vercel.app",
  [switch]$CheckOnly,
  [switch]$RestSmoke
)

$ErrorActionPreference = "Stop"

function Resolve-RepoRoot {
  $scriptPath = Split-Path -Parent $PSCommandPath
  return (Resolve-Path (Join-Path $scriptPath "..")).Path
}

function Resolve-CommandPath {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string[]]$Fallbacks = @()
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command -and $command.Source) {
    return $command.Source
  }

  foreach ($fallback in $Fallbacks) {
    if ($fallback -and (Test-Path -LiteralPath $fallback)) {
      return $fallback
    }
  }

  return ""
}

function Get-ProjectRefFromDbUrl {
  param([Parameter(Mandatory = $true)][string]$ConnectionString)

  try {
    $uri = [Uri]$ConnectionString
  } catch {
    return ""
  }

  $hostName = ""
  if ($uri.Host) {
    $hostName = $uri.Host.ToLowerInvariant()
  }

  if ($hostName -match "^db\.([a-z0-9-]+)\.supabase\.co$") {
    return $Matches[1]
  }

  $userInfo = ""
  if ($uri.UserInfo) {
    $userInfo = [Uri]::UnescapeDataString(($uri.UserInfo -split ":", 2)[0])
  }

  if ($userInfo -match "(?:^|\.)([a-z0-9-]{10,})$") {
    return $Matches[1]
  }

  return ""
}

function Invoke-PsqlFile {
  param(
    [Parameter(Mandatory = $true)][string]$ConnectionString,
    [Parameter(Mandatory = $true)][string]$SqlPath
  )

  if (!(Test-Path -LiteralPath $SqlPath)) {
    throw "SQL file not found: $SqlPath"
  }

  $psql = Resolve-CommandPath -Name "psql"
  if ($psql) {
    & $psql $ConnectionString -v ON_ERROR_STOP=1 -f $SqlPath
    if ($LASTEXITCODE -ne 0) {
      throw "psql failed for $SqlPath"
    }
    return
  }

  $docker = Resolve-CommandPath -Name "docker" -Fallbacks @(
    "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
  )
  if ($docker) {
    Get-Content -Raw -LiteralPath $SqlPath |
      & $docker run --rm -i postgres:17 psql $ConnectionString -v ON_ERROR_STOP=1
    if ($LASTEXITCODE -ne 0) {
      throw "dockerized psql failed for $SqlPath"
    }
    return
  }

  throw "Neither psql nor Docker was found. Install PostgreSQL client tools or Docker Desktop."
}

function Invoke-PersistCheck {
  param([Parameter(Mandatory = $true)][string]$BaseUrl)

  $url = $BaseUrl.TrimEnd("/") + "/api/helper/persist-check"
  Invoke-RestMethod -Uri $url -Method Get | ConvertTo-Json -Depth 16
}

function Invoke-RestSmoke {
  param([Parameter(Mandatory = $true)][string]$BaseUrl)

  $payloadObject = [ordered]@{
    title = "ivucx-remote-access-smoke"
    language = "Lean"
    fileName = "RemoteAccessSmoke.lean"
    code = "theorem remote_access_smoke : True := by trivial"
    requestedFormat = "cic-v1"
    jobId = "ivucx-remote-access-smoke"
    requestedAt = (Get-Date).ToUniversalTime().ToString("o")
    result = [ordered]@{
      ok = $true
      language = "lean"
      proofState = "YY"
      proofCheck = [ordered]@{
        ok = $true
        status = "verified"
        smokeTest = $true
      }
      planning = [ordered]@{
        planner = "remote-access-smoke"
        executor = "vercel-persist-endpoint"
        requestedFormat = "cic-v1"
        completedFormat = "cic-v1"
        operation = "submit"
        fallbackUsed = $false
      }
      conversion = [ordered]@{
        requestedFormat = "cic-v1"
        completedFormat = "cic-v1"
        adapter = "ivucx-remote-access-smoke"
        targetFamily = "cic"
        lambda = [ordered]@{
          format = "cic-v1"
          term = [ordered]@{
            kind = "SmokeCIC"
            name = "True.intro"
          }
          context = @()
          declarations = @()
          metadata = [ordered]@{
            smokeTest = $true
            source = "scripts/supabase-remote-access.ps1"
          }
          rawText = "remote-access-smoke"
        }
      }
    }
  }

  $payload = $payloadObject | ConvertTo-Json -Depth 16 -Compress
  $url = $BaseUrl.TrimEnd("/") + "/api/helper/persist"
  Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json; charset=utf-8" -Body $payload |
    ConvertTo-Json -Depth 16
}

if ([string]::IsNullOrWhiteSpace($DbUrl)) {
  throw "SUPABASE_DB_URL is required. Set it to the production Supabase Postgres connection string."
}

$repoRoot = Resolve-RepoRoot
$schemaSql = Join-Path $repoRoot "supabase\proof_helper.sql"
$checkSql = Join-Path $repoRoot "supabase\remote_access_check.sql"
$inferredRef = Get-ProjectRefFromDbUrl -ConnectionString $DbUrl

if ($ExpectedProjectRef -and $inferredRef -and ($ExpectedProjectRef -ne $inferredRef)) {
  throw "SUPABASE_PROJECT_REF mismatch. Expected '$ExpectedProjectRef' but DB URL appears to target '$inferredRef'."
}

if ($inferredRef) {
  Write-Host "Target Supabase project ref: $inferredRef"
} else {
  Write-Host "Target Supabase project ref could not be inferred from the DB URL."
}

if ($CheckOnly) {
  Write-Host "Running remote access check only..."
} else {
  Write-Host "Applying proof helper schema, grants, and PostgREST schema reload..."
  Invoke-PsqlFile -ConnectionString $DbUrl -SqlPath $schemaSql
}

Write-Host "Running remote access diagnostics..."
Invoke-PsqlFile -ConnectionString $DbUrl -SqlPath $checkSql

if ($AppBaseUrl) {
  Write-Host "Checking Vercel persistence diagnostics..."
  Invoke-PersistCheck -BaseUrl $AppBaseUrl
}

if ($RestSmoke) {
  Write-Host "Running Vercel persistence smoke test. This creates or reuses one row with helper_job_id ivucx-remote-access-smoke."
  Invoke-RestSmoke -BaseUrl $AppBaseUrl
  Write-Host "Rechecking Vercel persistence diagnostics..."
  Invoke-PersistCheck -BaseUrl $AppBaseUrl
}
