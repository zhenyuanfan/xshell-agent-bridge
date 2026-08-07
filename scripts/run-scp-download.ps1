param(
    [Parameter(Mandatory = $true)]
    [string]$SpecPath
)

$ErrorActionPreference = 'Stop'
$spec = $null

function Write-JsonAtomic {
    param(
        [string]$Path,
        [hashtable]$Value
    )
    $temporaryPath = "$Path.$PID.tmp"
    $Value | ConvertTo-Json -Depth 8 -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Write-Progress {
    param(
        [string]$Status,
        [string]$Stage,
        [hashtable]$Extra = @{}
    )
    $value = @{
        transferId = $spec.transferId
        status = $Status
        stage = $Stage
        updatedAt = [DateTime]::UtcNow.ToString('o')
    }
    foreach ($key in $Extra.Keys) { $value[$key] = $Extra[$key] }
    Write-JsonAtomic -Path $spec.progressPath -Value $value
}

function Write-Result {
    param(
        [string]$Status,
        [string]$Stage,
        [hashtable]$Extra = @{}
    )
    $value = @{
        transferId = $spec.transferId
        status = $Status
        stage = $Stage
        updatedAt = [DateTime]::UtcNow.ToString('o')
    }
    foreach ($key in $Extra.Keys) { $value[$key] = $Extra[$key] }
    Write-JsonAtomic -Path $spec.resultPath -Value $value
}

function Show-Confirmation {
    param([string]$Message)
    $answer = [System.Windows.Forms.MessageBox]::Show(
        $Message,
        $spec.texts.title,
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Warning,
        [System.Windows.Forms.MessageBoxDefaultButton]::Button2
    )
    return $answer -eq [System.Windows.Forms.DialogResult]::Yes
}

function Show-Information {
    param([string]$Message)
    [void][System.Windows.Forms.MessageBox]::Show(
        $Message,
        $spec.texts.title,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Information
    )
}

function Show-ErrorMessage {
    param([string]$Message)
    [void][System.Windows.Forms.MessageBox]::Show(
        $Message,
        $spec.texts.title,
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
}

try {
    Add-Type -AssemblyName System.Windows.Forms
    $spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $Host.UI.RawUI.WindowTitle = $spec.texts.consoleTitle

    if (-not $spec.initialApprovalHandledByXshell) {
        if (-not (Show-Confirmation -Message $spec.texts.initialApproval)) {
            Write-Result -Status 'rejected' -Stage 'initial_approval'
            Show-Information -Message $spec.texts.rejectInitial
            exit 0
        }
    }

    if (Test-Path -LiteralPath $spec.finalPath) {
        throw "The destination file already exists: $($spec.finalPath)"
    }

    Write-Progress -Status 'running' -Stage 'authentication_and_transfer'
    Write-Host ''
    Write-Host $spec.texts.consoleIntro -ForegroundColor Yellow
    Write-Host $spec.texts.transferring -ForegroundColor Cyan
    Write-Host ''

    $scpExecutable = [string]$spec.scpPath
    if (-not (Test-Path -LiteralPath $scpExecutable -PathType Leaf)) {
        $sysnativeScp = Join-Path $env:SystemRoot 'Sysnative\OpenSSH\scp.exe'
        if (Test-Path -LiteralPath $sysnativeScp -PathType Leaf) {
            $scpExecutable = $sysnativeScp
        }
        else {
            throw "OpenSSH scp.exe was not found: $scpExecutable"
        }
    }
    $scpArguments = @(
        '-P', [string]$spec.port,
        '-o', 'BatchMode=no',
        '--',
        [string]$spec.remoteSource,
        [string]$spec.partPath
    )
    & $scpExecutable @scpArguments
    $scpExitCode = $LASTEXITCODE
    if ($scpExitCode -ne 0) {
        throw "scp exited with code $scpExitCode"
    }
    if (-not (Test-Path -LiteralPath $spec.partPath -PathType Leaf)) {
        throw 'scp reported success but the temporary file was not created.'
    }

    $file = Get-Item -LiteralPath $spec.partPath
    $sha256 = (Get-FileHash -LiteralPath $spec.partPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($spec.expectedSha256 -and $sha256 -ne ([string]$spec.expectedSha256).ToLowerInvariant()) {
        Write-Result -Status 'failed' -Stage 'hash_verification' -Extra @{
            size = $file.Length
            sha256 = $sha256
            partPath = $spec.partPath
            error = $spec.texts.hashMismatch
        }
        Show-ErrorMessage -Message $spec.texts.hashMismatch
        exit 2
    }

    Write-Progress -Status 'awaiting_user' -Stage 'finalize_approval' -Extra @{
        size = $file.Length
        sha256 = $sha256
        partPath = $spec.partPath
    }
    $expectedHashLine = ''
    if ($spec.expectedSha256) {
        $expectedHashLine = "`r`n$($spec.texts.expectedHashLabel)：$($spec.expectedSha256)"
    }
    $finalizeMessage = @(
        $spec.texts.finalizeHeader,
        '',
        "$($spec.texts.sizeLabel)：$($file.Length) bytes",
        "$($spec.texts.hashLabel)：$sha256$expectedHashLine",
        "$($spec.texts.finalPathLabel)：$($spec.finalPath)"
    ) -join "`r`n"
    if (-not (Show-Confirmation -Message $finalizeMessage)) {
        Write-Result -Status 'rejected' -Stage 'finalize_approval' -Extra @{
            size = $file.Length
            sha256 = $sha256
            partPath = $spec.partPath
        }
        Show-Information -Message $spec.texts.rejectFinalize
        exit 0
    }

    if (Test-Path -LiteralPath $spec.finalPath) {
        throw "The destination file appeared before finalization: $($spec.finalPath)"
    }
    Move-Item -LiteralPath $spec.partPath -Destination $spec.finalPath
    Write-Result -Status 'completed' -Stage 'completed' -Extra @{
        size = $file.Length
        sha256 = $sha256
        localPath = $spec.finalPath
    }
    Show-Information -Message "$($spec.texts.completed)`r`n`r`n$($spec.finalPath)"
    exit 0
}
catch {
    $message = $_.Exception.Message
    if ($spec) {
        Write-Result -Status 'failed' -Stage 'transfer' -Extra @{
            error = $message
            partPath = $spec.partPath
        }
        Show-ErrorMessage -Message "$($spec.texts.failedPrefix)$message"
    }
    exit 1
}
