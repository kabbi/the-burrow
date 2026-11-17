import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/inter";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./ui/tokens.css";
import "./ui/ui.css";
import "./styles.css";
import { Layout, Moved, Workshop } from "./App.tsx";
import { Home } from "./pages/Home.tsx";
import { Add } from "./pages/Add.tsx";
import { Thing } from "./pages/Thing.tsx";
import { Papers } from "./pages/Papers.tsx";
import { Tidy } from "./pages/Tidy.tsx";
import { AiLog } from "./pages/AiLog.tsx";
import { Db } from "./pages/Db.tsx";
import { Schema } from "./pages/Schema.tsx";
import { TagsPage } from "./pages/TagsPage.tsx";
import { Places } from "./pages/Places.tsx";
import { Api } from "./pages/Api.tsx";
import { ToastProvider } from "./lib/toast.tsx";
import { System } from "./pages/System.tsx";
import { Account } from "./pages/Account.tsx";
import { AuthGate } from "./components/SignIn.tsx";
import { TerminalPage } from "./pages/Terminal.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: true, retry: 1 } },
});

const router = createBrowserRouter([
  // The terminal mode takes the whole screen: no top bar or tab bar (D-037).
  { path: "/terminal", element: <TerminalPage /> },
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/add", element: <Add /> },
      { path: "/places", element: <Places /> },
      { path: "/t/:id", element: <Thing /> },
      { path: "/papers", element: <Papers /> },
      { path: "/tidy", element: <Tidy /> },
      { path: "/account", element: <Account /> },
      {
        path: "/workshop",
        element: <Workshop />,
        children: [
          { index: true, element: <Moved to="/workshop/kinds" /> },
          { path: "kinds", element: <Schema /> },
          { path: "tags", element: <TagsPage /> },
          { path: "db", element: <Db /> },
          { path: "api", element: <Api /> },
          { path: "ai", element: <AiLog /> },
          { path: "system", element: <System /> },
        ],
      },
      // Old addresses (before D-027).
      { path: "/later", element: <Moved to="/tidy" /> },
      { path: "/schema", element: <Moved to="/workshop/kinds" /> },
      { path: "/tags", element: <Moved to="/workshop/tags" /> },
      { path: "/db", element: <Moved to="/workshop/db" /> },
      { path: "/integrations", element: <Moved to="/workshop/api" /> },
      { path: "/ai", element: <Moved to="/workshop/ai" /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthGate>
          <RouterProvider router={router} />
        </AuthGate>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
