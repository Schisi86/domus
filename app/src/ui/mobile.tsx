// Phone layout helpers: the back button in the content header, and the
// Android back key (history entries for content, sheets and dialogs).

import { effect } from "@preact/signals";
import { closeDialog, closeModal, contextMenu, dialog, lightbox, membersSheet, mobileNav, modal, narrow } from "../state/app";
import { t } from "../i18n";
import { IconButton, Icon } from "./components";

/**
 * iOS: the web view does not shrink when the keyboard opens – the visual
 * viewport does. The app follows its height so the composer stays visible,
 * and the page never scrolls away underneath the fixed layout.
 */
export function initIOSViewport() {
  const vv = window.visualViewport;
  document.documentElement.classList.add("ios");
  if (!vv) return;
  const root = document.documentElement;
  const apply = () => {
    // Only while the keyboard covers part of the screen: then the app shrinks
    // to the visible part. Otherwise it fills the whole web view.
    const keyboard = window.innerHeight - vv.height > 120;
    if (keyboard) root.style.setProperty("--app-h", `${Math.round(vv.height)}px`);
    else root.style.removeProperty("--app-h");
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  apply();
}

/** "Back to the channel list" – only on narrow screens. */
export function NavBack() {
  if (!narrow.value) return null;
  return (
    <IconButton title={t("mobile.back")} class="nav-back" onClick={() => (mobileNav.value = true)}>
      <Icon.ChevronLeft class="icon flip" />
    </IconButton>
  );
}

/** Members button for the chat header on narrow screens. */
export function MembersButton() {
  if (!narrow.value) return null;
  return (
    <IconButton title={t("chat.showMembers")} active={membersSheet.value} onClick={() => (membersSheet.value = !membersSheet.value)}>
      <Icon.Users />
    </IconButton>
  );
}

/** How many layers are open above the channel list (each one is a history entry). */
function depth() {
  let d = 0;
  if (narrow.value && !mobileNav.value) d++;
  if (membersSheet.value) d++;
  if (modal.value) d++;
  if (dialog.value) d++;
  if (lightbox.value) d++;
  if (contextMenu.value) d++;
  return d;
}

/** Closes the topmost layer (Android back key / browser back). */
function closeTop() {
  if (contextMenu.value) return void (contextMenu.value = null);
  if (lightbox.value) return void (lightbox.value = null);
  if (dialog.value) return closeDialog();
  if (modal.value) return closeModal();
  if (membersSheet.value) return void (membersSheet.value = false);
  if (narrow.value && !mobileNav.value) mobileNav.value = true;
}

/**
 * The Android back key goes back in the web view's history. While anything is
 * open above the channel list, one extra history entry ("trap") exists: going
 * back consumes it and closes the topmost layer instead of leaving the app.
 * Changes are serialised – a programmatic `history.back()` must arrive before
 * the next entry is pushed, otherwise the two traversals overtake each other.
 */
export function initBackKey() {
  let trap = false;
  let waiting = false;
  const sync = () => {
    if (waiting) return;
    const want = depth() > 0;
    if (want && !trap) {
      history.pushState({ domus: 1 }, "");
      trap = true;
    } else if (!want && trap) {
      // Closed from the UI: remove the trap again (its popstate is ours).
      waiting = true;
      history.back();
    }
  };
  window.addEventListener("popstate", () => {
    trap = false;
    if (waiting) waiting = false;
    else closeTop();
    sync();
  });
  effect(() => {
    void depth();
    sync();
  });
  // Leaving the phone layout (rotating a tablet) shows both columns again.
  effect(() => {
    if (!narrow.value) membersSheet.value = false;
  });
}
