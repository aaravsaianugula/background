<#
.SYNOPSIS
    Sync the media/ folder to GitHub: regenerate media.json, stage adds/deletes,
    refuse to commit non-media garbage, commit, push.

.DESCRIPTION
    One-shot helper for the Art Display webapp. Drop new image/video files into
    media/, run this script, and it will:

      1. Verify the working tree is in a sane state.
      2. Scan media/ and classify every entry as VALID media or GARBAGE.
      3. Refuse to proceed if garbage is present (use -Force to override).
      4. Run the existing build script (scripts/generate-media-json.js) to
         regenerate media.json from the real folder contents.
      5. Stage media/ adds + deletes and the regenerated media.json.
      6. Show a diff summary and (unless -Yes) ask for confirmation.
      7. Commit with an auto-generated message and push to origin/<branch>.

    Vercel's deploy hook re-runs the build server-side on push, so the live
    site picks up the new files within ~2 minutes. The browser app (app.js)
    polls media.json every 5 minutes, so already-loaded clients update too.

.PARAMETER DryRun
    Do everything except commit and push. Useful for previewing what the
    script *would* do before letting it touch git history or the remote.

.PARAMETER Yes
    Skip the interactive confirmation prompt before commit/push.

.PARAMETER Force
    Stage and commit even if garbage (non-media) files are present in media/.
    The garbage files are still NOT staged — they're just not a hard stop.

.PARAMETER Message
    Override the auto-generated commit message.

.EXAMPLE
    .\sync-media.ps1 -DryRun
    Preview what would change without touching git or the remote.

.EXAMPLE
    .\sync-media.ps1
    Sync interactively — confirm before push.

.EXAMPLE
    .\sync-media.ps1 -Yes -Message "Add weekend art batch"
    Non-interactive sync with custom commit message.
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Force,
    [string]$Message
)

# Stop on any uncaught error. PS 5.1 doesn't honor this for native exes
# (git, node) — for those we check $LASTEXITCODE explicitly.
$ErrorActionPreference = 'Stop'

# --- Config (must mirror scripts/generate-media-json.js) -----------------

$ValidExtensions = @(
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif',
    'mp4', 'webm'
)

# Same regex as the build script and app.js. Anchored, no path separators,
# no leading dot/slash/star/etc.
$ValidFilenamePattern = '^[^/\\:.*?#][^/\\:*?#]*$'

# Repo-meta filenames that are EXPECTED inside media/ but aren't slideshow
# content. They shouldn't be staged as media, and they shouldn't trip the
# garbage-detection bail-out either.
$IgnoredMetaNames = @('.gitignore', '.gitkeep', '.gitattributes')

$LargeFileWarnBytes = 50MB

# --- Helpers -------------------------------------------------------------

function Write-Section($Title) {
    Write-Host ''
    Write-Host "=== $Title ===" -ForegroundColor Cyan
}

function Write-Ok($Msg)    { Write-Host "  [OK]   $Msg" -ForegroundColor Green }
function Write-Warn2($Msg) { Write-Host "  [WARN] $Msg" -ForegroundColor Yellow }
function Write-Err2($Msg)  { Write-Host "  [ERR]  $Msg" -ForegroundColor Red }
function Write-Info($Msg)  { Write-Host "  $Msg" -ForegroundColor Gray }

function Invoke-Native {
    <#
    Run a native executable and capture stdout. Throw on non-zero exit.
    Used so we don't trip on PowerShell 5.1's "any stderr line trips $?"
    behavior with native commands.

    NB: param is named $ExeArgs (not $Args) because $Args is a reserved
    automatic variable in PowerShell. Using $Args as a param name causes
    weird shadowing where @Args splats the automatic — not your param.
    #>
    param(
        [Parameter(Mandatory)][string]$Exe,
        [string[]]$ExeArgs = @()
    )
    $output = & $Exe @ExeArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$Exe $($ExeArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
    return $output
}

function Invoke-Git {
    <#
    Wrapper around git that:
      - disables core.quotePath so non-ASCII filenames (e.g. U+2013 EN DASH)
        round-trip as UTF-8 verbatim instead of "\342\200\223" octal escapes.
        Without this, ls-files output won't string-compare to Get-ChildItem
        output and we'd see phantom add/delete pairs for the same file.
      - throws on non-zero exit via Invoke-Native.
    #>
    param([string[]]$GitArgs = @())
    return Invoke-Native git (@('-c', 'core.quotePath=false') + $GitArgs)
}

function Get-Extension($Name) {
    $i = $Name.LastIndexOf('.')
    if ($i -lt 1) { return '' }
    return $Name.Substring($i + 1).ToLowerInvariant()
}

# --- Pre-flight ----------------------------------------------------------

Write-Section 'Pre-flight checks'

# Move to the script's directory (= repo root, since the script lives there).
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $RepoRoot

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot '.git') -PathType Container)) {
    Write-Err2 "Not at a git repo root: $RepoRoot"
    exit 1
}
Write-Ok "Repo root: $RepoRoot"

$MediaDir = Join-Path $RepoRoot 'media'
if (-not (Test-Path -LiteralPath $MediaDir -PathType Container)) {
    Write-Err2 "media/ folder not found at $MediaDir"
    exit 1
}
Write-Ok 'media/ folder present'

# Tooling
foreach ($tool in @('git', 'node')) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Err2 "Required tool not on PATH: $tool"
        exit 1
    }
}
Write-Ok 'git and node on PATH'

# Branch
$branch = (Invoke-Git @('rev-parse', '--abbrev-ref', 'HEAD')).Trim()
if ($branch -ne 'main') {
    Write-Warn2 "On branch '$branch', not 'main'. Will still push to origin/$branch."
} else {
    Write-Ok "On branch main"
}

# Make sure remote 'origin' exists
$remotes = Invoke-Git @('remote')
if ($remotes -notcontains 'origin') {
    Write-Err2 "No 'origin' remote configured."
    exit 1
}
$originUrl = (Invoke-Git @('remote', 'get-url', 'origin')).Trim()
Write-Ok "origin -> $originUrl"

# Refuse to run if the index already contains staged changes for media/* or
# media.json. We can't safely add our own staging on top: the bare commit
# would sweep the pre-existing entries into our auto-generated message, and
# the abort/reset path would silently un-stage them.
$preStagedMedia = @(Invoke-Git @('diff', '--cached', '--name-only', '--', 'media', 'media.json'))
$preStagedMedia = $preStagedMedia | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
if ($preStagedMedia.Count -gt 0 -and -not $Force) {
    Write-Err2 'Index already has staged changes for media/* or media.json:'
    foreach ($p in $preStagedMedia) { Write-Info "  - $p" }
    Write-Info 'Commit, stash, or reset those first.'
    Write-Info '(Rerun with -Force to ignore - those entries will be committed too.)'
    exit 3
}

# Inform (don't block) about other working-tree noise — it won't be touched
# because we commit with `--only` against an explicit pathspec.
$dirtyOutside = Invoke-Git @('status', '--porcelain')
$strayPaths = @()
foreach ($line in $dirtyOutside) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    # Format: "XY path" — take everything after the 3-char prefix.
    $path = $line.Substring(3).Trim('"')
    # Account for renames "old -> new"
    if ($path -match ' -> ') { $path = ($path -split ' -> ')[1].Trim('"') }
    $isMedia    = $path -like 'media/*' -or $path -like 'media\*'
    $isMediaJson = $path -eq 'media.json'
    if (-not $isMedia -and -not $isMediaJson) {
        $strayPaths += $path
    }
}
if ($strayPaths.Count -gt 0) {
    Write-Warn2 'Working tree has changes outside media/:'
    foreach ($p in $strayPaths) { Write-Info "  - $p" }
    Write-Info '(They will NOT be staged or committed - this script uses --only with a media pathspec.)'
}

# --- Scan media/ ---------------------------------------------------------

Write-Section 'Scanning media/ folder'

$ValidMedia = New-Object System.Collections.Generic.List[string]
$Garbage    = New-Object System.Collections.Generic.List[pscustomobject]
$LargeFiles = New-Object System.Collections.Generic.List[pscustomobject]

# Top-level only. The build script does the same — no recursion into subdirs.
$entries = Get-ChildItem -LiteralPath $MediaDir -Force -File -ErrorAction Stop
foreach ($e in $entries) {
    $name = $e.Name

    # Skip known repo-meta files (e.g. media/.gitignore) without flagging them.
    if ($IgnoredMetaNames -contains $name) {
        continue
    }

    $ext  = Get-Extension $name

    if (-not ($name -match $ValidFilenamePattern)) {
        $Garbage.Add([pscustomobject]@{ Name = $name; Reason = 'invalid filename' })
        continue
    }
    if (-not ($ValidExtensions -contains $ext)) {
        $reason = if ($ext) { "unsupported extension: .$ext" } else { 'no extension' }
        $Garbage.Add([pscustomobject]@{ Name = $name; Reason = $reason })
        continue
    }

    $ValidMedia.Add($name)

    if ($e.Length -gt $LargeFileWarnBytes) {
        $sizeMB = [math]::Round($e.Length / 1MB, 1)
        $LargeFiles.Add([pscustomobject]@{ Name = $name; SizeMB = $sizeMB })
    }
}

Write-Ok  ("Valid media files:  {0}" -f $ValidMedia.Count)
if ($Garbage.Count -gt 0) {
    Write-Warn2 ("Garbage entries:    {0}" -f $Garbage.Count)
    foreach ($g in $Garbage) { Write-Info ("  - {0,-60} ({1})" -f $g.Name, $g.Reason) }
} else {
    Write-Ok 'Garbage entries:    0'
}
if ($LargeFiles.Count -gt 0) {
    Write-Warn2 ("Large media files (>{0}MB):" -f ($LargeFileWarnBytes / 1MB))
    foreach ($l in $LargeFiles) { Write-Info ("  - {0,-60} ({1} MB)" -f $l.Name, $l.SizeMB) }
}

if ($Garbage.Count -gt 0 -and -not $Force) {
    Write-Err2  ('Refusing to proceed: {0} non-media file(s) in media/.' -f $Garbage.Count)
    Write-Info  'Move them out of media/ (or rerun with -Force to ignore).'
    Write-Info  "Tip: media/.gitignore now blocks common garbage extensions (.exe, etc.),"
    Write-Info  "so those files won't be staged either way."
    exit 2
}

# --- Compare to git ------------------------------------------------------

Write-Section 'Diffing media/ against git'

# Files git currently knows about under media/.
$trackedRaw = Invoke-Git @('ls-files', '--', 'media')
$tracked = New-Object System.Collections.Generic.HashSet[string]
foreach ($t in $trackedRaw) {
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    # ls-files returns "media/foo.jpg" — strip the prefix to compare to disk names.
    $rel = $t -replace '^media[\\/]', ''
    [void]$tracked.Add($rel)
}

$onDisk = New-Object System.Collections.Generic.HashSet[string]
foreach ($v in $ValidMedia) { [void]$onDisk.Add($v) }

$adds    = @($onDisk    | Where-Object { -not $tracked.Contains($_) }) | Sort-Object
$deletes = @($tracked   | Where-Object { -not $onDisk.Contains($_) }) | Sort-Object

Write-Ok  ("Files to add:       {0}" -f $adds.Count)
foreach ($a in $adds)    { Write-Info "  + $a" }
Write-Ok  ("Files to delete:    {0}" -f $deletes.Count)
foreach ($d in $deletes) { Write-Info "  - $d" }

if ($adds.Count -eq 0 -and $deletes.Count -eq 0) {
    Write-Section 'Nothing to do'
    # Still regenerate media.json in case it's drifted.
    Write-Info 'Regenerating media.json anyway in case it drifted...'
    Invoke-Native node @('scripts/generate-media-json.js') | ForEach-Object { Write-Info $_ }
    $mediaJsonStatus = Invoke-Git @('status', '--porcelain', '--', 'media.json')
    if ([string]::IsNullOrWhiteSpace($mediaJsonStatus)) {
        Write-Ok 'media.json already in sync. Nothing to commit.'
        exit 0
    }
    Write-Warn2 'media.json was out of sync; will commit just that.'
}

# --- Regenerate media.json -----------------------------------------------

Write-Section 'Regenerating media.json'
$buildOutput = Invoke-Native node @('scripts/generate-media-json.js')
foreach ($line in $buildOutput) { Write-Info $line }

# --- Stage --------------------------------------------------------------

Write-Section 'Staging changes'

# Track exactly the paths this script staged. Used for both the commit
# pathspec (so we never commit anything else from the index) and for the
# abort path (so we only un-stage paths we ourselves staged).
$stagedPaths = New-Object System.Collections.Generic.List[string]

if ($DryRun) {
    Write-Warn2 'DryRun: skipping git add/commit/push.'
} else {
    # Stage adds.
    foreach ($a in $adds) {
        $rel = "media/$a"
        Invoke-Git @('add', '--', $rel) | Out-Null
        $stagedPaths.Add($rel)
    }
    # Stage deletes.
    foreach ($d in $deletes) {
        $rel = "media/$d"
        Invoke-Git @('rm', '--', $rel) | Out-Null
        $stagedPaths.Add($rel)
    }
    # Stage media.json (may or may not have changed).
    Invoke-Git @('add', '--', 'media.json') | Out-Null
    $stagedPaths.Add('media.json')

    # Show what we actually staged so the user can verify before push.
    $staged = Invoke-Git @('diff', '--cached', '--name-status')
    if ($staged -and $staged.Count -gt 0) {
        Write-Info 'Staged for commit:'
        foreach ($s in $staged) { Write-Info "  $s" }
    } else {
        Write-Ok 'Nothing ended up staged. Exiting.'
        exit 0
    }
}

# --- Commit message ------------------------------------------------------

if (-not $Message) {
    $parts = @()
    if ($adds.Count    -gt 0) { $parts += "+$($adds.Count)" }
    if ($deletes.Count -gt 0) { $parts += "-$($deletes.Count)" }
    if ($parts.Count -eq 0)   { $parts += 'media.json sync' }
    $Message = "Sync media: $($parts -join ' ')"
}

# --- Confirm -------------------------------------------------------------

Write-Section 'Ready to commit and push'
Write-Info  ("Branch:  {0}" -f $branch)
Write-Info  ("Remote:  {0}" -f $originUrl)
Write-Info  ("Message: {0}" -f $Message)

if ($DryRun) {
    Write-Warn2 'DryRun: stopping before commit/push. No changes were made to git.'
    exit 0
}

if (-not $Yes) {
    $resp = Read-Host 'Proceed? [y/N]'
    if ($resp -notmatch '^(y|yes)$') {
        Write-Warn2 'Aborted by user. Resetting only the paths this script staged.'
        # Only unstage paths we ourselves added/removed. Never `git reset
        # HEAD -- media` blanket — that would clobber pre-existing user-
        # staged changes within media/.
        if ($stagedPaths.Count -gt 0) {
            $resetArgs = @('reset', 'HEAD', '--') + $stagedPaths
            Invoke-Git $resetArgs | Out-Null
        }
        exit 0
    }
}

# --- Commit + push -------------------------------------------------------

Write-Section 'Committing and pushing'
# `git commit --only -- <paths>` commits only the specified pathspec,
# regardless of what else is in the index. This is the contract: this script
# only ever commits media files and media.json, never anything else.
$commitArgs = @('commit', '--only', '-m', $Message, '--') + $stagedPaths
Invoke-Git $commitArgs | ForEach-Object { Write-Info $_ }
Invoke-Git @('push', 'origin', $branch) | ForEach-Object { Write-Info $_ }

Write-Section 'Done'
Write-Ok  'Pushed to GitHub. Vercel will rebuild within ~2 minutes.'
Write-Info 'Already-loaded browsers will pick up the new media.json on their next poll (within 5 min).'
