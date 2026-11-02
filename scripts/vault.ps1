<#
  Encrypted sign-in storage for the account-switcher mod.

  This is the only code that touches sign-in tokens. It treats the sign-in file
  as an opaque blob: it never parses it, prints it or sends it anywhere. There
  are no network calls here. Output is one line of JSON holding no secret.

  Encryption is Windows DPAPI (CurrentUser): only this Windows user on this
  machine can decrypt a vault file.

  Actions
    capture   encrypt <ConfigDir>\.credentials.json into vault\<Id>.bin
    activate  decrypt vault\<Id>.bin over <ConfigDir>\.credentials.json
    login     run "claude auth login" in a new window against an empty folder
    adopt     encrypt a finished login folder into vault\<Id>.bin, delete it
    discard   delete a login folder
    launch    open a new window signed in as <Id>, from its own profile folder
    remove    delete an account's vault file and profile folder
    sweep     delete login folders an interrupted sign-in left behind
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('capture', 'activate', 'login', 'adopt', 'discard', 'launch', 'remove', 'sweep')]
  [string]$Action,
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Id,
  [string]$ConfigDir,
  [string]$Cwd,
  [string]$Folder
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$CredentialsName = '.credentials.json'
$SharedFolders = @('projects', 'plugins', 'skills', 'commands', 'agents')

function Write-Result([hashtable]$Result) {
  [Console]::Out.WriteLine(($Result | ConvertTo-Json -Compress))
}

function Assert-Id {
  if ($Id -notmatch '^[a-f0-9]{16}$') { throw 'Invalid account id.' }
}

function Get-Inside([string]$Parent, [string]$Name) {
  # Refuses any path that would land outside its parent.
  $full = [IO.Path]::GetFullPath((Join-Path $Parent $Name))
  $base = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  if (-not $full.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Path is outside the accounts folder.'
  }
  return $full
}

function Write-Atomic([string]$Path, [byte[]]$Bytes) {
  # Writes beside the target, then swaps, so a reader never sees half a file.
  [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllBytes($temporary, $Bytes)
    for ($attempt = 1; ; $attempt++) {
      try {
        if ([IO.File]::Exists($Path)) {
          [IO.File]::Replace($temporary, $Path, [NullString]::Value)
        } else {
          [IO.File]::Move($temporary, $Path)
        }
        return
      } catch [IO.IOException], [UnauthorizedAccessException] {
        # Another program may hold the file for a moment.
        if ($attempt -ge 5) { throw }
        Start-Sleep -Milliseconds (100 * $attempt)
      }
    }
  } finally {
    if ([IO.File]::Exists($temporary)) { [IO.File]::Delete($temporary) }
  }
}

function Protect-File([string]$Source, [string]$Destination) {
  $plain = [IO.File]::ReadAllBytes($Source)
  try {
    if ($plain.Length -eq 0) { throw 'The sign-in file is empty.' }
    $sealed = [Security.Cryptography.ProtectedData]::Protect(
      $plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    Write-Atomic $Destination $sealed
  } finally {
    [Array]::Clear($plain, 0, $plain.Length)
  }
}

function Unprotect-File([string]$Source, [string]$Destination) {
  $sealed = [IO.File]::ReadAllBytes($Source)
  $plain = [Security.Cryptography.ProtectedData]::Unprotect(
    $sealed, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  try {
    Write-Atomic $Destination $plain
  } finally {
    [Array]::Clear($plain, 0, $plain.Length)
  }
}

function Get-VaultPath { Get-Inside (Join-Path $Root 'vault') "$Id.bin" }
function Get-ProfilePath { Get-Inside (Join-Path $Root 'profiles') $Id }

function Update-VaultFromProfile([string]$VaultPath) {
  # A window with its own account refreshes its own copy; keep the newest.
  $copy = Join-Path (Get-ProfilePath) $CredentialsName
  if (-not [IO.File]::Exists($copy)) { return }
  if ((-not [IO.File]::Exists($VaultPath)) -or
      ([IO.File]::GetLastWriteTimeUtc($copy) -gt [IO.File]::GetLastWriteTimeUtc($VaultPath))) {
    Protect-File $copy $VaultPath
  }
}

function Remove-FolderSafely([string]$Path) {
  # Junctions are unlinked first, so nothing they point at can ever be deleted.
  if (-not [IO.Directory]::Exists($Path)) { return }
  foreach ($entry in [IO.Directory]::GetDirectories($Path)) {
    if (([IO.File]::GetAttributes($entry) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      [IO.Directory]::Delete($entry, $false)
    }
  }
  [IO.Directory]::Delete($Path, $true)
}

function Get-LoginFolder {
  if ($Folder -notmatch '^login-[a-f0-9]{32}$') { throw 'Invalid login folder.' }
  return Get-Inside (Join-Path $Root 'tmp') $Folder
}

try {
  switch ($Action) {
    'capture' {
      Assert-Id
      $source = Join-Path $ConfigDir $CredentialsName
      if (-not [IO.File]::Exists($source)) { throw 'No sign-in file was found.' }
      Protect-File $source (Get-VaultPath)
      Write-Result @{ ok = $true }
    }

    'activate' {
      Assert-Id
      $vault = Get-VaultPath
      Update-VaultFromProfile $vault
      if (-not [IO.File]::Exists($vault)) { throw 'This account has no saved sign-in.' }
      Unprotect-File $vault (Join-Path $ConfigDir $CredentialsName)
      Write-Result @{ ok = $true }
    }

    'login' {
      $name = 'login-' + [guid]::NewGuid().ToString('N')
      $Folder = $name
      $path = Get-LoginFolder
      [void][IO.Directory]::CreateDirectory($path)
      $env:CLAUDE_CONFIG_DIR = $path
      $claude = (Get-Command claude -ErrorAction Stop).Source
      $run = Start-Process -FilePath $claude -ArgumentList @('auth', 'login') -Wait -PassThru
      if ($run.ExitCode -ne 0 -or -not [IO.File]::Exists((Join-Path $path $CredentialsName))) {
        Remove-FolderSafely $path
        throw 'Sign-in was cancelled or did not finish.'
      }
      Write-Result @{ ok = $true; folder = $name; path = $path }
    }

    'adopt' {
      Assert-Id
      $path = Get-LoginFolder
      Protect-File (Join-Path $path $CredentialsName) (Get-VaultPath)
      Remove-FolderSafely $path
      Write-Result @{ ok = $true }
    }

    'discard' {
      Remove-FolderSafely (Get-LoginFolder)
      Write-Result @{ ok = $true }
    }

    'launch' {
      Assert-Id
      $vault = Get-VaultPath
      Update-VaultFromProfile $vault
      if (-not [IO.File]::Exists($vault)) { throw 'This account has no saved sign-in.' }
      $profilePath = Get-ProfilePath
      [void][IO.Directory]::CreateDirectory($profilePath)
      $copy = Join-Path $profilePath $CredentialsName
      if ((-not [IO.File]::Exists($copy)) -or
          ([IO.File]::GetLastWriteTimeUtc($vault) -gt [IO.File]::GetLastWriteTimeUtc($copy))) {
        Unprotect-File $vault $copy
      }
      foreach ($name in $SharedFolders) {
        $target = Join-Path $ConfigDir $name
        $link = Join-Path $profilePath $name
        if ([IO.Directory]::Exists($target) -and -not [IO.Directory]::Exists($link)) {
          [void](New-Item -ItemType Junction -Path $link -Target $target)
        }
      }
      foreach ($file in [IO.Directory]::GetFiles($ConfigDir)) {
        $name = [IO.Path]::GetFileName($file)
        if ($name -eq 'settings.json' -or $name -like '*.md') {
          [IO.File]::Copy($file, (Join-Path $profilePath $name), $true)
        }
      }
      $env:CLAUDE_CONFIG_DIR = $profilePath
      $claude = (Get-Command claude -ErrorAction Stop).Source
      [void](Start-Process -FilePath $claude -WorkingDirectory $Cwd -PassThru)
      Write-Result @{ ok = $true }
    }

    'remove' {
      Assert-Id
      $vault = Get-VaultPath
      if ([IO.File]::Exists($vault)) { [IO.File]::Delete($vault) }
      Remove-FolderSafely (Get-ProfilePath)
      Write-Result @{ ok = $true }
    }

    'sweep' {
      # Older than any sign-in can last, so none still in progress is touched.
      $tmp = Join-Path $Root 'tmp'
      $cutoff = [DateTime]::UtcNow.AddMinutes(-15)
      if ([IO.Directory]::Exists($tmp)) {
        foreach ($entry in [IO.Directory]::GetDirectories($tmp)) {
          $Folder = [IO.Path]::GetFileName($entry)
          if ($Folder -match '^login-[a-f0-9]{32}$' -and
              [IO.Directory]::GetLastWriteTimeUtc($entry) -lt $cutoff) {
            Remove-FolderSafely (Get-LoginFolder)
          }
        }
      }
      Write-Result @{ ok = $true }
    }
  }
} catch {
  Write-Result @{ ok = $false; error = $_.Exception.Message }
  exit 1
}
