import { Navigate, Route, Routes } from 'react-router'
import { Layout } from './components/Layout'
import { Loading } from './components/ui'
import { LoginPage } from './features/auth/LoginPage'
import { useMe } from './features/auth/useMe'
import { DeliveryPage } from './features/deliveries/DeliveryPage'
import { FleetPage } from './features/fleet/FleetPage'
import { InboxPage } from './features/inbox/InboxPage'
import { ProjectPage } from './features/projects/ProjectPage'
import { ProjectsPage } from './features/projects/ProjectsPage'
import { TaskPage } from './features/tasks/TaskPage'

export function App() {
  const me = useMe()
  if (me.isLoading) return <Loading />
  const signedIn = !!me.data

  return (
    <Routes>
      <Route path="/login" element={signedIn ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route element={signedIn ? <Layout /> : <Navigate to="/login" replace />}>
        <Route index element={<ProjectsPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="fleet" element={<FleetPage />} />
        <Route path="projects/:projectId" element={<ProjectPage />} />
        <Route path="projects/:projectId/deliveries/:deliveryId" element={<DeliveryPage />} />
        <Route path="projects/:projectId/tasks/:taskId" element={<TaskPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
