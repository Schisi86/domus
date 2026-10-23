// Compact emoji picker with recently used emojis.

import { useState } from "preact/hooks";
import { settings, updateSettings } from "../state/app";
import { t, type Key } from "../i18n";
import { Popover } from "./components";

const CATS: { id: string; icon: string; list: string }[] = [
  { id: "smileys", icon: "😀", list: "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😎 🤓 🧐 🤔 🤨 😐 😑 😶 🙄 😏 😬 😌 😔 😪 😴 😷 🤒 🤯 🥳 🥺 😢 😭 😤 😡 🤬 😱 😨 😳 🤗 🤭 🫡 🤫 🫠 😵‍💫 🥲 😈 💀 👻 🤖 👽 💩" },
  { id: "people", icon: "👍", list: "👍 👎 👏 🙌 👐 🤝 🙏 ✌️ 🤞 🤟 🤘 👌 🤌 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤙 💪 🦾 ✍️ 👀 👁️ 🧠 👶 🧑 👩 👨 🧓 👮 🧑‍💻 🧑‍🎓 🧑‍🍳 🧑‍🚀 🦸 🧙 🧛 🕺 💃 🏃 🧘 🛌" },
  { id: "hearts", icon: "❤️", list: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 ✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ❗ ❓ ‼️ ⁉️ ⚠️ 🚫 ⛔ 💤 💢 💥 💫 💬 💭 🔥 ✨ ⭐ 🌟 ⚡ 🎉 🎊 🔔 🔕 🎵 🎶 ♻️ 🆗 🆕 🆒 🔝" },
  { id: "nature", icon: "🌿", list: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦅 🦉 🐺 🐗 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🦖 🐙 🐬 🐳 🦈 🌵 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🌷 🌹 🌻 🌸 🌍 🌙 ☀️ ⛅ 🌧️ ❄️ 🌈 🌊" },
  { id: "food", icon: "🍕", list: "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🥦 🌽 🥕 🧄 🥔 🥐 🥨 🧀 🥚 🍳 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🍝 🍜 🍣 🍱 🥟 🍦 🍩 🍪 🎂 🍰 🍫 🍿 ☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🥃 🍸" },
  { id: "activity", icon: "⚽", list: "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥅 ⛳ 🏹 🎣 🥊 🥋 ⛸️ 🎿 🏂 🏆 🥇 🥈 🥉 🏅 🎮 🕹️ 🎲 ♟️ 🧩 🎯 🎳 🎸 🎹 🥁 🎤 🎧 🎬 🎨 🚗 🚕 🚙 🏎️ 🚓 🚑 🚒 🚲 🛴 🏍️ ✈️ 🚀 🛸 🚁 ⛵ 🚢 🏠 🏰 🗽 🗻" },
  { id: "objects", icon: "💡", list: "💡 🔦 🕯️ 💻 🖥️ ⌨️ 🖱️ 🖨️ 📱 ☎️ 📞 📷 🎥 📺 📻 🎙️ ⏰ ⌛ 📡 🔋 🔌 💾 💿 📀 🧮 📦 📫 ✉️ 📝 📌 📎 🔗 📏 ✂️ 🗂️ 📁 📅 📊 📈 📉 🔒 🔓 🔑 🛠️ 🔧 🔨 ⚙️ 🧲 🧪 💊 💉 🧯 🛒 💰 💳 💎 🎁 🏷️ 📚 🔍" },
];

export function EmojiPicker(props: { anchor: DOMRect; onPick: (e: string) => void; onClose: () => void }) {
  const recent = settings.value.recentEmojis;
  const [cat, setCat] = useState(recent.length ? "recent" : "smileys");
  const list = cat === "recent" ? recent : (CATS.find((c) => c.id === cat)?.list.split(" ") ?? []);
  const pick = (e: string) => {
    updateSettings({ recentEmojis: [e, ...recent.filter((x) => x !== e)].slice(0, 24) });
    props.onPick(e);
  };
  return (
    <Popover anchor={props.anchor} onClose={props.onClose}>
      <div class="emoji-picker">
        <div class="emoji-tabs" role="tablist">
          {recent.length > 0 && (
            <button class={cat === "recent" ? "active" : ""} title={t("emoji.recent")} onClick={() => setCat("recent")}>🕘</button>
          )}
          {CATS.map((c) => (
            <button key={c.id} class={cat === c.id ? "active" : ""} title={t(`emoji.${c.id}` as Key)} onClick={() => setCat(c.id)}>
              {c.icon}
            </button>
          ))}
        </div>
        <div class="emoji-grid">
          {list.map((e) => (
            <button key={e} onClick={() => pick(e)} title={e}>{e}</button>
          ))}
        </div>
      </div>
    </Popover>
  );
}
