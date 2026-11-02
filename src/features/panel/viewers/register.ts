import { registerViewer } from "../core/registry";
import { diffViewer } from "./diff";
import { filesViewer } from "./files";
import { htmlViewer } from "./html";
import { imageViewer } from "./image";
import { markdownViewer } from "./markdown";
import { terminalViewer } from "./terminal";
import { textViewer } from "./text";

let registered = false;

export function registerBuiltinViewers() {
  if (registered) return;
  registered = true;
  registerViewer(htmlViewer);
  registerViewer(markdownViewer);
  registerViewer(imageViewer);
  registerViewer(textViewer);
  registerViewer(diffViewer);
  registerViewer(filesViewer);
  registerViewer(terminalViewer);
}
