// 只装面板界面状态的独立 store。任务视图用它，旧工作区的面板状态还在旧 store 里。

import { create } from "zustand";

import { createPanelSlice, type PanelSlice } from "./slice.ts";

export const usePanelStore = create<PanelSlice>()((set, get) => createPanelSlice(set, get));
