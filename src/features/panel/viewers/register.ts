import { registerViewer } from "../core/registry";
import { diffViewer } from "./diff";
import { filesViewer } from "./files";
import { htmlViewer } from "./html";
import { markdownViewer } from "./markdown";
import { textViewer } from "./text";

let registered = false;

export function registerBuiltinViewers() {
  if (registered) return;
  registered = true;
  registerViewer(htmlViewer);
  registerViewer(markdownViewer);
  registerViewer(textViewer);
  registerViewer(diffViewer);
  registerViewer(filesViewer);
}
