import React from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
// Bank portal is served separately at port 4000 (bank-frontend container)
import Home from './pages/Home';
import Submit from './pages/Submit';
import Status from './pages/Status';
import Login from './pages/Login';
import Verifier from './pages/Verifier';
import { getStoredToken, getStoredRole, clearToken } from './services/api';

function RequireAuth({ children }: { children: React.ReactElement }) {
  const location = useLocation();
  if (!getStoredToken()) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  return children;
}

function RequireVerifier({ children }: { children: React.ReactElement }) {
  const location = useLocation();
  if (!getStoredToken()) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }
  if (getStoredRole() !== 'verifier') {
    return <Navigate to="/" replace />;
  }
  return children;
}


export default function App() {
  const [token, setToken] = React.useState(getStoredToken());
  const [role, setRole] = React.useState(getStoredRole());

  const handleLogout = () => {
    clearToken();
    setToken(null);
    setRole(null);
  };

  const syncAuth = () => {
    setToken(getStoredToken());
    setRole(getStoredRole());
  };

  React.useEffect(() => {
    window.addEventListener('auth-change', syncAuth); // same-tab login/logout
    window.addEventListener('storage', syncAuth);     // cross-tab sync
    return () => {
      window.removeEventListener('auth-change', syncAuth);
      window.removeEventListener('storage', syncAuth);
    };
  }, []);

  return (
    <BrowserRouter>
      <nav>
        <NavLink to="/" className="brand">KYC</NavLink>
        <NavLink to="/" end>Home</NavLink>
        {role !== 'verifier' && <NavLink to="/submit">Submit</NavLink>}
        {role !== 'verifier' && <NavLink to="/status">Check Status</NavLink>}
        {role === 'verifier' && <NavLink to="/verifier">Verifier Panel</NavLink>}
        {token
          ? <button className="btn-logout" onClick={handleLogout}>Logout</button>
          : <NavLink to="/login">Login</NavLink>
        }
      </nav>
      <main>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
          <Route path="/submit" element={<RequireAuth><Submit /></RequireAuth>} />
          <Route path="/status" element={<RequireAuth><Status /></RequireAuth>} />
          <Route path="/status/:id" element={<RequireAuth><Status /></RequireAuth>} />
          <Route path="/verifier" element={<RequireVerifier><Verifier /></RequireVerifier>} />
          <Route path="/bank" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}
