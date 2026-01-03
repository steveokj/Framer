// Root layout component for the entire application
// Wraps all pages with common HTML structure and global styles
import "@/styles/globals.css";
import type { ReactNode } from "react";

// Metadata exported for Next.js to use in HTML head
export const metadata = {
  title: "Lecturebook",
  description: "Transcript + Frames player"
};

// Root layout component that wraps all pages
// Provides the HTML skeleton with container div for consistent styling
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Container div provides consistent padding and max-width */}
        <div className="container">{children}</div>
      </body>
    </html>
  );
}

