import type { Metadata } from "next";
import { Public_Sans, Spline_Sans_Mono, Zilla_Slab } from "next/font/google";
import "./globals.css";

const body = Public_Sans({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const display = Zilla_Slab({
  variable: "--font-display-face",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

const data = Spline_Sans_Mono({
  variable: "--font-data",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Evalboard — grade Claude models on your own cases",
  description:
    "Run a dataset against multiple Claude models, grade every answer with exact match or an LLM judge, and compare accuracy, latency, and cost.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${body.variable} ${display.variable} ${data.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
