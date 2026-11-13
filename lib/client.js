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

    /**
     * NDJSON 流式 POST（快照删除进度）。
     *
     * 宿主契约（见 index.js 的 putCleanupJob 上方注释）：`stream:true` 时响应体
     * 是 `application/x-ndjson`，每行一个 JSON：
     *   {type:"start"|"progress"|"done", phase, done, total, bytesFreed,
     *    bytesTotal, current, jobId, result?}
     *
     * 三层降级，保证**任何**一层出问题都不会让用户卡在「没有反馈」：
     *   ① body.getReader() 边到边解析（正常路径，进度是真流式的）；
     *   ② 没有 getReader（老渲染器）→ res.text() 一次性拿到全部行再逐行回放，
     *      用户最后仍能看到完整结果；
     *   ③ 网络/解析异常 → onError 交回页面，页面再去轮询
     *      /snapshot-cleanup-progress?jobId=…。
     */
    function apiStream(route, body, handlers) {
      var options = handlers || {};
      var onLine = typeof options.onLine === "function" ? options.onLine : function () {};
      var init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      };
      function handleLine(line) {
        var text = String(line || "").trim();
        if (text.length === 0) return;
        var parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          return;
        }
        onLine(parsed);
      }
      return fetch(ROUTE + route, init).then(function (res) {
        if (!res.ok) {
          return res.json().catch(function () { return {}; }).then(function (payload) {
            throw new Error((payload && payload.error) || ("HTTP " + res.status));
          });
        }
        var reader = res.body && typeof res.body.getReader === "function" ? res.body.getReader() : null;
        if (!reader) {
          return res.text().then(function (text) {
            String(text || "").split("\n").forEach(handleLine);
            return true;
          });
        }
        var decoder = new TextDecoder("utf-8");
        var buffer = "";
        function pump() {
          return reader.read().then(function (step) {
            if (step.done) {
              var rest = buffer + decoder.decode();
              buffer = "";
              rest.split("\n").forEach(handleLine);
              return true;
            }
            buffer += decoder.decode(step.value, { stream: true });
            var newlineAt = buffer.indexOf("\n");
            while (newlineAt >= 0) {
              handleLine(buffer.slice(0, newlineAt));
              buffer = buffer.slice(newlineAt + 1);
              newlineAt = buffer.indexOf("\n");
            }
            return pump();
          });
        }
        return pump();
      });
    }

    // ---- job-backed operations, one shared kit ----------------------------
    //
    // 删除归档 / 批量归档 / 幽灵缓存清理三处都改成「接单即回执 + job 快照 +
    // 轮询」之后，共用同一套客户端件：三份各写一遍只会慢慢长歪，而用户的要求
    // 恰恰是「和快照清理那条保持一致」。
    //
    // 宿主契约（与快照清理共用同一条读取路由）：
    //   {type:"start"|"progress", done, total, bytesFreed, bytesTotal, phase, current}
    //   {type:"done", result:{...}}
    //   {type:"error", error:"..."}
    //
    // 🔴 老宿主不认识 stream：它会照旧回一整包 JSON（**没有 type 字段**）。这种
    // 回执必须直接当最终结果收下 —— 否则后端还没换新的过渡期里三张卡都点不动。

    function jobIdFor(prefix) {
      return String(prefix || "job") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    }

    /** 一组表格行的「整会话目录」字节合计；纯现算，不新增任何请求。 */
    function sumRowBytes(rows) {
      var list = Array.isArray(rows) ? rows : [];
      var total = 0;
      for (var i = 0; i < list.length; i += 1) total += Number(list[i] && list[i].bytes) || 0;
      return total;
    }

    /**
     * 轮询一条 job 的快照。
     *
     * 与快照卡里那份 pollProgress 同一条路由、同一套判死口径：400ms 一次，
     * 指纹 `done|bytesFreed|phase` 不变超过 90 秒就停止监视并置 stalled，绝不
     * 把「慢」当成「失败」；查不到 job 最多等 6 秒再报错（TTL 过期或老宿主）。
     * 快照卡那份是组件内嵌函数，另外三张卡够不到，所以这里放一份模块级的。
     */
    function pollJob(jobId, handlers) {
      var hooks = handlers || {};
      var stopped = false;
      var timer = null;
      var startedAt = Date.now();
      var lastProgressAt = Date.now();
      var lastFingerprint = "";
      var notFoundAt = 0;
      var STALL_MS = 90 * 1000;
      var TOTAL_MS = 10 * 60 * 1000;
      var TICK_MS = 400;
      function stop() {
        stopped = true;
        if (timer) { clearTimeout(timer); timer = null; }
      }
      function tick() {
        if (stopped) return;
        fetch(ROUTE + "/snapshot-cleanup-progress?jobId=" + encodeURIComponent(jobId))
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (stopped) return;
            var job = data && data.ok === true ? data.job : null;
            if (!job) {
              if (!notFoundAt) notFoundAt = Date.now();
              if (Date.now() - notFoundAt > 6000) {
                stop();
                if (typeof hooks.onFail === "function") hooks.onFail(new Error("宿主没有这个任务（可能已过期，或旧版宿主不支持进度查询）"));
                return;
              }
              timer = setTimeout(tick, TICK_MS);
              return;
            }
            notFoundAt = 0;
            var snap = {
              done: Number(job.done) || 0,
              total: Number(job.total) || 0,
              bytesFreed: Number(job.bytesFreed) || 0,
              bytesTotal: Number(job.bytesTotal) || 0,
              phase: String(job.phase || ""),
              current: job.current === undefined ? null : job.current,
              jobId: jobId,
            };
            if (typeof hooks.onProgress === "function") hooks.onProgress(snap);
            var fingerprint = snap.done + "|" + snap.bytesFreed + "|" + snap.phase;
            var now = Date.now();
            if (fingerprint !== lastFingerprint) {
              lastFingerprint = fingerprint;
              lastProgressAt = now;
            }
            if (job.state === "done") {
              stop();
              if (typeof hooks.onDone === "function") hooks.onDone(job.result || null);
              return;
            }
            if (job.state === "error") {
              stop();
              if (typeof hooks.onFail === "function") hooks.onFail(new Error(job.error || "操作失败"));
              return;
            }
            if (now - lastProgressAt > STALL_MS || now - startedAt > TOTAL_MS) {
              stop();
              if (typeof hooks.onProgress === "function") hooks.onProgress(Object.assign({}, snap, { phase: "stalled" }));
              return;
            }
            timer = setTimeout(tick, TICK_MS);
          })
          .catch(function () {
            if (!stopped) timer = setTimeout(tick, TICK_MS);
          });
      }
      timer = setTimeout(tick, TICK_MS);
      return stop;
    }

    /**
     * 发一个「可能要很久」的写操作，把三种宿主形态都吃下来：
     *   1. 新宿主 + stream：NDJSON 逐行 progress / done；
     *   2. 新宿主但流被截断：流结束仍未 settle → 转 pollJob 取权威结果；
     *   3. 老宿主：一整包 JSON（无 type）→ 直接当结果。
     * HTTP 失败（409 之类）由 apiStream 抛出来，在 catch 里收口，绝不转轮询
     * 空等 —— 宿主压根没建 jobId，轮询只会多绕 6 秒再报个更难懂的错误。
     */
    function runJob(route, body, options) {
      var opts = options || {};
      var jobId = opts.jobId ? String(opts.jobId) : "";
      var settled = false;
      var stopPoll = null;
      function onSnapshot(snap) {
        if (settled) return;
        if (typeof opts.onProgress === "function") opts.onProgress(snap);
      }
      function finish(result) {
        if (settled) return;
        settled = true;
        if (stopPoll) stopPoll();
        if (typeof opts.onDone === "function") opts.onDone(result);
      }
      function fail(error) {
        if (settled) return;
        settled = true;
        if (stopPoll) stopPoll();
        if (typeof opts.onFail === "function") opts.onFail(error instanceof Error ? error : new Error(String(error)));
      }
      function toPoll() {
        if (!jobId || stopPoll || settled) return;
        stopPoll = pollJob(jobId, { onProgress: onSnapshot, onDone: finish, onFail: fail });
      }
      var payload = {};
      if (body && typeof body === "object") {
        Object.keys(body).forEach(function (key) { payload[key] = body[key]; });
      }
      if (jobId) {
        payload.stream = true;
        payload.jobId = jobId;
      }
      apiStream(route, payload, {
        onLine: function (line) {
          if (!line || typeof line !== "object") return;
          var type = line.type;
          if (type === "error") {
            fail(new Error(String(line.error || "操作失败")));
            return;
          }
          if (type === "start" || type === "progress") {
            onSnapshot({
              done: Number(line.done) || 0,
              total: Number(line.total) || 0,
              bytesFreed: Number(line.bytesFreed) || 0,
              bytesTotal: Number(line.bytesTotal) || 0,
              phase: String(line.phase || ""),
              current: line.current === undefined ? null : line.current,
              jobId: jobId,
            });
            return;
          }
          if (type === "done") {
            finish(line.result || line);
            return;
          }
          if (type === undefined) finish(line);
        },
      }).then(function () {
        if (!settled) toPoll();
      }).catch(function (error) {
        if (settled) return;
        fail(error);
      });
      return { stop: function () { if (stopPoll) stopPoll(); } };
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

    /**
     * Normalised membership map, rebuilt lazily after the set changes.
     *
     * 🔴 WHY A CACHE. The old `isFavorite` looped the whole favourites object
     * and re-normalised every id on every call. It is called once per archived
     * row (309 on the author's machine) and once per rendered row, so opening
     * the settings page burned ~23k string operations before it had drawn
     * anything. `setFavorites` is the only writer of `favSet`, so nulling the
     * cache there is the whole invalidation story.
     */
    var favKeyCache = null;
    function favoriteKeySet() {
      if (favKeyCache !== null) return favKeyCache;
      var keys = {};
      for (var id in favSet) {
        if (Object.prototype.hasOwnProperty.call(favSet, id)) keys[idKey(id)] = true;
      }
      favKeyCache = keys;
      return keys;
    }

    function isFavorite(sessionId) {
      return favoriteKeySet()[idKey(sessionId)] === true;
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
      // Invalidation for `favoriteKeySet()`. This is the only writer of favSet.
      favKeyCache = null;
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

    // durationMs 可选：撤销/删除这类"必须看见"的提示要比普通复制提示停久一点。
    /**
     * 0.42.4 — 单独删掉某个「收藏」会话的快照（对话本身保留）。
     *
     * 走宿主的 POST /snapshot-forget —— 这是唯一允许对收藏项动手的快照入口，
     * 与批量 /snapshot-cleanup 的「收藏一律拒绝」互不影响。只删
     * <session>/history-file/ 那份历史，目录进 Windows 回收站可恢复。
     */
    function forgetFavoriteSnapshot(id, title, bytes) {
      var label = title ? "「" + title + "」" : "这个会话";
      var ok = window.confirm("删除" + label + "的快照？\n\n只删「撤销到某一轮」用的历史快照，对话本身和磁盘上的文件都保留。\n目录会进 Windows 回收站，可以恢复。");
      if (!ok) return Promise.resolve(null);
      return api("/snapshot-forget", { sessionId: id, confirm: true }).then(function (data) {
        if (data && data.ok === true) {
          var freed = (data.result && Number(data.result.bytesFreed) > 0) ? "（释放 " + humanBytes(data.result.bytesFreed) + "）" : "";
          toast("已删除快照" + freed, 3200);
        } else {
          toast("删除失败：" + ((data && (data.error || data.code)) || "宿主没有响应"), 4200);
        }
        return data;
      }).catch(function (error) {
        toast("删除失败：" + (error && error.message ? error.message : "网络错误"), 4200);
        return null;
      });
    }

    function toast(message, durationMs) {
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
        }, typeof durationMs === "number" && durationMs > 0 ? durationMs : 2400);
      } catch (e) {}
    }

    // ---- session info ----------------------------------------------------

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
    // ★ Star entry (0.40.0)
    //
    // The repository URL is NEVER hard-coded in this bundle: the host reads it
    // out of package.json (`repository.url`, falling back to `homepage`) and
    // serves it on GET /status as `repositoryUrl`. A bundle-embedded constant
    // would keep pointing at a renamed/transferred repo forever, and the point
    // of the button is to reach the REAL repository the user installed from.
    //
    // Opening goes through the host (POST /open-external → Electron
    // `shell.openExternal`, falling back to the platform opener) instead of a
    // renderer `window.open()`, because in the desktop shell a renderer popup
    // can be swallowed/blocked and gives no feedback either way. The browser
    // build (no Electron) gets window.open as a second-chance fallback.
    // =====================================================================

    // probed = the host answered /status at least once. It distinguishes
    // 「宿主还没提供这个字段」(old host, needs a full restart) from 「连宿主都
    // 没答上来」, because those two need different advice and the local
    // cluster-upgrade order makes the first case very common: the client bundle
    // is hot-swapped into a still-running host, so the bundle can be new while the
    // host keeps serving old code. (Windows desktop binds no page-reload keyboard
    // shortcut; a full reload is the desktop menu's "Reload Interface", and the
    // host hot-swaps client bundles anyway.)
    var repoUrlProbe = { url: "", probed: false };

    function loadRepositoryUrl() {
      if (repoUrlProbe.url || repoUrlProbe.probed) return Promise.resolve(repoUrlProbe);
      return api("/status").then(function (data) {
        repoUrlProbe = {
          url: data && data.ok === true && typeof data.repositoryUrl === "string"
            ? data.repositoryUrl
            : "",
          probed: true,
        };
        return repoUrlProbe;
      }).catch(function () { return { url: "", probed: false }; });
    }

    function openExternalFallback(url) {
      try {
        window.open(url, "_blank", "noopener,noreferrer");
        return true;
      } catch (e) {
        return false;
      }
    }

    function openExternalLink(url) {
      return api("/open-external", { url: url }).then(function (data) {
        if (data && data.ok === true) return true;
        return openExternalFallback(url);
      }).catch(function () {
        return openExternalFallback(url);
      });
    }

    function openRepository(kind) {
      var where = kind === "fav" ? "收藏清单" : "归档助手";
      return loadRepositoryUrl().then(function (probe) {
        if (!probe || !probe.url) {
          toast(probe && probe.probed === true
            ? "宿主还没有提供仓库地址：彻底退出 DSH 再启动一次之后，★ Star 就能用了"
            : "读不到宿主 /status，暂时无法打开 GitHub");
          return false;
        }
        return openExternalLink(probe.url).then(function (ok) {
          if (!ok) toast("打开 GitHub 失败：" + probe.url);
          else diag("star: opened " + probe.url + " from " + where);
          return ok;
        });
      });
    }

    // ---------------------------------------------------------------------
    // GEOMETRIC FIVE-POINTED STAR — inline SVG, deliberately NOT a glyph.
    //
    // WHY THE ★/☆ GLYPHS HAD TO GO (the reported 「收藏星标不对称」).
    // They are font glyphs, so three properties are decided by whichever font
    // wins the fallback chain, and none of them can be measured from a client
    // bundle:
    //   * the ink is placed against the BASELINE, not the middle of the line
    //     box, so `align-items:center` centres a 13px line box and leaves the
    //     star riding high inside its button;
    //   * ★ (U+2605) and ☆ (U+2606) do not share an advance width, so the
    //     solid/outline swap also slides the icon sideways;
    //   * ink-to-em ratio differs per font, so the same `font-size` renders at
    //     different optical sizes across the light/dark font stacks.
    // An SVG has none of those variables: the element box IS the icon box, and
    // both states below share ONE vertex list, so starring a row cannot move
    // or resize the star.
    //
    // CENTRED BY BOUNDING BOX, NOT BY VERTEX CENTRE. A five-pointed star is
    // not vertically symmetric about its centre point: with outer radius R the
    // top point reaches R above the centre while the two lower points reach
    // only R·sin(54°) = 0.80902·R below it. Centring the vertex would lift the
    // ink by (R − 0.80902R)/2 = 0.09549·R; at R = 6.4 that is 0.6111px of
    // upward bias — small enough to look like a rendering bug. The vertex list
    // is therefore shifted down by that 0.6111 and the bounding box lands dead
    // centre of the 16-unit viewBox:
    //   ink x ∈ [1.9132, 14.0868] → 1.9132 left / 1.9132 right (mirror)
    //   ink y ∈ [2.2111, 13.7889] → 2.2111 top  / 2.2111 bottom
    //   ink centre = (8.0000, 8.0000) = viewBox centre, exactly.
    // The path below is that computation written out (tips at -90°+72k,
    // valleys at -90°+36°+72k, r = R·0.382, re-checkable to 1e-4).
    // ---------------------------------------------------------------------
    function starIcon(filled, size) {
      var s = size || 16;
      return React.createElement("svg", {
        width: s, height: s, viewBox: "0 0 16 16",
        "aria-hidden": "true", focusable: "false",
        style: { display: "block", flex: "none" },
      }, React.createElement("path", {
        d: "M8.00 2.21L9.44 6.63L14.09 6.63L10.33 9.37L11.76 13.79L8.00 11.06L4.24 13.79L5.67 9.37L1.91 6.63L6.56 6.63Z",
        // Filled = favourited (painted with the caller's `color`, which is the
        // theme foreground — monochrome on purpose, never gold), outline = not
        // favourited. The outline grows by half the stroke width on every side,
        // which keeps it centred; it still shares the filled state's vertices,
        // so the two states cannot drift apart.
        fill: filled ? "currentColor" : "none",
        stroke: filled ? "none" : "currentColor",
        strokeWidth: filled ? 0 : 1.1,
        strokeLinejoin: "round",
      }));
    }

    /**
     * 「★ Star」按钮。放在卡片标题右侧，不抢主操作（统计/刷新）的视觉位置。
     * hover 提示写死成一句话：用户问过「这个星是干嘛的」，所以 title 直接回答。
     */
    function StarButton(props) {
      var compact = props && props.compact === true;
      var kind = props && typeof props.kind === "string" ? props.kind : "";
      var style = Object.assign({}, BTN_STYLE, {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
      }, compact ? { padding: "3px 10px", fontSize: "12px" } : {});
      return React.createElement("button", {
        type: "button",
        style: style,
        title: "在 GitHub 上点个 Star 支持作者",
        "aria-label": "在 GitHub 上点个 Star 支持作者",
        onClick: function () { openRepository(kind); },
      },
        // 星形用 SVG 而不是 "★"：这个按钮是 inline-flex + gap:4px，居中的是
        // 13px 文字行盒；字符星形的 ink 挂在基线上、且随字体不同而偏高，
        // 与右侧「Star」文字并排时会明显歪。SVG 盒 = 图标盒，14px 图标在
        // 行内按几何中心对齐，与文字行盒中心同高（见 starIcon 注释）。
        React.createElement("span", {
          key: "s",
          "aria-hidden": "true",
          // 黑白：跟随按钮自身的前景色（原来这里是 #e3b341 金色，已按用户
          // 2026-11-10 的硬规则去掉，本插件内不再出现金色/琥珀色）。
          style: { display: "inline-flex", color: "currentColor", flex: "none" },
        }, starIcon(true, 14)),
        React.createElement("span", { key: "t" }, "Star"));
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
    // Menu row.
    //
    // This row has now been wrong twice, in opposite ways, so both failure
    // modes are recorded here — the second one is why the row had no hover
    // highlight while every official row did.
    //
    // 1) A BARE BUTTON COLLAPSES. `Menu` renders its `children` straight into
    //    the list viewport, which is a flex column, and every row it draws
    //    itself is a wrapper div around a button that carries
    //    `width:100%; min-height:34px; padding:6px 8px; display:flex`. A bare
    //    `<button>` dropped in beside those inherits none of it and shrinks to
    //    a near-zero box: present in the DOM, invisible and unclickable. Hence
    //    the wrapper plus the full metric set below.
    //
    // 2) MATCHING THE OFFICIAL CLASS NAMES DOES NOTHING. The first fix also
    //    copied the shipped rows' class names (`itemWrap`, `item`, `itemLabel`,
    //    `itemIcon`) on the theory that "the surrounding stylesheet is loaded
    //    by ui-primitives, so matching the class names picks up the real
    //    styling". That is false: the shipped menu is a CSS Module, so in a
    //    real build those names are hashed (`_item_4ub78_90`,
    //    `_itemWrap_4ub78_90`, `_itemIcon_4ub78_148`, `_itemLabel_4ub78_190`,
    //    verified against the shipped `index-BNyAYEM7.css`) and the literals
    //    match no rule at all. The row kept its shape only because every rule
    //    was ALSO written as inline style — and that inline
    //    `background: "transparent"` then outranked any `:hover` rule the sheet
    //    might have contributed. Net effect: correct layout, no hover
    //    highlight, which is exactly what users reported.
    //
    // Rules that follow:
    //   * layout stays INLINE, because it must survive with no stylesheet;
    //   * hover/focus colour is owned by REACT (same technique as
    //     `FavoriteRowButton`), because an inline background beats any
    //     stylesheet rule short of `!important`;
    //   * classes are our own `dsh-aff-mi*` markers, so future `:hover` work can
    //     move into this plugin's own <style> without re-learning this lesson.
    //     This also means we no longer depend on the shipped module's internals
    //     at all, which is the whole point.
    // ------------------------------------------------------------------

    function MenuRow(props) {
      // Two separate states on purpose: a mouse click focuses the button
      // without ever matching `:focus-visible`, and a row that stayed lit after
      // the pointer left would look stuck.
      var hoverPair = React.useState(false);
      var hovered = hoverPair[0];
      var setHovered = hoverPair[1];
      var focusPair = React.useState(false);
      var focusVisible = focusPair[0];
      var setFocusVisible = focusPair[1];

      var background = "transparent";
      if (hovered || focusVisible) {
        // Both tokens are defined by `@deepseek-ai/dsh-client-ui-theme`
        // (checked against the shipped bundle: 403 tokens, both present). The
        // literal fallbacks only cover an embedding that boots without a theme.
        background = props.danger
          ? "var(--dsw-alias-interactive-bg-hover-danger, rgba(255,107,107,.16))"
          : "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))";
      }

      var icon = props.icon === undefined ? null : React.createElement("span", {
        className: "dsh-aff-mi-icon",
        style: { display: "inline-flex", flex: "none", width: "14px", height: "14px", alignItems: "center", justifyContent: "center" },
      }, props.icon);

      return React.createElement("div", {
        className: "dsh-aff-mi-wrap",
        style: { position: "relative" },
      }, React.createElement("button", {
        type: "button",
        role: "menuitem",
        className: props.danger ? "dsh-aff-mi dsh-aff-mi-danger" : "dsh-aff-mi",
        style: {
          display: "flex",
          alignItems: "center",
          gap: "6px",
          width: "100%",
          minHeight: "34px",
          padding: "6px 8px",
          border: "none",
          borderRadius: "6px",
          background: background,
          cursor: "pointer",
          fontSize: "13px",
          lineHeight: "20px",
          // The error token is real; the previous literal #ff6b6b was a
          // hard-coded colour that ignored the theme.
          color: props.danger ? "var(--dsw-alias-state-error-primary, #ff6b6b)" : "inherit",
          textAlign: "left",
          // A paint that appears instantly and never fades reads as a flicker;
          // the official rows transition, so match them.
          transition: "background-color .12s ease",
        },
        onMouseEnter: function () { setHovered(true); },
        onMouseLeave: function () { setHovered(false); },
        onFocus: function (event) {
          var visible = false;
          try {
            visible = typeof event.target.matches === "function" && event.target.matches(":focus-visible");
          } catch (e) { visible = false; }
          if (visible) setFocusVisible(true);
        },
        onBlur: function () { setFocusVisible(false); },
        onClick: function (event) {
          event.stopPropagation();
          if (props.onSelect) props.onSelect();
        },
      }, icon, React.createElement("span", {
        className: "dsh-aff-mi-label",
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
          // These numbers are copied from the official row-action button this
          // star stands next to, not invented (`.wh7htW_iconButton` in
          // @deepseek-ai/dsh-client-ui-workspace):
          //   width/height 24px, margin -4px, radius --dsw-radius-xs (4px),
          //   no border, transparent bg. (The host's own colour pair is
          //   label-tertiary → hover label-primary; this star stays monochrome
          //   and uses opacity for the same resting/hover step, see below.)
          // The -4px margins matter as much as the size: the host lays the
          // action strip out as `display:inline-flex; height:20px; gap:13px`,
          // so each official button's MARGIN box is 16×16 and two neighbours
          // end up 13−4−4 = 5px apart. A bare 16×16 box with no negative margin
          // sat 13−4 = 9px from the "…" button — 4px wider than every official
          // pair — which is the second half of the "not symmetric" report: the
          // star looked off-centre in a box that was itself off-grid.
          // The icon inside stays 16px (official artwork size), so the optical
          // weight matches the shipped icons instead of filling the button.
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: "24px", height: "24px", margin: "-4px", padding: "0", border: "none",
          borderRadius: "var(--dsw-radius-xs, 4px)",
          background: "transparent", cursor: "pointer", flex: "none",
          lineHeight: "0",
          // MONOCHROME (black/white) ONLY — no gold, amber or warn token here:
          // user rule, 2026-11-10. `--dsw-alias-label-primary` resolves to
          // `var(--foreground)`, which the shipped theme defines as
          // oklch(14.5% 0 0) (near-black) in the light theme and
          // oklch(98.5% 0 0) (near-white) in the dark one, so the star follows
          // the theme instead of a hard-coded #fff/#000. Note `--dsw-alias-fg-
          // primary` does NOT exist in this build (0 hits in the shipped CSS) —
          // using it would silently fall through to the fallback.
          color: "var(--dsw-alias-label-primary, currentColor)",
          // The fill/outline difference already separates the two states; the
          // opacity step only keeps the thin outline from reading as heavy as
          // the solid star, and brightens to full on hover (official row
          // buttons change colour on hover rather than adding a background).
          opacity: starred ? 1 : (hover[0] ? 1 : 0.55),
        },
        // 收藏 = 实心（fill=currentColor，跟随主题前景：暗色近白/亮色近黑），
        // 未收藏 = 空心描边（stroke=currentColor + opacity .55），两者共用同一
        // 顶点表，所以切换状态不会跳动、不会变形，也都没有任何金色。
      }, starIcon(starred, 16));
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
          // A small grey caption, NOT a button. Same horizontal padding as a
          // row. Our own class for the same reason as `MenuRow`: the official
          // `.label` is hashed at build time, so the literal never matched and
          // only these inline styles were doing anything.
          className: "dsh-aff-mi-caption",
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

    // FIVE visibility states, ONE radio group (`filterState` is the only source
    // of truth for the whole 筛选会话 block, official rows included).
    //
    // WHY THIS REPLACED THE OLD TWO-BOOLEAN DESIGN: the two favourites modes used
    // to be independent checkboxes with their own `data-dsh-aff-filter` value,
    // while the archive axis stayed a separate boolean in the harness's store.
    // Nothing tied the two together, so the user could see 仅显示已归档 ✓ AND
    // 仅显示收藏（已归档） ✓ at the same time — semantically contradictory, and
    // both had to be ticked before anything filtered. Clicking an active row also
    // toggled it to a third "off" state, which is a state a radio group must not
    // have.
    //
    // The harness ALREADY ships the third official option (`viewOptions.
    // showArchived`, 全部对话（显示已归档）), so no new official semantic had to
    // be invented — the group is three official states plus the two favourites
    // narrowings of two of them:
    //
    //   hide           隐藏已归档（默认）        official row: hide-archived
    //   all            全部对话（显示已归档）     official row: show-archived
    //   archived       仅显示已归档              official row: only-archived
    //   fav-archived   仅显示收藏（已归档）      official row: only-archived + favourites CSS
    //   fav-unarchived 仅显示收藏（未归档）      official row: hide-archived + favourites CSS
    //
    // The archive AXIS stays the harness's own: its store decides which rows are
    // RENDERED AT ALL, and a row it excluded cannot be brought back by CSS. So
    // every state only ever presses the harness's own row — the plugin's share is
    // the favourites narrowing, applied by the scoped stylesheet.
    var FILTER_STATES = ["hide", "all", "archived", "fav-archived", "fav-unarchived"]
    /**
     * state → the official row whose click puts the harness in the right archive
     * mode. `fav-archived` needs archived rows rendered (only-archived) and
     * `fav-unarchived` needs them gone (hide-archived); the two plain states map
     * to themselves.
     */
    var MIRROR_STATE = {
      "hide": "hide",
      "all": "all",
      "archived": "archived",
      "fav-archived": "archived",
      "fav-unarchived": "hide",
    }
    /**
     * Every label the official rows carry, keyed by official state. Both locales
     * are matched because matching only Chinese silently does nothing on an
     * English build, and a silent no-op is indistinguishable from a broken menu.
     * The zh-CN wording is copied verbatim from the harness i18n bundle
     * (`viewOptions.*`), including the full-width parentheses.
     */
    var OFFICIAL_LABELS = {
      "hide": ["隐藏已归档", "Hide archived"],
      "all": ["全部对话（显示已归档）", "All conversations (show archived)"],
      "archived": ["仅显示已归档", "Archived only"],
    }
    /** Labels for the two rows this plugin invents; the three official ones keep
     *  the harness's own wording (a clone of an official row is already correct). */
    var FAV_LABELS = {
      "fav-archived": "仅显示收藏（已归档）",
      "fav-unarchived": "仅显示收藏（未归档）",
    }
    var filterState = "hide"
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

    // -----------------------------------------------------------------------
    // HIDE THE UNGROUPED BUCKET
    // -----------------------------------------------------------------------
    // The shipped sidebar appends a "未分组" group whenever a session exists that
    // no Workspace claims. That group has no owner, no "…" menu and no dismiss
    // control, so a SINGLE stray row pins a permanent group to the bottom of the
    // list. The toggle below hides the GROUP itself, header included — nothing is
    // deleted, nothing is unregistered, and the sessions stay reachable through
    // this card's diagnosis.
    //
    // The preference lives in localStorage the same way the idle threshold does,
    // so it survives a restart without a host round-trip.
    //
    // DEFAULT = ON. An unset key means "hide", because the group carries no
    // information the user asked for: it is the sidebar's fallback for sessions
    // no Workspace claims, and every one of them is still reachable through this
    // card's diagnosis. A user who wants to see it opts back in with the
    // checkbox, which writes an explicit "0".
    var HIDE_UNGROUPED_STORAGE_KEY = "dsh-aff-hide-ungrouped";

    function readHideUngrouped() {
      try {
        // Anything other than an explicit "0" means on — including a missing key.
        return localStorage.getItem(HIDE_UNGROUPED_STORAGE_KEY) !== "0";
      } catch (e) { return true; }
    }

    var hideUngrouped = readHideUngrouped();

    /**
     * Tag the shipped ungrouped group so the style rule can drop it.
     *
     * The group HEADER carries `data-row-key="workspace:"` — an EMPTY key, which
     * is exactly how the shipped code spells UNGROUPED_KEY (`workspace:${key}`
     * with `key === ""`). Its parent element is the group container, so tagging
     * the parent hides the header AND its session rows in one rule. The
     * container's class name is a hashed CSS-module name, so it is never matched
     * by name — only by this marker.
     *
     * Value-guarded: an unconditional setAttribute on every scan would keep
     * mutating the DOM. Attribute writes are not observed by our childList
     * MutationObserver, so there is no feedback loop either way.
     */
    function markUngroupedGroup() {
      try {
        var headers = document.querySelectorAll("[data-row-key='workspace:']");
        for (var i = 0; i < headers.length; i++) {
          var seat = headers[i].parentElement;
          if (seat === null) continue;
          if (seat.getAttribute("data-dsh-aff-ungrouped") !== "1") {
            seat.setAttribute("data-dsh-aff-ungrouped", "1");
          }
        }
      } catch (e) {}
    }

    /**
     * Turn the "hide 未分组" preference on or off and apply it immediately.
     *
     * Persist first, then repaint: if the localStorage write throws (private
     * mode), the in-memory flag still drives this session, so the checkbox the
     * user just clicked does what it says.
     */
    function applyHideUngrouped(next) {
      hideUngrouped = next === true;
      try { localStorage.setItem(HIDE_UNGROUPED_STORAGE_KEY, hideUngrouped ? "1" : "0"); } catch (e) {}
      try {
        if (hideUngrouped) document.documentElement.setAttribute("data-dsh-aff-hide-ungrouped", "1");
        else document.documentElement.removeAttribute("data-dsh-aff-hide-ungrouped");
      } catch (e) {}
      ensureFilterStyle();
      markUngroupedGroup();
      markRows();
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
        // ONE GATE LEFT, because only one axis is still ours:
        //
        //   data-dsh-aff-ready  — the favourites set is loaded. Without it every
        //                         row looks unfavourited, so hiding on that
        //                         basis would empty the sidebar.
        //
        // There used to be a second gate, `data-dsh-aff-archready`, feeding a CSS
        // rule for the archive axis. Both the gate and the rule are gone: the
        // archive axis is now delegated to the harness's own filter (see
        // `onFilterClickCapture`), which already decides what is rendered at all.
        // Two gates over one axis was the mechanism that let the axes drift apart.
        style.textContent =
          // ONE rule for the whole favourites axis, prefix-matched on the single
          // state value. Only the two `fav-*` states narrow anything here: the
          // three plain states are decided entirely by the harness's own archive
          // filter (which also means there is no `'archived'`/`'unarchived'`
          // value any more, and therefore no way for two rules to disagree).
          "html[data-dsh-aff-ready='1'][data-dsh-aff-filter^='fav-'] " +
          "[data-row-key^='session:']:not([data-dsh-aff-fav='1']){display:none !important}" +
          // The ARCHIVE axis is NOT filtered here on purpose. A row the harness
          // has excluded is not rendered at all, so a CSS rule on
          // `data-dsh-aff-arch` could only ever double-hide: `fav-archived`
          // presses 仅显示已归档 (archived rows rendered, the rest absent) and
          // `fav-unarchived` presses 隐藏已归档. The `data-dsh-aff-arch` marker
          // is still written by `markRows`, but only as a diagnostic.
          // The "hide 未分组" switch drops the whole bucket — header included.
          //
          // Matched through the marker `markUngroupedGroup` puts on the group
          // container, never through the hashed class name (which changes with
          // every rebuild). The marker is only written for the group whose header
          // is `data-row-key="workspace:"`, i.e. the ownerless bucket; a real
          // Workspace always carries a non-empty key and is never touched.
          //
          // No extra gate is needed: hiding an EMPTY bucket is harmless, and the
          // marker itself is the proof that the bucket exists. Nothing is deleted,
          // so the worst case of a stale preference is a group the user asked to
          // stop seeing staying hidden.
          "html[data-dsh-aff-hide-ungrouped='1'] [data-dsh-aff-ungrouped='1']{display:none !important}";
        document.head.appendChild(style);
      } catch (e) {}
    }

    /**
     * Commit a state to the radio group.
     *
     * `filterState` is assigned FIRST and unconditionally: it is the single
     * source of truth, and every tick in the menu is painted from it, so there is
     * no second variable that could disagree and light a second ✓.
     */
    function applyFilterMode(state) {
      filterState = FILTER_STATES.indexOf(state) >= 0 ? state : "hide";
      try {
        ensureFilterStyle();
        // Only `fav-*` narrows rows through CSS. The other three are the
        // harness's own archive modes, so the attribute is removed rather than
        // written: "no attribute" then means exactly one thing — the plugin adds
        // nothing to the harness's own filtering.
        if (filterState.indexOf("fav-") === 0) {
          document.documentElement.setAttribute("data-dsh-aff-filter", filterState);
        } else {
          document.documentElement.removeAttribute("data-dsh-aff-filter");
        }
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
        // Runs before the favourites gate below: the ungrouped marker must be
        // correct even while the favourites set is still loading, otherwise the
        // bucket would flash back into view on every reload.
        markUngroupedGroup();
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
     * 🔴 PRIMARY JUDGE = THE STABLE COMPILED STYLE CLASS. The build emits
     * `NSkPbW_viewOptionsMenu`; only the hash prefix is unstable, so matching on
     * the `viewOptionsMenu` suffix survives a rebuild. Text is NOT a durable
     * identity: official copy can change between releases, and our own injected
     * rows carry Chinese text of their own.
     *
     * THE TEXT TEST IS KEPT AS A FALLBACK (older build, or the class renamed
     * away), and it must use text that is *INSIDE* the menu. "视图选项" ("View
     * options") is the TRIGGER's tooltip and `aria-label`; it never appears in
     * the menu body. Matching on it made this function return false for every
     * menu, so nothing was ever injected — a silent no-op. The menu body
     * contains the group headings instead: 分组方式 / 排序方式 / 筛选会话.
     */
    function isViewOptionsMenu(menu) {
      try {
        if (menu.matches && menu.matches("[class*='viewOptionsMenu']")) return true;
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
     * Show the selection tick on whichever row matches `filterState`.
     *
     * One pass, one comparison, one ✓. Because every row in the group (official
     * ones included) is a clone carrying a unique `data-dsh-aff-mode`, a single
     * `=== filterState` test can only ever be true for one row — two ticks is now
     * structurally impossible rather than something to debug.
     *
     * Visibility only: the glyph itself is a clone of the harness's own, so its
     * size, colour and position are the harness's.
     */
    function syncFilterChecks(menu) {
      try {
        // Self-healing: the harness re-renders its own rows from the store on
        // every archive-filter change, so a sync that lands between two renders
        // must re-apply the hiding as well. Value-guarded inside.
        hideOfficialFilterRows(menu);
        var rows = menu.querySelectorAll("[data-dsh-aff-mode]");
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i];
          var btn = row.querySelector("button[role='menuitem']");
          if (btn === null) continue;
          var tick = btn.lastElementChild;
          if (tick === null || typeof tick.tagName !== "string" ||
              tick.tagName.toLowerCase() !== "svg") continue;
          var active = row.getAttribute("data-dsh-aff-mode") === filterState;
          tick.style.display = active ? "" : "none";
          btn.setAttribute("aria-checked", active ? "true" : "false");
        }
      } catch (e) {}
    }

    /**
     * Hide the harness's own filter rows, because this plugin replaces them 1:1.
     *
     * WHY REPLACE INSTEAD OF JUST ADDING TWO ROWS (the decision the old code left
     * open): the official ✓ is painted by React from the official store, and this
     * plugin's ✓ was painted by `syncFilterChecks` from `filterState`. Two
     * independent painters over two independent booleans is precisely how the
     * reported "两个 ✓ 同时亮" happened, and there is no supported way to make
     * React render a tick for a state it does not own. Suppressing just the
     * official GLYPH would have kept two painters and one DOM-mutation race
     * (React re-creates the tick on every re-render, so a suppressed tick would
     * silently come back). Replacing the rows leaves exactly ONE painter, and the
     * official handler is still what runs — see `onFilterClickCapture`.
     *
     * Idempotent and value-guarded: called on every sync, so a re-render that
     * restores the originals is corrected on the next pass.
     */
    function hideOfficialFilterRows(menu) {
      try {
        var buttons = menu.querySelectorAll("button[role='menuitem']");
        for (var i = 0; i < buttons.length; i++) {
          var btn = buttons[i];
          if (btn.closest("[data-dsh-aff-injected='1']") !== null) continue;   // ours
          var text = (btn.textContent || "").trim();
          var wrap = btn.parentElement;
          if (wrap === null) continue;
          for (var s in OFFICIAL_LABELS) {
            if (!Object.prototype.hasOwnProperty.call(OFFICIAL_LABELS, s)) continue;
            if (matchesAnyLabel(text, OFFICIAL_LABELS[s])) {
              if (wrap.style.display !== "none") wrap.style.display = "none";
              break;
            }
          }
        }
      } catch (e) {}
    }

    /** Exact-match against a label list (never substring: two official rows differ
     *  only by a leading 隐藏/仅显示). */
    function matchesAnyLabel(text, labels) {
      if (!Array.isArray(labels)) return false;
      for (var i = 0; i < labels.length; i++) {
        if (text === labels[i]) return true;
      }
      return false;
    }

    /**
     * Rewrite a row's visible label, leaving its icon and layout official.
     *
     * The label is the text-bearing `<span>` that has no element children — the
     * icon seat and the check seat both contain elements, so neither is matched.
     */
    function setRowLabel(btn, text) {
      try {
        var spans = btn.querySelectorAll("span");
        for (var i = 0; i < spans.length; i++) {
          var isLabelSeat = (spans[i].textContent || "").trim().length > 0 &&
                            spans[i].children.length === 0;
          if (isLabelSeat) {
            spans[i].textContent = text;
            return true;
          }
        }
      } catch (e) {}
      return false;
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
          // Every sync is also a chance to re-seat the scheduled-task switch, so a
          // re-render that appended official items after it cannot leave it
          // below 排序方式. No-op when it already follows 「单列表 / Single list」.
          var schedRow = menu.querySelector("[data-dsh-aff-sched-row='1']");
          if (schedRow !== null) moveSchedHideRowToEnd(menu, schedRow);
          return;
        }

        // Find the filter GROUP: the wrapper of the 隐藏已归档 row's parent.
        // One clone is copied per official row, so each clone inherits that row's
        // own icon, spacing and markup — no hand-built buttons, and a future
        // restyle keeps working.
        var template = findOfficialRow(menu, OFFICIAL_LABELS.hide);
        if (template === null) template = findOfficialRow(menu, OFFICIAL_LABELS.archived);
        if (template === null) return;
        var templateWrap = template.parentElement;
        if (templateWrap === null) return;

        var group = templateWrap.parentElement;
        if (group === null) return;

        if (true) {
        // A real tick glyph to clone: the LAST ELEMENT CHILD of whichever
        // official row is currently selected is its bare `<svg>` tick. Exactly
        // one row in the filter group is selected at all times, so this always
        // resolves while such a row exists.
        var buttons = menu.querySelectorAll("button[role='menuitem']");
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
        for (var m = 0; m < FILTER_STATES.length; m++) {
          var state = FILTER_STATES[m];
          var mirror = MIRROR_STATE[state] || state;
          var source = findOfficialRow(menu, OFFICIAL_LABELS[mirror]);
          if (source === null) {
            // A harness build missing this row: skip the state instead of
            // shipping a row that cannot select anything. `hide` always exists
            // (it is the default), so the group can never end up tickless.
            diag("injectFilterRows: official row missing for state " + state);
            continue;
          }
          var sourceWrap = source.parentElement;
          if (sourceWrap === null) continue;
          var clone = sourceWrap.cloneNode(true);
          clone.setAttribute("data-dsh-aff-injected", "1");
          clone.setAttribute("data-dsh-aff-mode", state);
          var btn = clone.querySelector("button[role='menuitem']");
          if (btn === null) continue;
          // Relabel ONLY the two rows this plugin invents; the three official
          // clones keep the harness's own wording (including
          // 全部对话（显示已归档）, which IS the "全部对话（含已归档）" state the
          // user asked for — the harness ships it, so it is not re-created here).
          var ownLabel = FAV_LABELS[state];
          if (typeof ownLabel === "string") setRowLabel(btn, ownLabel);
          // Selection tick, done by REUSING the harness's own glyph.
          //
          // The shipped renderer emits the tick only on the selected row:
          //
          //     selected && selection === "check" && jsx(IconCheckOutlineRegular, { className: check })
          //
          // and it is a BARE `<svg>` appearing as the button's LAST element
          // child (the icon is wrapped in a span, so it is never last). Earlier
          // attempts failed because they either fabricated a "✓" span on top of
          // an inherited tick (two marks), or tested `seat.querySelector("svg")`
          // — which never matches, since an element does not match its own
          // selector — leaving a tick that tracked the HARNESS's selection
          // instead of ours.
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
            // Start hidden; `syncFilterChecks` reveals it for the active state.
            myTick.style.display = "none";
            btn.appendChild(myTick);
          }
          made.push(clone);
        }
        if (made.length === 0) return;
        for (var k = 0; k < made.length; k++) group.appendChild(made[k]);
        // Re-check AFTER the append. Two observers can be alive at once
        // (a hot reload leaves the previous instance's observer until its
        // disposer runs), and both may see the same empty menu before either
        // has written. Removing the duplicates we just created is cheaper and
        // more reliable than trying to make the check atomic.
        var filterClones = group.querySelectorAll("[data-dsh-aff-mode]");
        for (var f = made.length; f < filterClones.length; f++) {
          if (filterClones[f].parentElement !== null) filterClones[f].parentElement.removeChild(filterClones[f]);
        }
        // The active state must exist as a row, otherwise the group would render
        // with no ✓ at all. Fall back to the first state that was built.
        var covered = false;
        for (var c = 0; c < made.length; c++) {
          if (made[c].getAttribute("data-dsh-aff-mode") === filterState) covered = true;
        }
        if (!covered) applyFilterMode(made[0].getAttribute("data-dsh-aff-mode"));
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
        var state = row.getAttribute("data-dsh-aff-mode");
        if (FILTER_STATES.indexOf(state) < 0) return;
        event.stopPropagation();
        event.preventDefault();

        var menu = row.closest("div[role='menu']");

        // Radio semantics, NOT toggle semantics: re-clicking the active state is
        // a no-op. The old `favFilterMode === mode ? "off" : mode` invented a
        // THIRD state that has no row in the menu — so the group could end up
        // with no ✓ at all, while the official archive filter stayed put. That is
        // exactly the "必须勾两个才生效 / 两个 ✓ 同时亮" mess: two axes, two
        // toggles, no single source of truth.
        if (state === filterState) {
          if (menu !== null) syncFilterChecks(menu);   // re-assert exactly one ✓
          closeMenuOf(row);
          return;
        }

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
        // WHICH official row: `MIRROR_STATE` maps our five states onto the
        // harness's three archive states (hide / all / archived) — one explicit
        // table, so "which archive filter does this state imply" is answerable in
        // one look instead of being re-derived at each call site.
        //
        // Effect: the archive axis is exactly the harness's own, the favourites
        // axis is ours, and `filterState` is the single value both the ticks and
        // the CSS read.
        if (menu !== null) {
          var mirror = MIRROR_STATE[state] || "hide";
          var officialBtn = findOfficialRow(menu, OFFICIAL_LABELS[mirror]);
          if (officialBtn !== null) {
            // `.click()` dispatches a bubbling MouseEvent, which reaches React's
            // listener (installed on the portal container for a portalled menu)
            // and runs the harness's own onSelect. That is the whole point: the
            // official store updates through the normal path.
            try { officialBtn.click(); } catch (e) {
              diag("official filter click failed: " + String(e && e.message ? e.message : e));
            }
            diag("delegated archive axis to the harness: " + OFFICIAL_LABELS[mirror][0]);
          } else {
            // Without the harness's own row we cannot make it render the rows
            // this state needs, so say so rather than showing an empty list and
            // letting the user guess why.
            diag("harness filter row not found for " + OFFICIAL_LABELS[mirror][0] +
                 " — state will be incomplete");
          }
        }

        applyFilterMode(state);

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
    var markTimer = null
    var scheduledJobs = null

    /**
     * Run `job` once, 60 ms after the current burst of DOM changes settles.
     *
     * WHY A TIMER AND NOT A MICROTASK: a microtask fires once per mutation BATCH,
     * and the browser produces a batch per DOM change — while a reply streams,
     * that is one batch per token, so a microtasked scan costs a full pass per
     * token. Collapsing on a 60 ms boundary is what turns N passes into one.
     *
     * WHY A JOB LIST AND NOT A BOOLEAN: three document-wide observers each want a
     * DIFFERENT piece of work, and they observe the same mutations. With a single
     * boolean the first observer would swallow the others' work for that round
     * (their call would see "already scheduled" and return), so one of the three
     * features would silently go stale. One timer, every requested job, deduped
     * by function identity.
     *
     * `scheduleMark()` with no argument keeps its original meaning — re-tag the
     * sidebar rows — so every existing caller is unchanged.
     */
    function scheduleMark(job) {
      var fn = typeof job === "function" ? job : markRows
      if (scheduledJobs === null) scheduledJobs = []
      for (var i = 0; i < scheduledJobs.length; i++) {
        if (scheduledJobs[i] === fn) return          // that job is already queued
      }
      scheduledJobs.push(fn)
      if (markScheduled) return
      markScheduled = true
      try {
        markTimer = setTimeout(function () {
          markTimer = null
          markScheduled = false
          var jobs = scheduledJobs || []
          scheduledJobs = null
          for (var j = 0; j < jobs.length; j++) {
            try {
              jobs[j]()
            } catch (e) {
              diag("scheduled work failed: " + String(e && e.message ? e.message : e))
            }
          }
        }, 60)
      } catch (e) {
        markScheduled = false
        scheduledJobs = null
      }
    }

    /**
     * Drop queued work and the pending timer.
     *
     * Called from `stopFilterEnhancer` and on `pagehide`: a plugin that is torn
     * down must not fire a pass into a DOM it no longer owns, and a reload must
     * not leave a live timeout behind.
     */
    function cancelScheduledWork() {
      markScheduled = false
      scheduledJobs = null
      if (markTimer !== null) {
        try { clearTimeout(markTimer); } catch (e) {}
        markTimer = null
      }
    }

    /**
     * Remove ONE queued job, leaving the other jobs alone.
     *
     * A feature that unloads owns only its own pass; cancelling the whole queue
     * would silently steal a sibling feature's pending work in the same tick.
     */
    function unqueueScheduledWork(job) {
      if (scheduledJobs === null) return
      var keep = []
      for (var i = 0; i < scheduledJobs.length; i++) {
        if (scheduledJobs[i] !== job) keep.push(scheduledJobs[i])
      }
      scheduledJobs = keep.length > 0 ? keep : null
    }

    /**
     * Cheap positive test over a mutation batch: did anything we care about get
     * ADDED? `test` receives each added ELEMENT (text nodes are skipped, they can
     * never be a row or a menu).
     *
     * This is the gate that makes the observers affordable: it runs a couple of
     * `matches`/`closest` calls per added node instead of the old per-node
     * document-wide `querySelectorAll`.
     */
    function addedNodesTouch(records, test) {
      for (var i = 0; i < records.length; i++) {
        var added = records[i].addedNodes
        if (!added) continue
        for (var j = 0; j < added.length; j++) {
          var node = added[j]
          if (node === null || node.nodeType !== 1) continue
          try {
            if (test(node)) return true
          } catch (e) {}
        }
      }
      return false
    }

    /** Is this added node, or anything under it, part of the sidebar/menu patch? */
    function touchesFilterArea(node) {
      if (typeof node.matches === "function") {
        if (node.matches("div[role='menu']")) return true
        if (node.matches("[data-row-key^='session:']")) return true
        // Rows are usually appended inside a wrapper, and a row can be re-created
        // in place: "inside a session row" must count, otherwise a title edit or a
        // star swap would leave the row untagged.
        if (typeof node.closest === "function" &&
            node.closest("[data-row-key^='session:']") !== null) return true
      }
      if (typeof node.querySelector === "function") {
        if (node.querySelector("div[role='menu']") !== null) return true
        if (node.querySelector("[data-row-key^='session:']") !== null) return true
      }
      return false
    }

    /** Does this added node, or anything under it, hold a menu? */
    function touchesMenu(node) {
      if (typeof node.matches === "function" && node.matches("div[role='menu']")) return true
      if (typeof node.querySelector === "function" &&
          node.querySelector("div[role='menu']") !== null) return true
      return false
    }

    /**
     * Deferred DOM pass for the sidebar patch: fix up the menus that are open now.
     *
     * Rescanning the open menus instead of replaying the added nodes is what makes
     * the pass idempotent AND complete: a menu is populated across several
     * mutation batches (container, then rows), so replaying one batch could see a
     * half-built menu. Both callees are idempotent.
     */
    function refreshFilterMenus() {
      try {
        var menus = document.querySelectorAll("div[role='menu']")
        for (var i = 0; i < menus.length; i++) {
          injectFilterRows(menus[i])
          hideOfficialSessionIdRow(menus[i])
        }
      } catch (e) {}
    }

    function startFilterEnhancer() {
      try {
        ensureFilterStyle();
        document.addEventListener("click", onFilterClickCapture, true);
        if (typeof MutationObserver === "undefined") return;
        filterObserver = new MutationObserver(function (records) {
          // CHEAP GATE FIRST. Every session row carries data-row-key, and a menu
          // is either the added node itself or lives under it — everything else
          // (a tooltip, a toast, the composer, a star-icon swap) cannot affect
          // this patch, so it must not cost a document scan.
          //
          // This is also what the old code got wrong: it ran a querySelectorAll
          // per added node, on EVERY mutation, so a streaming reply re-scanned the
          // document per token.
          if (!addedNodesTouch(records, touchesFilterArea)) return;
          // ONE deferred pass per burst. Two jobs, one timer:
          //   refreshFilterMenus — the menus (idempotent DOM fix-up)
          //   markRows           — the rows may have been re-created in the same burst
          scheduleMark(refreshFilterMenus);
          scheduleMark();
        });
        filterObserver.observe(document.body, { childList: true, subtree: true });
        // A navigation must not leave a queued pass (or its timeout) behind.
        try { window.addEventListener("pagehide", cancelScheduledWork); } catch (e) {}
        markRows();
      } catch (e) {}
    }

    function stopFilterEnhancer() {
      try {
        document.removeEventListener("click", onFilterClickCapture, true);
        if (filterObserver !== null) { filterObserver.disconnect(); filterObserver = null; }
        // Drop the queued pass and its timer: after this point the plugin does not
        // own the DOM any more, and a stale timeout would run against it anyway.
        cancelScheduledWork();
        document.documentElement.removeAttribute("data-dsh-aff-filter");
        // Drop the hide switch's gate too. Without this an unloaded plugin would
        // leave the bucket hidden with no UI left to bring it back.
        document.documentElement.removeAttribute("data-dsh-aff-hide-ungrouped");
      } catch (e) {}
    }

    // =====================================================================
    // 2b. 「隐藏定时任务」/ hide every session that belongs to a scheduled task
    // =====================================================================
    // A session created (or reserved) by a schedule should not clutter the
    // sidebar at all (D 口径 2026-11-11: 只要关联定时任务就隐藏，到点也不弹回，
    // 只有手动关掉开关才恢复)。 Only UNARCHIVED rows are touched — archived rows
    // obey the archive filter, which is the harness's axis, not ours.
    //
    // Division of labour, and why it is split this way:
    //   host    decides `hide` from the schedule store (it is the only side that
    //           can read it) and reports `dueAt` = next fire time, used for
    //           DISPLAY only.
    //   client  paints the verdict from `hide` alone; it never re-evaluates a
    //           clock, so an already-fired schedule stays hidden. No guessing
    //           about which sessions are scheduled ever happens in the browser.
    //
    // Cost control: the 60 s tick does NOT rescan on idle. It runs only while the
    // switch is on AND at least one row is currently hidden, and the payload is
    // refetched at most every 5 minutes.
    //
    // State:
    //   html[data-dsh-aff-sched-hide='1']   switch on (the only CSS gate)
    //   row [data-dsh-aff-sched='1']        this row belongs to a scheduled task
    //   row/inject marker [data-dsh-aff-sched-row='1']  our menu row
    var SCHED_HIDE_STORAGE_KEY = "dsh-aff-hide-scheduled";
    var SCHED_HIDE_STYLE_ID = "dsh-aff-sched-style";
    var SCHED_HIDE_TICK_MS = 60000;
    var SCHED_HIDE_REFETCH_MS = 300000;
    // A SEPARATE key from the switch itself, because the notice is "the very
    // first time this switch ever hid anything", which must not come back just
    // because the user turned the switch off and on again.
    var SCHED_HIDE_NOTICE_KEY = "dsh-aff-sched-notice-shown";
    // Chinese only on purpose: the user asked for the English half to go, so the
    // label reads 「隐藏定时任务」 and nothing else (no title/aria-label copy exists).
    var SCHED_HIDE_LABEL = "隐藏定时任务";

    /** Anything but an explicit "0" means on, including a missing key. */
    function readSchedHideOn() {
      try { return localStorage.getItem(SCHED_HIDE_STORAGE_KEY) !== "0"; } catch (e) { return true; }
    }

    function writeSchedHideOn(on) {
      try { localStorage.setItem(SCHED_HIDE_STORAGE_KEY, on ? "1" : "0"); } catch (e) {}
    }

    var schedHide = {
      on: readSchedHideOn(),
      items: [],
      source: "",
      loadedAt: 0,
      fetching: false,
      applying: false,
      hiddenCount: 0,
      // Independent baseline for the one-time notice. `hiddenCount` cannot double
      // as that baseline any more: the fav-* views tag rows without hiding any of
      // them (the CSS lets them through), so a phantom count there must not look
      // like a 0 -> >0 edge. Keeping the two numbers separate is what lets the
      // fav-* pass reset the edge without falsifying `hiddenCount`.
      noticeBaseline: 0,
      noticeShown: false,
      observer: null,
      tickTimer: null,
      dueTimer: null,
      refetchTimer: null,
    };

    /** `session:<bare>` row keys and `session-<bare>` ids have to compare equal. */
    function bareSessionId(sessionId) {
      var text = String(sessionId === null || sessionId === undefined ? "" : sessionId);
      return text.indexOf("session-") === 0 ? text.slice(8) : text;
    }

    /** Our own <style>: the filter style block belongs to another section. */
    function ensureSchedHideStyle() {
      try {
        if (document.getElementById(SCHED_HIDE_STYLE_ID) !== null) return;
        var style = document.createElement("style");
        style.id = SCHED_HIDE_STYLE_ID;
        style.textContent =
          // The `fav-*` views are the user narrowing the list by hand, so the
          // switch steps aside there: `:not([data-dsh-aff-filter^='fav-'])` keeps
          // every row visible while 只看收藏（已归档 / 未归档）is on. Switching to
          // one of those views is a deliberate "I am looking for something", and
          // nothing is actually hidden behind them (the rows are still tagged, the
          // rule simply does not match). `data-dsh-aff-filter` is REMOVED — not set
          // to a plain value — in the three non-fav states (see `applyFilterMode`),
          // so the negation is true there as well; an absent attribute never
          // prefix-matches `fav-`.
          "html[data-dsh-aff-sched-hide='1']:not([data-dsh-aff-filter^='fav-']) " +
          "[data-row-key^='session:'][data-dsh-aff-sched='1']" +
          "{display:none !important}";
        (document.head || document.documentElement).appendChild(style);
      } catch (e) {}
    }

    /**
     * Tell the user ONCE that the switch is now hiding something.
     *
     * Fires on the only transition that matters — 0 hidden -> >0 hidden — and
     * never again: the flag is persisted in localStorage, so the second and every
     * later batch of newly hidden sessions stays silent. Without the persisted
     * key this would pop up again every time a fresh schedule joins the sidebar.
     *
     * `schedHide.hiddenCount` itself is NOT touched here: it keeps its original
     * job (deciding whether the 60 s tick is worth running at all).
     *
     * The edge is measured against `schedHide.noticeBaseline`, NOT against
     * `hiddenCount`: on a fav-* view the CSS lets every row through, so the count
     * is nonzero while nothing is actually hidden. Announcing 「已隐藏 N 个」there
     * would be a lie AND it would burn the one-shot key. On that view the baseline
     * is RESET to 0 before returning — not merely skipped — so the next real
     * 0 -> >0 edge on a normal view still fires.
     */
    function maybeNoticeSchedHide(hidden, baseline) {
      try {
        // The filter attribute is ABSENT in the three non-fav states (see
        // `applyFilterMode`), so only an explicit `fav-…` value takes this branch.
        var filter = String(document.documentElement.getAttribute("data-dsh-aff-filter") || "");
        if (filter.indexOf("fav-") === 0) {
          schedHide.noticeBaseline = 0;
          return;                                  // no toast, no localStorage write
        }
        if (!(hidden > 0) || baseline > 0) {       // not the 0 -> >0 edge
          // Keep the baseline true to the DOM on every pass, so a real 0 hands the
          // edge back to the next nonzero count.
          schedHide.noticeBaseline = hidden > 0 ? hidden : 0;
          return;
        }
        schedHide.noticeBaseline = hidden;
        if (schedHide.noticeShown) return;
        schedHide.noticeShown = true;
        try { if (localStorage.getItem(SCHED_HIDE_NOTICE_KEY) === "1") return; } catch (e) {}
        try { localStorage.setItem(SCHED_HIDE_NOTICE_KEY, "1"); } catch (e) {}
        toast("已隐藏 " + hidden + " 个定时任务会话；可在 视图选项 → 隐藏定时任务 关闭。");
      } catch (e) {}
    }

    /**
     * Tag every sidebar row that is tied to a scheduled task. Value-guarded
     * writes only: an unconditional setAttribute would keep mutating the DOM on
     * every scan.
     *
     * 2026-11-11 用户口径（D）：只要会话与定时任务有关就隐藏，**判定与时间无关** ——
     * 未到点 / 刚到点 / 早已到点都隐藏，到点不弹回；只有当 `schedHide.on` 关闭时全部
     * 恢复。`dueAt` 仅用于界面展示，不参与是否隐藏。
     */
    function applySchedHide() {
      if (schedHide.applying) return;
      schedHide.applying = true;
      try {
        ensureSchedHideStyle();
        // D 口径：判定与时间无关，所以这一遍既不需要 `now`，也不再累积 due 时刻。
        // The "was" side of the one-time notice is `schedHide.noticeBaseline`, read
        // at the bottom of this pass: `hiddenCount` can no longer serve as it, for
        // the fav-* reason documented on the notice helper below.
        //
        // `hiddenCount` 口径此处照旧（只看收藏类视图下仍会多报，已用提示基线
        // 防误弹提示，属既有设计）。另：D 口径下非收藏类视图恒 > 0，
        // `startSchedHide` 60 s tick 的空闲短路会失效，属可接受的额外 DOM 扫描。
        var scheduled = {};   // bare session id -> true, regardless of due time
        for (var i = 0; i < schedHide.items.length; i++) {
          var item = schedHide.items[i];
          if (item === null || typeof item !== "object") continue;
          if (item.hide !== true) continue;
          // 不读 `dueAt`：未到点 / 刚到点 / 早已到点 / 时间不可解析，一律算「与定时
          // 任务有关」。旧版这里的 `due <= now` 会让已到点的行弹回来，D 口径下删除。
          scheduled[bareSessionId(item.sessionId)] = true;
        }
        var rows = document.querySelectorAll("[data-row-key^='session:']");
        var hidden = 0;
        for (var r = 0; r < rows.length; r++) {
          var key = bareSessionId(sessionIdOfRow(rows[r]));
          var want = (schedHide.on && scheduled[key] === true) ? "1" : "0";
          if (rows[r].getAttribute("data-dsh-aff-sched") !== want) {
            rows[r].setAttribute("data-dsh-aff-sched", want);
          }
          if (want === "1") hidden += 1;
        }
        if (schedHide.on) document.documentElement.setAttribute("data-dsh-aff-sched-hide", "1");
        else document.documentElement.removeAttribute("data-dsh-aff-sched-hide");
        schedHide.hiddenCount = hidden;
        // `schedHide.noticeBaseline` was captured at the top of this pass: the
        // notice belongs to the 0 -> >0 edge only, and that edge is measured on
        // this baseline — never on `hiddenCount`, which counts fav-* rows that the
        // CSS leaves visible.
        maybeNoticeSchedHide(hidden, schedHide.noticeBaseline);
        queueSchedHideWake();
      } catch (e) {
      } finally {
        schedHide.applying = false;
      }
    }

    /**
     * CANCEL-ONLY since the D 口径 (2026-11-11): whether a row is hidden no longer
     * depends on `dueAt`, so there is no "next due moment" left to wake up for and
     * nothing is scheduled here any more. The call and the name stay (smallest
     * possible diff) so that any timer left over from an older bundle, from a
     * still-pending callback or from a previous pass is dropped rather than left
     * dangling — `stopSchedHide` on `pagehide` still clears it as well.
     */
    function queueSchedHideWake() {
      try {
        if (schedHide.dueTimer !== null) { clearTimeout(schedHide.dueTimer); schedHide.dueTimer = null; }
      } catch (e) {}
    }

    /** Ask the host once; never throws, never overlaps itself. */
    function fetchSchedHide() {
      if (schedHide.fetching) return;
      schedHide.fetching = true;
      var done = function () { schedHide.fetching = false; };
      try {
        api("/scheduled-sessions").then(function (data) {
          done();
          if (data === null || typeof data !== "object") return;
          if (data.ok !== true) {
            diag("scheduled-sessions: " + String(data.error || data.note || "not ok"));
            return;
          }
          schedHide.items = Array.isArray(data.items) ? data.items : [];
          schedHide.source = String(data.source || "");
          schedHide.loadedAt = Date.now();
          if (data.heuristic === true) diag("scheduled-sessions: degraded (" + schedHide.source + ")");
          applySchedHide();
        }).catch(function (error) {
          done();
          diag("scheduled-sessions fetch failed: " + String(error && error.message ? error.message : error));
        });
      } catch (error) {
        done();
      }
    }

    /**
     * The leading icon of our switch row: an alarm clock struck out by a slash.
     *
     * Same discipline as `starIcon` — one inline SVG, `currentColor` only (no
     * gold, no hard-coded fill) — because a text glyph would swap size and
     * baseline between states and across font stacks.
     *
     * CENTRED BY BOUNDING BOX, NOT BY VERTEX. Every coordinate is chosen so the
     * UNION ink box of the geometry (= what `getBBox()` reports, stroke excluded)
     * is x ∈ [2.45, 13.55], y ∈ [2.50, 13.50]:
     *   x centre = (2.45 + 13.55) / 2 = 8.000
     *   y centre = (2.50 + 13.50) / 2 = 8.000
     * The slash is the extreme element on all four sides, so it alone pins the
     * box; the dial (cx 8, cy 8.9, r 4.55 → x ∈ [3.45, 12.55], y ∈ [4.35, 13.45])
     * and both ears sit inside it. A uniform 1.4 stroke with round caps grows that
     * box by exactly 0.7 on every side, so the stroke-inflated centre is 8.000 as
     * well: tuning `stroke-width` cannot shift the icon.
     *
     * Shape = dial circle + two top ears + two hands + one upper-left → lower-right
     * slash. The ears are straight stubs at 45° (the standard alarm-clock read,
     * as in lucide/feather); the slash is 11.1 long and 45°-ish, i.e. a strike,
     * not a third hand.
     */
    function schedHiddenIcon(size) {
      var s = size || 16;
      var NS = "http://www.w3.org/2000/svg";
      var svg = document.createElementNS(NS, "svg");
      svg.setAttribute("width", String(s));
      svg.setAttribute("height", String(s));
      svg.setAttribute("viewBox", "0 0 16 16");
      // Inherited by every child: one `currentColor`, no fill anywhere.
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "1.4");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      svg.style.display = "block";
      svg.style.flex = "none";
      function part(name, attrs) {
        var el = document.createElementNS(NS, name);
        for (var k in attrs) {
          if (Object.prototype.hasOwnProperty.call(attrs, k)) el.setAttribute(k, attrs[k]);
        }
        svg.appendChild(el);
        return el;
      }
      part("circle", { cx: "8", cy: "8.9", r: "4.55" });        // dial
      part("path", { d: "M4.78 5.68L3.10 4.00" });              // left ear
      part("path", { d: "M11.22 5.68L12.90 4.00" });            // right ear
      part("path", { d: "M8 8.9L8 5.8" });                      // minute hand
      part("path", { d: "M8 8.9L9.55 7.35" });                  // hour hand
      part("path", { d: "M2.45 2.5L13.55 13.5" });              // the slash
      return svg;
    }

    /**
     * Paint our switch row: struck-out alarm clock, Chinese label, trailing tick.
     *
     * Three things the clone does NOT give us:
     *   - the label is Chinese only; the old "✓ " text prefix is gone too, so the
     *     row reads 「隐藏定时任务」 instead of 「✓ 隐藏定时任务（Hide …）」;
     *   - the clone drags in the source row's leading icon, which is REMOVED
     *     rather than hidden so no zero-width gap is left behind;
     *   - the row then carries OUR icon in exactly that seat (before the label),
     *     built by `schedHiddenIcon` and marked `data-dsh-aff-sched-icon="1"`.
     * Idempotence: our host node is dropped before the sweep on every pass, so a
     * pass always starts from "no icon of ours" and ends with exactly one — three
     * consecutive paints still leave one node. Clearing first also keeps the
     * sweep from mistaking our own host for the clone's icon.
     * The trailing seat (the LAST svg) is the state check and stays: it is the
     * only on/off indicator, so it is never the element removed here.
     */
    function paintSchedHideRow(row) {
      try {
        var stale = row.querySelectorAll("[data-dsh-aff-sched-icon='1']");
        for (var q = 0; q < stale.length; q++) {
          if (stale[q].parentNode !== null) stale[q].parentNode.removeChild(stale[q]);
        }
        // `role` is rewritten to `menuitemcheckbox` a few lines below, so the plain
        // `menuitem` selector stops matching THIS button from the second paint on.
        // A one-shot `[role='menuitem']` lookup therefore returned null and the
        // whole function bailed out silently — the row looked frozen ("点了没
        // 反应") with nothing in the log. Both spellings must be accepted.
        var btn = row.querySelector("button[role='menuitem']")
               || row.querySelector("button[role='menuitemcheckbox']");
        if (btn === null) return;
        var on = schedHide.on;
        btn.setAttribute("role", "menuitemcheckbox");
        btn.setAttribute("aria-checked", on ? "true" : "false");
        var seats = row.querySelectorAll("svg");
        var tick = seats.length > 0 ? seats[seats.length - 1] : null;
        // Leading icon = a direct child of the button that carries an svg but no
        // text, and is not — and does not contain — the trailing tick.
        var kids = btn.children || [];
        for (var i = 0; i < kids.length; i++) {
          var kid = kids[i];
          if (kid === null || kid === tick) continue;
          if (tick !== null && kid.contains && kid.contains(tick)) continue;
          var tag = String(kid.tagName || "").toLowerCase();
          if (tag !== "svg" && kid.querySelector("svg") === null) continue;
          if ((kid.textContent || "").trim() !== "") continue;   // text seat stays
          if (kid.parentNode !== null) kid.parentNode.removeChild(kid);
          break;
        }
        // Our icon takes the seat the clone's icon just left: before the text
        // label. The label seat is the same text-only `<span>` `setRowLabel`
        // rewrites, so neither function can disagree about which node it is.
        var host = document.createElement("span");
        host.setAttribute("data-dsh-aff-sched-icon", "1");
        host.style.display = "flex";
        host.style.flex = "none";
        host.style.alignItems = "center";
        host.style.justifyContent = "center";
        host.appendChild(schedHiddenIcon(16));
        var labelSeat = null;
        var spans = btn.querySelectorAll("span");
        for (var j = 0; j < spans.length; j++) {
          if (spans[j] === host) continue;
          if ((spans[j].textContent || "").trim().length > 0 && spans[j].children.length === 0) {
            labelSeat = spans[j];
            break;
          }
        }
        if (labelSeat !== null && labelSeat.parentNode === btn) btn.insertBefore(host, labelSeat);
        else btn.insertBefore(host, btn.firstChild);
        if (tick !== null && tick.parentNode !== null) tick.style.display = on ? "" : "none";
        setRowLabel(btn, SCHED_HIDE_LABEL);
      } catch (e) {}
    }

    /**
     * The ONE real row container of an open view-options menu: the viewport.
     *
     * Measured structure (read-only recon of the shipped bundle):
     *   div[role='menu']                  ← the CARD, and the scrollable box
     *   ├─ div[aria-hidden] .material     ← backdrop
     *   ├─ div[role='presentation']       ← ★ the only real row container
     *   └─ (footer — empty for this menu, so it does not exist)
     * Every label / separator / row is a FLAT child of the viewport; there is no
     * group wrapper. A menu ENTRY, however, is TWO layers deep —
     * `div.itemWrap > button[role='menuitem']` — so `first.parentElement` is that
     * single-row wrapper, NOT the viewport. Seating the clone there renders it
     * glued under that row (visually 2nd) and hides it from the flat-text anchor
     * scan, whose children are wrappers. Never return an itemWrap (2026-11-11).
     *
     * Only `.viewport` scrolls (`.scrollable .viewport{overflow-y:auto}`), so a
     * row appended to the card root sits OUTSIDE the scrolling area: it does not
     * travel with the list, and in a long menu it can be pushed past the card's
     * bottom edge. Always append to the viewport.
     *
     * RESOLVED BY ROLE, WITH A STRUCTURAL FALLBACK, in this order: the item's
     * nearest `div[role='presentation']` ancestor (the harness renders the card as
     * `div[role='presentation']` hosting one itemWrap per entry) → any
     * `div[role='presentation']` inside the card → the card itself. The parent of
     * the first row is never an answer. `[role^='menuitem']` is prefix-matched on
     * purpose: this very module rewrites `menuitem` to `menuitemcheckbox`, and
     * either spelling must still find the row.
     */
    function menuViewport(menu) {
      try {
        var first = menu.querySelector("[role^='menuitem']");
        if (!first) return menu.querySelector("div[role='presentation']") || menu;
        var pres = first.closest("div[role='presentation']");
        if (pres && pres !== menu && menu.contains(pres)) return pres;
        var vp = menu.querySelector("div[role='presentation']");
        return vp !== null ? vp : menu;
      } catch (e) { return menu; }
    }

    /**
     * Find the official 「单列表 / Single list」 row inside the menu's viewport.
     *
     * TEXT, NOT SELECTOR, and the reason is measured: neither 单列表 nor
     * Single list occurs a single time in this bundle — the label is host i18n
     * and only exists as rendered text. So the anchor is the viewport's flat
     * child whose trimmed textContent equals the label, accepting the Chinese
     * and English spelling. Our own row carries data-dsh-aff-sched-row="1" and
     * is skipped, so it can never anchor on itself.
     */
    function schedListRowAnchor(menu, row) {
      try {
        var host = menuViewport(menu);
        if (host === null || host.children === undefined) return null;
        var kids = host.children;
        for (var i = 0; i < kids.length; i++) {
          var kid = kids[i];
          if (kid === null || kid === undefined || kid === row) continue;
          if (kid.getAttribute !== undefined &&
              kid.getAttribute("data-dsh-aff-sched-row") === "1") continue;
          var text = kid.textContent === null || kid.textContent === undefined ? "" : kid.textContent;
          var trimmed = text.trim();
          if (trimmed === "单列表" || trimmed === "Single list") return kid;
        }
        return null;
      } catch (e) { return null; }
    }

    /**
     * Seat the row directly BELOW 「单列表 / Single list」, on every pass.
     *
     * This used to mean "BOTTOM of the menu": the row was re-appended to the
     * viewport's last seat on every pass. The user changed that requirement —
     * the row must sit between 单列表 and 排序方式 — so the strategy is now
     * "insert after the anchor" rather than "append to the end". The function
     * keeps its name because five call sites and the observer wiring reference
     * it.
     *
     * Two anchors, in order:
     *   1. the 单列表 / Single list row, found by rendered text (see
     *      `schedListRowAnchor`) → insert immediately after it;
     *   2. none rendered yet (early batched paint) or a build localised to a
     *      language neither string covers → the viewport's END. Never the menu
     *      card root: that is outside the scrolling area (see `menuViewport`).
     *
     * Idempotence is load-bearing: this runs from a MutationObserver, so every
     * write can re-trigger the pass. "Already after the anchor" returns before
     * touching the DOM (zero writes), and the fallback returns when the row is
     * already last — otherwise the row would detach/re-append itself forever
     * and the observer would never settle.
     */
    function moveSchedHideRowToEnd(menu, row) {
      try {
        if (menu === null || row === null) return;
        var anchor = schedListRowAnchor(menu, row);
        if (anchor !== null) {
          if (row.previousElementSibling === anchor) return;
          if (anchor.parentNode === null) return;
          anchor.parentNode.insertBefore(row, anchor.nextSibling);
          return;
        }
        var host = menuViewport(menu);
        if (host === null) return;
        if (row.parentNode === host && row.nextElementSibling === null) return;
        if (row.parentNode !== null) row.parentNode.removeChild(row);
        host.appendChild(row);
      } catch (e) {}
    }

    /**
     * Inject the switch into the open 视图选项 menu. Idempotent, and it never
     * carries `data-dsh-aff-mode`: this is a standalone checkbox, NOT one of the
     * five mutually exclusive filter states, so the filter state machine above
     * must never see it (`onFilterClickCapture` bails out on an unknown mode,
     * before its stopPropagation, which is exactly the pass-through we want).
     */
    function injectSchedHideRow(menu) {
      try {
        if (menu === null || !isViewOptionsMenu(menu)) return;
        ensureSchedHideStyle();
        var existing = menu.querySelector("[data-dsh-aff-sched-row='1']");
        if (existing !== null) {
          paintSchedHideRow(existing);
          // Re-seat on every sync: a re-render that appends official items after us
          // must not leave this row stranded below 排序方式 — it belongs right
          // after 「单列表 / Single list」.
          moveSchedHideRowToEnd(menu, existing);
          return;
        }
        // Clone one of OUR injected rows when present (same wrap + check seats),
        // else clone the first official menu row — only the shell is reused.
        var source = menu.querySelector("[data-dsh-aff-injected='1'][data-dsh-aff-mode]");
        if (source === null) {
          var official = menu.querySelector("button[role='menuitem']");
          if (official === null) return;
          source = official.parentElement;
        }
        if (source === null || source.parentNode === null) return;
        var clone = source.cloneNode(true);
        clone.setAttribute("data-dsh-aff-injected", "1");
        clone.setAttribute("data-dsh-aff-sched-row", "1");
        clone.removeAttribute("data-dsh-aff-mode");
        clone.removeAttribute("data-dsh-aff-ungrouped");
        // A future build may render the row key onto menu rows. If that key
        // survived the clone, `applySchedHide` would mistake this switch for a
        // session row and tag it as hidden/shown.
        clone.removeAttribute("data-row-key");
        var btn = clone.querySelector("button[role='menuitem']");
        if (btn === null) return;
        // Seat inside the scrolling VIEWPORT (never the card root). The first
        // paint appends to the viewport's END, then `moveSchedHideRowToEnd` puts
        // it right after 「单列表 / Single list」 on this and every later pass —
        // that anchor is not always rendered during the first batched paint.
        var host = menuViewport(menu);
        host.appendChild(clone);
        paintSchedHideRow(clone);
        moveSchedHideRowToEnd(menu, clone);
        diag("injected scheduled-task switch (on=" + (schedHide.on ? "1" : "0") + ")");
      } catch (e) {}
    }

    function scanSchedHideMenus(node) {
      try {
        if (node === null || typeof node !== "object" || node.nodeType !== 1) return;
        if (node.matches && node.matches("div[role='menu']")) injectSchedHideRow(node);
        if (node.querySelectorAll) {
          var menus = node.querySelectorAll("div[role='menu']");
          for (var i = 0; i < menus.length; i++) injectSchedHideRow(menus[i]);
        }
        if (node.closest) {
          var host = node.closest("div[role='menu']");
          if (host !== null) injectSchedHideRow(host);
        }
      } catch (e) {}
    }

    function onSchedHideClickCapture(event) {
      try {
        var target = event.target;
        if (target === null || typeof target.closest !== "function") return;
        var row = target.closest("[data-dsh-aff-sched-row='1']");
        if (row === null) return;
        event.preventDefault();
        event.stopPropagation();
        schedHide.on = !schedHide.on;
        writeSchedHideOn(schedHide.on);
        paintSchedHideRow(row);
        applySchedHide();
        if (schedHide.on) fetchSchedHide();
        closeMenuOf(row);
      } catch (e) {}
    }

    /**
     * Self-arming on purpose. The filter enhancer is another section's lifecycle
     * and this block must not depend on being called from inside it, so it owns
     * its registration and is idempotent (a second call returns immediately).
     */
    function startSchedHide() {
      try {
        if (schedHide.observer !== null) return;
        ensureSchedHideStyle();
        document.addEventListener("click", onSchedHideClickCapture, true);
        // Deferred, single-flight DOM pass for the switch, on the shared scheduler.
        //
        // ONLY THE CALLING CONVENTION CHANGED. `scanSchedHideMenus` and
        // `applySchedHide` keep their logic byte for byte: the scan is idempotent
        // (`injectSchedHideRow` repaints an existing row) and the visibility
        // verdict is still entirely `applySchedHide`'s. Nothing here decides
        // whether a row is hidden — only when the menu is patched.
        var refreshSchedHideMenus = function () {
          try {
            var menus = document.querySelectorAll("div[role='menu']");
            for (var m = 0; m < menus.length; m++) scanSchedHideMenus(menus[m]);
          } catch (e) {}
        };
        var observer = new MutationObserver(function (records) {
          // This pass can only write into an OPEN menu, so a batch that contains no
          // menu (tooltips, the composer, streaming text) is not even looked at.
          if (!addedNodesTouch(records, touchesMenu)) return;
          scheduleMark(refreshSchedHideMenus);
        });
        observer.observe(document.body, { childList: true, subtree: true });
        schedHide.observer = observer;
        schedHide.tickTimer = setInterval(function () {
          try {
            if (!schedHide.on) return;
            // Idle is free: nothing hidden and nothing queued means no work.
            if (schedHide.hiddenCount === 0 && schedHide.dueTimer === null) return;
            applySchedHide();
            if (Date.now() - schedHide.loadedAt > SCHED_HIDE_REFETCH_MS) fetchSchedHide();
          } catch (e) {}
        }, SCHED_HIDE_TICK_MS);
        window.addEventListener("pagehide", stopSchedHide);
        applySchedHide();
        if (schedHide.on) fetchSchedHide();
      } catch (e) {}
    }

    function stopSchedHide() {
      try {
        if (schedHide.observer !== null) { schedHide.observer.disconnect(); schedHide.observer = null; }
        if (schedHide.tickTimer !== null) { clearInterval(schedHide.tickTimer); schedHide.tickTimer = null; }
        if (schedHide.dueTimer !== null) { clearTimeout(schedHide.dueTimer); schedHide.dueTimer = null; }
        document.removeEventListener("click", onSchedHideClickCapture, true);
        document.documentElement.removeAttribute("data-dsh-aff-sched-hide");
        // Drop the per-row marks: a disabled plugin must not leave rows hidden.
        var marked = document.querySelectorAll("[data-dsh-aff-sched]");
        for (var i = 0; i < marked.length; i++) marked[i].removeAttribute("data-dsh-aff-sched");
        schedHide.hiddenCount = 0;
      } catch (e) {}
    }

    try {
      if (document.body !== null) startSchedHide();
      else document.addEventListener("DOMContentLoaded", function () { startSchedHide(); }, { once: true });
    } catch (e) {}

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

    // ---------------------------------------------------------------------
    // One visual grammar for every card (0.36.0)
    // ---------------------------------------------------------------------
    // Before this the six cards each spelled out their own title weight, hint
    // opacity and input padding, so two cards that did the same thing looked
    // different and a third looked like nothing at all. Everything below is the
    // single source for that grammar:
    //
    //   TITLE  — what this card is.
    //   HINT   — one sentence: what it does to your disk, and what it never does.
    //   ROW    — the header line that carries the card title plus its buttons.
    //   INPUT  — the threshold boxes, so every number field is the same width.
    //   SUBTLE — small print: source, counts, ids.
    //
    // A card that is not built from these five is a card that will drift again.
    var TITLE_STYLE = { fontWeight: "600", fontSize: "13.5px", lineHeight: "20px" };
    var HINT_STYLE = { opacity: .72, fontSize: "12px", lineHeight: "17px" };
    var SUBHEAD_STYLE = { fontWeight: "600", fontSize: "12.5px", lineHeight: "19px" };
    var SUBTLE_STYLE = { opacity: .6, fontSize: "11px", lineHeight: "16px" };
    var ROW_STYLE = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px" };
    var INPUT_STYLE = Object.assign({}, BTN_STYLE, {
      width: "72px", padding: "4px 8px", cursor: "text",
    });

    /**
     * Bytes as a human string. 1024-based, one decimal below 100 so the jump
     * from "9.8 MB" to "10 MB" does not wobble the column width.
     */
    function humanBytes(bytes) {
      // 缺失（undefined / null / 空串）不是 0：Number(null) === 0，直接转数字会把
      // 「这个数没拿到」折叠成「0 B」，让统计失败看起来像真的一无所有。
      if (bytes === null || bytes === undefined || bytes === "") return DASH;
      var n = Number(bytes);
      // 缺失（undefined / null / NaN）与真 0 是两件事：前者是「这个数没拿到」，
      // 必须渲染 DASH 断杠；后者才是「0 B」——确实一颗快照都没占。把 NaN 折叠成
      // "0 B" 会让「统计失败」看起来像「真的一无所有」。
      if (!isFinite(n)) return DASH;
      // 负数在字节语境里没有意义，沿用旧行为按 0 处理（不显示负字节）。
      if (n <= 0) return "0 B";
      var units = ["B", "KB", "MB", "GB", "TB"];
      var at = 0;
      while (n >= 1024 && at < units.length - 1) { n = n / 1024; at += 1; }
      var text = at === 0 ? String(Math.round(n)) : (n >= 100 ? n.toFixed(0) : n.toFixed(1));
      return text + " " + units[at];
    }

    /** Milliseconds since epoch -> the local "YYYY-MM-DD HH:mm" a person reads. */
    function humanWhen(ms) {
      var value = Number(ms);
      if (!isFinite(value) || value <= 0) return "-";
      var d = new Date(value);
      if (!isFinite(d.getTime())) return "-";
      function p2(v) { return (v < 10 ? "0" : "") + v; }
      return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate())
        + " " + p2(d.getHours()) + ":" + p2(d.getMinutes());
    }

    /**
     * A duration of inactivity as a short human string.
     *
     * 🔴 A NULL IS NOT A ZERO. `idleMs === null` means "we have no timestamp for
     * this conversation", which is the opposite of "idle for 0 minutes" — the
     * first is unknown, the second is brand new. Printing "0 分钟" for an
     * unknown age would silently pull the row toward the top of a
     * threshold-based selection, so it prints a dash instead.
     *
     * The scale is deliberately coarse — hours up to two days, then days — so
     * the column stays narrow and comparable at a glance rather than reading
     * like a stopwatch.
     */
    function humanIdle(ms) {
      if (typeof ms !== "number" || !isFinite(ms) || ms < 0) return "-";
      var mins = Math.floor(ms / 60000);
      if (mins < 60) return mins + " 分钟";
      var hours = Math.floor(mins / 60);
      if (hours < 48) return hours + " 小时";
      return Math.floor(hours / 24) + " 天";
    }

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
      archive: "var(--dsw-alias-state-warn-primary, #ffb454)",
      attach: "var(--dsw-alias-state-success-primary, #4ec9a0)",
      manual: "var(--dsw-alias-label-secondary, rgba(255,255,255,.6))",
    };

    function UngroupedCard(props) {
      var headered = props || {};
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
      // The "hide the bucket" switch. Seeded from the module-level preference so
      // the checkbox always agrees with what the style rule is already doing.
      var hidePair = React.useState(function () { return readHideUngrouped(); });
      var hideBucket = hidePair[0];
      var setHideBucket = hidePair[1];

      // 0.37.1 — the header 刷新 button also re-runs the diagnosis. Mount is
      // still silent: the first render only records the tick it started with.
      var refreshSeen = React.useRef(null);
      React.useEffect(function () {
        var next = typeof headered.refreshTick === "number" ? headered.refreshTick : 0;
        if (refreshSeen.current === null) { refreshSeen.current = next; return; }
        if (next === refreshSeen.current) return;
        refreshSeen.current = next;
        diagnose();
      }, [headered.refreshTick]);

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
        style: ROW_STYLE,
      },
        React.createElement("div", { style: TITLE_STYLE }, "未分组体检"),
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
        style: HINT_STYLE,
      }, "侧栏底部的「未分组」不是删除对话造成的，也不是数据损坏。它是官方侧栏给"
        + "「磁盘上存在、却从未登记进任何工作区」的会话留的兜底分组。这里可以只读检查有多少条、"
        + "分别该怎么处理，并一键修掉。"));

      // -- the hide switch ---------------------------------------------------
      //
      // Deliberately placed BEFORE the diagnosis result: it is the answer for
      // "I do not care what is in there, I just do not want to see the group",
      // and that user should not have to run a scan first. It is a pure view
      // toggle — no host call, no file touched, instantly reversible.
      children.push(React.createElement("label", {
        key: "hide",
        style: {
          display: "flex", alignItems: "center", gap: "8px", cursor: "pointer",
          padding: "8px", borderRadius: "8px",
          background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))",
          lineHeight: "20px",
        },
      },
        React.createElement("input", {
          type: "checkbox",
          checked: hideBucket,
          onChange: function (event) {
            var next = Boolean(event && event.target && event.target.checked);
            setHideBucket(next);
            applyHideUngrouped(next);
          },
        }),
        React.createElement("span", null,
          "在侧栏隐藏「未分组」分组（连同组头一起隐藏，不删除任何对话）")));

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
          style: { lineHeight: "20px", fontWeight: clean ? "600" : "600", color: clean ? "var(--dsw-alias-state-success-primary, #4ec9a0)" : "var(--dsw-alias-state-warn-primary, #ffb454)" },
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
            style: Object.assign({ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "330px" }, LIST_SCROLL),
          },
          // 0.37.0 — the same six columns as every other list. The advice used
          // to own a second text line; it now rides the right edge as a badge
          // with the reason in the tooltip, so the columns stay aligned.
          [React.createElement(ListHead, { key: "list-head", tail: TAIL_ADVISE })].concat(
            entries.slice(0, 60).map(function (entry) {
            var created = entry.createdAt === null || entry.createdAt === undefined ? null : Number(entry.createdAt);
            return React.createElement(SessionRow, {
              key: entry.sessionId,
              row: {
                id: entry.sessionId,
                title: entry.title,
                untitled: "（无标题）",
                sizeText: Number.isFinite(Number(entry.size)) && Number(entry.size) > 0
                  ? humanBytes(entry.size)
                  : "",
                idleMs: Number.isFinite(created) && created > 0 ? Math.max(0, Date.now() - created) : null,
                fileCountText: "",
                workspaceText: workspaceName(entry.cwd),
                whenText: humanWhen(created),
              },
              hint: String(entry.reason || ""),
              tailWidth: TAIL_ADVISE,
              tail: React.createElement("span", {
                style: {
                  flex: "0 0 auto", fontSize: "10px", opacity: .8,
                  color: ADVISE_COLOR[entry.advise] || "inherit",
                },
              }, "建议：" + (ADVISE_LABEL[entry.advise] || entry.advise)),
            });
          })), entries.length > 60
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

      // The ghost block lives below the directory-based diagnosis because it is
      // the second half of the same story: the scan above can only see sessions
      // whose directory still exists. Declared further down in this scope; the
      // function declaration hoists, so referencing it here is safe.
      children.push(React.createElement(GhostCacheBlock, { key: "ghosts" }));
      // billion-context 缓存是同一层的第三块：前两块管「未分组」和「投影缓存孤儿」，
      // 这块管压缩插件自己的三类缓存。声明在下面，函数声明提升，这里引用安全。
      children.push(React.createElement(BillionCacheBlock, { key: "billion-cache" }));

      return React.createElement("div", { style: CARD_STYLE }, children);
    }

    // -----------------------------------------------------------------------
    // PROJECTION-CACHE GHOSTS
    // -----------------------------------------------------------------------
    // The diagnosis above walks session DIRECTORIES, so it cannot see the other
    // way this bucket fills up: a record that survives only in
    // `storages/session_projcache/sessions/<id>.json` after its directory is
    // gone. The running instance still renders it (title, token count and turn
    // outline all live in that cache) and it is in nobody's `sessionIds`, so the
    // sidebar files it under 未分组 — while every directory-based check reports
    // clean. Deleting the cache file deletes no conversation: there is no
    // directory left to hold one.
    // -----------------------------------------------------------------------
    // BILLION-CONTEXT CACHE (ACP)
    // -----------------------------------------------------------------------
    // 与上面两张卡同一层：前两张管「未分组会话」和「投影缓存孤儿」，这张管
    // billion-context 自己的三类缓存（ACP 会话状态、整包重写的 overview-cache、
    // 会话检索图片缓存）。扫描只读，清理进回收站，默认先试算。
    function BillionCacheBlock() {
      var reportPair = React.useState(null);
      var report = reportPair[0];
      var setReport = reportPair[1];
      var busyPair = React.useState("");
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var stagePair = React.useState("");
      var stage = stagePair[0];
      var setStage = stagePair[1];
      var resultPair = React.useState(null);
      var result = resultPair[0];
      var setResult = resultPair[1];
      var progressPair = React.useState(null);
      var progress = progressPair[0];
      var setProgress = progressPair[1];
      var rebuildPair = React.useState(false);
      var includeRebuild = rebuildPair[0];
      var setIncludeRebuild = rebuildPair[1];
      // 检索图片缓存的保留窗口。默认 0 = 全部视为可清理（图片可随用随重建），
      // 这也是本机 72 MB 检索缓存一直被“保留”而清不掉的原因。
      var keepDaysPair = React.useState(0);
      var keepDays = keepDaysPair[0];
      var setKeepDays = keepDaysPair[1];

      function scan() {
        setBusy("scan");
        setResult(null);
        setStage("");
        api("/billion-cache-diagnose", { keepDays: keepDays })
          .then(function (data) { setBusy(""); setReport(data || null); })
          .catch(function (error) {
            setBusy("");
            setReport({ ok: false, detail: String(error && error.message ? error.message : error) });
          });
      }

      function clean(dryRun) {
        var ids = report && Array.isArray(report.entries)
          ? report.entries.filter(function (entry) {
              return entry.deletable === true || (includeRebuild === true && entry.rebuild === true);
            }).map(function (entry) { return entry.id; })
          : [];
        setBusy(dryRun ? "dry" : "live");
        var jobId = jobIdFor("bc");
        var bytesGuess = report && report.summary ? Number(report.summary.entriesBytes) || 0 : 0;
        setProgress({ done: 0, total: ids.length, bytesFreed: 0, bytesTotal: bytesGuess,
          phase: dryRun === true ? "dryRun" : "billion", jobId: jobId });
        runJob("/billion-cache-clean", {
          targets: ids,
          dryRun: dryRun === true,
          confirm: dryRun !== true,
          includeRebuild: includeRebuild === true,
          keepDays: keepDays,
        }, {
          jobId: jobId,
          onProgress: function (snap) { setProgress(snap); },
          onDone: function (data) {
            setBusy(""); setProgress(null); setResult(data || null);
            if (dryRun !== true) scan(); else setStage("live");
          },
          onFail: function (error) {
            setBusy(""); setProgress(null); setStage("");
            setResult({ error: String(error && error.message ? error.message : error) });
          },
        });
      }

      var summary = report && report.summary ? report.summary : null;
      var entries = report && Array.isArray(report.entries) ? report.entries : [];
      var totalBytes = summary ? Number(summary.totalBytes) || 0 : 0;
      var cleanableCount = entries.filter(function (e) {
        return e.deletable === true || (includeRebuild === true && e.rebuild === true);
      }).length;
      var kids = [];
      kids.push(React.createElement("div", { key: "bc-head", style: ROW_STYLE },
        React.createElement("div", { style: TITLE_STYLE }, "billion-context 缓存"),
        React.createElement("button", {
          type: "button", style: BTN_STYLE, disabled: busy !== "",
          onClick: scan,
        }, busy === "scan" ? "扫描中…" : "扫描")));
      kids.push(React.createElement("div", { key: "bc-desc", style: { fontSize: "12px", lineHeight: "18px", opacity: .8, margin: "4px 0 8px" } },
        "billion-context（ACP）的会话状态、整包重写的 overview-cache 和检索图片缓存。扫描只读；清理一律进 Windows 回收站（可恢复），可重建缓存需勾选后才清。"));
      if (report === null) {
        kids.push(React.createElement("div", { key: "bc-idle", style: { fontSize: "12px", opacity: .75 } },
          "点「扫描」查看 billion-context 缓存占用（只读，不改任何文件）。"));
      } else if (report.ok !== true) {
        kids.push(React.createElement("div", { key: "bc-err", style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #ff6b6b)" } },
          "扫描失败：" + String(report.error || report.detail || "unknown")));
      } else if (entries.length === 0 && totalBytes === 0) {
        kids.push(React.createElement("div", { key: "bc-clean", style: { fontSize: "12px", opacity: .8 } },
          "✅ 未发现可清理的 billion-context 缓存。"));
      } else {
        kids.push(React.createElement("div", { key: "bc-sum", style: { fontSize: "12px", opacity: .85, marginBottom: "4px" } },
          "可清理 " + cleanableCount + " 项 · 约 " + (Math.round((summary && summary.deletableBytes || 0) / 1024 / 1024 * 10) / 10) + " MB"
          + "（目录总计 " + (Math.round(totalBytes / 1024 / 1024 * 10) / 10) + " MB）"));
        kids.push(React.createElement("div", { key: "bc-list", style: { maxHeight: "160px", overflow: "auto", fontSize: "11px", lineHeight: "17px", opacity: .85, marginBottom: "6px" } },
          entries.slice(0, 40).map(function (entry, i) {
            var locked = !(entry.deletable === true || entry.rebuild === true);
            return React.createElement("div", { key: "bc-row-" + i, title: String(entry.reason || "") },
              (locked ? "🔒 " : (entry.rebuild ? "♻ " : "• ")) + String(entry.kindLabel || entry.kind) + " · "
              + (Math.round((Number(entry.bytes) || 0) / 1024 * 10) / 10) + " KB"
              + "  " + String(entry.rel || entry.path || ""));
          })));
        kids.push(React.createElement("label", { key: "bc-keep", style: { fontSize: "12px", display: "block", marginBottom: "6px", opacity: .85 } },
          "检索图片缓存保留 ",
          React.createElement("select", {
            value: String(keepDays),
            style: { fontSize: "12px", margin: "0 4px" },
            onChange: function (e) { setKeepDays(Number(e.target.value)); setReport(null); setResult(null); },
          }, [0, 1, 3, 7].map(function (d) {
            return React.createElement("option", { key: "kd-" + d, value: String(d) }, d === 0 ? "0 天（全部可清）" : d + " 天");
          })),
          "（改完自动重新扫描）"));
        kids.push(React.createElement("label", { key: "bc-rebuild", style: { fontSize: "12px", display: "block", marginBottom: "6px", opacity: .85 } },
          React.createElement("input", {
            type: "checkbox", checked: includeRebuild,
            onChange: function (e) { setIncludeRebuild(e.target.checked); },
          }), " 同时清理可重建缓存（overview-cache / models-dev 等，删除后会自动重建）"));
        kids.push(React.createElement("div", { key: "bc-actions", style: { display: "flex", gap: "8px" } },
          React.createElement("button", {
            type: "button", style: BTN_STYLE, disabled: busy !== "",
            onClick: function () { clean(true); },
          }, busy === "dry" ? "试算中…" : "试算清理"),
          React.createElement("button", {
            type: "button", style: BTN_STYLE, disabled: busy !== "" || stage !== "live",
            onClick: function () { clean(false); },
          }, busy === "live" ? "清理中…" : "清理到回收站")));
      }
      if (progress && typeof progress === "object") {
        kids.push(React.createElement(ProgressBar, {
          key: "bc-progress", progress: progress, doneVerb: "已清理", noun: "缓存",
          fallbackLabel: "正在清理 billion-context 缓存…",
        }));
      }
      if (result) {
        var failed = Boolean(result.error);
        kids.push(React.createElement("div", { key: "bc-result", style: {
          padding: "8px", borderRadius: "8px", lineHeight: "20px", fontSize: "12px", marginTop: "6px",
          background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))",
          color: failed ? "var(--dsw-alias-state-error-primary, #ff6b6b)" : "inherit",
        } }, failed
          ? "执行失败：" + String(result.error)
          : (result.dryRun ? "【试算结果，未做任何修改】" : "【已执行】")
            + " 清理 " + ((result.deleted || []).length) + " 项"
            + "｜跳过 " + ((result.skipped || []).length) + " 项"
            + "｜失败 " + ((result.failures || []).length) + " 项"
            + "｜释放 " + (Math.round((Number(result.bytesFreed) || 0) / 1024)) + " KB"));
      }
      return React.createElement("div", { style: { marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.08))" } }, kids);
    }

    function GhostCacheBlock() {
      var reportPair = React.useState(null);
      var report = reportPair[0];
      var setReport = reportPair[1];
      var busyPair = React.useState("");
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var stagePair = React.useState("");
      var stage = stagePair[0];
      var setStage = stagePair[1];
      var resultPair = React.useState(null);
      var result = resultPair[0];
      var setResult = resultPair[1];
      var progressPair = React.useState(null);
      var progress = progressPair[0];
      var setProgress = progressPair[1];
      // 0.36.0: keeping pinned / archived ghosts is now an OPT-IN, not the
      // default. Before this the list said "置顶，保留" for 86 of 86 entries on
      // this machine and pressing confirm deleted nothing — the flag being
      // honoured was an orphan id in workspace.json, guarding a cache file whose
      // conversation directory had been gone for weeks.
      var keepPair = React.useState({ pinned: false, archived: false });
      var keep = keepPair[0];
      var setKeep = keepPair[1];

      function scan() {
        setBusy("scan");
        setResult(null);
        setStage("");
        api("/ghost-cache-diagnose", { currentSessionId: affCurrentSessionId() })
          .then(function (data) {
            setBusy("");
            setReport(data || null);
          })
          .catch(function (error) {
            setBusy("");
            setReport({ ok: false, detail: String(error && error.message ? error.message : error) });
          });
      }

      function clean(dryRun) {
        var ids = report && Array.isArray(report.ghosts)
          ? report.ghosts.map(function (entry) { return entry.sessionId; })
          : [];
        setBusy(dryRun ? "dry" : "live");
        // 0.42.0 — 清理也改成 job：接单即回执，进度走同一条流 / 同一个读取路由，
        // 用的就是快照清理那条进度条的同一个组件（用户要求「保持一致」）。
        var jobId = jobIdFor("gc");
        var bytesGuess = report && report.summary ? Number(report.summary.bytes) || 0 : 0;
        setProgress({
          done: 0, total: ids.length, bytesFreed: 0, bytesTotal: bytesGuess,
          phase: dryRun === true ? "dryRun" : "ghost", jobId: jobId,
        });
        runJob("/ghost-cache-clean", {
          sessionIds: ids,
          dryRun: dryRun === true,
          // The host only honours `dryRun: false` together with `confirm: true`.
          confirm: dryRun !== true,
          // Explicit opt-out only. Everything is deletable unless the user says
          // otherwise, which is the whole point of the 0.36.0 change.
          keepPinned: keep.pinned === true,
          keepArchived: keep.archived === true,
        }, {
          jobId: jobId,
          onProgress: function (snap) { setProgress(snap); },
          onDone: function (data) {
            setBusy("");
            setProgress(null);
            setResult(data || null);
            if (dryRun !== true) scan();
            else setStage("live");
          },
          onFail: function (error) {
            setBusy("");
            setProgress(null);
            setStage("");
            setResult({ error: String(error && error.message ? error.message : error) });
          },
        });
      }

      var summary = report && report.summary ? report.summary : null;
      var ghostCount = summary ? (summary.ghostCount || 0) : 0;
      var cleanReport = report !== null && report.ok === true && ghostCount === 0;
      var kids = [];

      kids.push(React.createElement("div", {
        key: "g-head",
        style: ROW_STYLE,
      },
        React.createElement("div", { style: TITLE_STYLE }, "孤儿缓存"),
        React.createElement("button", {
          type: "button", style: BTN_STYLE, disabled: busy !== "",
          onClick: scan,
        }, busy === "scan" ? "检查中…" : "扫描")));

      kids.push(React.createElement("div", {
        key: "g-intro",
        style: HINT_STYLE,
      }, "有一种条目上面那个体检看不见：会话目录早已不在，但投影缓存"
        + "（storages/session_projcache）里还留着它的标题、token 数和对话摘要。"
        + "运行中的侧栏照样把它画出来，而它不在任何工作区的名单里，于是落进「未分组」。"
        + "清理这些缓存不会删掉任何对话——目录都不存在了，本来就没有对话可删。"));

      if (report === null) {
        kids.push(React.createElement("div", { key: "g-idle", style: { opacity: .65 } },
          "点「扫描」列出孤儿缓存（只读，不改任何文件）。"));
      } else if (report.ok !== true) {
        kids.push(React.createElement("div", {
          key: "g-err",
          style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #ff6b6b)" },
        }, "扫描失败：" + String(report.detail || "未知原因")));
      } else if (cleanReport) {
        kids.push(React.createElement("div", {
          key: "g-clean",
          style: { fontSize: "12px", color: "var(--dsw-alias-state-success-primary, #4ec9a0)" },
        }, "✅ 没有孤儿缓存（" + summary.cacheFiles + " 份缓存 vs " + summary.diskSessions + " 个会话目录）"));
      } else {
        kids.push(React.createElement("div", {
          key: "g-counts",
          style: { fontSize: "12px", opacity: .8, lineHeight: "18px" },
        }, "孤儿缓存 " + ghostCount + " 条 · 共 " + Math.round((summary.bytes || 0) / 1024) + " KB"
          + "（缓存 " + summary.cacheFiles + " 份 vs 目录 " + summary.diskSessions + " 个"
          + "；其中置顶 " + (summary.pinnedGhostCount || 0) + " 条、已归档 "
          + (summary.archivedGhostCount || 0) + " 条）"));

        // 0.36.0: the keep box. Opt-in protection instead of opt-out, so the
        // default answer to "there are 86 orphan caches" is finally "delete them".
        kids.push(React.createElement("label", {
          key: "g-keep",
          style: {
            display: "flex", alignItems: "center", gap: "6px", fontSize: "12px",
            cursor: "pointer", lineHeight: "18px",
          },
        },
          React.createElement("input", {
            type: "checkbox",
            "aria-label": "保留已归档或置顶的孤儿缓存",
            checked: keep.archived === true || keep.pinned === true,
            onChange: function (event) {
              var next = Boolean(event && event.target && event.target.checked);
              setKeep({ pinned: next, archived: next });
              setStage("");
              setResult(null);
            },
          }),
          React.createElement("span", null, "保留已归档 / 置顶的那几条")));

        kids.push(React.createElement("div", {
          key: "g-list",
          style: Object.assign({ display: "flex", flexDirection: "column", gap: "3px", maxHeight: "300px" }, LIST_SCROLL),
        },
        // 0.37.0 — six columns here too; 置顶 / 已归档 become row tags instead
        // of trailing text so they stop shifting the time column.
        [React.createElement(ListHead, { key: "g-list-head", tail: TAIL_BADGE })].concat(
          report.ghosts.slice(0, 40).map(function (entry) {
          var stamp = entry.lastPromptAt ?? entry.createdAt ?? null;
          var ms = stamp === null ? null : Number(stamp);
          var tag = entry.pinned ? "置顶" : (entry.archived ? "已归档" : "");
          return React.createElement(SessionRow, {
            key: entry.sessionId,
            row: {
              id: entry.sessionId,
              title: entry.title,
              untitled: "（无标题）",
              sizeText: Number.isFinite(Number(entry.bytes)) && Number(entry.bytes) > 0
                ? humanBytes(entry.bytes)
                : "",
              idleMs: Number.isFinite(ms) && ms > 0 ? Math.max(0, Date.now() - ms) : null,
              // A ghost is exactly one projection-cache file, so the count is known
              // even though nothing on disk can be walked any more.
              fileCountText: countText(1),
              workspaceText: workspaceName(entry.cwd),
              whenText: humanWhen(ms),
            },
            tailWidth: TAIL_BADGE,
            tail: tag.length > 0
              ? React.createElement("span", {
                  style: { flex: "0 0 auto", fontSize: "10px", opacity: entry.pinned ? .55 : .75 },
                }, tag)
              : null,
          });
        })), report.ghosts.length > 40
          ? React.createElement("div", { key: "g-more", style: { fontSize: "11px", opacity: .6 } },
              "还有 " + (report.ghosts.length - 40) + " 条未显示（清理会覆盖全部）。")
          : null));

        if (stage === "") {
          kids.push(React.createElement("div", { key: "g-act", style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
            React.createElement("button", {
              type: "button", style: BTN_STYLE, disabled: busy !== "",
              onClick: function () { clean(true); },
            }, busy === "dry" ? "试算中…" : "试算（不修改任何文件）")));
        }

        if (stage === "live") {
          kids.push(React.createElement("div", {
            key: "g-confirm",
            style: {
              display: "flex", flexDirection: "column", gap: "8px", padding: "8px",
              borderRadius: "8px", background: "var(--dsw-alias-bg-warning, rgba(255,107,107,.1))",
            },
          },
            React.createElement("div", { style: { lineHeight: "20px" } },
              "确认清理这 " + ghostCount + " 份孤儿缓存？文件进 Windows 回收站（可恢复），"
              + "不会删除任何对话——这些会话的目录早就不存在了。"
              + (keep.archived === true || keep.pinned === true
                ? "已勾选保留的那几条会跳过。"
                : "")),
            React.createElement("div", { style: { display: "flex", gap: "6px" } },
              React.createElement("button", {
                type: "button", style: DANGER_STYLE, disabled: busy !== "",
                onClick: function () { clean(false); },
              }, busy === "live" ? "清理中…" : "确认清理"),
              React.createElement("button", {
                type: "button", style: BTN_STYLE, disabled: busy !== "",
                onClick: function () { setStage(""); },
              }, "取消"))));
        }
      }

      // 进度条在结果区上方：先看见「正在清第几份」，再看见「清完了」。
      // 顺序与快照清理卡一致，样式也是同一个组件（不是另画的）。
      if (progress && typeof progress === "object") {
        kids.push(React.createElement(ProgressBar, {
          key: "g-progress",
          progress: progress,
          doneVerb: "已清理",
          noun: "缓存",
          fallbackLabel: "正在清理孤儿缓存…",
        }));
      }

      if (result) {
        var failed = Boolean(result.error);
        kids.push(React.createElement("div", {
          key: "g-result",
          style: {
            padding: "8px", borderRadius: "8px", lineHeight: "20px", fontSize: "12px",
            background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))",
            color: failed ? "var(--dsw-alias-state-error-primary, #ff6b6b)" : "inherit",
          },
        }, failed
          ? "执行失败：" + String(result.error)
          : (result.dryRun ? "【试算结果，未做任何修改】" : "【已执行】")
            + " 清理 " + ((result.deleted || []).length) + " 份"
            + "｜跳过 " + ((result.skipped || []).length)
            + "｜失败 " + ((result.failures || []).length)
            + "｜释放 " + Math.round((result.bytesFreed || 0) / 1024) + " KB",
        (result.failures && result.failures.length)
          ? React.createElement("div", { style: { marginTop: "4px", opacity: .75 } },
              result.failures.slice(0, 5).map(function (item) {
                return String(item.sessionId) + "：" + String(item.reason);
              }).join("；"))
          : null));
      }

      return React.createElement("div", {
        style: {
          display: "flex", flexDirection: "column", gap: "8px", marginTop: "4px",
          paddingTop: "10px", borderTop: "1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.12))",
        },
      }, kids);
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

    // =====================================================================
    // SNAPSHOT STORAGE USAGE — the 快照清理 card (was "快照占用" before 0.36.0)
    //
    // WHAT THE LEDGER IS
    //   Every `write` / `edit` / `str_replace_editor` tool call stores the
    //   file's pre-edit bytes under <session>/history-file/blobs/<sha256>, with
    //   one manifest row per event. That is what makes "undo this turn" able to
    //   put a file back. Nothing caps it, so a long session accumulates: the
    //   author's machine carries 25.4 MB across 59 sessions, the worst single
    //   session holding 10.4 MB of it.
    //
    // 🔴 WHY THERE IS A BUTTON AND NOT A NUMBER ON LOAD
    //   Measuring means walking every session directory and stat-ing every
    //   blob. Doing that on mount would run behind the user's back every time
    //   the settings page opens — exactly the kind of hidden work that gets
    //   blamed for a stutter somewhere else. So this card starts empty and
    //   measures ONLY when "立即统计" is pressed. No interval, no re-scan on
    //   render, no effect that fetches.
    //
    // 🔴 WHY DELETING IS MANUAL AND NOT AUTOMATIC
    //   An earlier generation of this plugin pruned ledgers automatically and
    //   that was removed on purpose: it silently destroyed the recovery path
    //   for conversations old enough to matter. So there is no age policy and
    //   no size ceiling — the user selects rows, sees a dry-run count, and only
    //   then confirms. Deletion goes to the recycle bin.
    // =====================================================================
    // =====================================================================
    // SHARED PRE-TICK SHELL (0.31.0)
    //
    // Three surfaces ask the same question: "here is a table of rows, tick the
    // stale ones for me, then let me remove exactly what I ticked". They are
    // the snapshot ledger, the archived-conversation list, and — as a preview
    // only — the idle-archive candidates. Writing that three times would
    // guarantee the three drift: one card grows a confirm step the others lack,
    // one forgets `confirm: true`, and the difference is only discovered by
    // deleting something by accident.
    //
    // So the table, the threshold row, the switch, the risk acknowledgement and
    // the two-step confirm are ONE implementation here. What each card keeps
    // for itself is what actually differs: WHERE the rows come from, WHICH
    // policy file they obey, and WHAT the confirmation has to say about the
    // damage ("undo an old turn" is not "the conversation is gone").
    //
    // 🔴 THE SHELL IS PRESENTATION PLUS CONFIRM ORCHESTRATION. It owns no data
    // source and no policy storage, because two cards sharing a policy file
    // would mean tuning the cheap action silently widens the expensive one.
    // Each card passes its own `route` to `usePreTickPolicy`.
    // =====================================================================

    /** Ids of the ticked rows, in insertion order. */
    function tickedIds(chosen) {
      var ids = [];
      for (var key in chosen) { if (chosen[key] === true) ids.push(key); }
      return ids;
    }

    /** Rebuild the tick set instead of mutating it, like React expects. */
    function retoggle(chosen, sessionId) {
      var next = {};
      var ids = tickedIds(chosen);
      for (var i = 0; i < ids.length; i += 1) next[ids[i]] = true;
      if (next[sessionId] === true) delete next[sessionId];
      else next[sessionId] = true;
      return next;
    }

    /**
     * Rows a policy pre-ticks: idle longer than the threshold and not
     * protected. Pure, so the cards and the probe can reason about it without a
     * DOM.
     *
     * Three exclusions, each with a reason:
     *   * `protected` — a starred conversation is never a cleanup candidate;
     *   * `idleMs === null` — no timestamp means no evidence of age, and
     *     "unknown age" must never read as "old";
     *   * `autoSelect !== true` — off means off; the switch belongs to the user.
     */
    function autoPick(rows, policy) {
      if (!policy || policy.autoSelect !== true) return {};
      var hours = Number(policy.hours);
      if (!isFinite(hours) || hours <= 0) return {};
      var cutoff = hours * 3600000;
      var next = {};
      var list = Array.isArray(rows) ? rows : [];
      for (var i = 0; i < list.length; i += 1) {
        var row = list[i];
        if (!row || row.protected === true) continue;
        if (typeof row.idleMs !== "number" || !isFinite(row.idleMs)) continue;
        if (row.idleMs < cutoff) continue;
        next[String(row.id)] = true;
      }
      return next;
    }

    /** The last folder of a working directory. The renderer has no node:path. */
    function lastFolder(cwd) {
      var text = typeof cwd === "string" ? cwd.replace(/[\\/]+$/, "") : "";
      if (text.length === 0) return "";
      var parts = text.split(/[\\/]/);
      return parts[parts.length - 1] || "";
    }

    // ---- 工作区名称 -------------------------------------------------------
    //
    // 0.37.1 — this column used to print the LAST FOLDER of the cwd, so every
    // row in the delete / snapshot panels read "workspace". That is where the
    // conversation's files live, not what the workspace is called: the registry
    // itself says "DeepSeek Chat". One tiny read at page open fills this cache;
    // any path we cannot match still falls back to the folder, because a wrong
    // name is worse than an honest directory.
    var WORKSPACE_TITLES = null;

    function workspaceName(cwd) {
      var last = lastFolder(cwd);
      if (last.length === 0) return "";
      if (WORKSPACE_TITLES === null) return last;
      var key = typeof cwd === "string" ? cwd.replace(/[\\/]+$/, "").toLowerCase() : "";
      var titled = WORKSPACE_TITLES[key];
      return typeof titled === "string" && titled.length > 0 ? titled : last;
    }

    function loadWorkspaceTitles() {
      return api("/workspace-titles").then(function (data) {
        if (data && data.ok === true && data.titles && typeof data.titles === "object") {
          WORKSPACE_TITLES = data.titles;
        }
      }).catch(function () {
        // No titles: every row falls back to the folder name.
      });
    }

    // ---- one row, six columns, every list --------------------------------
    //
    // 0.37.0 — this page has seven lists. Before this block each one invented
    // its own columns, so "which is bigger", "which is older" and "which
    // workspace" meant something different in every panel and the same
    // conversation looked like a different record in each place.
    //
    // Every list now renders through SessionRow, and the six columns are
    // always these six, always in this order:
    //
    //   文件大小 | 时长 | 对话名称 | 文件数量 | 工作区名称 | 时间
    //
    // A value the row genuinely does not have prints an em dash. It is NOT
    // blank and NOT omitted: an empty cell collapses the column and pushes
    // every later fact one slot to the left, which is exactly how two lists
    // end up looking like two different schemas. The dash is also a promise —
    // no cell is ever filled by scanning the disk on its own (see 快速上手).
    var DASH = "—";
    /**
     * The column captions, in the order the user asked for. Defined once so the
     * header row and any future reader cannot drift apart.
     */
    var LIST_COLUMNS = ["文件大小", "时长", "对话名称", "文件数量", "工作区名称", "时间"];
    // 0.38.0 — the six columns are a real grid now, and the layout belongs to
    // the reader: drag a caption to move that column, drag its right edge (or
    // double-click it) to change its width. Both live in ONE module-level
    // layout that every list reads, because the failure this page keeps
    // re-earning is two lists disagreeing about the schema.
    //
    // Why a grid instead of the flex row used through 0.37.2: a flex row cannot
    // align a caption against a row that also carries per-row buttons or
    // badges. 收藏清单 puts three buttons in its tail, so its 时间 cell began
    // ~90px left of the 时间 caption — visible in the user's screenshot, and
    // impossible to fix by tuning widths. Caption and rows now share one grid
    // template, so the columns line up by construction and "wider" is one
    // number in that template.
    //
    // The default is the order the user asked for:
    //   文件大小 | 时长 | 对话名称 | 文件数量 | 工作区名称 | 时间
    // A value the row genuinely does not have still prints an em dash — never
    // a blank cell (a blank cell shifts every later fact one slot left).
    var COLUMN_DEFS = [
      { key: "size", label: LIST_COLUMNS[0], width: 60, min: 40, max: 200, align: "left", track: "px" },
      { key: "idle", label: LIST_COLUMNS[1], width: 56, min: 40, max: 180, align: "right", track: "px" },
      { key: "name", label: LIST_COLUMNS[2], width: 150, min: 90, max: 560, align: "left", track: "name" },
      { key: "count", label: LIST_COLUMNS[3], width: 66, min: 44, max: 200, align: "right", track: "px" },
      { key: "workspace", label: LIST_COLUMNS[4], width: 96, min: 56, max: 360, align: "left", track: "cap" },
      { key: "when", label: LIST_COLUMNS[5], width: 100, min: 84, max: 220, align: "right", track: "px" },
    ];
    var COLUMN_LAYOUT_KEY = "dsh-aff-column-layout";
    // Reserved tracks around the six columns. A tail that only some rows carry
    // (a badge, three buttons) must still be paid for by the caption, or the
    // caption's last columns float right of the rows underneath them.
    var COLUMN_LEAD_TRACK = 13;
    var TAIL_ADVISE = 116;
    var TAIL_BADGE = 62;
    var TAIL_ACTIONS = 276;

    function columnDef(key) {
      for (var i = 0; i < COLUMN_DEFS.length; i += 1) {
        if (COLUMN_DEFS[i].key === key) return COLUMN_DEFS[i];
      }
      return null;
    }

    function defaultColumnLayout() {
      var order = [];
      var widths = {};
      COLUMN_DEFS.forEach(function (def) {
        order.push(def.key);
        widths[def.key] = def.width;
      });
      return { order: order, widths: widths };
    }

    /**
     * Anything read back from disk goes through here. A stored layout that has
     * lost a column would silently drop a fact from every list on the page, so
     * unknown keys are dropped and missing ones are appended — never merged by
     * trusting the file.
     */
    function normaliseColumnLayout(raw) {
      var layout = defaultColumnLayout();
      if (!raw || typeof raw !== "object") return layout;
      var order = [];
      var seen = {};
      var stored = Array.isArray(raw.order) ? raw.order : [];
      for (var i = 0; i < stored.length; i += 1) {
        var key = String(stored[i]);
        if (!columnDef(key) || seen[key] === true) continue;
        seen[key] = true;
        order.push(key);
      }
      COLUMN_DEFS.forEach(function (def) {
        if (seen[def.key] !== true) order.push(def.key);
      });
      var widths = {};
      COLUMN_DEFS.forEach(function (def) {
        var value = raw.widths && typeof raw.widths === "object" ? Number(raw.widths[def.key]) : NaN;
        widths[def.key] = Number.isFinite(value)
          ? Math.min(def.max, Math.max(def.min, Math.round(value)))
          : def.width;
      });
      return { order: order, widths: widths };
    }

    var COLUMN_LAYOUT = (function () {
      try {
        var text = localStorage.getItem(COLUMN_LAYOUT_KEY);
        if (text === null || text === undefined) return defaultColumnLayout();
        return normaliseColumnLayout(JSON.parse(text));
      } catch (e) {
        return defaultColumnLayout();
      }
    })();
    var COLUMN_DRAG_KEY = null;
    // The settings section hands in its own state bump here so a caption drag
    // repaints the page without every list having to thread a prop through.
    var COLUMN_LAYOUT_BUMP = null;

    function columnOrder() { return COLUMN_LAYOUT.order.slice(); }
    function columnWidth(key) {
      var value = COLUMN_LAYOUT.widths[key];
      return Number.isFinite(value) ? value : 0;
    }
    function columnIsCustomised() {
      for (var i = 0; i < COLUMN_DEFS.length; i += 1) {
        var def = COLUMN_DEFS[i];
        if (COLUMN_LAYOUT.order[i] !== def.key) return true;
        if (COLUMN_LAYOUT.widths[def.key] !== def.width) return true;
      }
      return false;
    }
    function bumpColumnLayout() {
      if (typeof COLUMN_LAYOUT_BUMP === "function") COLUMN_LAYOUT_BUMP();
    }
    function saveColumnLayout() {
      try {
        if (columnIsCustomised()) localStorage.setItem(COLUMN_LAYOUT_KEY, JSON.stringify(COLUMN_LAYOUT));
        else localStorage.removeItem(COLUMN_LAYOUT_KEY);
      } catch (e) {}
    }
    /** One CSS track per column, in the reader's order. */
    function columnTemplate(options) {
      var opts = options || {};
      var parts = [];
      if (opts.lead) parts.push(COLUMN_LEAD_TRACK + "px");
      COLUMN_LAYOUT.order.forEach(function (key) {
        var def = columnDef(key);
        var width = columnWidth(key);
        if (def && def.track === "name") parts.push("minmax(" + width + "px, 1.6fr)");
        else if (def && def.track === "cap") parts.push("minmax(" + width + "px, " + Math.max(width * 2, 160) + "px)");
        else parts.push(width + "px");
      });
      if (opts.tail) parts.push(Math.max(0, Number(opts.tail) || 0) + "px");
      return parts.join(" ");
    }
    function moveColumn(fromKey, toKey) {
      var order = COLUMN_LAYOUT.order.slice();
      var from = order.indexOf(String(fromKey));
      var to = order.indexOf(String(toKey));
      if (from < 0 || to < 0 || from === to) return false;
      order.splice(to, 0, order.splice(from, 1)[0]);
      COLUMN_LAYOUT.order = order;
      saveColumnLayout();
      bumpColumnLayout();
      return true;
    }
    function applyColumnWidth(key, px) {
      var def = columnDef(key);
      var value = Number(px);
      if (!def || !Number.isFinite(value)) return false;
      var next = Math.min(def.max, Math.max(def.min, Math.round(value)));
      if (next === COLUMN_LAYOUT.widths[key]) return false;
      COLUMN_LAYOUT.widths[key] = next;
      return true;
    }
    function setColumnWidth(key, px) {
      if (!applyColumnWidth(key, px)) return false;
      saveColumnLayout();
      bumpColumnLayout();
      return true;
    }
    var COLUMN_WIDTH_STEPS = [0, 60, 140];
    /** Double-click a grip: default -> wider -> widest -> default. */
    function cycleColumnWidth(key) {
      var def = columnDef(key);
      if (!def) return;
      var offset = columnWidth(key) - def.width;
      var at = COLUMN_WIDTH_STEPS.indexOf(offset);
      var step = COLUMN_WIDTH_STEPS[(at + 1) % COLUMN_WIDTH_STEPS.length];
      setColumnWidth(key, def.width + step);
    }
    function resetColumnWidth(key) {
      var def = columnDef(key);
      if (def) setColumnWidth(key, def.width);
    }
    function resetColumnLayout() {
      COLUMN_LAYOUT = defaultColumnLayout();
      COLUMN_DRAG_KEY = null;
      saveColumnLayout();
      bumpColumnLayout();
    }
    /**
     * Drag a grip: live width while the pointer moves, one write when released.
     * Nothing is persisted per pixel — a resize is not a reason to touch the
     * disk 300 times.
     */
    function beginColumnResize(event, key) {
      if (!event || typeof event.clientX !== "number") return;
      var startX = event.clientX;
      var startWidth = columnWidth(key);
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (typeof event.stopPropagation === "function") event.stopPropagation();
      function onMove(moveEvent) {
        if (!moveEvent || typeof moveEvent.clientX !== "number") return;
        if (applyColumnWidth(key, startWidth + (moveEvent.clientX - startX))) bumpColumnLayout();
      }
      function onUp() {
        try { document.removeEventListener("mousemove", onMove); } catch (e) {}
        try { document.removeEventListener("mouseup", onUp); } catch (e) {}
        saveColumnLayout();
      }
      try {
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      } catch (e) {}
    }
    /** A list that cannot show every column scrolls; it never drops one. */
    var LIST_SCROLL = { overflowX: "auto", overflowY: "auto" };

    /** Empty is a dash, never a blank cell. */
    function dashOr(text) {
      var value = typeof text === "string" ? text.trim() : "";
      return value.length > 0 ? value : DASH;
    }

    /** "12 个文件", or empty (=> dash) when the count is genuinely unknown. */
    function countText(n) {
      var value = Number(n);
      if (!Number.isFinite(value) || value <= 0) return "";
      return value + " 个文件";
    }

    /** ISO string -> epoch ms, or null. Favourites store an ISO stamp. */
    function msOfIso(value) {
      var parsed = typeof value === "string" ? Date.parse(value) : NaN;
      return Number.isFinite(parsed) ? parsed : null;
    }

    /** Age from an absolute timestamp; null when the stamp is missing. */
    function ageMsOf(ms) {
      var value = Number(ms);
      if (!Number.isFinite(value) || value <= 0) return null;
      return Math.max(0, Date.now() - value);
    }

    /**
     * The caption line. It is the SAME grid as SessionRow, with the same
     * template, so the columns line up no matter what a row carries on its
     * right. `tail` is the width reserved for the row tail (badges / buttons)
     * — the caption has to pay for it or its last columns drift right of the
     * rows underneath.
     *
     * 0.38.0 — the caption is also the control surface: drag a caption sideways
     * to move that column, drag the grip on its right edge to resize it,
     * double-click the grip to cycle through three widths. All three write the
     * one shared layout, so every list on the page follows.
     */
    function ListHead(props) {
      var tail = Number(props.tail) || 0;
      var cells = columnOrder().map(function (key) {
        var def = columnDef(key);
        var label = def ? def.label : key;
        var isTarget = COLUMN_DRAG_KEY !== null && COLUMN_DRAG_KEY !== key;
        return React.createElement("div", {
          key: "cap-" + key,
          draggable: true,
          title: "拖动可调整这一列的位置；拖右侧竖线可调宽度，双击竖线在三种宽度间切换",
          "data-aff-col": key,
          style: {
            display: "flex", alignItems: "center", gap: "3px", minWidth: 0,
            justifyContent: def && def.align === "right" ? "flex-end" : "flex-start",
            cursor: "grab", userSelect: "none",
            outline: isTarget ? "1px dashed var(--dsw-alias-border-l4, rgba(127,127,127,.4))" : "none",
            outlineOffset: "-1px",
            borderRadius: "3px",
            opacity: .62,
          },
          onDragStart: function (event) {
            COLUMN_DRAG_KEY = key;
            try { event.dataTransfer.setData("text/plain", key); } catch (e) {}
            if (typeof event.dataTransfer === "object" && event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          },
          onDragOver: function (event) {
            if (COLUMN_DRAG_KEY === null || COLUMN_DRAG_KEY === key) return;
            if (typeof event.preventDefault === "function") event.preventDefault();
            if (typeof event.dataTransfer === "object" && event.dataTransfer) event.dataTransfer.dropEffect = "move";
          },
          onDrop: function (event) {
            if (typeof event.preventDefault === "function") event.preventDefault();
            var from = COLUMN_DRAG_KEY;
            COLUMN_DRAG_KEY = null;
            if (from !== null) moveColumn(from, key);
          },
          onDragEnd: function () { COLUMN_DRAG_KEY = null; },
        },
          React.createElement("span", {
            style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          }, label),
          // The grip is a real control with its own label, so the resize is not
          // a mouse-only secret: focusable, titled, and double-clickable.
          React.createElement("span", {
            role: "separator",
            "aria-label": "调整「" + label + "」列宽",
            "aria-orientation": "vertical",
            tabIndex: 0,
            title: "拖动调整宽度；双击恢复默认",
            "data-aff-grip": key,
            style: {
              flex: "0 0 auto", width: "5px", alignSelf: "stretch", marginLeft: "1px",
              cursor: "col-resize",
              borderLeft: "1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.16))",
            },
            onMouseDown: function (event) { beginColumnResize(event, key); },
            onDoubleClick: function (event) {
              if (typeof event.preventDefault === "function") event.preventDefault();
              if (typeof event.stopPropagation === "function") event.stopPropagation();
              cycleColumnWidth(key);
            },
            onKeyDown: function (event) {
              if (!event) return;
              var step = 0;
              if (event.key === "ArrowLeft") step = -10;
              else if (event.key === "ArrowRight") step = 10;
              else if (event.key === "Enter") { cycleColumnWidth(key); return; }
              else if (event.key === "Backspace") { resetColumnWidth(key); return; }
              if (step === 0) return;
              if (typeof event.preventDefault === "function") event.preventDefault();
              setColumnWidth(key, columnWidth(key) + step);
            },
            onDragStart: function (event) { if (event && typeof event.preventDefault === "function") event.preventDefault(); },
          }));
      });
      return React.createElement("div", {
        key: "row-head",
        style: {
          display: "grid",
          gridTemplateColumns: columnTemplate({ lead: props.lead === true, tail: tail }),
          alignItems: "center", columnGap: "6px", fontSize: "10px",
          padding: "0 4px 3px 4px",
          borderBottom: "1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,.10))",
        },
      }, cells);
    }

    /**
     * One row of any list. `row` carries the six facts already formatted:
     *   sizeText | idleMs | title/untitled | fileCountText | workspaceText | whenText
     *
     * `lead` is the checkbox (tick lists), `tail` is the per-row buttons or
     * badges on the right edge, `tag` is "label" when the whole row should
     * toggle its checkbox, `tailWidth` is the width the caption must reserve so
     * the columns stay aligned with it.
     *
     * 0.38.0 — the cells are emitted in the reader's column order, into the
     * same grid template the caption uses. A column dragged to the front is at
     * the front of the caption AND of every row, because both read one layout.
     */
    function SessionRow(props) {
      var row = props.row || {};
      var tag = props.tag || "div";
      var name = row.title && String(row.title).length > 0 ? String(row.title) : (row.untitled || "（无标题）");
      var idleKnown = row.idleMs !== null && row.idleMs !== undefined;
      var cellOf = {
        size: function () {
          return React.createElement("span", {
            key: "c-size",
            style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          }, dashOr(row.sizeText));
        },
        // 0.37.2 — ONE colour for the whole 时长 column. The old per-row warning
        // tint made the same column look like two different columns depending on
        // which card it sat in (收藏清单 was untinted, 批量归档 was tinted), and it
        // separated a dash from a number for no reason. "Is this row late" is
        // already answered by its checkbox, not by hue.
        idle: function () {
          return React.createElement("span", {
            key: "c-idle",
            style: { minWidth: 0, textAlign: "right", opacity: .8, whiteSpace: "nowrap" },
          }, idleKnown ? humanIdle(row.idleMs) : DASH);
        },
        name: function () {
          return React.createElement("span", {
            key: "c-name",
            style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          }, name);
        },
        count: function () {
          return React.createElement("span", {
            key: "c-count",
            style: { minWidth: 0, textAlign: "right", whiteSpace: "nowrap" },
          }, dashOr(row.fileCountText));
        },
        workspace: function () {
          return React.createElement("span", {
            key: "c-workspace",
            style: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: .55 },
          }, dashOr(row.workspaceText));
        },
        when: function () {
          return React.createElement("span", {
            key: "c-when",
            style: { minWidth: 0, textAlign: "right", opacity: .55, whiteSpace: "nowrap" },
          }, dashOr(row.whenText));
        },
      };
      var cells = columnOrder().map(function (key) {
        var paint = cellOf[key];
        return paint ? paint() : null;
      });
      if (props.lead) cells.unshift(props.lead);
      if (props.tail) cells.push(props.tail);
      return React.createElement(tag, {
        key: row.id,
        title: props.hint || undefined,
        "aria-label": props.ariaLabel || undefined,
        style: {
          display: "grid",
          gridTemplateColumns: columnTemplate({ lead: props.lead ? true : false, tail: Number(props.tailWidth) || 0 }),
          alignItems: "center", columnGap: "6px", fontSize: "11px",
          padding: "2px 4px", borderRadius: "6px",
          cursor: props.cursor || "default",
          background: props.background || "transparent",
        },
      }, cells);
    }

    /**
     * Load, edit and persist ONE pre-tick policy.
     *
     * 🔴 THIS IS NOT AN AUTO-DELETE SWITCH AND MUST NEVER BECOME ONE. It only
     * decides whether rows arrive already ticked; every removal still costs a
     * dry run plus a second confirmation. A timer that deleted on its own was
     * shipped once, was pulled for destroying data, and is not coming back.
     *
     * Turning the switch ON is deliberately a two-step gesture: the checkbox
     * only raises `riskPending`, and the acknowledgement button is the single
     * path to `confirmOn()`. A switch that silently enables destructive
     * pre-selection is exactly the shape of the accident this plugin had.
     */
    function usePreTickPolicy(route, defaultHours) {
      var policyPair = React.useState(null);
      var policy = policyPair[0];
      var setPolicy = policyPair[1];
      var hoursTextPair = React.useState(function () { return String(defaultHours); });
      var hoursText = hoursTextPair[0];
      var setHoursText = hoursTextPair[1];
      var riskPair = React.useState(false);
      var riskPending = riskPair[0];
      var setRiskPending = riskPair[1];

      // Read the saved policy once, on mount. One tiny JSON read — deliberately
      // NOT folded into a scan route, whose contract is "only when asked".
      React.useEffect(function () {
        var alive = true;
        api(route).then(function (data) {
          if (!alive) return;
          var next = data && data.ok && data.policy ? data.policy : { autoSelect: false, hours: defaultHours };
          setPolicy(next);
          setHoursText(String(next.hours));
        }).catch(function () {
          if (alive) {
            setPolicy({ autoSelect: false, hours: defaultHours });
            setHoursText(String(defaultHours));
          }
        });
        return function () { alive = false; };
      }, []);

      function current() {
        return policy || { autoSelect: false, hours: defaultHours };
      }

      function save(next) {
        setPolicy(next);
        setHoursText(String(next.hours));
        api(route, { policy: next }).then(function (data) {
          if (data && data.ok && data.policy) {
            setPolicy(data.policy);
            setHoursText(String(data.policy.hours));
          }
        }).catch(function (error) {
          toast("保存设置失败：" + String(error && error.message ? error.message : error));
        });
        return next;
      }

      /**
       * A half-typed value must not become a threshold that ticks half the
       * table, so only a complete positive integer is committed. The raw text
       * still goes into the box so typing does not fight the user.
       */
      function onHoursInput(raw) {
        setHoursText(raw);
        var parsed = parseInt(raw, 10);
        if (!isFinite(parsed) || parsed <= 0) return null;
        return save({ autoSelect: current().autoSelect === true, hours: parsed });
      }

      return {
        policy: current(),
        hoursText: hoursText,
        onHoursInput: onHoursInput,
        riskPending: riskPending,
        setRiskPending: setRiskPending,
        requestOn: function () { setRiskPending(true); },
        confirmOn: function () { setRiskPending(false); return save({ autoSelect: true, hours: current().hours }); },
        requestOff: function () { return save({ autoSelect: false, hours: current().hours }); },
        save: save,
      };
    }

    /**
     * 删除/归档进度条 —— 全插件唯一一份实现（0.38.0 起在快照卡里，0.42.0 抽出）。
     *
     * 快照清理、删除归档、批量归档、幽灵缓存清理四处共用同一个组件，是因为
     * 用户的要求就是「参考现成的保持一致」：四条各画一遍迟早会在 padding、
     * 条高、颜色变量、百分比取整上漂开。同一个组件在物理上不可能不一致。
     *
     * 只在 progress 是对象时渲染（返回 null）；调用方不传就没有这条，
     * 保持「页面打开不会自己多出一条空进度条」的既有行为。
     *
     * 三行是刻意的：百分比给「还要多久」，已删/总数给「正在处理第几个」，
     * 释放空间给「值不值」——只有百分比时，删十几个会话的长尾会像卡死。
     *
     * 可选 props：
     *   doneVerb     底行左侧动词，默认「已删」
     *   noun         底行单位，默认「会话」（删除归档卡传「会话目录」时**不要**用它，
     *                那个是永久预警文案的 permanentNoun，单位仍是会话）
     *   fallbackLabel 未知 phase 的兜底文案
     */
    function ProgressBar(props) {
      var progress = props && props.progress;
      if (!progress || typeof progress !== "object") return null;
      var prog = progress;
      var progDone = Math.max(0, Number(prog.done) || 0);
      var progTotal = Math.max(0, Number(prog.total) || 0);
      var progPercent = progTotal > 0 ? Math.round(Math.min(1, progDone / progTotal) * 100) : 0;
      var progFreed = Number(prog.bytesFreed) || 0;
      var progBytesTotal = Number(prog.bytesTotal) || 0;
      var progPhase = String(prog.phase || "");
      var doneVerb = String((props && props.doneVerb) || "已删");
      var noun = String((props && props.noun) || "会话");
      var fallbackLabel = String((props && props.fallbackLabel) || "正在送入回收站…");
      // 试算的判定不能只看 phase：宿主执行体在 dryRun 时曾把 phase 恒写成真实
      // 动作名（delete / archive / ghost），于是「试算中」永远匹配不上，用户点一次
      // 只读试算，收到第一帧后文案就变成「正在永久删除会话目录…」——明明没删却
      // 像真删了。dryRun 是任务快照里的独立字段，优先信它；快照没带这个字段时才
      // 回退看 phase === "dryRun"。两侧都拿不到才算非试算。
      var progDryRun = prog.dryRun === true || progPhase === "dryRun";
      var stalledLabel = "已暂停监视：后台可能仍在处理（宿主侧继续，10 分钟内重新打开可续看）";
      var progLabel = progDryRun
        // 命中试算就无条件用它：不管 phase 被写成 delete / archive / ghost 哪一个。
        ? "试算中（不会删除任何东西）"
        : progPhase === "stalled"
          ? stalledLabel
          : progPhase === "scan"
            ? "正在核对会话快照…"
            : progPhase === "delete"
              // 删除归档此前没有显式分支，只能靠调用点的 fallbackLabel 兜底；
              // 补成显式分支后，任何调用点漏传 fallbackLabel 也不会退化成通用文案。
              ? "正在永久删除会话目录…"
              : progPhase === "archive"
                ? (progTotal > 0 ? "正在归档第 " + Math.min(progDone + 1, progTotal) + "/" + progTotal + " 个" : "正在归档…")
                : progPhase === "ghost"
                  ? "正在清理幽灵缓存…"
                  : progPhase === "done"
                    ? "正在收尾…"
                    : fallbackLabel;
      return React.createElement("div", {
        key: "p-progress",
        role: "progressbar",
        "aria-valuemin": 0,
        "aria-valuemax": 100,
        "aria-valuenow": progPercent,
        style: {
          padding: "8px", borderRadius: "8px", fontSize: "12px", lineHeight: "18px",
          background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))",
        },
      },
        React.createElement("div", {
          style: { display: "flex", justifyContent: "space-between", gap: "8px" },
        },
          React.createElement("span", null, progLabel),
          React.createElement("span", { style: { fontVariantNumeric: "tabular-nums", opacity: .85 } },
            progTotal > 0 ? progPercent + "%" : "准备中")),
        React.createElement("div", {
          style: {
            marginTop: "6px", height: "6px", borderRadius: "999px", overflow: "hidden",
            background: "var(--dsw-alias-border-subtle, rgba(255,255,255,.12))",
          },
        }, React.createElement("div", {
          style: {
            width: progTotal > 0 ? progPercent + "%" : "8%",
            height: "100%",
            borderRadius: "999px",
            background: "var(--dsw-alias-state-info-primary, #4c8dff)",
            transition: "width 140ms linear",
          },
        })),
        React.createElement("div", {
          style: { marginTop: "4px", display: "flex", justifyContent: "space-between", gap: "8px", opacity: .8 },
        },
          React.createElement("span", null,
            doneVerb + " " + progDone + " / " + (progTotal > 0 ? progTotal : "?") + " 个" + noun),
          React.createElement("span", null,
            "释放 " + humanBytes(progFreed) + (progBytesTotal > 0 ? " / " + humanBytes(progBytesTotal) : ""))));
    }

    /**
     * The table + threshold + switch + confirm block, shared by both cards.
     *
     * `labels` carries every user-visible string, because the same shell has to
     * speak two different truths: dropping a snapshot removes the ability to
     * undo an old turn, while deleting an archived conversation destroys the
     * conversation. A shared panel with shared words would flatten that
     * difference away, and that difference is the whole warning.
     */
    function PreTickPanel(props) {
      var labels = props.labels || {};
      var rows = Array.isArray(props.rows) ? props.rows : [];
      var chosen = props.chosen || {};
      var policy = props.policy || { autoSelect: false, hours: 720 };
      var autoOn = policy.autoSelect === true;
      var picked = Number(props.selectedCount) || 0;
      var stage = props.stage || "";
      var busy = props.busy || "";
      var result = props.result || null;
      var thresholdHours = Number(policy.hours) || 0;
      // 永久删除入口（0.42.0）。本面板被「快照清理」和「归档删除」两张卡共用，
      // 而「不进回收站」只对快照成立：删对话是另一个语义（那条路径根本没有
      // purged 回执，宿主也只给快照卡实现了 permanent）。所以必须显式门控，
      // 否则归档删除卡会长出一个它兑现不了的入口。
      var allowPermanent = props.allowPermanent === true;
      var wantPermanent = allowPermanent && props.permanent === true;
      // 永久预警的单位（0.42.0）。本面板被三张卡复用：快照卡抹掉的是「快照」，
      // 删除归档卡抹掉的是整个「会话目录」（转录 + 快照都在里面）。同一句
      // 「即将永久抹掉 N 个会话的快照」在归档页就是假话，必须由调用方给名词。
      // 注意：这与进度条的 noun 是两件事 —— 删归档卡的单位仍是「个会话」，
      // 所以两个 props 名字必须分开，不能互借。
      var permanentNoun = String(props.permanentNoun || "快照");
      // 风险提示要说出「这一下要删多少个会话、多少字节」。数字取自 props.rows
      // 全量行（含只有快照信息的行）∩ 勾选集合：不能用只渲染前 60 条的显示
      // 切片，也不能用 report.summary（那是测量汇总，不含勾选范围）。
      var wipeCount = 0;
      var wipeBytes = 0;
      for (var wi = 0; wi < rows.length; wi += 1) {
        if (chosen[rows[wi].id] === true) {
          wipeCount += 1;
          wipeBytes += Number(rows[wi].bytes) || 0;
        }
      }
      var kids = [];

      // 变红的确认按钮：同一颗按钮、同一处点击位置，只是把「可恢复」的措辞
      // 换成「不可恢复」，并用实心红底让它在视觉上不再像日常操作。
      var PERMANENT_STYLE = Object.assign({}, DANGER_STYLE, {
        color: "#ffffff",
        background: "var(--dsw-alias-state-error-primary, #b3261e)",
        borderColor: "var(--dsw-alias-state-error-primary, #b3261e)",
        fontWeight: "600",
      });

      // -- threshold + switch ------------------------------------------------
      kids.push(React.createElement("div", {
        key: "p-policy",
        style: {
          display: "flex", flexDirection: "column", gap: "6px",
          padding: "8px", borderRadius: "8px",
          background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))",
        },
      },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          React.createElement("span", { style: { fontSize: "12px" } }, labels.thresholdCaption),
          React.createElement("input", {
            type: "text", inputMode: "numeric", value: props.hoursText,
            "aria-label": labels.thresholdAria,
            style: INPUT_STYLE,
            onChange: function (event) { props.onHoursInput(event.target.value); },
          }),
          React.createElement("span", { style: { fontSize: "12px" } }, "小时"),
          React.createElement("span", { style: SUBTLE_STYLE },
            "≈ " + (Math.round(thresholdHours / 24 * 10) / 10) + " 天")),
        React.createElement("label", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" } },
          React.createElement("input", {
            type: "checkbox", checked: autoOn,
            // Two cards now share this panel, so the switch needs a stable
            // accessible name of its own — "the first checkbox" would bind
            // to whichever card happens to render first.
            "aria-label": labels.switchAria || labels.switchLabel,
            onChange: function () {
              if (!autoOn) { props.onRequestOn(); return; }
              props.onRequestOff();
            },
          }),
          React.createElement("span", null, labels.switchLabel)),
        props.riskPending
          ? React.createElement("div", {
              style: {
                display: "flex", flexDirection: "column", gap: "6px", padding: "8px",
                borderRadius: "8px", lineHeight: "19px", fontSize: "12px",
                background: "var(--dsw-alias-bg-warning, rgba(255,107,107,.1))",
              },
            },
              React.createElement("div", null, labels.riskBody),
              React.createElement("div", { style: { display: "flex", gap: "6px" } },
                React.createElement("button", {
                  type: "button", style: BTN_STYLE, onClick: function () { props.onRiskConfirm(); },
                }, "我知道风险，打开"),
                React.createElement("button", {
                  type: "button", style: BTN_STYLE, onClick: function () { props.onRiskCancel(); },
                }, "取消")))
          : null,
        React.createElement("div", { style: SUBTLE_STYLE },
          autoOn ? labels.statusOn : labels.statusOff)));

      // -- the rows ----------------------------------------------------------
      kids.push(React.createElement("div", {
        key: "p-list",
        style: Object.assign({ display: "flex", flexDirection: "column", gap: "2px", maxHeight: "330px" }, LIST_SCROLL),
      }, rows.length === 0
        ? React.createElement("div", { key: "p-none", style: { fontSize: "12px", opacity: .65 } },
            labels.emptyText)
        // 0.37.0 — every list on this page renders through SessionRow, so the
        // six columns are always 文件大小 | 时长 | 对话名称 | 文件数量 |
        // 工作区名称 | 时间, in that order, in every panel.
        : [React.createElement(ListHead, { key: "p-head", lead: true })].concat(
          rows.slice(0, 60).map(function (row) {
          var id = String(row.id);
          var on = chosen[id] === true;
          var name = row.title && String(row.title).length > 0 ? String(row.title) : (row.untitled || "（无标题）");
          return React.createElement(SessionRow, {
            key: id,
            row: row,
            // A <label> wrapper keeps "click anywhere on the row" ticking the
            // box, with the checkbox itself as the accessible handle. Each
            // panel ALSO contains the policy switch, so "the first checkbox"
            // is an ambiguous way to find a row — for a screen reader and for
            // the probe alike.
            tag: "label",
            cursor: "pointer",
            background: on ? "var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))" : "transparent",
            ariaLabel: (labels.rowAriaPrefix || "选择会话 ") + name,
            lead: React.createElement("input", {
              type: "checkbox", checked: on,
              "aria-label": (labels.rowAriaPrefix || "选择会话 ") + name,
              onChange: function () { props.onToggle(id); },
            }),
          });
        })),
        rows.length > 60
          ? React.createElement("div", { key: "p-more", style: { fontSize: "11px", opacity: .6 } },
              "还有 " + (rows.length - 60) + " 个未显示。")
          : null));

      // -- the blast radius, in words ---------------------------------------
      kids.push(React.createElement("div", {
        key: "p-warn",
        style: { fontSize: "11px", opacity: .62, lineHeight: "16px" },
      }, labels.warnText));

      if (stage === "") {
        kids.push(React.createElement("div", {
          key: "p-act",
          style: { display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "center" },
        },
          React.createElement("button", {
            type: "button", style: BTN_STYLE, disabled: busy !== "" || picked === 0,
            onClick: function () { props.onDryRun(); },
          }, busy === "dry" ? labels.dryRunBusy : labels.dryRun),
          React.createElement("span", { style: { fontSize: "11px", opacity: .6 } },
            picked === 0 ? labels.nonePicked : "已选 " + picked + " 个")));
      }

      if (stage === "live") {
        kids.push(React.createElement("div", {
          key: "p-confirm",
          style: {
            display: "flex", flexDirection: "column", gap: "8px", padding: "8px",
            borderRadius: "8px", background: "var(--dsw-alias-bg-warning, rgba(255,107,107,.1))",
          },
        },
          React.createElement("div", { style: { lineHeight: "20px" } }, labels.confirmText(picked)),
          // 勾选「永久删除」不发任何请求：只把下面的确认按钮改文案 + 变红，
          // 真正的请求仍然由那颗按钮发出（onConfirm → clean(false, true)）。
          allowPermanent
            ? React.createElement("label", {
                key: "p-perm",
                style: { display: "flex", alignItems: "flex-start", gap: "6px", fontSize: "12px", lineHeight: "18px", cursor: "pointer" },
              },
                React.createElement("input", {
                  type: "checkbox",
                  checked: wantPermanent,
                  "aria-label": "永久删除，不进回收站，无法恢复",
                  onChange: function (event) {
                    props.onPermanentChange(event && event.target ? event.target.checked === true : false);
                  },
                  style: { marginTop: "2px" },
                }),
                React.createElement("span", null,
                  "⚠ 永久删除（不进回收站，无法恢复）",
                  wantPermanent
                    ? React.createElement("span", { key: "p-perm-risk", style: { display: "block", marginTop: "4px" } },
                        "即将永久抹掉 " + wipeCount + " 个会话的" + permanentNoun + "，共 " + humanBytes(wipeBytes)
                        + "；不进回收站，删除后无法恢复。")
                    : null))
            : null,
          React.createElement("div", { style: { display: "flex", gap: "6px" } },
            React.createElement("button", {
              type: "button",
              style: wantPermanent ? PERMANENT_STYLE : DANGER_STYLE,
              disabled: busy !== "",
              onClick: function () { props.onConfirm(); },
            }, busy === "live" ? labels.confirmBusy : (wantPermanent ? (labels.confirmPermanent || "确认永久删除（不可恢复）") : labels.confirm)),
            React.createElement("button", {
              type: "button", style: BTN_STYLE, disabled: busy !== "",
              onClick: function () { props.onCancelConfirm(); },
            }, "取消"))));
      }

      // 进度条：只在调用方传了 progress 时渲染（ProgressBar 自己判）。快照清理、
      // 删除归档、批量归档三处调用共用同一份实现，幽灵缓存卡也直接渲染它 ——
      // 四条进度条从物理上不可能在尺寸、颜色、取整上漂开。
      kids.push(React.createElement(ProgressBar, {
        key: "p-progress",
        progress: props.progress,
        doneVerb: props.progressDoneVerb,
        noun: props.progressNoun,
        fallbackLabel: props.progressLabel,
      }));

      if (result) {
        // 409（已有任务在跑）不是失败：任务还在宿主侧跑，只是这次点击被拒。
        // 所以它走 notice 通道，措辞是提示而不是红色「执行失败」。
        var failed = Boolean(result.error) && result.notice !== true;
        var refused = Array.isArray(result.refusedFavorites) ? result.refusedFavorites : [];
        kids.push(React.createElement("div", {
          key: "p-result",
          style: {
            padding: "8px", borderRadius: "8px", lineHeight: "20px", fontSize: "12px",
            background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))",
            color: failed ? "var(--dsw-alias-state-error-primary, #ff6b6b)" : "inherit",
          },
        }, failed
          ? "执行失败：" + String(result.error)
          : (result.notice === true
              ? "提示：" + String(result.error)
              : (result.dryRun
                  ? "【试算结果，未做任何修改】"
                  // 回执必须说清「刚才是哪种删除」：用户可能在删完之后取消勾选，
                  // 只看按钮措辞就说不准了，所以永久戳随结果一起带回。
                  : (result.permanent === true ? "【已永久删除：不进回收站，无法恢复】" : "【已执行】")))
            + (result.notice === true ? "" : props.describeResult(result))
            + (result.permanent === true && typeof result.purged === "number" ? "｜永久抹除 " + result.purged : ""),
        // A refusal is REPORTED, never silent: hiding a checkbox is a UI
        // convention, and a stale page can still ask for a starred session.
        refused.length > 0
          ? React.createElement("div", { style: { marginTop: "4px", opacity: .8 } },
              "另有 " + refused.length + " 个已收藏会话被拒绝（收藏 = 保护）。")
          : null,
        (result.failures && result.failures.length)
          ? React.createElement("div", { style: { marginTop: "4px", opacity: .75 } },
              result.failures.slice(0, 5).map(function (item) {
                return String(item.sessionId) + "：" + String(item.reason);
              }).join("；"))
          : null));
      }

      return React.createElement("div", {
        style: { display: "flex", flexDirection: "column", gap: "8px" },
      }, kids);
    }

    /**
     * Snapshot ledger usage (0.29.0) on the shared shell (0.31.0).
     *
     * The card still does NOT report anything until its button is pressed: the
     * scan walks every session directory, so it is manual by construction.
     */
    function SnapshotUsageCard(props) {
      var headered = props || {};
      var reportPair = React.useState(null);
      var report = reportPair[0];
      var setReport = reportPair[1];
      var busyPair = React.useState("");
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var chosenPair = React.useState({});
      var chosen = chosenPair[0];
      var setChosen = chosenPair[1];
      var stagePair = React.useState("");
      var stage = stagePair[0];
      var setStage = stagePair[1];
      var resultPair = React.useState(null);
      var result = resultPair[0];
      var setResult = resultPair[1];
      // 永久删除勾选态。React.useState(false) 就保证了「每次打开卡片都是未勾选」：
      // 卡片卸载后重建即回到 false，绝不从 localStorage 或上一次的结果里复原。
      var permPair = React.useState(false);
      var perm = permPair[0];
      var setPerm = permPair[1];
      var tick = usePreTickPolicy("/snapshot-policy", 720);

      // 删除进度（契约：{done, total, bytesFreed, bytesTotal, phase, jobId}）。
      // null = 没有正在进行的删除；对象 = 进度条正在显示。
      var progressPair = React.useState(null);
      var progress = progressPair[0];
      var setProgress = progressPair[1];
      var pollRef = React.useRef(null);

      // 0.40.x — 后台定时清理（README ⑰ 承诺的「可选定时器」；此前 client.js 里
      // 一个 background 关键字都没有，等于承诺了开关却没做）。
      // 宿主默认 OFF（index.js 的 BACKGROUND_CLEANUP_DEFAULT），这里只是镜像：
      // 读取失败一律回落到 OFF —— 界面绝不能比后端更激进。
      var BG_DEFAULT = { enabled: false, scheduleMinutes: 60, hours: 1, maxItems: 50 };
      var bgPair = React.useState(null);
      var bg = bgPair[0];
      var setBg = bgPair[1];
      var bgLastPair = React.useState(null);
      var bgLast = bgLastPair[0];
      var setBgLast = bgLastPair[1];
      var bgRiskPair = React.useState(false);
      var bgRisk = bgRiskPair[0];
      var setBgRisk = bgRiskPair[1];
      // 输入框的「正在编辑」文本；空串 = 跟随服务端值。没有它，clamp 会把用户敲到
      // 一半的「1」直接改成「15」，第二位数字就再也输不进去了。
      var bgTextPair = React.useState({ scheduleMinutes: "", hours: "", maxItems: "" });
      var bgText = bgTextPair[0];
      var setBgText = bgTextPair[1];

      function stopPolling() {
        if (pollRef.current !== null) {
          try { clearInterval(pollRef.current); } catch (e) { /* 无碍 */ }
          pollRef.current = null;
        }
      }

      // 0.40.x — 进度持久化：jobId 原先只活在 React state 里，关掉设置页（组件
      // 卸载）就再也看不到正在跑的删除，而宿主侧的 job 其实还在删。这里把
      // jobId 落到 localStorage，重开页面时读回来续看。
      // TTL 与宿主 job 的 10 分钟保持一致：超时的残留直接清掉，绝不去轮询一个
      // 早被宿主淘汰的 job（否则用户会盯着一个永远不动的进度条）。
      var SNAPSHOT_JOB_KEY = "dsh-aff-snapshot-job";
      var SNAPSHOT_JOB_TTL_MS = 10 * 60 * 1000;
      // 「多久没有新进展」才判死（不是「盯了多久」）。宿主侧 job 的 TTL 按
      // updatedAt 滑动、有 10 分钟，客户端早先的绝对 90 秒比宿主严 6.7 倍。
      var SNAPSHOT_STALL_MS = 90 * 1000;
      // 总时长兜底：没有进展判据之外，再给一个硬上限，防止无限盯下去。
      var SNAPSHOT_POLL_TOTAL_MS = 8 * 60 * 1000;
      function clearPersistedJob() {
        try { localStorage.removeItem(SNAPSHOT_JOB_KEY); } catch (e) { /* 存储被禁 → 无碍 */ }
      }
      // 有进展时刷新持久化记录的 updatedAt（调用方负责节流）。宿主的续看
      // TTL 以 updatedAt 为基准，不刷新的话「跑了 11 分钟但一直有进展」的
      // 任务会在我们自己的续看侧被判过期。写失败只影响续看，不影响删除。
      function touchPersistedJob(jobId) {
        try {
          var raw = null;
          try { raw = localStorage.getItem(SNAPSHOT_JOB_KEY); } catch (e0) { raw = null; }
          var prev = null;
          try { prev = raw ? JSON.parse(raw) : null; } catch (e1) { prev = null; }
          var startedAt = prev && typeof prev.startedAt === "number" ? prev.startedAt : Date.now();
          localStorage.setItem(SNAPSHOT_JOB_KEY, JSON.stringify({
            jobId: jobId,
            startedAt: startedAt,
            updatedAt: Date.now(),
          }));
        } catch (e) { /* 存储被禁 → 只影响续看，不影响删除 */ }
      }
      // 续看 TTL 判据。宿主按 updatedAt 滑动淘汰 job，所以这里必须用同一
      // 基准：用 startedAt 会把「跑了 11 分钟但一直有进展」的任务判过期。
      // 老记录没有 updatedAt 时才回落到 startedAt。
      function resolvePersistedJob(saved, now) {
        var jobId = saved && typeof saved.jobId === "string" ? saved.jobId : "";
        var startedAt = saved && typeof saved.startedAt === "number" ? saved.startedAt : 0;
        var touchedAt = saved && typeof saved.updatedAt === "number" ? saved.updatedAt : startedAt;
        var at = Number(now);
        var expired = !jobId || !touchedAt || (at - touchedAt) > SNAPSHOT_JOB_TTL_MS;
        return { jobId: jobId, touchedAt: touchedAt, expired: expired };
      }
      // 组件卸载时别把 interval 留在后台（设置页来回切会积累）。
      React.useEffect(function () {
        return function () { stopPolling(); };
      }, []);

      // 挂载时续看上次没看完的删除（页面关闭 / 刷新后重新打开）。
      // 只认 10 分钟内的 job；更早的一律清掉——宿主的 job 早过期了。
      React.useEffect(function () {
        var raw = null;
        try { raw = localStorage.getItem(SNAPSHOT_JOB_KEY); } catch (e) { raw = null; }
        if (!raw) return undefined;
        var saved = null;
        try { saved = JSON.parse(raw); } catch (e) { saved = null; }
        // 🔴 TTL 按 updatedAt 判，不按 startedAt（宿主就是这么淘汰的）。
        var resolved = resolvePersistedJob(saved, Date.now());
        var savedId = resolved.jobId;
        if (resolved.expired) {
          clearPersistedJob();
          return undefined;
        }
        setBusy("live");
        setProgress({ done: 0, total: 0, bytesFreed: 0, bytesTotal: 0, phase: "resume", jobId: savedId });
        pollProgress(savedId, function (data) {
          clearPersistedJob();
          setProgress(null);
          setBusy("");
          setStage("");
          setChosen({});
          setResult(data || null);
          measure();
        }, function (error) {
          clearPersistedJob();
          setProgress(null);
          setBusy("");
          setStage("");
          setResult({ error: String(error && error.message ? error.message : error) });
        }, new Error("未找到该清理任务（可能已结束或宿主已重启），请重新统计确认"));
        return undefined;
      }, []);

      // 挂载时只读一次：一个策略文件 + 一条上次运行记录，都不扫盘。
      // GET /background-cleanup 在宿主侧返回 {ok, background, lastRun}。
      // 失败不报错：默认 OFF 的状态下「读不到」就等于「没开」，不值得打扰用户。
      React.useEffect(function () {
        var alive = true;
        api("/background-cleanup").then(function (data) {
          if (!alive) return;
          if (data && data.ok === true) {
            if (data.background) setBg(data.background);
            setBgLast(data.lastRun || null);
          }
        }).catch(function () {
          if (alive) setBg(null);
        });
        return function () { alive = false; };
      }, []);

      /**
       * 轮询兜底：`GET /snapshot-cleanup-progress?jobId=…`。
       *
       * 只在「NDJSON 流拿不到结果」时启动，所以正常路径一次都不会走。查不到
       * job（老宿主、或 10 分钟 TTL 已过）时最多等 6 秒再报错——不要把用户
       * 永久挂在进度条上。
       */
      // 判死判据 = 「多久没有新进展」，不是「盯了多久」。绝对 90 秒等于
      // 客户端比宿主严 6.7 倍（宿主 job TTL 按 updatedAt 滑动、10 分钟），
      // 而且旧版判死会连带清掉续看钥匙 → 刷新后看不成、列表还显示已删的
      // 行、重试撞 409。
      //
      // 判死 ≠ 判失败：命中超时只停止监视 + 进度态置 stalled，绝不 onFail、
      // 绝不 clearPersistedJob、绝不写 error —— 任务在宿主侧还在跑，10 分钟
      // 内重新打开页面必须还能续看。
      function pollProgress(jobId, onDone, onFail, cause) {
        stopPolling();
        var startedAt = Date.now();
        // 最后一次「真有进展」的时刻；初值 = 进入轮询时刻。
        var lastProgressAt = Date.now();
        // 进度指纹：宿主在同一 done 值上重发快照时必须不刷新，否则「一直不动」
        // 的假进展会把判死条件永远推开，永远判不了死。
        var lastFingerprint = null;
        var lastSnap = { done: 0, total: 0, bytesFreed: 0, bytesTotal: 0 };
        var lastTouchAt = 0;
        var stalled = false;

        function enterStall() {
          if (stalled) return;
          stalled = true;
          stopPolling();
          // jobId 故意留着（不清 localStorage）：任务还在宿主侧跑。
          setProgress({
            done: lastSnap.done,
            total: lastSnap.total,
            bytesFreed: lastSnap.bytesFreed,
            bytesTotal: lastSnap.bytesTotal,
            phase: "stalled",
            jobId: jobId,
          });
          // 🔴 故意不 setBusy("")：删除按钮要保持禁用。宿主侧任务还在跑，
          // 允许用户再点一次删除会让两个 job 并发删同一批 —— 一方被删掉
          // 另一方就撞 ENOENT，进度计数还会重复，比「按钮灰着」糟得多。
          toast("已停止监视删除进度，任务在宿主侧继续；10 分钟内重新打开可继续查看。");
        }

        pollRef.current = setInterval(function () {
          api("/snapshot-cleanup-progress?jobId=" + encodeURIComponent(jobId)).then(function (data) {
            var job = data && data.found === true ? data.job : null;
            if (!job) {
              if (Date.now() - startedAt > 6000) {
                stopPolling();
                onFail(cause || new Error("宿主未提供进度接口，请彻底退出客户端后重启"));
              }
              return;
            }
            var snap = {
              done: Number(job.done) || 0,
              total: Number(job.total) || 0,
              bytesFreed: Number(job.bytesFreed) || 0,
              bytesTotal: Number(job.bytesTotal) || 0,
              phase: String(job.phase || ""),
              jobId: jobId,
            };
            lastSnap = {
              done: snap.done,
              total: snap.total,
              bytesFreed: snap.bytesFreed,
              bytesTotal: snap.bytesTotal,
            };
            setProgress(snap);

            // 指纹变了才算「有进展」：done / bytesFreed / phase 任一变化即可
            // （phase 从 scan 走到 delete、每删完一个目录 done 加一都会变）。
            var fingerprint = snap.done + "|" + snap.bytesFreed + "|" + snap.phase;
            var now = Date.now();
            if (fingerprint !== lastFingerprint) {
              lastFingerprint = fingerprint;
              lastProgressAt = now;
              // 顺手刷新持久化记录的 updatedAt（节流 2 秒），让续看侧和宿主
              // 用同一基准判 TTL：跑很久但一直在动的任务不会自己过期。
              if (now - lastTouchAt >= 2000) {
                lastTouchAt = now;
                touchPersistedJob(jobId);
              }
            }

            if (job.state === "done") {
              stopPolling();
              onDone(job.result || null);
              return;
            }
            if (job.state === "error") {
              stopPolling();
              onFail(new Error(job.error || "删除失败"));
              return;
            }
            if (now - lastProgressAt > SNAPSHOT_STALL_MS) { enterStall(); return; }
            if (now - startedAt > SNAPSHOT_POLL_TOTAL_MS) { enterStall(); return; }
          }).catch(function () { /* 单次失败继续轮询 */ });
        }, 400);
      }

      // 0.37.1 — the header 刷新 button now reaches this card.
      //
      // The first render records the tick it was mounted with and does NOT
      // scan; only a later change runs the scan. That keeps the card's promise
      // ("nothing scans the disk on its own") while making 刷新 mean the same
      // thing on every tab. A no-op refresh is what made the button look broken.
      var refreshSeen = React.useRef(null);
      React.useEffect(function () {
        var next = typeof headered.refreshTick === "number" ? headered.refreshTick : 0;
        if (refreshSeen.current === null) { refreshSeen.current = next; return; }
        if (next === refreshSeen.current) return;
        refreshSeen.current = next;
        measure();
      }, [headered.refreshTick]);

      /**
       * 只写 background 一个键。
       *
       * 宿主 writeArchivePurgePolicy 对缺省键取「当前值」，
       * 所以这个 POST 绝不会顺手把顶层的「归档即删」改掉 —— 两个开关互不干扰。
       */
      function saveBackground(patch, note) {
        var merged = Object.assign({}, bg || BG_DEFAULT, patch);
        setBg(merged);
        return api("/archive-purge-policy", { policy: { background: merged } }).then(function (data) {
          if (data && data.ok === true && data.policy && data.policy.background) {
            setBg(data.policy.background);
          }
          if (note) toast(note);
        }).catch(function (error) {
          // 失败就回读真实状态 —— 不让按钮停在乐观值上假装保存成功。
          api("/background-cleanup").then(function (data) {
            if (data && data.ok === true && data.background) setBg(data.background);
          }).catch(function () { /* 回读也失败：toast 已经说了没保存，别再无谓报错 */ });
          toast("保存设置失败：" + String(error && error.message ? error.message : error));
        });
      }

      /**
       * 输入框纠偏：空白 → 回退默认；非数字/越界 → 夹到边界。
       * 这里不 toast（免得用户还在敲字就刷屏），由调用方决定怎么提示。
       */
      function clampField(text, lo, hi, fallback) {
        var raw = String(text === null || text === undefined ? "" : text).trim().replace(/[^0-9]/g, "");
        if (raw === "") return { value: fallback, corrected: false, why: "" };
        var n = parseInt(raw, 10);
        if (!isFinite(n) || n <= 0) return { value: fallback, corrected: true, why: "需要一个正整数" };
        if (n < lo) return { value: lo, corrected: true, why: "不能小于 " + lo };
        if (n > hi) return { value: hi, corrected: true, why: "不能大于 " + hi };
        return { value: n, corrected: false, why: "" };
      }

      /**
       * 一个数值输入行：编辑中不做 clamp（否则敲「1」会被立刻改成「15」），
       * 失焦时才纠正 + 提示 + 保存。
       */
      function bgNumberField(name, label, lo, hi, suffix) {
        var fallback = name === "scheduleMinutes" ? 60 : (name === "hours" ? 1 : 50);
        var shown = bgText[name] !== "" ? bgText[name] : String((bg || BG_DEFAULT)[name]);
        var on = bg !== null && bg.enabled === true;
        return React.createElement("label", {
          key: "s-bg-" + name,
          style: { display: "flex", alignItems: "center", gap: "4px", fontSize: "12px" },
        },
          React.createElement("span", { style: SUBTLE_STYLE }, label),
          React.createElement("input", {
            type: "text", inputMode: "numeric", value: shown,
            "aria-label": label + "（" + lo + "–" + hi + "）",
            style: INPUT_STYLE,
            onChange: function (event) {
              var next = Object.assign({}, bgText);
              next[name] = event.target.value;
              setBgText(next);
            },
            onBlur: function () {
              var fixed = clampField(shown, lo, hi, fallback);
              var cleared = Object.assign({}, bgText);
              cleared[name] = "";
              setBgText(cleared);
              if (fixed.corrected) toast(label + fixed.why + "，已纠正为 " + fixed.value);
              if (!on) return;
              if (!fixed.corrected && fixed.value === (bg || BG_DEFAULT)[name]) return;
              var patch = {};
              patch[name] = fixed.value;
              saveBackground(patch, label + "已保存");
            },
          }),
          React.createElement("span", { style: SUBTLE_STYLE }, suffix));
      }

      function measure(keepResult) {
        setBusy("scan");
        // keepResult=true：删除完成后的重算必须保住刚拿到的回执，否则
        // 「永久抹除了几个」在 200ms 后就消失。按钮与策略变化的调用点照旧清空。
        if (keepResult !== true) setResult(null);
        setStage("");
        api("/snapshot-usage").then(function (data) {
          setBusy("");
          setReport(data || null);
          // A fresh scan re-ticks from scratch, so a row the user deliberately
          // unticked does not come back on every re-measure.
          var policyNow = data && data.policy ? data.policy : tick.policy;
          setChosen(autoPick(rowsOf(data, policyNow), policyNow));
        }).catch(function (error) {
          setBusy("");
          setReport({ ok: false, detail: String(error && error.message ? error.message : error) });
        });
      }

      /** Cleanupable rows as shell rows: favourites are lifted out entirely. */
      function rowsOf(data, policyNow) {
        var entries = data && data.ok === true && Array.isArray(data.entries) ? data.entries : [];
        var rows = [];
        for (var i = 0; i < entries.length; i += 1) {
          var entry = entries[i];
          if (entry.favorite === true) continue;
          // 0.37.0 — the six shared columns. The workspace name comes from
          // the projection cache (scanned in the same pass that yields the
          // title), so it costs no extra disk read.
          rows.push({
            id: String(entry.sessionId),
            title: entry.title,
            untitled: "（无标题）",
            sizeText: humanBytes(entry.bytes),
            idleMs: typeof entry.idleMs === "number"
              ? entry.idleMs
              : ageMsOf(entry.lastActivityAt ?? entry.lastSnapshotAt),
            fileCountText: countText(entry.blobCount),
            workspaceText: workspaceName(entry.cwd),
            whenText: humanWhen(entry.lastSnapshotAt),
            protected: false,
            bytes: Number(entry.bytes) || 0,
          });
        }
        return rows;
      }

      /**
       * `clean(dryRun, permanent)` —— 位置参数，按位置读，不接受对象（调用点就
       * 两处，位置参数最难被「顺手传个 undefined」弄错）。
       *
       * 护栏在函数内部再算一次：`isPermanent` 要求「不是试算」与「勾了永久」
       * 同时成立，外部按钮只表达意图；宿主侧还要与 `confirm === true`、
       * `dryRun === false` 三条件同时成立才真删——两侧都不相信单一断言。
       */
      function clean(dryRun, permanent) {
        var ids = tickedIds(chosen);
        if (ids.length === 0) return;
        var isPermanent = dryRun !== true && permanent === true;
        var jobId = "sc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
        // 真实删除才落盘：dryRun 是一次性只读试算，没必要跨页面续看。
        if (dryRun !== true) {
          try {
            localStorage.setItem(SNAPSHOT_JOB_KEY, JSON.stringify({ jobId: jobId, startedAt: Date.now(), updatedAt: Date.now() }));
          } catch (e) { /* 存储被禁 → 只影响续看，不影响删除 */ }
        }
        var settled = false;
        setBusy(dryRun ? "dry" : "live");
        setResult(null);
        // 🔴 第一毫秒就有反馈：不等任何网络往返，进度条按「已勾选数量」立刻
        // 出现（0/N）。实测每个目录要 100~600ms，若等第一个事件才画，用户会
        // 先盯着一个没有任何变化的按钮，看起来就是「点了没反应」。
        setProgress({
          done: 0,
          total: ids.length,
          bytesFreed: 0,
          bytesTotal: 0,
          phase: dryRun === true ? "dryRun" : "delete",
          jobId: jobId,
        });

        function finish(data) {
          if (settled) return;
          settled = true;
          stopPolling();
          clearPersistedJob();
          setProgress(null);
          setBusy("");
          // 永久戳随回执一起带回：用户可能删完就取消勾选，只靠按钮现状说不清
          // 「刚才是哪种删除」。宿主返回的 purged 计数也在这一份结果里。
          setResult(Object.assign({}, data || {}, { permanent: isPermanent }));
          if (dryRun === true) {
            setStage("live");
          } else {
            // 完成后必须重算统计，否则列表还显示刚删掉的行。
            setStage("");
            setChosen({});
            // measure(true) = 保留刚才的回执：`measure()` 默认开口就
            // setResult(null)，直接调用会把「删除成功/失败清单」当场抹掉。
            measure(true);
          }
        }

        function failWith(error) {
          if (settled) return;
          settled = true;
          stopPolling();
          var message = String(error && error.message ? error.message : error);
          // 409 不是失败：`apiStream` 拿不到 status/code（两个字段都在 throw 时
          // 丢了），只能靠 message 文本识别「已有任务在运行」。这种时候任务还在
          // 宿主侧跑，所以保留续看钥匙（不清 persisted job），也别让用户以为
          // 自己点坏了什么东西。
          var alreadyRunning = /already-running|已有清理任务在运行/.test(message);
          if (!alreadyRunning) clearPersistedJob();
          setProgress(null);
          setBusy("");
          setStage("");
          setResult(alreadyRunning
            ? { error: "已有清理任务在运行（宿主拒绝再起一个，409）：请等它跑完，或在 10 分钟内重新打开页面续看进度。", notice: true, jobId: jobId }
            : { error: message });
        }

        var cleanupBody = {
          sessionIds: ids,
          dryRun: dryRun === true,
          // The host honours `dryRun: false` only together with `confirm: true`.
          confirm: dryRun !== true,
          stream: true,
          jobId: jobId,
        };
        // 只在「真删 + 勾了永久」时出现。预览即使勾着也绝不能带 permanent：
        // 宿主的判定是三条同时成立，少一条就退化成普通删除，而回执还会被误读。
        if (isPermanent) cleanupBody.permanent = true;
        apiStream("/snapshot-cleanup", cleanupBody, {
          onLine: function (line) {
            if (!line || typeof line !== "object") return;
            if (line.type === "error") {
              failWith(line.error || "删除失败");
              return;
            }
            setProgress({
              done: Number(line.done) || 0,
              total: Number(line.total) || ids.length,
              bytesFreed: Number(line.bytesFreed) || 0,
              bytesTotal: Number(line.bytesTotal) || 0,
              phase: String(line.phase || ""),
              jobId: jobId,
            });
            if (line.type === "done" && line.result) finish(line.result);
          },
        }).then(function () {
          // 流正常结束却没收到 done（中间层截断 / 首行就失败）→ 转轮询取权威
          // 结果；轮询也查不到时给出明确错误，绝不停在「转圈但不说话」。
          if (!settled) pollProgress(jobId, finish, failWith);
        }).catch(function (error) {
          // 409 必须在转轮询之前拦住：这一单根本没被受理，jobId 在宿主侧不存
          // 在，轮询只会等满 6 秒然后报「未找到该清理任务」——把「你先等一等」
          // 说成了「任务丢了」。
          if (settled) return;
          if (/already-running|已有清理任务在运行/.test(String(error && error.message))) {
            failWith(error);
            return;
          }
          // 流式通道整体不可用（老宿主 / 代理改写 / CSP）→ 直接降级轮询。
          pollProgress(jobId, finish, failWith, error);
        });
      }

      var summary = report && report.summary ? report.summary : null;
      var allEntries = report && Array.isArray(report.entries) ? report.entries : [];
      var favouriteEntries = allEntries.filter(function (entry) { return entry.favorite === true; });
      // The policy the user is looking at RIGHT NOW. `report.policy` is a
      // snapshot from scan time and goes stale the moment the switch is flipped,
      // which would make the switch appear to spring back to OFF.
      var rows = rowsOf(report, tick.policy);
      var picked = tickedIds(chosen).length;
      var kids = [];

      kids.push(React.createElement("div", {
        key: "s-head",
        style: ROW_STYLE,
      },
        React.createElement("div", { style: TITLE_STYLE }, "快照清理"),
        // 0.40.0 — ★ Star 放在主操作左侧：标题行右端仍然是「统计/重新统计」，
        // 星标是次要动作，压缩成一枚小按钮，点错也不会改任何文件。
        React.createElement("div", { key: "s-head-actions", style: { display: "flex", alignItems: "center", gap: "6px" } },
          React.createElement(StarButton, { key: "star", kind: "snapshot", compact: true }),
          React.createElement("button", {
            type: "button", style: BTN_STYLE, disabled: busy !== "",
            onClick: measure,
          }, busy === "scan" ? "统计中…" : (report === null ? "立即统计" : "重新统计")))));

      kids.push(React.createElement("div", {
        key: "s-intro",
        style: HINT_STYLE,
      }, "每次 write / edit 都会把改之前的文件存一份到会话目录的 history-file 里，",
        "这就是「撤销这一轮」能把文件放回去的依据。它没有上限，会话越久越大。",
        "这张卡平时不统计——按上面的按钮才扫一次，扫完把结果显示出来，不会在后台反复扫。",
        "收藏的对话不计入这里的可删列表。"));

      // 进度持久化的说明：用户关页面时最怕「是不是被我打断了」，这里说清楚。
      kids.push(React.createElement("div", {
        key: "s-persist-note",
        style: SUBTLE_STYLE,
      }, "删除在宿主侧继续执行，关掉这个页面不会中断；10 分钟内重新打开可继续查看进度。",
        "只有彻底退出 DSH 才会中断。"));

      // ---- 后台定时清理：宿主默认 OFF（index.js 的 BACKGROUND_CLEANUP_DEFAULT），这里镜像它。----
      // 开关本身默认显示「关闭」，要开先亮风险（两段式，理由同 usePreTickPolicy）。
      var bgOn = bg !== null && bg.enabled === true;
      var bgNow = bg || BG_DEFAULT;
      kids.push(React.createElement("div", {
        key: "s-bg",
        style: {
          display: "flex", flexDirection: "column", gap: "6px",
          padding: "8px", borderRadius: "8px",
          background: "var(--dsw-alias-bg-base, rgba(255,255,255,.04))",
        },
      },
        React.createElement("label", {
          key: "s-bg-toggle",
          style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" },
        },
          React.createElement("input", {
            type: "checkbox", checked: bgOn, "aria-label": "启用后台定时清理快照",
            onChange: function () {
              if (!bgOn) { setBgRisk(true); return; }   // 开：先亮风险，不直接生效
              setBgRisk(false);
              saveBackground({ enabled: false }, "后台定时清理已关闭");
            },
          }),
          React.createElement("span", null, "后台定时清理" + (bgOn ? "（已开启）" : "（关闭）"))),
        React.createElement("div", { key: "s-bg-note", style: SUBTLE_STYLE },
          "默认关闭——打开后才会按计划自动清理，删的是 history-file，绝不删收藏。"),
        bgRisk ? React.createElement("div", {
          key: "s-bg-risk",
          style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" },
        },
          React.createElement("span", {
            style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #ff6b6b)" },
          }, "开启后到点就把超期快照移进回收站，不再逐条问你。收藏的不动，年龄未知的不动，"
            + "单轮最多 " + bgNow.maxItems + " 个。"),
          React.createElement("button", {
            type: "button", style: DANGER_STYLE,
            onClick: function () {
              setBgRisk(false);
              saveBackground({ enabled: true }, "后台定时清理已开启");
            },
          }, "我明白，开启"),
          React.createElement("button", {
            type: "button", style: BTN_STYLE,
            onClick: function () { setBgRisk(false); },
          }, "取消")) : null,
        React.createElement("div", {
          key: "s-bg-fields",
          style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
        },
          bgNumberField("scheduleMinutes", "检查间隔", 15, 1440, "分钟一次"),
          bgNumberField("hours", "闲置超过", 1, 24, "小时"),
          bgNumberField("maxItems", "单轮上限", 1, 500, "个")),
        bgLast ? React.createElement("div", { key: "s-bg-last", style: SUBTLE_STYLE },
          "上次运行：" + (bgLast.at ? new Date(bgLast.at).toLocaleString() : "—")
          + " · " + (bgLast.mode === "dry-run" ? "干跑" : "定时执行")
          + " · 扫描 " + (bgLast.scanned || 0) + " 个会话，候选 " + (bgLast.candidates || 0)
          + " · 删除 " + (bgLast.deleted || 0) + " 个 / " + humanBytes(bgLast.bytes || 0)
          + " / " + (bgLast.files || 0) + " 个文件"
          + " · " + (bgLast.toRecycleBin === true ? "在回收站，清空后才真正释放" : "未走回收站")
          + " · " + (bgLast.ok === false
              ? "失败：" + String(bgLast.error || "unknown")
              : "成功")
          + (typeof bgLast.elapsedMs === "number" ? " · 耗时 " + bgLast.elapsedMs + " ms" : "")) : null));

      if (report === null) {
        kids.push(React.createElement("div", { key: "s-idle", style: { opacity: .65 } },
          "点「立即统计」看看占了多少（只读，不改任何文件）。"));
      } else if (report.ok !== true) {
        kids.push(React.createElement("div", {
          key: "s-err",
          style: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #ff6b6b)" },
        }, "统计失败：" + String(report.detail || "未知原因")));
      } else if (rows.length === 0 && favouriteEntries.length === 0) {
        kids.push(React.createElement("div", {
          key: "s-empty",
          style: { fontSize: "12px", color: "var(--dsw-alias-state-success-primary, #4ec9a0)" },
        }, "✅ 没有任何会话存过快照（0 B）。"));
      } else {
        kids.push(React.createElement("div", {
          key: "s-counts",
          style: { fontSize: "12px", opacity: .85, lineHeight: "18px" },
        }, rows.length + " 个可清理会话 · 共 " + humanBytes(rows.reduce(function (t, e) { return t + e.bytes; }, 0))
          // 「全部」才是用户真正问的那个数（含已收藏）：上面那半句是可清理子集。
          // totalBytes 后端一直在返回，前端此前从没显示过。
          + " · 全部 " + (summary ? humanBytes(summary.totalBytes || 0) : DASH) + "（含已收藏）"
          // 缺失必须显示「—」而不是「0 个」：summary 没拿到（宿主老 / 扫描失败）
          // 与「真的一颗快照都没有」是两件事，渲染成 0 就是撒谎。
          + " · " + (summary ? summary.totalBlobs : DASH) + " 个快照文件 · " + (summary ? summary.totalEntries : DASH) + " 条记录"
          + (typeof report.elapsedMs === "number" ? "（统计耗时 " + report.elapsedMs + " ms）" : ""),
        favouriteEntries.length > 0
          ? React.createElement("div", { key: "s-fav", style: { marginTop: "2px", opacity: .75 } },
              "另有 " + favouriteEntries.length + " 个已收藏会话占用 "
              + humanBytes(favouriteEntries.reduce(function (t, e) { return t + (Number(e.bytes) || 0); }, 0))
              + "（已收藏 = 保护，不列入清理）")
          : null,
        // The largest CLEANUPABLE row, taken from the filtered list: once
        // starred conversations are lifted out, a report-wide maximum can be a
        // row the user cannot select, which reads as a contradiction.
        rows.length > 0
          ? React.createElement("div", { key: "s-big", style: { marginTop: "2px", opacity: .75 } },
              "最大一项：" + (rows[0].title || rows[0].id) + " · " + humanBytes(rows[0].bytes))
          : null));

        kids.push(React.createElement(PreTickPanel, {
          key: "s-panel",
          rows: rows,
          chosen: chosen,
          policy: tick.policy,
          hoursText: tick.hoursText,
          riskPending: tick.riskPending,
          selectedCount: picked,
          stage: stage,
          busy: busy,
          result: result,
          // 永久删除入口只属于这张卡：归档删除卡不传 allowPermanent，共用面板
          // 因此不会给它长出一个它兑现不了的「不进回收站」。
          allowPermanent: true,
          permanent: perm,
          onPermanentChange: function (next) { setPerm(next === true); },
          // 只有快照卡传 progress（归档卡不传 → 组件里进度区域不渲染），
          // 这样两张卡共用面板也不会互相影响。
          progress: progress,
          onHoursInput: function (raw) {
            var next = tick.onHoursInput(raw);
            if (next) setChosen(autoPick(rows, next));
          },
          onRequestOn: tick.requestOn,
          onRiskConfirm: function () { var next = tick.confirmOn(); setChosen(autoPick(rows, next)); },
          onRiskCancel: function () { tick.setRiskPending(false); },
          onRequestOff: function () { var next = tick.requestOff(); setChosen(autoPick(rows, next)); setStage(""); setResult(null); },
          onToggle: function (id) { setChosen(retoggle(chosen, id)); setStage(""); setResult(null); },
          onDryRun: function () { clean(true, false); },
          // 预览永远是 false：勾着「永久删除」点试算，也只是一次只读扫描。
          onConfirm: function () { clean(false, perm); },
          onCancelConfirm: function () { setStage(""); },
          describeResult: function (res) {
            return " 处理 " + ((res.deleted || []).length) + " 个"
              + "｜跳过 " + ((res.skipped || []).length)
              + "｜失败 " + ((res.failures || []).length)
              + "｜释放 " + humanBytes(res.bytesFreed || 0)
              // 宿主只在永久模式下累加 purged（真抹掉、没进回收站的目录数）。
              + (res.permanent === true && typeof res.purged === "number" ? "｜永久抹除 " + res.purged : "");
          },
          labels: {
            thresholdCaption: "超时阈值",
            thresholdAria: "快照超时小时数",
            switchLabel: "统计时自动勾选「超时」的会话",
            riskBody: "打开后，每次点「立即统计」会把闲置超过 " + (tick.policy.hours || 0)
              + " 小时的会话自动勾上，你仍需点「试算删除」再点一次「确认删除」，才会真的删。"
              + "风险：快照删掉后，那些会话就不能再「撤销到以前的某一轮」了（对话本身和磁盘文件都还在）。"
              + "收藏的会话永远不参与勾选。",
            statusOn: "已开启：统计后会自动勾选超时会话，删除仍需你两次确认。",
            statusOff: "默认关闭：统计后不勾选任何行，需自己挑。",
            emptyText: "没有可清理的会话——剩下的都是收藏的。",
            rowAriaPrefix: "选择会话 ",
            warnText: "删掉某个会话的快照，只影响那一个会话的「撤销到某一轮」；对话本身和磁盘上的文件都不受影响。",
            dryRun: "试算删除",
            dryRunBusy: "试算中…",
            nonePicked: "先勾选要删的会话",
            confirmText: function (count) {
              return "确认删除这 " + count + " 个会话的快照？目录进 Windows 回收站（可恢复）；"
                + "删掉后这些会话就不能再撤销到以前的某一轮，但对话和磁盘文件都还在。";
            },
            confirm: "确认删除",
            // 不复用归档删除卡的「我知道风险，打开」，也不复用后台清理开关的
            // 「我明白，开启」：那两句都说「打开一个动作」，这一句说的是
            // 「这一下不可恢复」，措辞必须自己承担后果。
            confirmPermanent: "确认永久删除（不可恢复）",
            confirmBusy: "删除中…",
          },
        }));
      }

      return React.createElement("div", { style: CARD_STYLE }, kids);
    }

    /**
     * Delete archived-but-unfavourited conversations (0.31.0), on the same
     * shell as the snapshot card.
     *
     * What it reuses: the table, the age column, the threshold, the pre-tick
     * switch (its OWN policy file), and the dry-run → confirm sequence.
     *
     * What it does NOT reuse, because it must not: the words. A snapshot is a
     * rollback aid — losing it costs "undo an old turn". A conversation IS the
     * data; losing it costs everything. The confirmation says so plainly, and
     * the rows come from the live archive registry rather than from a cached
     * list.
     */
    // Reads a `source` string produced by loadArchived() and says, in plain
    // words, whether the archive set is trustworthy. `loadArchived()` appends
    // ":<count>" for bookkeeping, so the health verdict is taken from the part
    // BEFORE the colon. Only two values mean "we do not know": `unavailable`
    // and `request-failed`. Everything else is a successful read, and inventing
    // an "不可用" prefix for an unfamiliar-but-healthy name (e.g. "workspace")
    // would tell the user their archive is broken when it is not.
    function describeSource(raw) {
      var text = String(raw || "");
      if (text === "") return "官方实时注册表";
      var cut = text.indexOf(" | ");
      var head = cut === -1 ? text : text.slice(0, cut);
      var tail = cut === -1 ? "" : text.slice(cut + 3);
      var colon = head.indexOf(":");
      var base = colon === -1 ? head : head.slice(0, colon);
      var count = colon === -1 ? "" : head.slice(colon + 1);
      if (base === "starting") return "等待注册表启动…";
      if (base === "unavailable" || base === "request-failed") {
        return "不可用：" + base + (tail ? " | " + tail : "");
      }
      var label = base === "registry" ? "官方实时注册表"
        : base === "workspace" ? "官方工作区记录"
        : base === "log" ? "会话日志回推"
        : base === "snapshot" ? "上次快照"
        : base;
      return label + (count ? "（" + count + " 条）" : "");
    }

    function ArchiveDeleteCard(props) {
      var entries = Array.isArray(props.entries) ? props.entries : [];
      var favourites = Array.isArray(props.favourites) ? props.favourites : [];
      var busyPair = React.useState("");
      var busy = busyPair[0];
      var setBusy = busyPair[1];
      var chosenPair = React.useState({});
      var chosen = chosenPair[0];
      var setChosen = chosenPair[1];
      var stagePair = React.useState("");
      var stage = stagePair[0];
      var setStage = stagePair[1];
      var resultPair = React.useState(null);
      var result = resultPair[0];
      var setResult = resultPair[1];
      var progressPair = React.useState(null);
      var progress = progressPair[0];
      var setProgress = progressPair[1];
      var tick = usePreTickPolicy("/archive-delete-policy", 720);

      function favoriteKeys() {
        var keys = {};
        for (var i = 0; i < favourites.length; i += 1) {
          var id = String(favourites[i]);
          keys[id] = true;
          keys[id.replace(/^session-/, "")] = true;
        }
        return keys;
      }

      function buildRows() {
        var favs = favoriteKeys();
        var rows = [];
        for (var i = 0; i < entries.length; i += 1) {
          var entry = entries[i];
          var id = String(entry.sessionId);
          var bare = id.replace(/^session-/, "");
          // Favourites are lifted out of the list entirely, and counted
          // separately. The host refuses them too — hiding a checkbox is a
          // convention, not a guard.
          if (favs[id] === true || favs[bare] === true) continue;
          // 0.37.1 — same six columns as everywhere else, but the size cells
          // describe the WHOLE session directory (transcript + ledger), i.e.
          // what deleting this row actually frees. 0.37.0 used the snapshot
          // ledger here, which read "—" for almost every row because most
          // conversations never edit a file and so never write a snapshot.
          rows.push({
            id: id,
            title: entry.title,
            untitled: entry.blank === true ? "（新会话）" : "（无标题）",
            sizeText: Number.isFinite(Number(entry.bytes)) && Number(entry.bytes) > 0
              ? humanBytes(entry.bytes)
              : "",
            idleMs: typeof entry.idleMs === "number" ? entry.idleMs : null,
            fileCountText: countText(entry.fileCount ?? entry.blobCount),
            workspaceText: workspaceName(entry.cwd),
            whenText: humanWhen(entry.updatedAt),
            // 0.42.0 — 「共占」要用它求和。preview 后端一直带 bytes（整会话目录），
            // 前端此前只拿它渲染 sizeText 就丢了，于是这张卡算不出总体积。
            bytes: Number(entry.bytes) || 0,
            protected: false,
          });
        }
        return rows;
      }

      var rows = buildRows();
      var picked = tickedIds(chosen).length;

      // Re-tick from the CURRENT rows whenever the policy changes, so the switch
      // and the table can never disagree.
      function retick(policyNext) {
        setChosen(autoPick(rows, policyNext));
        setStage("");
        setResult(null);
      }

      function run(dryRun) {
        var ids = tickedIds(chosen);
        if (ids.length === 0) return;
        setBusy(dryRun ? "dry" : "live");
        // 0.42.0 — 不再一次性 POST 后干等：接单即回执，写盘进度走 NDJSON 流，
        // 流断了再轮询同一个 jobId（读取路由与快照清理共用）。
        var jobId = jobIdFor("ad");
        var rowsById = {};
        for (var ri = 0; ri < rows.length; ri += 1) rowsById[rows[ri].id] = rows[ri];
        var bytesTotal = 0;
        for (var ii = 0; ii < ids.length; ii += 1) {
          var rowHit = rowsById[ids[ii]] || rowsById["session-" + ids[ii]];
          bytesTotal += Number(rowHit && rowHit.bytes) || 0;
        }
        // 抢首帧：宿主还没回第一行时先让用户看见「12 个」，否则那半秒和卡死没区别。
        setProgress({
          done: 0, total: ids.length, bytesFreed: 0, bytesTotal: bytesTotal,
          phase: dryRun === true ? "dryRun" : "delete", jobId: jobId,
        });
        runJob("/archive-delete", {
          sessionIds: ids,
          dryRun: dryRun === true,
          confirm: dryRun !== true,
        }, {
          jobId: jobId,
          onProgress: function (snap) { setProgress(snap); },
          onDone: function (data) {
            setBusy("");
            setProgress(null);
            setResult(data || null);
            if (dryRun === true) {
              setStage("live");
            } else {
              setStage("");
              setChosen({});
              if (typeof props.onRefresh === "function") props.onRefresh();
            }
          },
          onFail: function (error) {
            setBusy("");
            setProgress(null);
            setStage("");
            setResult({ error: String(error && error.message ? error.message : error) });
          },
        });
      }

      var favouriteCount = entries.length - rows.length;
      var kids = [];

      kids.push(React.createElement("div", { style: TITLE_STYLE }, "删除归档对话（永久）"));

      if (props.unavailable === true) {
        kids.push(React.createElement("div", {
          style: { lineHeight: "20px", color: "var(--dsw-alias-state-warn-primary, #ffb454)" },
        }, "⚠ 读取不到官方的归档列表（workspaceRegistry 不可用），因此无法确定哪些对话已归档。为避免误删，这里不显示统计也不提供删除。"));
      } else if (props.loading === true) {
        kids.push(React.createElement("div", { style: { opacity: .65 } }, "正在读取归档列表…"));
      } else {
        kids.push(React.createElement("div", { style: HINT_STYLE },
          "删除归档区里没收藏的对话。这一栏是永久删除——对话和转录一起消失，进不了回收站。",
          "想留的先去收藏清单点星标，收藏项永远不在这张表里。"));
        kids.push(React.createElement("div", { style: { opacity: .8, lineHeight: "20px" } },
          "归档共 " + entries.length + " 条：其中已收藏 " + favouriteCount + " 条（保留），未收藏 "
          + rows.length + " 条（可删除），共占 " + humanBytes(sumRowBytes(rows)) + "（整会话目录）。"));
        kids.push(React.createElement("div", { style: SUBTLE_STYLE },
          "归档来源：" + describeSource(props.source)));

        if (rows.length === 0) {
          kids.push(React.createElement("div", { style: { opacity: .65 } },
            "没有可删除的条目——归档区里剩下的都是收藏。"));
        } else {
          kids.push(React.createElement(PreTickPanel, {
            key: "del-panel",
            rows: rows,
            chosen: chosen,
            policy: tick.policy,
            hoursText: tick.hoursText,
            riskPending: tick.riskPending,
            selectedCount: picked,
            stage: stage,
            busy: busy,
            result: result,
            // 0.42.0 — 这张卡也接上进度条（与快照清理同款）。数字来自同一个 jobId。
            progress: progress,
            progressLabel: "正在永久删除会话目录…",
            // 永久预警的单位：这张卡抹掉的是整个会话目录（转录 + 快照），不是只有快照。
            permanentNoun: "会话目录",
            onHoursInput: function (raw) { var next = tick.onHoursInput(raw); if (next) retick(next); },
            onRequestOn: tick.requestOn,
            onRiskConfirm: function () { retick(tick.confirmOn()); },
            onRiskCancel: function () { tick.setRiskPending(false); },
            onRequestOff: function () { retick(tick.requestOff()); },
            onToggle: function (id) { setChosen(retoggle(chosen, id)); setStage(""); setResult(null); },
            onDryRun: function () { run(true); },
            onConfirm: function () { run(false); },
            onCancelConfirm: function () { setStage(""); },
            describeResult: function (res) {
              var n = res.dryRun === true
                ? ((res.wouldDelete || []).length)
                : ((res.deleted || []).length);
              return " " + (res.dryRun === true ? "将删除 " : "删除 ") + n + " 条"
                + "｜跳过 " + ((res.skipped || []).length)
                + "｜失败 " + ((res.failures || []).length);
            },
            labels: {
              thresholdCaption: "超时阈值",
              thresholdAria: "删除对话超时小时数",
              switchLabel: "统计时自动勾选「超时」的已归档对话",
              riskBody: "打开后，每次刷新归档列表会把闲置超过 " + (tick.policy.hours || 0)
                + " 小时的已归档对话自动勾上，你仍需点「试算删除」再点一次「确认删除」，才会真的删。"
                + "风险：对话连同转录文件一起永久删除，不可撤销；已收藏的对话永远不参与勾选。",
              statusOn: "已开启：刷新后会自动勾选超时归档对话，删除仍需你两次确认。",
              statusOff: "默认关闭：刷新后不勾选任何行，需自己挑。",
              emptyText: "没有可删除的条目——归档区里剩下的都是收藏。",
              rowAriaPrefix: "删除对话 ",
              warnText: "删除是不可撤销的：对话本身和转录文件都会消失。想留的请先点星标收藏，收藏项永远不在这张表里。",
              dryRun: "试算删除",
              dryRunBusy: "试算中…",
              nonePicked: "先勾选要删的对话",
              confirmText: function (count) {
                return "将永久删除这 " + count + " 条已归档、未收藏的对话（连同其转录文件）。此操作不可撤销；已收藏的 "
                  + favouriteCount + " 条会被保留。";
              },
              confirm: "确认删除",
              confirmBusy: "删除中…",
            },
          }));
        }
      }

      return React.createElement("div", { style: CARD_STYLE }, kids);
    }


    function ArchiveFavoritesSection() {
      useFavoriteTick();
      var archivedPair = React.useState(null);
      var archived = archivedPair[0];
      var setArchived = archivedPair[1];
      // Per-row title / age / workspace, from the same /archived response as
      // the id list. Kept apart from `archived` because the id list is also
      // used for membership checks that must not care about row metadata.
      var archiveEntriesPair = React.useState([]);
      var archiveEntries = archiveEntriesPair[0];
      var setArchiveEntries = archiveEntriesPair[1];
      var busyPair = React.useState("");
      var busy = busyPair[0];
      var setBusy = busyPair[1];


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
      // 0.42.0 — 批量归档的进度（与快照清理同款组件；jobId 前缀 id-）。
      var progressPair = React.useState(null);
      var progress = progressPair[0];
      var setProgress = progressPair[1];
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

      // --- archive-purge switch state ---
      // `null` means "not read yet". The host defaults this to ON (0.35.0), so an
      // unread policy renders as ON too — rendering it as OFF made the box flip
      // from unticked to ticked one frame after mount, which reads as a bug.
      // The authoritative value lives in the host's archive-purge-policy.json; this
      // is only a cache of it, refreshed on mount and on every flip.
      var purgePolicyPair = React.useState(null);
      var purgePolicy = purgePolicyPair[0];
      var setPurgePolicy = purgePolicyPair[1];
      var purgeRiskPair = React.useState(false);
      var purgeRisk = purgeRiskPair[0];
      var setPurgeRisk = purgeRiskPair[1];

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
            setArchiveEntries(Array.isArray(data.entries) ? data.entries : []);
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

      /**
       * The archive-purge switch: read once on mount, written on every flip.
       *
       * Turning it ON is a two-step gesture — the checkbox only raises
       * `purgeRisk`, and the acknowledgement button is the only path that
       * writes `enabled: true`. That mirrors the pre-tick switches, for the
       * same reason: this is the one setting in the plugin that lets a
       * destructive action happen without a per-item confirmation.
       */
      function loadPurgePolicy() {
        // Fallback is ON, mirroring the host default: a host too old to answer this
        // route must not be able to silently disarm a switch the user expects on.
        return api("/archive-purge-policy").then(function (data) {
          setPurgePolicy(data && data.ok && data.policy ? data.policy : { enabled: true });
        }).catch(function () { setPurgePolicy({ enabled: true }); });
      }

      function savePurgePolicy(next) {
        setPurgePolicy(next);
        return api("/archive-purge-policy", { policy: next }).then(function (data) {
          if (data && data.ok && data.policy) setPurgePolicy(data.policy);
        }).catch(function (error) {
          toast("保存设置失败：" + String(error && error.message ? error.message : error));
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

      // 0.37.1 — the 工作区名称 column needs the registry titles, which only the
      // host half can read. Load them at page open, then re-render once; the
      // bump is a render-only counter so no card thinks 刷新 was pressed.
      var titlesPair = React.useState(0);
      var setTitlesRev = titlesPair[1];
      // 0.37.2 — a favourite stores only {at, title, cwd}, so its 文件大小 and
      // 文件数量 cells had no source and printed a dash on every row of the
      // 收藏清单. Measured by the host on demand (panel open / 刷新), keyed by
      // session id; a key with no fact keeps its dash.
      var favFactsPair = React.useState({});
      var favFacts = favFactsPair[0];
      var setFavFacts = favFactsPair[1];

      // 0.40.0 — 收藏清单的排序与筛选状态。The list used to be a plain
      // `favorites` dump in whatever order the registry object happened to
      // have, which is why "我最近收藏的那几个" was impossible to find once the
      // list grew past a screen. All of this is client-side: the rows already
      // come from /favorites + /favorite-facts, so no host route is added for
      // the view itself.
      var favSortPair = React.useState({ key: "saved", dir: "desc" });
      var favSort = favSortPair[0];
      var setFavSort = favSortPair[1];
      var favQueryPair = React.useState("");
      var favQuery = favQueryPair[0];
      var setFavQuery = favQueryPair[1];
      var favSizePair = React.useState("all");
      var favSize = favSizePair[0];
      var setFavSize = favSizePair[1];
      var favAgePair = React.useState("all");
      var favAge = favAgePair[0];
      var setFavAge = favAgePair[1];
      var favSnapPair = React.useState(false);
      var favSnapOnly = favSnapPair[0];
      var setFavSnapOnly = favSnapPair[1];
      // 0.42.5 — 收藏清单的批量勾选 + 批量删快照进度。
      var favSelPair = React.useState({});
      var favSel = favSelPair[0];
      var setFavSel = favSelPair[1];
      var favBatchPair = React.useState(null);
      var favBatch = favBatchPair[0];
      var setFavBatch = favBatchPair[1];
      function favSelCount() {
        var n = 0;
        for (var k in favSel) { if (favSel[k] === true) n += 1; }
        return n;
      }
      function favSelList() {
        var out = [];
        for (var k in favSel) { if (favSel[k] === true) out.push(k); }
        return out;
      }
      function favToggleSel(id) {
        setFavSel(function (prev) {
          var next = Object.assign({}, prev);
          if (next[id] === true) { delete next[id]; } else { next[id] = true; }
          return next;
        });
      }
      /**
       * 批量删快照：逐条 POST /snapshot-forget，一条一帧进度。
       * 只删各自的 <session>/history-file/，对话本体与磁盘文件全部保留，
       * 目录进 Windows 回收站，可恢复。
       */
      function favBatchForget(ids) {
        if (favBatch && favBatch.running === true) return;
        var list = (ids || []).slice();
        if (list.length === 0) return;
        var yes = window.confirm("删除所选 " + list.length + " 个收藏对话的快照？\n\n只删各自「撤销到某一轮」用的历史快照，对话本身和磁盘上的文件都保留。\n目录会进 Windows 回收站，可以恢复。");
        if (!yes) return;
        var state = { running: true, done: 0, total: list.length, bytesFreed: 0, ok: 0, failed: 0, reason: "" };
        setFavBatch(Object.assign({}, state));
        var i = 0;
        function step() {
          if (i >= list.length) {
            state.running = false;
            setFavBatch(Object.assign({}, state));
            var routeMissing = /no route|404|Cannot POST/i.test(String(state.reason || ""));
            toast(
              "已处理 " + list.length + " 个会话：成功 " + state.ok + " · 失败 " + state.failed
                + " · 释放 " + humanBytes(state.bytesFreed)
                + (state.failed > 0
                  ? (routeMissing
                      ? "。宿主还是旧版本（没有 /snapshot-forget 路由），请彻底退出 DSH 再启动。"
                      : "。首个原因：" + state.reason)
                  : ""),
              state.failed > 0 ? 7000 : 4200,
            );
            setFavSel({});
            try { loadFavFacts(); } catch (e) {}
            return;
          }
          var id = list[i];
          api("/snapshot-forget", { sessionId: id, confirm: true }).then(function (data) {
            if (data && data.ok === true) {
              state.ok += 1;
              state.bytesFreed += Number(data.result && data.result.bytesFreed) || 0;
            } else {
              state.failed += 1;
              if (state.reason === "") state.reason = String((data && data.error) || "接口返回失败");
            }
          }).catch(function (err) {
            state.failed += 1;
            if (state.reason === "") state.reason = String((err && err.message) || "网络请求失败");
          }).then(function () {
            i += 1;
            state.done = i;
            setFavBatch(Object.assign({}, state));
            step();
          });
        }
        step();
      }

      // 0.43.0 — 收藏清理 → 删除收藏垃圾文件。
      //
      // 分类判据全部在宿主（lib/junk-scan.js 的 JUNK_CATEGORIES），前端只负责
      // 勾选与展示，**不拼路径**：删除请求只发类别名，宿主按类别重新扫一遍再删，
      // 所以前端改不动「删什么」。session.v*.jsonl.zstd（对话本体）永不入选。
      var favJunkPair = React.useState(null);
      var favJunk = favJunkPair[0];
      var setFavJunk = favJunkPair[1];
      var favJunkSelPair = React.useState({});
      var favJunkSel = favJunkSelPair[0];
      var setFavJunkSel = favJunkSelPair[1];

      function favJunkScan() {
        setFavJunk(function (prev) { return Object.assign({}, prev || {}, { scanning: true, error: "" }); });
        api("/junk-scan").then(function (data) {
          if (!data || data.ok !== true) {
            var raw = String((data && data.error) || "扫描失败");
            var missing = /no route|404/i.test(raw);
            var msg = missing ? "宿主还是旧版本（没有 /junk-scan 路由），请彻底退出 DSH 再启动。" : raw;
            setFavJunk({ scanning: false, error: msg });
            toast(msg, 6000);
            return;
          }
          var sel = {};
          (data.categories || []).forEach(function (c) {
            if (c.defaultOn === true && Number(c.files) > 0) sel[c.key] = true;
          });
          setFavJunkSel(sel);
          setFavJunk(Object.assign({}, data, { scanning: false, at: Date.now() }));
        }).catch(function (err) {
          var msg = String((err && err.message) || "网络请求失败");
          setFavJunk({ scanning: false, error: msg });
          toast("扫描失败：" + msg, 6000);
        });
      }

      function favJunkPickKeys() {
        return Object.keys(favJunkSel).filter(function (k) { return favJunkSel[k] === true; });
      }

      function favJunkDelete() {
        var keys = favJunkPickKeys();
        if (keys.length === 0) { toast("先勾选要删的类别"); return; }
        var bytes = 0;
        var files = 0;
        ((favJunk && favJunk.categories) || []).forEach(function (c) {
          if (favJunkSel[c.key] === true) {
            bytes += Number(c.bytes) || 0;
            files += Number(c.files) || 0;
          }
        });
        var sure = window.confirm(
          "将把 " + keys.length + " 类垃圾（" + files + " 项 · " + humanBytes(bytes) + "）送进回收站，可恢复。\n\n"
          + "对话本体（session.v*.jsonl.zstd）永远不会被删。\n\n继续？",
        );
        if (!sure) return;
        setFavJunk(function (prev) { return Object.assign({}, prev || {}, { running: true, result: null, error: "" }); });
        api("/junk-delete", { keys: keys, confirm: true }).then(function (data) {
          if (!data || data.ok !== true) {
            var raw = String((data && data.error) || "删除失败");
            var missing = /no route|404/i.test(raw);
            var msg = missing ? "宿主还是旧版本（没有 /junk-delete 路由），请彻底退出 DSH 再启动。" : raw;
            setFavJunk(function (prev) { return Object.assign({}, prev || {}, { running: false, error: msg }); });
            toast(msg, 6000);
            return;
          }
          setFavJunk(function (prev) { return Object.assign({}, prev || {}, { running: false, result: data }); });
          toast(
            "已送进回收站：" + (Number(data.deleted) || 0) + " 项 · 释放 " + humanBytes(Number(data.bytes) || 0)
              + (Number(data.failed) > 0 ? " · 失败 " + data.failed : ""),
            5000,
          );
          favJunkScan();
        }).catch(function (err) {
          var msg = String((err && err.message) || "网络请求失败");
          setFavJunk(function (prev) { return Object.assign({}, prev || {}, { running: false, error: msg }); });
          toast("删除失败：" + msg, 6000);
        });
      }

      function loadFavFacts() {
        return api("/favorite-facts").then(function (data) {
          if (data && data.ok === true && data.facts && typeof data.facts === "object") {
            setFavFacts(data.facts);
          }
        }).catch(function () {});
      }

      // Read the archived set from the same file the running app uses, via the
      // host half. Cheap, and correct even while the app holds the registry in
      // memory, because archiving is persisted as it happens.
      React.useEffect(function () {
        loadWorkspaceTitles().then(function () {
          setTitlesRev(function (n) { return n + 1; });
        });
        refreshFavorites();
        Promise.resolve(loadFavFacts()).catch(function () {});
        var alive = true;
        // ONE reader of /archived. An earlier version fetched it here by hand and
        // copied only `archivedSessionIds`, which is how the per-row list stayed
        // empty ("归档共 0 条") until someone pressed 刷新 — the metadata was in
        // the response and simply never stored. Going through loadArchived()
        // means a new field can only be forgotten in one place.
        Promise.resolve(loadArchived()).catch(function () {});
        // Prime the idle preview so the control reads as live on first paint.
        api("/idle-archive?hours=" + encodeURIComponent(String(idleHours))).then(function (data) {
          if (alive) setPreview(data && data.ok ? data : null);
        }).catch(function () {});
        Promise.resolve(loadPurgePolicy()).catch(function () {});
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
      // The candidate list and the one-shot delete that used to live here were
      // removed in 0.31.0: ArchiveDeleteCard renders the list, owns the
      // selection, and asks for a dry run before it deletes anything. A second
      // delete path in the section would be a second set of guards to keep in
      // step with the host.

      var children = [];

      // --- the function switcher ---------------------------------------
      // Which of the five big functions is on screen. The choice is
      // remembered so a restart lands where the user left off; an unknown or
      // unreadable value falls back to the first tab instead of a blank page.
      var viewPair = React.useState(function () {
        try {
          var saved = localStorage.getItem("dsh-aff-settings-view");
          // 0.36.0: 快速上手 is the landing view — a person opening this page for
          // the first time needs to know what the six tabs do and which one is
          // safe, not to be dropped straight into a bulk archive control.
          return typeof saved === "string" && saved.length > 0 ? saved : "start";
        } catch (e) { return "start"; }
      });
      var view = viewPair[0];
      var setView = viewPair[1];
      function pickView(next) {
        setView(next);
        try { localStorage.setItem("dsh-aff-settings-view", next); } catch (e) {}
      }
      // Order matters: it is the reading order of the page. Orientation first,
      // then the two archive actions, then the two inspectors, then the
      // read-only favourites list.
      var VIEW_ORDER = [
        { key: "start", label: "快速上手" },
        { key: "idle", label: "批量归档" },
        { key: "del", label: "删除归档" },
        { key: "snapshot-usage", label: "快照清理" },
        { key: "ungrouped", label: "缓存与未分组" },
        { key: "fav", label: "收藏清单" },
      ];

      // The header button used to reload only favourites + the archive list, so
      // pressing it while looking at 快照清理 / 缓存与未分组 did nothing visible.
      // It now re-reads whatever the current tab is actually showing.
      //
      // 0.37.1 — "nothing happened" was STILL true for the two inspector tabs,
      // because those cards own their data and only scanned when their own
      // button was pressed. The header now also bumps a counter the cards
      // watch, so 刷新 means the same thing on every tab. It stays an EXPLICIT
      // act: a card records the counter it mounted with and ignores it until it
      // changes, so nothing scans on page open. A note next to the button names
      // what just ran, because "I pressed it and nothing changed" is a bug
      // report either way — if the data really is unchanged, the page has to
      // say so out loud.
      // 0.38.0 — the column layout is module-level (every list reads the same
      // one), so a drag on a caption has to repaint from here. The bump is a
      // counter the section owns; the layout calls it when it changes.
      var columnRevPair = React.useState(0);
      COLUMN_LAYOUT_BUMP = function () { columnRevPair[1](columnRevPair[0] + 1); };
      var refreshPair = React.useState(0);
      var refreshTick = refreshPair[0];
      var setRefreshTick = refreshPair[1];
      var refreshNotePair = React.useState("");
      var refreshNote = refreshNotePair[0];
      var setRefreshNote = refreshNotePair[1];

      function refreshCurrent() {
        refreshFavorites();
        loadArchived();
        var did = ["归档列表", "收藏状态"];
        if (view === "idle") { loadPreview(idleHours); did.push("候选清单"); }
        if (view === "del") did.push("可删行与占用");
        if (view === "snapshot-usage") did.push("快照统计");
        if (view === "ungrouped") did.push("未分组诊断");
        if (view === "fav") { Promise.resolve(loadFavFacts()).catch(function () {}); did.push("收藏清单"); }
        setRefreshTick(refreshTick + 1);
        setRefreshNote("刚刚刷新：" + did.join(" + "));
      }

      children.push(React.createElement("div", { key: "head", style: ROW_STYLE },
        React.createElement("div", { style: TITLE_STYLE }, "归档助手"),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
          refreshNote.length > 0
            ? React.createElement("span", { key: "refresh-note", style: SUBTLE_STYLE }, refreshNote)
            : null,
          // 0.40.0 — ★ Star 在顶部栏「刷新」左侧：整个插件页都能看到它，
          // 不必先切到某一栏。次要动作，hover 才解释用途。
          React.createElement(StarButton, { key: "star", kind: "page" }),
				// 0.42.2 — 顶部栏「刷新」左侧加 ⟳ 检查更新（复用技能浏览器全局委托）
				React.createElement("button", {
					key: "upd", type: "button", style: BTN_STYLE,
					"data-dsh-upd": "dsh-archive-favorites-forge",
					title: "检查更新（有新版可一键安装到 desktop profile，装完需彻底退出 DSH 再启动）",
					"aria-label": "检查更新",
					onClick: function () { try { if (window.__dshUpdClick) window.__dshUpdClick(this, "dsh-archive-favorites-forge"); } catch (e) {} },
				}, "⟳"),
          React.createElement("button", {
            type: "button", style: BTN_STYLE,
            title: "重新读取当前这一栏的数据（归档列表、收藏状态，以及本栏自带的重活）",
            "aria-label": "刷新当前栏",
            onClick: refreshCurrent,
          }, "刷新"))));

      // -- 快速上手 (0.36.0) --------------------------------------------------
      //
      // The landing view. Everything on this page deletes something, so the
      // first tab has to answer three questions before anyone touches a
      // button: what do these six tabs do, which of them are reversible, and
      // where are the three switches that guard the irreversible one.
      // Kept as plain text rows on purpose — no buttons, nothing to click.
      var GUIDE_ROWS = [
        {
          key: "guide-terms",
          title: "先分清三件事",
          lines: [
            "归档：只把对话挪进归档区，不动磁盘上任何字节，随时撤回。",
            "删快照：删掉 history-file 那一层（「撤销到某一轮」的依据），默认进 Windows 回收站，可恢复；对话本身还在。注意：在快照清理栏可以勾「永久删除」，勾了就是真删、不进回收站、不可恢复。",
            "删对话：整个会话目录连转录一起消失，永久、不进回收站、不可恢复。",
          ],
        },
        {
          key: "guide-tabs",
          title: "六栏分别做什么",
          lines: [
            "快速上手：就是这一页。",
            "批量归档：按闲置时长把没用的对话收进归档区，可撤回；本栏底部有「归档后顺带删快照」开关（默认开，只在本栏归档和侧栏右键归档时触发）。",
            "删除归档：把归档区里没收藏的对话永久删掉——删的是整个会话目录（转录 + 快照全在里面），永久、不可恢复。本栏有红线，按钮是红的。",
            "快照清理：统计各会话快照占了多少，勾选后删掉，默认进回收站。删的时候有进度条，关掉设置页宿主也会继续删完，10 分钟内重开还能看进度。顶部那行会写「可清理 X 会话 / 共 A」和「全部 B（含已收藏）」，B 才是真实总占用。",
            "缓存与未分组：三件事——「未分组体检」处理侧栏里没归属的会话（可勾「在侧栏隐藏『未分组』分组」，连同组头一起藏起来，不删除任何对话），「孤儿缓存」清掉会话目录已不在、但 storages/session_projcache 里还留着标题/token/摘要的投影缓存，「billion-context 缓存」清理压缩插件自己的会话状态、整包 overview-cache 与检索图片缓存并估算体积。三者都只影响缓存，不碰对话；这几处的删除一律进 Windows 回收站（可恢复），只有你另外勾了「永久删除」才是真删。",
            "收藏清单：收藏项永远不参与「删对话」，但可以逐行点「删快照」单独清掉它的历史快照（对话本身保留，目录进回收站）。现在支持排序和筛选，默认按最近收藏倒序。顶部还有一张「🗑 垃圾文件」卡片（0.43.0 起）：先「扫描」再按五类勾选删除——临时/日志/备份文件、测试残留目录、空目录、未压缩正文残留、历史快照（默认不勾），删除只认类别名、一律进 Windows 回收站可恢复，`session.v*.jsonl.zstd` 对话本体永不入选。",
          ],
        },
        {
          key: "guide-safe",
          title: "三条安全底线",
          lines: [
            "收藏就是豁免：收藏的对话不出现在删除归档表里，也不计入快照清理。",
            "凡删除都两步：先「试算」看清单，再「确认」。试算不改任何文件。",
            "重活不自动跑：快照统计、未分组诊断、孤儿缓存扫描都要你按按钮才扫一次，页面打开不会自己扫盘。",
            "但有一个例外：快照清理栏底部有「后台定时清理」开关，默认关着，只有你显式打开，它才会到点把超期快照移进回收站（收藏的和年龄未知的不动）。",
          ],
        },
        {
          key: "guide-sidebar",
          title: "侧栏那两个开关在哪",
          lines: [
            "视图选项 → 5 项互斥筛选：隐藏已归档 / 全部对话（显示已归档）/ 仅显示已归档 / 仅显示收藏（已归档）/ 仅显示收藏（未归档）。",
            "视图选项 → 隐藏定时任务：把跟定时任务有关的会话藏起来，到点也不会自己冒回来，只有你关掉这个开关才会恢复显示。",
            "另外，顶部栏那个「★ Star」：点一下去 GitHub 给作者点星，纯感谢，不影响任何功能。",
          ],
        },
        {
          key: "guide-columns",
          title: "表格的列可以自己排",
          lines: [
            "每一栏的列表都是同六列：文件大小、时长、对话名称、文件数量、工作区名称、时间。",
            "拖表头可以把那一列拖到别的位置；拖表头右侧的竖线可以改宽度，双击竖线在这一列的三种宽度之间切换。",
            "改过之后右上角会出现「恢复默认列」，点一下全部回到默认。设置记在本机，跨栏、跨重启都一致。",
          ],
        },
        {
          key: "guide-refresh",
          title: "右上角「刷新」做什么",
          lines: [
            "重新读取当前这一栏的数据：归档列表、收藏状态，以及本栏自带的重活（候选清单、快照统计、未分组诊断）。按钮旁会写「刚刚刷新：…」，说清它刚做了什么。",
            "打开页面仍然不会自己扫盘：那些统计要你按按钮才跑一次。",
          ],
        },
      ];
      // -- the column layout row -------------------------------------------
      //
      // Hidden until the reader has actually moved or resized something: an
      // always-on "reset" button on a page whose default IS the right answer
      // invites the reader to press it. The hint lives in 快速上手 instead.
      if (columnIsCustomised()) {
        children.push(React.createElement("div", {
          key: "columns",
          style: Object.assign({}, ROW_STYLE, { gap: "8px", flexWrap: "wrap", padding: "4px 0" }),
        },
          React.createElement("span", { key: "columns-note", style: SUBTLE_STYLE },
            "列的顺序与宽度已自定义（拖表头换位置、拖表头右侧竖线改宽度、双击竖线恢复该列）。"),
          React.createElement("button", {
            key: "columns-reset",
            type: "button",
            style: BTN_STYLE,
            title: "把六列恢复成默认顺序与默认宽度",
            "aria-label": "恢复默认列顺序与列宽",
            onClick: resetColumnLayout,
          }, "恢复默认列")));
      }
      children.push(React.createElement("div", { key: "start", style: CARD_STYLE },
        React.createElement("div", { style: TITLE_STYLE }, "快速上手"),
        React.createElement("div", { style: HINT_STYLE },
          "这个页面只做一件事：管理归档、快照、缓存这三类占地方的东西。",
          "下面按「先分清概念 → 六栏做什么 → 安全底线」的顺序说清楚，看完再动手。"),
        React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "12px", marginTop: "2px" } },
          GUIDE_ROWS.map(function (block) {
            return React.createElement("div", {
              key: block.key,
              style: { display: "flex", flexDirection: "column", gap: "4px" },
            },
              React.createElement("div", { style: SUBHEAD_STYLE }, block.title),
              block.lines.map(function (line, index) {
                return React.createElement("div", {
                  key: block.key + "-" + index,
                  style: Object.assign({}, HINT_STYLE, { paddingInlineStart: "10px", textIndent: "-10px" }),
                }, "· " + line);
              }));
          }))));

      // -- idle auto-archive: the heavyweight control lives HERE, not in the
      // per-row menu, because it acts on the whole archive at once and needs a
      // threshold plus a live preview that a menu row cannot carry.
      var idleCount = preview && typeof preview.idleCount === "number" ? preview.idleCount : null;
      var canUndo = Array.isArray(undoList) && undoList.length > 0;
      // Preview sample rows, so the user can SEE what a threshold selects before
      // committing — the count alone is not enough to trust a bulk archive.
      var idleSample = preview && Array.isArray(preview.sample) ? preview.sample : [];
      children.push(React.createElement("div", { key: "idle", style: CARD_STYLE },
        React.createElement("div", { style: TITLE_STYLE }, "批量归档闲置对话"),
        // One line of explanation. The previous wording repeated what the
        // controls already say and read as a wall of text.
        React.createElement("div", { style: HINT_STYLE },
          "把闲置超过阈值的未归档对话收进归档区。归档只改状态、不动任何字节，随时可撤回。"),
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" } },
          React.createElement("span", { style: { fontSize: "12px" } }, "闲置超过"),
          React.createElement("input", {
            type: "text",
            inputMode: "decimal",
            value: hoursText,
            "aria-label": "闲置小时数阈值",
            style: INPUT_STYLE,
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
              : idleCount > 0
                ? "→ " + idleCount + " 个候选"
                  // 明细只有前 N 条（宿主侧上限 50），所以只能报「明细」的合计，
                  // 绝不能冒充全量；口径是整会话目录字节，不是快照字节。
                  + (idleSample.length > 0
                    ? "（明细 " + idleSample.length + " 条 · 共占 " + humanBytes(sumRowBytes(idleSample)) + " · 整会话目录）"
                    : "")
                : "→ 无候选")),
        // -- the candidate list, INLINE ------------------------------------
        //
        // 🔴 THE EXPORT BUTTON ALONE WAS NOT ENOUGH. "Here are 93 rows, download
        // a text file to see them" makes checking a bulk action cost a trip to
        // the file system — and an archive that the user has to export in order
        // to review is an archive they will review zero times. The rows are
        // already in the preview payload (`sample`, capped at 50 host-side), so
        // showing them here costs nothing extra and removes the export step
        // from the normal path. The export stays for the full list.
        //
        // Each row carries the same three facts the export file carries — how
        // long it has been quiet, what it is called, and which workspace it
        // lives in — because a row without a name cannot be checked by eye.
        idleCount !== null && idleCount > 0
          ? React.createElement("div", {
              key: "idle-list",
              style: Object.assign({
                display: "flex", flexDirection: "column", gap: "2px",
                maxHeight: "300px",
                padding: "4px", borderRadius: "8px",
                background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))",
              }, LIST_SCROLL),
            },
              [React.createElement(ListHead, { key: "idle-head" })].concat(
                idleSample.map(function (row) {
                var id = String(row && row.id ? row.id : "");
                // 0.37.1 — six columns with real numbers. The host sends the
                // WHOLE session directory size and its file count with the
                // preview (0.37.0 sent the snapshot ledger, which was empty for
                // almost every row), plus the ledger size for reference.
                return React.createElement(SessionRow, {
                  key: id,
                  row: {
                    id: id,
                    title: row && row.title,
                    untitled: row && row.blank === true ? "（新会话）" : "（无标题）",
                    sizeText: row && Number.isFinite(Number(row.bytes)) && Number(row.bytes) > 0
                      ? humanBytes(row.bytes)
                      : "",
                    idleMs: row ? ageMsOf(row.updatedAt) : null,
                    fileCountText: row ? countText(row.fileCount ?? row.blobCount) : "",
                    workspaceText: workspaceName(row && row.cwd),
                    whenText: humanWhen(row && row.updatedAt),
                  },
                });
              })),
              idleCount > idleSample.length
                ? React.createElement("div", {
                    key: "idle-more",
                    style: { fontSize: "11px", opacity: .6, padding: "2px 4px" },
                  }, "还有 " + (idleCount - idleSample.length) + " 个未显示——完整清单可用「导出清单」拿到。")
                : null)
          : (idleCount === 0
              ? React.createElement("div", {
                  key: "idle-none",
                  style: { fontSize: "12px", opacity: .65 },
                }, "没有闲置超过 " + idleHours + " 小时的会话。")
              : null),
        // -- the "archiving drops the snapshots" switch ---------------------
        //
        // It sits INSIDE the archive card, directly under the button that
        // triggers it, because it has no meaning apart from that button: an
        // "auto-delete" switch parked in its own tab would read as a policy
        // about the whole archive, which it is not. It only ever touches the
        // sessions the very archive request in flight succeeded on.
        (function () {
          // Unread (null) renders as ON, matching the host default; the risk block
          // below is still the only path that writes enabled:true back.
          var on = purgePolicy === null ? true : purgePolicy.enabled === true;
          return React.createElement("div", {
            key: "idle-purge",
            style: {
              display: "flex", flexDirection: "column", gap: "4px",
              padding: "8px", borderRadius: "8px",
              border: "1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.25))",
            },
          },
            React.createElement("label", {
              style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "12px", cursor: "pointer" },
            },
              React.createElement("input", {
                type: "checkbox",
                "aria-label": "归档后删除快照开关",
                checked: on,
                onChange: function () {
                  // Off is immediate; on has to pass through the risk block.
                  if (on) { savePurgePolicy({ enabled: false }); return; }
                  setPurgeRisk(true);
                },
              }),
              "归档后顺带删除这些对话的快照"),
            React.createElement("div", { style: { fontSize: "11px", opacity: .65, lineHeight: "16px" } },
              on
                ? "默认开启：每次归档成功后，被归档对话的 history-file 快照会一起进回收站（可恢复）——本卡片的批量归档和侧栏右键归档都算。除归档这个动作外不会自动清理任何东西。"
                : "已关闭：归档只把对话挪进归档区，快照原样保留，这些对话仍可「撤销到某一轮」。"),
            purgeRisk
              ? React.createElement("div", {
                  style: {
                    display: "flex", flexDirection: "column", gap: "6px",
                    padding: "8px", borderRadius: "8px",
                    background: "var(--dsw-alias-bg-warning, rgba(255,107,107,.1))",
                    fontSize: "12px", lineHeight: "18px",
                  },
                },
                  React.createElement("div", null,
                    "开启后：每次归档成功后，被归档那些对话的快照会被删掉（送 Windows 回收站，可恢复）。代价是它们不能再「撤销到某一轮」——改过的文件就退不回去了。"),
                  React.createElement("div", { style: { opacity: .75 } },
                    "只在「归档」这个动作发生时触发：本卡片的「归档」按钮，以及你在侧栏右键归档单个对话——两条路都算。除此之外（定时、按体积、按数量）永远不会自动清理任何东西。"),
                  React.createElement("div", { style: { display: "flex", gap: "6px" } },
                    React.createElement("button", {
                      type: "button",
                      style: DANGER_STYLE,
                      onClick: function () { setPurgeRisk(false); savePurgePolicy({ enabled: true }); },
                    }, "我知道风险，打开"),
                    React.createElement("button", {
                      type: "button",
                      style: BTN_STYLE,
                      onClick: function () { setPurgeRisk(false); },
                    }, "取消")))
              : null);
        })(),
        React.createElement("div", { style: { display: "flex", gap: "6px", flexWrap: "wrap" } },
          React.createElement("button", {
            type: "button",
            style: BTN_STYLE,
            disabled: busy !== "" || idleCount === null || idleCount === 0,
            onClick: function () {
              setBusy("idle");
              setIdleResult(null);
              // 0.42.0 — 批量归档也接上进度：接单即回执 + job 快照 + 轮询。
              // 抢首帧先写 count，否则上百个会话逐个归档时界面看着像卡死。
              var jobId = jobIdFor("id");
              var archiveCount = idleCount === null ? 0 : Number(idleCount) || 0;
              setProgress({
                done: 0, total: archiveCount, bytesFreed: 0, bytesTotal: 0,
                phase: "archive", jobId: jobId,
              });
              runJob("/idle-archive", { hours: idleHours }, {
                jobId: jobId,
                onProgress: function (snap) { setProgress(snap); },
                onDone: function (data) {
                  setBusy("");
                  setProgress(null);
                  setIdleResult(data);
                  setUndoList(data && data.ok && Array.isArray(data.archived) ? data.archived : null);
                  return Promise.all([loadArchived(), loadPreview(idleHours)]);
                },
                onFail: function (error) {
                  setBusy("");
                  setProgress(null);
                  setIdleResult({ ok: false, error: String(error && error.message ? error.message : error) });
                },
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
        // 进度条在结果区上方（顺序与快照清理一致；组件也是同一个）。
        progress && typeof progress === "object"
          ? React.createElement(ProgressBar, {
              key: "idle-progress",
              progress: progress,
              doneVerb: "已归档",
              noun: "会话",
              fallbackLabel: "正在归档…",
            })
          : null,
        idleResult
          ? React.createElement("div", { style: { padding: "8px", borderRadius: "8px", background: "var(--dsw-alias-bg-subtle, rgba(255,255,255,.05))", lineHeight: "20px" } },
              idleResult.ok === false
                ? "操作失败：" + idleResult.error
                : (Array.isArray(idleResult.restored)
                    ? "已撤回 " + idleResult.restored.length + " 个会话的归档状态。"
                    : "已归档 " + ((idleResult.archived || []).length) + " 个会话。"),
              (idleResult.purged && idleResult.purged.length)
                ? React.createElement("div", { style: { marginTop: "4px", opacity: .8, fontSize: "12px" } },
                    "顺带删除了 " + idleResult.purged.length + " 个会话的快照（送回收站"
                      + (typeof idleResult.purgeBytes === "number" && idleResult.purgeBytes > 0
                          ? "，释放 " + humanBytes(idleResult.purgeBytes)
                          : "")
                      + "）。")
                : null,
              (idleResult.purgeFailures && idleResult.purgeFailures.length)
                ? React.createElement("div", { style: { marginTop: "4px", opacity: .7, fontSize: "11px" } },
                    "有 " + idleResult.purgeFailures.length + " 个会话的快照没删成（首个原因："
                      + String(idleResult.purgeFailures[0].reason || "") + "）。")
                : null,
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

      // -- favourites list (0.40.0: 排序 + 筛选 + 默认「最近收藏」倒序) --
      //
      // Data sources, all already loaded by this component:
      //   favSet[id]   → { at, title, cwd }            (the star itself)
      //   favFacts[id] → { bytes, fileCount, modifiedAt }  (/favorite-facts)
      //   archivedIds  → the session ids the app currently reports as archived
      //                  (NOT a snapshot-on-disk test; snapshot presence is
      //                   read from favFacts[id].bytes, see the favSnapOnly filter)
      // The whole view is derived in the renderer: no extra host route, so it
      // still renders against a host that never learned `modifiedAt` — the 时长
      // cell then falls back to 「收藏至今」, which is exactly what 0.37.x showed.
      var favNowMs = Date.now();
      var favRows = favorites.map(function (id) {
        var entry = favSet[id] || {};
        var fact = favFacts[id] || null;
        var factBytes = fact ? Number(fact.bytes) : NaN;
        var factFiles = fact ? Number(fact.fileCount) : NaN;
        var savedAt = msOfIso(entry.at);
        var touchedAt = fact ? msOfIso(fact.modifiedAt) : null;
        // 0.42.0 — 缺 modifiedAt 时旧代码拿 savedAt 顶替，于是「1 小时前收藏」
        // 被报成「时长 1 小时」的闲置时长。收藏年龄不是闲置时长：这里必须是
        // null（该单元格画破折号），绝不允许用收藏时间伪装闲置时间。
        var idleMs = touchedAt !== null ? Math.max(0, favNowMs - touchedAt) : null;
        return {
          id: id,
          entry: entry,
          inArchive: archivedHas(archivedIds, id),
          savedAt: savedAt,
          touchedAt: touchedAt,
          bytes: Number.isFinite(factBytes) ? factBytes : null,
          files: Number.isFinite(factFiles) ? factFiles : null,
          idleMs: idleMs,
          title: entry.title && String(entry.title).trim() ? String(entry.title) : id,
          workspace: workspaceName(entry.cwd),
          cwd: typeof entry.cwd === "string" ? entry.cwd : "",
        };
      });

      // 0.42.6 — facts 还没回来时不能把「未统计」显示成「共占 0 B」，那是两件事。
      var favFactsLoaded = Object.keys(favFacts).length > 0;
      var favNeedle = favQuery.trim().toLowerCase();
      var favVisible = favRows.filter(function (r) {
        // 「只看有快照的」= 该收藏确实有快照落盘，判据是 facts 的字节数，而不是
        // 「会话是否被归档」（inArchive 问的是另一件事，且本机 archivedSessionIds
        // 常为空，会把结果筛成 0 条）。三态处理跟随本文件既有约定：bytes>0 保留；
        // bytes===0 明确无快照，排除；bytes===null 测不到——与下方 size 筛选
        // 对 null 「不猜、直接排除」保持一致，确定性筛选只留有确定值的行。
        if (favSnapOnly && !(r.bytes !== null && r.bytes > 0)) return false;
        if (favNeedle.length > 0) {
          var hay = (r.title + " " + r.workspace + " " + r.cwd).toLowerCase();
          if (hay.indexOf(favNeedle) < 0) return false;
        }
        if (favSize !== "all") {
          // A row the host could not measure has no size to compare, so an
          // explicit size bucket must exclude it rather than guess.
          if (r.bytes === null) return false;
          var mb = r.bytes / (1024 * 1024);
          if (favSize === "lt1" && !(mb < 1)) return false;
          if (favSize === "1to50" && !(mb >= 1 && mb <= 50)) return false;
          if (favSize === "50to500" && !(mb > 50 && mb <= 500)) return false;
          if (favSize === "gt500" && !(mb > 500)) return false;
        }
        if (favAge !== "all") {
          if (r.idleMs === null) return false;
          var days = r.idleMs / 86400000;
          if (favAge === "lt1" && !(days < 1)) return false;
          if (favAge === "1to7" && !(days >= 1 && days <= 7)) return false;
          if (favAge === "7to30" && !(days > 7 && days <= 30)) return false;
          if (favAge === "gt30" && !(days > 30)) return false;
        }
        return true;
      });

      // A row with no measurement sinks to the bottom in BOTH directions: a
      // descending sort must not promote 「不知道」 to the top just because
      // null compares low.
      var favSign = favSort.dir === "asc" ? 1 : -1;
      var favPickSortValue = function (r) {
        if (favSort.key === "saved") return r.savedAt;
        if (favSort.key === "touched") return r.touchedAt;
        if (favSort.key === "size") return r.bytes;
        if (favSort.key === "idle") return r.idleMs;
        if (favSort.key === "count") return r.files;
        return null;
      };
      favVisible.sort(function (a, b) {
        if (favSort.key === "name") {
          return favSign * String(a.title).localeCompare(String(b.title), "zh-Hans-CN", { numeric: true });
        }
        var av = favPickSortValue(a);
        var bv = favPickSortValue(b);
        var aMissing = av === null || av === undefined;
        var bMissing = bv === null || bv === undefined;
        if (aMissing && bMissing) return 0;
        if (aMissing) return 1;
        if (bMissing) return -1;
        if (av === bv) return 0;
        return av < bv ? -favSign : favSign;
      });

      var FAV_CTRL_STYLE = {
        background: "transparent",
        color: "inherit",
        border: "1px solid rgba(128,128,128,.45)",
        borderRadius: "4px",
        padding: "2px 6px",
        fontSize: "12px",
        opacity: .92,
      };
      var favSortOptions = [
        ["saved", "最近收藏"],
        ["touched", "最近更新"],
        ["size", "文件大小"],
        ["idle", "时长"],
        ["count", "文件数量"],
        ["name", "对话名称"],
      ];
      var favSizeOptions = [
        ["all", "全部大小"],
        ["lt1", "小于 1 MB"],
        ["1to50", "1–50 MB"],
        ["50to500", "50–500 MB"],
        ["gt500", "大于 500 MB"],
      ];
      var favAgeOptions = [
        ["all", "全部时长"],
        ["lt1", "1 天内"],
        ["1to7", "1–7 天"],
        ["7to30", "7–30 天"],
        ["gt30", "超过 30 天"],
      ];

      function favRowNode(r) {
        var smallBtn = Object.assign({}, BTN_STYLE, { padding: "2px 8px", fontSize: "11px" });
        return React.createElement(SessionRow, {
          key: r.id,
          lead: React.createElement("input", {
            type: "checkbox",
            checked: favSel[r.id] === true,
            "aria-label": "选择收藏会话 " + (r.title || ""),
            title: "勾选后可批量删除这条收藏的历史快照",
            onChange: function () { favToggleSel(r.id); },
            onClick: function (ev) { if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation(); },
          }),
          row: {
            id: r.id,
            title: r.title,
            // 0.42.0 — 「无快照」与「测不到」不是一件事：宿主对没测到的会话
            // 根本不发 facts 条目（r.bytes === null），量到但目录里没有非空
            // 文件的会话发 0。前者是「不知道」，后者是「确实没有可删的东西」。
            sizeText: r.bytes !== null && r.bytes > 0 ? humanBytes(r.bytes) : (r.bytes === 0 ? "无快照" : ""),
            idleMs: r.idleMs,
            fileCountText: r.files !== null && r.files > 0 ? countText(r.files) : (r.files === 0 ? "无快照" : ""),
            workspaceText: r.workspace,
            // 「时间」列 = 收藏时间（entry.at 是星标写下的那一刻，不是推断值）。
            whenText: humanWhen(r.savedAt),
          },
          tailWidth: TAIL_ACTIONS,
          tail: React.createElement("span", {
            style: { display: "flex", alignItems: "center", gap: "4px", minWidth: 0, whiteSpace: "nowrap" },
          },
            React.createElement("span", { style: { fontSize: "10px", opacity: .6 } },
              r.inArchive ? "已归档" : "未归档"),
            React.createElement("button", {
              type: "button", title: "复制 ID", style: smallBtn,
              onClick: function () { copyId(r.id); },
            }, "ID"),
            React.createElement("button", {
              type: "button", title: "复制文件绝对路径", style: smallBtn,
              onClick: function () { copyPath(r.id); },
            }, "路径"),
            (r.bytes === null || r.bytes > 0)
              ? React.createElement("button", {
                  type: "button",
                  title: "只删这条收藏对话的历史快照（对话本身保留，目录进回收站）",
                  style: smallBtn,
                  onClick: function () {
                    forgetFavoriteSnapshot(r.id, r.entry.title || "", r.bytes).then(function (d) {
                      if (d && d.ok === true) { try { loadFavFacts(); } catch (e) {} }
                    });
                  },
                }, "删快照")
              : React.createElement("span", {
                  title: "这条会话没有可删的快照",
                  style: { fontSize: "10px", opacity: .45 },
                }, "无快照"),
            React.createElement("button", {
              type: "button", title: "取消收藏", style: smallBtn,
              onClick: function () { toggleFavorite(r.id, r.entry.title || ""); },
            }, "取消收藏")),
        });
      }

      children.push(React.createElement("div", { key: "fav", style: CARD_STYLE },
        React.createElement("div", { style: TITLE_STYLE }, "收藏的对话（" + favorites.length + "）"),
        React.createElement("div", { style: HINT_STYLE },
          "收藏是删除侧的唯一豁免：收藏的对话不会出现在「删除归档对话」的表里，也不计入快照清理。若只想腾地方，可以点每行的「删快照」单独清掉它的历史快照（对话保留）。"),
        favorites.length === 0
          ? React.createElement("div", { style: { opacity: .65 } },
              "还没有收藏。把鼠标移到侧栏任意对话上点 ☆，或用对话右侧的「…」菜单选「收藏对话」。")
          : React.createElement(React.Fragment, null,
              // Filter bar. Everything here only narrows what is already on
              // screen, so there is no loading state and nothing to debounce.
              React.createElement("div", {
                key: "fav-filter",
                style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px", margin: "8px 0 2px" },
              },
                React.createElement("input", {
                  type: "search",
                  value: favQuery,
                  placeholder: "搜索对话名称或工作区",
                  "aria-label": "搜索收藏的对话名称或工作区",
                  style: Object.assign({}, FAV_CTRL_STYLE, { width: "168px" }),
                  onChange: function (ev) { setFavQuery(ev.target.value); },
                }),
                React.createElement("select", {
                  value: favSort.key,
                  title: "排序字段",
                  "aria-label": "排序字段",
                  style: FAV_CTRL_STYLE,
                  onChange: function (ev) { setFavSort({ key: ev.target.value, dir: favSort.dir }); },
                }, favSortOptions.map(function (pair) {
                  return React.createElement("option", { key: pair[0], value: pair[0] }, pair[1]);
                })),
                React.createElement("button", {
                  type: "button",
                  title: favSort.dir === "desc" ? "当前降序，点击切换为升序" : "当前升序，点击切换为降序",
                  style: Object.assign({}, FAV_CTRL_STYLE, { cursor: "pointer" }),
                  onClick: function () {
                    setFavSort({ key: favSort.key, dir: favSort.dir === "desc" ? "asc" : "desc" });
                  },
                }, favSort.dir === "desc" ? "↓ 降序" : "↑ 升序"),
                React.createElement("select", {
                  value: favSize,
                  title: "按文件大小筛选",
                  "aria-label": "按文件大小筛选",
                  style: FAV_CTRL_STYLE,
                  onChange: function (ev) { setFavSize(ev.target.value); },
                }, favSizeOptions.map(function (pair) {
                  return React.createElement("option", { key: pair[0], value: pair[0] }, pair[1]);
                })),
                React.createElement("select", {
                  value: favAge,
                  title: "按时长（距最后一次改动）筛选",
                  "aria-label": "按时长筛选",
                  style: FAV_CTRL_STYLE,
                  onChange: function (ev) { setFavAge(ev.target.value); },
                }, favAgeOptions.map(function (pair) {
                  return React.createElement("option", { key: pair[0], value: pair[0] }, pair[1]);
                })),
                React.createElement("label", {
                  title: "只显示已经有归档快照的收藏",
                  style: { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", opacity: .92, cursor: "pointer" },
                },
                  React.createElement("input", {
                    type: "checkbox",
                    checked: favSnapOnly,
                    onChange: function (ev) { setFavSnapOnly(ev.target.checked === true); },
                  }, null),
                  "只看有快照的"),
                React.createElement("span", { style: { fontSize: "12px", opacity: .65 } },
                  favVisible.length === favorites.length
                    ? "共 " + favorites.length + " 条"
                    : "筛出 " + favVisible.length + " / " + favorites.length + " 条",
                  // 0.42.5 — 这一句原来写成了 `React.createElement(...) + " · 共占…"`，
                  // 元素对象被转成字符串，界面上直接出现「[object Object] · 共占…」。
                  // 口径：bytes 来自 /favorite-facts 的 measureSessionDirsFor = 整个
                  // 会话目录，与快照卡的「快照字节」区分开。
                  favVisible.length === 0
                    ? ""
                    : (favFactsLoaded
                        ? " · 共占 " + humanBytes(sumRowBytes(favVisible)) + "（整会话目录）"
                        : " · 统计中…（正在量快照目录）"))),
              // 0.42.5 — 批量操作条 + 进度条（收藏项专用；只删快照，不删对话）
              React.createElement("div", {
                key: "fav-batch",
                style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", margin: "6px 0 2px", fontSize: "12px" },
              },
                React.createElement("button", {
                  type: "button",
                  style: Object.assign({}, BTN_STYLE, { padding: "3px 9px", fontSize: "12px" }),
                  onClick: function () {
                    var next = {};
                    favVisible.forEach(function (r) { next[r.id] = true; });
                    setFavSel(next);
                  },
                }, "全选当前 " + favVisible.length + " 条"),
                React.createElement("button", {
                  type: "button",
                  style: Object.assign({}, BTN_STYLE, { padding: "3px 9px", fontSize: "12px" }),
                  onClick: function () { setFavSel({}); },
                }, "清空勾选"),
                React.createElement("button", {
                  type: "button",
                  disabled: favBatch && favBatch.running === true,
                  style: Object.assign({}, BTN_STYLE, { padding: "3px 9px", fontSize: "12px", fontWeight: 600 }),
                  onClick: function () { favBatchForget(favSelList()); },
                }, (favBatch && favBatch.running === true ? "删除中…" : "删除所选快照") + "（" + favSelCount() + "）"),
                React.createElement("span", { style: { opacity: .72 } },
                  favBatch
                    ? (favBatch.running === true
                        ? "处理中 " + favBatch.done + " / " + favBatch.total + " · 成功 " + (favBatch.ok || 0)
                          + " · 释放 " + humanBytes(favBatch.bytesFreed)
                        : "上次：成功 " + (favBatch.ok || 0) + " / " + favBatch.total
                          + " · 失败 " + (favBatch.failed || 0)
                          + " · 释放 " + humanBytes(favBatch.bytesFreed)
                          + ((favBatch.failed > 0 && favBatch.reason) ? "（" + favBatch.reason + "）" : ""))
                    : "勾选后点「删除所选快照」；只删历史快照，对话保留。")),
              React.createElement("div", {
                key: "fav-batch-bar",
                style: {
                  height: "4px", borderRadius: "999px", background: "rgba(127,127,127,.22)",
                  margin: "0 0 4px", overflow: "hidden",
                  display: (favBatch && favBatch.running === true) ? "block" : "none",
                },
              }, React.createElement("div", {
                style: {
                  height: "100%",
                  width: (favBatch && favBatch.total > 0 ? Math.round(Math.min(1, favBatch.done / favBatch.total) * 100) : 0) + "%",
                  background: "#2563eb", transition: "width .2s ease",
                },
              })),
              // 0.43.1 — 删除收藏垃圾文件。整宽独立一行：0.43.0 把它嵌在筛选行里，
              // 与「只看有快照的」抢同一行，行高被撑出大片空白、按钮还会拐行。
              // 类别改为横向 chip，一屏放得下；所有按钮 whiteSpace:nowrap。
              React.createElement("div", {
                key: "fav-junk",
                style: {
                  display: "flex", flexDirection: "column", gap: "4px",
                  border: "1px solid rgba(127,127,127,.22)", borderRadius: "8px",
                  padding: "5px 8px 6px", margin: "2px 0 4px", fontSize: "12px",
                },
              },
                React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" } },
                  React.createElement("span", { style: { fontWeight: 600, whiteSpace: "nowrap" } }, "🗑 垃圾文件"),
                  React.createElement("button", {
                    type: "button",
                    disabled: !!(favJunk && favJunk.scanning === true),
                    style: Object.assign({}, BTN_STYLE, { padding: "2px 8px", fontSize: "11.5px", whiteSpace: "nowrap" }),
                    onClick: function () { favJunkScan(); },
                  }, (favJunk && favJunk.scanning === true) ? "扫描中…" : "扫描"),
                  React.createElement("span", {
                    style: { opacity: .6, fontSize: "11px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "1 1 auto" },
                  },
                    favJunk && favJunk.categories
                      ? ((Number(favJunk.totalFiles) || 0) + " 项 · " + humanBytes(Number(favJunk.totalBytes) || 0))
                      : (favJunk && favJunk.error ? "" : "未扫描")),
                  React.createElement("button", {
                    type: "button",
                    disabled: !!(favJunk && favJunk.running === true) || favJunkPickKeys().length === 0,
                    style: Object.assign({}, BTN_STYLE, { padding: "2px 8px", fontSize: "11.5px", fontWeight: 600, whiteSpace: "nowrap" }),
                    onClick: function () { favJunkDelete(); },
                  }, (favJunk && favJunk.running === true ? "删除中…" : "删除所选") + "（" + favJunkPickKeys().length + "）")),
                favJunk && favJunk.categories
                  ? React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap", rowGap: "3px" } },
                      favJunk.categories.map(function (c) {
                        var n = Number(c.files) || 0;
                        return React.createElement("label", {
                          key: "junk-" + c.key,
                          title: c.hint,
                          style: {
                            display: "inline-flex", alignItems: "center", gap: "4px", whiteSpace: "nowrap",
                            padding: "1px 6px", borderRadius: "6px", cursor: n === 0 ? "default" : "pointer",
                            border: "1px solid rgba(127,127,127,.22)", opacity: n === 0 ? .45 : 1,
                          },
                        },
                          React.createElement("input", {
                            type: "checkbox",
                            checked: favJunkSel[c.key] === true,
                            disabled: n === 0,
                            style: { margin: 0 },
                            onChange: function (ev) {
                              var next = Object.assign({}, favJunkSel);
                              if (ev.target.checked) next[c.key] = true; else delete next[c.key];
                              setFavJunkSel(next);
                            },
                          }),
                          React.createElement("span", null, c.label),
                          React.createElement("span", { style: { opacity: .7, fontSize: "11px" } },
                            n + " · " + humanBytes(Number(c.bytes) || 0)));
                      }))
                  : null,
                (favJunk && favJunk.error) || (favJunk && favJunk.result)
                  ? React.createElement("div", {
                      style: {
                        fontSize: "11px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                        color: (favJunk && favJunk.error) ? "#d93025" : "inherit",
                        opacity: (favJunk && favJunk.error) ? 1 : .7,
                      },
                    },
                      (favJunk && favJunk.error)
                        ? favJunk.error
                        : ("上次：删了 " + (Number(favJunk.result.deleted) || 0) + " 项 · 释放 " + humanBytes(Number(favJunk.result.bytes) || 0)
                            + ((Number(favJunk.result.failed) || 0) > 0 ? " · 失败 " + favJunk.result.failed : "")))
                  : null),

              favVisible.length === 0
                ? React.createElement("div", { key: "fav-empty", style: { opacity: .65, marginTop: "4px" } },
                    "当前筛选条件下没有匹配的收藏。清空搜索、或把筛选改回「全部」，即可看到全部 "
                    + favorites.length + " 条。")
                : React.createElement("div", {
                    key: "fav-rows",
                    style: Object.assign({ display: "flex", flexDirection: "column", gap: "4px", maxHeight: "330px" }, LIST_SCROLL),
                  },
                    [React.createElement(ListHead, { key: "fav-head", tail: TAIL_ACTIONS })].concat(favVisible.map(favRowNode))))));

      // The standalone "导出清单" card was removed: the export button and its
      // result now live together inside the 批量归档闲置对话 card, so the path
      // appears directly beneath the control that produced it.

      // -- batch delete of unfavourited archived chats --
      //
      // The rows come from the live archive registry (/archived -> entries), so
      // this list shows what is actually archived right now instead of asking
      // the user to export one. Selection, the pre-tick threshold and the
      // dry-run/confirm pair all live in the shared shell.
      children.push(React.createElement(ArchiveDeleteCard, {
        key: "del",
        entries: archiveEntries,
        favourites: archivedFavorites,
        unavailable: archiveUnavailable,
        loading: archived === null,
        source: archiveSource,
        onRefresh: function () { loadArchived(); },
      }));
      // -- ungrouped-bucket health ("未分组体检") --
      //
      // Placed last on purpose: it is a maintenance card, not an everyday
      // action, and putting it above the archive controls would suggest the
      // bucket is something that needs attention every day.
      // Snapshot storage usage, right above the ungrouped health card: both are
      // "look at what this plugin is doing to your disk" maintenance cards, and
      // neither measures anything until its own button is pressed.
      children.push(React.createElement(SnapshotUsageCard, { key: "snapshot-usage", refreshTick: refreshTick }));

      children.push(React.createElement(UngroupedCard, { key: "ungrouped", refreshTick: refreshTick }));

      // --- assemble: header, switcher, then one visible panel ----------
      //
      // The cards were pushed flat into `children`. They are grouped by key
      // here rather than at each push site so there is exactly ONE place that
      // decides what is on screen — a viewer that has to consult five
      // independent push sites is a viewer that eventually disagrees with
      // itself.
      //
      // `child.key` is what real React exposes; the probe's createElement
      // stub keeps the key inside props instead. Reading both means the same
      // grouping logic runs in the app and under test.
      function keyOfChild(child) {
        if (!child) return null;
        if (child.key !== null && child.key !== undefined) return String(child.key);
        if (child.props && child.props.key !== null && child.props.key !== undefined) return String(child.props.key);
        return null;
      }
      var headNode = null;
      var cardByKey = {};
      var stray = [];
      children.forEach(function (child) {
        var key = keyOfChild(child);
        if (key === "head") { headNode = child; return; }
        if (key !== null && VIEW_ORDER.some(function (item) { return item.key === key; })) {
          cardByKey[key] = child;
          return;
        }
        // Anything this list does not recognise is still rendered, always.
        // A card that silently disappears because a key was renamed is the
        // exact failure mode this page already shipped once.
        stray.push(child);
      });
      var activeView = cardByKey[view] ? view : VIEW_ORDER[0].key;
      var assembled = [];
      if (headNode) assembled.push(headNode);
      assembled.push(React.createElement("div", {
        key: "tabs",
        role: "tablist",
        style: { display: "flex", gap: "4px", flexWrap: "wrap" },
      }, VIEW_ORDER.map(function (item) {
        var on = item.key === activeView;
        return React.createElement("button", {
          key: "tab-" + item.key,
          type: "button",
          role: "tab",
          "aria-selected": on ? "true" : "false",
          "data-aff-view": item.key,
          style: {
            padding: "5px 12px",
            borderRadius: "7px",
            cursor: "pointer",
            fontSize: "12.5px",
            fontWeight: on ? "600" : "400",
            border: "1px solid var(--dsw-alias-border-l4, rgba(127,127,127,.25))",
            background: on ? "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.22))" : "transparent",
            color: "inherit",
            opacity: on ? "1" : ".75",
          },
          onClick: function () { pickView(item.key); },
        }, item.label);
      })));
      // -- panel bodies: mounted on first visit, frozen while hidden --------
      //
      // `paintCache` keeps, per view key, the element object that was last
      // built while that view was on screen. Writing it during render is
      // deliberate and idempotent (the same render always computes the same
      // entry), and it is what lets a hidden panel hand React an identical
      // element so the subtree is skipped instead of re-rendered.
      //
      // Worth stating the trade: a hidden panel can be one render stale. It is
      // rebuilt the moment it becomes visible, before any paint, so the stale
      // window is invisible by construction — whereas re-rendering four hidden
      // panels on every threshold keystroke is a cost the user can feel.
      var paintCacheRef = React.useRef({});
      var paintCache = paintCacheRef.current;
      VIEW_ORDER.forEach(function (item) {
        var activeNow = item.key === activeView;
        var body;
        if (activeNow) {
          body = cardByKey[item.key] ? cardByKey[item.key] : null;
          paintCache[item.key] = body;
        } else if (Object.prototype.hasOwnProperty.call(paintCache, item.key)) {
          body = paintCache[item.key];
        } else {
          // Never opened: mount nothing at all. This is the first-paint win —
          // four cards, two of them with long lists, do not exist yet.
          body = null;
        }
        assembled.push(React.createElement("div", {
          key: "panel-" + item.key,
          "data-aff-panel": item.key,
          "data-aff-visited": item.key === activeView || Object.prototype.hasOwnProperty.call(paintCache, item.key) ? "1" : "0",
          style: {
            display: activeNow ? "flex" : "none",
            flexDirection: "column",
            gap: "8px",
          },
        }, body));
      });
      if (stray.length > 0) assembled.push(React.createElement("div", {
        key: "panel-stray",
        style: { display: "flex", flexDirection: "column", gap: "8px" },
      }, stray));

      return React.createElement("div", { style: SECTION_STYLE }, assembled);
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
    // edit/undo. Until 0.38 truncation also needed the original conversation
    // gone, via the host's `/session-replace` route (`handleDelete` with an
    // explicit `replace` flag). 0.39 no longer does: the rewind route shadows
    // the tail of the SAME session, so nothing is deleted and the session id —
    // and therefore the prompt cache prefix — survives.
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

    /* 被遮蔽的历史行（0.39.1）。撤销/删除之后模型侧已经看不到这些消息了，
       但窗口里它们仍然是 append-origin 事件、照旧渲染。降透明度让"这段已经不算数"
       一眼可见；人类提问行再加删除线，避免误以为还能接着聊。
       opacity 加 !important：应用给部分行设了行内样式。 */
    .dsh-aff-sd-shadowed {
      opacity: .4 !important;
    }
    .dsh-aff-sd-shadowed-msg {
      text-decoration: line-through;
      text-decoration-thickness: 1px;
      text-decoration-color: currentColor;
    }
    @media (prefers-color-scheme: light) {
      .dsh-aff-sd-shadowed {
        opacity: .48 !important;
      }
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
    //   会话截断  POST /session-rewind {sessionId, beforeSeq} —— 同会话遮蔽
    //            surface 尾部（0.39.0 起；此前是 fork 子会话 + 删原会话）
    //   重发      sessions.binding(sessionId).session.prompt 发送，id 不变
    //   预填      conversation.input.shell(sessionId).setDraft(text)
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
      const postJson = async (path, body, timeoutMs = 8000) => {
        const controller = new AbortController()
        const timer = window.setTimeout(() => controller.abort(), timeoutMs)
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

      // ── 同会话撤销（0.39.0）──────────────────────────────────────────
      //
      // 0.38 及以前：fork 一个截断的子会话 → 打开它 → 删掉原会话。语义正确，
      // 但代价很大——子会话是新 id，整段 prompt 缓存全冷。实测：子会话首次
      // 请求要重发 26 万 token，首包 14.5 秒，而热请求只要 5.7 秒。
      //
      // 0.39 起改走宿主 `/session-rewind`：`Session.append` 带
      // `surfaceOp: {op:"replace", startSeq, endSeq}` 把 beforeSeq 之后的
      // surface 节点遮蔽掉。日志只追加、sessionId 不变、活下来的前缀还是前缀。
      // 模型侧看到的历史由 `session.deriveMessages()` 从 surface 折叠而来，
      // 所以它真的「忘了」——不是界面上的障眼法。
      //
      // 已知代价（诚实记录）：replace 会 bump `surface.contentGeneration`，
      // 下一次请求因此走 `startsSeries` 分支、system prompt 节点被重写，
      // 前缀缓存会掉一部分。但比 fork 掉全部便宜一个数量级。
      //
      // 已知边界：窗口里的旧消息不会消失（聊天流只渲染 append-origin 事件，
      // 被遮蔽的事件本身仍是 append），它们变成「历史记录」。用户已拍板接受。
      const rewindSession = async (sessionId, beforeSeq) => {
        const body = { sessionId }
        body.beforeSeq = typeof beforeSeq === 'number' ? beforeSeq : null
        // 大日志落盘可能要一会儿，给足 20 秒，别让 8 秒的默认超时误判失败。
        return await postJson(ROUTE + '/session-rewind', body, 20000)
      }

      // 把文本塞回底部输入框。会话没有换 id、composer 不会重新挂载，所以
      // 「写 localStorage 草稿」这条路在撤销后是无效的（那份草稿只在 composer
      // 首次挂载时水合）。必须走官方 InputHub 的常驻 shell。
      // 拿不到就退回草稿存储——至少下次打开这条对话时还在。
      const prefillDraft = (sessionId, text) => {
        if (typeof text !== 'string' || !text.trim()) return false
        try {
          // `ctx.get` is the undeclared-read escape hatch; reading
          // `pluginCtx.conversation` directly would throw unless it were in
          // `exports.inject`, and adding a service the host might not seat
          // would take the whole plugin down.
          const conversation = typeof pluginCtx.get === 'function' ? pluginCtx.get('conversation') : null
          const shell = conversation?.input?.shell?.(sessionId)
          if (shell && typeof shell.setDraft === 'function') {
            shell.setDraft(text)
            return true
          }
        } catch (e) {
          console.warn('[next-ui-diagnostic] dsh-aff: 走 shell 预填失败，退回草稿存储：', e)
        }
        try {
          localStorage.setItem(`dsh.conversation.${sessionId}`, JSON.stringify({ draft: text, view: null, viewRequest: null }))
        } catch (e) {
          console.warn('[next-ui-diagnostic] dsh-aff: 输入框预填失败：', e)
        }
        return false
      }

      // ── 被遮蔽的历史行标灰（0.39.1）─────────────────────────────────
      //
      // 为什么按 data-chat-flow-key 记账、而不是按轮号：
      //   撤销之后用户往往马上重发，新消息的轮号会从 marker 的 turn 继续往上数，
      //   完全可能等于或小于被撤销那几轮的轮号。按轮号打标会把**刚发的新消息**
      //   也标灰。flow-key 是官方给每个渲染节点发的稳定键（React 重渲染会换 DOM
      //   节点，但 key 不变），拿它记账既能跨重渲染保留标记，又天然只命中
      //   "撤销那一刻已经在窗口里的那几行"。
      //
      // 记账时机：请求**发出前**先抓一遍 key（那时 DOM 一定完整），请求成功后才提交。
      const shadowedKeys = new Map() // sessionId -> Set<flowKey>

      const captureShadowedKeys = (sessionId, fromTurn) => {
        const keys = []
        for (const el of document.querySelectorAll('[data-chat-turn]')) {
          const turn = Number(el.getAttribute('data-chat-turn'))
          if (!Number.isSafeInteger(turn) || turn < fromTurn) continue
          const key = el.getAttribute('data-chat-flow-key')
          if (key) keys.push(key)
        }
        return keys
      }

      const applyShadowMarks = () => {
        // 快路径：从来没标过、窗口里也没有残留标记就直接返回，别给每次 DOM
        // 变动都加一遍全量扫描的负担。
        if (shadowedKeys.size === 0 && document.querySelector('.dsh-aff-sd-shadowed') === null) return
        let activeId = null
        try {
          activeId = currentSessionRow()?.id ?? null
        } catch {
          activeId = null
        }
        // 定位不到当前会话时什么都不动——宁可少标，也不要把别的会话的标记抹掉。
        if (!activeId) return
        const set = shadowedKeys.get(activeId)
        for (const el of document.querySelectorAll('[data-chat-turn]')) {
          const key = el.getAttribute('data-chat-flow-key')
          const on = Boolean(set && key && set.has(key))
          el.classList.toggle('dsh-aff-sd-shadowed', on)
          const kind = el.getAttribute('data-chat-flow-kind')
          const human = kind === 'user' || kind === 'steering'
          el.classList.toggle('dsh-aff-sd-shadowed-msg', on && human)
        }
      }

      const commitShadowedKeys = (sessionId, keys) => {
        if (!Array.isArray(keys) || keys.length === 0) return
        const set = shadowedKeys.get(sessionId) ?? new Set()
        for (const key of keys) set.add(key)
        shadowedKeys.set(sessionId, set)
        applyShadowMarks()
      }

      // 撤销此轮：文件恢复到该轮之前 → 同会话遮蔽这一轮及其后的尾部 →
      // 把这条消息的文本预填回输入框，用户点发送就接着往下走。
      // restoreFiles=false 时只回滚对话、文件保持不动（v49 弹窗勾选框）。
      const doUndoTurn = async (sessionId, info, restoreFiles = true) => {
        if (restoreFiles) {
          await postJson(ROUTE + '/session-files-restore', {
            sessionId,
            keepSeq: typeof info.beforeSeq === 'number' ? info.beforeSeq : -1,
          })
        }
        // 先抓一遍"当前窗口里将要被遮蔽的那几行"，请求成功后才落账。
        const shadowCandidate = captureShadowedKeys(sessionId, info.turn)
        const rewound = await rewindSession(sessionId, info.beforeSeq)
        if (!rewound.changed) throw new Error('这一轮之后没有可撤销的内容')
        commitShadowedKeys(sessionId, shadowCandidate)
        await clearInheritedQueue(sessionId)
        prefillDraft(sessionId, info.userText ?? '')
        toast('已撤回 ' + rewound.shadowed + ' 条消息（原内容保留，模型已不可见）', 4200)
      }

      // 删除消息（v42）：只截断对话，**不动任何文件**——不调用文件恢复、
      // 不预填输入框。截断点同撤销（回合边界）。
      const doDeleteMessage = async (sessionId, info) => {
        const shadowCandidate = captureShadowedKeys(sessionId, info.turn)
        const rewound = await rewindSession(sessionId, info.beforeSeq)
        if (!rewound.changed) throw new Error('这一轮之后没有可删除的内容')
        commitShadowedKeys(sessionId, shadowCandidate)
        await clearInheritedQueue(sessionId)
        toast('已删除 ' + rewound.shadowed + ' 条消息（原内容保留，模型已不可见）', 4200)
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

      // 别当哑巴：任何一次「点了没反应」都必须说清原因。0.39.0 的撤销正是
      // 栽在这里 —— guard 静默 return null，用户以为按钮坏了。
      const guard = (tag, button) => {
        if (busy) {
          toast('正在处理上一步，请稍候…', 1600)
          return null
        }
        let row = null
        try {
          row = currentSessionRow()
        } catch {
          row = null
        }
        if (!row?.id) {
          const why = new Error('找不到当前对话，请先在侧栏点开这条对话再操作')
          fail(button, why)
          toast(why.message, 3200)
          return null
        }
        if (row.running) {
          const why = new Error('会话正在运行，请等当前回合结束')
          fail(button, why)
          toast(why.message, 3200)
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
          // 同会话遮蔽这一轮及其后的尾部，然后**在同一个会话里**把新内容发出去。
          // 旧行同样标灰；新发出的这条是新的 flow-key，不会被误标。
          const shadowCandidate = captureShadowedKeys(sessionId, info.turn)
          const rewound = await rewindSession(sessionId, info.beforeSeq)
          if (!rewound.changed) throw new Error('这条消息之后没有可回滚的内容')
          commitShadowedKeys(sessionId, shadowCandidate)
          await clearInheritedQueue(sessionId)
          const parts = []
          for (const att of files) {
            if (att.image) {
              parts.push({ type: 'image', mediaType: att.mediaType, data: att.base64, name: att.name })
            } else {
              const uploaded = await pluginCtx.fileUpload.upload(sessionId, att.file, att.file.name)
              const receiptId = uploaded?.receiptId ?? uploaded?.value?.receiptId
              if (!receiptId) throw new Error(`文件上传失败：${att.name}`)
              parts.push({ type: 'file', receiptId })
            }
          }
          if (text.trim()) parts.push({ type: 'text', text })
          await promptChild(sessionId, parts)
          teardownEdit()
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
        // React 重渲染会把 class 一起冲掉，每次补挂按钮顺手补一遍标灰。
        applyShadowMarks()
      }

      // React 重渲染会抹掉注入节点；观察 DOM 变化自动补挂。
      //
      // THROTTLED, NOT MICROTASKED. A microtask runs once per mutation BATCH, and
      // while a reply streams the browser emits a batch per token — and `scan()`
      // walks EVERY message row, so that was a full pass per token. The 60 ms
      // single-flight scheduler collapses a whole burst (streaming, a page switch,
      // a list re-render) into one scan, and the cheap guard keeps unrelated
      // mutations (tooltips, the composer, toasts) from scheduling anything.
      const touchesActionRows = (records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (!node || node.nodeType !== 1) continue
            try {
              if (node.matches && node.matches('div[data-clock="start"]')) return true
              if (node.closest && node.closest(HUMAN_FLOW)) return true
              if (node.querySelector && node.querySelector('div[data-clock="start"]')) return true
            } catch (e) {}
          }
        }
        return false
      }
      const observer = new MutationObserver((records) => {
        if (!touchesActionRows(records)) return
        scheduleMark(scan)
      })
      observer.observe(document.body, { childList: true, subtree: true })
      scan()
      return () => {
        observer.disconnect()
        // The scan sits on the SHARED scheduler, so unloading must drop that one
        // job: otherwise a queued pass could fire into a DOM this effect released.
        unqueueScheduledWork(scan)
      }
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

      // Re-arm the "hide 未分组" switch from its stored preference. `hideUngrouped`
      // is already seeded at module load, but the <html> attribute the style rule
      // reads is only set here, and setting it before the first `markRows` means
      // the bucket never flashes into view on a fresh start.
      try {
        if (hideUngrouped) document.documentElement.setAttribute("data-dsh-aff-hide-ungrouped", "1");
        else document.documentElement.removeAttribute("data-dsh-aff-hide-ungrouped");
      } catch (e) {}

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
              label: function () { return "归档助手"; },
            }, ArchiveFavoritesSection);
          });

          // 设置页导航图标：宿主对未注册 settings.section.icon 的分区一律回退成通用齿轮，
          // 看起来就是「图标和内容不符」。id 必须等于分区 id「archive-favorites」。
          function AffNavIcon(props) {
            var size = (props && props.size) || 16;
            var color = (props && props.active) ? "#2563eb" : "currentColor";
            return React.createElement(
              "svg",
              { width: size, height: size, viewBox: "0 0 16 16", fill: "none", stroke: color,
                strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
                "aria-hidden": "true", focusable: "false" },
              React.createElement("rect", { x: "2", y: "5.4", width: "12", height: "7.6", rx: "1.6" }),
              React.createElement("path", { d: "M1.6 5.4h12.8" }),
              React.createElement("path", { d: "M8 7.4v3.4" }),
              React.createElement("path", { d: "M6.5 9.4L8 10.9l1.5-1.5" })
            );
          }
          try {
            ctx.slots.inject("settings.section.icon", function () {
              return ctx.slots.register(
                { name: "settings.section.icon", id: "archive-favorites", order: 24, inject: function () { return {}; } },
                AffNavIcon
              );
            });
          } catch (e) { try { console.warn("[dsh-archive-favorites-forge] settings icon registration failed", e); } catch (e2) {} }
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
