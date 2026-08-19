import React, { useState } from 'react';
import Login from './pages/Login';
import BankPortal from './pages/BankPortal';
import './index.css';

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('bank_token'));

  const handleLogin = (t: string) => {
    localStorage.setItem('bank_token', t);
    setToken(t);
  };

  const handleLogout = () => {
    localStorage.removeItem('bank_token');
    setToken(null);
  };

  if (!token) return <Login onLogin={handleLogin} />;

  return (
    <div>
      <nav style={{
        background: '#1a237e', color: 'white', padding: '0.75rem 1.5rem',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between'
      }}>
        <span style={{ fontWeight: 700, fontSize: '1.1rem' }}>Demo Bank — Identity Verification</span>
        <button onClick={handleLogout} style={{
          background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
          color: 'white', padding: '0.35rem 0.9rem', borderRadius: 4, cursor: 'pointer'
        }}>Logout</button>
      </nav>
      <main style={{ maxWidth: 560, margin: '2rem auto', padding: '0 1rem' }}>
        <BankPortal token={token} />
      </main>
    </div>
  );
}
