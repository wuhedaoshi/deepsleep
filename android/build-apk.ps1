# 构建 Deepsleep APK（Windows 本机版）：同步前端产物 → 递增版本号 → 打包签名 → 导出到 release/。
# 与 build-apk.sh 等价，只把那条脚本里写死的 /home/ubuntu 路径换成可覆盖的变量。
#
#   pwsh -File build-apk.ps1              # 出包
#   pwsh -File build-apk.ps1 -DryRun      # 只打印将要做什么，不改版本文件、不构建
#
# 工具链默认落在工作区根的 .toolchain/ 下，可用环境变量覆盖：
#   DEEPSLEEP_JDK / DEEPSLEEP_SDK / DEEPSLEEP_GRADLE / DEEPSLEEP_KEYSTORE
#
# 版本号：applicationId 只有一个（com.deepsleep.app），所以也只有一条版本号流。
# 实验版是同一个身份的另一个构建，直接覆盖安装即可，数据天然继承。
[CmdletBinding()]
param(
    # 只走流程不落地：不写版本文件、不同步 assets、不调 gradle、不导出
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$toolchain = Join-Path $workspace '.toolchain'
$dist = Join-Path $PSScriptRoot '..\frontend\dist'
$releaseDir = Join-Path $PSScriptRoot '..\release'

$jdk = if ($env:DEEPSLEEP_JDK) { $env:DEEPSLEEP_JDK } else { Join-Path $toolchain 'jdk-17' }
$sdk = if ($env:DEEPSLEEP_SDK) { $env:DEEPSLEEP_SDK } else { Join-Path $toolchain 'android-sdk' }
# 优先用仓库自带的 wrapper（版本与 CI 一致），没有再退回环境变量 / 工具链目录
$wrapperBat = Join-Path $PSScriptRoot 'gradlew.bat'
$gradle = if ($env:DEEPSLEEP_GRADLE) { $env:DEEPSLEEP_GRADLE } elseif (Test-Path $wrapperBat) { $wrapperBat } else { Join-Path $toolchain 'gradle-8.7\bin\gradle.bat' }
$keystore = if ($env:DEEPSLEEP_KEYSTORE) { $env:DEEPSLEEP_KEYSTORE } else { Join-Path $PSScriptRoot '..\keystore\deepsleep.keystore' }

$missing = @()
foreach ($path in @($jdk, $sdk, $gradle, $dist, $keystore)) {
    if (-not (Test-Path $path)) { $missing += $path }
}
if ($missing.Count -gt 0) {
    if ($DryRun) {
        Write-Host "[dry-run] 缺少依赖（真构建会失败）：$($missing -join '; ')"
    } else {
        throw "缺少依赖：$($missing -join '; ')"
    }
}

# 1) 版本号 +1：versionCode +1；versionName 补丁位 +1。
#    这里**不做「满 9 进一」**——那套规则会把 1.2.9 滚成 1.3.0，两条分支的版本名就撞了。
#    versionName 只给人看，补丁位涨到两位数（1.2.10）完全正常。
$props = 'version.properties'
$lines = Get-Content -LiteralPath $props
$codeLine = $lines | Where-Object { $_ -match '^versionCode=' } | Select-Object -First 1
$nameLine = $lines | Where-Object { $_ -match '^versionName=' } | Select-Object -First 1
if (-not $codeLine -or -not $nameLine) { throw "版本文件缺 versionCode/versionName：$props" }

$code = [int](($codeLine -replace '^versionCode=', '').Split('#')[0].Trim())
$name = ($nameLine -replace '^versionName=', '').Split('#')[0].Trim()
$parts = $name.Split('.')
if ($parts.Count -lt 3) { throw "versionName 需要三段式 x.y.z，实际：$name" }
$major = [int]$parts[0]
$minor = [int]$parts[1]
$patch = [int]$parts[2] + 1
$newName = "$major.$minor.$patch"
$newCode = $code + 1

if ($DryRun) {
    Write-Host "[dry-run] 版本：$name → $newName (versionCode $code → $newCode)，写入 $props"
} else {
    # 先存一份原文：构建或导出失败时把版本号退回去，否则调试一次就白烧一个版本号。
    $previousProps = Get-Content -LiteralPath $props -Raw
    $lines | ForEach-Object {
        $_ -replace '^versionCode=.*', "versionCode=$newCode" -replace '^versionName=.*', "versionName=$newName"
    } | Set-Content -Path $props -Encoding utf8
    Write-Host "版本：$name → $newName (versionCode $code → $newCode)"
}

# 2) 同步最新前端产物（assets/web 是构建期生成的，真源永远是 frontend/dist）
$assets = 'app\src\main\assets\web'
if ($DryRun) {
    Write-Host "[dry-run] 同步 $dist → $assets"
} else {
    if (Test-Path $assets) { Remove-Item -Recurse -Force $assets }
    New-Item -ItemType Directory -Force -Path $assets | Out-Null
    Copy-Item -Recurse -Force (Join-Path $dist '*') $assets
}

# 3) 构建（Gradle 与 AGP 都要 JDK 17；签名密钥路径从命令行传入，见 build.gradle.kts）
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$gradleArgs = @('--no-daemon', '--console=plain', "-Pdeepsleep.keystore=$keystore", ':app:assembleRelease')

if ($DryRun) {
    Write-Host "[dry-run] $gradle $($gradleArgs -join ' ')"
    Write-Host "[dry-run] 期望产物 app\build\outputs\apk\release\app-release.apk → $(Join-Path $releaseDir "Deepsleep-$newName.apk")"
    return
}

try {
    & $gradle @gradleArgs
    if ($LASTEXITCODE -ne 0) { throw "Gradle 构建失败：exit $LASTEXITCODE" }
} catch {
    if ($previousProps) {
        Set-Content -LiteralPath $props -Value $previousProps -NoNewline -Encoding utf8
        Write-Host "构建失败，版本号已回滚到 $name"
    }
    throw
}

# 4) 导出到 release/，并校验签名与包身份——这几项错了，装上去才发现就晚了
try {
    $builtApk = 'app\build\outputs\apk\release\app-release.apk'
    if (-not (Test-Path $builtApk)) { throw "找不到构建产物：$builtApk" }
    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    $out = Join-Path $releaseDir "Deepsleep-$newName.apk"
    Copy-Item $builtApk $out -Force
    & (Join-Path $sdk 'build-tools\34.0.0\apksigner.bat') verify $out
    if ($LASTEXITCODE -ne 0) { throw "签名校验失败：$out" }
} catch {
    if ($previousProps) {
        Set-Content -LiteralPath $props -Value $previousProps -NoNewline -Encoding utf8
        Write-Host "导出失败，版本号已回滚到 $name"
    }
    throw
}

$aapt2 = Join-Path $sdk 'build-tools\34.0.0\aapt2.exe'
if (Test-Path $aapt2) {
    & $aapt2 dump badging $out | Select-String -Pattern '^package:|^application-label:' | ForEach-Object { Write-Host $_ }
}

$size = [math]::Round((Get-Item $out).Length / 1MB, 2)
Write-Host "已生成 $out ($size MB)"

