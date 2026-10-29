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

    // The plugin context, stashed at apply() time so that non-slot helpers
    // (the ungrouped card's "which session is on screen" lookup) can reach the
    // `sessions` service. Null before mount, and every read is guarded.
    var affPluginCtx = null;

    /**
     * The session the user is currently looking at.
     *
     * This is the SAME lookup the app itself uses: the row whose
     * `retainedBy.mainView` counter is positive. It is deliberately NOT taken
     * from the URL or from a title, because a fork leaves several rows with the
     * same title and picking the wrong one would let the ungrouped cleanup
     * touch the conversation that is open right now.
     */
    function affCurrentSessionId() {
      try {
        var snapshot = affPluginCtx.sessions.list.getSnapshot();
        var rows = Object.values(snapshot.byId || {});
        for (var i = 0; i < rows.length; i++) {
          var retained = rows[i] && rows[i].retainedBy;
          if (retained && (retained.mainView || 0) > 0) return rows[i].id || "";
        }
      } catch (e) { /* service absent or not ready */ }
      return "";
    }

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

    // --- continuation into a new window (0.28.0) --------------------------
    //
    // WHY: a long conversation eventually costs more to continue than to
    // restart — every new turn re-sends the whole history, and past a certain
    // size the window simply stops being usable. The fix that keeps the WORK is
    // to hand a distilled brief (requirement timeline + task progress) to a
    // fresh session, and drop the 800 tool calls that produced it.
    //
    // WHAT THE CLIENT OWNS vs THE HOST: the host builds the brief from the event
    // log (`POST /session-digest`, read-only). The client creates the session,
    // inherits the agent preset, renames it, opens it and sends the brief —
    // because only the client can touch `sessions`/`uiWorkspace`.
    //
    // 🔴 THE SESSION IS CREATED ONLY AFTER THE USER CONFIRMS. Building the brief
    // is a read; creating a session is a write. Never merge the two: a user who
    // just wanted to see how far along the work is must not end up with a stray
    // empty conversation.

    /** The agent preset the original conversation runs on, if the app knows it. */
    function affAgentPresetOf(sessionId) {
      try {
        var rows = affPluginCtx.sessions.list.getSnapshot().byId || {};
        var row = rows[sessionId];
        var preset = row && row.projectionValues && row.projectionValues.agentPreset;
        return typeof preset === "string" ? preset : "";
      } catch (e) { return ""; }
    }

    /** The workspace a session belongs to, so the new window opens beside it. */
    function affWorkspaceIdOf(sessionId) {
      try {
        var items = affPluginCtx.workspaces.list.getSnapshot().items || [];
        for (var i = 0; i < items.length; i++) {
          var ids = items[i].sessionIds || [];
          for (var j = 0; j < ids.length; j++) {
            if (idKey(ids[j]) === idKey(sessionId)) return items[i].workspaceId;
          }
        }
      } catch (e) { /* fall through: create in the default workspace */ }
      return "";
    }

    /**
     * Rename a session the way the app itself does.
     *
     * `sessions.using(...)` is the official path (`renameSession` in the
     * workspace bundle) and it is the one that pushes the new title into the
     * projection store, so the sidebar updates without a reload. The direct
     * `manager.rename` fallback exists because `using` needs a retained binding
     * and a just-created session may not have one yet.
     */
    function affRenameSession(sessionId, title) {
      var clean = String(title || "").trim();
      if (clean.length === 0) return Promise.resolve(false);
      var sessions = affPluginCtx && affPluginCtx.sessions;
      if (!sessions) return Promise.resolve(false);

      var viaManager = function () {
        var manager = sessions.manager;
        if (!manager || typeof manager.rename !== "function") return Promise.resolve(false);
        return Promise.resolve(manager.rename(sessionId, clean)).then(function (result) {
          return !(result && result.ok === false);
        });
      };

      if (typeof sessions.using !== "function") return viaManager().catch(function () { return false; });

      return sessions.using(sessionId, { source: "archiveFavorites" }, function (reference) {
        return reference.binding.session.rename(clean);
      }).then(function (result) {
        if (result && result.ok === false) {
          throw new Error(result.error && result.error.message ? result.error.message : "rename failed");
        }
        return true;
      }).catch(viaManager).catch(function () { return false; });
    }

    /** Poll until a freshly created session accepts a prompt, then send it. */
    function affPromptSession(sessionId, content, attempts) {
      var left = typeof attempts === "number" ? attempts : 40;
      var sessions = affPluginCtx && affPluginCtx.sessions;
      var binding = sessions && typeof sessions.binding === "function" ? sessions.binding(sessionId) : undefined;
      var session = binding && binding.session;
      if (session && typeof session.prompt === "function") {
        // session.prompt() forwards its first argument straight to the
        // session/prompt wire call, whose content field is validated as an
        // array of content blocks. A bare string is rejected there with
        // gateway/input-invalid (wire field request failed boundary
        // validation), so wrap it before sending.
        var blocks = typeof content === "string" ? [{ type: "text", text: content }] : content;
        return Promise.resolve(session.prompt(blocks, "queue")).then(function (result) {
          if (result && result.ok === false) {
            throw new Error(result.error && result.error.message ? result.error.message : "发送失败");
          }
          return true;
        });
      }
      if (left <= 0) return Promise.reject(new Error("新会话未能就绪，继续对话的摘要没有发出去"));
      return new Promise(function (resolve) { window.setTimeout(resolve, 250); })
        .then(function () { return affPromptSession(sessionId, content, left - 1); });
    }

    /**
     * Build the brief, show it, and only then create the new conversation.
     *
     * The dialog reuses `SessionDeleteDialog`'s state shape: `editor` shows the
     * exact text that will be sent (so the user can trim it), `checkbox` toggles
     * preset inheritance. Confirm is what creates anything.
     */
    function continueInNewWindow(sessionId, displayTitle) {
      toast("正在整理上下文…");
      return api("/session-digest", { sessionId: sessionId }).then(function (data) {
        if (!data || data.ok !== true) {
          toast("无法整理上下文：" + ((data && data.error) || "未知原因"));
          return;
        }
        var title = data.title || displayTitle || "";
        var progress = [];
        progress.push("检测到任务进行到 第 " + data.turns + " 轮");
        if (data.todoSummary && data.todoSummary.total > 0) {
          var line = "任务清单 " + data.todoSummary.completed + "/" + data.todoSummary.total + " 已完成";
          if (data.todoSummary.current) line += "，当前：" + data.todoSummary.current;
          progress.push(line);
        } else if (data.teamSummary && data.teamSummary.current) {
          progress.push("进行中的团队任务：" + data.teamSummary.current);
        }
        progress.push("共 " + data.userMessageCount + " 条要求 · " + data.toolCallCount + " 次工具调用");
        progress.push("");
        progress.push("确认后会在新窗口开一个「新对话-" + (title || "未命名") + "」，并自动把下面的交接资料发过去。");
        progress.push("下面的文本框就是将要发送的内容，可以直接修改。");

        seSetDialog({
          title: "一键新窗口继续对话",
          description: progress.join("\n"),
          wide: true,
          editor: { initial: data.prompt, placeholder: "交接资料" },
          checkbox: { initial: true, label: "新对话继承原对话的预设智慧体" + (data.agentPreset ? "（" + data.agentPreset + "）" : "") },
          confirmLabel: "开始新对话",
          confirmDanger: false,
          onConfirm: function (text, inheritPreset) {
            var brief = typeof text === "string" && text.trim().length > 0 ? text : data.prompt;
            var preset = inheritPreset === false ? "" : (data.agentPreset || affAgentPresetOf(sessionId));
            var workspaceId = affWorkspaceIdOf(sessionId);
            var payload = {};
            if (workspaceId) payload.workspaceId = workspaceId;
            if (preset) payload.agentPreset = preset;
            toast("正在新建对话…");
            Promise.resolve(affPluginCtx.sessions.create(payload)).then(function (created) {
              var childId = typeof created === "string" ? created : (created && (created.sessionId || created.id));
              if (!childId) throw new Error("新会话没有返回 id");
              return affRenameSession(childId, "新对话-" + (title || "未命名")).then(function () {
                return childId;
              });
            }).then(function (childId) {
              try { affPluginCtx.uiWorkspace.openSession(childId); } catch (e) {}
              return affPromptSession(childId, brief, 40).then(function () {
                toast("已在新窗口继续，交接资料已发送");
                return childId;
              });
            }).catch(function (error) {
              diag("continue-in-new-window failed: " + (error && error.message ? error.message : error));
              toast("继续对话失败：" + (error && error.message ? error.message : error));
            });
          },
        });
      }).catch(function (error) {
        toast("无法整理上下文：" + (error && error.message ? error.message : error));
      });
    }

    function ContinueSessionMenuItem(props) {
      var sessionId = props.sessionId;
      var displayTitle = props.displayTitle;
      var menuOpenState = props.useMenuOpenState ? props.useMenuOpenState() : null;
      return React.createElement(MenuRow, {
        icon: "⇥",
        onSelect: function () {
          try { if (menuOpenState && menuOpenState[1]) menuOpenState[1](false); } catch (e) {}
          continueInNewWindow(sessionId, displayTitle);
        },
      }, "新窗口继续对话");
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
        }, "删除对话");
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
     * Hide the harness's own "复制 Session ID" row inside a session "..." menu.
     *
     * WHY
     * ---
     * `SessionIdMenuItem` is a BUILT-IN row of `sidebar.workspaces.session.menu.item`
     * (source: `@deepseek-ai/dsh-experimental-inspector` bindings, label
     * `menu.sessionId` → "复制 Session ID" / "Copy Session ID"). It is the last
     * built-in item, and it copies exactly what this plugin's own
     * "复制 ID + 路径" row already copies (the ID) — so the menu carried two
     * near-identical copy entries, which is what the user asked to remove.
     *
     * A slot cannot remove a sibling slot's row, so this is done at the DOM
     * level: the row's WRAPPER is hidden, not just the button, so no empty
     * gap is left behind. Matching is by exact label against the two shipped
     * locales — a substring match would also catch our own "复制 ID + 路径".
     *
     * Idempotent and cheap: it only walks menus that were just opened.
     */
    var OFFICIAL_SESSION_ID_LABELS = ["复制 Session ID", "Copy Session ID"];

    function hideOfficialSessionIdRow(menu) {
      try {
        if (menu === null || menu.querySelectorAll === undefined) return;
        var buttons = menu.querySelectorAll("button[role='menuitem']");
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          // Never touch our own injected rows.
          if (btn.closest("[data-dsh-aff-injected='1']") !== null) continue;
          var text = (btn.textContent || "").trim();
          var match = false;
          for (var w = 0; w < OFFICIAL_SESSION_ID_LABELS.length; w++) {
            if (text === OFFICIAL_SESSION_ID_LABELS[w]) { match = true; break; }
          }
          if (!match) continue;
          // Hide the enclosing row wrapper when there is one — the button alone
          // would leave a blank line of padding behind.
          var seat = btn.parentElement !== null ? btn.parentElement : btn;
          if (seat.getAttribute("data-dsh-aff-hidden-official") === "1") continue;
          seat.setAttribute("data-dsh-aff-hidden-official", "1");
          seat.style.display = "none";
        }
      } catch (e) {}
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
              if (node.matches && node.matches("div[role='menu']")) {
                injectFilterRows(node);
                hideOfficialSessionIdRow(node);
              } else if (node.querySelectorAll) {
                var menus = node.querySelectorAll("div[role='menu']");
                for (var k = 0; k < menus.length; k++) {
                  injectFilterRows(menus[k]);
                  hideOfficialSessionIdRow(menus[k]);
                }
              }
              // A menu can also be populated AFTER its container mounted (rows
              // stream in), in which case the added node's ancestor is the menu.
              if (node.closest) {
                var host = node.closest("div[role='menu']");
                if (host !== null) hideOfficialSessionIdRow(host);
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

    // =====================================================================
    // Ungrouped-bucket health card ("未分组体检")
    //
    // WHY THIS CARD EXISTS
    // --------------------
    // The sidebar's 未分组 group is the OFFICIAL fallback for sessions that sit
    // on disk but were never registered into any `workspace.sessionIds`. This
    // plugin cannot stop that from happening (only the official create path
    // decides what gets registered), so instead it makes the state VISIBLE and
    // fixable in one click. Without a surface like this, the only way to notice
    // a regression was to scroll the sidebar and wonder.
    //
    // 🔴 TWO CLICKS BEFORE ANYTHING IS DELETED.
    // The first click runs a DRY RUN and renders exactly what would happen; the
    // second click carries `confirm: true`. The host ALSO defaults `dryRun` to
    // true unless `confirm` is present, so a stale or hand-rolled request can
    // never remove a session.
    // =====================================================================

    var ADVISE_LABEL = {
      delete: "删到回收站",
      archive: "归档（保留数据）",
      attach: "登记归位",
      manual: "需人工判断",
    };
    var ADVISE_COLOR = {
      delete: "var(--dsw-alias-state-error-primary, #ff6b6b)",
      archive: "var(--dsw-alias-state-warning-primary, #ffb454)",
      attach: "var(--dsw-alias-state-success-primary, #4ec9a0)",
      manual: "var(--dsw-alias-label-secondary, rgba(255,255,255,.6))",
    };

    function UngroupedCard() {
      var reportPair = React.useState(null);
      var report = reportPair[0];
      var setReport = reportPair[1];
      var busyPair = React.useState("");
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      // "" | "dry" | "live" — which confirmation step the user is on.
      var stagePair = React.useState("");
      var stage = stagePair[0];
      var setStage = stagePair[1];
      var resultPair = React.useState(null);
      var result = resultPair[0];
      var setResult = resultPair[1];
      var explainPair = React.useState(null);
      var explain = explainPair[0];
      var setExplain = explainPair[1];

      function diagnose() {
        setBusy("diagnose");
        setResult(null);
        setStage("");
        api("/ungrouped-diagnose", { currentSessionId: affCurrentSessionId() })
          .then(function (data) {
            setBusy("");
            setReport(data || null);
          })
          .catch(function (error) {
            setBusy("");
            setReport({ ok: false, detail: String(error && error.message ? error.message : error) });
          });
      }

      function cleanup(dryRun) {
        var current = affCurrentSessionId();
        var ids = report && Array.isArray(report.ungrouped)
          ? report.ungrouped.map(function (entry) { return entry.sessionId; })
          : [];
        setBusy(dryRun ? "dry" : "live");
        api("/ungrouped-cleanup", {
          sessionIds: ids,
          currentSessionId: current,
          dryRun: dryRun === true,
          // The host only honours `dryRun: false` when `confirm` is true.
          confirm: dryRun !== true,
        })
          .then(function (data) {
            setBusy("");
            setResult(data || null);
            // A real run changed the disk, so the counts are stale: re-diagnose.
            if (dryRun !== true) diagnose();
            else setStage("live");
          })
          .catch(function (error) {
            setBusy("");
            setStage("");
            setResult({ error: String(error && error.message ? error.message : error) });
          });
      }

      function toggleExplain() {
        if (explain !== null) { setExplain(null); return; }
        api("/ungrouped-explain", {})
          .then(function (data) {
            setExplain(data && Array.isArray(data.paragraphs) ? data.paragraphs : []);
          })
          .catch(function () { setExplain([]); });
      }

      var children = [];
      children.push(React.createElement("div", {
        key: "head",
        style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" },
      },
        React.createElement("div", { style: { fontWeight: "600" } }, "未分组体检"),
        React.createElement("div", { style: { display: "flex", gap: "8px" } },
          React.createElement("button", {
            type: "button", style: BTN_STYLE, disabled: busy !== "",
            onClick: diagnose,
          }, busy === "diagnose" ? "检查中…" : "诊断"),
          React.createElement("button", {
            type: "button", style: BTN_STYLE,
            onClick: toggleExplain,
          }, explain === null ? "为什么会有未分组？" : "收起说明"))));

      children.push(React.createElement("div", {
        key: "intro",
        style: { opacity: .72, fontSize: "12px", lineHeight: "17px" },
      }, "侧栏底部的「未分组」不是删除对话造成的，也不是数据损坏。它是官方侧栏给"
        + "「磁盘上存在、却从未登记进任何工作区」的会话留的兜底分组。这里可以只读检查有多少条、"
        + "分别该怎么处理，并一键修掉。"));

      if (explain !== null) {
        children.push(React.createElement("div", {
          key: "explain",
          style: {
            display: "flex", flexDirection: "column", gap: "6px",
            padding: "8px", borderRadius: "8px",
            background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))",
            fontSize: "12px", lineHeight: "18px",
          },
        }, explain.length === 0
          ? React.createElement("div", { style: { opacity: .7 } }, "说明加载失败。")
          : explain.map(function (text, index) {
              return React.createElement("div", { key: "p" + index }, text);
            })));
      }

      if (report === null) {
        children.push(React.createElement("div", { key: "ug-idle", style: { opacity: .65 } },
          "点「诊断」开始只读检查（不会修改任何文件）。"));
      } else if (report.ok !== true) {
        children.push(React.createElement("div", {
          key: "fail",
          style: { color: "var(--dsw-alias-state-error-primary, #ff6b6b)", lineHeight: "20px" },
        }, "诊断失败：" + String(report.detail || report.error || "未知原因")));
      } else {
        var summary = report.summary || {};
        var entries = Array.isArray(report.ungrouped) ? report.ungrouped : [];
        var clean = entries.length === 0;
        children.push(React.createElement("div", {
          key: "summary",
          style: { lineHeight: "20px", fontWeight: clean ? "600" : "600", color: clean ? "var(--dsw-alias-state-success-primary, #4ec9a0)" : "var(--dsw-alias-state-warning-primary, #ffb454)" },
        }, clean
          ? "✅ 未分组为空（已扫描 " + (summary.totalDirs || 0) + " 个会话目录，全部有归属或被正确排除）"
          : "⚠ 有 " + entries.length + " 条会话会显示在「未分组」里"));

        children.push(React.createElement("div", {
          key: "counts",
          style: { fontSize: "11px", opacity: .7, lineHeight: "16px" },
        }, "扫描 " + (summary.totalDirs || 0) + " 个目录｜工作区成员 " + (summary.memberCount || 0)
          + "｜已归档 " + (summary.archivedCount || 0) + "｜子代理 " + (summary.subagentCount || 0)
          + "｜空会话 " + (summary.blankCount || 0) + "｜读失败 " + (summary.unreadableCount || 0)
          + "｜判定来源 " + (report.source === "registry" ? "官方实时注册表" : "workspace.json 文件")));

        if (!clean) {
          children.push(React.createElement("div", {
            key: "list",
            style: { display: "flex", flexDirection: "column", gap: "4px", maxHeight: "240px", overflowY: "auto" },
          }, entries.slice(0, 60).map(function (entry) {
            return React.createElement("div", {
              key: entry.sessionId,
              style: {
                display: "flex", flexDirection: "column", gap: "2px",
                padding: "6px 8px", borderRadius: "7px",
                background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.04))",
              },
            },
              React.createElement("div", { style: { fontSize: "12px", wordBreak: "break-all" } },
                (entry.title && String(entry.title).length > 0 ? String(entry.title) : "（无标题）")
                + "  ·  " + entry.sessionId),
              React.createElement("div", {
                style: { fontSize: "11px", opacity: .75, color: ADVISE_COLOR[entry.advise] || "inherit" },
              }, "建议：" + (ADVISE_LABEL[entry.advise] || entry.advise) + " — " + String(entry.reason || "")));
          }), entries.length > 60
            ? React.createElement("div", { key: "more", style: { fontSize: "11px", opacity: .6 } },
                "还有 " + (entries.length - 60) + " 条未显示（清理会覆盖全部）。")
            : null));
        }

        // ---- action area -------------------------------------------------
        if (!clean && stage === "") {
          children.push(React.createElement("div", { key: "ug-act", style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
            React.createElement("button", {
              type: "button", style: BTN_STYLE, disabled: busy !== "",
              onClick: function () { cleanup(true); },
            }, busy === "dry" ? "试算中…" : "试算（不修改任何文件）")));
        }

        if (stage === "live" && !clean) {
          children.push(React.createElement("div", {
            key: "confirm",
            style: {
              display: "flex", flexDirection: "column", gap: "8px", padding: "8px",
              borderRadius: "8px", background: "var(--dsw-alias-bg-warning, rgba(255,107,107,.1))",
            },
          },
            React.createElement("div", { style: { lineHeight: "20px" } },
              "确认执行？「删到回收站」的条目会进 Windows 回收站（可恢复），"
              + "「归档」的条目只是移出侧栏、数据保留，「登记归位」的条目会正常留在侧栏。"),
            React.createElement("div", { style: { display: "flex", gap: "6px" } },
              React.createElement("button", {
                type: "button", style: DANGER_STYLE, disabled: busy !== "",
                onClick: function () { cleanup(false); },
              }, busy === "live" ? "执行中…" : "确认执行"),
              React.createElement("button", {
                type: "button", style: BTN_STYLE, disabled: busy !== "",
                onClick: function () { setStage(""); },
              }, "取消"))));
        }

        if (result) {
          var isError = Boolean(result.error);
          children.push(React.createElement("div", {
            key: "result",
            style: {
              padding: "8px", borderRadius: "8px", lineHeight: "20px",
              background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))",
              color: isError ? "var(--dsw-alias-state-error-primary, #ff6b6b)" : "inherit",
            },
          }, isError
            ? "执行失败：" + String(result.error)
            : (result.dryRun ? "【试算结果，未做任何修改】" : "【已执行】")
              + " 删除 " + ((result.deleted || []).length)
              + " 条｜归档 " + ((result.archived || []).length)
              + " 条｜登记 " + ((result.attached || []).length)
              + " 条｜跳过 " + ((result.skipped || []).length)
              + " 条｜失败 " + ((result.failures || []).length) + " 条",
          (result.failures && result.failures.length)
            ? React.createElement("div", { style: { marginTop: "4px", fontSize: "12px", opacity: .75 } },
                result.failures.slice(0, 5).map(function (item) {
                  return String(item.sessionId) + "：" + String(item.reason);
                }).join("；"))
            : null));
        }
      }

      return React.createElement("div", { style: CARD_STYLE }, children);
    }

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

      // -- ungrouped-bucket health ("未分组体检") --
      //
      // Placed last on purpose: it is a maintenance card, not an everyday
      // action, and putting it above the archive controls would suggest the
      // bucket is something that needs attention every day.
      children.push(React.createElement(UngroupedCard, { key: "ungrouped" }));

      return React.createElement("div", { style: SECTION_STYLE }, children);
    }

    // =====================================================================
    // SESSION MANAGER HALF — distilled from dsh-session-manager v1.0.0
    //
    // Three capabilities, folded in so one plugin covers them:
    //
    //   1. Edit-and-resend / undo-a-turn / delete-a-message buttons injected
    //      under every user message (next to the shipped copy button).
    //   2. A file snapshot ledger: every `write` / `edit` /
    //      `str_replace_editor` tool call has its pre-edit bytes hashed into
    //      the session directory, so "undo this turn" can put the files back.
    //   3. A confirmation dialog hosted in the `shell.overlay` slot.
    //
    // 🔴 ONE DELETE IMPLEMENTATION, NOT TWO.
    // The upstream plugin shipped its own delete button + menu row + six-step
    // /api/session-delete. This plugin ALREADY has a permanent delete
    // (`aff-delete`, host `handleDelete`) with six guards, symlink refusal and
    // EBUSY retries — strictly stronger. So the upstream delete UI is NOT
    // ported at all: only its `seSetDialog`-based dialog is, reused by
    // edit/undo. Truncation still needs the original conversation gone, and
    // that final step calls the host's `/session-replace` route, which is
    // `handleDelete` with an explicit `replace` flag (see lib/index.js).
    //
    // WHY THE BLOCK BELOW IS VERBATIM-ISH
    // -----------------------------------
    // It was lifted from a working, shipped bundle and only re-namespaced:
    // every CSS class is `dsh-aff-sd-*` (upstream used `dsh-sd-*`), every
    // fetch path carries this plugin's ROUTE prefix, and every diagnostic goes
    // through the whitelisted `[next-ui-diagnostic]` channel. Rewriting it
    // would re-introduce bugs that were already paid for.
    // =====================================================================

    // ---- inline SVG icons -------------------------------------------------
    // The upstream glyphs, kept as strings: the injected buttons are built with
    // `document.createElement` (they live inside the chat transcript, which is
    // React-owned and not a slot), so `innerHTML` is the only ergonomic carrier.

    // 复用原插件的垃圾桶图标
    var SE_TRASH_SVG = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4M6.5 6.8v4.4M9.5 6.8v4.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`

    var SE_ICON_FAIL = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    </svg>`

    var SE_PENCIL_SVG = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M11.2 2.6a1.5 1.5 0 0 1 2.1 2.1L6.2 11.8l-2.9.9.9-2.9 7-7.2z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M10.1 3.7l2.1 2.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>`

    var SE_RESTORE_SVG = `<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M2.6 6.4A5.5 5.5 0 1 1 2.5 8.3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    <path d="M2.3 3v3.2h3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`

    var SE_CSS = `
    /* 与内置 iconButton 同规格：16x16、label-tertiary 起、hover 转 label-primary */
    .dsh-aff-sd-btn {
      appearance: none;
      border: none;
      background: none;
      cursor: pointer;
      color: var(--dsw-alias-label-tertiary);
      width: 16px;
      height: 16px;
      padding: 0;
      border-radius: 4px;
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .dsh-aff-sd-btn:hover { color: var(--dsw-alias-label-primary); }
    .dsh-aff-sd-btn:focus-visible {
      outline: 1px solid var(--dsw-alias-border-l2, currentColor);
      outline-offset: 1px;
    }
    .dsh-aff-sd-btn svg { width: 16px; height: 16px; display: block; }
    .dsh-aff-sd-btn.dsh-aff-sd-del:hover { color: var(--dsw-alias-state-error-primary); }
    .dsh-aff-sd-btn[aria-busy="true"] { opacity: .5; cursor: progress; }
    .dsh-aff-sd-btn.dsh-aff-sd-failed { color: var(--dsw-alias-state-error-primary); }

    /* 确认对话框：透明命中层 + 居中卡片，形态对齐宿主 Modal。
       v15：应用户要求去掉背景遮罩（不再压暗页面），但命中层仍全屏——
       点对话框外的任意位置依旧关闭，Esc 也依旧关闭。
       v16：卡片背景换成 --dsw-alias-bg-layer-2（宿主 Modal 同款 token）：
       亮色主题 = 纯白 #fff，暗色主题 = 浮层面色 #2c2c2e，随主题自适应。 */
    .dsh-aff-sd-backdrop {
      position: fixed;
      inset: 0;
      z-index: 200;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .dsh-aff-sd-dialog {
      box-sizing: border-box;
      width: 100%;
      max-width: 420px;
      background: var(--dsw-alias-bg-layer-2);
      color: var(--dsw-alias-label-primary);
      border: 1px solid var(--dsw-alias-border-l1);
      border-radius: 12px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, .25), 0 2px 8px rgba(0, 0, 0, .12);
      padding: 18px 20px 16px;
      font-size: 14px;
      line-height: 22px;
    }
    .dsh-aff-sd-dialog:focus { outline: none; }
    /* Wide variant: the continuation brief is a long markdown document, and a
       420px column turns it into an unreadable ribbon. Only dialogs that opt in
       with state.wide get this width. */
    .dsh-aff-sd-dialog.dsh-aff-sd-dialog-wide {
      max-width: 760px;
    }
    .dsh-aff-sd-dialog.dsh-aff-sd-dialog-wide .dsh-aff-sd-textarea {
      min-height: 320px;
      max-height: 52vh;
      font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
      font-size: 12px;
      line-height: 18px;
    }
    .dsh-aff-sd-title {
      margin: 0 0 8px;
      font-size: 15px;
      line-height: 22px;
      font-weight: 600;
    }
    .dsh-aff-sd-desc {
      margin: 0;
      color: var(--dsw-alias-label-secondary);
      font-size: 13px;
      line-height: 20px;
      white-space: pre-line;
      overflow-wrap: break-word;
      /* 文件清单可能较长：限制高度并允许滚动，弹窗不失控 */
      max-height: 40vh;
      overflow-y: auto;
    }
    .dsh-aff-sd-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 18px;
    }
    .dsh-aff-sd-action {
      appearance: none;
      cursor: pointer;
      font-size: 13px;
      line-height: 20px;
      padding: 5px 14px;
      border-radius: 8px;
      border: 1px solid var(--dsw-alias-border-l2);
      background: transparent;
      color: var(--dsw-alias-label-primary);
    }
    .dsh-aff-sd-action:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12)); }
    .dsh-aff-sd-action:focus-visible {
      outline: 1px solid var(--dsw-alias-border-l2, currentColor);
      outline-offset: 1px;
    }
    .dsh-aff-sd-action.dsh-aff-sd-danger {
      color: var(--dsw-alias-state-error-primary);
      border-color: var(--dsw-alias-state-error-primary);
    }

    /* 编辑模式的文本域（v19） */
    .dsh-aff-sd-textarea {
      box-sizing: border-box;
      width: 100%;
      min-height: 120px;
      max-height: 320px;
      resize: vertical;
      font: inherit;
      line-height: 20px;
      color: var(--dsw-alias-label-primary);
      background: var(--dsw-alias-bg-layer-1);
      border: 1px solid var(--dsw-alias-border-l2);
      border-radius: 8px;
      padding: 8px 10px;
      outline: none;
    }
    .dsh-aff-sd-textarea:focus-visible {
      outline: 1px solid var(--dsw-alias-border-l3, currentColor);
      outline-offset: 0;
    }

    /* 用户消息操作行的编辑/回滚按钮（v20）。
       尺寸/配色完全克隆内建 MessageIconActions 的 .action 规格，保证并排视觉一致 */
    .dsh-aff-sd-mactions {
      display: inline-flex;
      align-items: center;
      gap: 2px;
    }
    .dsh-aff-sd-maction {
      width: calc(28px + var(--dsh-content-font-delta, 0px));
      height: calc(28px + var(--dsh-content-font-delta, 0px));
      border-radius: var(--dsw-radius-sm);
      color: var(--dsw-alias-label-tertiary);
      cursor: pointer;
      background: none;
      border: none;
      justify-content: center;
      align-items: center;
      padding: 6px;
      display: inline-flex;
    }
    .dsh-aff-sd-maction svg {
      width: calc(15px + var(--dsh-content-font-delta, 0px));
      height: calc(15px + var(--dsh-content-font-delta, 0px));
      display: block;
    }
    .dsh-aff-sd-maction:hover {
      background: var(--dsw-alias-interactive-bg-hover);
      color: var(--dsw-alias-label-secondary);
    }
    .dsh-aff-sd-maction[aria-busy='true'] {
      opacity: .5;
      cursor: progress;
    }
    .dsh-aff-sd-maction[aria-busy='true'] {
      opacity: .5;
      cursor: progress;
    }
    .dsh-aff-sd-maction.dsh-aff-sd-failed {
      color: var(--dsw-alias-state-error-primary);
    }

    /* 用户消息操作行（复制/撤销/编辑）默认常显。
       应用对"后面还有用户消息"的行设 opacity:0、悬停才显（只有最后一条常显）；
       这里直接覆盖为始终可见。data-clock="start" 是应用自己的标记（助手行用
       "end"），只影响用户消息，不碰助手操作行。 */
    div[data-clock="start"] {
      opacity: 1 !important;
    }

    /* 助手消息操作行（复制/分支等）同样默认常显：应用经 [data-actions-reveal=hover]
       控制其显隐，这里一并覆盖。 */
    [data-actions-reveal="hover"] div[data-clock="end"],
    div[data-clock="end"] {
      opacity: 1 !important;
    }

    /* 深色提示气泡（对齐内置 Tooltip.module.css 的 .bubble 规格） */
    .dsh-aff-sd-maction,
    .dsh-aff-sd-btn {
      position: relative;
    }
    .dsh-aff-sd-tip {
      position: fixed;
      z-index: 400;
      pointer-events: none;
      width: max-content;
      max-width: 50vw;
      background: var(--dsw-alias-tooltip-bg);
      color: var(--dsw-static-neutral-bluish-00);
      font-size: 13px;
      line-height: 20px;
      padding: 3px 7px;
      border-radius: var(--dsw-radius-sm);
      white-space: pre-line;
      overflow-wrap: break-word;
      box-shadow: 0 6px 16px rgba(0, 0, 0, .2);
    }

    /* "更多"菜单里的删除项（规格对齐内置 MenuItemButton 的 .item/.danger） */
    .dsh-aff-sd-menu-item {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      box-sizing: border-box;
      min-height: 34px;
      padding: 6px 8px;
      border: none;
      border-radius: var(--dsw-radius-md);
      background: transparent;
      cursor: pointer;
      font-size: 13px;
      line-height: 20px;
      color: var(--dsw-alias-label-primary);
      text-align: left;
      user-select: none;
    }
    .dsh-aff-sd-menu-item:hover,
    .dsh-aff-sd-menu-item:focus-visible {
      background: var(--dsw-alias-interactive-bg-hover-danger);
      outline: none;
    }
    .dsh-aff-sd-menu-danger {
      color: var(--dsw-alias-state-error-primary);
    }
    .dsh-aff-sd-menu-icon {
      display: inline-flex;
      flex: none;
      width: 14px;
      height: 14px;
      align-items: center;
      justify-content: center;
    }
    .dsh-aff-sd-menu-icon svg {
      width: 14px;
      height: 14px;
      display: block;
    }

    /* 确认对话框里的勾选框（v49，回滚文件开关） */
    .dsh-aff-sd-check {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      cursor: pointer;
      user-select: none;
    }
    .dsh-aff-sd-check-box {
      width: 15px;
      height: 15px;
      flex: none;
      cursor: pointer;
      accent-color: var(--dsw-alias-state-business-primary);
      margin: 0;
    }
    .dsh-aff-sd-check-label {
      font-size: 13px;
      line-height: 20px;
      color: var(--dsw-alias-label-secondary);
    }

    /* 内联编辑器（v21，布局参考 ZCode ChatPromptEditor：圆角壳 + 附件区 + 底部工具栏） */
    .dsh-aff-sd-editing > :not(.dsh-aff-sd-editor) {
      display: none !important;
    }
    .dsh-aff-sd-editor {
      display: flex;
      flex-direction: column;
      gap: 8px;
      border: 1px solid var(--dsw-alias-border-l2);
      border-radius: 12px;
      background: var(--dsw-alias-bg-layer-1);
      padding: 12px;
    }
    .dsh-aff-sd-editor:focus-within {
      border-color: var(--dsw-alias-link);
    }
    .dsh-aff-sd-editor.dsh-aff-sd-drag {
      border-color: var(--dsw-alias-link);
      background: var(--dsw-alias-interactive-bg-hover);
    }
    .dsh-aff-sd-edit-textarea {
      width: 100%;
      box-sizing: border-box;
      border: none;
      background: transparent;
      color: var(--dsw-alias-label-primary);
      font: inherit;
      line-height: 20px;
      resize: none;
      outline: none;
      min-height: 40px;
      max-height: 40vh;
      overflow-y: auto;
    }
    .dsh-aff-sd-edit-bar {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .dsh-aff-sd-edit-hint {
      font-size: 12px;
      line-height: 16px;
      color: var(--dsw-alias-label-tertiary);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dsh-aff-sd-edit-actions {
      display: inline-flex;
      gap: 8px;
      margin-left: auto;
    }
    .dsh-aff-sd-send {
      appearance: none;
      cursor: pointer;
      border: none;
      border-radius: 8px;
      padding: 5px 16px;
      font-size: 13px;
      line-height: 20px;
      background: var(--dsw-alias-button-primary-fill);
      color: var(--dsw-alias-label-primary-foreground);
    }
    .dsh-aff-sd-send:hover { opacity: .85; }
    .dsh-aff-sd-send:focus-visible {
      outline: 1px solid var(--dsw-alias-link);
      outline-offset: 1px;
    }
    .dsh-aff-sd-send[aria-busy='true'] {
      opacity: .5;
      cursor: progress;
    }
    .dsh-aff-sd-atts {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .dsh-aff-sd-att {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .dsh-aff-sd-att.dsh-aff-sd-att-img {
      width: 48px;
      height: 48px;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--dsw-alias-border-l2);
    }
    .dsh-aff-sd-att-thumb {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .dsh-aff-sd-att-name {
      font-size: 12px;
      line-height: 16px;
      color: var(--dsw-alias-label-secondary);
      border: 1px solid var(--dsw-alias-border-l2);
      border-radius: 8px;
      padding: 4px 8px;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dsh-aff-sd-att-remove {
      position: absolute;
      top: -6px;
      right: -6px;
      width: 16px;
      height: 16px;
      border-radius: 999px;
      border: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      font-size: 11px;
      line-height: 1;
      background: var(--dsw-alias-label-primary);
      color: var(--dsw-alias-bg-base);
    }
    `

    // ---- `h` -----------------------------------------------------------------
    // The upstream code was written against `h = React.createElement`. This
    // bundle's existing code calls `React.createElement` directly, and `React`
    // is resolved lazily (it can be null at factory time in the desktop shell
    // before the UMD shim lands), so `h` delegates instead of capturing: a
    // captured `React.createElement` would be a null reference for the whole
    // session if the shim arrived one tick late.
    function h(type, props) {
      var args = Array.prototype.slice.call(arguments);
      return React.createElement.apply(React, args);
    }

    // ---- dialog state (module-scope inside the factory) --------------------
    // The dialog is rendered by the `shell.overlay` slot; the buttons that OPEN
    // it are plain DOM nodes inside the transcript. They cannot share React
    // state, so one factory-level record plus a subscriber set carries "which
    // confirmation is open". A throwing subscriber must not stop the others —
    // the dialog would then never re-render and look permanently stuck.
    var seDialog = null;
    var seDialogListeners = new Set();

    function seSetDialog(next) {
      seDialog = next;
      seDialogListeners.forEach(function (fn) {
        try { fn(); } catch (e) { /* isolate one bad subscriber */ }
      });
    }

    // ── 深色提示气泡（对齐内置 Tooltip 视觉，替代原生 title）────────────
    // 内置 Tooltip 是 primitives 组件，插件不能导入 Harness 包，故自绘：
    // fixed 定位气泡挂在按钮内部（不向 document.body 追加节点），悬停 500ms
    // 后显示——与内置的延迟一致。
    //
    // "卡片让位"：内置 Tooltip 打开时会把行 hover 卡片抑制掉（React Context
    // 机制，插件接不进）。等效复刻——运行时从样式表发现 HoverCard 卡片类
    // （特征：规则里含 --dsw-hovercard-bg），气泡存在期间用 body:has() 隐藏
    // 该卡片；气泡消失即恢复。与内置一致：先消卡片、再出提示、不双显。
    const SE_TOOLTIP_DELAY = 500

    function installHoverCardSuppression() {
      for (const sheet of document.styleSheets) {
        let rules
        try {
          rules = sheet.cssRules
        } catch {
          continue
        }
        for (const rule of rules) {
          if (rule.selectorText && rule.cssText && rule.cssText.includes('--dsw-hovercard-bg')) {
            const style = document.querySelector('style[data-plugin="dsh-archive-favorites-forge"]')
            if (style && !style.textContent.includes('dsh-sm-suppress')) {
              style.textContent += `\n/* dsh-sm-suppress：气泡显示期间隐藏行 hover 卡片（对齐内置 Tooltip 的抑制行为） */\nbody:has(.dsh-aff-sd-tip) ${rule.selectorText.split(',')[0].trim()} { display: none !important; }\n`
            }
            return true
          }
        }
      }
      return false
    }

    function attachTooltip(button, getText) {
      const show = () => {
        const text = getText()
        if (!text) return
        hide()
        const el = document.createElement('div')
        el.className = 'dsh-aff-sd-tip'
        el.textContent = text
        el.style.visibility = 'hidden'
        button.appendChild(el)
        const rect = button.getBoundingClientRect()
        const tipRect = el.getBoundingClientRect()
        let left = rect.left + rect.width / 2 - tipRect.width / 2
        left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8))
        el.style.left = `${Math.round(left)}px`
        el.style.top = `${Math.round(rect.bottom + 6)}px`
        el.style.visibility = ''
        tooltipState.el = el
      }
      const hide = () => {
        window.clearTimeout(tooltipState.timer)
        tooltipState.timer = 0
        if (tooltipState.el) {
          tooltipState.el.remove()
          tooltipState.el = null
        }
      }
      const tooltipState = { el: null, timer: 0 }
      button.addEventListener('mouseenter', () => {
        tooltipState.timer = window.setTimeout(show, SE_TOOLTIP_DELAY)
      })
      button.addEventListener('mouseleave', hide)
      button.addEventListener('blur', hide)
      button.addEventListener('mousedown', hide)
    }

    // ── 确认对话框（shell.overlay）─────────────────────────────────────

    function SessionDeleteDialog() {
      const [state, setState] = React.useState(seDialog)
      const [editorText, setEditorText] = React.useState('')
      const [checked, setChecked] = React.useState(true)

      React.useEffect(() => {
        const sync = () => {
          setState(seDialog)
          setEditorText(seDialog?.editor?.initial ?? '')
          setChecked(seDialog?.checkbox?.initial !== false)
        }
        seDialogListeners.add(sync)
        sync()
        return () => { seDialogListeners.delete(sync) }
      }, [])

      const dialogRef = React.useRef(null)
      const returnFocusRef = React.useRef(null)
      const isOpen = state !== null

      // 打开时记住触发元素并把焦点移进对话框；关闭时还回去。
      // 键盘可操作、焦点不丢，是宿主 Modal 的用户依赖行为。
      React.useEffect(() => {
        if (!isOpen) return undefined
        returnFocusRef.current = document.activeElement
        const id = window.setTimeout(() => {
          const area = dialogRef.current?.querySelector('textarea')
          if (area) {
            area.focus()
            const end = area.value.length
            area.setSelectionRange(end, end)
          } else {
            dialogRef.current?.focus()
          }
        }, 0)
        return () => {
          window.clearTimeout(id)
          const back = returnFocusRef.current
          if (back && typeof back.focus === 'function' && back.isConnected) back.focus()
        }
      }, [isOpen])

      if (state === null) return null

      const onKeyDown = (ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault()
          ev.stopPropagation()
          seSetDialog(null)
        }
      }

      const confirm = () => {
        const run = state.onConfirm
        const isEditor = state.editor != null
        const hasCheckbox = state.checkbox != null
        seSetDialog(null)
        if (typeof run === 'function') run(isEditor ? editorText : undefined, hasCheckbox ? checked : undefined)
      }

      return h('div', {
        className: 'dsh-aff-sd-backdrop',
        // 点命中层（对话框外任意位置）关闭；点卡片不关闭
        onMouseDown: (ev) => { if (ev.target === ev.currentTarget) seSetDialog(null) },
        onKeyDown,
      }, h('div', {
        ref: dialogRef,
        className: state.wide === true ? 'dsh-aff-sd-dialog dsh-aff-sd-dialog-wide' : 'dsh-aff-sd-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': state.title,
        tabIndex: -1,
      }, [
        h('h2', { key: 'title', className: 'dsh-aff-sd-title' }, state.title),
        h('p', { key: 'desc', className: 'dsh-aff-sd-desc' }, state.description),
        state.editor != null ? h('textarea', {
          key: 'editor',
          className: 'dsh-aff-sd-textarea',
          value: editorText,
          placeholder: state.editor.placeholder ?? '',
          onChange: (ev) => setEditorText(ev.target.value),
        }) : null,
        state.checkbox != null ? h('label', { key: 'checkbox', className: 'dsh-aff-sd-check' }, [
          h('input', {
            key: 'box',
            type: 'checkbox',
            className: 'dsh-aff-sd-check-box',
            checked,
            onChange: (ev) => setChecked(ev.target.checked),
          }),
          h('span', { key: 'label', className: 'dsh-aff-sd-check-label' }, state.checkbox.label ?? ''),
        ]) : null,
        h('div', { key: 'footer', className: 'dsh-aff-sd-footer' }, [
          h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dsh-aff-sd-action',
            onClick: (ev) => { ev.preventDefault(); ev.stopPropagation(); seSetDialog(null) },
          }, '取消'),
          h('button', {
            key: 'confirm',
            type: 'button',
            // Red is the DEFAULT because this dialog was born as a delete
            // confirmation. Actions that only create something (continuing in a
            // new window) opt out with `confirmDanger: false` — painting a
            // "start a new conversation" button red teaches the user to fear it.
            className: state.confirmDanger === false
              ? 'dsh-aff-sd-action'
              : 'dsh-aff-sd-action dsh-aff-sd-danger',
            onClick: (ev) => { ev.preventDefault(); ev.stopPropagation(); confirm() },
          }, state.confirmLabel || '确认'),
        ]),
      ]))
    }

    // ── 用户消息操作：编辑重发 / 撤销此轮（v20，DOM 注入到内置复制按钮前）──
    //
    // 数据链路（对应宿主端点与会话服务）：
    //   文件回滚  POST /session-files-restore {sessionId, keepSeq}
    //   turn 元信息 POST /session-turn-info   {sessionId, turn}
    //   会话截断  sessions.fork({sessionId, atSeq}) → 前缀子会话（应用自己的分支）
    //   首轮操作  无前缀可保留 → sessions.create 同工作区开新会话
    //   重发      openSession 后经 sessions.binding(child).session.prompt 发送
    //   收尾      POST /session-replace 删除原会话（含登记/事件/历史清理）
    //
    // 按钮语义（挂在用户消息下、复制按钮前）：
    //   铅笔 = 编辑重发：改写这条消息，其后对话与文件修改回滚后重发
    //   回转 = 撤销此轮：删除这条消息及其后的对话，文件修改一并回滚
    //
    // 已知边界：终端命令（bash/pwsh）造成的文件修改无法回滚；恢复会覆盖对话
    // 期间的手动改动。
    //
    // 挂载口径（0.28.2 修正）：官方把「一个回合开头的提问」渲染成
    // data-chat-flow-kind="user"，把「回合进行中插话（next-step 领取）」渲染成
    // data-chat-flow-kind="steering" —— 两者共用同一个 UserMessageNodeView，
    // 都带 data-clock="start" 与 data-chat-turn。早先只认 user，导致插话消息行
    // 上永远没有按钮（用户实测反馈「按钮不见了」，正是刚插话的那两条）。
    // 凡属人类消息行（user / steering）都要挂按钮。

    function injectTurnActions(pluginCtx) {
      const postJson = async (path, body) => {
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), 8000)
        try {
          const resp = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          const json = await resp.json().catch(() => ({}))
          if (!resp.ok || !json.ok) throw new Error(json.error || `HTTP ${resp.status}`)
          return json
        } finally {
          window.clearTimeout(timer)
        }
      }

      // 人类消息行选择器：官方把「一个回合开头的提问」标成 user，把「回合进行中
      // 插话」标成 steering，两者共用 UserMessageNodeView 渲染器、都带
      // data-chat-turn。只认 user 会漏掉所有插话消息行（0.28.2 修复）。
      const HUMAN_FLOW = '[data-chat-flow-kind="user"][data-chat-turn], [data-chat-flow-kind="steering"][data-chat-turn]'

      // 打开的聊天就是 mainView 保留的会话——应用自己定位"当前会话"同款方式
      const currentSessionRow = () => {
        const snapshot = pluginCtx.sessions.list.getSnapshot()
        return Object.values(snapshot.byId).find((r) => (r.retainedBy?.mainView ?? 0) > 0) ?? null
      }

      const promptChild = async (childId, content) => {
        for (let attempt = 0; attempt < 12; attempt++) {
          const session = pluginCtx.sessions.binding?.(childId)?.session
          if (session && typeof session.prompt === 'function') {
            const result = await session.prompt(content, 'queue')
            if (result && result.ok === false) throw new Error(result.error?.message || '发送失败')
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        throw new Error('新会话未能就绪，重发失败')
      }

      // 清空子会话继承的排队消息：fork 前缀里未消费的 inbox 插入事件会被子会话
      // 重建为"排队中"的气泡行（对话窗口里多出一条待发消息）。回滚语义是"撤销
      // 截断点之后的全部内容"，这些继承的排队项都属于被撤销的未来，一律移除。
      const clearInheritedQueue = async (childId) => {
        for (let attempt = 0; attempt < 12; attempt++) {
          const session = pluginCtx.sessions.binding?.(childId)?.session
          if (session && typeof session.updateQueue === 'function') {
            const queued = session.projections?.faceOf?.('inbox')?.getSnapshot()?.['next-turn'] ?? []
            for (const item of queued) {
              try {
                await session.updateQueue(item.id, { kind: 'remove' })
              } catch { /* 已被消费的条目按 no-op 处理 */ }
            }
            return
          }
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }

      // 开一个"保留 beforeSeq 及其之前"的新会话；beforeSeq 为 null（首轮）则开全新会话
      const openTruncatedChild = async (sessionId, beforeSeq) => {
        if (typeof beforeSeq === 'number') {
          const childId = await pluginCtx.sessions.fork({ sessionId, atSeq: beforeSeq })
          if (!childId) throw new Error('未能创建回滚会话')
          return childId
        }
        const items = pluginCtx.workspaces.list.getSnapshot().items
        const ws = items.find((w) => (w.sessionIds ?? []).includes(sessionId))
        const created = await pluginCtx.sessions.create(ws ? { workspaceId: ws.workspaceId } : {})
        const childId = typeof created === 'string' ? created : (created?.sessionId ?? created?.id ?? null)
        if (!childId) throw new Error('未能创建新会话')
        return childId
      }

      // 撤销此轮（v25）：文件恢复到该轮之前 → fork 截掉这条消息及其后 → 打开
      // 新会话 → 删原会话 → 这条消息的文本**预填进底部输入框**，用应用自己的
      // 发送键重新发出即可。
      // 预填方式：写入会话草稿的持久层 dsh.conversation.<sessionId>（裸 state
      // JSON），必须在 openSession 之前写——composer 挂载创建 store 时才水合。
      // fork 截在回合边界（beforeSeq），不再产生"已完成"合成尾迹。
      // restoreFiles=false 时只回滚对话、文件保持不动（v49 弹窗勾选框）。
      const doUndoTurn = async (sessionId, info, restoreFiles = true) => {
        if (restoreFiles) {
          await postJson(ROUTE + '/session-files-restore', {
            sessionId,
            keepSeq: typeof info.beforeSeq === 'number' ? info.beforeSeq : -1,
          })
        }
        const childId = await openTruncatedChild(sessionId, info.beforeSeq)
        const text = info.userText ?? ''
        if (text.trim()) {
          try {
            localStorage.setItem(`dsh.conversation.${childId}`, JSON.stringify({ draft: text, view: null, viewRequest: null }))
          } catch (e) {
            console.warn('[next-ui-diagnostic] dsh-aff: 输入框预填失败：', e)
          }
        }
        await pluginCtx.uiWorkspace.openSession(childId)
        await clearInheritedQueue(childId)
        await postJson(ROUTE + '/session-replace', { sessionId })
      }

      // 删除消息（v42）：只截断对话，**不动任何文件**——不调用文件恢复、
      // 不预填输入框。截断点同撤销（回合边界），子会话打开后删除原会话。
      const doDeleteMessage = async (sessionId, info) => {
        const childId = await openTruncatedChild(sessionId, info.beforeSeq)
        await pluginCtx.uiWorkspace.openSession(childId)
        await clearInheritedQueue(childId)
        await postJson(ROUTE + '/session-replace', { sessionId })
      }

      let busy = false
      const setBusy = (value) => {
        busy = value
        for (const el of document.querySelectorAll('.dsh-aff-sd-maction')) {
          el.setAttribute('aria-busy', value ? 'true' : 'false')
        }
      }
      const fail = (button, e) => {
        console.error('[next-ui-diagnostic] dsh-aff: 操作失败：', e)
        if (button) {
          button.classList.add('dsh-aff-sd-failed')
          button.title = `操作失败：${e && e.message ? e.message : e}`
          window.setTimeout(() => {
            button.classList.remove('dsh-aff-sd-failed')
            button.removeAttribute('title')
          }, 6000)
        }
      }

      const guard = (tag, button) => {
        if (busy) {
          return null
        }
        const row = currentSessionRow()
        if (!row?.id) {
          return null
        }
        if (row.running) {
          fail(button, new Error('会话正在运行，请等当前回合结束'))
          return null
        }
        return row.id
      }

      // ── 内联编辑（v21）：点击铅笔后，消息原地变成编辑框 ──────────────────
      // 布局参考 ZCode 的 ChatPromptEditor：附件 chips 区 + 自增高 textarea +
      // 底部工具栏（左提示、右 取消/发送）。支持拖入文件与粘贴图片：
      //   图片（png/jpeg/webp/gif）→ base64 内联进 prompt content
      //   其他文件 → fileUpload.upload(childId, …) 取 receiptId 进 prompt content
      let editing = null

      const teardownEdit = () => {
        if (!editing) return
        editing.stopWatchdog?.()
        editing.flowItem.classList.remove('dsh-aff-sd-editing')
        editing.editor.remove()
        for (const att of editing.files) {
          if (att.objectUrl) URL.revokeObjectURL(att.objectUrl)
        }
        editing = null
      }

      const readFileBase64 = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result ?? '')
          const index = result.indexOf(',')
          resolve(index === -1 ? '' : result.slice(index + 1))
        }
        reader.onerror = () => reject(new Error(`读取失败：${file.name}`))
        reader.readAsDataURL(file)
      })

      const addEditorFiles = async (fileList) => {
        if (!editing) return
        for (const file of fileList) {
          if (editing.files.length >= 10) {
            editing.setHint('附件最多 10 个')
            break
          }
          if (file.size > 8 * 1024 * 1024) {
            editing.setHint(`文件超过 8MB：${file.name || '未命名'}`)
            continue
          }
          const isImage = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)
          const att = {
            file,
            name: file.name || '图片.png',
            image: isImage,
            mediaType: isImage ? file.type : null,
            base64: null,
            objectUrl: isImage ? URL.createObjectURL(file) : null,
          }
          if (isImage) {
            try {
              att.base64 = await readFileBase64(file)
            } catch (e) {
              editing.setHint(e.message)
              continue
            }
          }
          editing.files.push(att)
        }
        editing.renderChips()
      }

      const enterEdit = async (turn, button) => {
        const sessionId = guard('edit', button)
        if (!sessionId) return
        setBusy(true)
        let info
        try {
          info = await postJson(ROUTE + '/session-turn-info', { sessionId, turn })
        } catch (e) {
          setBusy(false)
          fail(button, e)
          return
        }
        setBusy(false)
        try {
          // 用轮号**现查**消息行：点击到请求返回之间 React 可能已重渲染，
          // 点击时捕获的节点可能已被替换（挂上去就"隐身"了）
          const flowItem =
            document.querySelector(`[data-chat-flow-kind="user"][data-chat-turn="${turn}"], [data-chat-flow-kind="steering"][data-chat-turn="${turn}"]`) ??
            button.closest(HUMAN_FLOW)
          if (!flowItem || !flowItem.isConnected) {
            fail(button, new Error('未定位到该消息'))
            return
          }
          openEditor(flowItem, sessionId, info)
        } catch (e) {
          fail(button, e)
        }
      }

      // 在指定的消息行上打开内联编辑框（enterEdit 与回滚后的自动编辑共用）
      const openEditor = (flowItem, sessionId, info) => {
        if (editing) teardownEdit()

        const editor = document.createElement('div')
        editor.className = 'dsh-aff-sd-editor'
        const chips = document.createElement('div')
        chips.className = 'dsh-aff-sd-atts'
        const textarea = document.createElement('textarea')
        textarea.className = 'dsh-aff-sd-edit-textarea'
        textarea.value = info.userText ?? ''
        textarea.placeholder = '输入修改后的消息'
        const bar = document.createElement('div')
        bar.className = 'dsh-aff-sd-edit-bar'
        const hint = document.createElement('span')
        hint.className = 'dsh-aff-sd-edit-hint'
        hint.textContent = '可拖入文件或粘贴图片，Enter 发送，Shift+Enter 换行'
        const actions = document.createElement('div')
        actions.className = 'dsh-aff-sd-edit-actions'
        const cancelBtn = document.createElement('button')
        cancelBtn.type = 'button'
        cancelBtn.className = 'dsh-aff-sd-action'
        cancelBtn.textContent = '取消'
        const sendBtn = document.createElement('button')
        sendBtn.type = 'button'
        sendBtn.className = 'dsh-aff-sd-send'
        sendBtn.textContent = '发送'
        actions.append(cancelBtn, sendBtn)
        bar.append(hint, actions)
        editor.append(chips, textarea, bar)

        const state = {
          flowItem,
          turn: info.turn,
          sessionId, info, editor, textarea, sendBtn,
          files: [],
        }
        state.setHint = (message) => {
          hint.textContent = message
          window.setTimeout(() => {
            if (editing === state) hint.textContent = '可拖入文件或粘贴图片，Enter 发送，Shift+Enter 换行'
          }, 4000)
        }
        state.renderChips = () => {
          chips.textContent = ''
          editing.files.forEach((att, index) => {
            const chip = document.createElement('div')
            chip.className = att.image ? 'dsh-aff-sd-att dsh-aff-sd-att-img' : 'dsh-aff-sd-att'
            if (att.image && att.objectUrl) {
              const img = document.createElement('img')
              img.className = 'dsh-aff-sd-att-thumb'
              img.src = att.objectUrl
              img.alt = att.name
              chip.appendChild(img)
            } else {
              const name = document.createElement('span')
              name.className = 'dsh-aff-sd-att-name'
              name.textContent = att.name
              name.title = att.name
              chip.appendChild(name)
            }
            const remove = document.createElement('button')
            remove.type = 'button'
            remove.className = 'dsh-aff-sd-att-remove'
            remove.textContent = '×'
            remove.setAttribute('aria-label', '移除附件')
            remove.addEventListener('click', (ev) => {
              ev.stopPropagation()
              if (!editing) return
              editing.files.splice(index, 1)
              if (att.objectUrl) URL.revokeObjectURL(att.objectUrl)
              editing.renderChips()
            })
            chip.appendChild(remove)
            chips.appendChild(chip)
          })
          chips.style.display = editing.files.length > 0 ? '' : 'none'
        }
        editing = state

        textarea.addEventListener('input', () => {
          textarea.style.height = 'auto'
          textarea.style.height = Math.min(textarea.scrollHeight, window.innerHeight * 0.4) + 'px'
        })
        textarea.addEventListener('keydown', (ev) => {
          if (ev.key === 'Escape') {
            ev.preventDefault()
            ev.stopPropagation()
            teardownEdit()
            return
          }
          // 中文输入法组字过程中的 Enter 不触发发送
          if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
            ev.preventDefault()
            void submitEdit()
          }
        })
        textarea.addEventListener('paste', (ev) => {
          const files = [...(ev.clipboardData?.files ?? [])]
          if (files.length > 0) {
            ev.preventDefault()
            void addEditorFiles(files)
          }
        })
        editor.addEventListener('dragover', (ev) => {
          if (![...(ev.dataTransfer?.types ?? [])].includes('Files')) return
          ev.preventDefault()
          ev.dataTransfer.dropEffect = 'copy'
          editor.classList.add('dsh-aff-sd-drag')
        })
        editor.addEventListener('dragleave', () => editor.classList.remove('dsh-aff-sd-drag'))
        editor.addEventListener('drop', (ev) => {
          ev.preventDefault()
          editor.classList.remove('dsh-aff-sd-drag')
          const files = [...(ev.dataTransfer?.files ?? [])]
          if (files.length > 0) void addEditorFiles(files)
        })
        cancelBtn.addEventListener('click', () => teardownEdit())
        sendBtn.addEventListener('click', () => void submitEdit())

        flowItem.classList.add('dsh-aff-sd-editing')
        flowItem.appendChild(editor)
        editing.renderChips()
        textarea.focus()
        textarea.style.height = Math.min(textarea.scrollHeight, window.innerHeight * 0.4) + 'px'
        textarea.setSelectionRange(textarea.value.length, textarea.value.length)

        // 看门狗：React 重渲染可能替换消息行节点（class 也会被重置）。
        // 定时核对编辑器是否还挂在"活的"消息行上，不在就搬迁过去——
        // 否则编辑框会挂在已脱离文档的旧节点上，表现为"点编辑没反应"。
        const ensureAttached = () => {
          if (editing !== state) return
          const live = document.querySelector(`[data-chat-flow-kind="user"][data-chat-turn="${info.turn}"], [data-chat-flow-kind="steering"][data-chat-turn="${info.turn}"]`)
          if (!live || !live.isConnected) return
          if (live !== state.flowItem) {
            state.flowItem.classList.remove('dsh-aff-sd-editing')
            state.flowItem = live
            live.appendChild(state.editor)
          } else if (!live.contains(state.editor)) {
            live.appendChild(state.editor)
          }
          if (!live.classList.contains('dsh-aff-sd-editing')) live.classList.add('dsh-aff-sd-editing')
        }
        const watchdog = window.setInterval(ensureAttached, 300)
        state.stopWatchdog = () => window.clearInterval(watchdog)
      }

      const submitEdit = async () => {
        if (!editing || busy) return
        const text = editing.textarea.value
        const files = [...editing.files]
        if (!text.trim() && files.length === 0) return
        const { sessionId, info, sendBtn, textarea } = editing
        setBusy(true)
        sendBtn.setAttribute('aria-busy', 'true')
        textarea.setAttribute('readonly', 'readonly')
        try {
          await postJson(ROUTE + '/session-files-restore', {
            sessionId,
            keepSeq: typeof info.beforeSeq === 'number' ? info.beforeSeq : -1,
          })
          const childId = await openTruncatedChild(sessionId, info.beforeSeq)
          await pluginCtx.uiWorkspace.openSession(childId)
          await clearInheritedQueue(childId)
          const parts = []
          for (const att of files) {
            if (att.image) {
              parts.push({ type: 'image', mediaType: att.mediaType, data: att.base64, name: att.name })
            } else {
              const uploaded = await pluginCtx.fileUpload.upload(childId, att.file, att.file.name)
              const receiptId = uploaded?.receiptId ?? uploaded?.value?.receiptId
              if (!receiptId) throw new Error(`文件上传失败：${att.name}`)
              parts.push({ type: 'file', receiptId })
            }
          }
          if (text.trim()) parts.push({ type: 'text', text })
          await promptChild(childId, parts)
          teardownEdit()
          await postJson(ROUTE + '/session-replace', { sessionId })
          setBusy(false)
        } catch (e) {
          // 失败保持编辑框打开，可修改后重试
          setBusy(false)
          sendBtn.setAttribute('aria-busy', 'false')
          textarea.removeAttribute('readonly')
          fail(sendBtn, e)
        }
      }

      // 撤销此轮：先取 turn 元信息（含将被回滚的文件清单）再弹确认框
      const openUndo = async (turn, button) => {
        const sessionId = guard('undo', button)
        if (!sessionId) return
        if (editing) teardownEdit()
        setBusy(true)
        let info
        try {
          info = await postJson(ROUTE + '/session-turn-info', { sessionId, turn })
        } catch (e) {
          setBusy(false)
          fail(button, e)
          return
        }
        setBusy(false)
        const files = Array.isArray(info.files) ? info.files : []
        const shown = files.slice(0, 8)
        const more = files.length - shown.length
        // 无文件时只留问句，不显示"以下已修改文件…"那行
        const description = shown.length === 0
          ? '确认回滚到本轮对话吗？'
          : `确认回滚到本轮对话吗？以下已修改文件将会被回滚：\n${shown.join('\n')}${more > 0 ? `\n…另有 ${more} 个文件` : ''}`
        // 勾选框：默认选中=回滚文件；取消勾选则只回滚对话、保留文件
        const checkbox = files.length === 0
          ? null
          : { label: '同时回滚已修改的文件', initial: true }
        seSetDialog({
          title: '撤销此轮',
          description,
          confirmLabel: '撤销',
          checkbox,
          onConfirm: async (text, checked) => {
            setBusy(true)
            try {
              await doUndoTurn(sessionId, info, checked !== false)
              setBusy(false)
            } catch (e) {
              setBusy(false)
              fail(button, e)
            }
          },
        })
      }

      // 删除消息（v42）：只删除这条消息及其后的对话，文件保持不动
      const openDeleteMessage = (turn, button) => {
        const sessionId = guard('delete', button)
        if (!sessionId) return
        if (editing) teardownEdit()
        seSetDialog({
          title: '删除消息',
          description: '确认删除此消息吗？\n已修改文件将会保留，不会被删除/回滚。',
          confirmLabel: '删除',
          onConfirm: async () => {
            setBusy(true)
            try {
              const info = await postJson(ROUTE + '/session-turn-info', { sessionId, turn })
              await doDeleteMessage(sessionId, info)
              setBusy(false)
            } catch (e) {
              setBusy(false)
              fail(button, e)
            }
          },
        })
      }

      const makeButton = (kind, turn) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'dsh-aff-sd-maction'
        button.setAttribute('aria-busy', busy ? 'true' : 'false')
        if (kind === 'edit') {
          button.setAttribute('aria-label', '编辑重发这条消息')
          button.innerHTML = SE_PENCIL_SVG
          attachTooltip(button, () => '编辑消息')
          button.addEventListener('click', (ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            void enterEdit(turn, button)
          })
        } else if (kind === 'delete') {
          button.setAttribute('aria-label', '删除这条消息（不回滚文件）')
          button.innerHTML = SE_TRASH_SVG
          attachTooltip(button, () => '删除消息')
          button.addEventListener('click', (ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            openDeleteMessage(turn, button)
          })
        } else {
          button.setAttribute('aria-label', '撤销这条消息及其后的对话')
          button.innerHTML = SE_RESTORE_SVG
          attachTooltip(button, () => '撤销此轮')
          button.addEventListener('click', (ev) => {
            ev.preventDefault()
            ev.stopPropagation()
            void openUndo(turn, button)
          })
        }
        return button
      }

      // 在未处理的用户消息操作行（复制按钮后）插入按钮组
      // （编辑态的存活由 openEditor 的看门狗维护，这里只负责补挂按钮）
      const scan = () => {
        const rows = document.querySelectorAll('div[data-clock="start"]')
        for (const row of rows) {
          if (row.querySelector('.dsh-aff-sd-mactions')) continue
          const owner = row.closest(HUMAN_FLOW)
          if (!owner) continue
          const turn = Number(owner.getAttribute('data-chat-turn'))
          if (!Number.isSafeInteger(turn) || turn < 1) continue
          const copyButton = row.querySelector('button')
          const group = document.createElement('span')
          group.className = 'dsh-aff-sd-mactions'
          // 顺序（应用户要求）：复制 → 撤销（中间）→ 编辑 → 删除
          group.appendChild(makeButton('undo', turn))
          group.appendChild(makeButton('edit', turn))
          group.appendChild(makeButton('delete', turn))
          if (copyButton) copyButton.after(group)
          else row.appendChild(group)
        }
      }

      // React 重渲染会抹掉注入节点；观察 DOM 变化自动补挂
      let queued = false
      const observer = new MutationObserver(() => {
        if (queued) return
        queued = true
        queueMicrotask(() => {
          queued = false
          try {
            scan()
          } catch (e) {
            console.warn('[next-ui-diagnostic] dsh-aff: 注入扫描异常：', e.message)
          }
        })
      })
      observer.observe(document.body, { childList: true, subtree: true })
      scan()
      return () => observer.disconnect()
    }

    // =====================================================================
    // Entry
    // =====================================================================

    // Must be a plain array: the cordis loader reads `exports.inject` to decide
    // which client services reach `ctx`; a function form was verified not to work.
    //
    // The five extra services arrived with the session-manager half and are used
    // ONLY by the transcript button injector — nothing else here touches them:
    //
    //   sessions     -> list.getSnapshot() to find the open session, fork() to
    //                   truncate, create() for a first-turn undo, binding() to
    //                   reach the child's prompt()/updateQueue()
    //   uiWorkspace  -> openSession() to switch to the truncated child
    //   workspaces   -> list.getSnapshot().items to keep a new session in the
    //                   same workspace as the one being replaced
    //   fileUpload   -> upload() for attachments typed into the inline editor
    //
    // 🔴 WITHOUT THESE THE INJECTOR DEGRADES, IT DOES NOT CRASH: every call site
    // is optional-chained or guarded, so a host that withholds one service makes
    // that one button report "not available" instead of taking the plugin down.
    exports.inject = ["slots", "sessions", "uiWorkspace", "workspaces", "fileUpload"];

    exports.apply = function (ctx) {
      if (typeof document === "undefined") return;

      // Stash the context for helpers that are not slot components (the
      // ungrouped card's current-session lookup). Assigned before any slot
      // registration so a card mounted during the first render can already
      // read it.
      affPluginCtx = ctx || null;

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

          // One-click continuation into a fresh window. Ordered right after the
          // copy row: it is a "hand this conversation over" action, so it reads
          // naturally next to the other handover row and stays far from delete.
          ctx.slots.inject("sidebar.workspaces.session.menu.item", function () {
            return ctx.slots.register({
              name: "sidebar.workspaces.session.menu.item",
              id: "aff-continue",
              order: 520,
            }, ContinueSessionMenuItem);
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
          // Confirmation dialog host. `shell.overlay` is the one official slot
          // that renders above everything and outside the sidebar, which is
          // what a modal needs. It renders `null` while nothing is pending, so
          // mounting it unconditionally costs nothing.
          //
          // 🔴 THIS IS THE ONLY NEW SLOT. The upstream plugin also registered a
          // delete row-action and a delete menu item; both were dropped on
          // purpose — `aff-delete` above is the single delete affordance and
          // carries stronger guards. The dialog is kept because edit/undo need
          // a confirmation surface, and reusing the upstream one avoids a
          // second modal implementation.
          ctx.slots.inject("shell.overlay", function () {
            diag("shell.overlay owner mounted: registering confirm dialog");
            return ctx.slots.register({
              name: "shell.overlay",
              id: "aff-session-confirm",
              order: 100,
            }, SessionDeleteDialog);
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

      // ---------------------------------------------------------------------
      // Session-manager effects
      //
      // All three are `ctx.effect` calls, i.e. they must be registered for the
      // lifetime of the plugin and torn down on unload. `ctx.effect` is not
      // present in every embedding (the offline probe runs `apply` against a
      // bare `{ slots }`), so the whole group is guarded rather than assumed —
      // a missing `effect` must cost the transcript buttons, not the plugin.
      // ---------------------------------------------------------------------
      if (typeof ctx.effect === "function") {
        // The stylesheet for every `dsh-aff-sd-*` class. It is a SEPARATE
        // <style> from the toast/filter sheets and carries
        // `data-plugin="dsh-archive-favorites-forge"` because
        // `installHoverCardSuppression` locates it by that attribute to append
        // its `body:has()` rule. Two elements with the attribute would make the
        // suppression land in an arbitrary one, so nothing else may use it.
        ctx.effect(function () {
          var style = document.createElement("style");
          style.setAttribute("data-plugin", "dsh-archive-favorites-forge");
          style.textContent = SE_CSS;
          document.head.appendChild(style);
          return function () { style.remove(); };
        }, "dsh-archive-favorites-forge: session-manager styles");

        // The transcript buttons. This owns a MutationObserver on <body>, which
        // is why it must be an effect: a hot reload would otherwise leave the
        // previous observer injecting a second set of buttons on every render.
        ctx.effect(function () {
          return injectTurnActions(ctx);
        }, "dsh-archive-favorites-forge: turn-actions");

        // Hover-card suppression needs the Harness stylesheet to exist before it
        // can find the hover-card rule, and that sheet is injected after the
        // plugin boots. Six attempts one second apart cover the observed range
        // without polling forever; giving up is silent because the only cost is
        // the hover card overlapping the tooltip.
        ctx.effect(function () {
          var attempts = 0;
          var timer = 0;
          var tryInstall = function () {
            attempts += 1;
            if (installHoverCardSuppression()) return;
            if (attempts < 6) timer = window.setTimeout(tryInstall, 1000);
          };
          tryInstall();
          return function () { if (timer) window.clearTimeout(timer); };
        }, "dsh-archive-favorites-forge: hovercard-suppress");
      } else {
        diag("apply: ctx.effect MISSING - transcript buttons and styles skipped");
      }

      diag("apply: done");
    };

    return module.exports;
  },
});
