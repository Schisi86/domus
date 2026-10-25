// About NexusTalk: author, homepage, license and donation.

import { useEffect, useState } from "preact/hooks";
import { closeModal, toast } from "../../state/app";
import { t } from "../../i18n";
import { appInfo } from "../../platform";
import { AUTHOR, COPYRIGHT, DONATE_EMAIL, DONATE_URL, HOMEPAGE, PRODUCT_SITE } from "../../brand";
import { LogoMark, Modal, copyText, Icon } from "../components";
import { openExternal } from "../links";

export function DonateCard() {
  return (
    <div class="donate-card">
      <span class="heart" aria-hidden="true">💚</span>
      <div class="grow">
        <div style={{ fontWeight: 650 }}>{t("about.donateTitle")}</div>
        <div class="faint small">{t("about.donateText")}</div>
        <div class="row small" style={{ marginTop: "6px" }}>
          <span class="mono selectable">{DONATE_EMAIL}</span>
          <button
            class="icon-btn sm"
            title={t("common.copy")}
            onClick={() => {
              copyText(DONATE_EMAIL);
              toast(t("common.copied"), DONATE_EMAIL, "ok", 2000);
            }}
          >
            <Icon.Copy />
          </button>
        </div>
      </div>
      <button class="btn donate lg" onClick={() => void openExternal(DONATE_URL, true)}>
        <Icon.Heart /> {t("about.donate")}
      </button>
    </div>
  );
}

export function AboutDialog() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void appInfo().then((i) => setVersion(i?.version ?? null));
  }, []);
  return (
    <Modal footer={<button class="btn" onClick={closeModal}>{t("common.close")}</button>}>
      <div class="about-hero">
        <LogoMark />
        <div>
          <h2 style={{ margin: 0, fontSize: "var(--fs-2xl)" }}>NexusTalk</h2>
          <div class="muted">{t("about.tagline")}</div>
          <div class="faint small">{t("about.version", { version: version ?? "0.7.0" })}</div>
        </div>
      </div>
      <dl class="kv card">
        <dt>{t("about.author")}</dt>
        <dd>{AUTHOR}</dd>
        <dt>{t("about.homepage")}</dt>
        <dd><a href={HOMEPAGE} onClick={(e) => { e.preventDefault(); void openExternal(HOMEPAGE, true); }}>{HOMEPAGE.replace("https://", "")}</a></dd>
        <dt>{t("about.website")}</dt>
        <dd><a href={PRODUCT_SITE} onClick={(e) => { e.preventDefault(); void openExternal(PRODUCT_SITE, true); }}>{PRODUCT_SITE.replace("https://", "")}</a></dd>
        <dt>{t("about.license")}</dt>
        <dd>MIT</dd>
      </dl>
      <DonateCard />
      <div class="credit">{COPYRIGHT} · {t("about.rights")}</div>
    </Modal>
  );
}
