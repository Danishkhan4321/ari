/* Decorative SVG shapes — Dodonut / neobrutalist sticker style */
/* All shapes use: bright fill + black stroke + strokeWidth=2 + round caps */

export function Sparkle({ className = "", color = "#818CF8" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={`w-8 h-8 ${className}`}>
      <path
        d="M16 2L19.5 12.5L30 16L19.5 19.5L16 30L12.5 19.5L2 16L12.5 12.5L16 2Z"
        fill={color}
        stroke="#000"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Circle({ className = "", color = "#7DFFB3" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`w-6 h-6 ${className}`}>
      <circle cx="12" cy="12" r="10" fill={color} stroke="#000" strokeWidth="2" />
    </svg>
  );
}

export function Pill({ className = "", color = "#F2A3D8" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 40 20" fill="none" className={`w-10 h-5 ${className}`}>
      <rect x="1" y="1" width="38" height="18" rx="9" fill={color} stroke="#000" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Triangle({ className = "", color = "#4ADBC8" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 28 28" fill="none" className={`w-7 h-7 ${className}`}>
      <path
        d="M14 3L26 25H2L14 3Z"
        fill={color}
        stroke="#000"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Diamond({ className = "", color = "#FD693F" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`w-6 h-6 ${className}`}>
      <path
        d="M12 2L22 12L12 22L2 12L12 2Z"
        fill={color}
        stroke="#000"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Cross({ className = "", color = "#DAF464" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`w-6 h-6 ${className}`}>
      <path
        d="M8 2H16V8H22V16H16V22H8V16H2V8H8V2Z"
        fill={color}
        stroke="#000"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Squiggle({ className = "", color = "#818CF8" }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 48 16" fill="none" className={`w-12 h-4 ${className}`}>
      <path
        d="M2 8C6 2 10 14 14 8C18 2 22 14 26 8C30 2 34 14 38 8C42 2 46 14 46 8"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
