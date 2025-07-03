import { useState, useEffect, useCallback, useRef } from 'react';
import { useSocket, useSocketEvent } from './hooks/useSocket';
import { Header } from './components/Header';
import { ConnectionForm } from './components/ConnectionForm';
import { AgentCard } from './components/AgentCard';
import { Chat } from './components/Chat';
import { DebugConsole } from './components/DebugConsole';
import type { 
  AgentResponseEvent, 
  DebugLog, 
  ChatMessage, 
  ConnectionState, 
  CustomHeaders
} from './types';

function App() {
  const socket = useSocket();
  const mainRef = useRef<HTMLDivElement>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>({
    isConnected: false,
    isConnecting: false,
    agentCard: null,
    validationErrors: [],
    error: null,
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [debugLogs, setDebugLogs] = useState<DebugLog[]>([]);
  const [contextId, setContextId] = useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{ url: string; headers: CustomHeaders } | null>(null);

  const proceedWithConnection = useCallback(async (url: string, headers: CustomHeaders) => {
    if (!socket.socket) return;

    setConnectionState(prev => ({ ...prev, isConnecting: true, error: null }));
    setMessages([]);
    setDebugLogs([]);

    try {
      const response = await fetch('/agent-card', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ url, sid: socket.socket.id }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP error! status: ${response.status}`);

      setConnectionState(prev => ({
        ...prev,
        agentCard: data.card,
        validationErrors: data.validation_errors || [],
      }));

      socket.emit('initialize_client', { url, customHeaders: headers });
    } catch (error) {
      setConnectionState(prev => ({
        ...prev,
        isConnecting: false,
        error: (error as Error).message,
      }));
    }
  }, [socket]);

  useEffect(() => {
    if (socket.isConnected && pendingConnection) {
      proceedWithConnection(pendingConnection.url, pendingConnection.headers);
      setPendingConnection(null);
    }
  }, [socket.isConnected, pendingConnection, proceedWithConnection]);

  // Handle connection to agent
  const handleConnect = useCallback(async (url: string, headers: CustomHeaders) => {
    if (!socket.socket) return;

    if (!socket.socket.connected) {
      setPendingConnection({ url, headers });
      socket.connect();
    } else {
      proceedWithConnection(url, headers);
    }
  }, [socket, proceedWithConnection]);

  // Handle sending messages
  const handleSendMessage = useCallback((messageText: string) => {
    if (!socket.socket || !connectionState.isConnected) return;

    const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    
    // Add user message to chat
    const userMessage: ChatMessage = {
      id: messageId,
      sender: 'user',
      content: messageText,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMessage]);

    // Send to backend
    socket.emit('send_message', {
      message: messageText,
      id: messageId,
      contextId,
    });
  }, [socket, connectionState.isConnected, contextId]);

  const handleDisconnect = useCallback(() => {
    if (!socket.socket || !connectionState.isConnected) return;

    socket.socket.disconnect();

    setConnectionState({
      isConnected: false,
      isConnecting: false,
      agentCard: null,
      validationErrors: [],
      error: null,
    });
    setMessages([]);
    setDebugLogs([]);
    setContextId(null);
  }, [socket, connectionState.isConnected]);

  // Socket event handlers
  const handleClientInitialized = useCallback((data: { status: string; message?: string }) => {
    if (data.status === 'success') {
      setConnectionState(prev => ({
        ...prev,
        isConnected: true,
        isConnecting: false,
        error: null,
      }));
      
      const systemMessage: ChatMessage = {
        id: `system-${Date.now()}`,
        sender: 'system',
        content: 'Connected to agent. Ready to chat!',
        timestamp: new Date(),
      };
      setMessages([systemMessage]);
    } else {
      setConnectionState(prev => ({
        ...prev,
        isConnecting: false,
        error: data.message || 'Failed to initialize client',
      }));
    }
  }, []);
  useSocketEvent(socket, 'client_initialized', handleClientInitialized);

  const handleAgentResponse = useCallback((event: AgentResponseEvent) => {
    if (event.contextId) {
      setContextId(event.contextId);
    }

    const messageId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    
    if (event.error) {
      const errorMessage: ChatMessage = {
        id: messageId,
        sender: 'error',
        content: `Error: ${event.error}`,
        timestamp: new Date(),
        validationErrors: event.validation_errors,
        kind: 'error',
      };
      setMessages(prev => [...prev, errorMessage]);
      return;
    }

    let content = '';

    switch (event.kind) {
      case 'task':
        if (event.status) {
          content = `Task created with status: ${event.status.state}`;
        }
        break;
      
      case 'status-update': {
        const statusText = event.status?.message?.parts?.[0]?.text;
        if (statusText) {
          content = statusText;
        }
        break;
      }
      
      case 'artifact-update':
        event.artifact?.parts?.forEach(part => {
          if ('text' in part && part.text) {
            content += part.text;
          } else if ('file' in part && part.file) {
            const { uri, mimeType } = part.file;
            content += `File received (${mimeType}): [Open Link](${uri})`;
          } else if ('data' in part && part.data) {
            content += `\`\`\`json\n${JSON.stringify(part.data, null, 2)}\n\`\`\``;
          }
        });
        break;
      
      case 'message': {
        const textPart = event.parts?.find(p => p.text);
        if (textPart && textPart.text) {
          content = textPart.text;
        }
        break;
      }
    }

    if (content) {
      const agentMessage: ChatMessage = {
        id: messageId,
        sender: 'agent',
        content: content,
        timestamp: new Date(),
        validationErrors: event.validation_errors,
        kind: event.kind,
      };
      setMessages(prev => [...prev, agentMessage]);
    }
  }, []);
  useSocketEvent(socket, 'agent_response', handleAgentResponse);

  const handleDebugLog = useCallback((log: DebugLog) => {
    setDebugLogs(prev => [...prev, log]);
  }, []);
  useSocketEvent(socket, 'debug_log', handleDebugLog);

  const clearDebugLogs = () => {
    setDebugLogs([]);
  };

  return (
    <div ref={mainRef} className="min-h-screen bg-background text-text-primary">
      <Header />
      
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 pb-20">
        <div className="space-y-8">
          {/* Connection Form */}
          <ConnectionForm
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            isConnecting={connectionState.isConnecting}
            isConnected={connectionState.isConnected}
          />

          {/* Error Display */}
          {connectionState.error && (
            <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded-lg">
              <div className="flex items-center space-x-3">
                <div className="w-8 h-8 bg-red-500 rounded-lg flex items-center justify-center">
                  <span className="text-white text-sm font-bold">!</span>
                </div>
                <div>
                  <h3 className="font-medium text-red-800">Connection Error</h3>
                  <p className="text-red-700">{connectionState.error}</p>
                </div>
              </div>
            </div>
          )}

          {/* Agent Card */}
          <AgentCard
            agentCard={connectionState.agentCard}
            validationErrors={connectionState.validationErrors}
            isVisible={!!connectionState.agentCard}
          />

          {/* Chat */}
          <div className="h-[600px]">
            <Chat
              messages={messages}
              onSendMessage={handleSendMessage}
              isConnected={connectionState.isConnected}
              isEnabled={connectionState.isConnected && !connectionState.isConnecting}
            />
          </div>
        </div>
      </main>
      <DebugConsole logs={debugLogs} onClear={clearDebugLogs} />
    </div>
  );
}

export default App;
