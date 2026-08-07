param(
    [Parameter(Mandatory = $true)]
    [string]$RunnerPath,

    [Parameter(Mandatory = $true)]
    [string]$SpecPath
)

$ErrorActionPreference = 'Stop'
$spec = $null
$runner = $null

# This window must remain visible and interactive: the user enters host-key
# confirmation and credentials directly into OpenSSH, never through MCP.
try {
    $spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $watcherPath = Join-Path $PSScriptRoot 'watch-scp-download.ps1'
    $systemDirectory = [Environment]::SystemDirectory
    $powershellPath = Join-Path $systemDirectory 'WindowsPowerShell\v1.0\powershell.exe'
    foreach ($requiredPath in @($powershellPath, $watcherPath, $RunnerPath, $SpecPath)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required launch file was not found: $requiredPath"
        }
    }
    $arguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ('"{0}"' -f $RunnerPath),
        '-SpecPath',
        ('"{0}"' -f $SpecPath)
    )
    $runner = Start-Process -FilePath $powershellPath -ArgumentList $arguments -WindowStyle Normal -PassThru
    $watcherArguments = @(
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        ('"{0}"' -f $watcherPath),
        '-RunnerId',
        [string]$runner.Id,
        '-SpecPath',
        ('"{0}"' -f $SpecPath)
    )
    Start-Process -FilePath $powershellPath -ArgumentList $watcherArguments -WindowStyle Hidden
}
catch {
    $message = if ($spec) { "$($spec.texts.launcherFailed) $($_.Exception.Message)" } else { $_.Exception.Message }
    if ($spec -and -not (Test-Path -LiteralPath $spec.resultPath)) {
        $temporaryPath = "$($spec.resultPath).$PID.tmp"
        @{
            transferId = $spec.transferId
            status = 'failed'
            stage = 'launch'
            error = $message
            partPath = $spec.partPath
            updatedAt = [DateTime]::UtcNow.ToString('o')
        } | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
        Move-Item -LiteralPath $temporaryPath -Destination $spec.resultPath -Force
    }
    exit 1
}
