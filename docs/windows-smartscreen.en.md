# Windows installer blocked by SmartScreen or Defender

> **Other languages:** [简体中文](./windows-smartscreen.zh.md)

## Why this happens

Current AUTO Gateway Desktop Windows installers are signed with Azure Artifact
Signing (Authenticode). Tauri's update signature is also present, but it is a
separate mechanism used by the in-app updater. Older releases may have been
published before Authenticode signing was enabled. Even signed first releases
can still show a SmartScreen warning while the publisher and file reputation
builds.

When you download or run an installer, you may see one of the following:

- The browser (Edge / Chrome) warns "This file is not commonly downloaded and may
  harm your device".
- SmartScreen pops up "Windows protected your PC / Unknown publisher" when you
  double-click the file.
- Windows Defender deletes or quarantines the file right after it downloads.

**This does not automatically mean the installer is malicious.** Windows may
apply additional protection to executables that come from a download source,
especially while publisher reputation is still being established.

## How to proceed (pick your case)

### Case 1 — The browser blocks the download

- **Edge:** click `···` on the download bar → **Keep** → **Keep anyway**.
- **Chrome:** click `···` on the download bar → **Keep dangerous file**.
- If the file was already deleted: open the **Downloads** page, find the entry,
  and click **Recover malicious file** to restore it.

### Case 2 — SmartScreen says "Windows protected your PC"

1. In the blue window, click **"More info"**.
2. A **"Run anyway"** button appears — click it to continue installing.
3. Installation then proceeds normally with no feature loss.

> The SmartScreen window **does not show "Run anyway" by default** — you must
> click "More info" first. This is an intentional Windows safety design.

### Case 3 — Windows Defender deleted the `.exe` or reported a virus

1. Open **Windows Security** → **Virus & threat protection** →
   **Protection history**.
2. Find the quarantined `AUTO Gateway Desktop ... setup.exe`.
3. Click it → under **Actions** choose **"Allow"** (or restore on this device).
4. Re-download the installer from the download page.

If you cannot find it in **Protection history**:

- Do not permanently disable **Real-time protection** to install a download.
- Confirm that the installer came from the official release URL and inspect its
  Authenticode status with `Get-AuthenticodeSignature`.
- If the signature is invalid or the source is uncertain, stop and contact the
  release owner.

### Case 4 — A company-managed PC blocks it via group policy

Enterprise IT policy may disable the "Run anyway" button entirely. In that case:

- Ask IT to add `cdn.autogateway.cc` and the installer path to the allow list;
- Or install on a personal PC that is not subject to group policy.

## Why can a signed installer still show a warning?

Azure Artifact Signing uses a publicly trusted certificate, but SmartScreen
reputation still builds over time. New files and a new publisher may trigger a
warning for the first few releases; the warning should reduce as legitimate
download history accumulates. Do not disable Defender permanently. If a
specific signed file is detected as malware, report the file and its hash to
the release owner instead of broadly bypassing security controls.

## Verify the file integrity (optional)

If you want to confirm the downloaded installer was not tampered with, compare
the checksum published on the release page:

```powershell
# PowerShell: compute SHA256 after download
Get-FileHash .\AUTO\ Gateway\ Desktop_0.1.39_setup.exe -Algorithm SHA256
Get-AuthenticodeSignature .\AUTO\ Gateway\ Desktop_0.1.39_setup.exe |
  Format-List Status,SignerCertificate
```

Compare the hash with the matching line in `checksums.txt` on the release page.
The Authenticode status should be `Valid` and the signer should match the
published organization. A matching hash means the file is unchanged.
