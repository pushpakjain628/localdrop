import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('index.html is missing its #root element');
}

createRoot(container).render(<App />);
