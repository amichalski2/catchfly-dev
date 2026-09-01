import type { CSSProperties } from 'react';

import '../styles/landing.css';
import { useMediaQuery } from '../state/useMediaQuery.ts';
import { STACK } from './stack-marks.ts';

export const WORKSPACE_PATH = '/w/9f2c7a41';

export function Landing() {
  const showShot = useMediaQuery('(min-width: 768px)');

  return (
    <div className="landing">
      <div className="landing-decor" aria-hidden="true">
        <img
          src="/brand/landing/landing-bg.webp"
          srcSet="/brand/landing/landing-bg@1x.webp 1280w, /brand/landing/landing-bg.webp 2560w"
          sizes="100vw"
          alt=""
          width={2560}
          height={1428}
          loading="eager"
          fetchPriority="high"
        />
      </div>

      <header className="landing-hero">
        <div className="landing-copy">
          <div className="landing-brand">
            <img src="/brand/catchfly-mark.png" alt="" width={56} height={56} aria-hidden="true" />
            <span>Catchfly</span>
          </div>

          <h1 className="landing-title">
            See what agents do with your <span>WebMCP app</span>
          </h1>

          <p className="landing-lede">
            Capture production traces, run Chrome WebMCP Evals from CI, and find regressions across
            app, model and tool versions.
          </p>

          <p className="landing-body">
            Chrome executes the evals. Catchfly keeps every run and brings the results together
            with production traces, so you can see what changed and why.
          </p>

          <div className="landing-actions">
            <a className="landing-cta" href={`${WORKSPACE_PATH}?signin`}>
              Start free
              <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                <circle cx="10" cy="10" r="9" fill="none" stroke="currentColor" strokeOpacity="0.45" />
                <path
                  d="M8.5 6.5 12 10l-3.5 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
            <a className="landing-cta landing-cta-quiet" href={WORKSPACE_PATH}>
              Explore the demo
            </a>
            <a
              className="landing-cta landing-cta-quiet"
              href="https://webmcp.devpost.com/project-gallery"
              rel="noreferrer"
            >
              WebMCP Challenge Gallery
            </a>
          </div>

          <p className="landing-tagline">
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
            Open source | MIT licensed
          </p>
        </div>

        {showShot ? (
          <div className="landing-shot">
            <a className="landing-shot-frame" href={WORKSPACE_PATH} aria-label="Explore the Catchfly demo">
              <img
                src="/brand/landing/hero-app.webp"
                srcSet="/brand/landing/hero-app@1x.webp 900w, /brand/landing/hero-app.webp 1800w"
                sizes="(max-width: 1080px) calc(100vw - 3.5rem), 900px"
                alt="The Catchfly console: incident patterns, the release history and the findings that deserve attention."
                width={1800}
                height={1048}
                loading="eager"
              />
            </a>
          </div>
        ) : null}
      </header>

      <footer className="landing-foot panel">
        <span className="landing-built">Built for the WebMCP Challenge</span>
        <ul className="landing-stack">
          {STACK.map((item) => (
            <li
              key={item.name}
              title={item.name}
              data-brand={item.name.toLowerCase()}
              style={
                {
                  '--mark-box': `${item.box ?? 1.125}rem`,
                  '--mark-bleed': `${item.bleed ?? 0}rem`,
                } as CSSProperties
              }
            >
              {item.path ? (
                <svg viewBox="0 0 24 24" role="img" aria-label={item.name} focusable="false">
                  <path d={item.path} fill={item.color ?? 'currentColor'} />
                </svg>
              ) : item.src ? (
                <img className="landing-stack-mark" src={item.src} alt={item.name} />
              ) : (
                <span className="landing-stack-word">{item.name}</span>
              )}
            </li>
          ))}
        </ul>
      </footer>
    </div>
  );
}
