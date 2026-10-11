import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canGoBack,
  canGoForward,
  currentEntry,
  displayFileAddress,
  emptyHistory,
  fileAddressFromAssetUrl,
  goBack,
  goForward,
  noteLoaded,
  pageTitleFromHtml,
  parseAddressInput,
  visit,
} from "./browser.ts";

test("file addresses use forward slashes", () => {
  assert.equal(
    displayFileAddress(String.raw`C:\Users\admin\Documents\Playground\tiger-leopard-bicycle.html`),
    "C:/Users/admin/Documents/Playground/tiger-leopard-bicycle.html",
  );
  assert.equal(
    fileAddressFromAssetUrl(
      "http://asset.localhost/C%3A/Users/admin/Documents/Playground/tiger-leopard-bicycle.html",
    ),
    "C:/Users/admin/Documents/Playground/tiger-leopard-bicycle.html",
  );
});

test("address bar accepts https, hosts, files, and search", () => {
  assert.deepEqual(parseAddressInput("https://example.com/a"), {
    kind: "navigate",
    address: "https://example.com/a",
    target: "https://example.com/a",
  });
  assert.equal(parseAddressInput("example.com").kind, "navigate");
  assert.equal(parseAddressInput("C:/work/demo/index.html").kind, "file");
  assert.equal(parseAddressInput("老虎").kind, "navigate");
  assert.equal(parseAddressInput("javascript:alert(1)").kind, "invalid");
  assert.equal(parseAddressInput("file:///C:/secret.html").kind, "invalid");
});

test("history back and forward stay on the visited pages", () => {
  let history = emptyHistory();
  history = visit(history, { address: "C:/demo/a.html", target: "http://asset.localhost/a" });
  history = visit(history, { address: "https://example.com/", target: "https://example.com/" });
  assert.equal(canGoBack(history), true);
  assert.equal(canGoForward(history), false);
  history = goBack(history);
  assert.equal(currentEntry(history)?.address, "C:/demo/a.html");
  assert.equal(canGoForward(history), true);
  history = goForward(history);
  assert.equal(currentEntry(history)?.target, "https://example.com/");
  history = goBack(history);
  history = visit(history, { address: "https://example.org/", target: "https://example.org/" });
  assert.equal(canGoForward(history), false);
  assert.equal(history.entries.length, 2);
});

test("loaded file url keeps the disk path in the address bar", () => {
  let history = visit(emptyHistory(), {
    address: "C:/demo/a.html",
    target: "http://asset.localhost/C%3A/demo/a.html",
  });
  history = noteLoaded(history, "http://asset.localhost/C%3A/demo/a.html");
  assert.equal(currentEntry(history)?.address, "C:/demo/a.html");
  history = noteLoaded(history, "https://example.com/moved");
  assert.equal(currentEntry(history)?.address, "https://example.com/moved");
  assert.equal(canGoBack(history), true);
});

test("page title comes from the title element", () => {
  assert.equal(
    pageTitleFromHtml("<html><head><title>虎豹自行车</title></head><body></body></html>"),
    "虎豹自行车",
  );
  assert.equal(pageTitleFromHtml("<p>no title</p>"), "");
  assert.equal(pageTitleFromHtml("<title>A &amp; B</title>"), "A & B");
});
