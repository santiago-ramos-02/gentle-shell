# Keeps this fork on upstream gentle-pi main, releases it, and keeps Pi on it.
#
# Merges upstream/main into main, checks the fork's additions, and pushes main
# to origin, where .github/workflows/t3-release.yml publishes it as a release.
# Pi then installs the fork the same way anyone else does, from git
# (git:github.com/<owner>/gentle-shell) in place of npm:gentle-pi, and
# `pi update` moves it to the new main. Merging (not rebasing) keeps main
# pushable without a force push. Any failure (dirty tree, merge conflict,
# failing checks) stops before the push, so neither the release nor Pi gets a
# broken build. Runs daily from the "gentle-pi T3 update" scheduled task.
#
# Opting out: -Uninstall declares npm:gentle-pi again.

param(
  [string]$AgentHome = $(if ($env:GENTLE_PI_AGENT_HOME) { $env:GENTLE_PI_AGENT_HOME }
    elseif ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR }
    else { Join-Path $HOME '.pi\agent' }),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$Branch = 'main'
$Repo = Split-Path -Parent $PSScriptRoot
$Settings = Join-Path $AgentHome 'settings.json'
$Log = Join-Path $AgentHome 'gentle-pi-t3-update.log'
New-Item -ItemType Directory -Force $AgentHome | Out-Null
$env:PI_CODING_AGENT_DIR = $AgentHome

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

# Declares `source` as Pi's gentle-pi package in place of any other gentle-pi
# declaration, keeping the rest of settings.json and its two-space format.
function Set-GentlePiDeclaration([string]$Source) {
  $script = @'
const fs = require("node:fs");
const path = require("node:path");
const [settingsPath, source] = process.argv.slice(1);
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
const isGentlePi = (entry) => {
  const value = typeof entry === "string" ? entry : entry && entry.source;
  if (typeof value !== "string") return false;
  if (value === source || /^npm:gentle-pi(@|$)/.test(value) || /gentle-shell(@|$)/.test(value)) return true;
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
    Set-GentlePiDeclaration 'npm:gentle-pi'
    Invoke-Checked 'pi update npm:gentle-pi' { pi update npm:gentle-pi } | Out-Null
    Write-Log 'Pi declares npm:gentle-pi again'
    exit 0
  }

  if ((Invoke-Git rev-parse --abbrev-ref HEAD) -ne $Branch) { throw "$Repo is not on $Branch" }
  if (Invoke-Git status --porcelain) { throw "$Repo has uncommitted changes" }
  $origin = (Invoke-Git remote get-url origin) -replace '^https://', '' -replace '\.git$', ''
  $source = "git:$origin"

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

  Invoke-Git push --quiet origin $Branch | Out-Null
  $version = "$((Get-Content (Join-Path $Repo 'package.json') -Raw | ConvertFrom-Json).version)-t3.$((Invoke-Git rev-parse --short=7 HEAD))"
  Set-GentlePiDeclaration $source
  Invoke-Checked "pi update $source" { pi update $source } | Out-Null
  Write-Log "Pi is on $source at $version"
} catch {
  Write-Log "FAILED: $_"
  exit 1
}
