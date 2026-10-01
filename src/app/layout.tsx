import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kargo Hiring",
  description: "CV screening and candidate follow-through for Kargo's PM and SPM roles",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
