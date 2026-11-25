import {
  CHANNEL_EVENTS as E,
  HOST_METHODS_V3 as M,
  type ContentMessageEvent,
  type StreamFetchRequest,
  type StreamHead,
  type WsConnectParams,
} from "./protocol";
import { PluginError, type Rpc } from "./rpc";
import { addTo, type Disposable } from "./types";

export type AbortSignalLike = {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
};

export type StreamResponse = StreamHead & {
  ok: boolean;
  body: AsyncIterable<string>;
  text(): Promise<string>;
  cancel(): Promise<void>;
};

export type StreamFetchInit = Omit<StreamFetchRequest, "url"> & { signal?: AbortSignalLike };

export type SocketState = "connecting" | "open" | "closing" | "closed";

export type PluginSocket = {
  readonly id: string;
  readonly url: string;
  readonly protocol: string;
  readonly state: SocketState;
  send(data: string): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
  onMessage(listener: (data: string, binary: boolean) => void): Disposable;
  onClose(listener: (code: number, reason: string) => void): Disposable;
  onError(listener: (message: string) => void): Disposable;
};

export type ConnectOptions = { protocols?: string[]; headers?: Record<string, string>; signal?: AbortSignalLike };

type Waiting = { resolve: (result: IteratorResult<string>) => void; reject: (error: unknown) => void };

type Stream = { push(data: string): void; end(): void; fail(error: unknown): void };

type Socket = { opened(protocol: string): void; message(data: string, binary: boolean): void; closed(code: number, reason: string): void; failed(message: string): void };

const abortError = (signal: AbortSignalLike) =>
  signal.reason instanceof Error ? signal.reason : new PluginError("aborted", typeof signal.reason === "string" ? signal.reason : "The request was aborted.");

const MAX_BUFFERED_CHUNKS = 4096;

function chunkQueue(onDone: () => void) {
  const buffered: string[] = [];
  const readers: Waiting[] = [];
  let ended = false;
  let failure: unknown = null;
  const close = () => {
    ended = true;
    onDone();
  };
  const queue = {
    push(data: string) {
      if (ended) return;
      const reader = readers.shift();
      if (reader) reader.resolve({ value: data, done: false });
      else if (buffered.length < MAX_BUFFERED_CHUNKS) buffered.push(data);
      else queue.fail(new PluginError("overflow", "The stream sent more than the plugin read; it was cut off."));
    },
    end() {
      if (ended) return;
      close();
      if (!buffered.length) for (const reader of readers.splice(0)) reader.resolve({ value: undefined, done: true });
    },
    fail(error: unknown) {
      if (ended) return;
      failure = error;
      buffered.length = 0;
      close();
      for (const reader of readers.splice(0)) reader.reject(error);
    },
    next(): Promise<IteratorResult<string>> {
      const value = buffered.shift();
      if (value !== undefined) return Promise.resolve({ value, done: false });
      if (failure) return Promise.reject(failure);
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise<IteratorResult<string>>((resolve, reject) => readers.push({ resolve, reject }));
    },
    get ended() {
      return ended;
    },
  };
  return queue;
}

export type Channels = ReturnType<typeof createChannels>;

export function createChannels(rpc: Rpc, report: (error: unknown) => void) {
  const streams = new Map<string, Stream>();
  const sockets = new Map<string, Socket>();
  const sidecarListeners = new Set<(message: unknown) => void>();
  const contentListeners = new Set<(event: ContentMessageEvent) => void>();
  let next = 0;

  const safely = (listener: () => void) => {
    try {
      listener();
    } catch (error) {
      report(error);
    }
  };

  function deliver(name: string, data: Record<string, unknown>): boolean {
    const stream = typeof data.stream === "string" ? streams.get(data.stream) : undefined;
    const socket = typeof data.socket === "string" ? sockets.get(data.socket) : undefined;
    switch (name) {
      case E.fetchChunk:
        if (typeof data.data === "string") stream?.push(data.data);
        return true;
      case E.fetchEnd:
        stream?.end();
        return true;
      case E.fetchError:
        stream?.fail(new PluginError(typeof data.code === "string" ? data.code : "failed", typeof data.message === "string" ? data.message : "The stream failed."));
        return true;
      case E.wsOpen:
        socket?.opened(typeof data.protocol === "string" ? data.protocol : "");
        return true;
      case E.wsMessage:
        if (typeof data.data === "string") socket?.message(data.data, data.binary === true);
        return true;
      case E.wsClose:
        socket?.closed(typeof data.code === "number" ? data.code : 1006, typeof data.reason === "string" ? data.reason : "");
        return true;
      case E.wsError:
        socket?.failed(typeof data.message === "string" ? data.message : "The connection failed.");
        return true;
      case E.sidecarMessage:
        for (const listener of [...sidecarListeners]) safely(() => listener(data.message));
        return true;
      case E.contentMessage:
        if (typeof data.tabId === "string") {
          const event: ContentMessageEvent = { tabId: data.tabId, message: data.message };
          if (typeof data.frameId === "number") event.frameId = data.frameId;
          if (typeof data.scriptId === "string") event.scriptId = data.scriptId;
          for (const listener of [...contentListeners]) safely(() => listener(event));
        }
        return true;
      default:
        return false;
    }
  }

  async function fetchStream(input: string | (StreamFetchRequest & { signal?: AbortSignalLike }), init: StreamFetchInit = {}): Promise<StreamResponse> {
    const { signal, ...request } = typeof input === "string" ? { ...init, url: input } : { ...input, ...init };
    if (signal?.aborted) throw abortError(signal);
    const id = `f${++next}`;
    let cancelled = false;
    const queue = chunkQueue(() => {
      streams.delete(id);
      signal?.removeEventListener("abort", onAbort);
    });
    const cancel = async () => {
      if (cancelled || queue.ended) return;
      cancelled = true;
      queue.end();
      streams.delete(id);
      await rpc.request(M.fetchCancel, { stream: id }).then(undefined, report);
    };
    let rejectHead: ((error: unknown) => void) | null = null;
    function onAbort() {
      const error = abortError(signal!);
      queue.fail(error);
      rejectHead?.(error);
      if (!cancelled) {
        cancelled = true;
        void rpc.request(M.fetchCancel, { stream: id }).then(undefined, report);
      }
    }
    streams.set(id, queue);
    signal?.addEventListener("abort", onAbort, { once: true });
    const head = await new Promise<StreamHead>((resolve, reject) => {
      rejectHead = reject;
      rpc.request<StreamHead>(M.fetchStream, { ...request, stream: id }).then(resolve, (error) => {
        queue.fail(error);
        reject(error);
      });
    });
    rejectHead = null;
    let consumed = false;
    const body: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        if (consumed) throw new PluginError("used", "A stream's body can be read once.");
        consumed = true;
        return {
          next: () => queue.next(),
          return: async () => {
            await cancel();
            return { value: undefined, done: true };
          },
        };
      },
    };
    return {
      status: head.status,
      statusText: head.statusText ?? "",
      headers: head.headers ?? {},
      url: head.url ?? request.url,
      ok: head.status >= 200 && head.status < 300,
      body,
      async text() {
        let out = "";
        for await (const chunk of body) out += chunk;
        return out;
      },
      cancel,
    };
  }

  function connect(url: string, options: ConnectOptions = {}): Promise<PluginSocket> {
    const id = `w${++next}`;
    const listeners = { message: new Set<(data: string, binary: boolean) => void>(), close: new Set<(code: number, reason: string) => void>(), error: new Set<(message: string) => void>() };
    let state: SocketState = "connecting";
    let protocol = "";
    let settle: { resolve: () => void; reject: (error: unknown) => void } | null = null;
    const forget = () => {
      sockets.delete(id);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const socket: PluginSocket = {
      id,
      url,
      get protocol() {
        return protocol;
      },
      get state() {
        return state;
      },
      send: (data) => {
        if (state !== "open") return Promise.reject(new PluginError("closed", "The socket isn't open."));
        return rpc.request(M.wsSend, { socket: id, data }).then(() => undefined);
      },
      close: (code = 1000, reason = "") => {
        if (state === "closed" || state === "closing") return Promise.resolve();
        state = "closing";
        return rpc.request(M.wsClose, { socket: id, code, reason }).then(() => undefined);
      },
      onMessage: (listener) => addTo(listeners.message, listener),
      onClose: (listener) => addTo(listeners.close, listener),
      onError: (listener) => addTo(listeners.error, listener),
    };
    sockets.set(id, {
      opened(given) {
        if (state !== "connecting") return;
        state = "open";
        protocol = given;
        settle?.resolve();
      },
      message(data, binary) {
        for (const listener of [...listeners.message]) safely(() => listener(data, binary));
      },
      closed(code, reason) {
        state = "closed";
        forget();
        settle?.reject(new PluginError("closed", reason || `The socket closed (${code}) before it opened.`));
        for (const listener of [...listeners.close]) safely(() => listener(code, reason));
      },
      failed(message) {
        settle?.reject(new PluginError("failed", message));
        for (const listener of [...listeners.error]) safely(() => listener(message));
      },
    });
    function onAbort() {
      settle?.reject(abortError(options.signal!));
      void socket.close(1000, "aborted").catch(report);
    }
    if (options.signal?.aborted) {
      forget();
      return Promise.reject(abortError(options.signal));
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const params: WsConnectParams = { socket: id, url, ...(options.protocols ? { protocols: options.protocols } : {}), ...(options.headers ? { headers: options.headers } : {}) };
    return new Promise<PluginSocket>((resolve, reject) => {
      settle = {
        resolve: () => {
          settle = null;
          resolve(socket);
        },
        reject: (error) => {
          settle = null;
          reject(error);
        },
      };
      rpc.request<{ protocol?: string; open?: boolean }>(M.wsConnect, { ...params }).then(
        (reply) => {
          if (reply && reply.open === true) sockets.get(id)?.opened(typeof reply.protocol === "string" ? reply.protocol : "");
        },
        (error) => {
          state = "closed";
          forget();
          settle?.reject(error);
        },
      );
    });
  }

  return {
    deliver,
    fetchStream,
    connect,
    onSidecarMessage: (listener: (message: unknown) => void): Disposable => addTo(sidecarListeners, listener),
    onContentMessage: (listener: (event: ContentMessageEvent) => void): Disposable => addTo(contentListeners, listener),
    openCount: () => streams.size + sockets.size,
    closeAll() {
      const error = new PluginError("stopped", "The plugin stopped.");
      for (const stream of [...streams.values()]) stream.fail(error);
      for (const socket of [...sockets.values()]) socket.closed(1001, "The plugin stopped.");
      streams.clear();
      sockets.clear();
      sidecarListeners.clear();
      contentListeners.clear();
    },
  };
}
