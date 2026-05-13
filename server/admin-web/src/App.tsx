import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './stores/authStore';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Devices } from './pages/Devices';
import { DeviceDetail } from './pages/DeviceDetail';
import { Policies } from './pages/Policies';
import { Apps } from './pages/Apps';
import { Audit } from './pages/Audit';
import { Enrollment } from './pages/Enrollment';
import { Dashboard } from './pages/Dashboard';

function Private({ children }: { children: React.ReactNode }) {
  const token = useAuth(s => s.accessToken);
  return token ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/*"
        element={
          <Private>
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/devices" element={<Devices />} />
                <Route path="/devices/:id" element={<DeviceDetail />} />
                <Route path="/policies" element={<Policies />} />
                <Route path="/apps" element={<Apps />} />
                <Route path="/enrollment" element={<Enrollment />} />
                <Route path="/audit" element={<Audit />} />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
            </Layout>
          </Private>
        }
      />
    </Routes>
  );
}
