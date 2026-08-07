# 脚本使用说明

本文说明 `AUTO Gateway Desktop` 仓库中可直接执行的脚本、依赖与推荐用法。所有命令均应从仓库根目录执行。

> 不要将签名私钥、Apple 公证密钥、R2 凭据或 Azure 凭据提交到仓库，也不要粘贴到日志中。

## 快速选择

| 目标 | 推荐入口 |
| --- | --- |
| 编译并启动 macOS 开发版 | `./script/build_and_run.sh --verify` |
| 仅编译前端 | `npm run build` |
| 本地构建 macOS 发布产物 | `bash scripts/build-release.sh macos --clean` |
| 本地构建并公证 macOS 发布产物 | `bash scripts/build-release.sh macos --clean --notarize --notary-env <env-file>` |
| 发布正式的全平台版本 | GitHub Actions `Desktop Release` 工作流 |
| 发布前仅验证 Windows x64 | GitHub Actions 手动运行，选择 `windows-x64-test` |
| 将已完成的完整发布目录上传到 R2 | `bash scripts/publish-r2.sh` |

正式发布优先使用 GitHub Actions。它在原生 Windows 环境签名 Windows 包，并在 macOS 环境签名与公证 macOS 包。本机 macOS 上的 Windows 交叉构建适合验证打包，不应作为对外发布的签名来源。

## `script/build_and_run.sh`

用途：停止旧开发版、构建当前工作区、启动新的 `AUTO Gateway Desktop Dev.app`。这是 Codex Run 按钮使用的入口，配置位于 `.codex/environments/environment.toml`。

前提：macOS、Node.js、npm、Rust 工具链和项目依赖已安装。

```bash
# 默认构建并启动
./script/build_and_run.sh

# 构建、启动并确认进程存在
./script/build_and_run.sh --verify

# 构建后以 lldb 调试二进制文件
./script/build_and_run.sh --debug

# 构建、启动并持续输出应用日志；使用 Ctrl-C 停止日志流
./script/build_and_run.sh --logs

# 与 --logs 相同，作为 UI/运行时遥测检查入口
./script/build_and_run.sh --telemetry
```

开发包输出路径：

```text
src-tauri/target/debug/bundle/macos/AUTO Gateway Desktop Dev.app
```

该脚本只停止开发包，不会停止 `/Applications` 内的正式版。

## `scripts/build-release.sh`

用途：本地生成发布产物。开始前会检查 `package.json`、`src-tauri/Cargo.toml` 与 `src-tauri/tauri.conf.json` 的版本完全一致，并要求提供 Tauri 更新签名密钥。

```bash
scripts/build-release.sh [macos|windows|all] [options]
```

平台参数：

| 参数 | 行为 |
| --- | --- |
| `macos` | 构建 Apple Silicon、Intel 与 Universal macOS 包。仅可在 macOS 上执行。 |
| `windows` | 构建 x64、ARM64 及按架构选择的 Windows 安装包。Windows 主机使用原生 MSVC；macOS/Linux 使用 `cargo-xwin`。 |
| `all` | 依次构建上述两个平台；默认值。 |

常用选项：

| 选项 | 行为 |
| --- | --- |
| `--clean` | 仅允许清理仓库内的 `release/` 目录，然后重新生成产物。 |
| `--release-dir <path>` | 指定发布产物目录；默认 `release/`。 |
| `--skip-install` | 跳过 `npm ci`。适用于已确认依赖正确的重复构建。 |
| `--notarize` | 对 macOS 应用提交 Apple 公证并 stapler 固化结果。 |
| `--notary-env <path>` | 加载 Apple 公证环境变量文件。 |
| `--publish-r2` | 构建后上传 R2 并更新 `latest.json`。 |
| `--r2-env <path>` | 加载 R2 发布环境变量文件。 |
| `--tag` | 成功后创建注释 tag `v<version>`；要求工作区干净。 |
| `--push` | 推送当前分支及新 tag；只能与 `--tag` 一起使用。 |

示例：

```bash
# 仅重新构建 macOS 发布包，不发布
bash scripts/build-release.sh macos --clean

# 构建、公证并将完整 macOS 发布目录上传 R2
bash scripts/build-release.sh macos --clean --notarize \
  --notary-env /secure/path/notary.env \
  --publish-r2 --r2-env /secure/path/r2.env

# 构建完成后创建并推送 tag；只在工作区干净且版本已确认时使用
bash scripts/build-release.sh all --clean --tag --push
```

必需的更新签名变量：

```text
TAURI_SIGNING_PRIVATE_KEY_FILE 或 TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

使用 `--notarize` 时还需要：

```text
NOTARY_KEY_PATH 或 APPLE_NOTARY_KEY_BASE64
APPLE_NOTARY_KEY_ID
APPLE_NOTARY_ISSUER_ID
```

使用 `--publish-r2` 时还需要：

```text
R2_ENDPOINT
R2_BUCKET
R2_PUBLIC_BASE_URL
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
```

脚本也兼容 `AI_GATEWAY_SUPPORT_ATTACHMENT_*` 前缀的既有 R2 配置变量。

## `scripts/publish-r2.sh`

用途：上传一个已完整构建的 `release/` 目录到 R2，生成校验文件，并更新 `downloads/desktop/latest.json`。

该脚本不会构建或签名文件；只应在全部所需产物均已生成和验证后运行。它需要 `aws` CLI 与 `jq`。

```bash
set -a
source /secure/path/r2.env
set +a

VERSION=0.1.46 RELEASE_DIR="$PWD/release" \
  bash scripts/publish-r2.sh
```

需要的环境变量与上一节的 R2 变量相同。发布脚本会检查所有 macOS、Windows、更新签名和通用安装包是否存在且非空；缺少任何一项都会失败，不会写入新的 `latest.json`。

R2 对象键会将产物名中的空格转换为连字符，例如：

```text
AUTO-Gateway-Desktop_0.1.46_x64-setup.exe
```

生成的 `latest.json` 和校验清单使用同一无空格对象名。已经发布的历史对象不会被此脚本改名。

## `scripts/notarize-macos.sh`

用途：将一个已经签名的 macOS `.app` 提交 Apple 公证，等待结果、staple 公证票据，并验证签名与 Gatekeeper 评估。

通常由 `build-release.sh --notarize` 自动调用。仅在需要单独重试公证时手动使用：

```bash
APP_PATH="/absolute/path/AUTO Gateway Desktop.app" \
NOTARY_KEY_PATH="/secure/path/AuthKey_XXXXXXXXXX.p8" \
APPLE_NOTARY_KEY_ID="XXXXXXXXXX" \
APPLE_NOTARY_ISSUER_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" \
bash scripts/notarize-macos.sh
```

应用必须先由有效的 Developer ID 证书签名。该脚本不负责导入证书或签名应用。

## Windows Artifact Signing 脚本

这些脚本需要原生 Windows、Windows SDK 中的 `signtool.exe`、Artifact Signing Client Tools，以及已经登录的 Azure CLI。正式发布时 GitHub Actions 使用 `azure/artifact-signing-action`；以下脚本主要用于本地或 CI 辅助场景。

### `scripts/prepare-artifact-signing.ps1`

用途：下载 Artifact Signing Client，生成仅使用 Azure CLI 凭据的元数据文件，并把 dlib 和元数据路径写入 GitHub Actions 环境。

适用场景：GitHub Actions 的 Windows 作业。它依赖以下变量：

```text
AZURE_ARTIFACT_SIGNING_ENDPOINT
AZURE_ARTIFACT_SIGNING_ACCOUNT
AZURE_ARTIFACT_SIGNING_PROFILE
RUNNER_TEMP
GITHUB_ENV
```

在 Azure OIDC 登录完成后执行：

```powershell
pwsh -NoProfile -File scripts/prepare-artifact-signing.ps1
```

### `scripts/sign-windows-artifact.ps1`

用途：使用 Azure Artifact Signing 为一个 `.exe` 文件签名并立即验证签名。

```powershell
pwsh -NoProfile -File scripts/sign-windows-artifact.ps1 `
  -FilePath "C:\release\AUTO-Gateway-Desktop_0.1.46_x64-setup.exe"
```

可通过以下任一方式提供 Artifact Signing 配置：

```text
AZURE_ARTIFACT_SIGNING_METADATA_FILE
```

或：

```text
AZURE_ARTIFACT_SIGNING_ENDPOINT
AZURE_ARTIFACT_SIGNING_ACCOUNT
AZURE_ARTIFACT_SIGNING_PROFILE
```

可选变量包括 `WINDOWS_SIGNTOOL_PATH`、`AZURE_ARTIFACT_SIGNING_DLIB_PATH` 与 `AZURE_ARTIFACT_SIGNING_CLIENT_DIR`。

### `scripts/verify-windows-signatures.ps1`

用途：验证一个或多个 Windows 文件的 Authenticode 签名状态。

```powershell
pwsh -NoProfile -File scripts/verify-windows-signatures.ps1 `
  -Files "C:\release\AUTO-Gateway-Desktop_0.1.46_x64-setup.exe", "C:\release\AUTO-Gateway-Desktop_0.1.46_setup.exe"
```

签名状态不是 `Valid` 时脚本会失败。

## `scripts/windows-unified-installer.nsi`

用途：生成一个按 Windows CPU 架构选择 x64 或 ARM64 安装器的 NSIS 引导包。通常由 `build-release.sh` 或 GitHub Actions 自动调用，不能单独替代两个原生安装包。

所需宏参数：

```text
PAYLOAD_DIR  包含 AUTO-Gateway-Desktop-x64-setup.exe 与 AUTO-Gateway-Desktop-arm64-setup.exe
OUTFILE      输出安装包绝对路径
APP_VERSION  当前发布版本
```

手动调用示例：

```bash
makensis \
  -DPAYLOAD_DIR=/absolute/path/payload \
  -DOUTFILE=/absolute/path/AUTO-Gateway-Desktop_0.1.46_setup.exe \
  -DAPP_VERSION=0.1.46 \
  scripts/windows-unified-installer.nsi
```

NSIS 只负责封装与架构选择。最终 `.exe` 仍必须在原生 Windows 上完成 Artifact Signing。

## GitHub Actions 发布工作流

文件：`.github/workflows/desktop-release.yml`。

该工作流是正式发布的推荐路径：

1. 校验 tag/手动输入版本与三个项目版本一致。
2. 构建、签名和公证三个 macOS 包。
3. 在原生 Windows 上构建并签名 x64 与 ARM64 包。
4. 构建并签名通用 Windows 安装包。
5. 上传 R2 产物并更新 `latest.json`。

手动运行有两个范围：

| `release_scope` | 用途 |
| --- | --- |
| `full` | 默认值，构建所有平台并发布 R2。 |
| `windows-x64-test` | 只验证 Windows x64 应用与安装包签名；跳过 macOS、ARM64、通用安装包和 R2。 |

`windows-x64-test` 适合验证 Azure OIDC、Artifact Signing 或 NSIS 流程。成功后再通过新 tag 或 `full` 运行发布完整版本。

## 发布前检查

1. 确认工作区没有不应发布的未提交改动。
2. 确认三个版本文件一致。
3. 在 GitHub Actions 的 `release` 环境中确认 Apple、Tauri、Azure 与 R2 的机密变量齐全。
4. 优先先运行 `windows-x64-test` 验证 Windows 签名链路。
5. 完整工作流成功后，再确认 R2 的 `latest.json` 为目标版本。
