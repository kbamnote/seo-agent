<#
  Registers the agent's two scheduled tasks in Windows Task Scheduler.

  Task Scheduler rather than cron because the locked decision is that this runs
  on a Windows PC with a visible browser, so a human can clear a CAPTCHA when
  Assist Mode asks.

  Two things that matter and are easy to get wrong:

    - **-WindowStyle Normal, not Hidden.** Assist Mode opens a real browser
      window and waits for a person. A hidden task means nobody ever sees it and
      the submission times out after ten minutes.
    - **No -RunLevel Highest.** The agent needs no administrator rights, and
      granting them to something that opens web pages is a poor trade.

  Usage (from the project root, in PowerShell):

      .\scripts\install-schedule.ps1                 # install, daily 10:30 + weekly Sun 09:00
      .\scripts\install-schedule.ps1 -DailyAt 18:00
      .\scripts\install-schedule.ps1 -WhatIf         # show what it would do
      .\scripts\install-schedule.ps1 -Uninstall
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$DailyAt = '10:30',
  [string]$WeeklyAt = '09:00',
  [ValidateSet('Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')]
  [string]$WeeklyOn = 'Sunday',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$dailyName   = 'SeoAiAgent-Daily'
$weeklyName  = 'SeoAiAgent-Weekly'

function Remove-AgentTask {
  param([string]$Name)
  $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($existing) {
    if ($PSCmdlet.ShouldProcess($Name, 'Unregister scheduled task')) {
      Unregister-ScheduledTask -TaskName $Name -Confirm:$false
      Write-Host "removed $Name"
    }
  } else {
    Write-Host "$Name was not registered"
  }
}

if ($Uninstall) {
  Remove-AgentTask -Name $dailyName
  Remove-AgentTask -Name $weeklyName
  Write-Host ''
  Write-Host 'Both tasks removed. Nothing will run on a schedule any more.'
  return
}

# npm lives in a .cmd on Windows, so the action runs it through cmd.exe.
$npm = (Get-Command npm.cmd -ErrorAction SilentlyContinue)
if (-not $npm) { throw 'npm.cmd is not on PATH. Install Node 24 or open a shell where npm works.' }

function New-AgentTask {
  param(
    [string]$Name,
    [string]$ScriptArgs,
    [Microsoft.Management.Infrastructure.CimInstance]$Trigger,
    [string]$Description
  )

  Remove-AgentTask -Name $Name

  # /d sets the working directory; the agent resolves data/ and config/ from it.
  $action = New-ScheduledTaskAction `
    -Execute 'cmd.exe' `
    -Argument "/c cd /d `"$projectRoot`" && npm run $ScriptArgs >> `"$projectRoot\data\schedule.log`" 2>&1"

  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3)

  $principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

  if ($PSCmdlet.ShouldProcess($Name, 'Register scheduled task')) {
    Register-ScheduledTask `
      -TaskName $Name `
      -Action $action `
      -Trigger $Trigger `
      -Settings $settings `
      -Principal $principal `
      -Description $Description | Out-Null
    Write-Host "registered $Name"
  }
}

New-AgentTask `
  -Name $dailyName `
  -ScriptArgs 'daily' `
  -Trigger (New-ScheduledTaskTrigger -Daily -At $DailyAt) `
  -Description 'SEO agent: top up content, submit within quota, verify, refresh sheet and dashboard.'

New-AgentTask `
  -Name $weeklyName `
  -ScriptArgs 'weekly' `
  -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek $WeeklyOn -At $WeeklyAt) `
  -Description 'SEO agent: re-verify every historical link and alert on anything that died.'

Write-Host ''
Write-Host "daily  : $DailyAt"
Write-Host "weekly : $WeeklyOn $WeeklyAt"
Write-Host "log    : $projectRoot\data\schedule.log"
Write-Host ''
Write-Host 'The tasks run as you, in an interactive session, with a visible window — so'
Write-Host 'Assist Mode can ask you to clear a CAPTCHA. They only fire while you are'
Write-Host 'logged in; a missed run starts at the next logon.'
Write-Host ''
Write-Host 'Check them with:  Get-ScheduledTask -TaskName SeoAiAgent-*'
Write-Host 'Run one now with: Start-ScheduledTask -TaskName SeoAiAgent-Daily'
