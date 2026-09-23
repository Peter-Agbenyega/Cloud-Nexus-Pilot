import Link from "next/link";

const steps = [
  {
    title: "1. Choose your audio",
    description: "Use your microphone or share tab audio from Zoom, Teams, Google Meet, or YouTube practice.",
  },
  {
    title: "2. Start the session",
    description: "The copilot listens quietly while you stay focused on the conversation.",
  },
  {
    title: "3. Answer with confidence",
    description: "Get a quick sentence, key points, and a full human-sounding answer.",
  },
];

const useCases = [
  "Tech interviews",
  "Recruiter screens",
  "Consulting calls",
  "Client discovery calls",
  "Mock interview practice",
];

export default function HomePage() {
  return (
    <main className="min-h-screen bg-[#0D0D1A] text-[#F0F0FF]">
      <section className="section-shell py-14 sm:py-[4.5rem] lg:py-24">
        <div className="grid gap-10 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
          <div className="max-w-2xl">
            <span className="inline-flex rounded-full border border-white/[0.08] bg-[#13131F] px-4 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-[#7C6CFF]">
              LIVE INTERVIEW COPILOT
            </span>
            <h1 className="mt-7 text-4xl font-semibold leading-[1.05] tracking-tight text-[#F0F0FF] sm:text-5xl lg:text-6xl">
              Your interview copilot that answers before you panic
            </h1>
            <p className="mt-6 max-w-xl text-base leading-8 text-[#A0A0C0] sm:text-lg">
              Real-time coaching in three layers — what to say now, key points to hit, and your full answer in your own voice.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/workspace"
                className="inline-flex items-center justify-center rounded-xl bg-[#4F46E5] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#4338CA]"
              >
                Open Interview Copilot
              </Link>
              <Link
                href="/workspace?demo=true"
                className="inline-flex items-center justify-center rounded-xl border border-white/[0.08] bg-[#13131F] px-5 py-3 text-sm font-semibold text-[#F0F0FF] transition hover:border-[#7C6CFF]/50 hover:bg-[#1C1C2E]"
              >
                Try Demo Mode
              </Link>
            </div>
            <p className="mt-5 max-w-xl text-sm leading-6 text-[#6060A0]">
              Live transcription and guidance require a signed-in account, configured providers, and browser audio permission. Demo practice uses fixed rules and does not capture audio.
            </p>
          </div>

          <div className="rounded-[20px] border border-white/[0.08] bg-[#13131F] p-4 shadow-2xl shadow-black/30 sm:p-6">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-4">
              <div>
                <p className="text-sm font-medium text-[#F0F0FF]">Illustrative session preview</p>
                <p className="mt-1 text-xs text-[#6060A0]">Sample guidance — no active session</p>
              </div>
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.65)]" />
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {["Use Microphone", "Share Tab Audio"].map((item) => (
                <div key={item} className="rounded-xl border border-white/[0.08] bg-[#0D0D1A] p-4">
                  <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-lg bg-[#4F46E5]/10 text-[#7C6CFF]">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#7C6CFF]" />
                  </div>
                  <p className="text-sm font-medium text-[#F0F0FF]">{item}</p>
                  <p className="mt-1 text-xs leading-5 text-[#6060A0]">Requires permission in the workspace</p>
                </div>
              ))}
            </div>

            <div className="mt-5 space-y-3">
              <div className="rounded-2xl border border-amber-300/20 bg-amber-300/[0.08] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-200">SAY THIS NOW</p>
                <p className="mt-2 text-sm leading-6 text-[#F0F0FF]">
                  Great question — let me walk you through how I'd approach it.
                </p>
              </div>

              <div className="rounded-2xl border border-cyan-300/20 bg-cyan-300/[0.08] p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-200">HIT THESE POINTS</p>
                <ul className="mt-3 space-y-2 text-sm text-[#F0F0FF]">
                  {["Clarify the problem", "Explain the action", "Show the result"].map((point) => (
                    <li key={point} className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-cyan-200" />
                      {point}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-2xl border border-[#7C6CFF]/30 bg-[#7C6CFF]/10 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#B8B0FF]">YOUR FULL ANSWER</p>
                <p className="mt-2 text-sm leading-6 text-[#F0F0FF]">
                  I'd start by understanding the real issue, then explain the tradeoffs clearly and connect my answer
                  to the outcome.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section-shell pb-14 sm:pb-[4.5rem]">
        <h2 className="text-2xl font-semibold text-[#F0F0FF] sm:text-3xl">How it works</h2>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {steps.map((step) => (
            <div key={step.title} className="rounded-2xl border border-white/[0.08] bg-[#13131F] p-5">
              <h3 className="text-base font-semibold text-[#F0F0FF]">{step.title}</h3>
              <p className="mt-3 text-sm leading-7 text-[#A0A0C0]">{step.description}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section-shell pb-14 sm:pb-[4.5rem]">
        <h2 className="text-2xl font-semibold text-[#F0F0FF] sm:text-3xl">Use it when the pressure is high</h2>
        <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {useCases.map((useCase) => (
            <div key={useCase} className="rounded-xl border border-white/[0.08] bg-[#13131F] px-4 py-4">
              <p className="text-sm font-medium text-[#F0F0FF]">{useCase}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="section-shell pb-20">
        <div className="rounded-[20px] border border-white/[0.08] bg-[#13131F] p-6 sm:p-8">
          <h2 className="text-2xl font-semibold text-[#F0F0FF] sm:text-3xl">Ready to sound prepared?</h2>
          <p className="mt-3 text-sm leading-7 text-[#A0A0C0]">Open the copilot, choose your audio, and start practicing.</p>
          <Link
            href="/workspace"
            className="mt-6 inline-flex items-center justify-center rounded-xl bg-[#4F46E5] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#4338CA]"
          >
            Open Interview Copilot
          </Link>
        </div>
      </section>

      <div className="fixed bottom-3 right-3 select-none text-xs text-[#6060A0]/70">v2.1</div>
    </main>
  );
}
