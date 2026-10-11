(function () {
  if (window.__awBrowserBoot) return;
  window.__awBrowserBoot = true;

  var outbound = [];
  var outboundMid = 1;
  function post(payload) {
    payload.channel = "aw-browser";
    payload.mid = outboundMid;
    outboundMid += 1;
    outbound.push(payload);
    try {
      if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(payload);
      }
    } catch (err) {}
    return true;
  }
  window.__awDrain = function () {
    if (!outbound.length) return [];
    var items = outbound;
    outbound = [];
    return items;
  };

  function reportTitle() {
    var title = "";
    try {
      title = document.title || "";
    } catch (err) {
      title = "";
    }
    post({ kind: "title", title: title });
  }

  function hookTitle() {
    var proto = Document.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, "title");
    if (!desc || !desc.set || desc.set.__aw) return;
    var orig = desc.set;
    function setTitle(value) {
      orig.call(this, value);
      if (this === document) reportTitle();
    }
    setTitle.__aw = true;
    Object.defineProperty(proto, "title", {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: setTitle,
    });
  }

  hookTitle();
  window.__awSetAnnotate = function (on, fromHost) {
    window.__awAnnotateWanted = !!on;
    if (window.__awApplyAnnotate) window.__awApplyAnnotate(!!on, !!fromHost);
  };

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return "";
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var name = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(name + "#" + cssEscape(node.id));
        break;
      }
      var parent = node.parentElement;
      if (parent) {
        var same = [];
        for (var i = 0; i < parent.children.length; i++) {
          if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
        }
        if (same.length > 1) name += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(name);
      node = parent;
      if (parts.length > 8) break;
    }
    return parts.join(" > ").slice(0, 500);
  }

  function clip(text, max) {
    text = String(text || "").replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max) : text;
  }

  function typingTarget(event) {
    var path = event.composedPath ? event.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var node = path[i];
      if (!node || !node.tagName) continue;
      if (node.tagName === "TEXTAREA" || node.tagName === "INPUT" || node.isContentEditable) return true;
    }
    return false;
  }

  function install() {
    if (window.__awBrowserInstalled || !document.documentElement) return;
    window.__awBrowserInstalled = true;
    var host = document.createElement("div");
    host.setAttribute("data-aw-annotate-root", "1");
    var shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = [
      ":host{all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none}",
      ".blocker{position:absolute;inset:0;pointer-events:auto;cursor:crosshair;background:transparent}",
      ".box{position:absolute;border:2px solid #2f6fed;background:transparent;box-sizing:border-box;pointer-events:none;display:none;border-radius:3px}",
      ".dot{position:absolute;width:18px;height:18px;margin-left:-9px;margin-top:-9px;border-radius:999px;background:#2f6fed;color:#fff;font:12px/18px 'Segoe UI',sans-serif;text-align:center;pointer-events:none;display:none;z-index:4}",
      ".hint{position:absolute;left:12px;top:12px;max-width:300px;background:#111;color:#fff;border-radius:12px;padding:8px 10px;font:13px/1.45 'Segoe UI',sans-serif;pointer-events:none;box-shadow:0 8px 24px rgba(0,0,0,.28)}",
      ".hint kbd{display:inline-block;margin:0 2px;padding:0 5px;border-radius:5px;background:#2c2c2c;border:1px solid #444;font:12px/18px 'Segoe UI',sans-serif}",
      ".editor{position:absolute;box-sizing:border-box;min-width:180px;background:#fff;color:#111;border-radius:14px;box-shadow:0 10px 28px rgba(0,0,0,.18);pointer-events:auto;display:flex;align-items:flex-end;gap:6px;padding:6px 8px 6px 6px;z-index:3;font:13px/1.4 'Segoe UI',sans-serif}",
      ".editor textarea{flex:1;min-width:0;border:0;resize:none;outline:none;background:transparent;color:#111;font:inherit;min-height:22px;max-height:160px;padding:2px 0;overflow:hidden}",
      ".editor textarea::placeholder{color:#9aa0a6}",
      ".handle{width:14px;height:22px;display:grid;grid-template-columns:4px 4px;gap:2px 3px;align-content:center;justify-content:center;cursor:grab;flex:none;padding:0;border:0;background:transparent}",
      ".handle i{width:3px;height:3px;border-radius:99px;background:#b0b6be;display:block}",
      ".actions{display:flex;gap:4px;align-items:center;flex:none}",
      ".mic{border:0;background:transparent;width:22px;height:22px;border-radius:99px;display:inline-flex;align-items:center;justify-content:center;padding:0;color:#6b7280}",
      ".check{border:0;background:#111;color:#fff;width:22px;height:22px;border-radius:99px;display:none;align-items:center;justify-content:center;padding:0;cursor:pointer}",
      ".fail{position:absolute;left:12px;bottom:12px;background:#7f1d1d;color:#fee2e2;border-radius:8px;padding:6px 8px;pointer-events:none;font:12px/1.4 sans-serif}",
    ].join("");
    var blocker = document.createElement("div");
    blocker.className = "blocker";
    var box = document.createElement("div");
    box.className = "box";
    var dot = document.createElement("div");
    dot.className = "dot";
    var hint = document.createElement("div");
    hint.className = "hint";
    hint.setAttribute("data-browser-annotate-hint", "1");
    hint.innerHTML = "点击任意位置即可添加批注，也可拖动选取区域。按住<kbd>空格键</kbd>时可暂时操作网页。";
    shadow.append(style, blocker, box, dot, hint);
    document.documentElement.appendChild(host);

    var mode = false;
    var suspended = false;
    var pop = null;
    var field = null;
    var check = null;
    var drag = null;
    var pending = null;
    var hintOn = true;

    function showFail() {
      var old = shadow.querySelector(".fail");
      if (old) old.remove();
      var node = document.createElement("div");
      node.className = "fail";
      node.textContent = "无法更新批注";
      shadow.appendChild(node);
      setTimeout(function () { node.remove(); }, 2400);
    }

    function setSuspended(on) {
      if (suspended === on) return;
      suspended = on;
      blocker.style.pointerEvents = mode && !on ? "auto" : "none";
      blocker.style.cursor = mode && !on ? "crosshair" : "auto";
      if (on) {
        box.style.display = "none";
        dot.style.display = "none";
      }
      post({ kind: "suspended", on: on });
    }

    function hideSelection() {
      box.style.display = "none";
      dot.style.display = "none";
      dot.textContent = "";
    }

    function closePop() {
      if (pop) pop.remove();
      pop = null;
      field = null;
      check = null;
      pending = null;
      hideSelection();
    }

    function apply(on, fromHost) {
      mode = !!on;
      host.style.display = mode ? "block" : "none";
      blocker.style.pointerEvents = mode ? "auto" : "none";
      hintOn = mode;
      hint.style.display = mode ? "block" : "none";
      if (!mode) {
        closePop();
        if (suspended) setSuspended(false);
      }
      if (!fromHost) post({ kind: "annotate", on: mode });
    }
    window.__awApplyAnnotate = apply;

    function pageElement(x, y) {
      blocker.style.pointerEvents = "none";
      var el = document.elementFromPoint(x, y);
      blocker.style.pointerEvents = mode && !suspended ? "auto" : "none";
      if (!el || el === host || host.contains(el)) return document.body;
      return el;
    }

    function placeBox(rect, numbered) {
      box.style.display = "block";
      box.style.left = rect.left + "px";
      box.style.top = rect.top + "px";
      box.style.width = Math.max(1, rect.width) + "px";
      box.style.height = Math.max(1, rect.height) + "px";
      dot.style.display = "block";
      dot.style.left = (rect.left + rect.width / 2) + "px";
      dot.style.top = rect.top + "px";
      dot.textContent = numbered ? "1" : "";
    }

    function growField() {
      if (!field || !check || !pop) return;
      field.style.height = "auto";
      field.style.height = Math.min(160, Math.max(22, field.scrollHeight)) + "px";
      var filled = field.value.trim().length > 0;
      check.style.display = filled ? "inline-flex" : "none";
    }

    function submitPop() {
      if (!pop || !pending || !field) return;
      var value = String(field.value || "").replace(/^\s+|\s+$/g, "");
      if (!value) return;
      if (value.length > 4000) value = value.slice(0, 4000);
      pending.comment = value;
      if (!post({ kind: "annotation", note: pending })) showFail();
      closePop();
    }

    function placeEditor(rect) {
      var dotX = rect.left + rect.width / 2;
      var left = dotX + 14;
      var room = window.innerWidth - left - 8;
      var width = Math.max(180, Math.min(Math.max(rect.width, 220), room));
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
      if (left < 8) left = 8;
      var top = rect.top - 18;
      if (top < 8) top = 8;
      pop.style.left = left + "px";
      pop.style.top = top + "px";
      pop.style.width = width + "px";
    }

    function openEditor(note, rect) {
      closePop();
      pending = note;
      hintOn = false;
      hint.style.display = "none";
      placeBox(rect, true);
      pop = document.createElement("div");
      pop.className = "editor";
      pop.setAttribute("data-browser-comment-editor", "1");
      var handle = document.createElement("button");
      handle.type = "button";
      handle.className = "handle";
      handle.setAttribute("aria-hidden", "true");
      handle.tabIndex = -1;
      for (var i = 0; i < 6; i++) handle.appendChild(document.createElement("i"));
      field = document.createElement("textarea");
      field.rows = 1;
      field.placeholder = "添加评论…";
      var actions = document.createElement("div");
      actions.className = "actions";
      var mic = document.createElement("button");
      mic.type = "button";
      mic.className = "mic";
      mic.tabIndex = -1;
      mic.setAttribute("aria-hidden", "true");
      mic.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4"/></svg>';
      check = document.createElement("button");
      check.type = "button";
      check.className = "check";
      check.setAttribute("data-browser-comment-submit", "1");
      check.title = "发送";
      check.setAttribute("aria-label", "发送");
      check.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12.5 10 17.5 19 7"/></svg>';
      actions.append(mic, check);
      pop.append(handle, field, actions);
      shadow.appendChild(pop);
      placeEditor(rect);
      handle.addEventListener("mousedown", function (event) {
        event.preventDefault();
        event.stopPropagation();
        var startX = event.clientX;
        var startY = event.clientY;
        var origLeft = parseFloat(pop.style.left) || 0;
        var origTop = parseFloat(pop.style.top) || 0;
        function move(ev) {
          pop.style.left = (origLeft + ev.clientX - startX) + "px";
          pop.style.top = (origTop + ev.clientY - startY) + "px";
        }
        function up() {
          window.removeEventListener("mousemove", move, true);
          window.removeEventListener("mouseup", up, true);
        }
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
      });
      mic.addEventListener("mousedown", function (event) {
        event.preventDefault();
      });
      check.addEventListener("mousedown", function (event) {
        event.preventDefault();
      });
      check.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        submitPop();
      });
      field.addEventListener("input", growField);
      field.focus();
    }

    function noteForElement(el) {
      var rect = el.getBoundingClientRect();
      return {
        id: "ann-" + Date.now(),
        url: String(location.href || ""),
        selector: cssPath(el),
        text: clip(el.innerText || el.textContent || "", 500),
        comment: "",
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(Math.max(1, rect.width)),
        height: Math.round(Math.max(1, rect.height)),
        kind: "element",
      };
    }

    blocker.addEventListener("mousemove", function (event) {
      if (!mode || suspended || drag || pop) return;
      var el = pageElement(event.clientX, event.clientY);
      if (!el) {
        hideSelection();
        return;
      }
      if (hintOn) {
        hintOn = false;
        hint.style.display = "none";
      }
      placeBox(el.getBoundingClientRect(), false);
    });
    blocker.addEventListener("mousedown", function (event) {
      if (!mode || suspended || event.button !== 0) return;
      if (pop) {
        event.preventDefault();
        closePop();
        return;
      }
      event.preventDefault();
      drag = { x: event.clientX, y: event.clientY, moved: false };
    });
    window.addEventListener("mousemove", function (event) {
      if (!drag) return;
      var w = event.clientX - drag.x;
      var h = event.clientY - drag.y;
      if (Math.abs(w) > 6 || Math.abs(h) > 6) drag.moved = true;
      if (!drag.moved) return;
      placeBox({
        left: Math.min(drag.x, event.clientX),
        top: Math.min(drag.y, event.clientY),
        width: Math.abs(w),
        height: Math.abs(h),
      }, false);
    });
    window.addEventListener("mouseup", function (event) {
      if (!drag || !mode) {
        drag = null;
        return;
      }
      var start = drag;
      drag = null;
      if (start.moved) {
        var left = Math.min(start.x, event.clientX);
        var top = Math.min(start.y, event.clientY);
        var width = Math.abs(event.clientX - start.x);
        var height = Math.abs(event.clientY - start.y);
        var rect = { left: left, top: top, width: width, height: height };
        openEditor({
          id: "ann-" + Date.now(),
          url: String(location.href || ""),
          selector: "",
          text: "",
          comment: "",
          x: Math.round(left),
          y: Math.round(top),
          width: Math.round(width),
          height: Math.round(height),
          kind: "region",
        }, rect);
        return;
      }
      var el = pageElement(start.x, start.y);
      if (!el) return;
      var note = noteForElement(el);
      openEditor(note, el.getBoundingClientRect());
    });
    window.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === "Period") {
        event.preventDefault();
        event.stopPropagation();
        apply(!mode, false);
        return;
      }
      if (!mode) return;
      if (event.key === "Escape") {
        if (pop) {
          event.preventDefault();
          event.stopPropagation();
          closePop();
          return;
        }
        if (typingTarget(event)) return;
        event.preventDefault();
        apply(false, false);
        return;
      }
      if (pop && event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
        if (event.repeat) return;
        event.preventDefault();
        event.stopPropagation();
        submitPop();
        return;
      }
      if (event.code === "Space" && !event.repeat && !typingTarget(event) && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        setSuspended(true);
      }
    }, true);
    window.addEventListener("keyup", function (event) {
      if (event.code === "Space" && suspended) setSuspended(false);
    }, true);

    host.style.display = "none";
    hint.style.display = "none";
    if (window.__awAnnotateWanted) apply(true, true);
    reportTitle();
    var titleNode = document.querySelector("title");
    if (titleNode && window.MutationObserver) {
      new MutationObserver(reportTitle).observe(titleNode, { childList: true, characterData: true, subtree: true });
    }
  }

  function start() {
    install();
    reportTitle();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
  window.addEventListener("load", function () {
    reportTitle();
    window.dispatchEvent(new Event("resize"));
  });
})();
