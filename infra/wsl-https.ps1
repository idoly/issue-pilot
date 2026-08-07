param(
  [Parameter(Mandatory = $true)][string]$IpAddress,
  [Parameter(Mandatory = $true)][string]$PfxPath,
  [Parameter(Mandatory = $true)][string]$CerPath,
  [Parameter(Mandatory = $true)][string]$Password
)

$ErrorActionPreference = "Stop"
$friendlyName = "Issue Pilot WSL Development"
$subject = "CN=Issue Pilot WSL $IpAddress"

Get-ChildItem Cert:\CurrentUser\My |
  Where-Object { $_.FriendlyName -eq $friendlyName } |
  Remove-Item -Force
$certificate = New-SelfSignedCertificate `
  -Type Custom `
  -Subject $subject `
  -FriendlyName $friendlyName `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature, KeyEncipherment `
  -NotAfter (Get-Date).AddYears(2) `
  -TextExtension @(
    "2.5.29.17={text}IPAddress=$IpAddress&IPAddress=127.0.0.1&DNS=localhost",
    "2.5.29.37={text}1.3.6.1.5.5.7.3.1"
  )

$securePassword = ConvertTo-SecureString -String $Password -AsPlainText -Force
Export-PfxCertificate -Cert $certificate -FilePath $PfxPath -Password $securePassword -Force | Out-Null
Export-Certificate -Cert $certificate -FilePath $CerPath -Force | Out-Null
