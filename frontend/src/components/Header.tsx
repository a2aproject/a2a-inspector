import { SiGithub } from 'react-icons/si';
import { ThemeSwitcher } from './ThemeSwitcher';
import { useTheme } from '../hooks/useTheme';

export const Header = () => {
  const { theme } = useTheme();

  return (
    <header className="bg-surface/80 backdrop-blur-lg sticky top-0 z-50 border-b border-border shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-20">
          <div className="flex items-center space-x-4">
            <img
              src={
                theme === 'dark'
                  ? "https://google.github.io/adk-docs/assets/agent-development-kit.png"
                  : "https://google.github.io/adk-docs/assets/agent-development-kit.png"
              }
              alt="A2A Logo"
              className="w-12 h-12"
            />
            <div>
              <h1 className="text-2xl font-bold text-text-primary tracking-wider">
                A2A Inspector
              </h1>
              <p className="text-sm text-text-secondary -mt-1">
                <span className="text-google-blue">G</span>
                <span className="text-google-red">o</span>
                <span className="text-google-yellow">o</span>
                <span className="text-google-blue">g</span>
                <span className="text-google-green">l</span>
                <span className="text-google-red">e</span>                
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-4">
              <a
                href="https://github.com/a2aproject/a2a-inspector"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center space-x-2"
              >
                <SiGithub size={28} />
                <span className="font-medium text-sm">GitHub</span>
              </a>
              <ThemeSwitcher />
              </div>
            </div>        
        </div>
      </header>
  );
};