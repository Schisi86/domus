// Emoji shortcodes for ":name" suggestions in the composer (Discord style).

export const SHORTCODES: [string, string][] = [
  ["smile", "😄"], ["grin", "😁"], ["joy", "😂"], ["rofl", "🤣"], ["sweat_smile", "😅"], ["laughing", "😆"], ["wink", "😉"], ["blush", "😊"],
  ["innocent", "😇"], ["heart_eyes", "😍"], ["star_struck", "🤩"], ["kiss", "😘"], ["yum", "😋"], ["stuck_out_tongue", "😛"], ["zany", "🤪"], ["sunglasses", "😎"],
  ["nerd", "🤓"], ["thinking", "🤔"], ["raised_eyebrow", "🤨"], ["neutral", "😐"], ["expressionless", "😑"], ["no_mouth", "😶"], ["eye_roll", "🙄"], ["smirk", "😏"],
  ["grimacing", "😬"], ["relieved", "😌"], ["pensive", "😔"], ["sleepy", "😪"], ["sleeping", "😴"], ["mask", "😷"], ["nauseated", "🤢"], ["hot", "🥵"],
  ["cold", "🥶"], ["dizzy", "😵"], ["exploding_head", "🤯"], ["cowboy", "🤠"], ["party", "🥳"], ["confused", "😕"], ["worried", "😟"], ["slight_smile", "🙂"],
  ["upside_down", "🙃"], ["open_mouth", "😮"], ["astonished", "😲"], ["flushed", "😳"], ["pleading", "🥺"], ["cry", "😢"], ["sob", "😭"], ["scream", "😱"],
  ["angry", "😠"], ["rage", "😡"], ["skull", "💀"], ["clown", "🤡"], ["ghost", "👻"], ["alien", "👽"], ["robot", "🤖"], ["poop", "💩"],
  ["thumbsup", "👍"], ["+1", "👍"], ["thumbsdown", "👎"], ["-1", "👎"], ["clap", "👏"], ["raised_hands", "🙌"], ["pray", "🙏"], ["handshake", "🤝"],
  ["wave", "👋"], ["ok_hand", "👌"], ["v", "✌️"], ["crossed_fingers", "🤞"], ["metal", "🤘"], ["muscle", "💪"], ["point_up", "☝️"], ["point_right", "👉"],
  ["eyes", "👀"], ["brain", "🧠"], ["facepalm", "🤦"], ["shrug", "🤷"], ["heart", "❤️"], ["orange_heart", "🧡"], ["yellow_heart", "💛"], ["green_heart", "💚"],
  ["blue_heart", "💙"], ["purple_heart", "💜"], ["black_heart", "🖤"], ["broken_heart", "💔"], ["sparkling_heart", "💖"], ["100", "💯"], ["fire", "🔥"], ["sparkles", "✨"],
  ["star", "⭐"], ["zap", "⚡"], ["boom", "💥"], ["tada", "🎉"], ["confetti", "🎊"], ["gift", "🎁"], ["balloon", "🎈"], ["trophy", "🏆"],
  ["medal", "🏅"], ["crown", "👑"], ["gem", "💎"], ["money", "💰"], ["rocket", "🚀"], ["check", "✅"], ["x", "❌"], ["warning", "⚠️"],
  ["question", "❓"], ["exclamation", "❗"], ["bulb", "💡"], ["lock", "🔒"], ["key", "🔑"], ["bell", "🔔"], ["mega", "📣"], ["speech", "💬"],
  ["zzz", "💤"], ["coffee", "☕"], ["beer", "🍺"], ["beers", "🍻"], ["wine", "🍷"], ["pizza", "🍕"], ["burger", "🍔"], ["fries", "🍟"],
  ["cake", "🎂"], ["cookie", "🍪"], ["popcorn", "🍿"], ["sun", "☀️"], ["moon", "🌙"], ["rainbow", "🌈"], ["snowflake", "❄️"], ["cloud", "☁️"],
  ["dog", "🐶"], ["cat", "🐱"], ["fox", "🦊"], ["panda", "🐼"], ["unicorn", "🦄"], ["frog", "🐸"], ["monkey", "🙈"], ["penguin", "🐧"],
  ["video_game", "🎮"], ["joystick", "🕹️"], ["dart", "🎯"], ["game_die", "🎲"], ["soccer", "⚽"], ["basketball", "🏀"], ["headphones", "🎧"], ["microphone", "🎤"],
  ["computer", "💻"], ["phone", "📱"], ["camera", "📷"], ["movie", "🎬"], ["music", "🎵"], ["guitar", "🎸"], ["calendar", "📅"], ["pushpin", "📌"],
  ["clock", "⏰"], ["hourglass", "⏳"], ["thumbs", "👍"], ["ok", "🆗"], ["new", "🆕"], ["cool", "🆒"], ["sos", "🆘"], ["stop", "🛑"],
];

/** Suggestions for a typed ":query": prefix matches first, then contains. */
export function suggestEmoji(query: string, limit = 8): [string, string][] {
  const q = query.toLowerCase();
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const pass of [(n: string) => n.startsWith(q), (n: string) => n.includes(q)]) {
    for (const [n, e] of SHORTCODES) {
      if (out.length >= limit) return out;
      if (pass(n) && !seen.has(n)) {
        seen.add(n);
        out.push([n, e]);
      }
    }
  }
  return out;
}

/** Emoji for a complete ":name:" or null. */
export function shortcode(name: string) {
  return SHORTCODES.find(([n]) => n === name.toLowerCase())?.[1] ?? null;
}
