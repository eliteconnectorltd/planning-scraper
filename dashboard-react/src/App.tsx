import { Routes, Route } from "react-router-dom";
import { AppShell } from "@/components/app-shell";
import Overview from "@/pages/Overview";
import Applications from "@/pages/Applications";
import ApplicationDetail from "@/pages/ApplicationDetail";
import Changes from "@/pages/Changes";
import Analytics from "@/pages/Analytics";
import NotFound from "@/pages/NotFound";

// Replaces the App Router root layout. AppShell wraps every route (the old
// layout.tsx wrapped {children}); <Routes> renders the active page.
export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/applications" element={<Applications />} />
        <Route path="/applications/:id" element={<ApplicationDetail />} />
        <Route path="/changes" element={<Changes />} />
        <Route path="/analytics" element={<Analytics />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  );
}
