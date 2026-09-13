/**
 * Team AI — dashboard surface.
 *
 * Hand-written IIFE, no build step. The host exposes React and its helpers on
 * `window.__HERMES_PLUGIN_SDK__`, so there is nothing to bundle and nothing to
 * keep in sync with the host's React version.
 *
 * Two registrations, because they need different places on the page:
 *
 *   chat:composer  the Team control, beside the model and Build/Plan buttons
 *   overlay        the dialog, on the host's fixed layer above everything
 *
 * The dialog is NOT rendered from inside the composer. `position: fixed` is
 * relative to the nearest ancestor with a transform or filter, and the
 * composer sits inside a stack of positioned, gradient-masked wrappers — a
 * modal mounted there is one CSS change away from being clipped into a
 * 40-pixel strip. `overlay` is the host's own answer to that.
 *
 * Styling is inline and token-based on purpose. The host's Tailwind is built
 * by scanning ITS source at build time, so a class name that only appears in
 * this file generates no CSS. The custom properties (`--bg-secondary`,
 * `--accent`, …) are plain runtime CSS and follow the user's theme.
 */
(function () {
  "use strict";

  var PLUGIN = "team_ai";
  var STORE_KEY = "hermes.plugin.team_ai";

  var sdk = window.__HERMES_PLUGIN_SDK__;
  var registry = window.__HERMES_PLUGINS__;

  if (!sdk || !registry) {
    console.warn("[team_ai] Hermes plugin SDK not found; nothing registered.");
    return;
  }

  // Without this the control would render, arm, show a chip — and change
  // nothing about what gets sent. Refuse to draw a switch that is not wired
  // to anything, and say why.
  if (typeof registry.registerSendTransform !== "function") {
    console.warn(
      "[team_ai] This dashboard has no send-transform API (needs plugin SDK " +
        "1.2.0+). The Team control is not registered, because it could not " +
        "have affected any message."
    );
    return;
  }

  var React = sdk.React;
  var h = React.createElement;
  var useState = sdk.hooks.useState;
  var useEffect = sdk.hooks.useEffect;
  var useMemo = sdk.hooks.useMemo;

  // ── what the tools accept ────────────────────────────────────────────────
  // Mirrors plugins/team_ai/panel.py: DEFAULT_ROUNDS, MAX_ROUNDS, and the
  // two-model floor a panel needs to be a panel.

  var MODES = [
    {
      value: "race",
      tool: "team_race",
      label: "Race",
      hint: "All at once. First usable answer wins, the rest are cancelled.",
      min: 1,
      rounds: false,
    },
    {
      value: "discuss",
      tool: "team_discuss",
      label: "Discuss",
      hint: "Turns. Each reads the others and replies to them by @handle.",
      min: 2,
      rounds: true,
    },
    {
      value: "plan",
      tool: "team_plan",
      label: "Plan",
      hint: "Ordered steps and risks, argued out. Nothing gets implemented.",
      min: 2,
      rounds: true,
    },
    {
      value: "build",
      tool: "team_build",
      label: "Build",
      hint: "One drafts it whole, the rest quote and revise what exists.",
      min: 2,
      rounds: true,
    },
  ];

  var DEFAULT_ROUNDS = 3;
  var MAX_ROUNDS = 8;

  function modeMeta(value) {
    for (var i = 0; i < MODES.length; i++) {
      if (MODES[i].value === value) return MODES[i];
    }
    return MODES[1];
  }

  function clampRounds(value) {
    var n = Math.trunc(Number(value));
    if (!isFinite(n) || n < 1) return DEFAULT_ROUNDS;
    return Math.min(n, MAX_ROUNDS);
  }

  function isCombo(id) {
    return id.indexOf("combo/") === 0;
  }

  function ready(cfg) {
    return !!cfg && cfg.models.length >= modeMeta(cfg.mode).min;
  }

  function summary(cfg) {
    if (!cfg) return "Off";
    var n = cfg.models.length;
    return modeMeta(cfg.mode).label + " · " + n + " model" + (n === 1 ? "" : "s");
  }

  // ── persistence ──────────────────────────────────────────────────────────

  function readCfg() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var mode = modeMeta(parsed.mode).value;
      var models = Array.isArray(parsed.models)
        ? parsed.models.filter(function (m) {
            return typeof m === "string" && m;
          })
        : [];
      if (!models.length) return null;
      return { mode: mode, models: models, rounds: clampRounds(parsed.rounds) };
    } catch (err) {
      // Private windows throw on access, and a hand-edited value can be
      // anything. Off is the neutral state, so a failed read costs nothing.
      return null;
    }
  }

  function writeCfg(cfg) {
    try {
      if (cfg) localStorage.setItem(STORE_KEY, JSON.stringify(cfg));
      else localStorage.removeItem(STORE_KEY);
    } catch (err) {
      /* see readCfg */
    }
  }

  // ── the message the panel actually sends ─────────────────────────────────

  /**
   * Wrap the outgoing message in the panel request.
   *
   * This ASKS for the panel; it does not force it. `prompt.submit` carries
   * text and there is no tool_choice on that path, so the only thing that can
   * invoke a tool is the agent. Stating the call in full — tool, exact model
   * ids, rounds — is the honest version of that, and it stays visible to the
   * model rather than happening behind it.
   *
   * The user's own text goes below a rule rather than into the instructions:
   * a question containing the word `models:` must not read as an argument.
   */
  function applyTeam(text, cfg) {
    if (!ready(cfg)) return text;
    var meta = modeMeta(cfg.mode);
    var lines = [
      "Run this through the model panel. Call the `" +
        meta.tool +
        "` tool exactly once, with:",
      "  models: " + JSON.stringify(cfg.models),
    ];
    if (meta.rounds) lines.push("  rounds: " + clampRounds(cfg.rounds));
    lines.push(
      "  question: everything below the --- line, verbatim",
      "",
      "Do not answer it yourself first, do not substitute other models, and do not",
      "call the tool a second time. After it returns, add at most two sentences of",
      "your own.",
      "",
      "---",
      text
    );
    return lines.join("\n");
  }

  // ── shared state ─────────────────────────────────────────────────────────
  // The control and the dialog live in different slots, so they cannot share
  // React state. A module-level store with listeners is the smallest thing
  // that keeps them in step — the same shape the host's own slot registry uses.

  var store = { cfg: readCfg(), open: false };
  var listeners = [];

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i]();
      } catch (err) {
        /* a dead subscriber must not stop the others */
      }
    }
  }

  function setStore(patch) {
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) store[k] = patch[k];
    }
    emit();
  }

  function useStore() {
    var tick = useState(0);
    var set = tick[1];
    useEffect(function () {
      var fn = function () {
        set(function (n) {
          return n + 1;
        });
      };
      listeners.push(fn);
      return function () {
        var at = listeners.indexOf(fn);
        if (at !== -1) listeners.splice(at, 1);
      };
    }, []);
    return store;
  }

  function setCfg(next) {
    writeCfg(next);
    setStore({ cfg: next });
  }

  // ── styling ──────────────────────────────────────────────────────────────

  var S = {
    trigger: {
      display: "flex",
      alignItems: "center",
      gap: "4px",
      padding: "4px 8px",
      borderRadius: "6px",
      border: "none",
      background: "transparent",
      font: "inherit",
      fontSize: "12px",
      cursor: "pointer",
      color: "var(--text-secondary)",
      whiteSpace: "nowrap",
    },
    backdrop: {
      position: "fixed",
      inset: "0",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px",
      background: "rgba(0,0,0,0.6)",
      zIndex: "var(--z-modal, 100)",
    },
    dialog: {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      maxWidth: "512px",
      maxHeight: "80vh",
      overflow: "hidden",
      borderRadius: "12px",
      border: "1px solid var(--border)",
      background: "var(--bg-secondary)",
      boxShadow: "var(--shadow-md)",
      color: "var(--text-primary)",
    },
    section: { padding: "12px", borderBottom: "1px solid var(--border)" },
    field: {
      width: "100%",
      padding: "6px 8px",
      borderRadius: "6px",
      border: "1px solid var(--border-strong)",
      background: "var(--bg-tertiary)",
      color: "var(--text-primary)",
      font: "inherit",
      fontSize: "12px",
      boxSizing: "border-box",
    },
    row: {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      width: "100%",
      padding: "6px 8px",
      borderRadius: "6px",
      border: "none",
      background: "transparent",
      color: "var(--text-primary)",
      font: "inherit",
      fontSize: "12px",
      textAlign: "left",
      cursor: "pointer",
    },
    badge: {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      width: "20px",
      height: "20px",
      flexShrink: "0",
      borderRadius: "6px",
      border: "1px solid var(--border-strong)",
      fontSize: "10px",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      color: "transparent",
    },
    mono: {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      flex: "1",
      minWidth: "0",
    },
    primary: {
      padding: "6px 12px",
      borderRadius: "6px",
      border: "none",
      background: "var(--accent)",
      color: "var(--bg-primary)",
      font: "inherit",
      fontSize: "12px",
      cursor: "pointer",
    },
    quiet: {
      padding: "6px 12px",
      borderRadius: "6px",
      border: "none",
      background: "transparent",
      color: "var(--text-secondary)",
      font: "inherit",
      fontSize: "12px",
      cursor: "pointer",
    },
  };

  function merge() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
      }
    }
    return out;
  }

  // ── the composer control ─────────────────────────────────────────────────

  function TeamControl() {
    var s = useStore();
    var armed = ready(s.cfg);

    return h(
      "button",
      {
        type: "button",
        title: armed
          ? "Panel: " + s.cfg.models.join(", ")
          : "Answer the next message with several models",
        "aria-haspopup": "dialog",
        onClick: function () {
          setStore({ open: true });
        },
        style: merge(S.trigger, armed ? { color: "var(--accent)" } : null),
      },
      h("span", { "aria-hidden": "true" }, "◉"),
      h("span", null, armed ? summary(s.cfg) : "Team")
    );
  }

  // ── the dialog ───────────────────────────────────────────────────────────

  function TeamDialog() {
    var s = useStore();
    var open = s.open;

    var modeState = useState("discuss");
    var mode = modeState[0];
    var setMode = modeState[1];
    var pickedState = useState([]);
    var picked = pickedState[0];
    var setPicked = pickedState[1];
    var roundsState = useState(DEFAULT_ROUNDS);
    var rounds = roundsState[0];
    var setRounds = roundsState[1];
    var queryState = useState("");
    var query = queryState[0];
    var setQuery = queryState[1];

    // null while unknown, [] when the fetch failed or the provider lists none.
    var availState = useState(null);
    var available = availState[0];
    var setAvailable = availState[1];
    var providerState = useState("");
    var provider = providerState[0];
    var setProvider = providerState[1];
    var errState = useState("");
    var loadError = errState[0];
    var setLoadError = errState[1];

    // Re-seed from the stored config every time the dialog opens: another tab,
    // or the chip's own "turn off", can have moved it since last time.
    useEffect(
      function () {
        if (!open) return;
        var cfg = store.cfg;
        setMode(cfg ? cfg.mode : "discuss");
        setPicked(cfg ? cfg.models.slice() : []);
        setRounds(cfg ? clampRounds(cfg.rounds) : DEFAULT_ROUNDS);
        setQuery("");
      },
      [open]
    );

    useEffect(
      function () {
        if (!open) return;
        var dead = false;
        // Panelists come from the CURRENT provider only: panel.py calls
        // async_call_llm(model=…) with no provider override, so every id is
        // resolved against the one base_url the session already uses.
        sdk
          .fetchJSON("/api/model/options")
          .then(function (res) {
            if (dead) return;
            var all = (res && res.providers) || [];
            var slug = String((res && res.provider) || "");
            var current = null;
            for (var i = 0; i < all.length; i++) {
              if (all[i].slug === slug || (!current && all[i].is_current)) current = all[i];
              if (all[i].slug === slug) break;
            }
            setProvider((current && (current.name || current.slug)) || "");
            setAvailable(((current && current.models) || []).filter(Boolean));
          })
          .catch(function (err) {
            if (dead) return;
            setAvailable([]);
            setLoadError(String((err && err.message) || err));
          });
        return function () {
          dead = true;
        };
      },
      [open]
    );

    useEffect(
      function () {
        if (!open) return;
        var onKey = function (e) {
          if (e.key === "Escape") setStore({ open: false });
        };
        document.addEventListener("keydown", onKey);
        return function () {
          document.removeEventListener("keydown", onKey);
        };
      },
      [open]
    );

    var meta = modeMeta(mode);
    var draft = { mode: mode, models: picked, rounds: rounds };
    var isReady = ready(draft);

    // Picked models stay listed even when the filter excludes them — a search
    // that hides half your panel makes the count at the bottom look wrong.
    var groups = useMemo(
      function () {
        var q = query.trim().toLowerCase();
        var rows = (available || []).filter(function (m) {
          return picked.indexOf(m) !== -1 || !q || m.toLowerCase().indexOf(q) !== -1;
        });
        return {
          combos: rows.filter(isCombo),
          plain: rows.filter(function (m) {
            return !isCombo(m);
          }),
        };
      },
      [available, query, picked]
    );

    if (!open) return null;

    function toggle(model) {
      setPicked(function (prev) {
        return prev.indexOf(model) === -1
          ? prev.concat([model])
          : prev.filter(function (m) {
              return m !== model;
            });
      });
    }

    function modelRow(model) {
      var at = picked.indexOf(model);
      var on = at !== -1;
      return h(
        "button",
        {
          key: model,
          type: "button",
          "aria-pressed": on,
          onClick: function () {
            toggle(model);
          },
          style: merge(S.row, on ? { background: "var(--bg-tertiary)" } : null),
        },
        h(
          "span",
          {
            "aria-hidden": "true",
            style: merge(
              S.badge,
              on ? { borderColor: "var(--accent)", color: "var(--accent)" } : null
            ),
          },
          // The position, not a tick: in a discussion this is turn order.
          on ? String(at + 1) : "·"
        ),
        h("span", { style: S.mono }, model)
      );
    }

    function group(title, note, rows) {
      if (!rows.length) return null;
      return h(
        "div",
        { key: title, style: { marginBottom: "8px" } },
        h(
          "div",
          { style: { display: "flex", gap: "8px", alignItems: "baseline", padding: "4px 8px" } },
          h("span", { style: { fontSize: "12px", color: "var(--text-secondary)" } }, title),
          note
            ? h("span", { style: { fontSize: "10px", color: "var(--text-tertiary)" } }, note)
            : null
        ),
        rows.map(modelRow)
      );
    }

    return h(
      "div",
      {
        style: S.backdrop,
        role: "dialog",
        "aria-modal": "true",
        "aria-label": "Team AI panel",
        onClick: function (e) {
          if (e.target === e.currentTarget) setStore({ open: false });
        },
      },
      h(
        "div",
        { style: S.dialog },

        // header
        h(
          "div",
          { style: merge(S.section, { position: "relative" }) },
          h("div", { style: { fontSize: "14px", fontWeight: "600" } }, "Team AI panel"),
          h(
            "div",
            { style: { marginTop: "4px", fontSize: "12px", color: "var(--text-secondary)" } },
            "Several models answer the next message together" +
              (provider ? " — " + provider + " models only." : ".")
          ),
          h(
            "button",
            {
              type: "button",
              "aria-label": "Close",
              onClick: function () {
                setStore({ open: false });
              },
              style: merge(S.quiet, { position: "absolute", right: "8px", top: "8px" }),
            },
            "✕"
          )
        ),

        // mode + rounds
        h(
          "div",
          { style: S.section },
          h(
            "div",
            { style: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "4px" } },
            MODES.map(function (m) {
              var on = m.value === mode;
              return h(
                "button",
                {
                  key: m.value,
                  type: "button",
                  "aria-pressed": on,
                  onClick: function () {
                    setMode(m.value);
                  },
                  style: merge(
                    S.quiet,
                    { padding: "6px 8px", textAlign: "center" },
                    on ? { background: "var(--accent)", color: "var(--bg-primary)" } : null
                  ),
                },
                m.label
              );
            })
          ),
          h(
            "div",
            { style: { marginTop: "8px", fontSize: "12px", color: "var(--text-secondary)" } },
            meta.hint
          ),
          meta.rounds
            ? h(
                "label",
                {
                  style: {
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginTop: "8px",
                    fontSize: "12px",
                    color: "var(--text-secondary)",
                  },
                },
                h("span", null, "Rounds"),
                h("input", {
                  type: "number",
                  min: 1,
                  max: MAX_ROUNDS,
                  value: rounds,
                  onChange: function (e) {
                    setRounds(clampRounds(e.target.value));
                  },
                  style: merge(S.field, { width: "64px" }),
                }),
                h(
                  "span",
                  { style: { color: "var(--text-tertiary)" } },
                  "one round = every model speaks once (max " + MAX_ROUNDS + ")"
                )
              )
            : null
        ),

        // filter
        h(
          "div",
          { style: S.section },
          h("input", {
            value: query,
            placeholder: "Filter models…",
            "aria-label": "Filter models",
            onChange: function (e) {
              setQuery(e.target.value);
            },
            style: S.field,
          })
        ),

        // list
        h(
          "div",
          { style: { flex: "1", minHeight: "0", overflowY: "auto", padding: "4px" } },
          available === null
            ? h(
                "p",
                { style: { padding: "16px 12px", fontSize: "12px", color: "var(--text-tertiary)" } },
                "Loading models…"
              )
            : !available.length
              ? h(
                  "p",
                  {
                    style: {
                      padding: "16px 12px",
                      fontSize: "12px",
                      color: "var(--text-tertiary)",
                    },
                  },
                  loadError || "No models listed for the current provider."
                )
              : !groups.combos.length && !groups.plain.length
                ? h(
                    "p",
                    {
                      style: {
                        padding: "16px 12px",
                        fontSize: "12px",
                        color: "var(--text-tertiary)",
                      },
                    },
                    "Nothing matches “" + query + "”."
                  )
                : [
                    group(
                      "Combos",
                      "a routing rule — resolves to whichever link answers",
                      groups.combos
                    ),
                    group("Models", "", groups.plain),
                  ]
        ),

        // footer
        h(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              padding: "12px",
              borderTop: "1px solid var(--border)",
            },
          },
          h(
            "span",
            {
              style: {
                fontSize: "12px",
                color: isReady ? "var(--text-secondary)" : "var(--text-tertiary)",
                minWidth: "0",
              },
            },
            isReady
              ? picked.length +
                  " on the panel" +
                  (meta.rounds ? " · " + rounds + " round" + (rounds === 1 ? "" : "s") : "")
              : meta.label +
                  " needs at least " +
                  meta.min +
                  " model" +
                  (meta.min === 1 ? "" : "s") +
                  " — " +
                  picked.length +
                  " picked"
          ),
          h(
            "span",
            { style: { display: "flex", gap: "8px", flexShrink: "0" } },
            s.cfg
              ? h(
                  "button",
                  {
                    type: "button",
                    style: S.quiet,
                    onClick: function () {
                      setCfg(null);
                      setStore({ open: false });
                    },
                  },
                  "Turn off"
                )
              : null,
            h(
              "button",
              {
                type: "button",
                disabled: !isReady,
                style: merge(S.primary, isReady ? null : { opacity: "0.4", cursor: "not-allowed" }),
                onClick: function () {
                  if (!isReady) return;
                  setCfg({ mode: mode, models: picked.slice(), rounds: rounds });
                  setStore({ open: false });
                },
              },
              "Use panel"
            )
          )
        )
      )
    );
  }

  // ── the panel result, as bubbles ─────────────────────────────────────────
  // The tools append a machine-readable tail to their text result:
  //   <!--HERMES_PANEL {"turns":[…],"note":"…","failures":[…]} -->
  // An HTML comment because every other surface — the CLI, the logs, a model
  // reading the tool result — shows it as inert noise at worst.

  var OPEN = "<!--HERMES_PANEL ";
  var CLOSE = " -->";

  function parsePanel(raw) {
    var plain = { text: raw, turns: null, note: "", failures: [] };
    if (!raw) return plain;
    var start = raw.indexOf(OPEN);
    if (start === -1) return plain;
    var end = raw.indexOf(CLOSE, start);
    if (end === -1) return plain;
    try {
      var parsed = JSON.parse(raw.slice(start + OPEN.length, end));
      var turns = Array.isArray(parsed.turns) ? parsed.turns : null;
      if (!turns || !turns.length) return plain;
      return {
        text: (raw.slice(0, start) + raw.slice(end + CLOSE.length)).trim(),
        turns: turns,
        // Deliberately not the prose: it repeats every turn in full, so using
        // it as a header prints the panel twice.
        note: typeof parsed.note === "string" ? parsed.note : "",
        failures: Array.isArray(parsed.failures) ? parsed.failures : [],
      };
    } catch (err) {
      // Malformed payload: show the result as-is. Losing the bubbles is
      // cosmetic; losing the answer is not.
      return plain;
    }
  }

  /** Stable hue per model, so one speaker keeps its colour across turns. */
  function hueFor(model) {
    var n = 0;
    for (var i = 0; i < model.length; i++) n = (n * 31 + model.charCodeAt(i)) | 0;
    return Math.abs(n) % 360;
  }

  function PanelResult(props) {
    var panel = parsePanel(props.output || "");

    if (props.running) {
      return h(
        "div",
        { style: { fontSize: "12px", color: "var(--text-tertiary)", padding: "4px" } },
        h("span", { style: { color: "var(--accent)" } }, "◍ "),
        props.name,
        " running…"
      );
    }

    if (!panel.turns) {
      // Not a panel payload — an error string, or a result from a version
      // that predates the tail. Show it rather than an empty frame.
      return h(
        "div",
        { style: { fontSize: "12px", color: "var(--text-secondary)", padding: "4px" } },
        h(
          "div",
          { style: { color: "var(--text-tertiary)", marginBottom: "4px" } },
          props.name
        ),
        h(
          "pre",
          {
            style: {
              margin: "0",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: "11px",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            },
          },
          panel.text || "(no output)"
        )
      );
    }

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "12px" } },

      panel.note
        ? h("p", { style: { margin: "0", fontSize: "12px", color: "var(--text-tertiary)" } }, panel.note)
        : null,

      panel.turns.map(function (t, i) {
        var hue = hueFor(t.model || "");
        var via = t.requested && t.requested !== t.model ? " · via " + t.requested : "";
        return h(
          "div",
          {
            key: (t.model || "turn") + "-" + i,
            style: { display: "flex", flexDirection: "column", gap: "4px" },
          },
          h(
            "div",
            { style: { display: "flex", gap: "8px", alignItems: "baseline" } },
            h(
              "span",
              {
                style: {
                  // Hue only; lightness and saturation stay fixed so every
                  // speaker label sits at the same weight against both themes.
                  color: "hsl(" + hue + " 55% 65%)",
                  fontSize: "12px",
                  fontWeight: "500",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                },
              },
              t.handle || "@" + String(t.model || "")
            ),
            h(
              "span",
              {
                style: {
                  fontSize: "10px",
                  color: "var(--text-tertiary)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                },
              },
              String(t.model || "") + via + " · " + t.seconds + "s"
            )
          ),
          h(
            "div",
            {
              style: {
                borderRadius: "8px",
                border: "1px solid hsl(" + hue + " 40% 45% / 0.45)",
                background: "var(--bg-secondary)",
                color: "var(--text-primary)",
                padding: "8px 12px",
              },
            },
            h(
              "p",
              {
                style: {
                  margin: "0",
                  fontSize: "14px",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                },
              },
              t.text
            )
          )
        );
      }),

      // A panelist that never spoke is part of what happened. Without this the
      // bubbles under-report the panel: two models were asked, one answered,
      // and nothing on screen says why the other is missing.
      panel.failures.length
        ? h(
            "ul",
            { style: { margin: "0", padding: "0", listStyle: "none" } },
            panel.failures.map(function (f, i) {
              return h(
                "li",
                {
                  key: (f.model || "fail") + "-" + i,
                  style: { fontSize: "12px", color: "var(--text-tertiary)" },
                },
                f.model +
                  " did not answer" +
                  (f.round ? " in round " + f.round : "") +
                  " — " +
                  f.error
              );
            })
          )
        : null
    );
  }

  // ── registration ─────────────────────────────────────────────────────────
  // registerSlot takes (plugin, slot, component) — the order slots.ts
  // implements. Older copies of the host's sdk.d.ts document (slot, name),
  // which is wrong and would register into a slot named "team_ai".

  registry.registerSlot(PLUGIN, "chat:composer", TeamControl);
  registry.registerSlot(PLUGIN, "overlay", TeamDialog);

  registry.registerSendTransform(PLUGIN, function (text) {
    return applyTeam(text, store.cfg);
  });

  // Optional: a host on SDK 1.2.x has the composer control and the transform
  // but no way to hand a tool's result back to us, so the panel renders as
  // the built-in one-line chip. That is a smaller loss than the control not
  // working at all, so it is a soft check rather than a bail-out.
  if (typeof registry.registerToolRenderer === "function") {
    ["team_race", "team_discuss", "team_plan", "team_build"].forEach(function (tool) {
      registry.registerToolRenderer(PLUGIN, tool, PanelResult);
    });
  } else {
    console.info(
      "[team_ai] No tool-renderer API (needs plugin SDK 1.3.0+); panel results " +
        "will render as the built-in tool row."
    );
  }

  console.info("[team_ai] composer control registered (SDK " + sdk.sdkVersion + ")");
})();
