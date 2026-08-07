param(
    [Parameter(Mandatory = $true)]
    [int]$RunnerId,

    [Parameter(Mandatory = $true)]
    [string]$SpecPath
)

$ErrorActionPreference = 'SilentlyContinue'
$spec = Get-Content -LiteralPath $SpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
$runner = Get-Process -Id $RunnerId -ErrorAction SilentlyContinue
if ($runner) { $runner.WaitForExit() }

if (-not (Test-Path -LiteralPath $spec.resultPath)) {
    $temporaryPath = "$($spec.resultPath).$PID.tmp"
    @{
        transferId = $spec.transferId
        status = 'cancelled'
        stage = 'window_closed'
        error = $spec.texts.windowClosed
        partPath = $spec.partPath
        updatedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json -Depth 6 -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $spec.resultPath -Force
}
