/* ==================================================================
   CRAZYGAMES SDK ADAPTER
   ------------------------------------------------------------------
   Full Launch requires the SDK: gameplayStart/gameplayStop around play,
   ads only through the SDK, and the Data module for saved progress.

   The important property here is that the game is IDENTICAL with no SDK
   at all. Every call is fire-and-forget and wrapped, so a blocked script,
   an ad blocker, an offline laptop, or a host that isn't CrazyGames
   simply loses telemetry and ads — never the game. That is also a hard
   requirement: the game must work with an ad blocker present.

   The script is only injected on a crazygames.com host, so localhost and
   previews stay clean and we never initialise the SDK in the wrong
   context.
   ================================================================== */

const ON_CRAZYGAMES = /(^|\.)crazygames\.com$/i.test(location.hostname);

export const sdk = {
  ready: false,
  started: false,

  async init() {
    if (!ON_CRAZYGAMES || window.__cgInitTried) return false;
    window.__cgInitTried = true;
    try {
      // The tag is already in <head>; wait for it if the network is slow,
      // and give up quietly if it never arrives.
      await new Promise(resolve => {
        if (window.CrazyGames?.SDK) return resolve();
        const tag = document.getElementById("cg-sdk");
        if (!tag) return resolve();
        const done = () => resolve();
        tag.addEventListener("load", done, { once: true });
        tag.addEventListener("error", done, { once: true });
        setTimeout(done, 6000);
      });
      await window.CrazyGames.SDK.init();
      this.ready = true;
      return true;
    } catch {
      // No SDK: the game still runs. Nothing to do.
      return false;
    }
  },

  /** Player is actually driving — not in a menu, not in a results screen. */
  gameplayStart() {
    if (!this.ready || this.started) return;
    this.started = true;
    try { window.CrazyGames.SDK.game.gameplayStart(); } catch { /* ignore */ }
  },

  gameplayStop() {
    if (!this.ready || !this.started) return;
    this.started = false;
    try { window.CrazyGames.SDK.game.gameplayStop(); } catch { /* ignore */ }
  },

  /** Midgame ad, used between runs. Resolves either way. */
  async ad() {
    if (!this.ready) return false;
    return new Promise(resolve => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      setTimeout(() => done(false), 12000);          // never hang the retry button
      try {
        window.CrazyGames.SDK.ad.requestAd("midgame", {
          adStarted: () => {},
          adFinished: () => done(true),
          adError: () => done(false),                  // errors must not block play
        });
      } catch { done(false); }
    });
  },

  /** Cloud-saveable progress. Falls back to localStorage when absent. */
  async load(key) {
    try {
      if (this.ready && window.CrazyGames.SDK.data) {
        return await window.CrazyGames.SDK.data.getItem(key);
      }
    } catch { /* fall through */ }
    try { return localStorage.getItem(key); } catch { return null; }
  },

  async save(key, value) {
    try {
      if (this.ready && window.CrazyGames.SDK.data) {
        await window.CrazyGames.SDK.data.setItem(key, value);
        return;
      }
    } catch { /* fall through */ }
    try { localStorage.setItem(key, value); } catch { /* quota / disabled */ }
  },

  /** Interstitial point the portal may use for its own scheduling. */
  happy() {
    if (!this.ready) return;
    try { window.CrazyGames.SDK.game.happytime(); } catch { /* ignore */ }
  },
};
