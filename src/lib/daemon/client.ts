// 和后台 daemon 的 WebSocket 连接。断线自动重连；重连后重新订阅之前订阅过的主题。
// 每次连接前都重新取一次地址：桌面版取地址时会顺便把没在跑的 daemon 拉起来。

export interface DaemonEndpoint {
  url: string;
  token: string;
}

export type ConnectionStatus = "connecting" | "online" | "offline";

/** 只用到 WebSocket 的这几样，测试里可以换成假的。 */
export interface SocketLike {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface ClientOptions {
  resolveEndpoint: () => Promise<DaemonEndpoint>;
  openSocket?: (url: string) => SocketLike;
  /** 第 n 次重试前等多久，毫秒。 */
  retryDelay?: (attempt: number) => number;
  callTimeoutMs?: number;
}

const OPEN = 1;

export const OFFLINE_MESSAGE = "没有连上后台服务";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type TopicListener = (data: unknown) => void;

export class DaemonClient {
  private readonly options: Required<ClientOptions>;
  private socket: SocketLike | null = null;
  private status: ConnectionStatus = "offline";
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();
  private readonly topics = new Map<string, Set<TopicListener>>();
  /** 每个主题最近一次收到的值。后加入的监听者先拿到它。 */
  private readonly latest = new Map<string, unknown>();
  private readonly pending = new Map<number, Pending>();
  /** 连上之前发起的调用，连上后按顺序发出。 */
  private readonly waiting: string[] = [];
  private nextId = 1;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  constructor(options: ClientOptions) {
    this.options = {
      openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
      retryDelay: (attempt) => Math.min(500 * 2 ** attempt, 5000),
      callTimeoutMs: 15000,
      ...options,
    };
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.close();
    this.socket = null;
    this.failPending(OFFLINE_MESSAGE);
    this.setStatus("offline");
  }

  getStatus() {
    return this.status;
  }

  onStatus(listener: (status: ConnectionStatus) => void) {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    const text = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(this.status === "online" ? "后台服务没有响应" : OFFLINE_MESSAGE));
      }, this.options.callTimeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      if (this.socket && this.socket.readyState === OPEN && this.status === "online") {
        this.socket.send(text);
      } else {
        this.waiting.push(text);
      }
    });
  }

  /** 订阅主题。先收到一份当前值，之后每次变化收到完整的新值。 */
  subscribe(topic: string, listener: TopicListener) {
    let listeners = this.topics.get(topic);
    if (!listeners) {
      listeners = new Set();
      this.topics.set(topic, listeners);
      if (this.status === "online") this.sendSubscribe(topic);
    }
    listeners.add(listener);
    if (this.latest.has(topic)) listener(this.latest.get(topic));
    return () => {
      const current = this.topics.get(topic);
      if (!current) return;
      current.delete(listener);
      if (current.size > 0) return;
      this.topics.delete(topic);
      this.latest.delete(topic);
      if (this.status === "online") {
        this.call("unsubscribe", { topic }).catch(() => {});
      }
    };
  }

  private async connect() {
    if (this.stopped) return;
    this.setStatus("connecting");
    let endpoint: DaemonEndpoint;
    try {
      endpoint = await this.options.resolveEndpoint();
    } catch {
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;
    const url = `${endpoint.url}?token=${encodeURIComponent(endpoint.token)}`;
    let socket: SocketLike;
    try {
      socket = this.options.openSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.setStatus("online");
      for (const topic of this.topics.keys()) this.sendSubscribe(topic);
      for (const text of this.waiting.splice(0)) socket.send(text);
    };
    socket.onmessage = (event) => {
      if (this.socket === socket) this.handle(event.data);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending("和后台服务的连接断开了");
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    if (this.stopped) return;
    this.setStatus("offline");
    const delay = this.options.retryDelay(this.attempt++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private sendSubscribe(topic: string) {
    this.call("subscribe", { topic }).catch(() => {});
  }

  private handle(raw: unknown) {
    if (typeof raw !== "string") return;
    let message: { id?: number; result?: unknown; error?: { message?: string }; topic?: string; data?: unknown };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof message.topic === "string") {
      if (!this.topics.has(message.topic)) return;
      this.latest.set(message.topic, message.data);
      for (const listener of this.topics.get(message.topic) ?? []) listener(message.data);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || "后台服务出错"));
    else pending.resolve(message.result ?? null);
  }

  /** 已经发出去的调用随连接一起失败；还没发出的留到重连后再发。 */
  private failPending(reason: string) {
    const queued = new Set(this.waiting.map((text) => (JSON.parse(text) as { id: number }).id));
    for (const [id, pending] of this.pending) {
      if (queued.has(id)) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
