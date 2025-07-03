import { useState } from 'react';
import { FiChevronDown, FiChevronRight, FiCheckCircle, FiAlertTriangle, FiCode, FiEye, FiX } from 'react-icons/fi';
import type { AgentCard as AgentCardType } from '../types';

interface AgentCardProps {
  agentCard: AgentCardType | null;
  validationErrors: string[];
  isVisible: boolean;
}

export const AgentCard = ({ agentCard, validationErrors, isVisible }: AgentCardProps) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [showRawJson, setShowRawJson] = useState(false);

  if (!isVisible || !agentCard) return null;

  const hasErrors = validationErrors.length > 0;

  return (
    <div className="card p-8 transition-all duration-300 animate-slide-up">
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex items-center space-x-4 text-left flex-1 group"
        >
          <div className="w-14 h-14 icon-gradient-yellow-red rounded-2xl flex items-center justify-center shadow-lg">
            <FiCode className="w-7 h-7 text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-bold text-text-primary tracking-wide">Agent Card</h2>
            <p className="text-sm text-text-secondary">
              {hasErrors ? `${validationErrors.length} validation errors` : 'Valid & Compliant'}
            </p>
          </div>
          <div className="text-text-secondary group-hover:text-text-primary transition-colors">
            {isExpanded ? <FiChevronDown className="w-6 h-6" /> : <FiChevronRight className="w-6 h-6" />}
          </div>
        </button>

        <div className="flex items-center space-x-2 text-sm font-medium">
          {hasErrors ? (
            <div className="flex items-center space-x-2 text-white bg-google-red/80 px-3 py-1 rounded-full">
              <FiAlertTriangle className="w-5 h-5" />
              <span>Issues Found</span>
            </div>
          ) : (
            <div className="flex items-center space-x-2 text-white bg-google-green/80 px-3 py-1 rounded-full">
              <FiCheckCircle className="w-5 h-5" />
              <span>Valid</span>
            </div>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="space-y-6 pt-6 border-t border-border animate-fade-in">
          {hasErrors && (
            <div className="bg-red-500/10 border border-google-red/30 rounded-lg p-4">
              <h3 className="font-bold text-google-red mb-2 flex items-center space-x-2">
                <FiAlertTriangle/>
                <span>Validation Errors</span>
              </h3>
              <ul className="space-y-1 pl-2">
                {validationErrors.map((error, index) => (
                  <li key={index} className="text-sm text-red-700 dark:text-red-300 list-disc list-inside">
                    {error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            <div className="space-y-4">
              <div>
                <label className="text-xs font-bold text-text-secondary uppercase tracking-wider">Name</label>
                <p className="text-text-primary font-medium text-lg">{agentCard.name}</p>
              </div>
              <div>
                <label className="text-xs font-bold text-text-secondary uppercase tracking-wider">Version</label>
                <p className="text-text-secondary">{agentCard.version}</p>
              </div>
              <div>
                <label className="text-xs font-bold text-text-secondary uppercase tracking-wider">URL</label>
                <p className="text-google-blue text-sm break-all hover:underline">
                  <a href={agentCard.url} target="_blank" rel="noopener noreferrer">{agentCard.url}</a>
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs font-bold text-text-secondary uppercase tracking-wider">Input Modes</label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {agentCard.defaultInputModes.map((mode, index) => (
                    <span key={index} className="px-3 py-1 bg-google-blue/20 text-google-blue text-xs rounded-full font-medium">
                      {mode}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-bold text-text-secondary uppercase tracking-wider">Output Modes</label>
                <div className="flex flex-wrap gap-2 mt-1">
                  {agentCard.defaultOutputModes.map((mode, index) => (
                    <span key={index} className="px-3 py-1 bg-google-green/20 text-google-green text-xs rounded-full font-medium">
                      {mode}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
          
          <div>
            <label className="text-xs font-bold text-text-secondary uppercase tracking-wider">Capabilities</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {Object.entries(agentCard.capabilities).map(([key, value]) => (
                <span
                  key={key}
                  className={`px-3 py-1 text-xs rounded-full font-medium flex items-center space-x-1.5 ${
                    value
                      ? 'bg-green-500/20 text-green-800 dark:text-green-300'
                      : 'bg-gray-500/20 text-gray-600 dark:text-gray-400'
                  }`}
                >
                  {value ? <FiCheckCircle className="w-3.5 h-3.5"/> : <FiX className="w-3.5 h-3.5"/>}
                  <span>{key}</span>
                </span>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-bold text-text-secondary uppercase tracking-wider">Description</label>
            <p className="text-text-secondary mt-1 text-base">{agentCard.description}</p>
          </div>

          <div className="flex items-center justify-between pt-6 border-t border-border">
            <span className="text-sm text-text-secondary font-medium">
              {agentCard.skills.length} skill{agentCard.skills.length !== 1 ? 's' : ''} available
            </span>
            <button
              onClick={() => setShowRawJson(!showRawJson)}
              className="flex items-center space-x-2 px-4 py-2 text-sm font-medium text-text-secondary bg-background hover:bg-border rounded-lg transition-colors"
            >
              <FiEye className="w-5 h-5" />
              <span>{showRawJson ? 'Hide' : 'Show'} Raw JSON</span>
            </button>
          </div>

          {showRawJson && (
            <div className="overflow-hidden rounded-lg border border-border animate-fade-in">
              <pre className="bg-background text-sm text-google-green p-4 overflow-x-auto scrollbar-hide font-mono">
                {JSON.stringify(agentCard, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
};