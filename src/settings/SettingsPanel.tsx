// 设置面板：从 App 提取的自包含 UI。主题/语言偏好直接从 LocaleContext 消费
// （切换主题/语言时只重渲染本组件，不经过 App 的 props 链）；endpoint、备份等
// 业务状态仍由 App 通过 props 提供。
import { useLocale } from "../context/LocaleContext";
import type { LocalePreference } from "../shared/i18n";
import type { ThemeMode } from "../shared/theme";

type SettingsPanelProps = {
  endpoint: string;
  onEndpointChange: (value: string) => void;
  busy: boolean;
  backupCount: number;
  onRestoreBackups: () => void;
  onClose: () => void;
};

export function SettingsPanel({
  endpoint,
  onEndpointChange,
  busy,
  backupCount,
  onRestoreBackups,
  onClose,
}: SettingsPanelProps) {
  const { tr, theme, changeTheme, localePreference, changeLocale } =
    useLocale();

  return (
    <section className="settingsContent">
      <p className="sectionKicker">{tr("settings")}</p>
      <h1>{tr("connectionRecovery")}</h1>
      <p className="lead">{tr("connectionRecoveryLead")}</p>
      <div className="preferencesPanel">
        <strong>{tr("appearance")}</strong>
        <label className="fieldLabel">
          {tr("theme")}
          <select
            value={theme}
            onChange={(event) => changeTheme(event.target.value as ThemeMode)}
          >
            <option value="system">{tr("system")}</option>
            <option value="light">{tr("light")}</option>
            <option value="dark">{tr("dark")}</option>
          </select>
        </label>
        <label className="fieldLabel">
          {tr("language")}
          <select
            value={localePreference}
            onChange={(event) =>
              changeLocale(event.target.value as LocalePreference)
            }
          >
            <option value="system">{tr("automatic")}</option>
            <option value="zh">{tr("chinese")}</option>
            <option value="en">{tr("english")}</option>
          </select>
        </label>
      </div>
      <label className="fieldLabel">
        {tr("endpoint")}
        <input
          value={endpoint}
          onChange={(event) => onEndpointChange(event.target.value)}
          autoComplete="url"
        />
      </label>
      <div className="settingsDivider" />
      <div className="recoveryRow">
        <div>
          <strong>{tr("backups")}</strong>
          <span>
            {tr("backupsAvailable", {
              count: backupCount,
              suffix: backupCount === 1 ? "" : "s",
            })}
          </span>
        </div>
        <button
          className="secondaryButton"
          disabled={busy}
          onClick={onRestoreBackups}
        >
          {tr("restoreLatest")}
        </button>
      </div>
      <button className="secondaryButton backButton" onClick={onClose}>
        {tr("backToSetup")}
      </button>
    </section>
  );
}
