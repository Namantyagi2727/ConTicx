import type { Metadata } from "next";
import { Big_Shoulders, Work_Sans, Space_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/SiteHeader";

// Display: condensed, industrial — gig-poster headline type. Big
// Shoulders is a variable family (optical size 10-72 covers the old
// separate Text/Display cuts); pinning near the top of that range via
// discrete weights gets the condensed "Display" character.
const bigShoulders = Big_Shoulders({
  variable: "--font-display",
  subsets: ["latin"],
  weight: ["600", "700", "800", "900"],
});

// Body: humanist, readable, quiet next to the display face.
const workSans = Work_Sans({
  variable: "--font-body",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

// Utility: prices, dates, countdowns, ticket codes — box-office
// dot-matrix feel for anything that's data rather than prose.
const spaceMono = Space_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "700"],
});

export const metadata: Metadata = {
  title: "ConTicx",
  description: "Book tickets to three fictional Brooklyn shows — a Hyperswitch sandbox demo, no real payments.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${bigShoulders.variable} ${workSans.variable} ${spaceMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-acid focus:px-3 focus:py-2 focus:font-body focus:text-sm focus:text-ink"
        >
          Skip to content
        </a>
        <SiteHeader />
        <div id="main" className="flex flex-1 flex-col">
          {children}
        </div>
      </body>
    </html>
  );
}
