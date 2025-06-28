import { useState, useRef, useMemo } from 'react';
import { FiPlus, FiX, FiChevronDown, FiChevronRight, FiSettings, FiZap, FiCheck } from 'react-icons/fi';
import { VscRobot } from "react-icons/vsc";
import type { HeaderItem, CustomHeaders } from '../types';

interface ConnectionFormProps {
  onConnect: (url: string, headers: CustomHeaders) => void;
  onDisconnect: () => void;
  isConnecting: boolean;
  isConnected: boolean;
}

export const ConnectionForm = ({ onConnect, onDisconnect, isConnecting, isConnected }: ConnectionFormProps) => {
  const [agentUrl, setAgentUrl] = useState('');
  const [headers, setHeaders] = useState<HeaderItem[]>([]);
  const [showHeaders, setShowHeaders] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const isValidUrl = useMemo(() => {
    if (!agentUrl.trim()) return false;
    try {
      const url = new URL(agentUrl.startsWith('http') ? agentUrl : `http://${agentUrl}`);
      return url.hostname.includes('.');
    } catch {
      return false;
    }
  }, [agentUrl]);

  const addHeader = () => {
    setHeaders([...headers, { id: Date.now().toString(), name: '', value: '' }]);
  };

  const removeHeader = (id: string) => {
    setHeaders(headers.filter(h => h.id !== id));
  };

  const updateHeader = (id: string, field: 'name' | 'value', value: string) => {
    setHeaders(headers.map(h => h.id === id ? { ...h, [field]: value } : h));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidUrl) return;

    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    let url = agentUrl.trim();
    if (!/^https?:\/\//i.test(url)) {
      url = 'http://' + url;
    }

    const customHeaders: CustomHeaders = {};
    headers.forEach(header => {
      if (header.name.trim() && header.value.trim()) {
        customHeaders[header.name.trim()] = header.value.trim();
      }
    });

    onConnect(url, customHeaders);
  };

  return (
    <div className="card p-8 animate-slide-up">
      <div className="flex items-center space-x-4 mb-8">
        <div className="w-14 h-14 icon-gradient-blue-green rounded-2xl flex items-center justify-center shadow-lg">
          <VscRobot className="w-7 h-7 text-white" />
        </div>
        <h2 className="text-2xl font-bold text-text-primary tracking-wide">Connect to Agent</h2>
      </div>

      <form ref={formRef} onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label htmlFor="agent-url" className="block text-sm font-medium text-text-secondary mb-2">
            Agent Card URL
          </label>
          <div className="relative">
            <input
              type="text"
              id="agent-url"
              value={agentUrl}
              onChange={(e) => setAgentUrl(e.target.value)}
              placeholder="Enter Agent URL to connect"
              className="w-full pl-4 pr-10 py-3 bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg border-2 border-gray-300 dark:border-gray-600 focus:outline-none focus:border-google-blue focus:ring-2 focus:ring-google-blue/50 transition-all placeholder-gray-500 dark:placeholder-gray-400"
              disabled={isConnecting}
            />
          </div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowHeaders(!showHeaders)}
            className="flex items-center space-x-2 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
          >
            <FiSettings className="w-5 h-5" />
            <span>Advanced: HTTP Headers</span>
            {showHeaders ? <FiChevronDown className="w-5 h-5" /> : <FiChevronRight className="w-5 h-5" />}
          </button>

          {showHeaders && (
            <div className="mt-4 space-y-3 p-4 bg-surface rounded-lg animate-fade-in">
              {headers.map((header) => (
                <div key={header.id} className="flex space-x-2 items-center">
                  <input
                    type="text"
                    placeholder="Header Name"
                    value={header.name}
                    onChange={(e) => updateHeader(header.id, 'name', e.target.value)}
                    className="flex-1 px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-md border border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-google-blue placeholder-gray-500 dark:placeholder-gray-400"
                  />
                  <input
                    type="text"
                    placeholder="Header Value"
                    value={header.value}
                    onChange={(e) => updateHeader(header.id, 'value', e.target.value)}
                    className="flex-1 px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white rounded-md border border-gray-300 dark:border-gray-600 focus:outline-none focus:ring-1 focus:ring-google-blue placeholder-gray-500 dark:placeholder-gray-400"
                  />
                  <button
                    type="button"
                    onClick={() => removeHeader(header.id)}
                    className="p-2 text-text-secondary rounded-full hover:bg-red-500/20 hover:text-google-red transition-colors"
                  >
                    <FiX className="w-4 h-4" />
                  </button>
                </div>
              ))}

              <button
                type="button"
                onClick={addHeader}
                className="flex items-center space-x-2 text-sm font-medium text-google-green hover:text-google-green/80"
              >
                <FiPlus className="w-4 h-4" />
                <span>Add Header</span>
              </button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end pt-6 space-x-4">
          {isConnected && (
            <button
              type="button"
              onClick={onDisconnect}
              className="btn-danger flex items-center justify-center"
            >
              <FiX className="w-6 h-6 mr-2" />
              <span>Disconnect</span>
            </button>
          )}
          <button
            type="submit"
            disabled={isConnecting || !isValidUrl || isConnected}
            className="btn-primary w-full flex items-center justify-center"
          >
            {isConnecting ? (
              <>
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-3"></div>
                <span>Connecting...</span>
              </>
            ) : isConnected ? (
              <>
                <FiCheck className="w-6 h-6 mr-2" />
                <span>Connected</span>
              </>
            ) : (
              <>
                <FiZap className="w-6 h-6 mr-2" />
                <span>Connect Now</span>
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};