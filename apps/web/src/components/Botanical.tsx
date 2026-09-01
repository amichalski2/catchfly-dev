/**
 * The brand's watercolour plate as page decoration.
 *
 * Decorative only: it sits behind the page at low opacity, is anchored to a
 * corner well clear of any plot area, and is hidden from assistive technology.
 * Never placed under data — a varying background steals the contrast that bars
 * and lines depend on.
 *
 * Fixed to the viewport rather than to the element it decorates: the page is as
 * tall as the document, so a plate anchored inside it would sit below the fold
 * on every long view.
 */

export function Botanical() {
  return (
    <div className="botanical botanical-corner" aria-hidden="true">
      <img src="/brand/decor-blush.webp" alt="" />
    </div>
  );
}
