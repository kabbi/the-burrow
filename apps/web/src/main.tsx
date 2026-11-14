import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/inter";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/700.css";
import "./styles.css";
import { Layout } from "./App.tsx";
import { Home } from "./pages/Home.tsx";
import { Add } from "./pages/Add.tsx";
import { Thing } from "./pages/Thing.tsx";
import { Papers } from "./pages/Papers.tsx";
import { Later } from "./pages/Later.tsx";
import { AiLog } from "./pages/AiLog.tsx";
import { ToastProvider } from "./lib/toast.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 } },
});

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/add", element: <Add /> },
      { path: "/t/:id", element: <Thing /> },
      { path: "/papers", element: <Papers /> },
      { path: "/later", element: <Later /> },
      { path: "/ai", element: <AiLog /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
