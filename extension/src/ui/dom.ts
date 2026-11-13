// Tiny DOM builder. All API text goes through textContent (never innerHTML).
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v as EventListener);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

export const MONO = `ui-monospace, "JetBrains Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`;
export const SERIF = `"Instrument Serif", "Iowan Old Style", Georgia, "Times New Roman", serif`;
export const SANS = `system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;

/** Creates a host element with an isolated (open) shadow root and a style reset. */
export function shadowHost(tag: 'div' | 'span', css: string, attr: string): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement(tag);
  host.setAttribute('data-recall-guard', attr);
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('display', 'block', 'important');
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `:host{all:initial;display:block}*{box-sizing:border-box}` + css;
  root.append(style);
  return { host, root };
}
