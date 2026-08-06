export type Locale = "en" | "zh";
export type LocalePreference = "system" | Locale;

const localeStorageKey = "autogateway.desktop.locale";

const dictionaries = {
  en: {
    checking: "Checking the local Codex configuration…",
    connected: "AUTO Gateway is connected to Codex.",
    notConfigured: "AUTO Gateway Codex has not been configured yet.",
    readStatusFailed: "Unable to read the local Codex status: {error}",
    callbackInvalid:
      "The desktop sign-in callback could not be verified. Start sign-in again.",
    signedIn: "Signed in securely. Continue with the Codex installation.",
    workspaceRestored: "Your AUTO Gateway workspace is ready.",
    workspaceReady: "Your AUTO Gateway workspace is ready.",
    signedInExistingKey:
      "Signed in. This installation already has a default API key; use the user console to rotate it before configuring Codex.",
    restoringSession: "Restoring your account…",
    sessionRestored: "Your AUTO Gateway account has been restored securely.",
    sessionRestoreFailed:
      "Unable to restore the saved desktop session: {error}",
    signInFailed: "Desktop sign-in could not be completed: {error}",
    continueInApp: "Sign in or register",
    openingSignIn: "Opening secure sign-in…",
    completeInApp:
      "Sign in or register in the secure window opened inside AUTO Gateway Desktop. It will close automatically after success.",
    signInFallback:
      "If the in-app sign-in window is blank, use the system browser instead.",
    signInFallbackOpened: "Opened the sign-in page in your system browser.",
    startSignInFailed: "Unable to start desktop sign-in: {error}",
    configurationWritten:
      "Configuration written.{backup} Fully quit and reopen ChatGPT/Codex.",
    backupCreated: " A configuration backup was created.",
    configurationFailed: "Configuration failed: {error}",
    preparingConfiguration: "Preparing automatic configuration",
    preparingConfigurationDescription:
      "AUTO Gateway is preparing the secure setup workflow.",
    creatingAPIKey: "Creating your API key…",
    creatingAPIKeyDescription:
      "A dedicated API key is being created for this computer.",
    apiKeyCreationFailed: "AUTO Gateway did not return a usable API key.",
    generatedAPIKey: "API key for this computer",
    copyAPIKey: "Copy",
    copiedAPIKey: "Copied",
    automaticConfiguring: "Configuring Codex…",
    automaticConfiguringDescription:
      "The API key is ready. AUTO Gateway is now writing and validating the Codex configuration.",
    automaticConfigurationComplete: "Codex configuration is complete",
    automaticConfigurationCompleteDescription:
      "The API key has been applied successfully. You can copy it before continuing.",
    automaticConfigurationFailed: "Automatic configuration failed",
    automaticConfigurationFailedDescription:
      "The automatic workflow stopped safely: {error}",
    retryConfiguration: "Retry configuration",
    credentialCleanupFailed:
      "The configuration succeeded, but the temporary API key could not be removed from secure storage.",
    installing: "Downloading and installing the official ChatGPT desktop app…",
    updating: "Downloading and installing the latest official Codex update…",
    preparingDownload: "Preparing the official Codex download…",
    selectingDownloadSource:
      "Testing download sources to find the fastest connection…",
    downloadingCodex: "Downloading the official Codex installer…",
    downloadingCodexProgress:
      "Downloading the official Codex installer… {percent}%",
    downloadBytesDetails: "{downloaded} of {total}",
    downloadBytesUnknownTotal: "{downloaded} downloaded",
    downloadSpeedDetails: "Speed: {speed}",
    calculatingDownloadSpeed: "Calculating speed…",
    downloadSourceDetails: "Source: {source} · calculating speed…",
    downloadStatusDetails: "Source: {source} · about {remaining} remaining",
    replacingCodex: "Codex will quit while the verified update is installed…",
    windowsInstalling:
      "Windows is registering ChatGPT. This can take several minutes; keep this page open.",
    windowsInstallationTimedOutTitle: "Windows registration is taking too long",
    windowsInstallationTimedOut:
      "Windows did not finish registering ChatGPT within 5 minutes. Download the installer again and retry.",
    retryCodexInstallation: "Download and install again",
    verifyingCodex: "Verifying the installed Codex version…",
    downloadPercent: "{percent}% downloaded",
    installedReady:
      "ChatGPT and Codex are installed and ready for the next step.",
    updatedReady: "ChatGPT and Codex were updated successfully.",
    installationFailed: "Codex installation failed: {error}",
    storeInstallationInProgress:
      "Finish the ChatGPT installation in Microsoft Store. This page is checking automatically.",
    reinstallingCodex:
      "A completed installer was found. Retrying the Codex installation…",
    checkInstallation: "Check installation",
    restoreConfirm:
      "Restore the latest Codex configuration backups? This replaces the current local configuration files.",
    restored:
      "Restored the latest backup. Fully quit and reopen ChatGPT/Codex.",
    restoreFailed: "Configuration restore failed: {error}",
    switchBackConfiguration: "Switch back to the previous configuration",
    switchBackConfigurationDescription:
      "Restore the Codex settings and credentials saved before AUTO Gateway was applied.",
    switchBackConfirm:
      "Switch Codex back to the previous configuration? This replaces the current local configuration files.",
    switchedBack:
      "Codex was switched back to the previous configuration. Fully quit and reopen ChatGPT/Codex.",
    signInRequired:
      "Sign in with AUTO Gateway before opening the user console.",
    sessionExpired:
      "Your sign-in has expired. Connect your account again to continue.",
    signOut: "Sign out",
    signOutConfirm:
      "Sign out of AUTO Gateway on this device? Your Codex configuration will not be changed.",
    signedOut: "You have been signed out. Connect an account to continue.",
    signOutFailed: "Unable to sign out: {error}",
    consoleFailed: "Unable to open the console: {error}",
    openDevtools: "Open DevTools",
    devtoolsFailed: "Unable to open DevTools: {error}",
    openCodexFailed: "Unable to open Codex: {error}",
    openingCodex: "Opening Codex…",
    codexOpened: "Codex is open",
    codexOpenTimeout: "Codex did not finish opening. Try again.",
    stepConnect: "Connect account",
    stepInstall: "Install Codex",
    stepConfigure: "Configure AUTO Gateway",
    stepFinish: "Finish",
    setupSteps: "Setup steps",
    secureSignIn: "Secure in-app sign-in",
    connectTitle: "Connect your AUTO Gateway account",
    connectLead:
      "Sign in or create your AUTO Gateway account inside the app. Your password never enters this app.",
    continueToCodex: "Continue to Codex",
    accountConnected: "Account connected",
    noAccount: "No account connected yet",
    signedInAs: "Signed in as",
    officialDesktopApp: "Official desktop app",
    installTitle: "Install Codex",
    installLead:
      "AUTO Gateway installs the official ChatGPT desktop app, which includes Codex.",
    installed: "ChatGPT and Codex are installed",
    upToDate: "Codex is up to date",
    updateAvailable: "A Codex update is available",
    updateAvailableDescription:
      "A newer official release is available. Update now to get the latest fixes and features.",
    installedDescription:
      "The official ChatGPT desktop application is installed. It includes Codex.",
    updateCheckUnavailable:
      "The local installation was found, but the latest version could not be checked right now.",
    localVersion: "Installed version",
    latestVersion: "Latest version",
    versionUnavailable: "Unavailable",
    notInstalled: "Codex is not installed yet",
    notInstalledDescription:
      "Install the official ChatGPT desktop application to continue.",
    checkingInstallation: "Checking installation status…",
    previous: "Previous",
    next: "Next",
    installAutomatically: "Install Codex automatically",
    installingCodex: "Installing Codex…",
    updateNow: "Update Codex",
    updatingCodex: "Updating Codex…",
    installNow: "Install now",
    checkNow: "Check now",
    checkingCodexUpdates: "Checking for Codex updates…",
    codexUpdateFound: "Codex {version} is ready to update.",
    codexUpToDate: "Codex is already up to date.",
    safeConfiguration: "Safe configuration",
    configureTitle: "Configure AUTO Gateway",
    configureLead:
      "Your default API key will be applied to Codex automatically. We create a local backup before making changes.",
    readyToConfigure: "Ready to configure",
    keyReady: "Your default API key is ready for this computer.",
    keyMissing:
      "A default API key is needed before this computer can be configured.",
    configureCodex: "Configure Codex",
    configuring: "Configuring…",
    setupComplete: "Setup complete",
    completeTitle: "Codex is ready for AUTO Gateway",
    completeLead:
      "Your provider configuration is saved. Fully quit and reopen ChatGPT/Codex before starting your next session.",
    configured: "AUTO Gateway is configured",
    readyToVerify: "Configuration is ready to verify",
    openCodex: "Open Codex",
    openConsole: "Open user console",
    enterWorkspace: "Enter workspace",
    workspace: "Workspace",
    homeNavigation: "Workspace navigation",
    home: "Home",
    codexSetup: "Codex setup",
    userConsole: "User console",
    homeTitle: "AUTO Gateway is ready",
    homeLead: "Everything is connected and ready for your next Codex session.",
    trayTitle: "AUTO Gateway",
    traySignedInAs: "Signed in as",
    trayBalance: "Balance",
    trayLoading: "Loading account…",
    trayUnavailable: "Unavailable",
    trayOpenWorkspace: "Open workspace",
    trayQuit: "Quit AUTO Gateway",
    workspaceReadyTitle: "All systems connected",
    workspaceReadyDescription: "Your Codex workspace is ready to use.",
    workspaceCheckingTitle: "Checking your workspace",
    workspaceCheckingDescription:
      "We are verifying the local Codex connection.",
    officialProviderStatus: "Official provider",
    officialProviderTitle: "Using the official OpenAI provider",
    officialProviderDescription:
      "Use AUTO Gateway for a more affordable and convenient Codex experience.",
    thirdPartyProviderStatus: "Third-party provider",
    thirdPartyProviderTitle: "A third-party provider is active",
    thirdPartyProviderDescription:
      "We recommend AUTO Gateway for simpler provider setup and management.",
    invalidProviderStatus: "Invalid configuration",
    invalidProviderTitle: "Codex provider configuration is invalid",
    invalidProviderDescription:
      "The Codex configuration file is missing or cannot be parsed. Reconfigure Codex to continue.",
    desktopUpdateAvailable: "AUTO Gateway Desktop update available",
    desktopUpdateDescription:
      "Version {version} is ready. Download and restart to apply it.",
    desktopUpdateNow: "Install update",
    desktopUpdating: "Installing update… {percent}%",
    desktopUpdateFailed: "Desktop update failed: {error}",
    desktopUpdateRetrying:
      "The automatic update failed. Checking for the latest version and retrying…",
    desktopUpdateManualTitle: "Automatic update failed",
    desktopUpdateManualDescription:
      "The update could not be installed automatically. Open the installer and overwrite the current AUTO Gateway Desktop installation.",
    desktopUpdateManualConfirm:
      "The automatic update failed twice. Open the latest installer and overwrite the current AUTO Gateway Desktop installation?",
    desktopUpdateManualOpened:
      "The installer has been opened. Run it and choose overwrite or install to update AUTO Gateway Desktop.",
    desktopUpdateManualOpen: "Open installer",
    desktopUpdateManualUnavailable:
      "The installer URL is unavailable. Check for updates again and retry.",
    desktopUpdateManualOpenFailed: "Unable to open the installer: {error}",
    desktopUpdateCheckNow: "Check Desktop updates",
    desktopUpdateCheckDescription:
      "Check the signed AUTO Gateway Desktop release now.",
    desktopCheckingUpdates: "Checking for Desktop updates…",
    desktopUpdateFound: "AUTO Gateway Desktop {version} is ready to install.",
    desktopUpToDate: "AUTO Gateway Desktop is up to date.",
    desktopUpdateCheckUnavailable:
      "Desktop update check is unavailable right now.",
    desktopAppVersion: "Desktop app v{version}",
    active: "Active",
    accountBalance: "Account balance",
    balanceUnavailable: "Unavailable",
    notSynced: "Not synced",
    lastSyncedAt: "Last synced {time}",
    topUpBalance: "Top up balance",
    quickActions: "Quick actions",
    openConsoleDescription: "Access your AUTO Gateway user console.",
    checkUpdates: "Check for Codex updates",
    checkUpdatesDescription: "Refresh local and official Codex version status.",
    reconfigureCodex: "Reconfigure Codex",
    reconfigureCodexDescription: "Review the local Codex setup workflow.",
    recentSetup: "Recent setup",
    connectedAccount: "Connected account",
    codexConfigured: "Codex configured",
    versionUpToDate: "Version status",
    needHelp: "Need help?",
    settings: "Settings",
    appearance: "Appearance",
    theme: "Theme",
    system: "System",
    light: "Light",
    dark: "Dark",
    language: "Language",
    automatic: "Automatic",
    english: "English",
    chinese: "Chinese",
    connectionRecovery: "Connection & recovery",
    connectionRecoveryLead:
      "These controls are for repair and advanced setup. Your browser sign-in remains the recommended path.",
    endpoint: "Gateway endpoint",
    backups: "Configuration backups",
    backupsAvailable: "{count} local backup{suffix} available",
    restoreLatest: "Restore latest backup",
    backToSetup: "Back to setup",
    working: "Working…",
  },
  zh: {
    checking: "正在检查本机 Codex 配置…",
    connected: "AUTO Gateway 已连接到 Codex。",
    notConfigured: "尚未为 Codex 配置 AUTO Gateway。",
    readStatusFailed: "无法读取本机 Codex 状态：{error}",
    callbackInvalid: "无法验证桌面端登录回调，请重新开始登录。",
    signedIn: "已安全登录，请继续安装 Codex。",
    workspaceRestored: "你的 AUTO Gateway 工作区已准备就绪。",
    workspaceReady: "你的 AUTO Gateway 工作区已准备就绪。",
    signedInExistingKey:
      "已登录。此设备已有默认 API Key；请先在用户控制台轮换 Key，再配置 Codex。",
    restoringSession: "正在恢复账户…",
    sessionRestored: "已安全恢复 AUTO Gateway 登录状态。",
    sessionRestoreFailed: "无法恢复已保存的桌面登录状态：{error}",
    signInFailed: "无法完成桌面端登录：{error}",
    continueInApp: "登录或注册",
    openingSignIn: "正在打开安全登录页…",
    completeInApp:
      "请在 AUTO Gateway Desktop 内打开的安全窗口中完成登录或注册，成功后窗口会自动关闭。",
    signInFallback: "如果应用内登录窗口空白，可改用系统浏览器登录。",
    signInFallbackOpened: "已在系统浏览器中打开登录页面。",
    startSignInFailed: "无法开始桌面端登录：{error}",
    configurationWritten:
      "配置已写入。{backup}请完全退出并重新打开 ChatGPT/Codex。",
    backupCreated: "已创建配置备份。",
    configurationFailed: "配置失败：{error}",
    preparingConfiguration: "正在准备自动配置",
    preparingConfigurationDescription: "AUTO Gateway 正在准备安全配置流程。",
    creatingAPIKey: "正在创建 API Key…",
    creatingAPIKeyDescription: "正在为此电脑创建专用 API Key。",
    apiKeyCreationFailed: "AUTO Gateway 未返回可用的 API Key。",
    generatedAPIKey: "此电脑的 API Key",
    copyAPIKey: "复制",
    copiedAPIKey: "已复制",
    automaticConfiguring: "正在配置 Codex…",
    automaticConfiguringDescription:
      "API Key 已准备好，正在写入并验证 Codex 配置。",
    automaticConfigurationComplete: "Codex 配置已完成",
    automaticConfigurationCompleteDescription:
      "API Key 已成功应用。进入下一步前仍可复制保存。",
    automaticConfigurationFailed: "自动配置失败",
    automaticConfigurationFailedDescription: "自动流程已安全停止：{error}",
    retryConfiguration: "重试配置",
    credentialCleanupFailed: "配置已成功，但无法从安全存储中移除临时 API Key。",
    installing: "正在下载并安装官方 ChatGPT 桌面应用…",
    updating: "正在下载并安装最新的官方 Codex 更新…",
    preparingDownload: "正在准备下载官方 Codex…",
    selectingDownloadSource: "正在测试下载源并选择最快连接…",
    downloadingCodex: "正在下载官方 Codex 安装包…",
    downloadingCodexProgress: "正在下载官方 Codex 安装包… {percent}%",
    downloadBytesDetails: "已下载 {downloaded} / 共 {total}",
    downloadBytesUnknownTotal: "已下载 {downloaded}",
    downloadSpeedDetails: "速度：{speed}",
    calculatingDownloadSpeed: "正在计算速度…",
    downloadSourceDetails: "来源：{source} · 正在计算速度…",
    downloadStatusDetails: "来源：{source} · 预计剩余 {remaining}",
    replacingCodex: "正在退出 Codex 并安装已验证的更新…",
    windowsInstalling:
      "Windows 正在注册 ChatGPT，可能需要几分钟；请保持此页面打开。",
    windowsInstallationTimedOutTitle: "Windows 注册超时",
    windowsInstallationTimedOut:
      "Windows 在 5 分钟内没有完成 ChatGPT 注册。请重新下载安装包并重试。",
    retryCodexInstallation: "重新下载并安装",
    verifyingCodex: "正在验证已安装的 Codex 版本…",
    downloadPercent: "已下载 {percent}%",
    installedReady: "ChatGPT 和 Codex 已安装，可以进入下一步。",
    updatedReady: "ChatGPT 和 Codex 已成功更新。",
    installationFailed: "Codex 安装失败：{error}",
    storeInstallationInProgress:
      "请在 Microsoft Store 完成 ChatGPT 安装；此页面会自动检查。",
    reinstallingCodex: "发现已下载完成的安装包，正在自动重试安装 Codex…",
    checkInstallation: "检查安装状态",
    restoreConfirm: "要恢复最新的 Codex 配置备份吗？这会替换当前本地配置文件。",
    restored: "已恢复最新备份。请完全退出并重新打开 ChatGPT/Codex。",
    restoreFailed: "配置恢复失败：{error}",
    switchBackConfiguration: "切换回原来的配置",
    switchBackConfigurationDescription:
      "恢复应用 AUTO Gateway 之前保存的 Codex 设置和凭据。",
    switchBackConfirm:
      "要将 Codex 切换回原来的配置吗？这会替换当前本地配置文件。",
    switchedBack:
      "Codex 已切换回原来的配置。请完全退出并重新打开 ChatGPT/Codex。",
    signInRequired: "请先登录 AUTO Gateway，再打开用户控制台。",
    sessionExpired: "登录状态已失效，请重新连接账户后继续。",
    signOut: "退出登录",
    signOutConfirm:
      "要退出此设备上的 AUTO Gateway 登录吗？Codex 配置不会被修改。",
    signedOut: "已退出登录，请重新连接账户。",
    signOutFailed: "退出登录失败：{error}",
    consoleFailed: "无法打开控制台：{error}",
    openDevtools: "打开 DevTools",
    devtoolsFailed: "无法打开 DevTools：{error}",
    openCodexFailed: "无法打开 Codex：{error}",
    openingCodex: "正在打开 Codex…",
    codexOpened: "Codex 已打开",
    codexOpenTimeout: "Codex 未能完成打开，请重试。",
    stepConnect: "连接账户",
    stepInstall: "安装 Codex",
    stepConfigure: "配置 AUTO Gateway",
    stepFinish: "完成",
    setupSteps: "设置步骤",
    secureSignIn: "应用内安全登录",
    connectTitle: "连接你的 AUTO Gateway 账户",
    connectLead:
      "请直接在应用内登录或注册 AUTO Gateway 账户，密码不会进入此应用。",
    continueToCodex: "继续安装 Codex",
    accountConnected: "账户已连接",
    noAccount: "尚未连接账户",
    signedInAs: "当前登录账户",
    officialDesktopApp: "官方桌面应用",
    installTitle: "安装 Codex",
    installLead: "AUTO Gateway 会安装官方 ChatGPT 桌面应用，其中包含 Codex。",
    installed: "已安装 ChatGPT 和 Codex",
    upToDate: "Codex 已是最新版本",
    updateAvailable: "Codex 有可用更新",
    updateAvailableDescription:
      "发现新的官方版本。立即更新即可获得最新修复和功能。",
    installedDescription: "已安装官方 ChatGPT 桌面应用，其中包含 Codex。",
    updateCheckUnavailable: "已发现本地安装，但当前无法检查最新版本。",
    localVersion: "本机版本",
    latestVersion: "最新版本",
    versionUnavailable: "暂不可用",
    notInstalled: "尚未安装 Codex",
    notInstalledDescription: "请安装官方 ChatGPT 桌面应用后继续。",
    checkingInstallation: "正在检查安装状态…",
    previous: "上一步",
    next: "下一步",
    installAutomatically: "自动安装 Codex",
    installingCodex: "正在安装 Codex…",
    updateNow: "更新 Codex",
    updatingCodex: "正在更新 Codex…",
    installNow: "立即安装",
    checkNow: "立即检查",
    checkingCodexUpdates: "正在检查 Codex 更新…",
    codexUpdateFound: "Codex {version} 已有可用更新。",
    codexUpToDate: "Codex 已经是最新版本。",
    safeConfiguration: "安全配置",
    configureTitle: "配置 AUTO Gateway",
    configureLead:
      "默认 API Key 会自动应用到 Codex。修改前我们会创建本地备份。",
    readyToConfigure: "可以开始配置",
    keyReady: "此设备的默认 API Key 已准备好。",
    keyMissing: "配置此设备前需要默认 API Key。",
    configureCodex: "配置 Codex",
    configuring: "正在配置…",
    setupComplete: "设置完成",
    completeTitle: "Codex 已准备好使用 AUTO Gateway",
    completeLead:
      "服务商配置已保存。开始下一次会话前，请完全退出并重新打开 ChatGPT/Codex。",
    configured: "AUTO Gateway 已配置",
    readyToVerify: "配置已准备好验证",
    openCodex: "打开 Codex",
    openConsole: "打开用户控制台",
    enterWorkspace: "进入工作区",
    workspace: "工作区",
    homeNavigation: "工作区导航",
    home: "主页",
    codexSetup: "Codex 设置",
    userConsole: "用户控制台",
    homeTitle: "AUTO Gateway 已准备就绪",
    homeLead: "所有服务均已连接，可开始下一次 Codex 会话。",
    trayTitle: "AUTO Gateway",
    traySignedInAs: "当前账号",
    trayBalance: "账户余额",
    trayLoading: "正在加载账户信息…",
    trayUnavailable: "暂不可用",
    trayOpenWorkspace: "打开工作台",
    trayQuit: "退出 AUTO Gateway",
    workspaceReadyTitle: "所有服务已连接",
    workspaceReadyDescription: "你的 Codex 工作区已准备好使用。",
    workspaceCheckingTitle: "正在检查工作区",
    workspaceCheckingDescription: "正在验证本机 Codex 连接状态。",
    officialProviderStatus: "官方 Provider",
    officialProviderTitle: "当前使用官方 OpenAI Provider",
    officialProviderDescription: "建议使用 AUTO Gateway，更省更方便。",
    thirdPartyProviderStatus: "第三方 Provider",
    thirdPartyProviderTitle: "检测到第三方 Provider",
    thirdPartyProviderDescription:
      "推荐使用 AUTO Gateway，配置更简单，使用更方便。",
    invalidProviderStatus: "配置文件无效",
    invalidProviderTitle: "无法读取 Codex Provider",
    invalidProviderDescription:
      "Codex 配置文件缺失或无法解析，请重新配置。",
    desktopUpdateAvailable: "AUTO Gateway Desktop 有可用更新",
    desktopUpdateDescription:
      "版本 {version} 已准备好。下载后重启即可完成更新。",
    desktopUpdateNow: "安装更新",
    desktopUpdating: "正在安装更新… {percent}%",
    desktopUpdateFailed: "桌面应用更新失败：{error}",
    desktopUpdateRetrying: "自动更新失败，正在重新获取最新版本并重试安装…",
    desktopUpdateManualTitle: "自动更新失败",
    desktopUpdateManualDescription:
      "自动更新安装失败，请打开安装包并覆盖安装当前 AUTO Gateway Desktop。",
    desktopUpdateManualConfirm:
      "自动更新连续失败两次。要打开最新安装包并覆盖安装当前 AUTO Gateway Desktop 吗？",
    desktopUpdateManualOpened:
      "安装包已打开，请运行安装程序并选择覆盖或安装，以更新 AUTO Gateway Desktop。",
    desktopUpdateManualOpen: "打开安装包",
    desktopUpdateManualUnavailable:
      "暂时无法获取安装包地址，请重新检查更新后重试。",
    desktopUpdateManualOpenFailed: "无法打开安装包：{error}",
    desktopUpdateCheckNow: "检查桌面应用更新",
    desktopUpdateCheckDescription:
      "立即检查已签名的 AUTO Gateway Desktop 新版本。",
    desktopCheckingUpdates: "正在检查桌面应用更新…",
    desktopUpdateFound: "AUTO Gateway Desktop {version} 已可安装。",
    desktopUpToDate: "AUTO Gateway Desktop 已是最新版本。",
    desktopUpdateCheckUnavailable: "暂时无法检查桌面应用更新。",
    desktopAppVersion: "桌面应用 v{version}",
    active: "运行正常",
    accountBalance: "账户余额",
    balanceUnavailable: "暂不可用",
    notSynced: "尚未同步",
    lastSyncedAt: "最后同步：{time}",
    topUpBalance: "充值余额",
    quickActions: "快捷操作",
    openConsoleDescription: "进入 AUTO Gateway 用户控制台。",
    checkUpdates: "检查 Codex 更新",
    checkUpdatesDescription: "刷新本机与官方 Codex 版本状态。",
    reconfigureCodex: "重新配置 Codex",
    reconfigureCodexDescription: "查看本机 Codex 设置流程。",
    recentSetup: "最近设置",
    connectedAccount: "已连接账户",
    codexConfigured: "Codex 已配置",
    versionUpToDate: "版本状态",
    needHelp: "需要帮助？",
    settings: "设置",
    appearance: "外观",
    theme: "主题",
    system: "跟随系统",
    light: "浅色",
    dark: "深色",
    language: "语言",
    automatic: "自动",
    english: "English",
    chinese: "简体中文",
    connectionRecovery: "连接与恢复",
    connectionRecoveryLead:
      "这些控制项用于修复和高级设置。推荐仍使用浏览器登录。",
    endpoint: "网关地址",
    backups: "配置备份",
    backupsAvailable: "可用本地备份：{count} 个",
    restoreLatest: "恢复最新备份",
    backToSetup: "返回设置向导",
    working: "正在处理…",
  },
} as const;

export type TranslationKey = keyof typeof dictionaries.en;

function detectSystemLocale(): Locale {
  const languages =
    typeof navigator === "undefined"
      ? []
      : [...navigator.languages, navigator.language].filter(Boolean);
  return languages.some((language) => language.toLowerCase().startsWith("zh"))
    ? "zh"
    : "en";
}

export function readLocalePreference(): LocalePreference {
  const value = window.localStorage.getItem(localeStorageKey);
  return value === "zh" || value === "en" ? value : "system";
}

export function resolveLocale(preference: LocalePreference): Locale {
  return preference === "system" ? detectSystemLocale() : preference;
}

export function writeLocalePreference(preference: LocalePreference) {
  window.localStorage.setItem(localeStorageKey, preference);
}

export function translate(
  locale: Locale,
  key: TranslationKey,
  values: Record<string, string | number> = {},
) {
  let text: string = dictionaries[locale][key] ?? dictionaries.en[key];
  for (const [name, value] of Object.entries(values))
    text = text.replace(`{${name}}`, String(value));
  return text;
}
