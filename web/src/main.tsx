import { Amplify } from 'aws-amplify';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { AuthGate } from './auth/AuthGate';
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
    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: config.userPoolId,
          userPoolClientId: config.userPoolClientId,
          loginWith: { email: true },
        },
      },
    });
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
