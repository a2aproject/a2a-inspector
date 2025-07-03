import { useTheme } from '../hooks/useTheme';
import { FiSun, FiMoon } from 'react-icons/fi';

export const ThemeSwitcher = () => {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      onClick={toggleTheme}
      className="p-2 rounded-full bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200"
    >
      {theme === 'light' ? <FiMoon className="w-4 h-4" aria-label="moon" /> : <FiSun className="w-4 h-4" aria-label="sun" />}
    </button>
  );
};