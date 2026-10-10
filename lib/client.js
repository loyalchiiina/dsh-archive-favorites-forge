window.__ModuleLoader__.load({
  id: "dsh-archive-favorites-forge",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    // =====================================================================
    // dsh-archive-favorites-forge — client half
    //
    // Adds three things to DSH's OWN archive feature without editing a single
    // official file:
    //
    //   1. Copy conversation id / transcript absolute path  (session "..." menu)
    //   2. Favourite a conversation, any conversation       (menu + row star)
    //   3. Browse favourites and batch-delete the             (settings section)
    //      archived conversations that are NOT favourited
    //
    // HOW IT ATTACHES
    // ---------------
    // Two documented official list slots plus one settings page:
    //
    //   sidebar.workspaces.session.menu.item    -> the session "..." menu rows
    //   sidebar.workspaces.session.row.action   -> the hover icon buttons
    //   settings.section                        -> a settings nav page
    //
    // The two sidebar slots are declared by `@deepseek-ai/dsh-client-ui-workspace`
    // and are only mounted while its sidebar entry is. `ctx.slots.inject` is
    // exactly the "register once the owner exists" contract, so we never touch
    // a node the host owns and never assume the sidebar is up.
    //
    // WHY THE FAVOURITES SET IS NOT IN localStorage
    // ---------------------------------------------
    // localStorage is origin-scoped: the desktop shell, the mobile view and a
    // remote browser are different origins and would each hold their own stars.
    // The host half persists them to ~/.dsh/data/<plugin>/favorites.json and
    // serves them over /plugins/dsh-archive-favorites-forge/*. We keep an
    // in-memory cache for synchronous render and refresh it in the background.
    // =====================================================================

    var ROUTE = "/plugins/dsh-archive-favorites-forge";

    // ---- diagnostics -----------------------------------------------------
    //
    // DSH's main process forwards only a WHITELIST of client console prefixes
    // to the host log; any other prefix is dropped entirely. `[next-ui-diagnostic]`
    // is on that whitelist, so it is the one channel that lets a third-party
    // bundle prove it executed. This exists because "the menu rows never
    // appeared" is otherwise indistinguishable from "the bundle never loaded",
    // "the slot was never owned", and "the component threw".
    function diag(message) {
      try { console.warn("[next-ui-diagnostic] dsh-aff: " + message); } catch (e) {}
    }

    var React = null;
    try {
      var _react = require("react");
      React = (_react && _react.default) || _react;
    } catch (e) { React = null; }
    if (!React) { try { React = window.React || null; } catch (e) { React = null; } }

    // ---- host bridge ----------------------------------------------------

    // Always a ROOT-RELATIVE path. An absolute http://127.0.0.1:<port> URL is
    // blocked by the renderer's CSP in the desktop shell, and hard-coding the
    // port breaks whenever the host picks another one. Relative paths ride the
    // same transport the rest of the client uses.
    function api(route, body) {
      var init = { headers: { "content-type": "application/json" } };
      if (body !== undefined) {
        init.method = "POST";
        init.body = JSON.stringify(body);
      }
      return fetch(ROUTE + route, init).then(function (res) {
        return res.json();
      });
    }

    // ---- favourites cache ------------------------------------------------
    //
    // The render path is synchronous (React slots render during a commit), so
    // the set lives in memory and is kept fresh by `refreshFavorites()`. The
    // listeners let an open settings page re-render the moment a star toggles
    // somewhere else.
    var favSet = {};
    var favReady = false;
    var favListeners = [];

    function favoriteIds() { return Object.keys(favSet); }

    /**
     * The comparison form of a session id: the bare uuid.
     *
     * 🔴 THE HARNESS SPELLS A SESSION ID TWO WAYS. The sidebar's `data-row-key`
     * and the slot's `sessionId` use `session-<uuid>`; the registry's stored
     * sets were measured to hold 22 bare `<uuid>` entries alongside 83 prefixed
     * ones. Comparing raw strings therefore fails silently for whichever
     * spelling differs — a star that will not clear, or an "is this archived?"
     * test that answers wrong for a subset of rows.
     */
    function idKey(sessionId) {
      var text = String(sessionId === undefined || sessionId === null ? "" : sessionId);
      return text.indexOf("session-") === 0 ? text.slice("session-".length) : text;
    }

    function isFavorite(sessionId) {
      var key = idKey(sessionId);
      for (var id in favSet) {
        if (Object.prototype.hasOwnProperty.call(favSet, id) && idKey(id) === key) return true;
      }
      return false;
    }

    /** Whether an archived-id list contains this session, in either spelling. */
    function archivedHas(archivedIds, sessionId) {
      if (!Array.isArray(archivedIds)) return false;
      var key = idKey(sessionId);
      for (var i = 0; i < archivedIds.length; i++) {
        if (idKey(archivedIds[i]) === key) return true;
      }
      return false;
    }

    function setFavorites(next) {
      favSet = (next && typeof next === "object") ? next : {};
      favReady = true;
      // Opening the safety gate: from here on the marker on each row is
      // meaningful, so the filter rule may act on it.
      favoritesLoaded = true;
      var snapshot = favListeners.slice();
      for (var i = 0; i < snapshot.length; i++) {
        try { snapshot[i](); } catch (e) {}
      }
      // The row marking and the favourites filter both read from this cache, so
      // every change must refresh them. `scheduleMark` is declared later in the
      // factory but is hoisted, and it no-ops when the enhancer is not running.
      scheduleMark();
    }

    function refreshFavorites() {
      return api("/favorites").then(function (data) {
        if (data && data.ok) setFavorites(data.favorites);
        return data;
      }).catch(function () { return null; });
    }

    function toggleFavorite(sessionId, title) {
      var next = !isFavorite(sessionId);
      // Optimistic: the star must feel instant. A failed write rolls back.
      var optimistic = Object.assign({}, favSet);
      if (next) optimistic[sessionId] = { at: new Date().toISOString(), title: title || "", cwd: "" };
      else delete optimistic[sessionId];
      setFavorites(optimistic);
      return api("/favorite", { sessionId: sessionId, value: next, title: title || "" }).then(function (data) {
        if (data && data.ok) setFavorites(data.favorites);
        else setFavorites(favSet);
        return next;
      }).catch(function () {
        setFavorites(favSet);
        return !next;
      });
    }

    // ---- clipboard / notices --------------------------------------------

    function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return legacyCopy(text); });
        }
      } catch (e) {}
      return Promise.resolve(legacyCopy(text));
    }

    function legacyCopy(text) {
      // Fallback for a non-secure or restricted context: an off-screen
      // textarea + execCommand still works where the async clipboard is denied.
      try {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(area);
        return ok;
      } catch (e) { return false; }
    }

    // A tiny self-owned toast. The host has its own notice channel, but it is
    // reachable only from the owner plugin's injected props, which a third
    // party does not receive.
    //
    // COLOURS ARE HARD-CODED, DELIBERATELY. The first version used
    // `var(--dsw-alias-bg-elevated, <fallback>)`, which rendered as a dark box
    // with dark text: a `var()` whose name resolves to an EMPTY value does not
    // fall back — it makes the whole declaration invalid, so the element kept
    // the initial (transparent) background while the text stayed at the
    // inherited dark colour. A self-contained overlay must not depend on a
    // theme token it cannot verify, so this uses explicit values.
    var TOAST_ID = "dsh-aff-toast";
    var toastTimer = null;

    function ensureToastStyle() {
      if (document.getElementById(TOAST_ID + "-style") !== null) return;
      var style = document.createElement("style");
      style.id = TOAST_ID + "-style";
      style.textContent =
        "#" + TOAST_ID + "{" +
        "position:fixed;left:50%;top:18px;transform:translateX(-50%) translateY(-8px);" +
        "z-index:2147483000;max-width:min(560px,80vw);" +
        "padding:10px 16px;border-radius:10px;" +
        "background:#2b2d31;color:#ffffff;" +
        "border:1px solid rgba(255,255,255,.18);" +
        "box-shadow:0 8px 28px rgba(0,0,0,.45);" +
        "font-size:13px;line-height:19px;font-weight:500;" +
        "word-break:break-all;white-space:pre-wrap;pointer-events:none;" +
        "opacity:0;transition:opacity .16s ease,transform .16s ease;}" +
        "#" + TOAST_ID + ".dsh-aff-toast-show{opacity:1;transform:translateX(-50%) translateY(0);}" +
        // A light theme needs the inverse, or white-on-white reappears.
        "@media (prefers-color-scheme:light){" +
        "#" + TOAST_ID + "{background:#ffffff;color:#1c1c1e;border-color:rgba(0,0,0,.14);" +
        "box-shadow:0 8px 28px rgba(0,0,0,.18);}}";
      document.head.appendChild(style);
    }

    function toast(message) {
      try {
        ensureToastStyle();
        var el = document.getElementById(TOAST_ID);
        if (el === null) {
          el = document.createElement("div");
          el.id = TOAST_ID;
          el.setAttribute("role", "status");
          el.setAttribute("aria-live", "polite");
          document.body.appendChild(el);
        }
        el.textContent = message;
        // Force a reflow so a rapid second toast restarts the transition.
        void el.offsetWidth;
        el.classList.add("dsh-aff-toast-show");
        if (toastTimer !== null) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
          var node = document.getElementById(TOAST_ID);
          if (node !== null) node.classList.remove("dsh-aff-toast-show");
        }, 2400);
      } catch (e) {}
    }

    // ---- session info ----------------------------------------------------

    function titleOf(sessionId) {
      var entry = favSet[sessionId];
      return entry && typeof entry.title === "string" ? entry.title : "";
    }

    function copyId(sessionId) {
      copyText(sessionId).then(function (ok) {
        toast(ok ? "已复制对话 ID：" + sessionId : "复制失败，请手动选择：" + sessionId);
      });
    }

    function copyPath(sessionId) {
      api("/session-info", { sessionId: sessionId }).then(function (data) {
        if (data && data.ok && data.path) {
          copyText(data.path).then(function (ok) {
            toast(ok ? "已复制转录文件绝对路径：" + data.path : "复制失败，路径为：" + data.path);
          });
        } else {
          toast("未找到该对话的转录文件（可能尚未落盘）");
        }
      }).catch(function () {
        toast("读取路径失败：宿主接口不可用");
      });
    }

    // =====================================================================
    // Slot components
    // =====================================================================

    function useFavoriteState(sessionId) {
      var pair = React.useState(0);
      var bump = pair[1];
      React.useEffect(function () {
        var listener = function () { bump(function (n) { return n + 1; }); };
        favListeners.push(listener);
        return function () {
          var at = favListeners.indexOf(listener);
          if (at >= 0) favListeners.splice(at, 1);
        };
      }, []);
      return isFavorite(sessionId);
    }

    // ------------------------------------------------------------------
    // Menu row, structurally identical to ui-primitives' `MenuItemButton`.
    //
    // THE WRAPPER IS NOT OPTIONAL. `Menu` renders its `children` straight into
    // the list viewport:
    //
    //     jsxs("div", { className: viewport, children: [items.map(renderEntry), children] })
    //
    // where every row it renders itself is a `div.itemWrap` around a
    // `button.item`. `.viewport` is a flex column and `.item` carries
    // `width:100%; min-height:34px; padding:6px 8px; display:flex`. A bare
    // `<button>` dropped in beside those has none of that, so it collapses to a
    // zero/near-zero box and is effectively invisible — which is exactly the
    // symptom this replaced. The class names below are the official ones; the
    // surrounding stylesheet is loaded by ui-primitives itself, so matching the
    // class names is what makes the row pick up the real styling.
    // ------------------------------------------------------------------

    function MenuRow(props) {
      var icon = props.icon === undefined ? null : React.createElement("span", {
        className: "itemIcon",
        style: { display: "inline-flex", flex: "none", width: "14px", height: "14px", alignItems: "center", justifyContent: "center" },
      }, props.icon);

      return React.createElement("div", {
        className: "itemWrap",
        style: { position: "relative" },
      }, React.createElement("button", {
        type: "button",
        role: "menuitem",
        className: props.danger ? "item danger" : "item",
        style: {
          display: "flex",
          alignItems: "center",
          gap: "6px",
          width: "100%",
          minHeight: "34px",
          padding: "6px 8px",
          border: "none",
          borderRadius: "6px",
          background: "transparent",
          cursor: "pointer",
          fontSize: "13px",
          lineHeight: "20px",
          color: props.danger ? "#ff6b6b" : "inherit",
          textAlign: "left",
        },
        onClick: function (event) {
          event.stopPropagation();
          if (props.onSelect) props.onSelect();
        },
      }, icon, React.createElement("span", {
        // `.itemLabel` carries `flex:1; min-width:0; overflow:hidden;
        // text-overflow:ellipsis; white-space:nowrap` in the official sheet.
        className: "itemLabel",
        style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      }, props.children)));
    }

    // --- 1 & 2: session "..." menu rows -----------------------------------

    function FavoriteMenuItem(props) {
      var sessionId = props.sessionId;
      var displayTitle = props.displayTitle;
      var menuOpenState = props.useMenuOpenState ? props.useMenuOpenState() : null;
      var starred = useFavoriteState(sessionId);

      return React.createElement(MenuRow, {
        icon: starred ? "★" : "☆",
        onSelect: function () {
          // The host contract asks a row to dismiss the menu through the
          // injected hook after acting.
          try { if (menuOpenState && menuOpenState[1]) menuOpenState[1](false); } catch (e) {}
          toggleFavorite(sessionId, displayTitle).then(function (nowStarred) {
            toast(nowStarred ? "已收藏对话" : "已取消收藏");
          });
        },
      }, starred ? "取消收藏" : "收藏对话");
    }

    /**
     * One copy row, and only one.
     *
     * Separate "copy id" and "copy path" rows were removed: the id alone is
     * rarely useful without the path, and three near-identical entries made the
     * menu long for no gain. This copies both, one per line, so either value can
     * be taken from the clipboard.
     */
    function CopyBothMenuItem(props) {
      var sessionId = props.sessionId;
      var menuOpenState = props.useMenuOpenState ? props.useMenuOpenState() : null;
      return React.createElement(MenuRow, {
        icon: "⧉",
        onSelect: function () {
          try { if (menuOpenState && menuOpenState[1]) menuOpenState[1](false); } catch (e) {}
          api("/session-info", { sessionId: sessionId }).then(function (data) {
            var path = data && data.ok && data.path ? data.path : "(路径未知)";
            var text = sessionId + "\n" + path;
            copyText(text).then(function (ok) {
              toast(ok ? "已复制 ID + 路径" : "复制失败：" + text);
            });
          }).catch(function () {
            // The host route can fail; the id alone is still worth handing over.
            copyId(sessionId);
          });
        },
      }, "复制 ID + 路径");
    }

    // --- 2 (inline): row star ---------------------------------------------

    function FavoriteRowButton(props) {
      var sessionId = props.sessionId;
      var displayTitle = props.displayTitle;
      var starred = useFavoriteState(sessionId);
      var hover = React.useState(false);
      return React.createElement("button", {
        type: "button",
        className: "dsh-aff-star",
        "aria-label": starred ? "取消收藏" : "收藏对话",
        "aria-pressed": starred ? "true" : "false",
        title: starred ? "取消收藏" : "收藏对话",
        onClick: function (event) {
          // Clicks inside the row-action strip stay in the strip, per the slot
          // contract, but stopping propagation also guarantees the row behind
          // it never receives the click and opens the conversation.
          event.stopPropagation();
          event.preventDefault();
          toggleFavorite(sessionId, displayTitle).then(function (nowStarred) {
            toast(nowStarred ? "已收藏对话" : "已取消收藏");
          });
        },
        onMouseEnter: function () { hover[1](true); },
        onMouseLeave: function () { hover[1](false); },
        style: {
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: "16px", height: "16px", padding: "0", border: "none",
          background: "transparent", cursor: "pointer", flex: "none",
          fontSize: "13px", lineHeight: "1",
          color: starred
            ? "var(--dsw-alias-state-warning-primary, #ffb454)"
            : (hover[0] ? "var(--dsw-alias-label-primary, #f5f5f7)" : "var(--dsw-alias-label-tertiary, #8b8b90)"),
        },
      }, starred ? "★" : "☆");
    }

    // --- single-session permanent delete -----------------------------------

    // Deleting one conversation is irreversible, so it is always behind a
    // confirmation, and one case is refused outright:
    //   * a FAVOURITED session is refused — a favourite is a deliberate
    //     "keep this" signal, so the host refuses it too and the row says why;
    //   * everything else is deletable, archived or not. An earlier version
    //     offered the row only for archived sessions, which read as "the
    //     single-delete feature disappeared" whenever the user opened the menu
    //     on a live conversation.
    function DeleteSessionMenuItem(props) {
      var sessionId = props.sessionId;
      var displayTitle = props.displayTitle;
      var menuOpenState = props.useMenuOpenState ? props.useMenuOpenState() : null;
      var starred = useFavoriteState(sessionId);
      var pendingPair = React.useState(false);
      var pending = pendingPair[0];
      var setPending = pendingPair[1];

      // A favourite is never offered: the host would refuse it anyway, and an
      // action that is guaranteed to fail should not be shown.
      if (starred) return null;

      if (!pending) {
        return React.createElement(MenuRow, {
          danger: true,
          icon: "🗑",
          onSelect: function () { setPending(true); },
        }, "永久删除此对话…");
      }

      // Confirmation step. The prompt occupies its own non-interactive row so it
      // is not mistaken for an action, and the two choices are ordinary menu
      // rows — the same structure as every other row, which is what keeps them
      // visible and keyboard-reachable inside the list.
      return React.createElement(React.Fragment, null,
        React.createElement("div", {
          // `.label` in the official sheet: small grey, same horizontal padding
          // as a row, and NOT a button.
          className: "label",
          style: { padding: "6px 8px", fontSize: "11px", lineHeight: "15px", color: "var(--dsw-alias-label-tertiary, #9aa0a6)", whiteSpace: "normal" },
        }, "永久删除「" + (displayTitle || sessionId) + "」？"),
        React.createElement(MenuRow, {
          danger: true,
          icon: "⚠",
          onSelect: function () {
            api("/delete", { sessionIds: [sessionId] }).then(function (data) {
              var deleted = data && data.ok && Array.isArray(data.deleted)
                ? data.deleted.filter(function (id) { return idKey(id) === idKey(sessionId); })
                : [];
              if (deleted.length > 0) {
                toast("已永久删除此对话");
              } else {
                // Report whichever bucket actually holds the id. Reading only
                // `failures` made a plain "not found" skip show up as
                // "未知原因", which told the user nothing actionable.
                var why = "";
                if (data && Array.isArray(data.failures) && data.failures.length > 0) why = data.failures[0].reason || "";
                if (why === "" && data && Array.isArray(data.skipped) && data.skipped.length > 0) why = data.skipped[0].reason || "";
                if (why === "" && data && data.error) why = String(data.error);
                if (why === "" && data && data.ok === false) why = "宿主拒绝了该请求";
                // Translate the machine tokens the host reports, so each message
                // names the actual situation instead of a token.
                if (why === "not-found") why = "这条对话的转录文件已不存在（可能已被删除，或列表尚未刷新）";
                if (why === "favorited") why = "这是收藏的对话，收藏项不会被删除（请先取消收藏）";
                toast("未删除：" + (why || "未知原因"));
              }
              // Make the sidebar rebuild its rows. The session is gone from the
              // host, but the client keeps rendering the row it already holds
              // until something invalidates it — which is why a SUCCESSFUL
              // delete left the entry on screen.
              refreshSidebarRows();
              try { if (menuOpenState && menuOpenState[1]) menuOpenState[1](false); } catch (e) {}
            }).catch(function (error) {
              toast("删除请求失败：" + String(error && error.message ? error.message : error));
              try { if (menuOpenState && menuOpenState[1]) menuOpenState[1](false); } catch (e) {}
            });
          },
        }, "确认永久删除（不可恢复）"),
        React.createElement(MenuRow, {
          icon: "↩",
          onSelect: function () { setPending(false); },
        }, "取消"));
    }

    // =====================================================================
    // Favourites filter, injected into the OFFICIAL sidebar view-options menu.
    //
    // WHY DOM AND NOT A SLOT: the view-options menu
    // (`groupBy` / `orderBy` / `archivedFilter`) is rendered by
    // `@deepseek-ai/dsh-client-ui-workspace` from a HARDCODED `items` array with
    // no slot of any kind, and its trigger button carries no id. There is
    // therefore no supported extension point — the menu is closed to plugins.
    //
    // The harness's own guidance for this situation is "enhance the official UI
    // through DOM, keyed on stable semantics rather than CSS-module hashes",
    // which is what follows:
    //
    //   * rows are true `<button role="menuitem">` inside a `div[role="menu"]` —
    //     roles and aria attributes are stable across harness versions, while
    //     the generated class names (e.g. `_7VDZUG_item`) are re-hashed on every
    //     build and must never be matched;
    //   * we CLONE an existing row and swap its label rather than building a
    //     button from scratch, so the clone inherits the official markup and
    //     styling exactly, and a future restyle keeps working;
    //   * the trigger is found by matching the menu content ("仅显示已归档" /
    //     "Archived only") and walking up to the enclosing button — no id, no
    //     positional index that a new official row would shift.
    //
    // The filter itself is display-only: it hides rows via a scoped stylesheet
    // on this plugin's own document head. It never reorders, never removes and
    // never mutates a React-managed node's attributes, so React cannot be
    // desynchronised and the upstream UI keeps working with the plugin removed.
    // =====================================================================

    // TWO modes, one per archive state, named symmetrically:
    //
    //   archived   — 仅显示收藏（已归档）: favourited conversations that ARE archived
    //   unarchived — 仅显示收藏（未归档）: favourited conversations that are NOT archived
    //
    // The harness's own archived-visibility control filters by archive state for
    // ALL conversations; these narrow that to favourites only, which is what the
    // archive workflow needs.
    var FILTER_MODES = ["archived", "unarchived"]
    var favFilterMode = "off"
    /**
     * Whether the favourites set has been loaded at least once.
     *
     * The sidebar-hiding rule is gated on this: an empty `favSet` before the
     * first successful fetch would mark every row "not a favourite" and hide the
     * entire conversation list — the plugin appearing to break the sidebar.
     */
    var favoritesLoaded = false
    /**
     * Whether the archive set has been read at least once.
     *
     * The gate needs this for the same reason it needs `favoritesLoaded`: with
     * an empty archive cache every row looks unarchived, so the "archived" mode
     * would hide the whole list rather than show the archived favourites.
     */
    var archiveLoaded = false
    /** Cached archived ids, shared by the row scan and the filter modes. */
    var archivedCache = []

    /**
     * The session id behind a rendered row.
     *
     * `data-row-key` is `session:<id>`, where `<id>` is the API id WITHOUT its
     * `session-` prefix (measured against the live sidebar). Every id this
     * plugin sends to the host must therefore be re-prefixed, and every lookup
     * keyed by a host answer must use that same prefixed form.
     */
    function sessionIdOfRow(row) {
      var key = row.getAttribute("data-row-key") || "";
      var bare = key.slice("session:".length);
      if (bare.length === 0) return "";
      return bare.indexOf("session-") === 0 ? bare : "session-" + bare;
    }

    function filterStyleId() { return "dsh-aff-fav-filter-style"; }

    function ensureFilterStyle() {
      try {
        if (document.getElementById(filterStyleId())) return;
        var style = document.createElement("style");
        style.id = filterStyleId();
        // 🔴 ONE RULE, DOUBLE-GUARDED, AND IT CANNOT FIRE BEFORE THE PLUGIN KNOWS
        // WHAT A FAVOURITE IS.
        //
        // An earlier version hid every row lacking `data-dsh-aff-fav='1'` as soon
        // as the filter attribute was present. That let the plugin EMPTY the
        // sidebar: if the favourites list had not loaded (or was rejected), no
        // row carried the marker, so the `!important` rule hid the entire
        // conversation list — including newly created sessions and archived
        // ones, which the user correctly reported as "the plugin broke the
        // sidebar".
        //
        // The rule now requires BOTH:
        //   * the filter attribute, AND
        //   * `data-dsh-aff-ready='1'` on <html>, which `markRows` sets only
        //     after it has marked rows using a SUCCESSFULLY LOADED favourites
        //     set.
        //
        // Until then the selector matches nothing, so hiding is impossible
        // before the plugin can tell a favourite from a non-favourite.
        // TWO INDEPENDENT GATES, because the two axes fail independently.
        //
        //   data-dsh-aff-ready      — the favourites set is loaded. Without it
        //                             every row looks unfavourited, so hiding on
        //                             that basis would empty the sidebar.
        //   data-dsh-aff-archready  — the archive set is loaded. Without it every
        //                             row looks unarchived, so the "archived"
        //                             rule would hide the ENTIRE list.
        //
        // Keeping them separate means an archive-set failure costs only the
        // archive axis: the favourites narrowing still works, instead of the
        // whole filter silently doing nothing (which is exactly what a single
        // combined gate caused).
        style.textContent =
          "html[data-dsh-aff-ready='1'][data-dsh-aff-filter] " +
          "[data-row-key^='session:']:not([data-dsh-aff-fav='1']){display:none !important}" +
          // The archived mode hides rows that are not archived.
          "html[data-dsh-aff-archready='1'][data-dsh-aff-filter='archived'] " +
          "[data-row-key^='session:'][data-dsh-aff-arch='0']{display:none !important}" +
          // The unarchived mode hides rows that are archived.
          "html[data-dsh-aff-archready='1'][data-dsh-aff-filter='unarchived'] " +
          "[data-row-key^='session:'][data-dsh-aff-arch='1']{display:none !important}";
        document.head.appendChild(style);
      } catch (e) {}
    }

    function applyFilterMode(mode) {
      favFilterMode = FILTER_MODES.indexOf(mode) >= 0 ? mode : "off";
      try {
        ensureFilterStyle();
        if (favFilterMode === "off") document.documentElement.removeAttribute("data-dsh-aff-filter");
        else document.documentElement.setAttribute("data-dsh-aff-filter", favFilterMode);
      } catch (e) {}
      markRows();
      // Keep the open menu's tick truthful if it is still mounted.
      try {
        var openMenus = document.querySelectorAll("div[role='menu']");
        for (var i = 0; i < openMenus.length; i++) syncFilterChecks(openMenus[i]);
      } catch (e) {}
    }

    /**
     * Tag each rendered session row with the state the filter rule reads, and
     * open the filter's safety gate once that marking is trustworthy.
     *
     * Every write is value-guarded: an unconditional `setAttribute` on each scan
     * would keep mutating the DOM and retrigger our own MutationObserver.
     */
    function markRows() {
      try {
        if (!favoritesLoaded) {
          // Without a loaded favourites set EVERY row would be marked "not a
          // favourite", and the filter rule would then hide the whole sidebar.
          // The gate stays shut until the set is known.
          try { document.documentElement.removeAttribute("data-dsh-aff-ready"); } catch (e) {}
          return;
        }
        var rows = document.querySelectorAll("[data-row-key^='session:']");
        var marked = 0;
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var sessionId = sessionIdOfRow(row);
          if (sessionId.length === 0) continue;
          var want = isFavorite(sessionId) ? "1" : "0";
          if (row.getAttribute("data-dsh-aff-fav") !== want) {
            row.setAttribute("data-dsh-aff-fav", want);
          }
          // The archive state, so the archived / unarchived modes can act on it.
          // `archivedCache` is refreshed on load and after every archive
          // mutation; while it is unknown the marker stays "0", which only makes
          // the archived mode show nothing extra — the safe direction.
          var isArch = archivedHas(archivedCache, sessionId) ? "1" : "0";
          if (row.getAttribute("data-dsh-aff-arch") !== isArch) {
            row.setAttribute("data-dsh-aff-arch", isArch);
          }
          marked += 1;
        }
        // Open the gates. Each is independent, so a failure in one axis cannot
        // disable the other — see the rule comments above.
        try {
          if (marked > 0 && favoritesLoaded) {
            document.documentElement.setAttribute("data-dsh-aff-ready", "1");
          } else {
            document.documentElement.removeAttribute("data-dsh-aff-ready");
          }
          if (marked > 0 && archiveLoaded) {
            document.documentElement.setAttribute("data-dsh-aff-archready", "1");
          } else {
            document.documentElement.removeAttribute("data-dsh-aff-archready");
          }
        } catch (e) {}
      } catch (e) {}
    }

    /** Refresh the shared archived-id cache the row scan and modes read. */
    function refreshArchivedCache() {
      return api("/archived").then(function (data) {
        if (data && data.ok && Array.isArray(data.archivedSessionIds)) {
          archivedCache = data.archivedSessionIds;
          // Only a SUCCESSFUL read opens the archive side of the gate.
          archiveLoaded = true;
          diag("archived set: " + archivedCache.length + " ids (source=" + (data.source || "?") + ")");
          scheduleMark();
        }
        return archivedCache;
      }).catch(function () { return archivedCache; });
    }

    /**
     * True when this menu is the sidebar view-options menu.
     *
     * 🔴 THE MATCH MUST USE TEXT THAT IS *INSIDE* THE MENU. "视图选项"
     * ("View options") is the TRIGGER's tooltip and `aria-label`; it never
     * appears in the menu body. Matching on it made this function return false
     * for every menu, so nothing was ever injected — a silent no-op. The menu
     * body contains the group headings instead: 分组方式 / 排序方式 / 筛选会话.
     */
    function isViewOptionsMenu(menu) {
      try {
        var text = menu.textContent || "";
        return text.indexOf("筛选会话") >= 0 || text.indexOf("Filter sessions") >= 0 ||
               text.indexOf("排序方式") >= 0 || text.indexOf("Order by") >= 0 ||
               text.indexOf("分组方式") >= 0 || text.indexOf("Group by") >= 0;
      } catch (e) { return false; }
    }

    // The selection-check painting that used to live here was REMOVED.
    //
    // Three attempts all produced a mark the user could see was wrong: a raw "✓"
    // span on top of the check the cloned template already carried (two marks on
    // one row), a check that stayed lit on every row, and — worst — a structural
    // lookup that could mistake an official row's own seat for ours. A filter row
    // whose on/off state is ambiguous is a cosmetic problem; a plugin that
    // mutates the harness's own menu rows is not. The row's effect is visible in
    // the sidebar anyway, so no in-menu indicator ships.

    /**
     * Show the selection tick on whichever of OUR rows is active.
     *
     * Visibility only: the glyph itself is a clone of the harness's own, so its
     * size, colour and position are the harness's. Nothing here creates a mark,
     * so a row can never carry two, and the state can never invert — the two
     * failures the earlier implementations produced.
     *
     * Scoped to `[data-dsh-aff-mode]`, so an official row's own tick is never
     * touched.
     */
    function syncFilterChecks(menu) {
      try {
        var rows = menu.querySelectorAll("[data-dsh-aff-mode]");
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var btn = row.querySelector("button[role='menuitem']");
          if (btn === null) continue;
          var tick = btn.lastElementChild;
          if (tick === null || typeof tick.tagName !== "string" ||
              tick.tagName.toLowerCase() !== "svg") continue;
          var active = row.getAttribute("data-dsh-aff-mode") === favFilterMode;
          tick.style.display = active ? "" : "none";
          btn.setAttribute("aria-checked", active ? "true" : "false");
        }
      } catch (e) {}
    }

    /**
     * Inject the favourites-filter rows into the open view-options menu.
     * Idempotent: an already-injected menu is left untouched.
     */
    function injectFilterRows(menu) {
      try {
        if (!isViewOptionsMenu(menu)) return;
        // Idempotence: the rows are injected once per menu instance. An
        // already-injected menu still needs its tick refreshed, because the
        // active mode can have changed while it stayed mounted.
        if (menu.querySelector("[data-dsh-aff-mode]") !== null) {
          syncFilterChecks(menu);
          return;
        }

        // Find the archived-filter group: the "only archived" row's enclosing
        // wrapper. Cloning THAT row is what makes the clone look official.
        var buttons = menu.querySelectorAll("button[role='menuitem']");
        var template = null;
        for (var i = 0; i < buttons.length; i++) {
          var label = (buttons[i].textContent || "").trim();
          if (label === "仅显示已归档" || label === "Archived only") { template = buttons[i]; break; }
        }
        if (template === null) return;
        var templateWrap = template.parentElement;
        if (templateWrap === null) return;

        var group = templateWrap.parentElement;
        if (group === null) return;

        if (true) {
        // Two rows, matching the two archive states, so the names mean exactly
        // what each one shows.
        var labels = {
          archived: "仅显示收藏（已归档）",
          unarchived: "仅显示收藏（未归档）",
        };
        // A real tick glyph to clone: the LAST ELEMENT CHILD of whichever
        // official row is currently selected is its bare `<svg>` tick. Exactly
        // one row in the filter group is selected at all times, so this always
        // resolves while such a row exists.
        var tickSample = null;
        for (var tb = 0; tb < buttons.length; tb++) {
          var candidate = buttons[tb];
          if (candidate.closest("[data-dsh-aff-injected='1']") !== null) continue;
          var last = candidate.lastElementChild;
          if (last !== null && typeof last.tagName === "string" && last.tagName.toLowerCase() === "svg") {
            tickSample = last;
            break;
          }
        }
        var made = [];
        for (var m = 0; m < FILTER_MODES.length; m++) {
          var mode = FILTER_MODES[m];
          var clone = templateWrap.cloneNode(true);
          clone.setAttribute("data-dsh-aff-injected", "1");
          clone.setAttribute("data-dsh-aff-mode", mode);
          var btn = clone.querySelector("button[role='menuitem']");
          if (btn === null) continue;
          // Replace only the label span's text; the icon and layout stay
          // official, which is what keeps the row looking native. The label is
          // the text-bearing span that has no element children — the icon seat
          // and the check seat both contain elements, so neither is matched.
          var spans = btn.querySelectorAll("span");
          for (var s = 0; s < spans.length; s++) {
            var isLabelSeat = (spans[s].textContent || "").trim().length > 0 &&
                              spans[s].children.length === 0;
            if (isLabelSeat) {
              spans[s].textContent = labels[mode];
              break;
            }
          }
          // Selection tick, done by REUSING the harness's own glyph.
          //
          // The shipped renderer emits the tick only on the selected row:
          //
          //     selected && selection === "check" && jsx(IconCheckOutlineRegular, { className: check })
          //
          // and it is a BARE `<svg>` appearing as the button's LAST element
          // child (the icon is wrapped in a span, so it is never last). Three
          // earlier attempts failed because they either fabricated a "✓" span on
          // top of an inherited tick (two marks), or tested
          // `seat.querySelector("svg")` — which never matches, since an element
          // does not match its own selector — leaving a tick that tracked the
          // HARNESS's selection instead of ours.
          //
          // So: strip whatever the clone inherited, then append a CLONE OF THE
          // REAL OFFICIAL GLYPH taken from whichever row is currently selected.
          // One row always is (the filter group's selectedIds always names one),
          // so the sample is always available, and the mark inherits the exact
          // official size, colour and position. Visibility alone is ours to set.
          var seat = btn.lastElementChild;
          if (seat !== null && seat.parentElement !== null && typeof seat.tagName === "string" &&
              seat.tagName.toLowerCase() === "svg") {
            seat.parentElement.removeChild(seat);
          }
          if (tickSample !== null) {
            var myTick = tickSample.cloneNode(true);
            // Start hidden; `syncFilterChecks` reveals it for the active mode.
            myTick.style.display = "none";
            btn.appendChild(myTick);
          }
          made.push(clone);
        }
        for (var k = 0; k < made.length; k++) group.appendChild(made[k]);
        // Re-check AFTER the append. Two observers can be alive at once
        // (a hot reload leaves the previous instance's observer until its
        // disposer runs), and both may see the same empty menu before either
        // has written. Removing the duplicates we just created is cheaper and
        // more reliable than trying to make the check atomic.
        var filterClones = group.querySelectorAll("[data-dsh-aff-mode]");
        for (var f = FILTER_MODES.length; f < filterClones.length; f++) {
          if (filterClones[f].parentElement !== null) filterClones[f].parentElement.removeChild(filterClones[f]);
        }
        syncFilterChecks(menu);
        }

        // The turn-count sort rows that used to be injected here were removed
        // at the user's request: the harness's own view-options menu should
        // offer only the harness's own controls.
      } catch (e) {
        // Report, never swallow. A silent failure here is exactly how a broken
        // DOM call (`remove()` on a node the environment did not implement) made
        // the filter row vanish with no trace anywhere.
        diag("injectFilterRows failed: " + String(e && e.message ? e.message : e));
      }
    }

    /**
     * Handle a click on one of our injected rows.
     *
     * Bound at the DOCUMENT in the capture phase and resolved from
     * `event.target` — never from a node reference. The menu is React-managed
     * and is rebuilt on every open, so a listener attached to the row itself
     * would be left behind on a discarded node and silently never fire.
     */
    function onFilterClickCapture(event) {
      try {
        var target = event.target;
        if (!target || typeof target.closest !== "function") return;

        var row = target.closest("[data-dsh-aff-injected='1']");
        if (row === null) return;
        var mode = row.getAttribute("data-dsh-aff-mode") || "off";
        event.stopPropagation();
        event.preventDefault();

        // Toggle: choosing the active mode again turns it off.
        var next = favFilterMode === mode ? "off" : mode;
        var menu = row.closest("div[role='menu']");

        // 🔴 THE ARCHIVE AXIS BELONGS TO THE HARNESS. DELEGATE IT.
        //
        // A row that the official filter has excluded is NOT RENDERED AT ALL, so
        // no CSS of ours can bring it back. "Favourites that are archived" was
        // therefore empty whenever the harness was hiding archived rows — the
        // "显示批次不对" report.
        //
        // The official filter has no plugin-facing setter (`setArchivedFilter`
        // lives on a store instance the workspace plugin owns privately), but it
        // IS reachable the way the user reaches it: the menu row. So we click
        // that row in the SAME open menu, which runs the official handler and
        // updates the official store, and only then narrow to favourites with
        // our own rule.
        //
        // Effect: the archive axis is exactly the harness's own, and the only
        // thing this plugin adds is the favourites axis.
        if (menu !== null) {
          var officialLabels = next === "archived"
            ? ["仅显示已归档", "Archived only"]        // archived rows rendered
            : ["隐藏已归档", "Hide archived"];         // archived rows excluded (default)
          var officialBtn = findOfficialRow(menu, officialLabels);
          if (officialBtn !== null) {
            // `.click()` dispatches a bubbling MouseEvent, which reaches React's
            // listener (installed on the portal container for a portalled menu)
            // and runs the harness's own onSelect. That is the whole point: the
            // official store updates through the normal path.
            try { officialBtn.click(); } catch (e) {
              diag("official filter click failed: " + String(e && e.message ? e.message : e));
            }
            diag("delegated archive axis to the harness: " + officialLabels[0]);
          } else {
            // Without the harness's own row we cannot make it render the rows
            // this mode needs, so say so rather than showing an empty list and
            // letting the user guess why.
            diag("harness filter row not found for " + officialLabels[0] + " — mode will be incomplete");
          }
        }

        applyFilterMode(next);

        // Re-mark on a short ladder. Switching the harness filter rebuilds the
        // row set, and the new nodes carry no favourite marker until a scan runs
        // — during which the hiding rule would match every one of them. The
        // observer is the primary trigger; this ladder is the guarantee, so the
        // list cannot be left blank if a re-render reuses nodes instead of
        // replacing them.
        try {
          setTimeout(markRows, 0);
          setTimeout(markRows, 80);
          setTimeout(markRows, 240);
        } catch (e) {}
        closeMenuOf(row);
        markRows();
      } catch (e) {}
    }

    /**
     * The harness's own row carrying any of these labels, never one of ours.
     *
     * Several labels are accepted because the menu is localised: matching only
     * the Chinese strings would silently do nothing on an English build, and a
     * silent no-op is indistinguishable from a broken feature.
     */
    function findOfficialRow(menu, labels) {
      try {
        var wanted = Array.isArray(labels) ? labels : [labels];
        var buttons = menu.querySelectorAll("button[role='menuitem']");
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          if (btn.closest("[data-dsh-aff-injected='1']") !== null) continue;   // ours
          var text = (btn.textContent || "").trim();
          for (var w = 0; w < wanted.length; w++) {
            if (text === wanted[w]) return btn;
          }
        }
      } catch (e) {}
      return null;
    }

    /**
     * Nudge the sidebar into rebuilding its session rows.
     *
     * The host knows the conversation is gone, but this client holds the list it
     * last received and keeps rendering the deleted row — which is why a
     * successful delete left the entry visible. React re-reads its store when an
     * observed layout value changes, so a resize event plus a bounded retry is
     * the least invasive way to force that rebuild without touching the official
     * component or its store.
     */
    function refreshSidebarRows() {
      var attempts = 0;
      function poke() {
        attempts += 1;
        try { window.dispatchEvent(new Event("resize")); } catch (e) {}
        // A row that disappeared on its own means the store caught up; stop.
        if (attempts >= 6) return;
        setTimeout(function () {
          var stillThere = document.querySelectorAll("[data-row-key^='session:']").length;
          if (stillThere === lastRowCount && attempts < 6) poke();
        }, 220);
      }
      lastRowCount = document.querySelectorAll("[data-row-key^='session:']").length;
      poke();
    }

    var lastRowCount = 0;

    /** Dismiss the open menu by asking it the way the host does (Escape). */
    function closeMenuOf(node) {      try {
        var menu = node.closest("div[role='menu']");
        var opts = { bubbles: true, cancelable: true, key: "Escape" };
        if (menu !== null) menu.dispatchEvent(new KeyboardEvent("keydown", opts));
        document.dispatchEvent(new KeyboardEvent("keydown", opts));
      } catch (e) {}
    }

    // Declared as function declarations (hoisted) because `setFavorites` can
    // run before this point in the factory — a favourites fetch may resolve
    // while the module body is still evaluating. A `var` + function-expression
    // form would leave `markScheduled` undefined at that moment and swallow the
    // first mark.
    var filterObserver = null
    var markScheduled = false

    function scheduleMark() {
      if (markScheduled) return
      markScheduled = true
      try {
        setTimeout(function () {
          markScheduled = false
          markRows()
        }, 60)
      } catch (e) {
        markScheduled = false
      }
    }

    function startFilterEnhancer() {
      try {
        ensureFilterStyle();
        document.addEventListener("click", onFilterClickCapture, true);
        if (typeof MutationObserver === "undefined") return;
        filterObserver = new MutationObserver(function (records) {
          // Cheap gate: only look at the document when something actually
          // changed, and only ever inject into an OPEN menu.
          for (var i = 0; i < records.length; i++) {
            var added = records[i].addedNodes;
            for (var j = 0; j < added.length; j++) {
              var node = added[j];
              if (node.nodeType !== 1) continue;
              if (node.matches && node.matches("div[role='menu']")) injectFilterRows(node);
              else if (node.querySelectorAll) {
                var menus = node.querySelectorAll("div[role='menu']");
                for (var k = 0; k < menus.length; k++) injectFilterRows(menus[k]);
              }
            }
          }
          scheduleMark();
        });
        filterObserver.observe(document.body, { childList: true, subtree: true });
        markRows();
      } catch (e) {}
    }

    function stopFilterEnhancer() {
      try {
        document.removeEventListener("click", onFilterClickCapture, true);
        if (filterObserver !== null) { filterObserver.disconnect(); filterObserver = null; }
        document.documentElement.removeAttribute("data-dsh-aff-filter");
      } catch (e) {}
    }

    // =====================================================================
    // 3. Settings section: favourites + batch delete
    // =====================================================================

    var SECTION_STYLE = {
      display: "flex", flexDirection: "column", gap: "12px",
      padding: "4px 0", fontSize: "13px",
    };
    var CARD_STYLE = {
      border: "0.5px solid var(--dsw-alias-border-l4, rgba(255,255,255,.14))",
      borderRadius: "10px", padding: "12px", display: "flex",
      flexDirection: "column", gap: "8px",
    };
    var BTN_STYLE = {
      padding: "5px 12px", borderRadius: "7px", cursor: "pointer",
      fontSize: "13px", lineHeight: "18px",
      border: "0.5px solid var(--dsw-alias-border-l4, rgba(255,255,255,.18))",
      background: "var(--dsw-alias-button-elevated-fill, rgba(255,255,255,.06))",
      color: "var(--dsw-alias-label-primary, inherit)",
    };
    var DANGER_STYLE = Object.assign({}, BTN_STYLE, {
      color: "var(--dsw-alias-state-error-primary, #ff6b6b)",
      borderColor: "var(--dsw-alias-state-error-primary, #ff6b6b)",
    });

    function useFavoriteTick() {
      var pair = React.useState(0);
      var bump = pair[1];
      React.useEffect(function () {
        var listener = function () { bump(function (n) { return n + 1; }); };
        favListeners.push(listener);
        return function () {
          var at = favListeners.indexOf(listener);
          if (at >= 0) favListeners.splice(at, 1);
        };
      }, []);
      return pair[0];
    }

    function ArchiveFavoritesSection() {
      useFavoriteTick();
      var archivedPair = React.useState(null);
      var archived = archivedPair[0];
      var setArchived = archivedPair[1];
      var busyPair = React.useState("");
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var confirmPair = React.useState(false);
      var confirming = confirmPair[0];
      var setConfirming = confirmPair[1];
      var resultPair = React.useState(null);
      var result = resultPair[0];
      var setResult = resultPair[1];

      // --- idle auto-archive ("超时归档") state ---
      // The threshold persists in localStorage so it survives a restart, but the
      // AUTHORITATIVE count always comes from the host, which reads the real
      // activity times. A stale local number would let the user archive the
      // wrong set.
      //
      // The unit is HOURS. Day-granularity could not express "quiet since this
      // morning", and its fractional values rendered badly — "0.5" came out as
      // "0" because the old code rounded for display.
      var hoursPair = React.useState(function () {
        try {
          var saved = parseFloat(localStorage.getItem("dsh-aff-idle-hours"));
          if (Number.isFinite(saved) && saved > 0) return saved;
          // Migrate the old day-based value if it is there, so a user who set
          // "1 day" does not silently drop to the default.
          var legacyDays = parseFloat(localStorage.getItem("dsh-aff-idle-days"));
          if (Number.isFinite(legacyDays) && legacyDays > 0) return Math.round(legacyDays * 24);
          return 24;
        } catch (e) { return 24; }
      });
      var idleHours = hoursPair[0];
      var setIdleHours = hoursPair[1];
      var hoursTextPair = React.useState(function () { return String(idleHours); });
      var hoursText = hoursTextPair[0];
      var setHoursText = hoursTextPair[1];
      var previewPair = React.useState(null);
      var preview = previewPair[0];
      var setPreview = previewPair[1];
      var idleResultPair = React.useState(null);
      var idleResult = idleResultPair[0];
      var setIdleResult = idleResultPair[1];
      var undoPair = React.useState(null);
      var undoList = undoPair[0];
      var setUndoList = undoPair[1];
      // The last export: its path stays on screen so the follow-ups (copy the
      // path, open the folder) remain available after the toast has gone.
      var exportPair = React.useState(null);
      var exportInfo = exportPair[0];
      var setExportInfo = exportPair[1];
      // Where the archived set came from. Surfaced in the UI because a
      // "registry" answer and a "file" answer can differ by dozens of stale
      // entries, and a wrong candidate count is otherwise unexplainable.
      var archiveSourcePair = React.useState("");
      var archiveSource = archiveSourcePair[0];
      var setArchiveSource = archiveSourcePair[1];

      /**
       * Read the archive set, retrying while the registry is still starting.
       *
       * `workspaceRegistry.archivedSessionIds` throws "not started yet" until the
       * service's async init() has opened its storage domain. That is a normal
       * boot state, not a failure, so a poll that sees it must come back rather
       * than conclude the feature is broken — which is what left the settings
       * card stuck on "归档来源：读取中…" indefinitely.
       */
      var archiveRetry = null;
      var archiveAttempts = 0;
      function loadArchived() {
        if (archiveRetry !== null) { clearTimeout(archiveRetry); archiveRetry = null; }
        return api("/archived").then(function (data) {
          if (data && data.ok && Array.isArray(data.archivedSessionIds)) {
            archiveAttempts = 0;
            setArchived(data.archivedSessionIds);
            archivedCache = data.archivedSessionIds;
            archiveLoaded = true;
            setArchiveSource(String(data.source || "") + (typeof data.count === "number" ? ":" + data.count : ""));
            scheduleMark();
            return;
          }
          var source = data && data.source ? String(data.source) : "unavailable";
          var reason = data && data.reason ? String(data.reason) : "";
          if (source === "starting" && archiveAttempts < 20) {
            archiveAttempts += 1;
            setArchiveSource("starting");
            archiveRetry = setTimeout(function () { archiveRetry = null; loadArchived(); }, 500);
            return;
          }
          // Unavailable is NOT empty. Rendering "0 archived" would claim every
          // conversation is live, which is the opposite of the truth — and it is
          // how a candidate list once grew larger than the conversation count.
          setArchived(null);
          archivedCache = [];
          setArchiveSource(source + (reason ? " | " + reason : ""));
        }).catch(function (error) {
          setArchived(null);
          archivedCache = [];
          setArchiveSource("request-failed | " + String(error && error.message ? error.message : error));
        });
      }

      function loadPreview(hours) {
        return api("/idle-archive?hours=" + encodeURIComponent(String(hours))).then(function (data) {
          setPreview(data && data.ok ? data : null);
        }).catch(function () { setPreview(null); });
      }

      /**
       * Export the current idle candidates to a text file and report where.
       *
       * The full list is fetched fresh rather than reused from the preview,
       * because the preview payload caps its sample — exporting a truncated
       * list would defeat the point of having one to verify the count.
       *
       * The rows carry each conversation's NAME and how long it has been idle,
       * so the file can be read and checked by a person. The result is kept in
       * state rather than only toasted, because the useful follow-ups — copy
       * the path, open the folder — need the path to still be on screen.
       */
      function exportIdleList(hours) {
        setExportInfo(null);
        api("/idle-archive?hours=" + encodeURIComponent(String(hours))).then(function (data) {
          var entries = data && data.ok && Array.isArray(data.all) ? data.all : [];
          if (entries.length === 0 && data && Array.isArray(data.sample)) entries = data.sample;
          return api("/export-list", {
            label: "idle-" + hours + "h",
            title: "闲置超过 " + hours + " 小时的未归档对话",
            entries: entries,
          });
        }).then(function (res) {
          if (res && res.ok && res.path) {
            setExportInfo({ path: res.path, count: res.count });
            toast("已导出 " + res.count + " 条到：" + res.path);
          } else {
            setExportInfo({ error: (res && res.error) || "未知原因" });
            toast("导出失败：" + ((res && res.error) || "未知原因"));
          }
        }).catch(function (error) {
          var message = String(error && error.message ? error.message : error);
          setExportInfo({ error: message });
          toast("导出失败：" + message);
        });
      }

      /** Ask the host to reveal an exported file in the OS file manager. */
      function revealExport(path) {
        api("/reveal", { path: path }).then(function (res) {
          if (!res || !res.ok) toast("打开文件夹失败：" + ((res && res.error) || "未知原因"));
        }).catch(function (error) {
          toast("打开文件夹失败：" + String(error && error.message ? error.message : error));
        });
      }

      /**
       * Turn a "${days-ago}" timestamp into a short human age.
       *
       * Present so the preview can show WHAT it is about to act on. Rounding is
       * deliberately coarse: 90 minutes reads "1 小时前", not "1.5".
       */
      function ageLabel(updatedAt) {
        if (typeof updatedAt !== "number" || !isFinite(updatedAt)) return "";
        var ms = Date.now() - updatedAt;
        if (ms < 0) return "刚刚";
        var mins = Math.floor(ms / 60000);
        if (mins < 60) return mins + " 分钟前";
        var hours = Math.floor(mins / 60);
        if (hours < 48) return hours + " 小时前";
        return Math.floor(hours / 24) + " 天前";
      }

      // Read the archived set from the same file the running app uses, via the
      // host half. Cheap, and correct even while the app holds the registry in
      // memory, because archiving is persisted as it happens.
      React.useEffect(function () {
        refreshFavorites();
        var alive = true;
        api("/archived").then(function (data) {
          if (!alive) return;
          setArchived(data && data.ok && Array.isArray(data.archivedSessionIds) ? data.archivedSessionIds : []);
        }).catch(function () {
          if (alive) setArchived([]);
        });
        // Prime the idle preview so the control reads as live on first paint.
        api("/idle-archive?hours=" + encodeURIComponent(String(idleHours))).then(function (data) {
          if (alive) setPreview(data && data.ok ? data : null);
        }).catch(function () {});
        return function () { alive = false; };
      }, []);

      var favorites = favoriteIds();
      // `null` means the live archive set could not be read. It is NOT the same
      // as empty: with an unknown set we cannot say which conversations are
      // archived, so every count and every bulk action below is suppressed
      // rather than computed from a guess.
      //
      // `"starting"` is deliberately kept OUT of this flag: the registry is
      // still booting, the client is retrying, and showing the loud warning for
      // a state that resolves itself in a second would be noise.
      var archiveUnavailable = archived === null && archiveSource !== "starting"
      var archivedIds = Array.isArray(archived) ? archived : [];
      var archivedFavorites = archivedIds.filter(isFavorite);
      // The deletion candidates: archived AND not favourited. Favourites are
      // stripped twice — here for display, and again host-side as a guard.
      var candidates = archiveUnavailable ? [] : archivedIds.filter(function (id) { return !isFavorite(id); });

      function runDelete() {
        setBusy("delete");
        resultPair[1](null);
        api("/delete", { sessionIds: candidates }).then(function (data) {
          setBusy("");
          setConfirming(false);
          setResult(data);
          // Re-read both sets: the registry no longer lists what we removed.
          return Promise.all([
            refreshFavorites(),
            api("/archived").then(function (next) {
              setArchived(next && next.ok && Array.isArray(next.archivedSessionIds) ? next.archivedSessionIds : []);
            }).catch(function () {}),
          ]);
        }).catch(function (error) {
          setBusy("");
          setConfirming(false);
          setResult({ error: String(error && error.message ? error.message : error) });
        });
      }

      var children = [];

      children.push(React.createElement("div", { key: "head", style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" } },
        React.createElement("div", { style: { fontWeight: "600" } }, "归档收藏与管理"),
        React.createElement("div", { style: { display: "flex", gap: "8px" } },
          React.createElement("button", {
            type: "button", style: BTN_STYLE,
            onClick: function () {
              refreshFavorites();
              loadArchived();
            },
          }, "刷新"))));

      // -- idle auto-archive: the heavyweight control lives HERE, not in the
      // per-row menu, because it acts on the whole archive at once and needs a
      // threshold plus a live preview that a menu row cannot carry.
      var idleCount = preview && typeof preview.idleCount === "number" ? preview.idleCount : null;
      var canUndo = Array.isArray(undoList) && undoList.length > 0;
      // Preview sample rows, so the user can SEE what a threshold selects before
      // committing — the count alone is not enough to trust a bulk archive.
      var idleSample = preview && Array.isArray(preview.sample) ? preview.sample : [];
      children.push(React.createElement("div", { key: "idle", style: CARD_STYLE },
        React.createElement("div", { style: { fontWeight: "600" } }, "超时批量归档"),
        // One line of explanation. The previous wording repeated what the
        // controls already say and read as a wall of text.
        React.createElement("div", { style: { opacity: .72, fontSize: "12px", lineHeight: "17px" } },
          "把闲置超过阈值的未归档对话收进归档区；随时可撤回。"),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          React.createElement("span", { style: { fontSize: "12px" } }, "闲置超过"),
          React.createElement("input", {
            type: "text",
            inputMode: "decimal",
            value: hoursText,
            "aria-label": "闲置小时数阈值",
            style: Object.assign({}, BTN_STYLE, { width: "72px", padding: "4px 8px", cursor: "text" }),
            onChange: function (event) {
              // The raw string is kept in the box so a half-typed "1." or an
              // empty field does not fight the user. Only a complete, positive
              // number becomes the threshold — a zero or negative one would
              // select EVERY session and archive the whole list.
              var raw = event.target.value;
              setHoursText(raw);
              var parsed = parseFloat(raw);
              if (Number.isFinite(parsed) && parsed > 0) {
                setIdleHours(parsed);
                try {
                  localStorage.setItem("dsh-aff-idle-hours", String(parsed));
                  localStorage.removeItem("dsh-aff-idle-days");
                } catch (e) {}
                loadPreview(parsed);
              } else {
                // Keep the preview truthful while the input is invalid.
                setPreview(null);
              }
            },
          }),
          React.createElement("span", { style: { fontSize: "12px" } }, "小时"),
          React.createElement("span", { style: { opacity: .5, fontSize: "11px" } },
            "≈ " + (Math.round(idleHours / 24 * 10) / 10) + " 天"),
          React.createElement("span", { style: { opacity: .85, fontSize: "12px", marginInlineStart: "4px" } },
            idleCount === null ? "（输入大于 0 的小时数）"
              : idleCount > 0 ? "→ " + idleCount + " 个候选"
              : "→ 无候选")),
        React.createElement("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
          React.createElement("button", {
            type: "button",
            style: BTN_STYLE,
            disabled: busy !== "" || idleCount === null || idleCount === 0,
            onClick: function () {
              setBusy("idle");
              setIdleResult(null);
              api("/idle-archive", { hours: idleHours }).then(function (data) {
                setBusy("");
                setIdleResult(data);
                setUndoList(data && data.ok && Array.isArray(data.archived) ? data.archived : null);
                return Promise.all([loadArchived(), loadPreview(idleHours)]);
              }).catch(function (error) {
                setBusy("");
                setIdleResult({ ok: false, error: String(error && error.message ? error.message : error) });
              });
            },
          }, busy === "idle" ? "正在归档…" : (idleCount === null ? "归档闲置会话" : "归档 " + idleCount + " 个")),
          // A downloadable list replaces the inline preview rows. The list can
          // be hundreds of rows, which does not belong in a settings card, and a
          // file can be searched and pasted into a spreadsheet — which is what
          // "check the list" actually needs.
          React.createElement("button", {
            type: "button",
            style: BTN_STYLE,
            disabled: idleCount === null || idleCount === 0,
            onClick: function () { exportIdleList(idleHours); },
          }, "导出清单"),
          canUndo
            ? React.createElement("button", {
                type: "button",
                style: BTN_STYLE,
                disabled: busy !== "",
                onClick: function () {
                  setBusy("undo");
                  api("/unarchive", { sessionIds: undoList }).then(function (data) {
                    setBusy("");
                    setIdleResult(data && data.ok
                      ? { ok: true, archived: [], restored: data.restored, undoOf: undoList.length }
                      : { ok: false, error: "撤回失败" });
                    setUndoList(null);
                    return Promise.all([loadArchived(), loadPreview(idleHours)]);
                  }).catch(function (error) {
                    setBusy("");
                    setIdleResult({ ok: false, error: String(error && error.message ? error.message : error) });
                  });
                },
              }, busy === "undo" ? "正在撤回…" : "撤回上一步（" + undoList.length + "）")
            : null),
        idleResult
          ? React.createElement("div", { style: { padding: "8px", borderRadius: "8px", background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))", lineHeight: "20px" } },
              idleResult.ok === false
                ? "操作失败：" + idleResult.error
                : (Array.isArray(idleResult.restored)
                    ? "已撤回 " + idleResult.restored.length + " 个会话的归档状态。"
                    : "已归档 " + ((idleResult.archived || []).length) + " 个会话。"),
              (idleResult.failed && idleResult.failed.length)
                ? React.createElement("div", { style: { marginTop: "4px", opacity: .75, fontSize: "12px" } },
                    "跳过 " + idleResult.failed.length + " 个（可能仍有进行中的工作）；首个原因：" + idleResult.failed[0].reason)
                : null)
          : null,
        // The export result lives INSIDE this card, right under the button that
        // produces it. A separate card meant the path appeared somewhere else on
        // the page from the control that created it.
        exportInfo === null
          ? null
          : exportInfo.error
            ? React.createElement("div", { style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #ff6b6b)" } },
                "上次导出失败：" + exportInfo.error)
            : React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
                React.createElement("div", { style: { fontSize: "11px", opacity: .7, wordBreak: "break-all", lineHeight: "15px" } },
                  "已导出 " + exportInfo.count + " 条：" + exportInfo.path),
                React.createElement("div", { style: { display: "flex", gap: "6px" } },
                  React.createElement("button", {
                    type: "button",
                    style: Object.assign({}, BTN_STYLE, { padding: "3px 10px", fontSize: "12px" }),
                    onClick: function () {
                      copyText(exportInfo.path).then(function (ok) {
                        toast(ok ? "已复制导出文件路径" : "复制失败，请手动选择：" + exportInfo.path);
                      });
                    },
                  }, "复制路径"),
                  React.createElement("button", {
                    type: "button",
                    style: Object.assign({}, BTN_STYLE, { padding: "3px 10px", fontSize: "12px" }),
                    onClick: function () { revealExport(exportInfo.path); },
                  }, "在文件夹中打开")))));

      // -- favourites list --
      children.push(React.createElement("div", { key: "fav", style: CARD_STYLE },
        React.createElement("div", { style: { fontWeight: "600" } }, "收藏的对话（" + favorites.length + "）"),
        favorites.length === 0
          ? React.createElement("div", { style: { opacity: .65 } },
              "还没有收藏。把鼠标移到侧栏任意对话上点 ☆，或用对话右侧的「…」菜单选「收藏对话」。")
          : React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "260px", overflowY: "auto" } },
              favorites.map(function (id) {
                var entry = favSet[id] || {};
                var inArchive = archivedHas(archivedIds, id);
                return React.createElement("div", {
                  key: id,
                  style: { display: "flex", alignItems: "center", gap: "8px", padding: "4px 6px", borderRadius: "6px" },
                },
                  React.createElement("span", { style: { flex: "1", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
                    (entry.title && String(entry.title).trim()) ? entry.title : id),
                  React.createElement("span", {
                    style: { flex: "none", fontSize: "11px", opacity: .6 },
                  }, inArchive ? "已归档" : "未归档"),
                  React.createElement("button", {
                    type: "button",
                    title: "复制 ID",
                    style: Object.assign({}, BTN_STYLE, { padding: "2px 8px", fontSize: "11px" }),
                    onClick: function () { copyId(id); },
                  }, "ID"),
                  React.createElement("button", {
                    type: "button",
                    title: "复制文件绝对路径",
                    style: Object.assign({}, BTN_STYLE, { padding: "2px 8px", fontSize: "11px" }),
                    onClick: function () { copyPath(id); },
                  }, "路径"),
                  React.createElement("button", {
                    type: "button",
                    title: "取消收藏",
                    style: Object.assign({}, BTN_STYLE, { padding: "2px 8px", fontSize: "11px" }),
                    onClick: function () { toggleFavorite(id, entry.title || ""); },
                  }, "取消收藏"));
              }))));

      // The standalone "导出清单" card was removed: the export button and its
      // result now live together inside the 超时批量归档 card, so the path
      // appears directly beneath the control that produced it.

      // -- batch delete of unfavourited archived chats --
      children.push(React.createElement("div", { key: "del", style: CARD_STYLE },
        React.createElement("div", { style: { fontWeight: "600" } }, "批量删除归档中「未收藏」的对话"),
        archiveUnavailable
          ? React.createElement("div", { style: { lineHeight: "20px", color: "var(--dsw-alias-state-warning-primary, #ffb454)" } },
              "⚠ 读取不到官方的归档列表（workspaceRegistry 不可用），因此无法确定哪些对话已归档。为避免误删，这里不显示统计也不提供删除。")
          : archived === null
            ? React.createElement("div", { style: { opacity: .65 } }, "正在读取归档列表…")
            : React.createElement("div", { style: { opacity: .8, lineHeight: "20px" } },
                "归档共 " + archivedIds.length + " 条：其中已收藏 " + archivedFavorites.length + " 条（保留），未收藏 " + candidates.length + " 条（可删除）。"),
        // Where the number came from. Only the live registry is trusted now, so
        // this is either "registry:N" or a specific reason it could not be read.
        //
        // 🔴 NEVER SAY "读取中…" WHILE A COUNT IS ALREADY ON SCREEN.
        //
        // The count and this line come from the SAME response, so a visible
        // count proves the read already succeeded. Rendering "读取中…" beside it
        // (which the empty initial state does on the first paint, and again after
        // any refresh that resets it) contradicts the number right above it — the
        // user reasonably reads that contradiction as a stuck spinner.
        // When the source is unknown but a list is present, say so plainly.
        React.createElement("div", { style: { fontSize: "11px", opacity: .6, lineHeight: "16px" } },
          "归档来源：" + (archiveSource === ""
            ? (archived === null ? "读取中…" : "官方实时注册表")
            : archiveSource === "starting" ? "等待注册表启动…"
            : archiveSource === "unavailable" ? "不可用（workspaceRegistry 未就绪）"
            : archiveSource.indexOf("registry") === 0 ? archiveSource + "（官方实时注册表）"
            : "不可用：" + archiveSource)),
        !archiveUnavailable && archived !== null && candidates.length > 0 && !confirming
          ? React.createElement("div", null,
              React.createElement("button", {
                type: "button", style: DANGER_STYLE,
                disabled: busy !== "",
                onClick: function () { setConfirming(true); setResult(null); },
              }, busy === "delete" ? "正在删除…" : "删除这 " + candidates.length + " 条未收藏对话"))
          : null,
        confirming
          ? React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "8px", borderRadius: "8px", background: "var(--dsw-alias-bg-warning, rgba(255,107,107,.1))" } },
              React.createElement("div", { style: { lineHeight: "20px" } },
                "将永久删除 " + candidates.length + " 条已归档、未收藏的对话（连同其转录文件）。此操作不可撤销；已收藏的 " + archivedFavorites.length + " 条会被保留。"),
              React.createElement("div", { style: { display: "flex", gap: "8px" } },
                React.createElement("button", {
                  type: "button", style: DANGER_STYLE, disabled: busy !== "",
                  onClick: runDelete,
                }, busy === "delete" ? "正在删除…" : "确认删除"),
                React.createElement("button", {
                  type: "button", style: BTN_STYLE, disabled: busy !== "",
                  onClick: function () { setConfirming(false); },
                }, "取消")))
          : null,
        archived !== null && candidates.length === 0
          ? React.createElement("div", { style: { opacity: .65 } }, "没有可删除的条目——归档区里剩下的都是收藏。")
          : null,
        result
          ? React.createElement("div", { style: { padding: "8px", borderRadius: "8px", background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))", lineHeight: "20px" } },
              result.error
                ? "删除失败：" + result.error
                : "已删除 " + ((result.deleted || []).length) + " 条；跳过 " + ((result.skipped || []).length) + " 条；失败 " + ((result.failures || []).length) + " 条。",
              (result.failures && result.failures.length)
                ? React.createElement("div", { style: { marginTop: "4px", opacity: .75, fontSize: "12px" } },
                    result.failures.slice(0, 5).map(function (f) { return f.sessionId + "：" + f.reason; }).join("；"))
                : null)
          : null));

      return React.createElement("div", { style: SECTION_STYLE }, children);
    }

    // =====================================================================
    // Entry
    // =====================================================================

    // Must be a plain array: the cordis loader reads `exports.inject` to decide
    // which client services reach `ctx`; a function form was verified not to work.
    exports.inject = ["slots"];

    exports.apply = function (ctx) {
      if (typeof document === "undefined") return;

      // Prime the favourites cache as early as possible so the first render of
      // a session row already knows whether it is starred. Row marking depends
      // on this, so re-mark once the fetch lands.
      refreshFavorites().then(function () { scheduleMark(); }).catch(function () {});

      // 🔴 PRIME THE ARCHIVE SET HERE TOO — NOT ONLY WHEN THE SETTINGS PAGE OPENS.
      //
      // `archiveLoaded` opens one half of the sidebar-hiding gate, and it used to
      // be set only inside the settings section's own loader. Unless the user had
      // visited that page, the gate stayed shut, so the favourites rule never
      // applied and the sidebar filter looked like it only delegated the archive
      // axis — which reads as "仅显示收藏（未归档）shows every unarchived
      // conversation", including the ones that are not favourites.
      //
      // Priming at mount makes the gate independent of whether any UI was opened.
      refreshArchivedCache().then(function () { scheduleMark(); }).catch(function () {});

      // Idempotent teardown: a hot reload re-runs apply() and a leftover
      // observer or capture listener from the previous instance would double
      // every injection and keep marking rows after unmount.
      stopFilterEnhancer();
      startFilterEnhancer();

      try {
        if (ctx && ctx.slots) {
          diag("apply: slots service present, registering");
          // Report which slots are already owned, so a missing row can be told
          // apart from a late-owning sidebar.
          try {
            var owned = [];
            var names = [
              "sidebar.workspaces.session.menu.item",
              "sidebar.workspaces.session.row.action",
              "sidebar.workspaces",
              "settings.section",
            ];
            for (var n = 0; n < names.length; n++) {
              var entries = ctx.slots.entries ? ctx.slots.entries(names[n]) : null;
              owned.push(names[n] + "=" + (entries ? entries.length : "?"));
            }
            diag("apply: slot occupancy " + owned.join(" "));
          } catch (e2) { diag("apply: occupancy probe failed " + e2); }

          // Session "..." menu rows. Orders sit between the shipped rows
          // (pin 100, rename 200, fork 300, archive 400) so the additions read
          // as a coherent group instead of landing after everything.
          ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
            diag("menu.item owner mounted: registering rows");
            return ctx.slots.register({
              name: "sidebar.workspaces.session.menu.item",
              id: "aff-favorite",
              order: 500,
            }, FavoriteMenuItem);
          });
          ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
            return ctx.slots.register({
              name: "sidebar.workspaces.session.menu.item",
              id: "aff-copy-both",
              order: 510,
            }, CopyBothMenuItem);
          });

          // Permanent delete for one conversation. Ordered last so it sits away
          // from the everyday actions; it hides itself for a favourited session,
          // which the host would refuse anyway.
          ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
            return ctx.slots.register({
              name: "sidebar.workspaces.session.menu.item",
              id: "aff-delete",
              order: 900,
            }, DeleteSessionMenuItem);
          });

          // Inline hover star. Order 300 puts it after the shipped archive
          // (100) and pin (200) buttons.
          ctx.slots.inject("sidebar.workspaces.session.row.action", function () {
            return ctx.slots.register({
              name: "sidebar.workspaces.session.row.action",
              id: "aff-favorite",
              order: 300,
            }, FavoriteRowButton);
          });

          // Settings page: favourites list + batch delete of unfavourited
          // archived chats.
          ctx.slots.inject("settings.section", function () {
            diag("settings.section owner mounted: registering page");
            return ctx.slots.register({
              name: "settings.section",
              id: "archive-favorites",
              order: 24,
              label: function () { return "归档收藏"; },
            }, ArchiveFavoritesSection);
          });
        } else {
          diag("apply: ctx.slots MISSING - no client half can register");
        }
      } catch (e) {
        // Report through the whitelisted channel too: the bare `console.warn`
        // below is dropped by the host, which is how a registration failure
        // stays invisible.
        diag("apply: registration threw: " + (e && e.message ? e.message : e));
        try { console.warn("[dsh-archive-favorites-forge] slot registration failed", e); } catch (e2) {}
      }
      diag("apply: done");
    };

    return module.exports;
  },
});
