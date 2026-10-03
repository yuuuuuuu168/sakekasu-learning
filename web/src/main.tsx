import { Amplify } from 'aws-amplify';
// マネージドログインから戻ったときに、URL の認可コードをトークンに換える処理を有効にする
import 'aws-amplify/auth/enable-oauth-listener';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthGate } from './auth/AuthGate';
import { amplifyAuthConfig } from './auth/oauth';
import { Layout } from './components/Layout';
import { ErrorMessage } from './components/Status';
import { loadConfig } from './config';
import './index.css';
import { ExamPage } from './pages/ExamPage';
import { HomePage } from './pages/HomePage';
import { QuestionPage } from './pages/QuestionPage';

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/exams/:category/:exam', element: <ExamPage /> },
      { path: '/exams/:category/:exam/q/:id', element: <QuestionPage /> },
      { path: '*', element: <ErrorMessage message="ページが見つかりません" /> },
    ],
  },
]);

const root = createRoot(document.getElementById('root')!);

loadConfig()
  .then((config) => {
    // ログインは共通ログイン（マネージドログイン + 認可コード + PKCE）
    Amplify.configure({ Auth: amplifyAuthConfig(config, window.location.origin) });
    root.render(
      <StrictMode>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
      </StrictMode>,
    );
  })
  .catch((err: Error) => {
    root.render(
      <div className="p-6">
        <ErrorMessage message={err.message} />
      </div>,
    );
  });
