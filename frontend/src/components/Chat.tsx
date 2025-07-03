import { useState, useRef, useEffect } from 'react';
import { FiSend, FiMessageCircle, FiCheckCircle, FiAlertTriangle, FiEye, FiX, FiUser } from 'react-icons/fi';
import { VscRobot } from 'react-icons/vsc';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../types';

interface ChatProps {
  messages: ChatMessage[];
  onSendMessage: (message: string) => void;
  isConnected: boolean;
  isEnabled: boolean;
}

export const Chat = ({ messages, onSendMessage, isConnected, isEnabled }: ChatProps) => {
  const [inputValue, setInputValue] = useState('');
  const [selectedMessage, setSelectedMessage] = useState<ChatMessage | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    if (isConnected) {
      scrollToBottom();
    }
  }, [messages, isConnected]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || !isEnabled) return;

    onSendMessage(inputValue.trim());
    setInputValue('');
    inputRef.current?.focus();
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const renderMessageContent = (message: ChatMessage) => {
    if (message.sender === 'agent') {
      return <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>;
    }
    
    return <span>{message.content}</span>;
  };

  const getMessageClasses = (sender: string) => {
    switch (sender) {
      case 'user':
        return 'message-user self-end';
      case 'agent':
        return 'message-agent self-start';
      case 'system':
        return 'message-system self-center';
      case 'error':
        return 'message-error self-start';
      default:
        return 'message-agent self-start';
    }
  };

  const renderIcon = (sender: string) => {
    switch (sender) {
      case 'user':
        return <FiUser className="w-6 h-6 text-white" />;
      case 'agent':
        return <VscRobot className="w-6 h-6 text-white" />;
      default:
        return <VscRobot className="w-6 h-6 text-white" />;
    }
  }

  return (
    <div className="card p-6 h-full flex flex-col animate-slide-up">
      <div className="flex items-center space-x-4 mb-4">
        <div className="w-14 h-14 icon-gradient-blue-green rounded-2xl flex items-center justify-center shadow-lg">
          <FiMessageCircle className="w-7 h-7 text-white" />
        </div>
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-text-primary tracking-wide">Live Chat</h2>
          <p className="text-sm text-text-secondary">Real-time validated messaging</p>
        </div>
        <div className="flex items-center space-x-2 text-sm text-text-secondary">
          <div className={`w-3 h-3 rounded-full animate-pulse ${isConnected ? 'bg-google-green' : 'bg-google-red'}`} />
          <span className="font-medium">
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 bg-background rounded-xl border border-border flex flex-col">
        <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-secondary">
              <div className="text-center animate-fade-in">
                <FiMessageCircle className="w-20 h-20 mx-auto mb-4 opacity-50" />
                <p className="font-medium text-lg">No Messages Yet</p>
                <p className="text-sm mt-1">Connect to an agent to start the conversation.</p>
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`flex items-start gap-4 ${message.sender === 'user' ? 'justify-end' : 'justify-start'} animate-fade-in`}
              >
                {message.sender !== 'user' && (
                  <div className="w-8 h-8 rounded-full icon-gradient-blue-green flex items-center justify-center flex-shrink-0">
                    {renderIcon(message.sender)}
                  </div>
                )}
                <div
                  className={`${getMessageClasses(message.sender)} cursor-pointer relative transition-all duration-200 ease-in-out`}
                  onClick={() => setSelectedMessage(message)}
                >
                  <div className="flex items-start space-x-3">
                    <div className="flex-1">
                      <div className="message-content prose prose-sm max-w-none text-text-primary dark:text-white">
                        {renderMessageContent(message)}
                      </div>
                      <div className="text-xs text-text-secondary mt-2">
                        {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    
                    {message.sender !== 'user' && (
                      <div className="flex items-center space-x-1 pt-1 text-text-secondary">
                        {message.validationErrors && message.validationErrors.length > 0 ? (
                          <div title={`${message.validationErrors.length} validation errors`}>
                            <FiAlertTriangle className="w-4 h-4 text-google-yellow" />
                          </div>
                        ) : (
                          <div title="Message is compliant">
                            <FiCheckCircle className="w-4 h-4 text-google-green" />
                          </div>
                        )}
                        <FiEye className="w-4 h-4" />
                      </div>
                    )}
                  </div>
                </div>
                {message.sender === 'user' && (
                  <div className="w-8 h-8 rounded-full icon-gradient-yellow-red flex items-center justify-center flex-shrink-0">
                    {renderIcon(message.sender)}
                  </div>
                )}
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="border-t border-border p-4">
          <form onSubmit={handleSubmit} className="flex items-center space-x-3">
            <input
              ref={inputRef}
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder={isEnabled ? "Send a message..." : "Connect to an agent to chat"}
              disabled={!isEnabled}
              className="flex-1 px-5 py-3 bg-background text-text-primary rounded-full border-2 border-border focus:outline-none focus:border-google-blue focus:bg-surface transition-all placeholder-text-secondary"
            />
            <button
              type="submit"
              disabled={!isEnabled || !inputValue.trim()}
              className="btn-primary p-3 rounded-full"
              aria-label="Send"
            >
              <FiSend className="w-6 h-6" />
            </button>
          </form>
        </div>
      </div>

      {/* JSON Modal */}
      {selectedMessage && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4 backdrop-blur-lg animate-fade-in"
          onClick={() => setSelectedMessage(null)}
        >
          <div
            className="card p-6 max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-border">
              <h3 className="text-lg font-bold text-text-primary">Raw Message</h3>
              <button
                onClick={() => setSelectedMessage(null)}
                className="text-text-secondary hover:text-text-primary transition-colors rounded-full p-1"
              >
                <FiX className="w-6 h-6" />
              </button>
            </div>
            <pre className="bg-background text-sm text-google-green p-4 rounded-lg overflow-auto flex-1 scrollbar-hide font-mono">
              {JSON.stringify(selectedMessage, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};