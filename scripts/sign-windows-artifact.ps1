[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath
)

$ErrorActionPreference = "Stop"

function Resolve-RequiredPath {
    param(
        [string]$ConfiguredPath,
        [string]$Description
    )

    if ($ConfiguredPath) {
        if (-not (Test-Path -LiteralPath $ConfiguredPath -PathType Leaf)) {
            throw "$Description does not exist: $ConfiguredPath"
        }
        return (Resolve-Path -LiteralPath $ConfiguredPath).Path
    }

    return $null
}

function Resolve-SignTool {
    $configured = Resolve-RequiredPath $env:WINDOWS_SIGNTOOL_PATH "SignTool"
    if ($configured) {
        return $configured
    }

    $fromPath = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }

    $roots = @(
        (Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"),
        (Join-Path $env:ProgramFiles "Windows Kits\10\bin")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }

    $candidates = foreach ($root in $roots) {
        Get-ChildItem -LiteralPath $root -Recurse -File -Filter "signtool.exe" -ErrorAction SilentlyContinue |
            Where-Object { $_.Directory.Name -eq "x64" }
    }

    $candidate = $candidates | Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $candidate) {
        throw "SignTool was not found. Install the Windows SDK or set WINDOWS_SIGNTOOL_PATH."
    }
    return $candidate.FullName
}

function Resolve-Dlib {
    $configured = Resolve-RequiredPath $env:AZURE_ARTIFACT_SIGNING_DLIB_PATH "Artifact Signing dlib"
    if ($configured) {
        return $configured
    }

    $runnerTempRoot = if ($env:RUNNER_TEMP) {
        Join-Path $env:RUNNER_TEMP "artifact-signing-client"
    } else {
        $null
    }

    $roots = @(
        $env:AZURE_ARTIFACT_SIGNING_CLIENT_DIR,
        (Join-Path $env:USERPROFILE ".nuget\packages\microsoft.artifactsigning.client"),
        (Join-Path $env:ProgramFiles "Microsoft Artifact Signing Client Tools"),
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft Artifact Signing Client Tools"),
        $runnerTempRoot
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) }

    $candidates = foreach ($root in $roots) {
        Get-ChildItem -LiteralPath $root -Recurse -File -Filter "Azure.CodeSigning.Dlib.dll" -ErrorAction SilentlyContinue |
            Sort-Object FullName -Descending
    }

    $candidate = $candidates |
        Where-Object { $_.FullName -match "[\\/]x64[\\/]" } |
        Select-Object -First 1
    if (-not $candidate) {
        $candidate = $candidates | Select-Object -First 1
    }
    if (-not $candidate) {
        throw "Azure.CodeSigning.Dlib.dll was not found. Install Artifact Signing Client Tools or set AZURE_ARTIFACT_SIGNING_DLIB_PATH."
    }
    return $candidate.FullName
}

function Resolve-MetadataFile {
    $configured = Resolve-RequiredPath $env:AZURE_ARTIFACT_SIGNING_METADATA_FILE "Artifact Signing metadata file"
    if ($configured) {
        return @{ Path = $configured; Temporary = $false }
    }

    $endpoint = $env:AZURE_ARTIFACT_SIGNING_ENDPOINT
    $account = $env:AZURE_ARTIFACT_SIGNING_ACCOUNT
    $profile = $env:AZURE_ARTIFACT_SIGNING_PROFILE
    if (-not ($endpoint -and $account -and $profile)) {
        throw "Set AZURE_ARTIFACT_SIGNING_METADATA_FILE or set AZURE_ARTIFACT_SIGNING_ENDPOINT, AZURE_ARTIFACT_SIGNING_ACCOUNT, and AZURE_ARTIFACT_SIGNING_PROFILE."
    }

    # Local and CI signing use an Azure CLI session. Skip every other credential
    # provider so the signing client fails fast instead of probing unavailable identities.
    $metadata = [ordered]@{
        Endpoint = $endpoint
        CodeSigningAccountName = $account
        CertificateProfileName = $profile
        ExcludeCredentials = @(
            "EnvironmentCredential"
            "WorkloadIdentityCredential"
            "ManagedIdentityCredential"
            "SharedTokenCacheCredential"
            "VisualStudioCredential"
            "VisualStudioCodeCredential"
            "AzurePowerShellCredential"
            "AzureDeveloperCliCredential"
            "InteractiveBrowserCredential"
        )
    }
    if ($env:AZURE_ARTIFACT_SIGNING_CORRELATION_ID) {
        $metadata.CorrelationId = $env:AZURE_ARTIFACT_SIGNING_CORRELATION_ID
    }

    $path = Join-Path ([System.IO.Path]::GetTempPath()) ("autogateway-artifact-signing-{0}.json" -f ([guid]::NewGuid()))
    $metadata | ConvertTo-Json | Set-Content -LiteralPath $path -Encoding UTF8
    return @{ Path = $path; Temporary = $true }
}

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "File to sign does not exist: $FilePath"
}

$signTool = Resolve-SignTool
$dlib = Resolve-Dlib
$metadata = Resolve-MetadataFile

try {
    $arguments = @(
        "sign",
        "/v",
        "/debug",
        "/fd", "SHA256",
        "/tr", "http://timestamp.acs.microsoft.com",
        "/td", "SHA256",
        "/dlib", $dlib,
        "/dmdf", $metadata.Path,
        $FilePath
    )

    & $signTool @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "SignTool failed with exit code $LASTEXITCODE for $FilePath"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $FilePath
    if ($signature.Status -ne "Valid") {
        throw "Windows signature validation failed for ${FilePath}: $($signature.Status) $($signature.StatusMessage)"
    }
    Write-Host "Artifact Signing signature is valid: $FilePath"
}
finally {
    if ($metadata.Temporary -and (Test-Path -LiteralPath $metadata.Path)) {
        Remove-Item -LiteralPath $metadata.Path -Force
    }
}
