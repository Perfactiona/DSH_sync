<#
.SYNOPSIS
  Publish this plugin to GitHub without git (REST API only).

.DESCRIPTION
  Creates the repository when it does not exist, then writes every package file
  in one commit through the Git Data API. Works with Windows PowerShell 5.1.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\publish-github.ps1 -Token ghp_xxx -Repo yourname/dsh-cloud-sync

.EXAMPLE
  # 公开仓库（默认创建私有仓库）
  powershell -ExecutionPolicy Bypass -File .\publish-github.ps1 -Token ghp_xxx -Repo yourname/dsh-cloud-sync -Public
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Token,
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$Branch = 'main',
    [switch]$Public,
    [string]$Message = 'dsh-cloud-sync: publish'
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$api = 'https://api.github.com'
$headers = @{
    Authorization          = "Bearer $Token"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'dsh-cloud-sync-publish'
}

function Invoke-Api {
    param([string]$Method, [string]$Path, $Body)
    $params = @{ Method = $Method; Uri = "$api$Path"; Headers = $headers; ErrorAction = 'Stop' }
    if ($null -ne $Body) {
        $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
        $params.ContentType = 'application/json; charset=utf-8'
    }
    return Invoke-RestMethod @params
}

function Get-Status {
    param($ErrorRecord)
    if ($ErrorRecord.Exception.Response -and $ErrorRecord.Exception.Response.StatusCode) {
        return [int]$ErrorRecord.Exception.Response.StatusCode
    }
    return 0
}

if ($Repo -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') {
    throw "Repo 必须是 owner/name，例如 yourname/dsh-cloud-sync"
}
$owner, $name = $Repo.Split('/', 2)

Write-Host "[1/5] 校验 Token..." -ForegroundColor Cyan
$user = Invoke-Api -Method GET -Path '/user'
Write-Host "      登录身份：$($user.login)"

Write-Host "[2/5] 确认仓库 $Repo ..." -ForegroundColor Cyan
$exists = $true
try {
    $null = Invoke-Api -Method GET -Path "/repos/$Repo"
} catch {
    if ((Get-Status $_) -eq 404) { $exists = $false } else { throw }
}
if (-not $exists) {
    if ($owner -ne $user.login) {
        Write-Warning "仓库将由 $owner 创建；当前 Token 身份是 $($user.login)。组织仓库请先在网页上创建。"
    }
    $null = Invoke-Api -Method POST -Path '/user/repos' -Body ([ordered]@{
        name        = $name
        private     = (-not $Public)
        description = 'Sync DeepSeek Harness plugins and settings between machines through a GitHub repository'
        auto_init   = $false
    })
    Write-Host "      已创建仓库（$(if ($Public) { '公开' } else { '私有' })）"
} else {
    Write-Host '      仓库已存在'
}

Write-Host "[3/5] 上传文件..." -ForegroundColor Cyan
$root = $PSScriptRoot
$exclude = @('.git', 'node_modules', 'dsh-sync', 'scratch')
$files = Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object {
    $relative = $_.FullName.Substring($root.Length).TrimStart('\', '/')
    $segments = $relative -split '[\\/]'
    $skip = $false
    foreach ($segment in $segments) { if ($exclude -contains $segment) { $skip = $true; break } }
    (-not $skip) -and ($_.Name -notin @('.DS_Store'))
}

$parentSha = $null
try {
    $ref = Invoke-Api -Method GET -Path "/repos/$Repo/git/ref/heads/$Branch"
    $parentSha = $ref.object.sha
    Write-Host "      基于现有分支 $Branch（$($parentSha.Substring(0,7))）"
} catch {
    if ((Get-Status $_) -ne 404) { throw }
    Write-Host "      将在空仓库创建 $Branch"
}

$treeItems = @()
foreach ($file in $files) {
    $relative = $file.FullName.Substring($root.Length).TrimStart('\', '/') -replace '\\', '/'
    $encoded = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName))
    $blob = Invoke-Api -Method POST -Path "/repos/$Repo/git/blobs" -Body ([ordered]@{ content = $encoded; encoding = 'base64' })
    $treeItems += [ordered]@{ path = $relative; mode = '100644'; type = 'blob'; sha = $blob.sha }
    Write-Host "      + $relative"
}

Write-Host "[4/5] 创建提交..." -ForegroundColor Cyan
$tree = Invoke-Api -Method POST -Path "/repos/$Repo/git/trees" -Body ([ordered]@{ tree = $treeItems })
$commitBody = [ordered]@{ message = $Message; tree = $tree.sha }
if ($parentSha) { $commitBody.parents = @($parentSha) }
$commit = Invoke-Api -Method POST -Path "/repos/$Repo/git/commits" -Body $commitBody

if ($parentSha) {
    $null = Invoke-Api -Method PATCH -Path "/repos/$Repo/git/refs/heads/$Branch" -Body ([ordered]@{ sha = $commit.sha; force = $true })
} else {
    $null = Invoke-Api -Method POST -Path "/repos/$Repo/git/refs" -Body ([ordered]@{ ref = "refs/heads/$Branch"; sha = $commit.sha })
}

Write-Host "[5/5] 完成" -ForegroundColor Green
Write-Host "      仓库：https://github.com/$Repo"
Write-Host "      提交：$($commit.sha.Substring(0,7))"
Write-Host ''
Write-Host '在另一台电脑的 DeepSeek Harness 终端里安装：' -ForegroundColor Cyan
Write-Host "  dsh plugin add https://github.com/$Repo/archive/refs/heads/$Branch.tar.gz"

