import React, { useState } from 'react';
import axios from 'axios';

const API = process.env.REACT_APP_API_URL ?? 'http://localhost:3000';

interface Props { onLogin: (token: string) => void; }

export default function Login({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await axios.post<{ token: string; role: string }>(
        `${API}/api/auth/login`, { username, password }
      );
      if (data.role !== 'bank') { setError('Access denied: bank credentials required'); return; }
      onLogin(data.token);
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f0f4ff' }}>
      <div style={{ background: 'white', padding: '2.5rem', borderRadius: 10, boxShadow: '0 4px 20px rgba(0,0,0,0.1)', width: 340 }}>
        <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '2.5rem' }}>🏦</div>
          <h2 style={{ margin: '0.5rem 0 0', color: '#1a237e' }}>Demo Bank</h2>
          <p style={{ color: '#666', margin: '0.25rem 0 0', fontSize: '0.9rem' }}>Identity Verification Portal</p>
        </div>
        <form onSubmit={submit}>
          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: '0.85rem', fontWeight: 600, color: '#333' }}>Username</label>
            <input value={username} onChange={e => setUsername(e.target.value)}
              style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid #ddd', borderRadius: 6, fontSize: '1rem', boxSizing: 'border-box' }}
              autoComplete="username" required disabled={loading} />
          </div>
          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', marginBottom: 4, fontSize: '0.85rem', fontWeight: 600, color: '#333' }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              style={{ width: '100%', padding: '0.5rem 0.75rem', border: '1px solid #ddd', borderRadius: 6, fontSize: '1rem', boxSizing: 'border-box' }}
              autoComplete="current-password" required disabled={loading} />
          </div>
          {error && <p style={{ color: '#c62828', fontSize: '0.85rem', margin: '0 0 1rem' }}>{error}</p>}
          <button type="submit" disabled={loading || !username || !password}
            style={{ width: '100%', padding: '0.65rem', background: '#1a237e', color: 'white', border: 'none', borderRadius: 6, fontSize: '1rem', fontWeight: 600, cursor: 'pointer' }}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
