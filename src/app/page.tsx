'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';

/* ─── Floating Particles Background ─── */
function Particles({ count = 30 }: { count?: number }) {
  const [particles, setParticles] = useState<Array<{ left: string; dur: string; del: string; w: string; h: string; bg: string }>>([]);

  useEffect(() => {
    setParticles(
      Array.from({ length: count }).map((_, i) => ({
        left: `${Math.random() * 100}%`,
        dur: `${6 + Math.random() * 10}s`,
        del: `${Math.random() * 8}s`,
        w: `${2 + Math.random() * 3}px`,
        h: `${2 + Math.random() * 3}px`,
        bg: i % 3 === 0 ? '#6366f1' : '#00d4ff',
      }))
    );
  }, [count]);

  if (!particles.length) return null;

  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
      {particles.map((p, i) => (
        <span
          key={i}
          className="particle"
          style={{
            left: p.left,
            animationDuration: p.dur,
            animationDelay: p.del,
            width: p.w,
            height: p.h,
            background: p.bg,
          }}
        />
      ))}
    </div>
  );
}

/* ─── Scroll Reveal Hook ─── */
function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) el.classList.add('visible'); },
      { threshold: 0.15 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  return ref;
}

/* ─── Animated Counter ─── */
function Counter({ target, suffix = '' }: { target: number; suffix?: string }) {
  const [val, setVal] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      let start = 0;
      const step = target / 60;
      const tick = () => {
        start += step;
        if (start >= target) { setVal(target); return; }
        setVal(Math.floor(start));
        requestAnimationFrame(tick);
      };
      tick();
      obs.disconnect();
    }, { threshold: 0.5 });
    obs.observe(el);
    return () => obs.disconnect();
  }, [target]);

  return <span ref={ref}>{val.toLocaleString()}{suffix}</span>;
}

/* ═══════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════ */
export default function LandingPage() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 60);
    window.addEventListener('scroll', h);
    return () => window.removeEventListener('scroll', h);
  }, []);

  return (
    <div className="min-h-screen bg-[#030508] text-white selection:bg-cyan-500/30">
      {/* ─── NAV ─── */}
      <nav className={`fixed top-0 w-full z-50 transition-all duration-500 ${scrolled ? 'glass py-3' : 'py-6'}`}>
        <div className="max-w-7xl mx-auto px-6 flex justify-between items-center">
          <div className="flex items-center gap-3">
            <div className="relative w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center">
              <span className="text-cyan-400 font-black text-sm">K</span>
              <div className="absolute inset-0 rounded-lg pulse-ring" />
            </div>
            <span className="text-xl font-bold tracking-tight">
              Krypton<span className="text-cyan-400">.</span>
            </span>
          </div>
          <div className="flex items-center gap-4">
            <a href="#features" className="text-sm text-slate-400 hover:text-white transition-colors hidden sm:block">Features</a>
            <a href="#how" className="text-sm text-slate-400 hover:text-white transition-colors hidden sm:block">How It Works</a>
            <a
              href="http://localhost:5000"
              className="bg-cyan-500 hover:bg-cyan-400 text-black text-sm font-bold px-5 py-2.5 rounded-full transition-all glow-accent flex items-center gap-2"
            >
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              Live Tracking
            </a>
          </div>
        </div>
      </nav>

      {/* ─── HERO ─── */}
      <header className="relative min-h-screen flex items-center overflow-hidden grid-bg">
        <Particles count={40} />

        {/* Hero Image */}
        <div className="absolute inset-0 z-0">
          <Image src="/hero.png" alt="" fill className="object-cover opacity-30 brightness-50" priority />
          <div className="absolute inset-0 bg-gradient-to-b from-[#030508]/60 via-[#030508]/40 to-[#030508]" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#030508] via-transparent to-transparent" />
        </div>

        <div className="max-w-7xl mx-auto px-6 relative z-10 pt-24">
          <div className="max-w-3xl">
            {/* Badge */}
            <div className="inline-flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-1.5 mb-8">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs font-medium text-slate-300 tracking-wide uppercase">Live on Indian Railways</span>
            </div>

            <h1 className="text-5xl sm:text-6xl md:text-7xl lg:text-8xl font-black tracking-tight mb-8 leading-[1.05]">
              Never miss a<br />
              <span className="text-gradient">moment</span> on the<br />
              tracks.
            </h1>

            <p className="text-lg sm:text-xl text-slate-400 max-w-xl mb-12 leading-relaxed">
              Krypton transforms your train journey into an interactive experience — live crossings,
              river alerts, historic sites, and real-time GPS telemetry.
            </p>

            <div className="flex flex-wrap gap-4">
              <a
                href="http://localhost:5000"
                className="bg-cyan-500 text-black font-bold px-8 py-4 rounded-full glow-accent hover:scale-[1.03] active:scale-[0.98] transition-all flex items-center gap-3 text-base"
              >
                Start Tracking
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M3 8h10m0 0L9 4m4 4L9 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </a>
              <a
                href="#features"
                className="border border-white/10 hover:border-white/25 text-white font-semibold px-8 py-4 rounded-full transition-all flex items-center gap-2 text-base hover:bg-white/5"
              >
                Explore Features
              </a>
            </div>
          </div>
        </div>

        {/* Scroll Indicator */}
        <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-10">
          <span className="text-xs text-slate-500 uppercase tracking-widest">Scroll</span>
          <div className="w-5 h-8 rounded-full border border-slate-600 flex justify-center pt-1.5">
            <div className="w-1 h-2 rounded-full bg-cyan-400 animate-bounce" />
          </div>
        </div>
      </header>

      {/* ─── STATS BAR ─── */}
      <section className="border-y border-white/5 bg-[#0a0e14]/80">
        <div className="max-w-7xl mx-auto px-6 py-16 grid grid-cols-2 md:grid-cols-4 gap-8">
          {[
            { n: 13000, s: '+', label: 'Trains Tracked' },
            { n: 8000,  s: '+', label: 'Stations Mapped' },
            { n: 500,   s: 'km', label: 'Max Scan Radius' },
            { n: 2,     s: 's',  label: 'Update Interval' },
          ].map((s, i) => (
            <StatBlock key={i} {...s} />
          ))}
        </div>
      </section>

      {/* ─── FEATURES ─── */}
      <section id="features" className="py-32 relative">
        <Particles count={15} />
        <div className="max-w-7xl mx-auto px-6 relative z-10">
          <SectionHeader
            badge="Core Features"
            title="Built for the curious traveler."
            desc="Every feature is designed to make sure you never look away from your window at the wrong moment."
          />

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureCard
              icon="📡"
              color="cyan"
              title="Live GPS Precision"
              desc="Uses your phone's native GPS for sub-meter accuracy. Know your exact speed, heading, and altitude in real-time."
              tag="CORE"
            />
            <FeatureCard
              icon="🚂"
              color="indigo"
              title="Crossing Predictor"
              desc="Detects oncoming trains and predicts the exact moment they'll cross you, even in the middle of nowhere."
              tag="ENGINE"
            />
            <FeatureCard
              icon="⚡"
              color="amber"
              title="Overtake Detection"
              desc="Knows when a faster train is approaching from behind and alerts you before it flies past your window."
              tag="ENGINE"
            />
            <FeatureCard
              icon="🌊"
              color="cyan"
              title="River & Bridge Alerts"
              desc="Get notified 3 minutes before you cross a major river. Never miss that scenic bridge shot again."
              tag="POI"
            />
            <FeatureCard
              icon="⚔️"
              color="indigo"
              title="Historic Sites"
              desc="Passing through Panipat? You'll get the story of the three battles that decided India's fate."
              tag="POI"
            />
            <FeatureCard
              icon="📴"
              color="amber"
              title="100% Offline"
              desc="Historical data is pre-loaded. Works in tunnels, forests, and areas with zero cellular signal."
              tag="DESIGN"
            />
          </div>
        </div>
      </section>

      {/* ─── HOW IT WORKS ─── */}
      <section id="how" className="py-32 bg-[#0a0e14]/60 border-y border-white/5 relative overflow-hidden">
        <div className="max-w-7xl mx-auto px-6 relative z-10">
          <SectionHeader
            badge="How It Works"
            title="Three steps. Zero complexity."
            desc="Enter your train, sit back, and let Krypton handle the rest."
          />

          <div className="grid md:grid-cols-3 gap-8">
            {[
              { step: '01', title: 'Enter Your Train', desc: 'Type your train number. Krypton instantly finds your live position via GPS and the RailRadar network.', icon: '🔍' },
              { step: '02', title: 'We Scan the Network', desc: 'The engine scans thousands of trains within your radius, calculates directions, and identifies every relevant crossing.', icon: '📡' },
              { step: '03', title: 'Enjoy the Journey', desc: 'Sit back and watch. You\'ll be alerted before every crossing, river, and historic site. Never miss a moment.', icon: '✨' },
            ].map((s, i) => (
              <StepCard key={i} {...s} index={i} />
            ))}
          </div>
        </div>
      </section>

      {/* ─── CTA ─── */}
      <section className="py-32 relative">
        <Particles count={20} />
        <div className="max-w-4xl mx-auto px-6 text-center relative z-10">
          <CtaSection />
        </div>
      </section>

      {/* ─── FOOTER ─── */}
      <footer className="border-t border-white/5 py-10">
        <div className="max-w-7xl mx-auto px-6 flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm">Krypton<span className="text-cyan-400">.</span></span>
            <span className="text-xs text-slate-600">v2.0</span>
          </div>
          <p className="text-xs text-slate-600">&copy; 2026 Krypton Project. Built with passion for Indian Railways.</p>
        </div>
      </footer>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SUB-COMPONENTS
   ═══════════════════════════════════════════════════════════ */

function SectionHeader({ badge, title, desc }: { badge: string; title: string; desc: string }) {
  const ref = useReveal();
  return (
    <div ref={ref} className="reveal text-center mb-20">
      <span className="inline-block text-xs font-bold uppercase tracking-[0.2em] text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 rounded-full px-4 py-1.5 mb-6">
        {badge}
      </span>
      <h2 className="text-4xl md:text-5xl font-bold mb-6 tracking-tight">{title}</h2>
      <p className="text-slate-400 max-w-2xl mx-auto text-lg leading-relaxed">{desc}</p>
    </div>
  );
}

function StatBlock({ n, s, label }: { n: number; s: string; label: string }) {
  const ref = useReveal();
  return (
    <div ref={ref} className="reveal text-center">
      <div className="text-3xl md:text-4xl font-black text-cyan-400 stat-number mb-2">
        <Counter target={n} suffix={s} />
      </div>
      <div className="text-sm text-slate-500 uppercase tracking-wide">{label}</div>
    </div>
  );
}

const colorMap: Record<string, { bg: string; border: string; tagBg: string; tagText: string }> = {
  cyan:   { bg: 'group-hover:bg-cyan-500/10',   border: 'group-hover:border-cyan-500/30',   tagBg: 'bg-cyan-500/10',   tagText: 'text-cyan-400'   },
  indigo: { bg: 'group-hover:bg-indigo-500/10',  border: 'group-hover:border-indigo-500/30', tagBg: 'bg-indigo-500/10', tagText: 'text-indigo-400' },
  amber:  { bg: 'group-hover:bg-amber-500/10',   border: 'group-hover:border-amber-500/30',  tagBg: 'bg-amber-500/10',  tagText: 'text-amber-400'  },
};

function FeatureCard({ icon, color, title, desc, tag }: { icon: string; color: string; title: string; desc: string; tag: string }) {
  const ref = useReveal();
  const c = colorMap[color] || colorMap.cyan;

  return (
    <div
      ref={ref}
      className={`reveal shimmer-border group bg-[#0a0e14] rounded-2xl p-8 border border-white/5 ${c.border} transition-all duration-300 hover:-translate-y-1 cursor-default`}
    >
      <div className="flex items-center justify-between mb-6">
        <div className={`text-2xl bg-white/5 ${c.bg} w-14 h-14 flex items-center justify-center rounded-xl transition-colors`}>
          {icon}
        </div>
        <span className={`text-[10px] font-bold tracking-widest ${c.tagBg} ${c.tagText} px-3 py-1 rounded-full`}>
          {tag}
        </span>
      </div>
      <h3 className="text-lg font-bold mb-3">{title}</h3>
      <p className="text-sm text-slate-400 leading-relaxed">{desc}</p>
    </div>
  );
}

function StepCard({ step, title, desc, icon, index }: { step: string; title: string; desc: string; icon: string; index: number }) {
  const ref = useReveal();
  return (
    <div ref={ref} className="reveal" style={{ transitionDelay: `${index * 150}ms` }}>
      <div className="relative bg-[#111720] rounded-2xl p-8 border border-white/5 hover:border-white/10 transition-all h-full">
        <div className="text-6xl font-black text-white/[0.03] absolute top-4 right-6">{step}</div>
        <div className="text-3xl mb-6">{icon}</div>
        <h3 className="text-lg font-bold mb-3">{title}</h3>
        <p className="text-sm text-slate-400 leading-relaxed">{desc}</p>
      </div>
    </div>
  );
}

function CtaSection() {
  const ref = useReveal();
  return (
    <div ref={ref} className="reveal">
      <div className="inline-flex items-center gap-2 bg-white/5 border border-white/10 rounded-full px-4 py-1.5 mb-8">
        <span className="text-xs font-medium text-slate-300 tracking-wide">Ready to explore?</span>
      </div>
      <h2 className="text-4xl md:text-6xl font-black tracking-tight mb-8 leading-tight">
        Your next journey<br />starts <span className="text-gradient">now</span>.
      </h2>
      <p className="text-lg text-slate-400 max-w-xl mx-auto mb-12 leading-relaxed">
        Enter your train number and watch as Krypton brings the entire railway network around you to life.
      </p>
      <a
        href="http://localhost:5000"
        className="inline-flex items-center gap-3 bg-cyan-500 text-black font-bold px-10 py-5 rounded-full glow-accent hover:scale-[1.03] active:scale-[0.98] transition-all text-lg"
      >
        Launch Krypton
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
          <path d="M3 8h10m0 0L9 4m4 4L9 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </a>
    </div>
  );
}
