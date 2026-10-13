<#
.SYNOPSIS
Read one KnowBook GitHub Actions CI snapshot without credentials or polling.
.EXAMPLE
pwsh -NoProfile -File scripts/check-github-ci.ps1 -Commit 0bcc33e32c7890cddec49e44a2b9db6abc607efc
.EXAMPLE
pwsh -NoProfile -File scripts/check-github-ci.ps1 -RunId 38255430916 -Format Table
.NOTES
Only public GitHub HTML is requested. No token, cookie, browser session, or git
credential is read. HTML changes and unavailable fields produce unknown/errors.
Exit codes: 0 = readable snapshot (including pending/running), 1 = failure,
2 = unknown or incomplete evidence. Invoke again yourself for another snapshot.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string] $Commit,

    [ValidatePattern('^[1-9][0-9]{0,19}$')]
    [string] $RunId,

    [ValidateSet('Json', 'Table')]
    [string] $Format = 'Json',

    [ValidateRange(1, 20)]
    [int] $MaxPages = 5
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repositoryPath = '/zhenhua32/knowbook'
$repositoryPattern = [regex]::Escape($repositoryPath)
$errors = [System.Collections.Generic.List[string]]::new()

function Get-PublicHtml([string] $Url) {
    try {
        $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 30 -Headers @{
            'User-Agent' = 'KnowBook-CI-ReadOnly'
            'Accept' = 'text/html'
            'Accept-Language' = 'en-US'
        }
        return [string] $response.Content
    }
    catch {
        # Exception bodies may contain HTML. Keep the diagnostic intentionally small.
        $httpStatus = $null
        if ($_.Exception.Response) {
            $httpStatus = [int] $_.Exception.Response.StatusCode
        }
        $detail = if ($httpStatus) { "HTTP $httpStatus" } else { 'network/request error' }
        throw "Cannot read $Url ($detail)."
    }
}

function Get-PlainText([string] $Html) {
    return ([System.Net.WebUtility]::HtmlDecode(
        [regex]::Replace($Html, '<[^>]+>', ' ')
    ) -replace '\s+', ' ').Trim()
}

function Get-State([string] $Text) {
    $value = (Get-PlainText $Text).Trim().ToLowerInvariant().TrimEnd(':').Trim()
    switch -Regex ($value) {
        '^(success|succeeded|completed successfully)$' {
            return @{ status = 'success'; conclusion = 'success' }
        }
        '^(failure|failed|completed with failure)$' {
            return @{ status = 'failure'; conclusion = 'failure' }
        }
        '^(cancelled|canceled)$' {
            return @{ status = 'failure'; conclusion = 'cancelled' }
        }
        '^(timed out|timed_out)$' {
            return @{ status = 'failure'; conclusion = 'timed_out' }
        }
        '^(skipped)$' {
            return @{ status = 'skipped'; conclusion = 'skipped' }
        }
        '^(in progress|in_progress|running)$' {
            return @{ status = 'running'; conclusion = $null }
        }
        '^(queued|waiting|pending|requested)$' {
            return @{ status = 'pending'; conclusion = $null }
        }
        default {
            return @{ status = 'unknown'; conclusion = $null }
        }
    }
}

function Get-HeadSha([string] $Html) {
    $shaPattern = '{0}/commit/([a-fA-F0-9]{{40}})(?=[/"''#?])' -f $repositoryPattern
    $shaMatches = [regex]::Matches($Html, $shaPattern)
    $values = @($shaMatches | ForEach-Object { $_.Groups[1].Value.ToLowerInvariant() } | Select-Object -Unique)
    if ($values.Count -eq 1) { return $values[0] }
    return $null
}

$result = [ordered]@{
    runId = $RunId
    url = $null
    headSha = $null
    status = 'unknown'
    conclusion = $null
    jobs = @()
    errors = @()
}

try {
    if (-not $Commit -and -not $RunId) {
        throw 'Specify -Commit <40 hexadecimal characters> or -RunId <run ID>.'
    }

    if ($Commit) { $Commit = $Commit.ToLowerInvariant() }
    if (-not $RunId) {
        # Bounded pagination locates the run; this is not a polling loop.
        for ($page = 1; $page -le $MaxPages -and -not $RunId; $page++) {
            $listing = Get-PublicHtml "https://github.com$repositoryPath/actions/workflows/ci.yml?page=$page"
            $foundRunRow = $false
            foreach ($row in [regex]::Split($listing, '<div class="Box-row')) {
                $runPattern = '<a\b[^>]*href="{0}/actions/runs/([0-9]+)"[^>]*aria-label="[^"]+"' -f $repositoryPattern
                $runLink = [regex]::Match($row, $runPattern)
                if (-not $runLink.Success) { continue }
                $foundRunRow = $true
                if ((Get-HeadSha $row) -eq $Commit) {
                    $RunId = $runLink.Groups[1].Value
                    break
                }
            }
            if (-not $foundRunRow) { break }
        }
        if (-not $RunId) {
            throw "No CI run found for commit $Commit in the first $MaxPages workflow pages."
        }
    }

    $result.runId = $RunId
    $result.url = "https://github.com$repositoryPath/actions/runs/$RunId"
    $runHtml = Get-PublicHtml $result.url
    $result.headSha = Get-HeadSha $runHtml
    if (-not $result.headSha) {
        $errors.Add('Run page does not contain one unambiguous full commit SHA.')
    }
    elseif ($Commit -and $result.headSha -ne $Commit) {
        throw "Run $RunId belongs to $($result.headSha), not requested commit $Commit."
    }

    $statusFields = [regex]::Matches($runHtml, '(?s)\bStatus</span>\s*<span\b[^>]*>([^<]+)</span>')
    $runStates = @($statusFields | ForEach-Object { Get-PlainText $_.Groups[1].Value } | Select-Object -Unique)
    if ($runStates.Count -eq 1) {
        $state = Get-State $runStates[0]
        $result.status = $state.status
        $result.conclusion = $state.conclusion
    }
    if ($result.status -eq 'unknown') {
        $errors.Add('Run status is missing, ambiguous, or not recognized.')
    }

    $jobPattern = '(?s)<a\b[^>]*href="({0}/actions/runs/{1}/job/([0-9]+))(?:[^"]*)"[^>]*>(.*?)</a>' -f $repositoryPattern, $RunId
    $jobLinks = [regex]::Matches($runHtml, $jobPattern)
    $jobIds = @($jobLinks | ForEach-Object { $_.Groups[2].Value } | Select-Object -Unique)
    if ($jobIds.Count -eq 0) {
        $errors.Add('Run page contains no readable job links; job success cannot be verified.')
    }

    $jobs = foreach ($jobId in $jobIds) {
        $job = [ordered]@{
            id = $jobId
            name = $null
            url = "https://github.com$repositoryPath/actions/runs/$RunId/job/$jobId"
            headSha = $null
            status = 'unknown'
            conclusion = $null
            errors = @()
        }
        $jobErrors = [System.Collections.Generic.List[string]]::new()
        try {
            $jobHtml = Get-PublicHtml $job.url
            $job.headSha = Get-HeadSha $jobHtml
            if ($job.headSha -and $result.headSha -and $job.headSha -ne $result.headSha) {
                throw "Job $jobId belongs to a different commit than the run."
            }
            $name = [regex]::Match($jobHtml, '(?s)<a\b[^>]*id="check-step-header-title"[^>]*>(.*?)</a>')
            if ($name.Success) { $job.name = Get-PlainText $name.Groups[1].Value }
            if (-not $job.name) { $jobErrors.Add('Job name field is missing.') }

            # This header belongs to this job. A green workflow icon elsewhere on
            # the page must never be used as evidence that this job succeeded.
            $headerPath = [regex]::Escape("$repositoryPath/runs/$jobId/header")
            $headerPattern = '(?s)<span\b[^>]*data-url="{0}"[^>]*>(.*?)</span>' -f $headerPath
            $headers = [regex]::Matches($jobHtml, $headerPattern)
            $headerStates = @($headers | ForEach-Object {
                Get-PlainText (($_.Groups[1].Value -split '<relative-time\b', 2)[0])
            } | Select-Object -Unique)
            if ($headerStates.Count -eq 1) {
                $state = Get-State $headerStates[0]
                $job.status = $state.status
                $job.conclusion = $state.conclusion
            }
            if ($job.status -eq 'unknown') {
                $jobErrors.Add('This job-specific status header is missing, ambiguous, or not recognized.')
            }
        }
        catch {
            $job.status = 'unknown'
            $job.conclusion = $null
            $jobErrors.Add($_.Exception.Message)
        }
        $job.errors = @($jobErrors)
        [pscustomobject] $job
    }
    $result.jobs = @($jobs)
}
catch {
    $result.status = 'unknown'
    $result.conclusion = $null
    $errors.Add($_.Exception.Message)
}

$result.errors = @($errors)
$snapshot = [pscustomobject] $result
if ($Format -eq 'Table') {
    $snapshot | Select-Object runId, url, headSha, status, conclusion | Format-List
    $snapshot.jobs | Select-Object id, name, status, conclusion, url | Format-Table -AutoSize -Wrap
    foreach ($message in $snapshot.errors) { Write-Output "ERROR: $message" }
    foreach ($job in $snapshot.jobs) {
        foreach ($message in $job.errors) { Write-Output "JOB $($job.id): $message" }
    }
}
else {
    $snapshot | ConvertTo-Json -Depth 6
}

if ($snapshot.errors.Count -gt 0 -or $snapshot.status -eq 'unknown' -or
    @($snapshot.jobs | Where-Object { $_.status -eq 'unknown' -or $_.errors.Count -gt 0 }).Count -gt 0) {
    exit 2
}
if ($snapshot.status -eq 'failure' -or @($snapshot.jobs | Where-Object status -EQ 'failure').Count -gt 0) {
    exit 1
}
exit 0
