import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'
import { Providers } from './providers'
import { AppGate } from '@/components/AppGate'
import { ToastProvider } from '@/components/Toast'

const geist = Geist({
  subsets: ['latin'],
  variable: '--font-geist',
})

const geistMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-geist-mono',
})

export const metadata: Metadata = {
  title: 'lolipay',
  description: 'Non-custodial P2P IDR ⇄ USDC exchange on Stellar',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable} h-full`}>
      <body className="min-h-full flex flex-col bg-lp-paper font-geist text-lp-ink antialiased">
        <Providers>
          <ToastProvider>
            <AppGate>{children}</AppGate>
          </ToastProvider>
        </Providers>
      </body>
    </html>
  )
}
