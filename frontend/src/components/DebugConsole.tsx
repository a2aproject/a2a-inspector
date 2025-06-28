import { useState, useRef, useEffect } from 'react';
import { FiTerminal, FiTrash2, FiChevronUp, FiChevronDown } from 'react-icons/fi';
import type { DebugLog } from '../types';

interface DebugConsoleProps {
  logs: DebugLog[];
  onClear: () => void;
}

export const DebugConsole = ({ logs, onClear }: DebugConsoleProps) => {
  const [isVisible, setIsVisible] = useState(false);
  const [height, setHeight] = useState(300);
  const [isResizing, setIsResizing] = useState(false);
  const consoleRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [logs]);

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsResizing(true);
    e.preventDefault();
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const newHeight = window.innerHeight - e.clientY;
      if (newHeight > 100 && newHeight < window.innerHeight * 0.8) {
        setHeight(newHeight);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ns-resize';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isResizing]);

  const getLogTypeColor = (type: string) => {
    switch (type) {
      case 'request':
        return 'border-google-blue';
      case 'response':
        return 'border-google-green';
      case 'error':
        return 'border-google-red';
      case 'validation_error':
        return 'border-google-yellow';
      default:
        return 'border-gray-400';
    }
  };

  const getLogTypeTextColor = (type: string) => {
    switch (type) {
      case 'request':
        return 'text-google-blue';
      case 'response':
        return 'text-google-green';
      case 'error':
        return 'text-google-red';
      case 'validation_error':
        return 'text-google-yellow';
      default:
        return 'text-gray-500';
    }
  };

  return (
    <div
      ref={consoleRef}
      className="fixed bottom-0 left-0 right-0 bg-surface/90 backdrop-blur-xl text-text-primary shadow-2xl z-40 border-t border-border transition-all duration-300"
      style={{ height: isVisible ? height : 56 }}
    >
      {/* Handle */}
      <div
        className="flex items-center justify-between px-4 h-14 bg-surface/80 cursor-ns-resize select-none"
        onMouseDown={handleMouseDown}
      >
        <div className="flex items-center space-x-3">
          <FiTerminal className="w-5 h-5 text-google-green" />
          <span className="font-bold text-text-primary tracking-wide">Debug Console</span>
          <span className="text-xs text-text-secondary bg-background px-2.5 py-1 rounded-full">
            {logs.length} logs
          </span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={onClear}
            className="p-2 text-text-secondary hover:bg-background rounded-full transition-colors"
            title="Clear logs"
          >
            <FiTrash2 className="w-5 h-5" />
          </button>
          
          <button
            onClick={() => setIsVisible(!isVisible)}
            className="p-2 text-text-secondary hover:bg-background rounded-full transition-colors"
            title={isVisible ? 'Collapse Console' : 'Expand Console'}
          >
            {isVisible ? <FiChevronDown className="w-6 h-6" /> : <FiChevronUp className="w-6 h-6" />}
          </button>
        </div>
      </div>

      {/* Content */}
      {isVisible && (
        <div
          ref={contentRef}
          className="h-full overflow-y-auto p-3 space-y-2 bg-background scrollbar-hide"
          style={{ height: height - 56 }}
        >
          {logs.length === 0 ? (
            <div className="flex items-center justify-center h-full text-text-secondary">
              <div className="text-center animate-fade-in">
                <FiTerminal className="w-12 h-12 mx-auto mb-3 opacity-50" />
                <p className="font-medium">No debug logs yet</p>
                <p className="text-sm mt-1">Logs will appear here as you interact with agents.</p>
              </div>
            </div>
          ) : (
            logs.map((log, index) => (
              <div
                key={`${log.id}-${log.type}-${index}`}
                className={`border-l-4 p-3 bg-surface rounded-r-lg animate-fade-in ${getLogTypeColor(log.type)}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center space-x-3">
                    <span className={`font-bold text-xs uppercase tracking-wider ${getLogTypeTextColor(log.type)}`}>
                      {log.type.replace('_', ' ')}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  </div>
                  <span className="text-xs text-text-secondary font-mono">
                    ID: {log.id}
                  </span>
                </div>
                
                <pre className="text-xs text-text-secondary whitespace-pre-wrap break-words font-mono bg-background p-3 rounded-md">
                  {JSON.stringify(log.data, null, 2)}
                </pre>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};