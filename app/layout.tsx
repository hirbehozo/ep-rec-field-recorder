import type { Metadata } from 'next'
import '@fontsource-variable/archivo'
import './globals.css'

export const metadata: Metadata = {
  title: 'EP-REC field recorder',
  description: 'Client-side synced audio/MIDI field recorder for USB hardware.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  )
}
