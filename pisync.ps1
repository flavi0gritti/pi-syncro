# pi-syncro wrapper per Windows PowerShell
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cliPath = Join-Path $scriptDir "cli.mjs"
node $cliPath $args
