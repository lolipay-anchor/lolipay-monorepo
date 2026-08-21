import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' })

const title = 'lolipay — spend crypto like it’s nothing'
const description =
  'Buy, sell and pay any local bill straight from USDC. Non-custodial, on Stellar — a liquidity provider settles the local cash, you keep your keys.'

export const metadata: Metadata = {
  metadataBase: new URL('https://lolipay.app'),
  title,
  description,
  openGraph: {
    title,
    description,
    url: 'https://lolipay.app',
    siteName: 'lolipay',
    type: 'website',
  },
  twitter: {
    card: 'summary',
  },
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1 }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body className="bg-lp-paper font-geist text-lp-ink antialiased">{children}</body>
    </html>
  )
}
