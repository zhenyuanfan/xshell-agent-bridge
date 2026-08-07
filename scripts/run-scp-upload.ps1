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

function Resolve-OpenSshExecutable {
    param(
        [string]$ConfiguredPath,
        [string]$ExecutableName
    )
    if (Test-Path -LiteralPath $ConfiguredPath -PathType Leaf) {
        return $ConfiguredPath
    }
    $sysnativePath = Join-Path $env:SystemRoot "Sysnative\OpenSSH\$ExecutableName"
    if (Test-Path -LiteralPath $sysnativePath -PathType Leaf) {
        return $sysnativePath
    }
    throw "未找到 Windows OpenSSH $ExecutableName：$ConfiguredPath"
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

    if (-not (Test-Path -LiteralPath $spec.localPath -PathType Leaf)) {
        throw "待上传的本地文件不存在：$($spec.localPath)"
    }
    $localFile = Get-Item -LiteralPath $spec.localPath
    if ($localFile.Length -ne [long]$spec.size) {
        throw "本地文件大小在确认后发生变化，已停止上传。"
    }
    $currentHash = (Get-FileHash -LiteralPath $spec.localPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($currentHash -ne ([string]$spec.expectedSha256).ToLowerInvariant()) {
        throw "本地文件 SHA-256 在确认后发生变化，已停止上传。"
    }

    Write-Progress -Status 'running' -Stage 'authentication_and_upload' -Extra @{
        size = $localFile.Length
        sha256 = $currentHash
        localPath = $spec.localPath
        partPath = $spec.remotePartPath
    }
    Write-Host ''
    Write-Host $spec.texts.consoleIntro -ForegroundColor Yellow
    Write-Host $spec.texts.transferring -ForegroundColor Cyan
    Write-Host ''

    $scpExecutable = Resolve-OpenSshExecutable -ConfiguredPath ([string]$spec.scpPath) -ExecutableName 'scp.exe'
    $scpArguments = @(
        '-P', [string]$spec.port,
        '-o', 'BatchMode=no',
        '--',
        [string]$spec.localPath,
        [string]$spec.remoteDestination
    )
    & $scpExecutable @scpArguments
    $scpExitCode = $LASTEXITCODE
    if ($scpExitCode -ne 0) {
        throw "scp 退出，代码为 $scpExitCode"
    }

    Write-Progress -Status 'awaiting_user' -Stage 'finalize_approval' -Extra @{
        size = $localFile.Length
        sha256 = $currentHash
        localPath = $spec.localPath
        partPath = $spec.remotePartPath
    }
    $finalizeMessage = @(
        $spec.texts.finalizeHeader,
        '',
        "$($spec.texts.sizeLabel)：$($localFile.Length) bytes",
        "$($spec.texts.hashLabel)：$currentHash",
        "$($spec.texts.partPathLabel)：$($spec.remotePartPath)",
        "$($spec.texts.finalPathLabel)：$($spec.remotePath)"
    ) -join "`r`n"
    if (-not (Show-Confirmation -Message $finalizeMessage)) {
        Write-Result -Status 'rejected' -Stage 'finalize_approval' -Extra @{
            size = $localFile.Length
            sha256 = $currentHash
            localPath = $spec.localPath
            partPath = $spec.remotePartPath
        }
        Show-Information -Message $spec.texts.rejectFinalize
        exit 0
    }

    Write-Progress -Status 'running' -Stage 'remote_verification_and_finalize' -Extra @{
        size = $localFile.Length
        sha256 = $currentHash
        localPath = $spec.localPath
        partPath = $spec.remotePartPath
    }
    Write-Host ''
    Write-Host '请再次亲自完成服务器认证。随后只会校验远程临时文件，并在目标不存在时改名。' -ForegroundColor Yellow
    Write-Host ''

    $sshExecutable = Resolve-OpenSshExecutable -ConfiguredPath ([string]$spec.sshPath) -ExecutableName 'ssh.exe'
    $sshArguments = @(
        '-p', [string]$spec.port,
        '-o', 'BatchMode=no',
        [string]$spec.remoteTarget,
        [string]$spec.remoteFinalizeCommand
    )
    & $sshExecutable @sshArguments
    $sshExitCode = $LASTEXITCODE
    if ($sshExitCode -ne 0) {
        throw "服务器校验或不覆盖改名失败，ssh 退出代码为 $sshExitCode。远程临时文件会保留。"
    }

    Write-Result -Status 'completed' -Stage 'completed' -Extra @{
        size = $localFile.Length
        sha256 = $currentHash
        localPath = $spec.localPath
        remotePath = $spec.remotePath
    }
    Show-Information -Message "$($spec.texts.completed)`r`n`r`n$($spec.remotePath)"
    exit 0
}
catch {
    $message = $_.Exception.Message
    if ($spec) {
        Write-Result -Status 'failed' -Stage 'transfer' -Extra @{
            error = $message
            localPath = $spec.localPath
            partPath = $spec.remotePartPath
        }
        Show-ErrorMessage -Message "$($spec.texts.failedPrefix)$message"
    }
    exit 1
}
