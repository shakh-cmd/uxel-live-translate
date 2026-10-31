import type { ClientMessage, ServerMessage } from "../shared/protocol";

export type LiveSocket = {
  send: (message: ClientMessage) => void;
  close: () => void;
  isOpen: () => boolean;
};

export function connectTour(
  url: string,
  hello: ClientMessage,
  onMessage: (message: ServerMessage) => void,
  onLink: (open: boolean) => void,
): LiveSocket {
  let socket: WebSocket | null = null;
  let closed = false;
  let delay = 600;
  let timer = 0;

  const open = () => {
    if (closed) return;
    socket = new WebSocket(url);
    socket.onopen = () => {
      delay = 600;
      socket?.send(JSON.stringify(hello));
      onLink(true);
    };
    socket.onmessage = (event) => {
      try {
        onMessage(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    socket.onclose = () => {
      onLink(false);
      if (!closed) timer = window.setTimeout(open, delay);
      delay = Math.min(8000, delay * 2);
    };
    socket.onerror = () => socket?.close();
  };
  open();

  return {
    send(message) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    close() {
      closed = true;
      window.clearTimeout(timer);
      socket?.close(1000, "leave");
    },
    isOpen: () => socket?.readyState === WebSocket.OPEN,
  };
}
