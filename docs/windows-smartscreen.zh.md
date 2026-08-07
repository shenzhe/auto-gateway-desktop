# Windows 安装时被 SmartScreen / Defender 拦截怎么办？

> **其他语言：** [English](./windows-smartscreen.en.md)

## 为什么会被拦截

当前版本的 AUTO Gateway Desktop Windows 安装包已经使用 Azure Artifact Signing
完成 Authenticode 代码签名。Tauri 更新签名仍然保留，但它是应用内更新完整性
校验的另一层机制。较早发布的版本可能还没有启用 Authenticode 签名。即使已经
签名，首次发布的文件在建立发布者和文件信誉之前，仍可能触发 SmartScreen。

当你下载或双击运行安装包时，可能会遇到：

- 浏览器（Edge / Chrome）下载提示「通常不下载此文件，可能危害你的设备」
- 双击运行时弹出 SmartScreen「Windows 已保护你的电脑 / 未知发布者」
- Windows Defender 在下载完成时把文件直接删掉或隔离

**这不是因为安装包真的有毒**，而是 Windows 对所有「未签名 + 下载来源」
的可执行文件都会施加的默认保护。

## 解决办法（按场景选）

### 场景 1：浏览器下载时被拦下 / 没下下来

- Edge：点击下载条右侧的 `···` → 选「保留」→「仍然保留」。
- Chrome：点击下载条右侧的 `···` → 选「保留危险文件」。
- 如果文件已经被删：在「下载」页面找到该条目，点「恢复危险文件」即可找回。

### 场景 2：双击运行时弹 SmartScreen「Windows 已保护你的电脑」

1. 在弹出的蓝色窗口里点 **「更多信息」**。
2. 这时会出现 **「仍要运行」** 按钮，点它即可继续安装。
3. 安装过程和正常安装完全一样，不会有任何功能损失。

> 提示：SmartScreen 的蓝色窗口**没有明显的「仍要运行」按钮**，
> 必须先点「更多信息」才会显示出来。这是 Windows 故意的安全设计。

### 场景 3：Windows Defender 直接把 `.exe` 删了 / 提示含病毒

1. 打开「Windows 安全中心」→「病毒和威胁防护」→「保护历史记录」。
2. 找到被隔离的 `AUTO Gateway Desktop ... setup.exe`。
3. 点击它 → 选 **「操作」→「允许」**（或在设备上还原）。
4. 重新到下载页下载安装包即可。

如果「保护历史记录」里找不到：

- 不要为了安装下载文件而长期关闭「实时保护」。
- 确认安装包来自官方发布地址，并使用 `Get-AuthenticodeSignature` 检查
  Authenticode 状态。
- 如果签名无效或来源不确定，请停止安装并联系发布方。

### 场景 4：企业电脑被组策略拦截

企业 IT 策略可能直接禁用「仍要运行」按钮。这种情况请：

- 联系公司 IT，把 `cdn.autogateway.cc` 和安装包路径加入允许名单；
- 或换一台不受组策略管控的个人电脑安装。

## 为什么已经签名仍可能出现提示

Azure Artifact Signing 使用公开信任的代码签名证书，但 SmartScreen 仍会根据
真实下载和使用历史逐步建立信誉。前几次发布出现蓝色提示并不代表签名失效；
请优先确认发布页校验和，并避免长期关闭 Defender。如果某个已签名文件被识别
为恶意文件，应把文件和校验和交给发布方复核，不要大范围绕过系统安全策略。

## 验证文件完整性（可选）

如果你担心下载到的安装包被篡改，可以对比发布页提供的校验和：

```powershell
# PowerShell：下载后比对 SHA256
Get-FileHash .\AUTO\ Gateway\ Desktop_0.1.39_setup.exe -Algorithm SHA256
Get-AuthenticodeSignature .\AUTO\ Gateway\ Desktop_0.1.39_setup.exe |
  Format-List Status,SignerCertificate
```

把哈希和发布页 / `checksums.txt` 里的对应行比对，并确认 Authenticode
状态为 `Valid` 且签名者与发布组织一致。哈希一致表示文件未被改动。
