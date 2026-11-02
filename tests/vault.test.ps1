# Tests scripts\vault.ps1 against throwaway folders and a fake sign-in file.
# It never touches a real sign-in. Run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests\vault.test.ps1
Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

$script = Join-Path $PSScriptRoot '..\scripts\vault.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('vault-test-' + [guid]::NewGuid().ToString('N'))
$root = Join-Path $sandbox 'root'
$config = Join-Path $sandbox 'config'
$credentials = Join-Path $config '.credentials.json'
[void][IO.Directory]::CreateDirectory($config)
$idA = 'aaaaaaaaaaaaaaaa'
$idB = 'bbbbbbbbbbbbbbbb'
$script:failures = 0

function Invoke-Vault([string[]]$Arguments) {
  $output = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Root $root @Arguments
  return ($output | Select-Object -Last 1) | ConvertFrom-Json
}

function Assert-True([string]$Name, [bool]$Condition) {
  if ($Condition) { Write-Output "ok    $Name" } else { Write-Output "FAIL  $Name"; $script:failures++ }
}

try {
  [IO.File]::WriteAllText($credentials, '{"fake":"token-of-account-a"}')
  $capture = Invoke-Vault @('-Action', 'capture', '-Id', $idA, '-ConfigDir', $config)
  $sealedPath = Join-Path $root "vault\$idA.bin"
  Assert-True 'capture succeeds' ($capture.ok -eq $true)
  Assert-True 'vault file exists' ([IO.File]::Exists($sealedPath))
  $sealedText = [Text.Encoding]::ASCII.GetString([IO.File]::ReadAllBytes($sealedPath))
  Assert-True 'vault file is not plain text' (-not $sealedText.Contains('token-of-account-a'))

  [IO.File]::WriteAllText($credentials, '{"fake":"token-of-account-b"}')
  [void](Invoke-Vault @('-Action', 'capture', '-Id', $idB, '-ConfigDir', $config))
  $activate = Invoke-Vault @('-Action', 'activate', '-Id', $idA, '-ConfigDir', $config)
  Assert-True 'activate succeeds' ($activate.ok -eq $true)
  Assert-True 'activate restores the exact bytes' ([IO.File]::ReadAllText($credentials) -eq '{"fake":"token-of-account-a"}')
  Assert-True 'no temporary file is left' (@([IO.Directory]::GetFiles($config, '*.tmp')).Count -eq 0)

  $bad = Invoke-Vault @('-Action', 'capture', '-Id', '..\..\evil', '-ConfigDir', $config)
  Assert-True 'a path-like id is refused' ($bad.ok -eq $false)
  $missing = Invoke-Vault @('-Action', 'activate', '-Id', 'cccccccccccccccc', '-ConfigDir', $config)
  Assert-True 'a missing account reports failure' ($missing.ok -eq $false)
  Assert-True 'a failed activate leaves the sign-in alone' ([IO.File]::ReadAllText($credentials) -eq '{"fake":"token-of-account-a"}')
  $badFolder = Invoke-Vault @('-Action', 'discard', '-Folder', '..\..\config')
  Assert-True 'a path-like login folder is refused' ($badFolder.ok -eq $false)
  Assert-True 'the config folder survives that' ([IO.Directory]::Exists($config))

  # A newer sign-in in a window's own profile wins over the vault.
  $profileB = Join-Path $root "profiles\$idB"
  [void][IO.Directory]::CreateDirectory($profileB)
  [IO.File]::WriteAllText((Join-Path $profileB '.credentials.json'), '{"fake":"refreshed-b"}')
  [IO.File]::SetLastWriteTimeUtc((Join-Path $profileB '.credentials.json'), [DateTime]::UtcNow.AddMinutes(5))
  [void](Invoke-Vault @('-Action', 'activate', '-Id', $idB, '-ConfigDir', $config))
  Assert-True 'a newer profile copy is used' ([IO.File]::ReadAllText($credentials) -eq '{"fake":"refreshed-b"}')

  # Removing an account must unlink a junction, never empty what it points at.
  $shared = Join-Path $config 'projects'
  [void][IO.Directory]::CreateDirectory($shared)
  $sentinel = Join-Path $shared 'history.txt'
  [IO.File]::WriteAllText($sentinel, 'keep me')
  [void](New-Item -ItemType Junction -Path (Join-Path $profileB 'projects') -Target $shared)
  $remove = Invoke-Vault @('-Action', 'remove', '-Id', $idB)
  Assert-True 'remove succeeds' ($remove.ok -eq $true)
  Assert-True 'remove deletes the vault file' (-not [IO.File]::Exists((Join-Path $root "vault\$idB.bin")))
  Assert-True 'remove deletes the profile' (-not [IO.Directory]::Exists($profileB))
  Assert-True 'a shared folder survives remove' ([IO.File]::Exists($sentinel))

  # A login folder is adopted into the vault and then deleted.
  $folder = 'login-' + ('0' * 32)
  $loginPath = Join-Path $root "tmp\$folder"
  [void][IO.Directory]::CreateDirectory($loginPath)
  [IO.File]::WriteAllText((Join-Path $loginPath '.credentials.json'), '{"fake":"new"}')
  $adopt = Invoke-Vault @('-Action', 'adopt', '-Id', $idB, '-Folder', $folder)
  Assert-True 'adopt succeeds' ($adopt.ok -eq $true)
  Assert-True 'adopt deletes the plain login folder' (-not [IO.Directory]::Exists($loginPath))
  [void](Invoke-Vault @('-Action', 'activate', '-Id', $idB, '-ConfigDir', $config))
  Assert-True 'the adopted sign-in decrypts' ([IO.File]::ReadAllText($credentials) -eq '{"fake":"new"}')

  # An abandoned login folder goes; a recent one may still be in use and stays.
  $old = Join-Path $root ('tmp\login-' + ('1' * 32))
  $recent = Join-Path $root ('tmp\login-' + ('2' * 32))
  $other = Join-Path $root 'tmp\not-a-login'
  foreach ($path in @($old, $recent, $other)) { [void][IO.Directory]::CreateDirectory($path) }
  [IO.Directory]::SetLastWriteTimeUtc($old, [DateTime]::UtcNow.AddHours(-1))
  [IO.Directory]::SetLastWriteTimeUtc($other, [DateTime]::UtcNow.AddHours(-1))
  $sweep = Invoke-Vault @('-Action', 'sweep')
  Assert-True 'sweep succeeds' ($sweep.ok -eq $true)
  Assert-True 'sweep deletes an abandoned login' (-not [IO.Directory]::Exists($old))
  Assert-True 'sweep keeps a recent login' ([IO.Directory]::Exists($recent))
  Assert-True 'sweep leaves anything else alone' ([IO.Directory]::Exists($other))
} finally {
  [IO.Directory]::Delete($sandbox, $true)
}

if ($script:failures -gt 0) { Write-Output "$($script:failures) failed"; exit 1 }
Write-Output 'all passed'
