import { Nav } from '../components/Nav'
import { HeroCopy } from '../components/HeroCopy'
import { BuySellWidget } from '../components/BuySellWidget'
import { TrustStrip } from '../components/TrustStrip'
import { HowItWorks } from '../components/HowItWorks'
import { Features } from '../components/Features'
import { ProvidersCta } from '../components/ProvidersCta'
import { Footer } from '../components/Footer'
import { fetchAnchorFees } from '../lib/anchor-fees'

export const revalidate = 300

export default async function Home() {
  const fees = await fetchAnchorFees()

  return (
      <div className="relative min-h-screen overflow-x-hidden">
        <Nav />
        <header id="top" className="relative">
          <div className="mx-auto grid max-w-[1200px] grid-cols-1 items-center gap-10 px-7 pb-[72px] pt-16 min-[900px]:grid-cols-[1.05fr_.95fr] min-[900px]:gap-14">
            <HeroCopy />
            <BuySellWidget fees={fees} />
          </div>
        </header>
        <TrustStrip />
        <HowItWorks />
        <Features />
        <ProvidersCta />
        <Footer />
      </div>
  )
}
