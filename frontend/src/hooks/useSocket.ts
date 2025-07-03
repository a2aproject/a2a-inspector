import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

export const useSocket = () => {
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Connect to the backend Socket.IO server via Vite proxy
    const socket = io({
      transports: ['websocket', 'polling'],
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setIsConnected(true);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
    });

    socket.on('connect_error', () => {
      setIsConnected(false);
    });

    return () => {
      socket.disconnect();
    };
  }, []);

  const emit = (event: string, data: unknown) => {
    if (socketRef.current?.connected) {
      socketRef.current.emit(event, data);
    } 
  };

  const on = <T>(event: string, callback: (data: T) => void) => {
    if (socketRef.current) {
      socketRef.current.on(event, callback as (data: unknown) => void);
      return () => socketRef.current?.off(event, callback as (data: unknown) => void);
    }
    return () => {};
  };

  const off = <T>(event: string, callback?: (data: T) => void) => {
    if (socketRef.current) {
      socketRef.current.off(event, callback as (data: unknown) => void);
    }
  };

  const connect = () => {
    if (socketRef.current && !socketRef.current.connected) {
      socketRef.current.connect();
    }
  }

  return {
    socket: socketRef.current,
    isConnected,
    emit,
    on,
    off,
    connect,
  };
};

export const useSocketEvent = <T = unknown>(
  socket: ReturnType<typeof useSocket>,
  event: string,
  callback: (data: T) => void
) => {
  useEffect(() => {
    if (!socket.socket) return;

    const cleanup = socket.on(event, callback);
    return cleanup;
  }, [socket, event, callback]);
};