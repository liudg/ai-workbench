(function () {
  if (window.__awBrowserBoot) return;
  window.__awBrowserBoot = true;

  function post(payload) {
    payload.channel = "aw-browser";
    try {
      if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(payload);
        return true;
      }
    } catch (err) {
      return false;
    }
    try {
      var invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
      if (!invoke) return false;
      if (payload.kind === "title") invoke("browser_page_title", { title: payload.title || "" });
      else if (payload.kind === "annotation") invoke("browser_annotation_submit", { note: payload.note });
      else invoke("browser_annotate_state", { kind: payload.kind, on: !!payload.on });
      return true;
    } catch (err) {
      return false;
    }
  }

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
      ".box{position:absolute;border:2px solid #38bdf8;background:rgba(56,189,248,.18);box-sizing:border-box;pointer-events:none;display:none}",
      ".pop{position:absolute;width:280px;box-sizing:border-box;background:#18181b;color:#fafafa;border:1px solid #3f3f46;border-radius:12px;padding:8px;pointer-events:auto;box-shadow:0 12px 40px rgba(0,0,0,.35);font:13px/1.4 sans-serif}",
      "textarea{display:block;width:100%;min-height:72px;box-sizing:border-box;margin:0;resize:vertical;border:1px solid #3f3f46;border-radius:8px;background:#09090b;color:#fafafa;padding:8px;font:inherit}",
      ".row{display:flex;justify-content:flex-end;gap:8px;margin-top:8px}",
      "button{border:0;border-radius:8px;padding:6px 10px;font:inherit;cursor:pointer}",
      ".cancel{background:transparent;color:#d4d4d8}",
      ".send{background:#fafafa;color:#09090b}",
      ".fail{position:absolute;left:12px;bottom:12px;background:#7f1d1d;color:#fee2e2;border-radius:8px;padding:6px 8px;pointer-events:none}",
      ".mark{position:absolute;width:18px;height:18px;border-radius:999px;background:#0284c7;color:#fff;font:11px/18px sans-serif;text-align:center;pointer-events:none}",
    ].join("");
    var blocker = document.createElement("div");
    blocker.className = "blocker";
    var box = document.createElement("div");
    box.className = "box";
    shadow.append(style, blocker, box);
    document.documentElement.appendChild(host);

    var mode = false;
    var suspended = false;
    var pop = null;
    var drag = null;
    var seq = 0;
    var pending = null;

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
      if (on) box.style.display = "none";
      post({ kind: "suspended", on: on });
    }

    function closePop() {
      if (pop) pop.remove();
      pop = null;
      pending = null;
    }

    function apply(on, fromHost) {
      mode = !!on;
      host.style.display = mode ? "block" : "none";
      blocker.style.pointerEvents = mode ? "auto" : "none";
      if (!mode) {
        closePop();
        box.style.display = "none";
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

    function placeBox(rect) {
      box.style.display = "block";
      box.style.left = rect.left + "px";
      box.style.top = rect.top + "px";
      box.style.width = Math.max(1, rect.width) + "px";
      box.style.height = Math.max(1, rect.height) + "px";
    }

    function openPop(note, anchor) {
      closePop();
      pending = note;
      pop = document.createElement("div");
      pop.className = "pop";
      var field = document.createElement("textarea");
      field.placeholder = "添加评论…";
      var row = document.createElement("div");
      row.className = "row";
      var cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "cancel";
      cancel.textContent = "取消";
      var send = document.createElement("button");
      send.type = "button";
      send.className = "send";
      send.textContent = "发送";
      row.append(cancel, send);
      pop.append(field, row);
      var left = Math.max(8, Math.min(anchor.left, window.innerWidth - 296));
      var top = Math.max(8, Math.min(anchor.top, window.innerHeight - 160));
      pop.style.left = left + "px";
      pop.style.top = top + "px";
      shadow.appendChild(pop);
      cancel.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        closePop();
      });
      send.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        note.comment = clip(field.value, 4000);
        if (!post({ kind: "annotation", note: note })) showFail();
        else {
          seq += 1;
          var mark = document.createElement("div");
          mark.className = "mark";
          mark.textContent = String(seq);
          mark.style.left = Math.max(0, note.x) + "px";
          mark.style.top = Math.max(0, note.y) + "px";
          shadow.appendChild(mark);
        }
        closePop();
      });
      field.addEventListener("keydown", function (event) {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closePop();
        }
        event.stopPropagation();
      });
      field.focus();
    }

    function noteForElement(el) {
      var rect = el.getBoundingClientRect();
      return {
        id: "ann-" + Date.now() + "-" + (seq + 1),
        url: String(location.href || ""),
        selector: cssPath(el),
        text: clip(el.innerText || el.textContent || "", 500),
        comment: "",
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        kind: "element",
      };
    }

    blocker.addEventListener("mousemove", function (event) {
      if (!mode || suspended || drag) return;
      var el = pageElement(event.clientX, event.clientY);
      if (!el) {
        box.style.display = "none";
        return;
      }
      placeBox(el.getBoundingClientRect());
    });
    blocker.addEventListener("mousedown", function (event) {
      if (!mode || suspended || event.button !== 0) return;
      if (pop && pop.contains(event.target)) return;
      event.preventDefault();
      closePop();
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
      });
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
        openPop({
          id: "ann-" + Date.now() + "-" + (seq + 1),
          url: String(location.href || ""),
          selector: "",
          text: "",
          comment: "",
          x: Math.round(left),
          y: Math.round(top),
          width: Math.round(width),
          height: Math.round(height),
          kind: "region",
        }, { left: left, top: top + height + 8 });
        return;
      }
      var el = pageElement(start.x, start.y);
      if (!el) return;
      var note = noteForElement(el);
      placeBox(el.getBoundingClientRect());
      openPop(note, { left: note.x, top: note.y + note.height + 8 });
    });
    window.addEventListener("keydown", function (event) {
      if (!mode) return;
      if (event.key === "Escape") {
        if (pop) return;
        if (event.target && event.target.tagName === "TEXTAREA") return;
        event.preventDefault();
        apply(false, false);
        return;
      }
      if (event.code === "Space" && !event.repeat) {
        if (event.target && (event.target.tagName === "TEXTAREA" || event.target.tagName === "INPUT")) return;
        event.preventDefault();
        setSuspended(true);
      }
    }, true);
    window.addEventListener("keyup", function (event) {
      if (event.code === "Space" && suspended) setSuspended(false);
    }, true);

    host.style.display = "none";
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
