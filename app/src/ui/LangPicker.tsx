// Language switcher: current country flag; click opens all 15 languages.

import { useState } from "preact/hooks";
import { settings, updateSettings } from "../state/app";
import { lang, langInfo, LANGS, t } from "../i18n";
import { Popover } from "./components";
import { Flag } from "./flags";

export function LangPicker({ class: cls }: { class?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const cur = langInfo(lang.value);
  return (
    <>
      <button
        class={cls ?? "rail-btn flag"}
        title={`${t("lang.choose")} – ${cur.name}`}
        aria-label={t("lang.choose")}
        onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        <Flag code={cur.flag} class="" />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div class="flag-picker" role="listbox" aria-label={t("lang.choose")}>
            {LANGS.map((l) => (
              <button
                key={l.code}
                role="option"
                aria-selected={l.code === cur.code}
                class={l.code === cur.code ? "active" : ""}
                onClick={() => {
                  updateSettings({ language: l.code });
                  setAnchor(null);
                }}
              >
                <Flag code={l.flag} />
                <span dir={l.rtl ? "rtl" : "ltr"}>{l.name}</span>
              </button>
            ))}
            <button
              class={!settings.value.language ? "active" : ""}
              style={{ gridColumn: "1 / -1", justifyContent: "center" }}
              onClick={() => {
                updateSettings({ language: "" });
                setAnchor(null);
              }}
            >
              {t("lang.system")}
            </button>
          </div>
        </Popover>
      )}
    </>
  );
}
