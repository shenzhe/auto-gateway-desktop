[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

foreach ($name in @(
    "AZURE_ARTIFACT_SIGNING_ENDPOINT",
    "AZURE_ARTIFACT_SIGNING_ACCOUNT",
    "AZURE_ARTIFACT_SIGNING_PROFILE"
)) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "The $name environment variable is required."
    }
}

$nugetPath = Join-Path $env:RUNNER_TEMP "nuget.exe"
if (-not (Test-Path -LiteralPath $nugetPath -PathType Leaf)) {
    Invoke-WebRequest `
        -Uri "https://dist.nuget.org/win-x86-commandline/latest/nuget.exe" `
        -OutFile $nugetPath
}

$clientDirectory = Join-Path $env:RUNNER_TEMP "artifact-signing-client"
if (Test-Path -LiteralPath $clientDirectory) {
    Remove-Item -LiteralPath $clientDirectory -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $clientDirectory | Out-Null

& $nugetPath install Microsoft.ArtifactSigning.Client `
    -OutputDirectory $clientDirectory `
    -ExcludeVersion | Out-Host
if ($LASTEXITCODE -ne 0) {
    throw "NuGet failed to install Microsoft.ArtifactSigning.Client with exit code $LASTEXITCODE."
}

$dlib = Get-ChildItem -LiteralPath $clientDirectory -Recurse -File -Filter "Azure.CodeSigning.Dlib.dll" |
    Where-Object { $_.FullName -match "[\\/]x64[\\/]" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
if (-not $dlib) {
    throw "Azure.CodeSigning.Dlib.dll was not found in the Artifact Signing client package."
}

$metadataPath = Join-Path $env:RUNNER_TEMP ("artifact-signing-{0}.json" -f $env:ARTIFACT_SIGNING_CORRELATION_ID)
[ordered]@{
    Endpoint = $env:AZURE_ARTIFACT_SIGNING_ENDPOINT
    CodeSigningAccountName = $env:AZURE_ARTIFACT_SIGNING_ACCOUNT
    CertificateProfileName = $env:AZURE_ARTIFACT_SIGNING_PROFILE
    CorrelationId = $env:ARTIFACT_SIGNING_CORRELATION_ID
} | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8

"AZURE_ARTIFACT_SIGNING_DLIB_PATH=$($dlib.FullName)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
"AZURE_ARTIFACT_SIGNING_METADATA_FILE=$metadataPath" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
Write-Host "Prepared Artifact Signing client and metadata."
