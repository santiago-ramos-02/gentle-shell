# Keeps Pi on upstream gentle-pi main plus this fork's API.
#
# Merges upstream/main into main, checks the build, and installs a clean copy of
# main at <agent home>/gentle-pi-t3, which Pi's settings.json then declares in
# place of npm:gentle-pi. The checkout itself is never what Pi loads, so work in
# progress here cannot break Pi. Merging (not rebasing) keeps main pushable
# without a force push. Any failure (dirty tree, merge conflict, failing checks,
# an install that cannot answer `describe`) stops before the swap, so the
# working copy is never replaced by a broken one. Runs daily from the
# "gentle-pi T3 update" scheduled task.
#
# The version is main's package version plus the fork commit installed, such as
# 3.7.0-t3.232bfd4, so any new commit triggers a reinstall.
#
# Opting out: -Uninstall declares npm:gentle-pi again (installing it if Pi has
# no copy) and leaves this copy on disk until the next update removes it.

param(
  [string]$AgentHome = $(if ($env:GENTLE_PI_AGENT_HOME) { $env:GENTLE_PI_AGENT_HOME }
    elseif ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR }
    else { Join-Path $HOME '.pi\agent' }),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Branch = 'main'
$Repo = Split-Path -Parent $PSScriptRoot
$Install = Join-Path $AgentHome 'gentle-pi-t3'
$Settings = Join-Path $AgentHome 'settings.json'
$Log = Join-Path $AgentHome 'gentle-pi-t3-update.log'
New-Item -ItemType Directory -Force $AgentHome | Out-Null

function Write-Log([string]$Message) {
  $line = "$(Get-Date -Format s) $Message"
  Write-Host $line
  Add-Content -Path $Log -Value $line
}

function Invoke-Git {
  $output = & git -C $Repo @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') failed: $output" }
  $output
}

function Invoke-Checked([string]$What, [scriptblock]$Command) {
  $output = & $Command 2>&1
  if ($LASTEXITCODE -ne 0) { throw "$What failed: $(($output | Select-Object -Last 5) -join ' ')" }
  $output
}

# Declares `source` as Pi's gentle-pi package, replacing any other gentle-pi
# declaration and keeping the rest of settings.json and its two-space format.
function Set-GentlePiDeclaration([string]$Source) {
  $script = @'
const fs = require("node:fs");
const path = require("node:path");
const [settingsPath, source] = process.argv.slice(1);
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
const isGentlePi = (entry) => {
  const value = typeof entry === "string" ? entry : entry && entry.source;
  if (typeof value !== "string") return false;
  if (/^npm:gentle-pi(@|$)/.test(value)) return true;
  const dir = path.resolve(path.dirname(settingsPath), value);
  try { return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name === "gentle-pi"; } catch { return false; }
};
const packages = Array.isArray(settings.packages) ? settings.packages : [];
const index = packages.findIndex(isGentlePi);
const next = packages.filter((entry, i) => i === index || !isGentlePi(entry));
if (index === -1) next.unshift(source); else next[next.indexOf(packages[index])] = source;
if (JSON.stringify(next) === JSON.stringify(packages)) process.exit(0);
settings.packages = next;
const temporary = `${settingsPath}.t3-update.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
fs.renameSync(temporary, settingsPath);
'@
  Invoke-Checked 'updating settings.json' { node -e $script $Settings $Source } | Out-Null
}

try {
  if ($Uninstall) {
    $npmCopy = Join-Path $AgentHome 'npm\node_modules\gentle-pi\package.json'
    if (-not (Test-Path $npmCopy)) {
      $env:PI_CODING_AGENT_DIR = $AgentHome
      Invoke-Checked 'pi install npm:gentle-pi' { pi install npm:gentle-pi } | Out-Null
    }
    Set-GentlePiDeclaration 'npm:gentle-pi'
    Write-Log 'Pi declares npm:gentle-pi again'
    exit 0
  }

  if ((Invoke-Git rev-parse --abbrev-ref HEAD) -ne $Branch) { throw "$Repo is not on $Branch" }
  if (Invoke-Git status --porcelain) { throw "$Repo has uncommitted changes" }

  Invoke-Git fetch --quiet upstream | Out-Null
  $upstream = Invoke-Git rev-parse upstream/main
  & git -C $Repo merge-base --is-ancestor $upstream HEAD
  if ($LASTEXITCODE -ne 0) {
    & git -C $Repo merge --quiet --no-edit -m 'chore(fork): sync upstream' upstream/main 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
      & git -C $Repo merge --abort 2>&1 | Out-Null
      throw "merging upstream/main ($($upstream.Substring(0, 9))) conflicts; resolve it by hand"
    }
  }

  Push-Location $Repo
  try {
    # Upstream changes to a library the API loads leave its generated module stale.
    Invoke-Checked 'pnpm install' { pnpm install --frozen-lockfile --ignore-scripts } | Out-Null
    Invoke-Checked 'building runtime modules' { node scripts/build-runtime-modules.mjs --write } | Out-Null
    if (Invoke-Git status --porcelain runtime) {
      Invoke-Git add runtime | Out-Null
      Invoke-Git commit --quiet -m 'chore(fork): regenerate runtime modules' | Out-Null
    }
    Invoke-Checked 'API tests' { node --experimental-strip-types --test tests/gentle-pi-api.test.ts } | Out-Null
  } finally {
    Pop-Location
  }

  $packageVersion = (Get-Content (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json).version
  $version = "$packageVersion-t3.$((Invoke-Git rev-parse --short=7 HEAD))"
  $versionFile = Join-Path $Install '.t3-version'
  $installed = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() }
  if ($installed -eq $version) {
    Set-GentlePiDeclaration $Install
    Write-Log "up to date at $version"
    exit 0
  }

  $stage = "$Install.new"
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  $archive = Join-Path ([IO.Path]::GetTempPath()) "gentle-pi-$version.zip"
  Invoke-Git archive --format=zip -o $archive HEAD | Out-Null
  Expand-Archive -Path $archive -DestinationPath $stage
  Remove-Item $archive -Force
  Push-Location $stage
  try {
    # Like Pi's own install: runtime dependencies only, Pi supplies its peers, and the
    # postinstall fetches the gentle-ai release this gentle-pi is pinned to.
    Invoke-Checked 'npm install' { npm install --omit=dev --omit=peer --no-audit --no-fund --no-package-lock } | Out-Null
  } finally {
    Pop-Location
  }
  $describe = '{}' | & node (Join-Path $stage 'bin\gentle-pi-api.mjs') describe | Select-Object -Last 1 | ConvertFrom-Json
  if ($describe.type -ne 'result') { throw 'the new install does not answer describe' }
  Set-Content -Path (Join-Path $stage '.t3-version') -Value $version

  # A running Pi keeps gentle-ai.exe open inside the copy, which blocks renaming it;
  # the next run retries.
  $previous = "$Install.previous"
  if (Test-Path $previous) { Remove-Item $previous -Recurse -Force }
  if (Test-Path $Install) { Move-Item $Install $previous }
  Move-Item $stage $Install
  Set-GentlePiDeclaration $Install
  Write-Log "installed $version (was $(if ($installed) { $installed } else { 'npm:gentle-pi' }))"
} catch {
  Write-Log "FAILED: $_"
  exit 1
}
