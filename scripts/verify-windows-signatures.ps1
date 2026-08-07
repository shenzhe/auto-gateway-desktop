[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]]$Files
)

$ErrorActionPreference = "Stop"

foreach ($file in $Files) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "File to verify does not exist: $file"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne "Valid") {
        throw "Windows signature validation failed for ${file}: $($signature.Status) $($signature.StatusMessage)"
    }

    $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { "unknown signer" }
    Write-Host "Valid Windows signature: $file [$subject]"
}
